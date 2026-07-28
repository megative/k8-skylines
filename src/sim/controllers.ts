/* ============================================================================
 * sim/controllers.ts — kube-controller-manager's reconcile loops.
 *
 * Every controller here is the same shape and that shape is the whole idea:
 *
 *     watch  ->  diff desired against actual  ->  act  ->  requeue
 *
 * None of them talk to each other. None of them are called by anything. They
 * wake on a watch event or a resync, read the world, write one API request,
 * and go back to sleep. A Deployment does not run a pod; it writes a
 * ReplicaSet, and a different loop writes the Pods, and a third loop puts them
 * on nodes. Records producing records, and only the Pod ever becomes a
 * building.
 * ==========================================================================*/

import {
  TIMING,
  type ControllerId,
  type ControllerState,
  type DeploymentState,
  type JobState,
  type Kind,
  type PodState,
  type ReplicaSetState,
  type ServiceState,
} from '../core/types'
import { clamp, selectorMatches } from '../core/util'
import { SUBJECTS, submit } from './controlplane'
import {
  MODEL,
  type ContainerSpec,
  type DeploySpec,
  type PodTemplate,
  type SimCtx,
  type Workqueue,
  deletePod,
  dequeue,
  emit,
  enqueue,
  forgetKey,
  instantiatePod,
  addPod,
  key,
  podIsReady,
  podIsTerminating,
  podUsedCpu,
  requeueWithBackoff,
  runtimeOf,
  setCondition,
  toleratesTaint,
  removePod,
} from './ctx'
import { flushUnschedulable } from './scheduling'
import { findPvc, reclaim, reconcileClaim } from './storage'

/* The taints the node controller applies. These strings are load-bearing:
 * a DaemonSet stays put through them only because it tolerates them. */
const TAINT_UNREACHABLE = 'node.kubernetes.io/unreachable'
const TAINT_NOT_READY = 'node.kubernetes.io/not-ready'

/** Informer resync period. Real default is 10 hours; scaled to stay visible. */
const RESYNC_SECONDS = 12
/** ReplicaSets kept per Deployment for rollback. Real default is 10. */
const REVISION_HISTORY_LIMIT = 10
/** Model seconds a terminal pod lingers before the garbage collector reaps it. */
const TERMINAL_POD_TTL = 30

/* ---------------------------------------------------------------------------
 * Template hashing. Kubernetes names a ReplicaSet after the hash of the pod
 * template it materialises, which is exactly why changing the template makes a
 * new ReplicaSet and changing nothing does not.
 * -------------------------------------------------------------------------*/

export function templateHash(spec: DeploySpec, ctx: SimCtx): string {
  if (!spec.knobDriven) return spec.image
  const k = ctx.s.knobs
  return `${spec.image}|${k.requestCpuMilli}|${k.limitCpuMilli}|${k.requestMemMib}|${k.limitMemMib}`
}

function shortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let out = (h >>> 0).toString(36)
  while (out.length < 9) out = `${out}0`
  return out.slice(0, 9)
}

function buildContainers(ctx: SimCtx, spec: DeploySpec, image: string): ContainerSpec[] {
  const k = ctx.s.knobs
  const out: ContainerSpec[] = []
  for (const c of spec.containers) {
    const copy: ContainerSpec = { ...c }
    if (c.role === 'app') copy.image = image
    if (spec.knobDriven && c.role === 'app') {
      copy.requestCpuMilli = k.requestCpuMilli
      copy.limitCpuMilli = k.limitCpuMilli
      copy.requestMemMib = k.requestMemMib
      copy.limitMemMib = k.limitMemMib
    }
    out.push(copy)
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Small lookups.
 * -------------------------------------------------------------------------*/

function findDeployment(ctx: SimCtx, ns: string, name: string): DeploymentState | undefined {
  for (const d of ctx.s.deployments) if (d.namespace === ns && d.name === name) return d
  return undefined
}

function findRs(ctx: SimCtx, ns: string, name: string): ReplicaSetState | undefined {
  for (const r of ctx.s.replicaSets) if (r.namespace === ns && r.name === name) return r
  return undefined
}

export function rsUid(ns: string, name: string): string {
  return `rs:${ns}/${name}`
}

/**
 * A write the controller issued came back as an error. This is what a real
 * reconcile loop does with it: count it, and put the key back on the queue
 * behind an exponential delay rather than hot-looping on a broken API server.
 */
function reportWriteError(ctx: SimCtx, id: ControllerId, k: string): void {
  const cs = ctx.s.controllers[id]
  cs.errors += 1
  const q = ctx.store.queues.get(id)
  if (q) cs.backoffSeconds = requeueWithBackoff(q, k, ctx.s.t)
}

function ownedActivePods(ctx: SimCtx, ownerUid: string, out: PodState[]): PodState[] {
  out.length = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.owner?.uid !== ownerUid) continue
    if (podIsTerminating(p)) continue
    if (p.phase === 'Failed' || p.phase === 'Succeeded') continue
    out.push(p)
  }
  return out
}

const SCRATCH_A: PodState[] = []

/* ---------------------------------------------------------------------------
 * Deployment controller.
 * -------------------------------------------------------------------------*/

function deploymentRs(ctx: SimCtx, d: DeploymentState, out: ReplicaSetState[]): ReplicaSetState[] {
  out.length = 0
  for (const r of ctx.s.replicaSets) {
    if (r.namespace === d.namespace && r.ownerDeployment === d.name) out.push(r)
  }
  out.sort((a, b) => b.revision - a.revision)
  return out
}
const RS_SCRATCH: ReplicaSetState[] = []

