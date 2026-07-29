/* ============================================================================
 * K8Skylines — shared contracts.
 *
 * Everything in this file is API surface consumed by more than one module.
 * The simulation (src/sim) never imports three.js; the world (src/world) never
 * mutates simulation state. They meet here.
 *
 * Kubernetes vocabulary is used exactly as the upstream API uses it. A field
 * named `phase` holds a Pod phase, not a mood; `conditions` are the real
 * condition set. Where the model scales a number so a human can watch it, the
 * comment says so and names the real default.
 * ==========================================================================*/

import type * as THREE from 'three'

/* ---------------------------------------------------------------------------
 * Cluster constants — geometry and simulation must agree on these counts.
 * -------------------------------------------------------------------------*/

/** Worker nodes in the visible grid. Real clusters run thousands. */
export const N_NODES = 4
/** Raft members in the etcd vault. Real clusters run 3 or 5; never even. */
export const N_ETCD_MEMBERS = 3
/** Majority needed to commit a raft entry. With 3 members, 2. */
export const ETCD_QUORUM = Math.floor(N_ETCD_MEMBERS / 2) + 1
/** Visible pod plots per node. kubelet's real default cap is 110. */
export const POD_SLOTS_PER_NODE = 12
/** Raft log entries visible in the vault at once — a moving window. */
export const RAFT_LOG_SLOTS = 16
/** Container slots drawn per pod (init + app + sidecar share the budget). */
export const CONTAINER_SLOTS_PER_POD = 4
/** Node hardware, per node. Scaled small so the whole grid fits one screen. */
export const NODE_CPU_MILLICORES = 4000
export const NODE_MEM_MIB = 8192
/** kube-system reserves a slice of every node before workloads get any. */
export const NODE_RESERVED_CPU_MILLICORES = 400
export const NODE_RESERVED_MEM_MIB = 768

/* ---------------------------------------------------------------------------
 * Real Kubernetes timings. These are the defaults the control loops actually
 * use; the simulation divides wall-clock by `timeScale`, never these.
 * -------------------------------------------------------------------------*/

export const TIMING = {
  /** kubelet renews its Lease this often. */
  kubeletLeaseSeconds: 10,
  /** No lease renewal for this long and the node controller marks NotReady. */
  nodeMonitorGraceSeconds: 40,
  /** Default toleration for node.kubernetes.io/not-ready before eviction. */
  notReadyTolerationSeconds: 300,
  /** CrashLoopBackOff doubles from here... */
  crashBackoffStartSeconds: 10,
  /** ...and is capped here. */
  crashBackoffMaxSeconds: 300,
  /** A container running this long resets its backoff to the start value. */
  crashBackoffResetSeconds: 600,
  /** Default probe cadence and failure tolerance. */
  probePeriodSeconds: 10,
  probeFailureThreshold: 3,
  probeSuccessThreshold: 1,
  /** SIGTERM to SIGKILL. */
  terminationGraceSeconds: 30,
  /** raft heartbeat and election window. */
  raftHeartbeatMs: 100,
  raftElectionTimeoutMs: 1000,
  /** HPA re-evaluates this often and refuses to scale down faster than this. */
  hpaSyncSeconds: 15,
  hpaScaleDownStabilizationSeconds: 300,
  /** etcd compacts and the API server's watch cache holds this much history. */
  etcdCompactionIntervalSeconds: 300,
} as const

/* ---------------------------------------------------------------------------
 * Identity. Every object in a cluster is (apiVersion, kind, namespace, name)
 * plus a resourceVersion that only etcd may assign.
 * -------------------------------------------------------------------------*/

export type Kind =
  | 'Pod'
  | 'ReplicaSet'
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Job'
  | 'CronJob'
  | 'Service'
  | 'EndpointSlice'
  | 'Ingress'
  | 'ConfigMap'
  | 'Secret'
  | 'PersistentVolume'
  | 'PersistentVolumeClaim'
  | 'StorageClass'
  | 'Node'
  | 'Namespace'
  | 'HorizontalPodAutoscaler'
  | 'PodDisruptionBudget'
  | 'ServiceAccount'
  | 'Lease'
  | 'Event'

