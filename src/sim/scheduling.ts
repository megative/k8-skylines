/* ============================================================================
 * sim/scheduling.ts — kube-scheduler: filter, score, reserve, bind.
 *
 * The one thing this file must get exactly right is why a Pod is Pending.
 * `Pending` is never a queue position: it means every node failed at least one
 * filter, and the aggregated reason is written onto the pod. Every filter here
 * compares the pod's *requests* against the node's *allocatable minus already
 * requested*. Actual usage never enters the decision — a node running at 95 %
 * CPU will happily accept another pod if the requests still fit, which is the
 * single most common surprise in a real cluster.
 * ==========================================================================*/

import {
  N_NODES,
  TIMING,
  type FilterReason,
  type NodeState,
  type NodeVerdict,
  type PodState,
  type SchedulingCycle,
  type Taint,
} from '../core/types'
import { clamp } from '../core/util'
import { submit, SUBJECTS } from './controlplane'
import {
  MODEL,
  deletePod,
  emit,
  nodeByName,
  nodeLabel,
  podIsTerminating,
  podRequestCpu,
  podRequestMem,
  runtimeOf,
  toleratesTaint,
  type SimCtx,
} from './ctx'

/* The order these appear in the aggregated `0/N nodes are available:` message. */
const FILTER_REASONS: readonly FilterReason[] = [
  'node(s) were unschedulable',
  "node(s) didn't match node affinity",
  'node(s) had untolerated taint',
  'Too many pods',
  'Insufficient cpu',
  'Insufficient memory',
  'node(s) had volume node affinity conflict',
  "node(s) didn't match pod anti-affinity rules",
  "node(s) didn't satisfy topology spread constraints",
]

/* Scoring plugins, with the default weights kube-scheduler ships. */
const PLUGIN_WEIGHT = {
  NodeResourcesFit: 1,
  ImageLocality: 1,
  InterPodAffinity: 2,
  TaintToleration: 3,
  NodeAffinity: 2,
} as const
const TOTAL_WEIGHT =
  PLUGIN_WEIGHT.NodeResourcesFit +
  PLUGIN_WEIGHT.ImageLocality +
  PLUGIN_WEIGHT.InterPodAffinity +
  PLUGIN_WEIGHT.TaintToleration +
  PLUGIN_WEIGHT.NodeAffinity

/**
 * How long a preemptor's claim on its node survives. In kube-scheduler the
 * nomination lives until the pod schedules; here it also times out, so a
 * nomination whose victims never actually leave cannot deadlock the queue.
 */
const NOMINATION_HOLD_SECONDS = TIMING.terminationGraceSeconds * 3
const NOMINATION_RETRY_SECONDS = 2

/** Reused every cycle. A scheduling cycle must not allocate. */
const CYCLE: SchedulingCycle = {
  podUid: '',
  podName: '',
  phase: 'idle',
  progress: 0,
  verdicts: [],
  preempting: [],
}

/* ---------------------------------------------------------------------------
 * Filters.
 * -------------------------------------------------------------------------*/

function matchesNodeSelector(ctx: SimCtx, nodeIndex: number, sel: Record<string, string>): boolean {
  for (const k in sel) {
    if (nodeLabel(ctx, nodeIndex, k) !== sel[k]) return false
  }
  return true
}

function untoleratedTaint(pod: PodState, node: NodeState): Taint | null {
  for (const t of node.taints) {
    /* PreferNoSchedule is a scoring signal, never a filter. */
    if (t.effect === 'PreferNoSchedule') continue
    if (!toleratesTaint(pod.tolerations, t)) return t
  }
  return null
}

