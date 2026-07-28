/* ============================================================================
 * sim/scenarios.ts — the curriculum.
 *
 * Nobody needs a visualization of a healthy cluster. Each scenario here is a
 * failure a real operator has been paged for, arranged so it propagates
 * through the city in the correct order and with the correct delay. None of
 * them cheat: a scenario only ever turns a knob or writes an object, and the
 * cluster's own loops do the rest.
 * ==========================================================================*/

import type { DeploymentState } from '../core/types'
import { SUBJECTS, submit } from './controlplane'
import {
  drainNode,
  enqueueKey,
  nextRevision,
  rollbackDeployment,
  setDeploymentImage,
  uncordonNode,
} from './controllers'
import { emit, key, type ContainerSpec, type DeploySpec, type SimCtx } from './ctx'
import { IMAGES } from './images'

export interface ScenarioDef {
  id: string
  title: string
  blurb: string
  start(ctx: SimCtx): void
  stop(ctx: SimCtx): void
  /** Optional driver for scenarios that unfold in stages. */
  step?(ctx: SimCtx, dt: number): void
}

function webDeployment(ctx: SimCtx): DeploymentState | undefined {
  return ctx.s.deployments.find((d) => d.namespace === 'shop' && d.name === 'web')
}

/* ---------------------------------------------------------------------------
 * Creating and removing whole workloads, the way a user would: by writing to
 * the API and letting the controllers notice.
 * -------------------------------------------------------------------------*/

function batchContainer(
  name: string,
  image: string,
  cpu: number,
  mem: number,
  extra: Partial<ContainerSpec> = {},
): ContainerSpec {
  return {
    name,
    image,
    role: 'app',
    requestCpuMilli: cpu,
    limitCpuMilli: cpu,
    requestMemMib: mem,
    limitMemMib: mem,
    idleCpuMilli: Math.max(8, cpu * 0.12),
    idleMemMib: Math.max(24, mem * 0.4),
    startupSeconds: 2,
    hasReadinessProbe: true,
    hasLivenessProbe: false,
    ...extra,
  }
}

function applyDeployment(
  ctx: SimCtx,
  namespace: string,
  name: string,
  replicas: number,
  spec: DeploySpec,
): void {
  if (ctx.s.deployments.some((d) => d.namespace === namespace && d.name === name)) return
  ctx.store.deploySpecs.set(key(namespace, name), spec)
  submit(ctx, {
    verb: 'create',
    kind: 'Deployment',
    namespace,
    name,
    subject: SUBJECTS.admin,
    commit: (c) => {
      c.s.deployments.push({
        name,
        namespace,
        replicas,
        maxSurge: 1,
        maxUnavailable: 0,
        revision: 0,
        replicaSets: [],
        statusReplicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        updatedReplicas: 0,
        rollingOut: false,
        progressDeadlineExceeded: false,
        paused: false,
        selector: { app: spec.labels['app'] },
      })
      enqueueKey(c, 'deployment', key(namespace, name))
    },
  })
}

/** Delete the Deployment; the garbage collector unwinds the rest by ownerRef. */
function deleteDeployment(ctx: SimCtx, namespace: string, name: string): void {
  const at = ctx.s.deployments.findIndex((d) => d.namespace === namespace && d.name === name)
  if (at < 0) return
  submit(ctx, {
    verb: 'delete',
    kind: 'Deployment',
    namespace,
    name,
    subject: SUBJECTS.admin,
    commit: (c) => {
      const i = c.s.deployments.findIndex((d) => d.namespace === namespace && d.name === name)
      if (i >= 0) c.s.deployments.splice(i, 1)
      c.store.deploySpecs.delete(key(namespace, name))
      enqueueKey(c, 'garbage-collector', 'cluster')
    },
  })
}

/* ---------------------------------------------------------------------------
 * The scenarios.
 * -------------------------------------------------------------------------*/

