/* ============================================================================
 * sim/ctx.ts — the simulation's private plumbing.
 *
 * `SimState` is the contract the city draws. Everything in this file is
 * bookkeeping the city has no business seeing: rate-limited workqueues,
 * per-container probe clocks, the callback an in-flight API write runs when
 * etcd finally commits it.
 *
 * Nothing here imports three.js, and nothing here is exported past src/sim.
 * ==========================================================================*/

import {
  N_NODES,
  POD_SLOTS_PER_NODE,
  TIMING,
  type ClusterEvent,
  type ContainerState,
  type ControllerId,
  type Kind,
  type Knobs,
  type NodeVerdict,
  type OwnerRef,
  type PodState,
  type QosClass,
  type SimState,
  type Taint,
  type Verb,
} from '../core/types'
import { bus } from '../core/bus'
import { Rng, clamp, nextUid, randomSuffix } from '../core/util'

/* ---------------------------------------------------------------------------
 * Model constants. Every one of these is a *scaled* number; the real
 * Kubernetes default is named in the comment so the lie is on the record.
 * Anything that is already real lives in TIMING in core/types.ts.
 * -------------------------------------------------------------------------*/

export const MODEL = {
  /**
   * One honest millisecond inside the API server is stretched to this many
   * model milliseconds so a request is watchable as it sinks through the
   * tower. A real admitted write completes in ~20-60 ms end to end.
   */
  apiDilation: 26,

  /** Concurrency seats across all APF priority levels. Real clusters: 600. */
  apfSeats: 24,

  /** Deployment .spec.progressDeadlineSeconds. Real default is 600. */
  progressDeadlineSeconds: 120,

  /** Lease duration for kube-controller-manager / kube-scheduler. Real: 15 s. */
  leaderLeaseSeconds: 15,

  /**
   * MiB the etcd backing store grows per applied revision. A real revision is
   * a few KiB; scaled up so the 2 GiB quota is reachable inside a session.
   */
  etcdWriteMib: 0.3,
  /**
   * Revisions of history kept after a compaction. Real etcd keeps five
   * minutes of history, which at a real cluster's write rate is thousands of
   * revisions; at this model's rate five minutes is roughly this many.
   */
  etcdKeepRevisions: 200,
  /** etcd's client request timeout. This one is real. */
  etcdRequestTimeoutSeconds: 7,

  /** Workqueue rate limiter: base delay and cap. Real: 5 ms -> 1000 s. */
  workqueueBaseSeconds: 1,
  workqueueMaxSeconds: 32,

  /** Model seconds each reconcile phase occupies, so the machine is readable. */
  reconcilePhaseSeconds: 0.22,
  /** Model seconds each scheduler phase occupies. Real cycles are ~1 ms. */
  schedulerPhaseSeconds: 0.18,

  /** Milli-cores a single request-per-second costs the demo web container. */
  cpuPerRps: 1.8,
  /** MiB per second a leaking container adds. */
  memLeakMibPerSecond: 14,
  /** Requests per second one ready web endpoint can serve at its CPU limit. */
  rpsPerReadyEndpoint: 90,

  /** Model seconds a CSI attach / mount / detach step takes. Real: seconds. */
  csiStepSeconds: 2.5,
  /** Model seconds a dynamic provision takes. */
  csiProvisionSeconds: 4,

  /** Cap on ClusterEvent history kept in SimState. */
  eventCap: 240,
  /** Two identical events inside this window aggregate instead of repeating. */
  /* Kubernetes aggregates an identical (object, reason) for ten minutes and
   * climbs `count` rather than repeating the row. Six seconds was shorter than
   * the very intervals the model produces — a CrashLoopBackOff backs off for
   * 10s, then 20s, then 40s — so the canonical high-count event never once
   * aggregated and the count column always read 1. */
  eventAggregateSeconds: 600,
} as const

/* ---------------------------------------------------------------------------
 * Pod templates. A controller instantiates one of these; only a Pod ever
 * becomes a building.
 * -------------------------------------------------------------------------*/

export interface ContainerSpec {
  name: string
  image: string
  role: 'init' | 'app' | 'sidecar'
  requestCpuMilli: number
  limitCpuMilli: number
  requestMemMib: number
  limitMemMib: number
  /** Init containers only: model seconds of work before they exit 0. */
  runSeconds?: number
  /** Model seconds before the startup probe first succeeds. */
  startupSeconds?: number
  /** Steady-state consumption with no traffic. */
  idleCpuMilli: number
  idleMemMib: number
  hasReadinessProbe: boolean
  hasLivenessProbe: boolean
  /** Fraction of this pod's traffic-derived CPU this container absorbs. */
  trafficShare?: number
}