function volumeConflict(ctx: SimCtx, pod: PodState, node: NodeState): boolean {
  for (const claimName of pod.volumeClaims) {
    for (const pvc of ctx.s.pvcs) {
      if (pvc.namespace !== pod.namespace || pvc.name !== claimName) continue
      if (!pvc.boundPv) break
      const pinned = ctx.store.pvNodeAffinity.get(pvc.boundPv)
      if (pinned && pinned !== node.name) return true
      /* ReadWriteOnce: a volume already attached elsewhere and still in use by
       * a live pod cannot be attached to a second node. */
      for (const pv of ctx.s.pvs) {
        if (pv.name !== pvc.boundPv) continue
        if (pv.accessMode !== 'ReadWriteOnce') break
        if (pv.attachedNode && pv.attachedNode !== node.name && volumeStillInUse(ctx, pvc.name, pod.uid)) {
          return true
        }
        break
      }
      break
    }
  }
  return false
}

function volumeStillInUse(ctx: SimCtx, claimName: string, exceptUid: string): boolean {
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.uid === exceptUid || !p.nodeName || podIsTerminating(p)) continue
    for (const c of p.volumeClaims) if (c === claimName) return true
  }
  return false
}

function antiAffinityConflict(ctx: SimCtx, pod: PodState, node: NodeState): boolean {
  if (!ctx.s.knobs.podAntiAffinity) return false
  const labelKey = ctx.store.antiAffinity.get(pod.uid)
  if (!labelKey) return false
  const want = pod.labels[labelKey]
  if (want === undefined) return false
  for (const uid of node.podUids) {
    if (uid === pod.uid) continue
    const other = ctx.s.pods.get(uid)
    if (!other || podIsTerminating(other)) continue
    if (other.labels[labelKey] === want) return true
  }
  return false
}

/*
 * Space held for pods that have already preempted onto a node and are waiting
 * for their victims to die. A lower-priority pod must not take that space, or
 * the preemptor would preempt again and the cluster would unravel.
 */
let nominatedCpu = 0
let nominatedMem = 0

function reserveNominated(ctx: SimCtx, nodeName: string, priority: number, exceptUid: string): void {
  nominatedCpu = 0
  nominatedMem = 0
  if (ctx.store.nominated.size === 0) return
  for (const [uid, nom] of ctx.store.nominated) {
    if (uid === exceptUid || nom.node !== nodeName || ctx.s.t >= nom.until) continue
    const p = ctx.s.pods.get(uid)
    if (!p || p.nodeName || p.priority < priority) continue
    nominatedCpu += podRequestCpu(p)
    nominatedMem += podRequestMem(p)
  }
}

/**
 * Run every filter for one node. The order matches kube-scheduler's plugin
 * order so the reported reason is the one a real cluster would report.
 */
export function filterNode(ctx: SimCtx, nodeIndex: number, pod: PodState): FilterReason | undefined {
  const node = ctx.s.nodes[nodeIndex]

  if (node.unschedulable) return 'node(s) were unschedulable'
  if (pod.nodeSelector && !matchesNodeSelector(ctx, nodeIndex, pod.nodeSelector)) {
    return "node(s) didn't match node affinity"
  }
  if (untoleratedTaint(pod, node)) return 'node(s) had untolerated taint'

  if (node.podUids.length >= node.capacityPods) return 'Too many pods'

  /* allocatable minus requests. Never usage, never limits. */
  reserveNominated(ctx, node.name, pod.priority, pod.uid)
  const freeCpu = node.allocatableCpuMilli - node.requestedCpuMilli - nominatedCpu
  const freeMem = node.allocatableMemMib - node.requestedMemMib - nominatedMem
  if (podRequestCpu(pod) > freeCpu) return 'Insufficient cpu'
  if (podRequestMem(pod) > freeMem) return 'Insufficient memory'

  if (volumeConflict(ctx, pod, node)) return 'node(s) had volume node affinity conflict'
  if (antiAffinityConflict(ctx, pod, node)) return "node(s) didn't match pod anti-affinity rules"
  return undefined
}

/* ---------------------------------------------------------------------------
 * Scoring.
 * -------------------------------------------------------------------------*/