export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'rolling-update',
    title: 'Rolling update',
    blurb:
      'Change the image. A second ReplicaSet appears at zero replicas and the two counts trade places within the maxSurge / maxUnavailable budget.',
    start(ctx) {
      setDeploymentImage(ctx, 'shop', 'web', IMAGES.webV2)
    },
    stop() {
      /* A finished rollout is the new normal; there is nothing to undo. */
    },
  },

  {
    id: 'bad-rollout',
    title: 'Wedged rollout',
    blurb:
      'The new revision never passes its readiness probe. With maxUnavailable: 0 the rollout stalls forever rather than taking the service down, and eventually reports progressDeadlineExceeded.',
    start(ctx) {
      /* Rig the revision the next template change will produce. */
      ctx.store.wedgedRevisions.add(nextRevision(ctx, 'shop', 'web'))
      setDeploymentImage(ctx, 'shop', 'web', IMAGES.webBroken)
    },
    stop(ctx) {
      /* `kubectl rollout undo`: the old ReplicaSet still exists at zero, so
       * recovery is a counter moving, not a build. */
      rollbackDeployment(ctx, 'shop', 'web')
      ctx.store.wedgedRevisions.clear()
    },
  },

  {
    id: 'node-failure',
    title: 'Node failure',
    blurb:
      'A node stops renewing its Lease. Nothing happens for 40 seconds, then it is NotReady and its pods leave every Service. The pods themselves are not deleted for another five minutes.',
    start(ctx) {
      ctx.s.knobs.nodeDown = 1
    },
    stop(ctx) {
      ctx.s.knobs.nodeDown = 0
    },
  },

  {
    id: 'crashloop',
    title: 'CrashLoopBackOff',
    blurb:
      'The container exits non-zero a few seconds after starting. kubelet restarts it after 10s, then 20, 40, 80, 160, 300 — and 300 forever after.',
    start(ctx) {
      ctx.s.knobs.crashLoop = true
    },
    stop(ctx) {
      ctx.s.knobs.crashLoop = false
    },
  },

  {
    id: 'oom-kill',
    title: 'OOMKilled',
    blurb:
      'A leaking container walks up to its memory limit. There is no throttling for memory: the kernel kills it the moment it crosses, and the restart clears the leak.',
    start(ctx) {
      ctx.s.knobs.memoryLeak = true
    },
    stop(ctx) {
      ctx.s.knobs.memoryLeak = false
    },
  },

  {
    id: 'image-pull-failure',
    title: 'ImagePullBackOff',
    blurb:
      'Roll out a tag that does not exist. Pods are scheduled and get IPs, then sit in ErrImagePull and back off — the scheduler did its job perfectly.',
    start(ctx) {
      ctx.s.knobs.imagePullFailure = true
      setDeploymentImage(ctx, 'shop', 'web', IMAGES.webMissing)
    },
    stop(ctx) {
      ctx.s.knobs.imagePullFailure = false
      rollbackDeployment(ctx, 'shop', 'web')
    },
  },

  {
    id: 'etcd-quorum-loss',
    title: 'etcd quorum loss',
    blurb:
      'Two of three members go down. No proposal can commit, so every write times out and the API server goes read-only — while cached reads keep answering, which is why the cluster looks alive.',
    start(ctx) {
      ctx.s.knobs.etcdMembersDown = 2
    },
    stop(ctx) {
      ctx.s.knobs.etcdMembersDown = 0
    },
  },

  {
    id: 'webhook-outage',
    title: 'Admission webhook outage',
    blurb:
      'A validating webhook with failurePolicy: Fail loses its backing service. Every write in the cluster is now rejected at the validating stage — including the writes that would fix it.',
    start(ctx) {
      ctx.s.knobs.webhookReachable = false
    },
    stop(ctx) {
      ctx.s.knobs.webhookReachable = true
    },
  },

  {
    id: 'hpa-traffic-spike',
    title: 'HPA traffic spike',
    blurb:
      'Traffic jumps. The HPA compares CPU usage against the sum of the pods’ requests, scales up at once, and then refuses to scale back down for five minutes.',
    start(ctx) {
      ctx.s.knobs.hpaEnabled = true
      ctx.s.knobs.trafficRps = 900
      enqueueKey(ctx, 'hpa', 'shop/web')
    },
    stop(ctx) {
      ctx.s.knobs.hpaEnabled = false
    },
  },

  {
    id: 'pending-unschedulable',
    title: 'Pending: unschedulable',
    blurb:
      'Raise the CPU request past what any node has free. Every node fails a filter and the pods stay Pending with the aggregated reason — the cluster has plenty of idle CPU, and it does not matter.',
    start(ctx) {
      ctx.s.knobs.requestCpuMilli = 3400
      ctx.s.knobs.limitCpuMilli = 3400
      enqueueKey(ctx, 'deployment', 'shop/web')
    },
    stop(ctx) {
      enqueueKey(ctx, 'deployment', 'shop/web')
    },
  },

  {
    id: 'preemption',
    title: 'Preemption',
    blurb:
      'Fill the cluster with low-priority work, then submit something with a higher PriorityClass. The scheduler finds no node, picks the cheapest set of victims, and evicts them to make room.',
    start(ctx) {
      /* Fill whatever is free so the high-priority pods genuinely cannot fit. */
      let free = 0
      for (const n of ctx.s.nodes) {
        if (n.unschedulable || n.taints.some((t) => t.effect === 'NoSchedule')) continue
        free += n.allocatableCpuMilli - n.requestedCpuMilli
      }
      const fillerReplicas = Math.max(1, Math.floor(free / 600))
      applyDeployment(ctx, 'shop', 'filler', fillerReplicas, {
        image: IMAGES.report,
        labels: { app: 'filler' },
        containers: [batchContainer('filler', IMAGES.report, 600, 384)],
        tolerations: [],
        volumeClaims: [],
        priority: -10,
        priorityClassName: 'low-priority',
        knobDriven: false,
        history: new Map(),
      })
      ctx.store.scenarioStep = 0
    },
    step(ctx, dt) {
      /* The high-priority workload arrives only once the filler has landed.
       * Submitting it early would let it win on priority order alone and there
       * would be nothing to preempt. */
      if (ctx.store.scenarioStep > 0) return
      ctx.store.scenarioClock += dt
      if (ctx.store.scenarioClock < 60) return
      ctx.store.scenarioStep = 1
      applyDeployment(ctx, 'shop', 'checkout', 2, {
        image: IMAGES.checkout,
        labels: { app: 'checkout' },
        containers: [batchContainer('checkout', IMAGES.checkout, 800, 512)],
        tolerations: [],
        volumeClaims: [],
        priority: 1000,
        priorityClassName: 'high-priority',
        knobDriven: false,
        history: new Map(),
      })
      emit(
        ctx,
        'Normal',
        'ScenarioStage',
        'scenario/preemption',
        'high-priority checkout Deployment submitted',
      )
    },
    stop(ctx) {
      deleteDeployment(ctx, 'shop', 'checkout')
      deleteDeployment(ctx, 'shop', 'filler')
    },
  },

  {
    id: 'pdb-blocks-drain',
    title: 'PodDisruptionBudget blocks a drain',
    blurb:
      'minAvailable equals the replica count, so the budget allows zero disruptions. The node is cordoned but the drain can never evict its first pod — the classic self-inflicted maintenance deadlock.',
    start(ctx) {
      const d = webDeployment(ctx)
      const pdb = ctx.s.pdbs.find((p) => p.name === 'web-pdb')
      if (pdb && d) pdb.minAvailable = d.replicas
      drainNode(ctx, 0)
    },
    stop(ctx) {
      const pdb = ctx.s.pdbs.find((p) => p.name === 'web-pdb')
      if (pdb) pdb.minAvailable = 3
      uncordonNode(ctx, 0)
    },
  },
] as const