export interface ObjectRef {
  kind: Kind
  namespace: string
  name: string
  /** etcd's monotonic revision at which this version was written. */
  resourceVersion: number
  uid: string
}

/** An ownerReference with `controller: true` — the edge garbage collection walks. */
export interface OwnerRef {
  kind: Kind
  name: string
  uid: string
  controller: boolean
}

/* ---------------------------------------------------------------------------
 * etcd — the only durable truth in the cluster.
 * -------------------------------------------------------------------------*/

export type RaftRole = 'leader' | 'follower' | 'candidate' | 'down'

export interface RaftLogEntry {
  index: number
  term: number
  /** Which key this entry mutates — drives the label in the vault. */
  key: string
  op: 'put' | 'delete'
  /** committed once a quorum has acknowledged it; applied once in the tree. */
  committed: boolean
  applied: boolean
  /** 0..1 animation progress of the proposal travelling to followers. */
  replication: number
}

export interface EtcdMember {
  id: string
  name: string
  role: RaftRole
  /** Highest log index this member has persisted. */
  matchIndex: number
  /** Raft term it believes is current. */
  term: number
  /** Seconds since it last heard from the leader. */
  sinceHeartbeat: number
  /** Disk write latency in ms — the thing that actually breaks etcd. */
  fsyncMs: number
}

export interface EtcdState {
  members: EtcdMember[]
  /** Monotonic revision. Every successful write bumps it; nothing resets it. */
  revision: number
  /** Revision below which history has been compacted away. */
  compactedRevision: number
  log: RaftLogEntry[]
  /** Has a quorum of members that can commit writes. */
  hasQuorum: boolean
  /** Backing store size in MiB against the default 2 GiB quota. */
  dbSizeMib: number
  dbQuotaMib: number
  /** Open watch streams, almost all of them the API server's. */
  watchers: number
  /** Committed writes per second. */
  writesPerSec: number
  /** Latency of a quorum read, in ms. */
  readLatencyMs: number
  /** Set when the quota is exceeded: the cluster goes read-only. */
  alarm: 'none' | 'NOSPACE' | 'CORRUPT'
}

/* ---------------------------------------------------------------------------
 * kube-apiserver — the one door. Every request rides this pipeline in order.
 * -------------------------------------------------------------------------*/

export type ApiStage =
  | 'tls'
  | 'authn'
  | 'authz'
  | 'apf'
  | 'mutating'
  | 'validation'
  | 'validating'
  | 'storage'
  | 'response'

export const API_STAGES: readonly ApiStage[] = [
  'tls',
  'authn',
  'authz',
  'apf',
  'mutating',
  'validation',
  'validating',
  'storage',
  'response',
] as const

export type Verb = 'get' | 'list' | 'watch' | 'create' | 'update' | 'patch' | 'delete'

export interface ApiRequest {
  id: string
  verb: Verb
  kind: Kind
  namespace: string
  name: string
  /** Who is asking — a user, a ServiceAccount, or a control-plane component. */
  subject: string
  stage: ApiStage
  /** 0..1 progress through the current stage. */
  progress: number
  /** Populated the moment a stage rejects it. */
  outcome: 'inflight' | 'ok' | 'unauthorized' | 'forbidden' | 'rejected' | 'conflict' | 'timeout'
  /** Human-readable rejection reason, shown on the request itself. */
  reason?: string
  /** Total ms spent so far, model time. */
  elapsedMs: number
}

export interface AdmissionWebhook {
  name: string
  kind: 'mutating' | 'validating'
  /** Model latency this webhook adds to every matching request. */
  latencyMs: number
  failurePolicy: 'Ignore' | 'Fail'
  /** A webhook whose backing service has no ready endpoints. */
  reachable: boolean
}