function scoreNodeResourcesFit(ctx: SimCtx, node: NodeState, pod: PodState): number {
  const cpu = clamp((node.requestedCpuMilli + podRequestCpu(pod)) / node.allocatableCpuMilli, 0, 1)
  const mem = clamp((node.requestedMemMib + podRequestMem(pod)) / node.allocatableMemMib, 0, 1)
  /* LeastAllocated: the emptier node wins. */
  return ((1 - cpu) + (1 - mem)) * 50
}

function scoreImageLocality(node: NodeState, pod: PodState): number {
  let total = 0
  let cached = 0
  for (const c of pod.containers) {
    total += 1
    if (node.imageCache.includes(c.image)) cached += 1
  }
  return total === 0 ? 0 : (cached / total) * 100
}

function scoreInterPodAffinity(ctx: SimCtx, node: NodeState, pod: PodState): number {
  const want = pod.labels['app']
  if (want === undefined) return 100
  let same = 0
  for (const uid of node.podUids) {
    const other = ctx.s.pods.get(uid)
    if (other && other.labels['app'] === want) same += 1
  }
  /* Spreading: each co-located sibling costs 25 points. */
  return clamp(100 - same * 25, 0, 100)
}

function scoreTaintToleration(node: NodeState, pod: PodState): number {
  let penalty = 0
  for (const t of node.taints) {
    if (t.effect !== 'PreferNoSchedule') continue
    if (!toleratesTaint(pod.tolerations, t)) penalty += 50
  }
  return clamp(100 - penalty, 0, 100)
}

/** Preferred (soft) node affinity: the demo web pods prefer SSD nodes. */
function scoreNodeAffinity(ctx: SimCtx, nodeIndex: number, pod: PodState): number {
  if (pod.labels['app'] !== 'web') return 50
  return nodeLabel(ctx, nodeIndex, 'disktype') === 'ssd' ? 100 : 0
}

function scoreNode(ctx: SimCtx, nodeIndex: number, pod: PodState, verdict: NodeVerdict): void {
  const node = ctx.s.nodes[nodeIndex]
  const bd = verdict.scoreBreakdown!
  bd.length = 0

  const fit = scoreNodeResourcesFit(ctx, node, pod)
  const img = scoreImageLocality(node, pod)
  const affinity = scoreInterPodAffinity(ctx, node, pod)
  const taint = scoreTaintToleration(node, pod)
  const nodeAff = scoreNodeAffinity(ctx, nodeIndex, pod)

  bd.push({ plugin: 'NodeResourcesFit', score: Math.round(fit) })
  bd.push({ plugin: 'ImageLocality', score: Math.round(img) })
  bd.push({ plugin: 'InterPodAffinity', score: Math.round(affinity) })
  bd.push({ plugin: 'TaintToleration', score: Math.round(taint) })
  bd.push({ plugin: 'NodeAffinity', score: Math.round(nodeAff) })

  const weighted =
    fit * PLUGIN_WEIGHT.NodeResourcesFit +
    img * PLUGIN_WEIGHT.ImageLocality +
    affinity * PLUGIN_WEIGHT.InterPodAffinity +
    taint * PLUGIN_WEIGHT.TaintToleration +
    nodeAff * PLUGIN_WEIGHT.NodeAffinity
  verdict.score = Math.round(weighted / TOTAL_WEIGHT)
}

/* ---------------------------------------------------------------------------
 * Queues.
 * -------------------------------------------------------------------------*/

export function enqueuePod(ctx: SimCtx, uid: string): void {
  const sched = ctx.s.scheduler
  if (sched.activeQueue.includes(uid)) return
  const bi = sched.backoffQueue.indexOf(uid)
  if (bi >= 0) sched.backoffQueue.splice(bi, 1)
  const ui = sched.unschedulableQueue.indexOf(uid)
  if (ui >= 0) sched.unschedulableQueue.splice(ui, 1)
  sched.activeQueue.push(uid)
}