export interface PodTemplate {
  namespace: string
  /** Name prefix; a 5-character suffix is appended, as a ReplicaSet does. */
  basename: string
  labels: Record<string, string>
  containers: ContainerSpec[]
  tolerations: Taint[]
  nodeSelector?: Record<string, string>
  volumeClaims: string[]
  priority: number
  priorityClassName?: string
  revision?: number
  owner?: OwnerRef
  /**
   * requiredDuringScheduling pod anti-affinity on this label key, when the
   * anti-affinity knob is on. The value is read from the pod's own labels.
   */
  antiAffinityKey?: string
}

/* ---------------------------------------------------------------------------
 * Per-container and per-pod runtime the kubelet owns. None of it is in
 * SimState because none of it is drawable; what the city sees is the
 * ContainerState it produces.
 * -------------------------------------------------------------------------*/

export interface ContainerRuntime {
  /** Seconds this container process has been up without exiting. */
  runningSeconds: number
  /** Model seconds of work an init container still owes. */
  workRemaining: number
  startupClock: number
  readinessClock: number
  livenessClock: number
  /** Image pull backoff step and remaining time, doubling like crash backoff. */
  pullBackoff: number
  pullBackoffRemaining: number
  /** True once the image is resident on the node for this container. */
  imageReady: boolean
  /** MiB this process has leaked since it last started. A restart zeroes it. */
  leakedMib: number
  /** Seconds the cgroup CPU quota has been capping this container without let-up. */
  throttledSeconds: number
  /** Seconds the last exit reason stays on the status before the backoff shows. */
  exitDisplay: number
  /* Immutable copies of the pod spec the kubelet needs every frame. */
  idleCpuMilli: number
  idleMemMib: number
  trafficShare: number
  startupSeconds: number
  runSeconds: number
  hasReadinessProbe: boolean
  hasLivenessProbe: boolean
}

export type PodStage =
  | 'unscheduled'
  | 'pulling'
  | 'sandbox'
  | 'cni'
  | 'csi'
  | 'init'
  | 'app'
  | 'running'
  | 'terminating'

export interface PodRuntime {
  stage: PodStage
  stageProgress: number
  /** Which init container is running; -1 once they have all completed. */
  initIndex: number
  containers: ContainerRuntime[]
  /** Readiness is wired never to succeed — the wedged-rollout lesson. */
  neverReady: boolean
  /** Model second the scheduler bound this pod, for scheduling latency. */
  boundAt: number
  /** Node index the sandbox was created on; -1 before CNI ADD. */
  hostIndex: number
  /** Host part of the pod IP inside the node's /24. */
  ipHost: number
  /** Set when the pod is being deleted so the kubelet stops reconciling it. */
  doomed: boolean
  /** Why the pod is going away, for the Killing event. */
  killReason: string
  /** Index of the volumeClaim the volume manager is currently attaching. */
  mountIndex: number
  /** CSI operation this pod's volume manager is waiting on, '' when none. */
  csiOpId: string
  /** Set once the volumes have been released on termination. */
  unmounted: boolean
  /** Model second this pod reached a terminal phase; -1 while it is alive. */
  terminalAt: number
}

/* ---------------------------------------------------------------------------
 * The API pipeline's private half.
 * -------------------------------------------------------------------------*/

export interface RequestSpec {
  verb: Verb
  kind: Kind
  namespace: string
  name: string
  subject: string
  /**
   * Applied the instant etcd commits and applies the write. A request that
   * never reaches storage never runs this — which is exactly why a broken
   * webhook stops the cluster dead.
   */
  commit?: (ctx: SimCtx) => void
  /** Always called once, with the request's final outcome. */
  done?: (ctx: SimCtx, outcome: ApiOutcome, reason: string) => void
}

export type ApiOutcome =
  | 'inflight'
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rejected'
  | 'conflict'
  | 'timeout'

export interface InflightRecord {
  spec: RequestSpec
  stageIndex: number
  /** Honest milliseconds this stage costs; progress is the dilated version. */
  stageCostMs: number
  /** False until the current stage's gate has run. */
  gated: boolean
  /** Raft log index this write is waiting on, or -1. */
  raftIndex: number
  raftWaitSeconds: number
  /** etcd revision at submission, for optimistic concurrency. */
  startRevision: number
  /** True once the APF filter has taken a seat that must be given back. */
  holdsSeat: boolean
}

export type WatchHandler = (ctx: SimCtx, kind: Kind, namespace: string, name: string) => void

/* ---------------------------------------------------------------------------
 * The rate-limited workqueue every controller shares. Real client-go
 * semantics: a key present in the queue is never enqueued twice, and a failed
 * key comes back only after its exponential delay has expired.
 * -------------------------------------------------------------------------*/