export interface ApiServerState {
  /** Requests currently inside the pipeline, in flight order. */
  inflight: ApiRequest[]
  /** API Priority and Fairness: concurrency shares actually in use. */
  apfSeatsUsed: number
  apfSeatsTotal: number
  /** Requests shed with 429 because their priority level was saturated. */
  throttled: number
  webhooks: AdmissionWebhook[]
  /** Open watch connections served to controllers and kubelets. */
  watchConnections: number
  /** The watch cache's newest revision — how far it lags etcd. */
  watchCacheRevision: number
  requestsPerSec: number
  /** Rolling counts by outcome, for the HUD. */
  counts: Record<'ok' | 'forbidden' | 'unauthorized' | 'rejected' | 'conflict', number>
  /** False while etcd has no quorum: writes fail, cached reads may still serve. */
  writable: boolean
}

/* ---------------------------------------------------------------------------
 * Controllers — the reconcile loops. Each is watch → diff → act, forever.
 * -------------------------------------------------------------------------*/

export type ControllerId =
  | 'deployment'
  | 'replicaset'
  | 'statefulset'
  | 'daemonset'
  | 'job'
  | 'cronjob'
  | 'node'
  | 'endpointslice'
  | 'pv-binder'
  | 'garbage-collector'
  | 'hpa'
  | 'serviceaccount'
  | 'namespace'

export type ReconcilePhase = 'idle' | 'dequeue' | 'diff' | 'act' | 'requeue'

export interface ControllerState {
  id: ControllerId
  name: string
  /** Items waiting in the rate-limited workqueue. */
  queueDepth: number
  /** What the loop is doing right now — drives the machine's animation. */
  phase: ReconcilePhase
  /** 0..1 progress through the current phase. */
  progress: number
  /** Key currently being reconciled, e.g. "shop/web". */
  currentKey?: string
  /** Objects the informer cache holds for this controller. */
  cached: number
  /** Reconciles completed and reconciles that returned an error. */
  reconciles: number
  errors: number
  /** Seconds until the next rate-limited retry, if the last attempt failed. */
  backoffSeconds: number
  /** Cleared when the component loses its leader election lease. */
  leading: boolean
}

/* ---------------------------------------------------------------------------
 * Scheduler — filter, score, bind. Bind is just another API write.
 * -------------------------------------------------------------------------*/

export type SchedulerPhase = 'idle' | 'dequeue' | 'filter' | 'score' | 'reserve' | 'bind'

/** Why a node was rejected in the filter phase. This is what `Pending` means. */
export type FilterReason =
  | 'Insufficient cpu'
  | 'Insufficient memory'
  | 'Too many pods'
  | 'node(s) had untolerated taint'
  | 'node(s) didn\'t match node affinity'
  | 'node(s) didn\'t match pod anti-affinity rules'
  | 'node(s) had volume node affinity conflict'
  | 'node(s) were unschedulable'
  | 'node(s) didn\'t satisfy topology spread constraints'

export interface NodeVerdict {
  nodeName: string
  passed: boolean
  /** The machine is not in the cluster: no verdict was formed, and it must not
   * be counted in `N/M nodes are available`. */
  absent?: boolean
  reason?: FilterReason
  /** 0..100 once scored; undefined if it never reached the score phase. */
  score?: number
  /** Per-plugin contributions, for the inspector breakdown. */
  scoreBreakdown?: { plugin: string; score: number }[]
}

export interface SchedulingCycle {
  podUid: string
  podName: string
  phase: SchedulerPhase
  progress: number
  verdicts: NodeVerdict[]
  chosen?: string
  /** Set when every node failed a filter. The pod stays Pending. */
  unschedulableReason?: string
  /** Pods this cycle would preempt to make room, if any. */
  preempting: string[]
}