/** A cluster change may have made a parked pod schedulable. Move them back. */
export function flushUnschedulable(ctx: SimCtx): void {
  const sched = ctx.s.scheduler
  while (sched.unschedulableQueue.length > 0) {
    const uid = sched.unschedulableQueue.pop()!
    if (ctx.s.pods.has(uid)) sched.activeQueue.push(uid)
  }
}

function backoffPod(ctx: SimCtx, uid: string, fixedDelay?: number): void {
  const sched = ctx.s.scheduler
  let next: number
  if (fixedDelay !== undefined) {
    next = fixedDelay
  } else {
    const prev = ctx.store.schedRate.get(uid) ?? 0
    next = clamp(prev === 0 ? 1 : prev * 2, 1, 10)
    ctx.store.schedRate.set(uid, next)
  }
  ctx.store.schedReadyAt.set(uid, ctx.s.t + next)
  if (!sched.backoffQueue.includes(uid)) sched.backoffQueue.push(uid)
}

function drainBackoff(ctx: SimCtx): void {
  const sched = ctx.s.scheduler
  for (let i = sched.backoffQueue.length - 1; i >= 0; i--) {
    const uid = sched.backoffQueue[i]
    if (!ctx.s.pods.has(uid)) {
      sched.backoffQueue.splice(i, 1)
      continue
    }
    const at = ctx.store.schedReadyAt.get(uid) ?? 0
    if (at > ctx.s.t) continue
    sched.backoffQueue.splice(i, 1)
    sched.activeQueue.push(uid)
  }
}

/* ---------------------------------------------------------------------------
 * Preemption. A pod may only preempt strictly lower-priority pods, and only if
 * removing them actually makes it fit.
 * -------------------------------------------------------------------------*/

/**
 * Fill `out` with the pods that would have to go for `pod` to fit on this
 * node, lowest priority first. Returns false if it still would not fit — a
 * pod may only ever preempt strictly lower-priority pods.
 */
function collectVictims(ctx: SimCtx, nodeIndex: number, pod: PodState, out: string[]): boolean {
  out.length = 0
  const node = ctx.s.nodes[nodeIndex]
  if (node.unschedulable || untoleratedTaint(pod, node)) return false
  if (pod.nodeSelector && !matchesNodeSelector(ctx, nodeIndex, pod.nodeSelector)) return false

  const needCpu = podRequestCpu(pod)
  const needMem = podRequestMem(pod)
  let freeCpu = node.allocatableCpuMilli - node.requestedCpuMilli
  let freeMem = node.allocatableMemMib - node.requestedMemMib

  while (freeCpu < needCpu || freeMem < needMem) {
    let victim = ''
    let victimPriority = pod.priority
    for (const uid of node.podUids) {
      if (out.indexOf(uid) >= 0) continue
      const p = ctx.s.pods.get(uid)
      if (!p || podIsTerminating(p)) continue
      if (p.priority >= pod.priority) continue
      if (victim !== '' && p.priority >= victimPriority) continue
      victim = uid
      victimPriority = p.priority
    }
    if (victim === '') return false
    const p = ctx.s.pods.get(victim)!
    freeCpu += podRequestCpu(p)
    freeMem += podRequestMem(p)
    out.push(victim)
  }
  return out.length > 0
}

function findPreemptionVictims(ctx: SimCtx, pod: PodState, out: string[]): number {
  out.length = 0
  if (pod.priority <= 0) return -1
  let bestNode = -1
  let bestCount = Infinity
  for (let n = 0; n < ctx.s.nodes.length; n++) {
    if (!collectVictims(ctx, n, pod, ctx.store.preemptTrial)) continue
    if (ctx.store.preemptTrial.length < bestCount) {
      bestCount = ctx.store.preemptTrial.length
      bestNode = n
    }
  }
  if (bestNode < 0) return -1
  collectVictims(ctx, bestNode, pod, out)
  return bestNode
}