export interface Workqueue {
  keys: string[]
  inQueue: Set<string>
  /** key -> model second before which it must not be dequeued. */
  readyAt: Map<string, number>
  /** key -> current backoff step in seconds. */
  rate: Map<string, number>
}

export function newWorkqueue(): Workqueue {
  return { keys: [], inQueue: new Set(), readyAt: new Map(), rate: new Map() }
}

export function enqueue(q: Workqueue, key: string): void {
  if (q.inQueue.has(key)) return
  q.inQueue.add(key)
  q.keys.push(key)
}

/** First key past its rate-limit delay, or undefined. Allocates nothing. */
export function dequeue(q: Workqueue, now: number): string | undefined {
  for (let i = 0; i < q.keys.length; i++) {
    const k = q.keys[i]
    const at = q.readyAt.get(k)
    if (at !== undefined && at > now) continue
    q.keys.splice(i, 1)
    q.inQueue.delete(k)
    q.readyAt.delete(k)
    return k
  }
  return undefined
}

/** Re-enqueue after an exponential delay. This is what `requeue` really is. */
export function requeueWithBackoff(q: Workqueue, key: string, now: number): number {
  const prev = q.rate.get(key) ?? 0
  const next = clamp(prev === 0 ? MODEL.workqueueBaseSeconds : prev * 2, MODEL.workqueueBaseSeconds, MODEL.workqueueMaxSeconds)
  q.rate.set(key, next)
  q.readyAt.set(key, now + next)
  enqueue(q, key)
  return next
}

export function forgetKey(q: Workqueue, key: string): void {
  q.rate.delete(key)
  q.readyAt.delete(key)
}

/* ---------------------------------------------------------------------------
 * Everything the simulation keeps that SimState does not carry.
 * -------------------------------------------------------------------------*/

export interface DeploySpec {
  image: string
  labels: Record<string, string>
  containers: ContainerSpec[]
  tolerations: Taint[]
  volumeClaims: string[]
  priority: number
  priorityClassName?: string
  antiAffinityKey?: string
  nodeSelector?: Record<string, string>
  /**
   * The demo Deployment's resource requests and limits come from the knobs, so
   * turning a knob edits the pod template and legitimately starts a rollout.
   */
  knobDriven: boolean
  /** Revision -> image, so a rollback knows what it is going back to. */
  history: Map<number, string>
}

export interface Store {
  /**
   * Insertion-ordered mirror of state.pods. The tick loop runs every frame and
   * `for (const p of map.values())` allocates an iterator; an array does not.
   */
  podList: PodState[]
  runtime: Map<string, PodRuntime>

  controllerOrder: ControllerId[]
  queues: Map<ControllerId, Workqueue>
  /** Model seconds the current reconcile phase has consumed, per controller. */
  phaseClock: Map<ControllerId, number>

  requests: Map<string, InflightRecord>
  requestPool: InflightRecord[]
  reqSeq: number
  watchers: WatchHandler[]
  /** Object key -> etcd revision of its last write, for 409 detection. */
  lastWriteRev: Map<string, number>

  eventSeq: number
  namespaces: string[]
  serviceAccounts: Set<string>

  deploySpecs: Map<string, DeploySpec>
  /** ReplicaSet "ns/name" -> hash of the pod template it materialises. */
  rsTemplate: Map<string, string>
  /** ns/name -> model second of the last rollout progress. */
  rolloutProgressAt: Map<string, number>
  /** ns/name -> the readyReplicas last seen, for progress detection. */
  rolloutMark: Map<string, number>
  /** Node index -> model seconds it has been missing its Lease. */
  nodeUnreadyFor: number[]
  /**
   * The `nodeCount` this store has already acted on.
   *
   * Membership is state, not a projection of the knob. It used to be derived
   * every tick as `index < nodeCount`, which can only ever express "the last n
   * machines" — so deleting a Node by name was impossible, and the next tick
   * would have put it straight back. The knob is an intent, applied when it
   * changes; between changes the `present` flags stand on their own.
   */
  nodeCountApplied: number
  cmLeaseInflight: boolean
  schedLeaseInflight: boolean
  /** Deployment revisions whose pods can never pass readiness. */
  wedgedRevisions: Set<number>

  /** Node index -> model seconds until the next drain eviction attempt. */
  draining: Map<number, number>

  /** uid -> label key this pod declares required anti-affinity on. */
  antiAffinity: Map<string, string>
  /**
   * PV name -> node its topology pins it to. A WaitForFirstConsumer volume is
   * provisioned in the consumer's topology, and the scheduler must honour that
   * for every later scheduling of a pod that mounts it.
   */
  pvNodeAffinity: Map<string, string>