export interface SchedulerState {
  /** Pods with no nodeName, in priority then FIFO order. */
  activeQueue: string[]
  /** Pods that failed to schedule and are waiting out their backoff. */
  backoffQueue: string[]
  /** Pods parked until a cluster event might make them schedulable. */
  unschedulableQueue: string[]
  cycle?: SchedulingCycle
  /** Successful bindings and failed attempts since start. */
  scheduled: number
  failed: number
  /** End-to-end scheduling latency in ms, rolling average. */
  latencyMs: number
  leading: boolean
}

/* ---------------------------------------------------------------------------
 * Nodes and kubelet.
 * -------------------------------------------------------------------------*/

export type NodeConditionType = 'Ready' | 'MemoryPressure' | 'DiskPressure' | 'PIDPressure' | 'NetworkUnavailable'
export type ConditionStatus = 'True' | 'False' | 'Unknown'

export interface NodeCondition {
  type: NodeConditionType
  status: ConditionStatus
  reason: string
  /** Seconds since the condition last flipped. */
  sinceSeconds: number
}

export interface Taint {
  key: string
  value?: string
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
}

export type KubeletPhase =
  | 'idle'
  | 'syncing'
  | 'pulling'
  | 'sandbox'
  | 'cni'
  | 'csi'
  | 'starting'
  | 'probing'
  | 'terminating'

export interface KubeletState {
  phase: KubeletPhase
  progress: number
  /** Pod the sync loop is working on. */
  currentPodUid?: string
  /** Seconds since the Lease was last renewed. */
  sinceLeaseSeconds: number
  /** PLEG relist health — the classic "PLEG is not healthy" failure. */
  plegHealthy: boolean
  /** Node-pressure eviction is actively reclaiming. */
  evicting: boolean
}

export interface KubeProxyRule {
  /** The Service this rule realizes. */
  service: string
  clusterIp: string
  /** Backend pod IPs currently programmed. Empty means connection refused. */
  endpoints: string[]
  /** True while the rule table is being reprogrammed. */
  syncing: boolean
}

export interface NodeState {
  name: string
  /** Index into the geometry's node grid. */
  index: number
  /**
   * Is this machine part of the cluster at all?
   *
   * Distinct from Ready and from cordoned: an absent node has no Node object,
   * so the scheduler never sees it, it contributes nothing to capacity, and it
   * is not a failure. Scaling the cluster down removes machines; it does not
   * break them.
   */
  present: boolean
  conditions: NodeCondition[]
  taints: Taint[]
  /** Set by `kubectl cordon`. Blocks new scheduling, keeps running pods. */
  unschedulable: boolean
  /** Total hardware. */
  capacityCpuMilli: number
  capacityMemMib: number
  capacityPods: number
  /** capacity minus kube-reserved — what the scheduler may actually hand out. */
  allocatableCpuMilli: number
  allocatableMemMib: number
  /** Sum of the *requests* of pods bound here. This is what schedules. */
  requestedCpuMilli: number
  requestedMemMib: number
  /** Real consumption. This is what OOM-kills and throttles. */
  usedCpuMilli: number
  usedMemMib: number
  podUids: string[]
  kubelet: KubeletState
  proxyRules: KubeProxyRule[]
  /** Pod CIDR assigned to this node by the controller manager. */
  podCidr: string
  /** Images already present, so a pull can be skipped. */
  imageCache: string[]
}

/* ---------------------------------------------------------------------------
 * Pods and containers.
 * -------------------------------------------------------------------------*/

export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'
export type PodConditionType = 'PodScheduled' | 'Initialized' | 'ContainersReady' | 'Ready'
export type QosClass = 'Guaranteed' | 'Burstable' | 'BestEffort'

export type ContainerStateName = 'waiting' | 'running' | 'terminated'

/** Real `reason` strings. These are what a user actually reads in `kubectl`. */
export type ContainerReason =
  | 'ContainerCreating'
  | 'PodInitializing'
  | 'ImagePullBackOff'
  | 'ErrImagePull'
  | 'CrashLoopBackOff'
  | 'OOMKilled'
  | 'Error'
  | 'Completed'
  | 'CreateContainerConfigError'
  | 'Running'