/* ---------------------------------------------------------------------------
 * The cycle.
 * -------------------------------------------------------------------------*/

function beginCycle(ctx: SimCtx, pod: PodState): void {
  CYCLE.podUid = pod.uid
  CYCLE.podName = `${pod.namespace}/${pod.name}`
  CYCLE.phase = 'dequeue'
  CYCLE.progress = 0
  CYCLE.chosen = undefined
  CYCLE.unschedulableReason = undefined
  CYCLE.preempting.length = 0
  CYCLE.verdicts = ctx.store.verdictScratch
  ctx.s.scheduler.cycle = CYCLE
  ctx.store.cycleStartedAt = ctx.s.t
}

function endCycle(ctx: SimCtx): void {
  CYCLE.phase = 'idle'
  ctx.s.scheduler.cycle = undefined
}

function runFilters(ctx: SimCtx, pod: PodState): number {
  const verdicts = ctx.store.verdictScratch
  const tally = ctx.store.reasonTally
  tally.length = FILTER_REASONS.length
  for (let i = 0; i < tally.length; i++) tally[i] = 0

  let passed = 0
  for (let n = 0; n < N_NODES; n++) {
    const v = verdicts[n]
    v.nodeName = ctx.s.nodes[n].name
    v.score = undefined
    /* A machine that is not in the cluster produces no verdict at all. The
     * scheduler cannot reject a Node object it has never seen, and counting it
     * as a rejection would make `0/4 nodes are available` lie about the size of
     * the cluster. */
    if (!ctx.s.nodes[n].present) {
      v.passed = false
      v.reason = undefined
      v.absent = true
      continue
    }
    v.absent = false
    const reason = filterNode(ctx, n, pod)
    v.passed = reason === undefined
    v.reason = reason
    if (reason === undefined) {
      passed += 1
    } else {
      const idx = FILTER_REASONS.indexOf(reason)
      if (idx >= 0) tally[idx] += 1
    }
  }
  return passed
}

/** The exact shape of the message on a Pending pod: `0/4 nodes are available: ...`. */
function aggregateReason(ctx: SimCtx): string {
  const tally = ctx.store.reasonTally
  let parts = ''
  for (let i = 0; i < FILTER_REASONS.length; i++) {
    if (tally[i] === 0) continue
    if (parts.length > 0) parts += ', '
    parts += `${tally[i]} ${FILTER_REASONS[i]}`
  }
  /* The denominator is the cluster's real size, not the geometry's capacity:
   * a three-node cluster must not report `0/4`. */
  return `0/${ctx.s.knobs.nodeCount} nodes are available: ${parts}.`
}

function bind(ctx: SimCtx, pod: PodState, nodeIndex: number): void {
  const node = ctx.s.nodes[nodeIndex]
  ctx.store.bindPending = true
  ctx.store.bindDone = false
  ctx.store.bindOk = false
  const uid = pod.uid
  /* A Binding really is `POST .../pods/<name>/binding`: the scheduler has no
   * privileged path into etcd, it queues behind admission like everyone else. */
  submit(ctx, {
    verb: 'create',
    kind: 'Pod',
    namespace: pod.namespace,
    name: pod.name,
    subject: SUBJECTS.scheduler,
    commit: (c) => {
      const p = c.s.pods.get(uid)
      if (!p || p.nodeName) return
      p.nodeName = node.name
      p.conditions.PodScheduled = true
      node.podUids.push(uid)
      node.requestedCpuMilli += podRequestCpu(p)
      node.requestedMemMib += podRequestMem(p)
      c.store.nominated.delete(uid)
      const rt = runtimeOf(c, uid)
      if (rt) {
        rt.hostIndex = nodeIndex
        rt.boundAt = c.s.t
        rt.stage = 'pulling'
        rt.stageProgress = 0
      }
      emit(
        c,
        'Normal',
        'Scheduled',
        `pod/${p.name}`,
        `Successfully assigned ${p.namespace}/${p.name} to ${node.name}`,
      )
    },
    done: (c, outcome, reason) => {
      c.store.bindPending = false
      c.store.bindDone = true
      c.store.bindOk = outcome === 'ok'
      if (outcome !== 'ok') {
        const p = c.s.pods.get(uid)
        if (p) {
          emit(
            c,
            'Warning',
            'FailedScheduling',
            `pod/${p.name}`,
            `binding rejected: ${reason || outcome}`,
          )
        }
      }
    },
  })
}