  csiSeq: number
  jobSeq: number
  /**
   * Job "ns/name" -> pod uids already counted into its status. Job status is a
   * persisted counter, not a headcount: garbage-collecting a finished pod must
   * never make a Job look less complete than it is.
   */
  jobCounted: Map<string, Set<string>>
  /** CSI operation id -> model seconds since it completed, for retiring it. */
  csiAge: Map<string, number>

  /** Leader-election lease age for the two elected components. */
  cmLeaseAge: number
  schedLeaseAge: number

  /* Per-node kubelet bookkeeping, indexed by node. */
  ipNext: number[]
  leaseInflight: boolean[]
  /** Model second each kubelet may next attempt a Lease renewal. */
  leaseAttemptAt: number[]
  cmAttemptAt: number
  schedAttemptAt: number
  evictClock: number[]
  /**
   * Node index -> model seconds the machine has been out of the cluster. This
   * is PodGC's quarantine, not an eviction timer: it only decides when PodGC
   * stops suspecting a stale cache and accepts that the Node is really gone.
   */
  nodeAbsentFor: number[]
  proxySync: number[]
  /** uid -> the readiness the kubelet last reported through the API. */
  reportedReady: Map<string, boolean>
  /** Requests per second each ready replica of a workload is absorbing. */
  rpsPerPod: Record<string, number>

  writesWindow: number
  requestsWindow: number
  windowClock: number
  compactionClock: number
  cronClock: number
  resyncClock: number
  /** Model seconds since the periodic RBAC-denied probe last ran. */
  rbacProbeClock: number
  anonProbeClock: number

  /** Scheduler scratch, reused every cycle so a cycle allocates nothing. */
  verdictScratch: NodeVerdict[]
  /** Reason tally per filter, indexed the same way as FILTER_REASONS. */
  reasonTally: number[]
  preemptScratch: string[]
  preemptTrial: string[]
  /** Scheduler backoff and unschedulable-queue bookkeeping, keyed by pod uid. */
  schedReadyAt: Map<string, number>
  schedRate: Map<string, number>
  /**
   * status.nominatedNodeName: a pod that has already preempted is parked
   * against the node it cleared, until the victims finish terminating. Without
   * it the preemptor would re-preempt every retry and evict the whole cluster.
   */
  nominated: Map<string, { node: string; until: number }>
  unschedFlushClock: number
  cycleStartedAt: number
  /** The scheduler's in-flight Binding: it is an ordinary API write. */
  bindPending: boolean
  bindDone: boolean
  bindOk: boolean

  scenarioSaved: Partial<Knobs> | null
  scenarioClock: number
  /** Scenario-owned counters, e.g. how far a staged scenario has advanced. */
  scenarioStep: number
}

export interface SimCtx {
  s: SimState
  rng: Rng
  store: Store
}

export function createStore(controllerOrder: ControllerId[]): Store {
  const queues = new Map<ControllerId, Workqueue>()
  const phaseClock = new Map<ControllerId, number>()
  for (const id of controllerOrder) {
    queues.set(id, newWorkqueue())
    phaseClock.set(id, 0)
  }
  const verdictScratch: NodeVerdict[] = []
  for (let i = 0; i < N_NODES; i++) {
    verdictScratch.push({ nodeName: '', passed: false, scoreBreakdown: [] })
  }
  return {
    podList: [],
    runtime: new Map(),
    controllerOrder,
    queues,
    phaseClock,
    requests: new Map(),
    requestPool: [],
    reqSeq: 0,
    watchers: [],
    lastWriteRev: new Map(),
    eventSeq: 0,
    namespaces: ['default', 'kube-system', 'kube-public', 'shop'],
    serviceAccounts: new Set(),
    deploySpecs: new Map(),
    rsTemplate: new Map(),
    rolloutProgressAt: new Map(),
    rolloutMark: new Map(),
    nodeUnreadyFor: new Array<number>(N_NODES).fill(0),
    nodeCountApplied: -1,
    cmLeaseInflight: false,
    schedLeaseInflight: false,
    wedgedRevisions: new Set(),
    draining: new Map(),
    antiAffinity: new Map(),
    pvNodeAffinity: new Map(),
    csiSeq: 0,
    jobSeq: 0,
    jobCounted: new Map(),
    csiAge: new Map(),
    cmLeaseAge: 0,
    schedLeaseAge: 0,
    ipNext: new Array<number>(N_NODES).fill(4),
    leaseInflight: new Array<boolean>(N_NODES).fill(false),
    leaseAttemptAt: new Array<number>(N_NODES).fill(0),
    cmAttemptAt: 0,
    schedAttemptAt: 0,
    evictClock: new Array<number>(N_NODES).fill(0),
    nodeAbsentFor: new Array<number>(N_NODES).fill(0),
    proxySync: new Array<number>(N_NODES).fill(0),
    reportedReady: new Map(),
    rpsPerPod: { web: 0, api: 0, db: 0, coredns: 0, 'node-exporter': 0, migrate: 0, report: 0 },
    writesWindow: 0,
    requestsWindow: 0,
    windowClock: 0,
    compactionClock: 0,
    cronClock: 0,
    resyncClock: 0,
    rbacProbeClock: 0,
    anonProbeClock: 0,
    verdictScratch,
    reasonTally: [],
    preemptScratch: [],
    preemptTrial: [],
    schedReadyAt: new Map(),
    schedRate: new Map(),
    nominated: new Map(),
    unschedFlushClock: 0,
    cycleStartedAt: 0,
    bindPending: false,
    bindDone: false,
    bindOk: false,
    scenarioSaved: null,
    scenarioClock: 0,
    scenarioStep: 0,
  }
}