export interface ContainerState {
  name: string
  image: string
  /** init containers run to completion in order before app containers start. */
  role: 'init' | 'app' | 'sidecar'
  state: ContainerStateName
  reason: ContainerReason
  restartCount: number
  /** Seconds left on the exponential crash backoff, 0 when not backing off. */
  backoffRemaining: number
  /** Current backoff step, doubling from TIMING.crashBackoffStartSeconds. */
  backoffSeconds: number
  requestCpuMilli: number
  limitCpuMilli: number
  requestMemMib: number
  limitMemMib: number
  usedCpuMilli: number
  usedMemMib: number
  /** True while the cgroup CPU quota is actively capping this container. */
  throttled: boolean
  ready: boolean
  /** Consecutive probe failures, per probe kind. */
  livenessFailures: number
  readinessFailures: number
  startupDone: boolean
  /** 0..1 image pull progress, for the runtime animation. */
  pullProgress: number
}

export interface PodState {
  uid: string
  name: string
  namespace: string
  owner?: OwnerRef
  phase: PodPhase
  conditions: Record<PodConditionType, boolean>
  /** Empty until the scheduler binds it. */
  nodeName?: string
  /** Assigned by the CNI plugin, after the sandbox exists. */
  ip?: string
  qos: QosClass
  priority: number
  priorityClassName?: string
  containers: ContainerState[]
  /** Labels the Services and controllers select on. */
  labels: Record<string, string>
  nodeSelector?: Record<string, string>
  tolerations: Taint[]
  /** PVCs this pod mounts; it cannot start until they are Bound. */
  volumeClaims: string[]
  /** Seconds since creation, model time. */
  ageSeconds: number
  /** Set on delete: the pod is terminating and endpoints drop it immediately. */
  deletionGraceSeconds?: number
  /** Set by the pod plot's geometry so flows can find it without a lookup. */
  slot?: number
  /** Which revision of its Deployment produced it — drives rollout colouring. */
  revision?: number
}

/* ---------------------------------------------------------------------------
 * Workloads — records that produce records. Only a Pod ever becomes a building.
 * -------------------------------------------------------------------------*/

export interface DeploymentState {
  name: string
  namespace: string
  /** Desired replicas. This is the number the user edits. */
  replicas: number
  /** Rolling update budget. */
  maxSurge: number
  maxUnavailable: number
  /** Newest revision number; each spec change bumps it. */
  revision: number
  /** ReplicaSet names, newest first. Old ones are kept for rollback. */
  replicaSets: string[]
  /** Status subresource, all derived from the pods that actually exist. */
  statusReplicas: number
  readyReplicas: number
  availableReplicas: number
  updatedReplicas: number
  /** True while updated < desired or old pods survive. */
  rollingOut: boolean
  /** Set when a rollout makes no progress for progressDeadlineSeconds. */
  progressDeadlineExceeded: boolean
  paused: boolean
  selector: Record<string, string>
}

export interface ReplicaSetState {
  name: string
  namespace: string
  ownerDeployment: string
  revision: number
  /** Scaled to 0 for superseded revisions, which is why rollback is instant. */
  replicas: number
  statusReplicas: number
  readyReplicas: number
  selector: Record<string, string>
  podTemplateLabels: Record<string, string>
  /** Image of the app container — what actually differs between revisions. */
  image: string
}

export interface DaemonSetState {
  name: string
  namespace: string
  /** One pod per eligible node, by definition — never a replica count. */
  desiredScheduled: number
  currentScheduled: number
  ready: number
  tolerations: Taint[]
}

