/* ============================================================================
 * sim/scenarios.ts — the curriculum.
 *
 * Nobody needs a visualization of a healthy cluster. Each scenario here is a
 * failure a real operator has been paged for, arranged so it propagates
 * through the city in the correct order and with the correct delay. None of
 * them cheat: a scenario only ever turns a knob or writes an object, and the
 * cluster's own loops do the rest.
 * ==========================================================================*/

import type { DeploymentState, ScenarioDef as ScenarioMeta } from '../core/types'
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

export interface ScenarioDef extends ScenarioMeta {
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
    category: 'workload',
    symptom: 'kubectl rollout status deployment/web',
    watchFor: [
      'New-revision pods appear before old ones leave; that is maxSurge',
      'An old pod leaves only once a new one reports Ready',
      'The ReplicaSet counts change, never the Deployment',
    ],
    teaches:
      'A Deployment never touches a Pod. It scales one ReplicaSet up and another down, and maxSurge with maxUnavailable is the budget governing how fast.',
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
    category: 'workload',
    symptom: 'ProgressDeadlineExceeded',
    watchFor: [
      'The rollout reaches maxSurge and stops there',
      'New pods run but never turn Ready, so they never take traffic',
      'Ingress starts serving 5xx once the old capacity is gone',
    ],
    teaches:
      'A readiness probe that never passes does not fail loudly, it wedges. The old ReplicaSet is still there at zero replicas, which is why a rollback is instant.',
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
    category: 'node',
    symptom: 'NodeNotReady, then Evicted',
    watchFor: [
      'The Lease stops renewing first and nothing else changes for 40 seconds',
      'Ready flips to Unknown after nodeMonitorGracePeriod',
      'Pods are evicted 300 seconds later, not immediately',
    ],
    teaches:
      'Kubernetes is deliberately slow to declare a node dead. The 40 second grace and the 300 second toleration exist so a network blip does not reschedule the cluster.',
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
    category: 'workload',
    symptom: 'CrashLoopBackOff',
    watchFor: [
      'restartCount climbing on the container, not the pod',
      'The backoff doubling: 10s, 20s, 40s, 80s',
      'Capped at 300s, and reset only after 10 minutes of running',
    ],
    teaches:
      'The backoff is exponential and per container. A pod in CrashLoopBackOff is not being throttled by the scheduler; kubelet is simply waiting before trying again.',
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
    category: 'workload',
    symptom: 'OOMKilled',
    watchFor: [
      'Memory climbing toward the limit, not the request',
      'A hard kill the moment the limit is crossed, with no warning',
      'The pod restarts in place; it is not rescheduled anywhere',
    ],
    teaches:
      'The memory limit is enforced by the kernel, not by Kubernetes. Crossing it kills the process instantly: no grace period, no eviction notice, no chance to shut down cleanly.',
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
    category: 'workload',
    symptom: 'ErrImagePull, then ImagePullBackOff',
    watchFor: [
      'The sandbox exists before the image ever arrives',
      'Backoff growing between pull attempts',
      'A node that already has the layers is untouched',
    ],
    teaches:
      'Image pulls happen per node. A bad tag fails everywhere at once; a registry outage only affects nodes that do not already have the layers cached.',
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
    category: 'control-plane',
    symptom: 'etcdserver: request timed out',
    watchFor: [
      'The raft log stops committing and entries pile up uncommitted',
      'The API server refuses writes but still serves cached reads',
      'Controllers keep looping over a world they can no longer change',
    ],
    teaches:
      'Quorum is floor(n/2)+1. With three members you may lose one. Losing two stops every write in the cluster while reads quietly keep working, which is why the failure looks confusing.',
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
    category: 'control-plane',
    symptom: 'failed calling webhook: context deadline exceeded',
    watchFor: [
      'Writes stall in the mutating admission stage, not at authn',
      'failurePolicy Fail turns a broken webhook into a broken cluster',
      'Reads are entirely unaffected',
    ],
    teaches:
      'An admission webhook sits in the write path of every object it matches. With failurePolicy Fail and no ready endpoints behind its Service, you cannot even deploy the fix.',
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
    category: 'workload',
    symptom: 'kubectl get hpa',
    watchFor: [
      'Utilisation is measured against requests, never against limits',
      'Scale-up is prompt; scale-down waits out 300 seconds',
      'The HPA writes .spec.replicas, the same field you would edit',
    ],
    teaches:
      'The HPA is just another controller writing a replica count. The stabilization window exists so a brief dip does not tear down capacity you are about to need again.',
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
    category: 'scheduling',
    symptom: 'FailedScheduling: 0/4 nodes are available',
    watchFor: [
      'Every node reports its own distinct rejection reason',
      'The pod has no nodeName and will not get one until something changes',
      'Cluster-wide free capacity can still look plentiful',
    ],
    teaches:
      'Pending is a verdict, not a place in a queue. The scheduler fits requests against allocatable minus already-requested, never against what the containers actually use.',
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
    category: 'scheduling',
    symptom: 'Preempted in order to admit a higher priority pod',
    watchFor: [
      'A higher-priority pod arrives and no node passes the filters',
      'Victims are chosen by priority and then gracefully terminated',
      'The freed room is not reserved for the pod that caused the eviction',
    ],
    teaches:
      'Preemption evicts lower-priority pods to make room. It is a last resort, and the preemptor still has to win the next scheduling cycle like everyone else.',
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
    category: 'node',
    symptom: 'Cannot evict pod as it would violate the disruption budget',
    watchFor: [
      'The drain begins and then stops partway',
      'disruptionsAllowed sits at zero and nothing moves',
      'A node that simply dies ignores the budget completely',
    ],
    teaches:
      'A PodDisruptionBudget constrains voluntary disruption only. It protects a workload from your own drain, not from hardware failure.',
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