function reconcileDeployment(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const d = findDeployment(ctx, ns, name)
  if (!d) return true
  const spec = ctx.store.deploySpecs.get(k)
  if (!spec) return true

  const hash = templateHash(spec, ctx)
  const rsList = deploymentRs(ctx, d, RS_SCRATCH)

  let newRs: ReplicaSetState | undefined
  for (const r of rsList) {
    if (ctx.store.rsTemplate.get(key(r.namespace, r.name)) === hash) {
      newRs = r
      break
    }
  }

  if (!newRs) {
    /* A template the cluster has never seen: a new revision, a new ReplicaSet.
     * The rollout is then nothing but the two ReplicaSets' replica counts. */
    let maxRev = 0
    for (const r of rsList) maxRev = Math.max(maxRev, r.revision)
    const revision = maxRev + 1
    const rsName = `${d.name}-${shortHash(hash)}`
    if (findRs(ctx, ns, rsName)) return true
    submit(ctx, {
      verb: 'create',
      kind: 'ReplicaSet',
      namespace: ns,
      name: rsName,
      subject: SUBJECTS.controllerManager,
      commit: (c) => {
        if (findRs(c, ns, rsName)) return
        const labels: Record<string, string> = { ...spec.labels, 'pod-template-hash': shortHash(hash) }
        c.s.replicaSets.push({
          name: rsName,
          namespace: ns,
          ownerDeployment: d.name,
          revision,
          replicas: 0,
          statusReplicas: 0,
          readyReplicas: 0,
          selector: { ...d.selector, 'pod-template-hash': shortHash(hash) },
          podTemplateLabels: labels,
          image: spec.image,
        })
        c.store.rsTemplate.set(key(ns, rsName), hash)
        d.revision = revision
        spec.history.set(revision, spec.image)
        c.store.rolloutProgressAt.set(k, c.s.t)
        d.progressDeadlineExceeded = false
        emit(c, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled up replica set ${rsName} to 0`)
      },
      done: (c, outcome, reason) => {
        if (outcome === 'ok') return
        emit(c, 'Warning', 'FailedCreate', `deployment/${d.name}`, `Error creating ReplicaSet: ${reason || outcome}`)
        reportWriteError(c, 'deployment', k)
      },
    })
    return true
  }

  d.revision = newRs.revision

  /* Status is derived from the pods that actually exist — never asserted. */
  let statusReplicas = 0
  let readyReplicas = 0
  let updatedReplicas = 0
  let newRsReady = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.namespace !== ns) continue
    const owner = p.owner
    if (!owner || owner.kind !== 'ReplicaSet') continue
    let mine = false
    for (const r of rsList) {
      if (owner.uid === rsUid(ns, r.name)) {
        mine = true
        break
      }
    }
    if (!mine) continue
    if (podIsTerminating(p) || p.phase === 'Failed' || p.phase === 'Succeeded') continue
    statusReplicas += 1
    const ready = podIsReady(p)
    if (ready) readyReplicas += 1
    if (owner.uid === rsUid(ns, newRs.name)) {
      updatedReplicas += 1
      if (ready) newRsReady += 1
    }
  }
  d.statusReplicas = statusReplicas
  d.readyReplicas = readyReplicas
  d.availableReplicas = readyReplicas
  d.updatedReplicas = updatedReplicas
  d.replicaSets.length = 0
  for (const r of rsList) d.replicaSets.push(r.name)

  if (d.paused) {
    d.rollingOut = updatedReplicas < d.replicas
    return true
  }

  /* The real rolling-update arithmetic, from deployment/rolling.go. */
  let allPods = 0
  for (const r of rsList) allPods += r.replicas
  const maxTotal = d.replicas + d.maxSurge
  const minAvailable = Math.max(0, d.replicas - d.maxUnavailable)

  const scaleUp = Math.min(maxTotal - allPods, d.replicas - newRs.replicas)
  if (scaleUp > 0) {
    newRs.replicas += scaleUp
    allPods += scaleUp
    emit(ctx, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled up replica set ${newRs.name} to ${newRs.replicas}`)
  } else if (newRs.replicas > d.replicas) {
    const dec = newRs.replicas - d.replicas
    newRs.replicas = d.replicas
    allPods -= dec
    emit(ctx, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled down replica set ${newRs.name} to ${newRs.replicas}`)
  }

  /* maxUnavailable is enforced here and nowhere else: we may only give up
   * `available - minAvailable` pods, minus the new ones not yet available. */
  const newUnavailable = newRs.replicas - newRsReady
  let maxScaledDown = allPods - minAvailable - newUnavailable
  if (maxScaledDown > 0) {
    for (let i = rsList.length - 1; i >= 0 && maxScaledDown > 0; i--) {
      const old = rsList[i]
      if (old === newRs || old.replicas === 0) continue
      const dec = Math.min(old.replicas, maxScaledDown)
      old.replicas -= dec
      maxScaledDown -= dec
      emit(ctx, 'Normal', 'ScalingReplicaSet', `deployment/${d.name}`, `Scaled down replica set ${old.name} to ${old.replicas}`)
    }
  }

  let oldPods = 0
  for (const r of rsList) if (r !== newRs) oldPods += r.replicas
  d.rollingOut = updatedReplicas < d.replicas || oldPods > 0 || statusReplicas > d.replicas

  /* Progress deadline. A rollout that stops moving is a rollout that failed,
   * and this is the only signal a user gets that a readiness probe is wedged. */
  const mark = ctx.store.rolloutMark.get(k) ?? -1
  const progressSignal = readyReplicas * 1000 + updatedReplicas
  if (progressSignal !== mark) {
    ctx.store.rolloutMark.set(k, progressSignal)
    ctx.store.rolloutProgressAt.set(k, ctx.s.t)
  }
  const since = ctx.s.t - (ctx.store.rolloutProgressAt.get(k) ?? ctx.s.t)
  /* The deadline tracks the *new* ReplicaSet becoming available. A pure
   * scale-down is not a stalled rollout, however long it takes. */
  if (d.rollingOut && updatedReplicas < d.replicas && since > MODEL.progressDeadlineSeconds) {
    if (!d.progressDeadlineExceeded) {
      d.progressDeadlineExceeded = true
      emit(
        ctx,
        'Warning',
        'ProgressDeadlineExceeded',
        `deployment/${d.name}`,
        `ReplicaSet "${newRs.name}" has timed out progressing.`,
      )
    }
  } else if (!d.rollingOut) {
    d.progressDeadlineExceeded = false
  }

  /* revisionHistoryLimit: keep old ReplicaSets so rollback stays instant. */
  if (rsList.length > REVISION_HISTORY_LIMIT) {
    for (let i = rsList.length - 1; i >= 0 && ctx.s.replicaSets.length > REVISION_HISTORY_LIMIT; i--) {
      const old = rsList[i]
      if (old === newRs || old.replicas > 0) continue
      const at = ctx.s.replicaSets.indexOf(old)
      if (at >= 0) ctx.s.replicaSets.splice(at, 1)
      ctx.store.rsTemplate.delete(key(old.namespace, old.name))
      break
    }
  }
  return true
}

/**
 * `kubectl rollout undo`. It is instant because the previous ReplicaSet still
 * exists at replicas: 0 — nothing is built, a counter is moved.
 */
export function rollbackDeployment(ctx: SimCtx, ns: string, name: string): boolean {
  const d = findDeployment(ctx, ns, name)
  const spec = ctx.store.deploySpecs.get(key(ns, name))
  if (!d || !spec) return false
  const rsList = deploymentRs(ctx, d, RS_SCRATCH)
  const currentHash = templateHash(spec, ctx)
  for (const r of rsList) {
    const h = ctx.store.rsTemplate.get(key(r.namespace, r.name))
    if (!h || h === currentHash) continue
    spec.image = r.image
    ctx.store.wedgedRevisions.delete(d.revision)
    d.progressDeadlineExceeded = false
    ctx.store.rolloutProgressAt.set(key(ns, name), ctx.s.t)
    emit(
      ctx,
      'Normal',
      'DeploymentRollback',
      `deployment/${d.name}`,
      `Rolled back deployment "${d.name}" to revision ${r.revision}`,
    )
    enqueue(ctx.store.queues.get('deployment')!, key(ns, name))
    return true
  }
  return false
}

/** Change the Deployment's image, which is what actually starts a rollout. */
export function setDeploymentImage(ctx: SimCtx, ns: string, name: string, image: string): void {
  const spec = ctx.store.deploySpecs.get(key(ns, name))
  if (!spec || spec.image === image) return
  spec.image = image
  const d = findDeployment(ctx, ns, name)
  if (d) {
    d.progressDeadlineExceeded = false
    ctx.store.rolloutProgressAt.set(key(ns, name), ctx.s.t)
  }
  enqueue(ctx.store.queues.get('deployment')!, key(ns, name))
}

/** The revision a not-yet-created ReplicaSet would get. Scenarios need this. */
export function nextRevision(ctx: SimCtx, ns: string, name: string): number {
  const d = findDeployment(ctx, ns, name)
  if (!d) return 1
  let maxRev = 0
  for (const r of deploymentRs(ctx, d, RS_SCRATCH)) maxRev = Math.max(maxRev, r.revision)
  return maxRev + 1
}

/* ---------------------------------------------------------------------------
 * ReplicaSet controller. The only loop in the cluster that creates Pods.
 * -------------------------------------------------------------------------*/

function reconcileReplicaSet(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const rs = findRs(ctx, ns, name)
  if (!rs) return true
  const d = findDeployment(ctx, ns, rs.ownerDeployment)
  const spec = d ? ctx.store.deploySpecs.get(key(ns, d.name)) : undefined
  if (!spec) return true

  const uid = rsUid(ns, name)
  const owned = ownedActivePods(ctx, uid, SCRATCH_A)
  rs.statusReplicas = owned.length
  let ready = 0
  for (const p of owned) if (podIsReady(p)) ready += 1
  rs.readyReplicas = ready

  const diff = rs.replicas - owned.length
  if (diff > 0) {
    /* Real ReplicaSets create in a slow-start batch; two per reconcile keeps
     * the construction readable without pretending it is instant. */
    const batch = Math.min(diff, 2)
    for (let i = 0; i < batch; i++) createPodForRs(ctx, rs, spec)
    return true
  }
  if (diff < 0) {
    let toDelete = -diff
    /* Victim order: unscheduled, then not-ready, then youngest. */
    owned.sort((a, b) => {
      const av = (a.nodeName ? 1 : 0) + (podIsReady(a) ? 2 : 0)
      const bv = (b.nodeName ? 1 : 0) + (podIsReady(b) ? 2 : 0)
      if (av !== bv) return av - bv
      return a.ageSeconds - b.ageSeconds
    })
    for (const p of owned) {
      if (toDelete <= 0) break
      toDelete -= 1
      const podUid = p.uid
      const podName = p.name
      submit(ctx, {
        verb: 'delete',
        kind: 'Pod',
        namespace: ns,
        name: podName,
        subject: SUBJECTS.controllerManager,
        commit: (c) => deletePod(c, podUid, 'ScaledDown'),
      })
      emit(ctx, 'Normal', 'SuccessfulDelete', `replicaset/${rs.name}`, `Deleted pod: ${podName}`)
    }
  }
  return true
}

function createPodForRs(ctx: SimCtx, rs: ReplicaSetState, spec: DeploySpec): void {
  const tpl: PodTemplate = {
    namespace: rs.namespace,
    basename: rs.name,
    labels: rs.podTemplateLabels,
    containers: buildContainers(ctx, spec, rs.image),
    tolerations: spec.tolerations,
    nodeSelector: spec.nodeSelector,
    volumeClaims: spec.volumeClaims,
    priority: spec.priority,
    priorityClassName: spec.priorityClassName,
    revision: rs.revision,
    antiAffinityKey: spec.antiAffinityKey,
    owner: { kind: 'ReplicaSet', name: rs.name, uid: rsUid(rs.namespace, rs.name), controller: true },
  }
  const pod = instantiatePod(ctx, tpl)
  submit(ctx, {
    verb: 'create',
    kind: 'Pod',
    namespace: rs.namespace,
    name: pod.name,
    subject: SUBJECTS.controllerManager,
    commit: (c) => {
      addPod(c, pod)
      emit(c, 'Normal', 'SuccessfulCreate', `replicaset/${rs.name}`, `Created pod: ${pod.name}`)
    },
    done: (c, outcome, reason) => {
      if (outcome === 'ok') return
      /* The pod object was never created. This is what a broken webhook or a
       * quorum-less etcd looks like from a controller's side. */
      c.store.runtime.delete(pod.uid)
      emit(c, 'Warning', 'FailedCreate', `replicaset/${rs.name}`, `Error creating: ${reason || outcome}`)
      reportWriteError(c, 'replicaset', key(rs.namespace, rs.name))
    },
  })
}

/* ---------------------------------------------------------------------------
 * StatefulSet controller: ordered, one ordinal at a time, stable identities.
 * -------------------------------------------------------------------------*/

function reconcileStatefulSet(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const ss = ctx.s.statefulSets.find((s) => s.namespace === ns && s.name === name)
  if (!ss) return true
  const spec = ctx.store.deploySpecs.get(key(ns, name))
  if (!spec) return true

  const uid = `sts:${ns}/${name}`
  const owned = ownedActivePods(ctx, uid, SCRATCH_A)
  let ready = 0
  for (const p of owned) if (podIsReady(p)) ready += 1
  ss.readyReplicas = ready

  /* Scale down happens from the highest ordinal, one at a time. */
  if (owned.length > ss.replicas) {
    let highest: PodState | null = null
    let highestOrd = -1
    for (const p of owned) {
      const ord = ordinalOf(p.name)
      if (ord > highestOrd) {
        highestOrd = ord
        highest = p
      }
    }
    if (highest) {
      ss.inProgressOrdinal = highestOrd
      const target = highest.uid
      const targetName = highest.name
      submit(ctx, {
        verb: 'delete',
        kind: 'Pod',
        namespace: ns,
        name: targetName,
        subject: SUBJECTS.controllerManager,
        commit: (c) => deletePod(c, target, 'ScaledDown'),
      })
    }
    return true
  }

  for (let ord = 0; ord < ss.replicas; ord++) {
    const podName = `${name}-${ord}`
    let existing: PodState | null = null
    for (const p of owned) if (p.name === podName) existing = p
    if (existing) {
      /* Ordinal N is not created until ordinal N-1 is Ready. That ordering is
       * the entire contract a StatefulSet offers. */
      if (!podIsReady(existing)) {
        ss.inProgressOrdinal = ord
        return true
      }
      continue
    }
    ss.inProgressOrdinal = ord
    const claim = `${ss.claimTemplate}-${podName}`
    ensureClaim(ctx, ns, claim)
    const tpl: PodTemplate = {
      namespace: ns,
      basename: podName,
      labels: spec.labels,
      containers: buildContainers(ctx, spec, spec.image),
      tolerations: spec.tolerations,
      volumeClaims: [claim],
      priority: spec.priority,
      owner: { kind: 'StatefulSet', name, uid, controller: true },
    }
    const pod = instantiatePod(ctx, tpl)
    /* StatefulSet pods keep their name; there is no random suffix. */
    pod.name = podName
    submit(ctx, {
      verb: 'create',
      kind: 'Pod',
      namespace: ns,
      name: podName,
      subject: SUBJECTS.controllerManager,
      commit: (c) => {
        addPod(c, pod)
        emit(c, 'Normal', 'SuccessfulCreate', `statefulset/${name}`, `create Pod ${podName} in StatefulSet ${name} successful`)
      },
      done: (c, outcome) => {
        if (outcome !== 'ok') c.store.runtime.delete(pod.uid)
      },
    })
    return true
  }
  ss.inProgressOrdinal = undefined
  return true
}

function ordinalOf(name: string): number {
  const dash = name.lastIndexOf('-')
  const n = Number(name.slice(dash + 1))
  return Number.isFinite(n) ? n : -1
}

function ensureClaim(ctx: SimCtx, ns: string, claim: string): void {
  if (findPvc(ctx, ns, claim)) return
  ctx.s.pvcs.push({
    name: claim,
    namespace: ns,
    phase: 'Pending',
    requestGib: 8,
    storageClass: 'fast-ssd',
    waitingForConsumer: false,
  })
  enqueue(ctx.store.queues.get('pv-binder')!, key(ns, claim))
}

/* ---------------------------------------------------------------------------
 * DaemonSet controller: one pod per eligible node, by definition.
 * -------------------------------------------------------------------------*/

function reconcileDaemonSet(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const ds = ctx.s.daemonSets.find((d) => d.namespace === ns && d.name === name)
  if (!ds) return true
  const spec = ctx.store.deploySpecs.get(key(ns, name))
  if (!spec) return true

  const uid = `ds:${ns}/${name}`
  const owned = ownedActivePods(ctx, uid, SCRATCH_A)

  let desired = 0
  let scheduled = 0
  let ready = 0
  for (const p of owned) {
    if (p.nodeName) scheduled += 1
    if (podIsReady(p)) ready += 1
  }

  for (let n = 0; n < ctx.s.nodes.length; n++) {
    const node = ctx.s.nodes[n]
    let eligible = true
    for (const t of node.taints) {
      if (t.effect === 'PreferNoSchedule') continue
      if (!toleratesTaint(spec.tolerations, t)) eligible = false
    }
    if (!eligible) continue
    desired += 1
    let present = false
    for (const p of owned) {
      if (p.nodeSelector?.['kubernetes.io/hostname'] === node.name) present = true
    }
    if (present) continue
    const tpl: PodTemplate = {
      namespace: ns,
      basename: name,
      labels: spec.labels,
      containers: buildContainers(ctx, spec, spec.image),
      tolerations: spec.tolerations,
      /* A real DaemonSet pins the pod with required nodeAffinity on the node's
       * name; the hostname label is the same constraint, spelled shorter. */
      nodeSelector: { 'kubernetes.io/hostname': node.name },
      volumeClaims: [],
      priority: spec.priority,
      priorityClassName: spec.priorityClassName,
      owner: { kind: 'DaemonSet', name, uid, controller: true },
    }
    const pod = instantiatePod(ctx, tpl)
    submit(ctx, {
      verb: 'create',
      kind: 'Pod',
      namespace: ns,
      name: pod.name,
      subject: SUBJECTS.controllerManager,
      commit: (c) => {
        addPod(c, pod)
        emit(c, 'Normal', 'SuccessfulCreate', `daemonset/${name}`, `Created pod: ${pod.name}`)
      },
      done: (c, outcome) => {
        if (outcome !== 'ok') c.store.runtime.delete(pod.uid)
      },
    })
  }

  ds.desiredScheduled = desired
  ds.currentScheduled = scheduled
  ds.ready = ready
  return true
}

/* ---------------------------------------------------------------------------
 * Job and CronJob.
 * -------------------------------------------------------------------------*/

function reconcileJob(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const job = ctx.s.jobs.find((j) => j.namespace === ns && j.name === name)
  if (!job) return true
  const spec = ctx.store.deploySpecs.get(key(ns, jobSpecKey(name)))
  if (!spec) return true

  const uid = `job:${ns}/${name}`
  let counted = ctx.store.jobCounted.get(k)
  if (!counted) {
    counted = new Set()
    ctx.store.jobCounted.set(k, counted)
  }
  let active = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.owner?.uid !== uid) continue
    if (p.phase === 'Succeeded' || p.phase === 'Failed') {
      /* Counted once, forever. The pod may be garbage-collected tomorrow. */
      if (counted.has(p.uid)) continue
      counted.add(p.uid)
      if (p.phase === 'Succeeded') job.succeeded += 1
      else job.failed += 1
      continue
    }
    if (!podIsTerminating(p)) active += 1
  }
  job.active = active
  const succeeded = job.succeeded

  if (succeeded >= job.completions) {
    if (!job.complete) {
      job.complete = true
      emit(ctx, 'Normal', 'Completed', `job/${name}`, `Job completed`)
    }
    return true
  }
  /* backoffLimit: past it the Job gives up rather than retrying forever. */
  if (job.failed > job.backoffLimit) return true

  const want = Math.min(job.parallelism - active, job.completions - succeeded - active)
  for (let i = 0; i < want; i++) {
    const tpl: PodTemplate = {
      namespace: ns,
      basename: name,
      labels: spec.labels,
      containers: buildContainers(ctx, spec, spec.image),
      tolerations: spec.tolerations,
      volumeClaims: [],
      priority: spec.priority,
      owner: { kind: 'Job', name, uid, controller: true },
    }
    const pod = instantiatePod(ctx, tpl)
    submit(ctx, {
      verb: 'create',
      kind: 'Pod',
      namespace: ns,
      name: pod.name,
      subject: SUBJECTS.controllerManager,
      commit: (c) => {
        addPod(c, pod)
        emit(c, 'Normal', 'SuccessfulCreate', `job/${name}`, `Created pod: ${pod.name}`)
      },
      done: (c, outcome) => {
        if (outcome !== 'ok') c.store.runtime.delete(pod.uid)
      },
    })
  }
  return true
}

function jobSpecKey(jobName: string): string {
  const dash = jobName.lastIndexOf('-')
  return dash > 0 && /^\d+$/.test(jobName.slice(dash + 1)) ? jobName.slice(0, dash) : jobName
}

/** Model seconds between CronJob firings. The demo schedule is every 2 minutes. */
const CRON_PERIOD_SECONDS = 120
/** Finished Jobs kept, per successfulJobsHistoryLimit. */
const JOB_HISTORY = 3

function reconcileCronJob(ctx: SimCtx, _k: string): boolean {
  /* The schedule is wall-clock driven; the controller only notices it. */
  if (ctx.store.cronClock < CRON_PERIOD_SECONDS) return true
  ctx.store.cronClock = 0
  ctx.store.jobSeq += 1
  const name = `report-${ctx.store.jobSeq}`
  const job: JobState = {
    name,
    namespace: 'shop',
    completions: 2,
    parallelism: 1,
    succeeded: 0,
    failed: 0,
    backoffLimit: 4,
    active: 0,
    complete: false,
  }
  submit(ctx, {
    verb: 'create',
    kind: 'Job',
    namespace: 'shop',
    name,
    subject: SUBJECTS.controllerManager,
    commit: (c) => {
      c.s.jobs.push(job)
      enqueue(c.store.queues.get('job')!, key('shop', name))
      emit(c, 'Normal', 'SuccessfulCreate', `cronjob/report`, `Created job ${name}`)
      /* successfulJobsHistoryLimit: old completed Jobs are reaped. */
      let complete = 0
      for (let i = c.s.jobs.length - 1; i >= 0; i--) {
        if (!c.s.jobs[i].complete) continue
        complete += 1
        if (complete > JOB_HISTORY) c.s.jobs.splice(i, 1)
      }
    },
  })
  return true
}

/* ---------------------------------------------------------------------------
 * Node controller: leases in, NotReady and eviction out.
 * -------------------------------------------------------------------------*/

function hasTaint(node: { taints: { key: string }[] }, k: string): boolean {
  for (const t of node.taints) if (t.key === k) return true
  return false
}

function removeTaint(node: { taints: { key: string }[] }, k: string): void {
  for (let i = node.taints.length - 1; i >= 0; i--) if (node.taints[i].key === k) node.taints.splice(i, 1)
}

function reconcileNode(ctx: SimCtx, k: string): boolean {
  let index = -1
  for (let i = 0; i < ctx.s.nodes.length; i++) if (ctx.s.nodes[i].name === k) index = i
  if (index < 0) return true
  const node = ctx.s.nodes[index]

  if (!node.podCidr) node.podCidr = `10.244.${index}.0/24`

  const stale = node.kubelet.sinceLeaseSeconds > TIMING.nodeMonitorGraceSeconds
  if (stale) {
    if (!hasTaint(node, TAINT_UNREACHABLE)) {
      /* Every condition goes Unknown, not just Ready: the control plane has
       * lost its only reporter and will not guess on the kubelet's behalf. */
      setCondition(node, 'Ready', 'Unknown', 'NodeStatusUnknown')
      setCondition(node, 'MemoryPressure', 'Unknown', 'NodeStatusUnknown')
      setCondition(node, 'DiskPressure', 'Unknown', 'NodeStatusUnknown')
      setCondition(node, 'PIDPressure', 'Unknown', 'NodeStatusUnknown')
      setCondition(node, 'NetworkUnavailable', 'Unknown', 'NodeStatusUnknown')
      node.taints.push({ key: TAINT_UNREACHABLE, effect: 'NoSchedule' })
      node.taints.push({ key: TAINT_UNREACHABLE, effect: 'NoExecute' })
      emit(
        ctx,
        'Warning',
        'NodeNotReady',
        `node/${node.name}`,
        `Node ${node.name} status is now: NodeNotReady`,
      )
      /* The API server's view of every pod here goes stale at once: their
       * Ready condition is set to false, which drops them from every Service. */
      for (const uid of node.podUids) {
        const p = ctx.s.pods.get(uid)
        if (!p) continue
        p.conditions.Ready = false
        p.conditions.ContainersReady = false
        for (const c of p.containers) c.ready = false
      }
    }
    /* Only after the pods' toleration for the NoExecute taint expires — five
     * minutes by default — does anything actually get deleted. */
    if (ctx.store.nodeUnreadyFor[index] > TIMING.notReadyTolerationSeconds) {
      for (let i = node.podUids.length - 1; i >= 0; i--) {
        const uid = node.podUids[i]
        const p = ctx.s.pods.get(uid)
        if (!p || podIsTerminating(p)) continue
        let tolerated = false
        for (const t of node.taints) {
          if (t.effect !== 'NoExecute') continue
          if (toleratesTaint(p.tolerations, t)) tolerated = true
        }
        if (tolerated) continue
        const podName = p.name
        submit(ctx, {
          verb: 'delete',
          kind: 'Pod',
          namespace: p.namespace,
          name: podName,
          subject: SUBJECTS.controllerManager,
          commit: (c) => deletePod(c, uid, 'NodeNotReady'),
        })
      }
    }
    return true
  }

  if (hasTaint(node, TAINT_UNREACHABLE) || hasTaint(node, TAINT_NOT_READY)) {
    removeTaint(node, TAINT_UNREACHABLE)
    removeTaint(node, TAINT_NOT_READY)
    emit(ctx, 'Normal', 'NodeReady', `node/${node.name}`, `Node ${node.name} status is now: NodeReady`)
    flushUnschedulable(ctx)
  }
  setCondition(node, 'Ready', 'True', 'KubeletReady')
  ctx.store.nodeUnreadyFor[index] = 0
  return true
}

/* ---------------------------------------------------------------------------
 * EndpointSlice controller. Readiness in, rule tables out.
 * -------------------------------------------------------------------------*/

function reconcileEndpointSlice(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  let svc: ServiceState | undefined
  for (const s of ctx.s.services) if (s.namespace === ns && s.name === name) svc = s
  if (!svc) return true
  rebuildEndpoints(ctx, svc)
  return true
}

export function rebuildEndpoints(ctx: SimCtx, svc: ServiceState): void {
  const eps = svc.endpoints
  let n = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.namespace !== svc.namespace) continue
    if (!p.ip) continue
    if (!selectorMatches(svc.selector, p.labels)) continue
    /* A terminating pod leaves the slice at once — before its containers stop.
     * That gap is deliberate: it is what makes a graceful shutdown graceful. */
    if (podIsTerminating(p)) continue
    if (p.phase !== 'Running') continue

    let entry = eps[n]
    if (!entry) {
      entry = { podUid: '', ip: '', ready: false, serving: false }
      eps.push(entry)
    }
    entry.podUid = p.uid
    entry.ip = p.ip
    entry.ready = podIsReady(p)
    entry.serving = anyContainerRunning(p)
    entry.nodeName = p.nodeName
    n += 1
  }
  if (eps.length > n) eps.length = n
}

function anyContainerRunning(p: PodState): boolean {
  for (const c of p.containers) {
    if (c.role === 'init') continue
    if (c.state === 'running') return true
  }
  return false
}

/* ---------------------------------------------------------------------------
 * PV binder.
 * -------------------------------------------------------------------------*/

function reconcilePvBinder(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const pvc = findPvc(ctx, ns, name)
  if (!pvc) {
    /* The claim is gone: release its volume per the class's reclaim policy. */
    for (const pv of ctx.s.pvs) {
      if (pv.boundClaim === k && pv.phase === 'Bound') reclaim(ctx, pv)
    }
    return true
  }
  return reconcileClaim(ctx, pvc)
}

/* ---------------------------------------------------------------------------
 * Garbage collector: the ownerReference graph, swept.
 * -------------------------------------------------------------------------*/

function ownerExists(ctx: SimCtx, uid: string, kind: Kind): boolean {
  if (kind === 'ReplicaSet') {
    for (const r of ctx.s.replicaSets) if (rsUid(r.namespace, r.name) === uid) return true
    return false
  }
  if (kind === 'StatefulSet') {
    for (const s of ctx.s.statefulSets) if (`sts:${s.namespace}/${s.name}` === uid) return true
    return false
  }
  if (kind === 'DaemonSet') {
    for (const d of ctx.s.daemonSets) if (`ds:${d.namespace}/${d.name}` === uid) return true
    return false
  }
  if (kind === 'Job') {
    for (const j of ctx.s.jobs) if (`job:${j.namespace}/${j.name}` === uid) return true
    return false
  }
  return true
}

function reconcileGc(ctx: SimCtx, _k: string): boolean {
  const pods = ctx.store.podList
  for (let i = pods.length - 1; i >= 0; i--) {
    const p = pods[i]
    if (p.owner && !ownerExists(ctx, p.owner.uid, p.owner.kind)) {
      /* An orphan: its controller is gone, so the object is garbage. */
      emit(ctx, 'Normal', 'OwnerRefGone', `pod/${p.name}`, `Deleting orphaned pod, owner ${p.owner.kind}/${p.owner.name} not found`)
      removePod(ctx, p.uid)
      continue
    }
    if (p.phase === 'Failed' || p.phase === 'Succeeded') {
      const rt = runtimeOf(ctx, p.uid)
      if (!rt) continue
      if (rt.terminalAt < 0) rt.terminalAt = ctx.s.t
      else if (ctx.s.t - rt.terminalAt > TERMINAL_POD_TTL) removePod(ctx, p.uid)
    }
  }
  /* A ReplicaSet whose Deployment is gone goes with it. */
  for (let i = ctx.s.replicaSets.length - 1; i >= 0; i--) {
    const r = ctx.s.replicaSets[i]
    let owner = false
    for (const d of ctx.s.deployments) if (d.namespace === r.namespace && d.name === r.ownerDeployment) owner = true
    if (!owner) {
      ctx.s.replicaSets.splice(i, 1)
      ctx.store.rsTemplate.delete(key(r.namespace, r.name))
    }
  }
  /* A PV whose claim no longer exists is Released. */
  for (const pv of ctx.s.pvs) {
    if (pv.phase !== 'Bound' || !pv.boundClaim) continue
    const slash = pv.boundClaim.indexOf('/')
    if (!findPvc(ctx, pv.boundClaim.slice(0, slash), pv.boundClaim.slice(slash + 1))) reclaim(ctx, pv)
  }
  return true
}

/* ---------------------------------------------------------------------------
 * Horizontal Pod Autoscaler. Utilisation is measured against *requests*.
 * -------------------------------------------------------------------------*/

function reconcileHpa(ctx: SimCtx, k: string): boolean {
  const slash = k.indexOf('/')
  const ns = k.slice(0, slash)
  const name = k.slice(slash + 1)
  const hpa = ctx.s.hpas.find((h) => h.namespace === ns && h.name === name)
  if (!hpa) return true
  const knobs = ctx.s.knobs

  hpa.minReplicas = knobs.hpaMinReplicas
  hpa.maxReplicas = knobs.hpaMaxReplicas
  hpa.targetUtilization = knobs.hpaTargetUtilization

  const targetName = hpa.targetRef.slice(hpa.targetRef.indexOf('/') + 1)
  const d = findDeployment(ctx, ns, targetName)
  if (!d) return true

  let usedCpu = 0
  let requestCpu = 0
  let counted = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.namespace !== ns || !selectorMatches(d.selector, p.labels)) continue
    if (!podIsReady(p)) continue
    counted += 1
    usedCpu += podUsedCpu(p)
    for (const c of p.containers) {
      if (c.role === 'init') continue
      requestCpu += c.requestCpuMilli
    }
  }

  if (counted === 0 || requestCpu === 0) {
    /* metrics-server has nothing to report; the HPA refuses to guess. */
    hpa.unknownMetrics = true
    hpa.currentUtilization = 0
    return true
  }
  hpa.unknownMetrics = false
  /* The denominator is the sum of *requests*. Using limits here is the single
   * most common misreading of the HPA, and it silently halves your scaling. */
  hpa.currentUtilization = Math.round((usedCpu / requestCpu) * 100)

  if (!knobs.hpaEnabled) {
    hpa.desiredReplicas = d.replicas
    return true
  }

  const ratio = hpa.currentUtilization / Math.max(1, hpa.targetUtilization)
  let desired = d.replicas
  /* The 10 % tolerance: inside it, the HPA does nothing at all. */
  if (Math.abs(ratio - 1) > 0.1) desired = Math.ceil(d.replicas * ratio)
  desired = clamp(desired, hpa.minReplicas, hpa.maxReplicas)
  hpa.desiredReplicas = desired

  /* Scale-down stabilization is a rolling window over the *recommendation*:
   * the HPA may only shrink once every recommendation for the last five
   * minutes has been below the current size. Any recommendation to hold or
   * grow rearms the window, which is why a bursty workload never shrinks. */
  if (desired >= d.replicas) {
    hpa.stabilizationRemaining = TIMING.hpaScaleDownStabilizationSeconds
  }

  if (desired === d.replicas) return true
  if (desired < d.replicas && hpa.stabilizationRemaining > 0) return true

  const from = d.replicas
  submit(ctx, {
    verb: 'patch',
    kind: 'Deployment',
    namespace: ns,
    name: targetName,
    subject: SUBJECTS.controllerManager,
    commit: (c) => {
      const dep = findDeployment(c, ns, targetName)
      if (!dep) return
      dep.replicas = desired
      c.s.knobs.replicas = desired
      /* Any rescale rearms the window: the next shrink starts its own clock. */
      hpa.stabilizationRemaining = TIMING.hpaScaleDownStabilizationSeconds
      emit(
        c,
        'Normal',
        'SuccessfulRescale',
        `horizontalpodautoscaler/${name}`,
        `New size: ${desired}; reason: cpu resource utilization (percentage of request) above target`,
      )
      enqueue(c.store.queues.get('deployment')!, key(ns, targetName))
    },
  })
  return true
}

/* ---------------------------------------------------------------------------
 * ServiceAccount and Namespace controllers.
 * -------------------------------------------------------------------------*/

function reconcileServiceAccount(ctx: SimCtx, k: string): boolean {
  /* Every namespace gets a `default` ServiceAccount whether you want one or
   * not; that is why every pod has a token mounted by default. */
  const name = `${k}/default`
  if (ctx.store.serviceAccounts.has(name)) return true
  ctx.store.serviceAccounts.add(name)
  submit(ctx, {
    verb: 'create',
    kind: 'ServiceAccount',
    namespace: k,
    name: 'default',
    subject: SUBJECTS.controllerManager,
    commit: (c) => emit(c, 'Normal', 'SuccessfulCreate', `namespace/${k}`, `Created serviceaccount default`),
  })
  return true
}

function reconcileNamespace(ctx: SimCtx, k: string): boolean {
  if (ctx.store.namespaces.indexOf(k) < 0) {
    /* Namespace deletion is a cascade: everything inside it goes first. */
    const pods = ctx.store.podList
    for (let i = pods.length - 1; i >= 0; i--) {
      if (pods[i].namespace === k) removePod(ctx, pods[i].uid)
    }
    return true
  }
  enqueue(ctx.store.queues.get('serviceaccount')!, k)
  return true
}

/* ---------------------------------------------------------------------------
 * The controller table.
 * -------------------------------------------------------------------------*/

interface ControllerDef {
  name: string
  watches: readonly Kind[]
  /** Enqueue every key this controller owns. The informer's periodic resync. */
  resync: (ctx: SimCtx, q: Workqueue) => void
  reconcile: (ctx: SimCtx, k: string) => boolean
  /** Objects the informer cache holds. */
  cached: (ctx: SimCtx) => number
}

const DEFS: Record<ControllerId, ControllerDef> = {
  deployment: {
    name: 'deployment-controller',
    watches: ['Deployment', 'ReplicaSet'],
    resync: (c, q) => {
      for (const d of c.s.deployments) enqueue(q, key(d.namespace, d.name))
    },
    reconcile: reconcileDeployment,
    cached: (c) => c.s.deployments.length + c.s.replicaSets.length,
  },
  replicaset: {
    name: 'replicaset-controller',
    watches: ['ReplicaSet', 'Pod'],
    resync: (c, q) => {
      for (const r of c.s.replicaSets) enqueue(q, key(r.namespace, r.name))
    },
    reconcile: reconcileReplicaSet,
    cached: (c) => c.s.replicaSets.length + c.s.pods.size,
  },
  statefulset: {
    name: 'statefulset-controller',
    watches: ['StatefulSet', 'Pod'],
    resync: (c, q) => {
      for (const s of c.s.statefulSets) enqueue(q, key(s.namespace, s.name))
    },
    reconcile: reconcileStatefulSet,
    cached: (c) => c.s.statefulSets.length + c.s.pods.size,
  },
  daemonset: {
    name: 'daemonset-controller',
    watches: ['DaemonSet', 'Pod', 'Node'],
    resync: (c, q) => {
      for (const d of c.s.daemonSets) enqueue(q, key(d.namespace, d.name))
    },
    reconcile: reconcileDaemonSet,
    cached: (c) => c.s.daemonSets.length + c.s.nodes.length,
  },
  job: {
    name: 'job-controller',
    watches: ['Job', 'Pod'],
    resync: (c, q) => {
      for (const j of c.s.jobs) enqueue(q, key(j.namespace, j.name))
    },
    reconcile: reconcileJob,
    cached: (c) => c.s.jobs.length,
  },
  cronjob: {
    name: 'cronjob-controller',
    watches: ['CronJob', 'Job'],
    resync: (_c, q) => enqueue(q, 'shop/report'),
    reconcile: reconcileCronJob,
    cached: (c) => 1 + c.s.jobs.length,
  },
  node: {
    name: 'node-lifecycle-controller',
    watches: ['Node', 'Lease'],
    resync: (c, q) => {
      for (const n of c.s.nodes) enqueue(q, n.name)
    },
    reconcile: reconcileNode,
    cached: (c) => c.s.nodes.length * 2,
  },
  endpointslice: {
    name: 'endpointslice-controller',
    watches: ['Service', 'Pod', 'EndpointSlice'],
    resync: (c, q) => {
      for (const s of c.s.services) enqueue(q, key(s.namespace, s.name))
    },
    reconcile: reconcileEndpointSlice,
    cached: (c) => c.s.services.length + c.s.pods.size,
  },
  'pv-binder': {
    name: 'persistentvolume-binder',
    watches: ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'],
    resync: (c, q) => {
      for (const p of c.s.pvcs) enqueue(q, key(p.namespace, p.name))
    },
    reconcile: reconcilePvBinder,
    cached: (c) => c.s.pvcs.length + c.s.pvs.length + c.s.storageClasses.length,
  },
  'garbage-collector': {
    name: 'garbage-collector',
    watches: ['Pod', 'ReplicaSet', 'PersistentVolume'],
    resync: (_c, q) => enqueue(q, 'cluster'),
    reconcile: reconcileGc,
    cached: (c) => c.s.pods.size + c.s.replicaSets.length,
  },
  hpa: {
    name: 'horizontal-pod-autoscaler',
    watches: ['HorizontalPodAutoscaler', 'Deployment'],
    resync: (c, q) => {
      for (const h of c.s.hpas) enqueue(q, key(h.namespace, h.name))
    },
    reconcile: reconcileHpa,
    cached: (c) => c.s.hpas.length + c.s.deployments.length,
  },
  serviceaccount: {
    name: 'serviceaccount-controller',
    watches: ['Namespace', 'ServiceAccount'],
    resync: (c, q) => {
      for (const n of c.store.namespaces) enqueue(q, n)
    },
    reconcile: reconcileServiceAccount,
    cached: (c) => c.store.serviceAccounts.size,
  },
  namespace: {
    name: 'namespace-controller',
    watches: ['Namespace'],
    resync: (c, q) => {
      for (const n of c.store.namespaces) enqueue(q, n)
    },
    reconcile: reconcileNamespace,
    cached: (c) => c.store.namespaces.length,
  },
}

/* Which controllers wake on a write of each Kind. This is the watch fan-out. */
const WATCHERS_BY_KIND = new Map<Kind, ControllerId[]>()
for (const id in DEFS) {
  const cid = id as ControllerId
  for (const k of DEFS[cid].watches) {
    let list = WATCHERS_BY_KIND.get(k)
    if (!list) {
      list = []
      WATCHERS_BY_KIND.set(k, list)
    }
    list.push(cid)
  }
}

/** Every informer that cares wakes on the same revision. */
export function controllerWatch(ctx: SimCtx, kind: Kind, ns: string, name: string): void {
  const ids = WATCHERS_BY_KIND.get(kind)
  if (!ids) return
  for (const id of ids) {
    const q = ctx.store.queues.get(id)
    if (!q) continue
    /* A controller keys off its own object, so a Pod event has to be mapped
     * back to the owner it belongs to. Resync covers the rest. */
    if (kind === DEFS[id].watches[0]) enqueue(q, kind === 'Node' || kind === 'Namespace' ? name : key(ns, name))
    else DEFS[id].resync(ctx, q)
  }
}

/* ---------------------------------------------------------------------------
 * Leader election. Both elected components hold a Lease in kube-system; lose
 * etcd and you lose the lease, and every reconcile loop in the cluster stops.
 * -------------------------------------------------------------------------*/

export function tickLeaderElection(ctx: SimCtx, dt: number): void {
  ctx.store.cmLeaseAge += dt
  ctx.store.schedLeaseAge += dt

  /* Renewal is attempted on a fixed retry period, not as fast as the previous
   * attempt fails; otherwise a broken API server sees a self-inflicted storm. */
  const renewPeriod = MODEL.leaderLeaseSeconds / 3
  if (
    ctx.store.cmLeaseAge >= renewPeriod &&
    !ctx.store.cmLeaseInflight &&
    ctx.s.t >= ctx.store.cmAttemptAt
  ) {
    ctx.store.cmLeaseInflight = true
    ctx.store.cmAttemptAt = ctx.s.t + renewPeriod
    submit(ctx, {
      verb: 'update',
      kind: 'Lease',
      namespace: 'kube-system',
      name: 'kube-controller-manager',
      subject: SUBJECTS.controllerManager,
      commit: (c) => {
        c.store.cmLeaseAge = 0
      },
      done: (c) => {
        c.store.cmLeaseInflight = false
      },
    })
  }
  if (
    ctx.store.schedLeaseAge >= renewPeriod &&
    !ctx.store.schedLeaseInflight &&
    ctx.s.t >= ctx.store.schedAttemptAt
  ) {
    ctx.store.schedLeaseInflight = true
    ctx.store.schedAttemptAt = ctx.s.t + renewPeriod
    submit(ctx, {
      verb: 'update',
      kind: 'Lease',
      namespace: 'kube-system',
      name: 'kube-scheduler',
      subject: SUBJECTS.scheduler,
      commit: (c) => {
        c.store.schedLeaseAge = 0
      },
      done: (c) => {
        c.store.schedLeaseInflight = false
      },
    })
  }

  const cmLeading = ctx.store.cmLeaseAge < MODEL.leaderLeaseSeconds
  for (const id of ctx.store.controllerOrder) {
    const cs = ctx.s.controllers[id]
    if (cs.leading && !cmLeading) {
      emit(ctx, 'Warning', 'LeaderLost', `lease/kube-controller-manager`, 'failed to renew lease, stopping controllers')
    }
    cs.leading = cmLeading
  }
  const schedLeading = ctx.store.schedLeaseAge < MODEL.leaderLeaseSeconds
  ctx.s.scheduler.leading = schedLeading
}

/* ---------------------------------------------------------------------------
 * The reconcile machine: one key at a time, through the four phases.
 * -------------------------------------------------------------------------*/

function stepController(ctx: SimCtx, id: ControllerId, dt: number): void {
  const cs: ControllerState = ctx.s.controllers[id]
  const def = DEFS[id]
  const q = ctx.store.queues.get(id)!
  cs.queueDepth = q.keys.length
  cs.cached = def.cached(ctx)

  if (!cs.leading) {
    cs.phase = 'idle'
    cs.progress = 0
    cs.currentKey = undefined
    return
  }

  if (cs.phase === 'idle') {
    const k = dequeue(q, ctx.s.t)
    if (k === undefined) return
    cs.currentKey = k
    cs.phase = 'dequeue'
    cs.progress = 0
    ctx.store.phaseClock.set(id, 0)
    return
  }

  const clock = (ctx.store.phaseClock.get(id) ?? 0) + dt
  cs.progress = clamp(clock / MODEL.reconcilePhaseSeconds, 0, 1)
  if (clock < MODEL.reconcilePhaseSeconds) {
    ctx.store.phaseClock.set(id, clock)
    return
  }
  ctx.store.phaseClock.set(id, 0)
  cs.progress = 0

  switch (cs.phase) {
    case 'dequeue':
      cs.phase = 'diff'
      return
    case 'diff':
      cs.phase = 'act'
      return
    case 'act': {
      const k = cs.currentKey ?? ''
      let ok = false
      try {
        ok = def.reconcile(ctx, k)
      } catch (err) {
        ok = false
        console.error(`[sim] ${id} reconcile threw`, err)
      }
      cs.reconciles += 1
      if (ok) {
        forgetKey(q, k)
        cs.backoffSeconds = 0
      } else {
        cs.errors += 1
        cs.backoffSeconds = requeueWithBackoff(q, k, ctx.s.t)
      }
      cs.phase = 'requeue'
      return
    }
    case 'requeue':
      cs.phase = 'idle'
      cs.currentKey = undefined
      return
    default:
      cs.phase = 'idle'
  }
}

/**
 * Clocks that advance with wall time, not with how often a reconcile happens.
 * A CronJob schedule and the node-eviction timer are properties of the world;
 * the controller only notices them when it next runs.
 */
function tickControllerTimers(ctx: SimCtx, dt: number): void {
  ctx.store.cronClock += dt
  for (let i = 0; i < ctx.s.nodes.length; i++) {
    const node = ctx.s.nodes[i]
    if (node.kubelet.sinceLeaseSeconds > TIMING.nodeMonitorGraceSeconds) {
      ctx.store.nodeUnreadyFor[i] += dt
      /* Nothing on a dead node counts down a grace period, so the control
       * plane does it here. A real cluster leaves the pod Terminating until
       * the node returns or an operator forces the delete. */
      for (let j = node.podUids.length - 1; j >= 0; j--) {
        const p = ctx.s.pods.get(node.podUids[j])
        if (!p || p.deletionGraceSeconds === undefined) continue
        p.deletionGraceSeconds = Math.max(0, p.deletionGraceSeconds - dt)
        if (p.deletionGraceSeconds <= 0) removePod(ctx, p.uid)
      }
    } else {
      ctx.store.nodeUnreadyFor[i] = 0
    }
  }
}

export function tickControllers(ctx: SimCtx, dt: number): void {
  tickControllerTimers(ctx, dt)
  ctx.store.resyncClock += dt
  const doResync = ctx.store.resyncClock >= RESYNC_SECONDS
  if (doResync) ctx.store.resyncClock = 0

  for (const id of ctx.store.controllerOrder) {
    if (doResync && ctx.s.controllers[id].leading) {
      DEFS[id].resync(ctx, ctx.store.queues.get(id)!)
    }
    stepController(ctx, id, dt)
  }

  updatePdbs(ctx)
  tickDrain(ctx, dt)
}

/* ---------------------------------------------------------------------------
 * PodDisruptionBudgets and drain.
 *
 * The disruption controller has no machine in the yard because ControllerId
 * has no entry for it; its status is maintained here so a PDB is never stale.
 * -------------------------------------------------------------------------*/

function updatePdbs(ctx: SimCtx): void {
  for (const pdb of ctx.s.pdbs) {
    let healthy = 0
    const pods = ctx.store.podList
    for (let i = 0; i < pods.length; i++) {
      const p = pods[i]
      if (p.namespace !== pdb.namespace) continue
      if (!selectorMatches(pdb.selector, p.labels)) continue
      if (podIsReady(p)) healthy += 1
    }
    pdb.currentHealthy = healthy
    pdb.disruptionsAllowed = Math.max(0, healthy - pdb.minAvailable)
  }
}

/** `kubectl drain`: cordon, then evict everything the budgets will let go. */
export function drainNode(ctx: SimCtx, index: number): void {
  const node = ctx.s.nodes[index]
  if (!node) return
  node.unschedulable = true
  ctx.store.draining.set(index, 0)
  emit(ctx, 'Normal', 'NodeCordoned', `node/${node.name}`, `Node ${node.name} cordoned`)
}

export function uncordonNode(ctx: SimCtx, index: number): void {
  const node = ctx.s.nodes[index]
  if (!node) return
  node.unschedulable = false
  ctx.store.draining.delete(index)
  flushUnschedulable(ctx)
}

const DRAIN_RETRY_SECONDS = 3

function tickDrain(ctx: SimCtx, dt: number): void {
  if (ctx.store.draining.size === 0) return
  for (const [index, clock] of ctx.store.draining) {
    const next = clock + dt
    if (next < DRAIN_RETRY_SECONDS) {
      ctx.store.draining.set(index, next)
      continue
    }
    ctx.store.draining.set(index, 0)
    const node = ctx.s.nodes[index]
    if (!node) {
      ctx.store.draining.delete(index)
      continue
    }
    let target: PodState | null = null
    for (const uid of node.podUids) {
      const p = ctx.s.pods.get(uid)
      if (!p || podIsTerminating(p)) continue
      /* drain skips DaemonSet pods; they come back the instant they are gone. */
      if (p.owner?.kind === 'DaemonSet') continue
      target = p
      break
    }
    if (!target) {
      ctx.store.draining.delete(index)
      emit(ctx, 'Normal', 'DrainSucceeded', `node/${node.name}`, `Drained node ${node.name}`)
      continue
    }
    let blockedBy = ''
    for (const pdb of ctx.s.pdbs) {
      if (pdb.namespace !== target.namespace) continue
      if (!selectorMatches(pdb.selector, target.labels)) continue
      if (pdb.disruptionsAllowed <= 0) blockedBy = pdb.name
    }
    if (blockedBy) {
      /* The eviction API answers 429 with this exact text. It is surfaced as a
       * Warning here because the model has no place to show an HTTP response. */
      emit(
        ctx,
        'Warning',
        'EvictionBlocked',
        `pod/${target.name}`,
        `Cannot evict pod as it would violate the pod's disruption budget (${blockedBy}).`,
      )
      continue
    }
    const uid = target.uid
    const podName = target.name
    submit(ctx, {
      verb: 'delete',
      kind: 'Pod',
      namespace: target.namespace,
      name: podName,
      subject: SUBJECTS.admin,
      commit: (c) => deletePod(c, uid, 'Drain'),
    })
    emit(ctx, 'Normal', 'Evicted', `pod/${podName}`, `Evicted pod ${podName} from node ${node.name}`)
  }
}

/* ---------------------------------------------------------------------------
 * Per-tick decay that belongs to controller state.
 * -------------------------------------------------------------------------*/

export function tickHpaStabilization(ctx: SimCtx, dt: number): void {
  for (const h of ctx.s.hpas) {
    if (h.stabilizationRemaining > 0) h.stabilizationRemaining = Math.max(0, h.stabilizationRemaining - dt)
  }
}

/** Exposed so scenarios and the model can push a key without a watch event. */
export function enqueueKey(ctx: SimCtx, id: ControllerId, k: string): void {
  const q = ctx.store.queues.get(id)
  if (q) enqueue(q, k)
}