export function tickScheduler(ctx: SimCtx, dt: number): void {
  const sched = ctx.s.scheduler

  /* Without the lease this process is a hot spare: it watches, it does not act. */
  if (!sched.leading) {
    if (sched.cycle) endCycle(ctx)
    return
  }

  drainBackoff(ctx)
  ctx.store.unschedFlushClock += dt
  if (ctx.store.unschedFlushClock >= 30) {
    ctx.store.unschedFlushClock = 0
    flushUnschedulable(ctx)
  }

  if (!sched.cycle) {
    /* Highest priority first, then FIFO — the real activeQ ordering. */
    let best = -1
    let bestPriority = -Infinity
    for (let i = 0; i < sched.activeQueue.length; i++) {
      const p = ctx.s.pods.get(sched.activeQueue[i])
      if (!p) continue
      if (p.priority > bestPriority) {
        bestPriority = p.priority
        best = i
      }
    }
    if (best < 0) {
      sched.activeQueue.length = 0
      return
    }
    const uid = sched.activeQueue.splice(best, 1)[0]
    const pod = ctx.s.pods.get(uid)
    if (!pod || pod.nodeName || podIsTerminating(pod)) return
    beginCycle(ctx, pod)
    return
  }

  const pod = ctx.s.pods.get(CYCLE.podUid)
  if (!pod || podIsTerminating(pod)) {
    endCycle(ctx)
    return
  }

  if (CYCLE.phase === 'bind') {
    if (ctx.store.bindDone) {
      ctx.store.bindDone = false
      if (ctx.store.bindOk) {
        sched.scheduled += 1
        const took = (ctx.s.t - ctx.store.cycleStartedAt) * 1000
        sched.latencyMs = sched.latencyMs === 0 ? took : sched.latencyMs * 0.8 + took * 0.2
        ctx.store.schedRate.delete(pod.uid)
        ctx.store.schedReadyAt.delete(pod.uid)
      } else {
        sched.failed += 1
        backoffPod(ctx, pod.uid)
      }
      endCycle(ctx)
    }
    return
  }

  CYCLE.progress += dt / MODEL.schedulerPhaseSeconds
  if (CYCLE.progress < 1) return
  CYCLE.progress = 0

  switch (CYCLE.phase) {
    case 'dequeue':
      CYCLE.phase = 'filter'
      return

    case 'filter': {
      const passed = runFilters(ctx, pod)
      if (passed > 0) {
        CYCLE.phase = 'score'
        return
      }
      /* Already preempted once and the victims are still shutting down. Wait:
       * preempting again here would cascade through the whole cluster. */
      const nomination = ctx.store.nominated.get(pod.uid)
      if (nomination && ctx.s.t < nomination.until) {
        CYCLE.unschedulableReason = `0/${N_NODES} nodes are available: waiting for preempted pods on ${nomination.node} to terminate.`
        sched.failed += 1
        /* A short, flat retry: the space is reserved, so the only thing this
         * pod is waiting for is the victims' grace period to run out. */
        backoffPod(ctx, pod.uid, NOMINATION_RETRY_SECONDS)
        endCycle(ctx)
        return
      }

      /* Nothing fits. Try preemption before parking the pod. */
      const victimNode = findPreemptionVictims(ctx, pod, ctx.store.preemptScratch)
      if (victimNode >= 0) {
        CYCLE.preempting.length = 0
        ctx.store.nominated.set(pod.uid, {
          node: ctx.s.nodes[victimNode].name,
          until: ctx.s.t + NOMINATION_HOLD_SECONDS,
        })
        for (const uid of ctx.store.preemptScratch) {
          const v = ctx.s.pods.get(uid)
          if (!v) continue
          CYCLE.preempting.push(v.name)
          emit(
            ctx,
            'Normal',
            'Preempted',
            `pod/${v.name}`,
            `Preempted by ${pod.namespace}/${pod.name} on node ${ctx.s.nodes[victimNode].name}`,
          )
          submit(ctx, {
            verb: 'delete',
            kind: 'Pod',
            namespace: v.namespace,
            name: v.name,
            subject: SUBJECTS.scheduler,
            commit: (c) => deletePod(c, uid, 'Preempted'),
          })
        }
        sched.failed += 1
        backoffPod(ctx, pod.uid)
        endCycle(ctx)
        return
      }
      const reason = aggregateReason(ctx)
      CYCLE.unschedulableReason = reason
      sched.failed += 1
      emit(ctx, 'Warning', 'FailedScheduling', `pod/${pod.name}`, reason)
      if (!sched.unschedulableQueue.includes(pod.uid)) sched.unschedulableQueue.push(pod.uid)
      endCycle(ctx)
      return
    }

    case 'score': {
      let bestIndex = -1
      let bestScore = -1
      for (let n = 0; n < N_NODES; n++) {
        const v = ctx.store.verdictScratch[n]
        if (!v.passed) continue
        scoreNode(ctx, n, pod, v)
        if ((v.score ?? 0) > bestScore) {
          bestScore = v.score ?? 0
          bestIndex = n
        }
      }
      if (bestIndex < 0) {
        endCycle(ctx)
        return
      }
      CYCLE.chosen = ctx.s.nodes[bestIndex].name
      CYCLE.phase = 'reserve'
      return
    }

    case 'reserve':
      CYCLE.phase = 'bind'
      CYCLE.progress = 0
      {
        const idx = CYCLE.chosen ? nodeByName(ctx, CYCLE.chosen) : -1
        if (idx < 0) {
          endCycle(ctx)
          return
        }
        /* Re-check the fit: the world moved while we were scoring. */
        if (filterNode(ctx, idx, pod) !== undefined) {
          sched.failed += 1
          backoffPod(ctx, pod.uid)
          endCycle(ctx)
          return
        }
        bind(ctx, pod, idx)
      }
      return

    default:
      endCycle(ctx)
  }
}