export interface StatefulSetState {
  name: string
  namespace: string
  replicas: number
  readyReplicas: number
  /** Ordinal currently being created or deleted; ordered, one at a time. */
  inProgressOrdinal?: number
  serviceName: string
  /** Each ordinal gets its own PVC, and keeps it across rescheduling. */
  claimTemplate: string
}

export interface JobState {
  name: string
  namespace: string
  completions: number
  parallelism: number
  succeeded: number
  failed: number
  backoffLimit: number
  active: number
  complete: boolean
}

export interface HpaState {
  name: string
  namespace: string
  targetRef: string
  metric: 'cpu' | 'memory'
  /** Target average utilisation as a percentage of *requests*, not limits. */
  targetUtilization: number
  currentUtilization: number
  minReplicas: number
  maxReplicas: number
  desiredReplicas: number
  /** Seconds until the scale-down stabilization window allows shrinking. */
  stabilizationRemaining: number
  /** True when the metrics pipeline cannot supply a value. */
  unknownMetrics: boolean
}

export interface PdbState {
  name: string
  namespace: string
  minAvailable: number
  currentHealthy: number
  /** How many pods may still be voluntarily evicted right now. */
  disruptionsAllowed: number
  selector: Record<string, string>
}

/* ---------------------------------------------------------------------------
 * Services and the network. A Service is a rule table, not a process.
 * -------------------------------------------------------------------------*/

export type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'Headless'

export interface EndpointSliceEntry {
  podUid: string
  ip: string
  ready: boolean
  /** Terminating pods are marked serving=false and drop out immediately. */
  serving: boolean
  nodeName?: string
}

export interface ServiceState {
  name: string
  namespace: string
  type: ServiceType
  /** The virtual IP. Nothing listens on it; every node has a rule for it. */
  clusterIp: string
  port: number
  targetPort: number
  nodePort?: number
  /** Provisioned by the cloud controller manager for LoadBalancer services. */
  externalIp?: string
  selector: Record<string, string>
  endpoints: EndpointSliceEntry[]
  /** Requests per second currently traversing this service. */
  rps: number
}

export interface IngressRule {
  host: string
  path: string
  service: string
  port: number
}

export interface IngressState {
  name: string
  namespace: string
  className: string
  rules: IngressRule[]
  tls: boolean
  /** Requests per second arriving from outside the cluster. */
  rps: number
  /** 5xx rate, which is how a broken rollout becomes visible to users. */
  errorRate: number
}

export interface DnsState {
  /** CoreDNS pods answering, via its own Service. */
  readyReplicas: number
  queriesPerSec: number
  /** Cache hit ratio of the CoreDNS cache plugin. */
  cacheHitRatio: number
  /** NXDOMAIN rate — usually the ndots:5 search-path tax on external names. */
  nxdomainRate: number
  latencyMs: number
}

export interface NetworkPolicyState {
  name: string
  namespace: string
  /** Pods this policy selects. Selecting a pod at all makes it default-deny. */
  podSelector: Record<string, string>
  ingressFrom: Record<string, string>[]
  /** Connections this policy dropped, for the checkpoint animation. */
  denied: number
}

/* ---------------------------------------------------------------------------
 * Storage.
 * -------------------------------------------------------------------------*/

export type PvcPhase = 'Pending' | 'Bound' | 'Lost'
export type PvPhase = 'Available' | 'Bound' | 'Released' | 'Failed'

export interface StorageClassState {
  name: string
  provisioner: string
  /** WaitForFirstConsumer is why a PVC can sit Pending until a pod schedules. */
  bindingMode: 'Immediate' | 'WaitForFirstConsumer'
  reclaimPolicy: 'Delete' | 'Retain'
  allowExpansion: boolean
}

export interface PvcState {
  name: string
  namespace: string
  phase: PvcPhase
  requestGib: number
  storageClass: string
  boundPv?: string
  /** Set while the PVC waits for its consumer pod to be scheduled. */
  waitingForConsumer: boolean
}