/* ---------------------------------------------------------------------------
 * Events. The cluster narrating itself, with the reason strings `kubectl
 * describe` actually prints.
 * -------------------------------------------------------------------------*/

/**
 * The namespace of the object an event names, resolved while that object still
 * exists. `involved` is always `kind/name`; cluster-scoped kinds return ''.
 */
function involvedNamespace(ctx: SimCtx, involved: string): string {
  const cut = involved.indexOf('/')
  if (cut <= 0) return ''
  const kind = involved.slice(0, cut)
  const name = involved.slice(cut + 1)
  const s = ctx.s
  switch (kind) {
    case 'pod': {
      for (const p of s.pods.values()) if (p.name === name) return p.namespace
      return ''
    }
    case 'deployment':
      return s.deployments.find((d) => d.name === name)?.namespace ?? ''
    case 'replicaset':
      return s.replicaSets.find((r) => r.name === name)?.namespace ?? ''
    case 'statefulset':
      return s.statefulSets.find((x) => x.name === name)?.namespace ?? ''
    case 'daemonset':
      return s.daemonSets.find((x) => x.name === name)?.namespace ?? ''
    case 'job':
      return s.jobs.find((j) => j.name === name)?.namespace ?? ''
    case 'service':
      return s.services.find((v) => v.name === name)?.namespace ?? ''
    case 'ingress':
      return s.ingresses.find((i) => i.name === name)?.namespace ?? ''
    case 'hpa':
      return s.hpas.find((h) => h.name === name)?.namespace ?? ''
    case 'persistentvolumeclaim':
    case 'pvc':
      return s.pvcs.find((c) => c.name === name)?.namespace ?? ''
    case 'namespace':
      return name
    case 'serviceaccount':
      return name.includes(':') ? name.slice(0, name.indexOf(':')) : ''
    /* Nodes, PersistentVolumes and StorageClasses are cluster-scoped. */
    default:
      return ''
  }
}

export function emit(
  ctx: SimCtx,
  type: 'Normal' | 'Warning',
  reason: string,
  involved: string,
  message: string,
): void {
  const events = ctx.s.events
  /* Real Events aggregate: same reason on the same object bumps `count`.
   * The whole retained window is searched, not the last handful: on a busy
   * cluster the previous occurrence is hundreds of events back, which is
   * exactly when aggregation is worth having. */
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.reason === reason && e.involved === involved && ctx.s.t - e.at < MODEL.eventAggregateSeconds) {
      e.count += 1
      e.at = ctx.s.t
      e.message = message
      return
    }
  }
  ctx.store.eventSeq += 1
  const ev: ClusterEvent = {
    id: ctx.store.eventSeq,
    type,
    reason,
    involved,
    namespace: involvedNamespace(ctx, involved),
    message,
    at: ctx.s.t,
    count: 1,
  }
  events.push(ev)
  if (events.length > MODEL.eventCap) events.shift()
  bus.emit('event', ev)
}

/* ---------------------------------------------------------------------------
 * Keys and small lookups.
 * -------------------------------------------------------------------------*/

export const key = (namespace: string, name: string): string => `${namespace}/${name}`

export function objKey(kind: Kind, namespace: string, name: string): string {
  return `${kind}:${namespace}/${name}`
}

export function nodeByName(ctx: SimCtx, name: string): number {
  const nodes = ctx.s.nodes
  for (let i = 0; i < nodes.length; i++) if (nodes[i].name === name) return i
  return -1
}

/**
 * Node labels. NodeState carries no label map, so the well-known labels are
 * derived from the node's identity — the same values kubeadm would set.
 */