/** Watch handler: new unbound pods enter the queue; node changes unpark pods. */
export function schedulerWatch(ctx: SimCtx, kind: string): void {
  if (kind === 'Node' || kind === 'PersistentVolumeClaim' || kind === 'PersistentVolume') {
    flushUnschedulable(ctx)
  }
}

/** Called every tick so a pod created by any controller is queued exactly once. */
export function syncSchedulerQueue(ctx: SimCtx): void {
  const sched = ctx.s.scheduler
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (p.nodeName || podIsTerminating(p)) continue
    if (sched.cycle && sched.cycle.podUid === p.uid) continue
    if (sched.activeQueue.includes(p.uid)) continue
    if (sched.backoffQueue.includes(p.uid)) continue
    if (sched.unschedulableQueue.includes(p.uid)) continue
    sched.activeQueue.push(p.uid)
  }
  /* Drop queue entries for pods that no longer exist. */
  pruneQueue(ctx, sched.activeQueue)
  pruneQueue(ctx, sched.backoffQueue)
  pruneQueue(ctx, sched.unschedulableQueue)
}

function pruneQueue(ctx: SimCtx, q: string[]): void {
  for (let i = q.length - 1; i >= 0; i--) {
    const p = ctx.s.pods.get(q[i])
    if (!p || p.nodeName || podIsTerminating(p)) q.splice(i, 1)
  }
}