export interface PvState {
  name: string
  phase: PvPhase
  capacityGib: number
  storageClass: string
  boundClaim?: string
  /** Node the volume is currently attached to, for ReadWriteOnce volumes. */
  attachedNode?: string
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | 'ReadOnlyMany'
}

export type CsiOp = 'provision' | 'attach' | 'mount' | 'unmount' | 'detach' | 'delete'

export interface CsiOperation {
  id: string
  op: CsiOp
  pv: string
  nodeName?: string
  progress: number
  failed: boolean
  reason?: string
}

/* ---------------------------------------------------------------------------
 * Events — the cluster's own narration, and the HUD's ticker.
 * -------------------------------------------------------------------------*/

export interface ClusterEvent {
  id: number
  type: 'Normal' | 'Warning'
  reason: string
  /** Object the event is about, e.g. "pod/web-7d9f-x2k". */
  involved: string
  message: string
  /** Model seconds at which it was emitted. */
  at: number
  count: number
}

/* ---------------------------------------------------------------------------
 * Knobs — everything the user can turn, including the failure injections.
 * -------------------------------------------------------------------------*/

export interface Knobs {
  /** Machines in the cluster, 1..N_NODES. Absent nodes are removed, not broken. */
  nodeCount: number
  /** Desired replicas of the demo Deployment. The number the city chases. */
  replicas: number
  /** External requests per second arriving at the ingress. */
  trafficRps: number
  /** Per-container resource request and limit for the demo workload. */
  requestCpuMilli: number
  limitCpuMilli: number
  requestMemMib: number
  limitMemMib: number
  /** Rolling update budget. */
  maxSurge: number
  maxUnavailable: number
  /** Seconds an image pull takes when it is not already cached. */
  imagePullSeconds: number
  /** Probe tuning, exposed because misconfigured probes cause most outages. */
  readinessPeriodSeconds: number
  livenessPeriodSeconds: number
  probeFailureThreshold: number
  /** Autoscaling. */
  hpaEnabled: boolean
  hpaTargetUtilization: number
  hpaMinReplicas: number
  hpaMaxReplicas: number
  /** Admission webhook latency and reachability. */
  webhookLatencyMs: number
  webhookReachable: boolean
  /** etcd disk latency — the single most common real control-plane pathology. */
  etcdFsyncMs: number
  /** Members deliberately taken down, to demonstrate quorum loss. */
  etcdMembersDown: number
  /** Failure injections. */
  nodeDown: number
  crashLoop: boolean
  imagePullFailure: boolean
  memoryLeak: boolean
  networkPolicyEnabled: boolean
  podAntiAffinity: boolean
  /** Simulation transport. */
  timeScale: number
  paused: boolean
}

export const DEFAULT_KNOBS: Knobs = {
  nodeCount: N_NODES,
  replicas: 4,
  trafficRps: 120,
  requestCpuMilli: 250,
  limitCpuMilli: 500,
  requestMemMib: 256,
  limitMemMib: 512,
  maxSurge: 1,
  maxUnavailable: 0,
  imagePullSeconds: 6,
  readinessPeriodSeconds: TIMING.probePeriodSeconds,
  livenessPeriodSeconds: TIMING.probePeriodSeconds,
  probeFailureThreshold: TIMING.probeFailureThreshold,
  hpaEnabled: false,
  hpaTargetUtilization: 70,
  hpaMinReplicas: 2,
  hpaMaxReplicas: 12,
  webhookLatencyMs: 40,
  webhookReachable: true,
  etcdFsyncMs: 3,
  etcdMembersDown: 0,
  nodeDown: 0,
  crashLoop: false,
  imagePullFailure: false,
  memoryLeak: false,
  networkPolicyEnabled: false,
  podAntiAffinity: false,
  timeScale: 1,
  paused: false,
}

/* ---------------------------------------------------------------------------
 * Scenarios — the failure curriculum.
 *
 * Nobody needs a visualization of a healthy cluster; they need one of a broken
 * one. A scenario is a pathology an on-call engineer actually meets, staged so
 * it propagates through the city in the correct order and with the correct
 * delay, and narrated while it does.
 * -------------------------------------------------------------------------*/