export function nodeLabel(ctx: SimCtx, nodeIndex: number, k: string): string | undefined {
  const n = ctx.s.nodes[nodeIndex]
  if (!n) return undefined
  switch (k) {
    case 'kubernetes.io/hostname':
      return n.name
    case 'kubernetes.io/os':
      return 'linux'
    case 'kubernetes.io/arch':
      return 'amd64'
    case 'topology.kubernetes.io/zone':
      return nodeIndex % 2 === 0 ? 'zone-a' : 'zone-b'
    case 'topology.kubernetes.io/region':
      return 'model-1'
    case 'disktype':
      return nodeIndex < 2 ? 'ssd' : 'hdd'
    case 'node-role.kubernetes.io/worker':
      return ''
    default:
      return undefined
  }
}

/**
 * Is this machine part of the cluster at all?
 *
 * Absent is not the same as down. A down node has a Node object that stopped
 * reporting, so the control plane notices, waits out its timers and evicts. An
 * absent node was never registered: the scheduler cannot see it, it adds no
 * capacity, and nothing about it is a failure. Scaling a cluster down removes
 * machines; it does not break them.
 */
export function nodeIsAbsent(ctx: SimCtx, nodeIndex: number): boolean {
  return nodeIndex >= ctx.s.knobs.nodeCount
}

/** Is a node up? A node the operator took down stops renewing its Lease. */
export function nodeIsDown(ctx: SimCtx, nodeIndex: number): boolean {
  /* An absent machine runs nothing either, so every runtime path that already
   * handles "down" handles "not here" for free. The difference lives in the
   * capacity totals and the conditions, not in the kubelet. */
  if (nodeIsAbsent(ctx, nodeIndex)) return true
  /* Failures are injected from index 0 so the first block to die is the one
   * the demo Deployment is most likely to be running on. */
  return nodeIndex < ctx.s.knobs.nodeDown
}

export function nodeReady(node: { conditions: { type: string; status: string }[] }): boolean {
  for (const c of node.conditions) if (c.type === 'Ready') return c.status === 'True'
  return false
}

export function setCondition(
  node: { conditions: { type: string; status: string; reason: string; sinceSeconds: number }[] },
  type: string,
  status: 'True' | 'False' | 'Unknown',
  reason: string,
): void {
  for (const c of node.conditions) {
    if (c.type !== type) continue
    if (c.status !== status) {
      c.status = status
      c.reason = reason
      c.sinceSeconds = 0
    }
    return
  }
}

/* ---------------------------------------------------------------------------
 * QoS. The real rule, not an approximation:
 *   Guaranteed  every container has cpu and memory limits, and requests equal
 *               to those limits.
 *   BestEffort  no container sets any request or limit at all.
 *   Burstable   everything else.
 * -------------------------------------------------------------------------*/

export function qosOf(containers: readonly ContainerState[]): QosClass {
  if (containers.length === 0) return 'BestEffort'
  let anySet = false
  let allGuaranteed = true
  for (const c of containers) {
    const set =
      c.requestCpuMilli > 0 || c.limitCpuMilli > 0 || c.requestMemMib > 0 || c.limitMemMib > 0
    if (set) anySet = true
    const guaranteed =
      c.limitCpuMilli > 0 &&
      c.limitMemMib > 0 &&
      c.requestCpuMilli === c.limitCpuMilli &&
      c.requestMemMib === c.limitMemMib
    if (!guaranteed) allGuaranteed = false
  }
  if (!anySet) return 'BestEffort'
  return allGuaranteed ? 'Guaranteed' : 'Burstable'
}

/** Sum of container *requests* — the only number the scheduler ever adds up. */
export function podRequestCpu(pod: PodState): number {
  let appSum = 0
  let initMax = 0
  for (const c of pod.containers) {
    if (c.role === 'init') initMax = Math.max(initMax, c.requestCpuMilli)
    else appSum += c.requestCpuMilli
  }
  /* Real effective request: max(sum of app containers, largest init container). */
  return Math.max(appSum, initMax)
}

export function podRequestMem(pod: PodState): number {
  let appSum = 0
  let initMax = 0
  for (const c of pod.containers) {
    if (c.role === 'init') initMax = Math.max(initMax, c.requestMemMib)
    else appSum += c.requestMemMib
  }
  return Math.max(appSum, initMax)
}

export function podUsedCpu(pod: PodState): number {
  let sum = 0
  for (const c of pod.containers) if (c.state === 'running') sum += c.usedCpuMilli
  return sum
}

export function podUsedMem(pod: PodState): number {
  let sum = 0
  for (const c of pod.containers) if (c.state === 'running') sum += c.usedMemMib
  return sum
}

export function podIsTerminating(pod: PodState): boolean {
  return pod.deletionGraceSeconds !== undefined
}

/** A pod counts toward a Service and a Deployment only when all this holds. */
export function podIsReady(pod: PodState): boolean {
  return pod.phase === 'Running' && pod.conditions.Ready && !podIsTerminating(pod)
}

/* ---------------------------------------------------------------------------
 * Pod construction and destruction.
 * -------------------------------------------------------------------------*/

function newContainerState(spec: ContainerSpec): ContainerState {
  return {
    name: spec.name,
    image: spec.image,
    role: spec.role,
    state: 'waiting',
    reason: 'ContainerCreating',
    restartCount: 0,
    backoffRemaining: 0,
    backoffSeconds: TIMING.crashBackoffStartSeconds,
    requestCpuMilli: spec.requestCpuMilli,
    limitCpuMilli: spec.limitCpuMilli,
    requestMemMib: spec.requestMemMib,
    limitMemMib: spec.limitMemMib,
    usedCpuMilli: 0,
    usedMemMib: 0,
    throttled: false,
    ready: false,
    livenessFailures: 0,
    readinessFailures: 0,
    startupDone: false,
    pullProgress: 0,
  }
}

function newContainerRuntime(spec: ContainerSpec): ContainerRuntime {
  return {
    runningSeconds: 0,
    workRemaining: spec.runSeconds ?? 0,
    startupClock: 0,
    readinessClock: 0,
    livenessClock: 0,
    pullBackoff: TIMING.crashBackoffStartSeconds,
    pullBackoffRemaining: 0,
    imageReady: false,
    leakedMib: 0,
    throttledSeconds: 0,
    exitDisplay: 0,
    idleCpuMilli: spec.idleCpuMilli,
    idleMemMib: spec.idleMemMib,
    trafficShare: spec.trafficShare ?? 0,
    startupSeconds: spec.startupSeconds ?? 0,
    runSeconds: spec.runSeconds ?? 0,
    hasReadinessProbe: spec.hasReadinessProbe,
    hasLivenessProbe: spec.hasLivenessProbe,
  }
}

/** Build a Pod object. It is not in the cluster until `addPod` puts it there. */
export function instantiatePod(ctx: SimCtx, tpl: PodTemplate): PodState {
  const containers: ContainerState[] = []
  const runtimes: ContainerRuntime[] = []
  for (const spec of tpl.containers) {
    containers.push(newContainerState(spec))
    runtimes.push(newContainerRuntime(spec))
  }
  const labels: Record<string, string> = {}
  for (const k in tpl.labels) labels[k] = tpl.labels[k]

  const pod: PodState = {
    uid: nextUid('pod'),
    name: `${tpl.basename}-${randomSuffix(ctx.rng, 5)}`,
    namespace: tpl.namespace,
    owner: tpl.owner,
    phase: 'Pending',
    conditions: { PodScheduled: false, Initialized: false, ContainersReady: false, Ready: false },
    qos: qosOf(containers),
    priority: tpl.priority,
    priorityClassName: tpl.priorityClassName,
    containers,
    labels,
    nodeSelector: tpl.nodeSelector,
    tolerations: tpl.tolerations,
    volumeClaims: tpl.volumeClaims,
    ageSeconds: 0,
    revision: tpl.revision,
  }

  const rt: PodRuntime = {
    stage: 'unscheduled',
    stageProgress: 0,
    initIndex: 0,
    containers: runtimes,
    neverReady: tpl.revision !== undefined && ctx.store.wedgedRevisions.has(tpl.revision),
    boundAt: -1,
    hostIndex: -1,
    ipHost: 0,
    doomed: false,
    killReason: '',
    mountIndex: 0,
    csiOpId: '',
    unmounted: false,
    terminalAt: -1,
  }
  ctx.store.runtime.set(pod.uid, rt)
  if (tpl.antiAffinityKey) ctx.store.antiAffinity.set(pod.uid, tpl.antiAffinityKey)
  return pod
}

export function addPod(ctx: SimCtx, pod: PodState): void {
  ctx.s.pods.set(pod.uid, pod)
  ctx.store.podList.push(pod)
}

export function runtimeOf(ctx: SimCtx, uid: string): PodRuntime | undefined {
  return ctx.store.runtime.get(uid)
}