export type ScenarioCategory =
  | 'workload'
  | 'scheduling'
  | 'node'
  | 'control-plane'
  | 'network'
  | 'storage'

export interface ScenarioStep {
  /** Model seconds after the scenario started when this beat begins. */
  at: number
  /** What is happening right now, in one or two plain sentences. */
  text: string
  /** Registry id to move the camera to, when this beat has a place. */
  focus?: string
}

export interface ScenarioDef {
  id: string
  title: string
  category: ScenarioCategory
  /** One line: what breaks. */
  blurb: string
  /** What the reader should watch for while it plays. */
  watchFor: string[]
  /**
   * What `kubectl` would show — the real reason string or condition. This is
   * the bridge between the city and the terminal the reader actually uses.
   */
  symptom?: string
  /** Narration beats, like a tour chapter but driven by model time. */
  steps?: ScenarioStep[]
  /** Roughly how long it takes to play out, in model seconds. */
  durationSeconds?: number
  /** The lesson. Why this happens, and what a real operator does about it. */
  teaches?: string
}

/* ---------------------------------------------------------------------------
 * SimState — the whole contract between src/sim and everything that draws it.
 * -------------------------------------------------------------------------*/

export interface SimState {
  /** Model seconds since start. Advances by dt * timeScale, never wall-clock. */
  t: number
  knobs: Knobs
  etcd: EtcdState
  api: ApiServerState
  scheduler: SchedulerState
  controllers: Record<ControllerId, ControllerState>
  nodes: NodeState[]
  /** Every pod in the cluster, keyed by uid. Buildings index into this. */
  pods: Map<string, PodState>
  deployments: DeploymentState[]
  replicaSets: ReplicaSetState[]
  statefulSets: StatefulSetState[]
  daemonSets: DaemonSetState[]
  jobs: JobState[]
  hpas: HpaState[]
  pdbs: PdbState[]
  services: ServiceState[]
  ingresses: IngressState[]
  networkPolicies: NetworkPolicyState[]
  dns: DnsState
  storageClasses: StorageClassState[]
  pvcs: PvcState[]
  pvs: PvState[]
  csiOps: CsiOperation[]
  events: ClusterEvent[]
  /** Cluster-wide rollups the HUD reads every frame. */
  totals: {
    podsRunning: number
    podsPending: number
    podsFailed: number
    podsTerminating: number
    nodesReady: number
    cpuRequestedMilli: number
    cpuAllocatableMilli: number
    memRequestedMib: number
    memAllocatableMib: number
    restarts: number
  }
}

/* ---------------------------------------------------------------------------
 * Registry — how a piece of geometry announces what it explains.
 * -------------------------------------------------------------------------*/

export type DistrictId =
  | 'client'
  | 'apiserver'
  | 'etcd'
  | 'scheduler'
  | 'controllers'
  | 'nodes'
  | 'network'
  | 'storage'
  | 'registry'

export interface Explainer {
  /** Stable id used by focus events, search, the tour and deep links. */
  id: string
  title: string
  district: DistrictId
  /** The real Kubernetes name, e.g. `kube-controller-manager`. */
  kubeName?: string
  /** One sentence: what this is. */
  summary: string
  /** The paragraphs shown in the inspector. */
  detail: string[]
  /** Simplifications that could change the lesson. Never optional in spirit. */
  caveats?: string[]
  /** Object to frame when the user focuses this entry. */
  object?: THREE.Object3D
  /** Where the camera should sit, if framing the object is not enough. */
  focus?: [number, number, number]
  /** Live values rendered into the inspector, recomputed per frame. */
  metrics?: (s: SimState) => { label: string; value: string; hint?: string }[]
  /** Search keywords beyond the title and kubeName. */
  keywords?: string[]
}