/** Remove a pod from the cluster. The API record is gone; so is the building. */
export function removePod(ctx: SimCtx, uid: string): void {
  const pod = ctx.s.pods.get(uid)
  if (!pod) return
  if (pod.nodeName) {
    const ni = nodeByName(ctx, pod.nodeName)
    if (ni >= 0) {
      const list = ctx.s.nodes[ni].podUids
      const at = list.indexOf(uid)
      if (at >= 0) list.splice(at, 1)
    }
  }
  ctx.s.pods.delete(uid)
  ctx.store.runtime.delete(uid)
  ctx.store.antiAffinity.delete(uid)
  ctx.store.nominated.delete(uid)
  ctx.store.reportedReady.delete(uid)
  const at = ctx.store.podList.indexOf(pod)
  if (at >= 0) ctx.store.podList.splice(at, 1)
}

/**
 * Begin a graceful delete. The pod stays in the API and keeps running for its
 * grace period, but `deletionGraceSeconds` is set *now*, and the endpoint
 * controller drops it from every EndpointSlice on the very next sync. That
 * ordering is the whole point of a graceful shutdown.
 */
export function deletePod(ctx: SimCtx, uid: string, reason: string): void {
  const pod = ctx.s.pods.get(uid)
  if (!pod || pod.deletionGraceSeconds !== undefined) return
  pod.deletionGraceSeconds = TIMING.terminationGraceSeconds
  const rt = ctx.store.runtime.get(uid)
  if (rt) {
    rt.doomed = true
    rt.killReason = reason
    if (rt.stage !== 'unscheduled') rt.stage = 'terminating'
  }
  /* A pod that never got a node has nothing to shut down; it goes at once. */
  if (!pod.nodeName) {
    removePod(ctx, uid)
    return
  }
  emit(ctx, 'Normal', 'Killing', `pod/${pod.name}`, `Stopping container ${pod.containers[pod.containers.length - 1]?.name ?? 'app'}`)
}

/** Free pod slots left on a node. kubelet's real default cap is 110. */
export function nodePodCapacityLeft(node: { podUids: string[]; capacityPods: number }): number {
  return node.capacityPods - node.podUids.length
}

export const NODE_POD_CAPACITY = POD_SLOTS_PER_NODE

/* ---------------------------------------------------------------------------
 * Tolerations. A toleration with an empty key is `operator: Exists` with no
 * key, which tolerates every taint — how DaemonSets stay on dying nodes.
 * -------------------------------------------------------------------------*/

/**
 * A toleration excuses one taint only when the key *and* the effect match.
 *
 * An empty key means "any key" — the API spells this `operator: Exists` with no
 * key — but it says nothing about the effect. That is the distinction the whole
 * mechanism rests on: a toleration written for `NoSchedule` says "you may not
 * refuse to schedule me", never "you may not evict me". This used to return
 * true on an empty key before it read the effect at all, which quietly turned
 * every blanket toleration into immunity from eviction.
 *
 * Not modelled: `operator` (an undefined `value` stands in for `Exists`), an
 * empty `effect` as a match-all, and `tolerationSeconds`. Eviction timing is
 * the node controller's single grace period here, not per-toleration.
 */
export function toleratesTaint(tolerations: readonly Taint[], taint: Taint): boolean {
  for (const t of tolerations) {
    if (t.key !== '' && t.key !== taint.key) continue
    if (t.value !== undefined && t.value !== taint.value) continue
    if (t.effect !== taint.effect) continue
    return true
  }
  return false
}

export function clampKnobs(k: Knobs): void {
  k.replicas = clamp(Math.round(k.replicas), 0, N_NODES * POD_SLOTS_PER_NODE)
  k.trafficRps = clamp(k.trafficRps, 0, 5000)
  k.maxSurge = clamp(Math.round(k.maxSurge), 0, 10)
  k.maxUnavailable = clamp(Math.round(k.maxUnavailable), 0, 10)
  /* maxSurge and maxUnavailable may not both be zero: the rollout could never
   * take a first step. The API server rejects that spec outright. */
  if (k.maxSurge === 0 && k.maxUnavailable === 0) k.maxSurge = 1
  k.timeScale = clamp(k.timeScale, 0, 20)
  k.etcdMembersDown = clamp(Math.round(k.etcdMembersDown), 0, 3)
  k.nodeDown = clamp(Math.round(k.nodeDown), 0, N_NODES)
  /* At least one machine, or there is no cluster left to look at. */
  k.nodeCount = clamp(Math.round(k.nodeCount), 1, N_NODES)
  /* You cannot take down more machines than the cluster has. */
  k.nodeDown = Math.min(k.nodeDown, k.nodeCount)
  k.hpaMinReplicas = clamp(Math.round(k.hpaMinReplicas), 1, 40)
  k.hpaMaxReplicas = clamp(Math.round(k.hpaMaxReplicas), k.hpaMinReplicas, 48)
  k.probeFailureThreshold = clamp(Math.round(k.probeFailureThreshold), 1, 20)
}
