/* ============================================================================
 * sim/model.ts — the cluster, assembled.
 *
 * This file owns three things: the initial cluster (the "YAML" everything else
 * reconciles toward), the tick order, and the small public surface the rest of
 * the application drives the simulation through.
 *
 * The tick order is causal, and the causality is the lesson:
 *
 *   etcd commits  ->  the API server serves  ->  controllers diff and write
 *   ->  the scheduler binds  ->  kubelets build  ->  endpoints and traffic
 *
 * Nothing in the model reaches around that order. A controller cannot create a
 * Pod without an API write; an API write cannot land without a raft quorum.
 * Break etcd and everything downstream stops, in the right order, by itself.
 * ==========================================================================*/

import {
  DEFAULT_KNOBS,
  N_ETCD_MEMBERS,
  N_NODES,
  NODE_CPU_MILLICORES,
  NODE_MEM_MIB,
  NODE_RESERVED_CPU_MILLICORES,
  NODE_RESERVED_MEM_MIB,
  POD_SLOTS_PER_NODE,
  type ControllerId,
  type ControllerState,
  type EtcdMember,
  type Kind,
  type Knobs,
  type NodeState,
  type SimState,
  type Taint,
} from '../core/types'
import { bus } from '../core/bus'
import { Rng, clusterIp } from '../core/util'
import {
  MODEL,
  clampKnobs,
  createStore,
  deletePod,
  emit,
  key,
  podIsTerminating,
  TAINT_NOT_READY,
  TAINT_UNREACHABLE,
  type ContainerSpec,
  type DeploySpec,
  type SimCtx,
} from './ctx'
import { SUBJECTS, submit, tickApiServer, tickBackgroundClients, tickEtcd } from './controlplane'
import {
  controllerWatch,
  enqueueKey,
  tickControllers,
  tickHpaStabilization,
  tickLeaderElection,
} from './controllers'
import { schedulerWatch, syncSchedulerQueue, tickScheduler } from './scheduling'
import { recomputeNodeAllocation, tickKubelet } from './kubelet'
import { tickNetwork } from './network'
import { tickStorage } from './storage'
import { IMAGES } from './images'
import { SCENARIOS } from './scenarios'

export { IMAGES }

/* ---------------------------------------------------------------------------
 * Public surface.
 * -------------------------------------------------------------------------*/

export interface Scenario {
  id: string
  title: string
  blurb: string
}

export interface Sim {
  state: SimState
  /** `dtSeconds` is real wall-clock seconds; timeScale is applied in here. */
  tick(dtSeconds: number): void
  setKnob<K extends keyof Knobs>(key: K, value: Knobs[K]): void
  runScenario(id: string): void
  stopScenario(): void
  /**
   * Delete a cluster object the way `kubectl delete` does: the request goes
   * through the API pipeline and etcd, and garbage collection cascades to
   * owned children. Returns false only when no such object exists. Standalone
   * objects (Ingress, Service, NetworkPolicy) stay gone; controller-owned ones
   * (a Pod, a ReplicaSet) are recreated by their controller — which is the
   * lesson, not a bug. There is no create path yet, so `reset()` is the undo.
   */
  deleteObject(kind: string, namespace: string, name: string): boolean
  /**
   * Create one of the predefined objects the model knows how to run. There is
   * no arbitrary `apply -f` — the model has fixed workload shapes — so this
   * only accepts names from `applyCatalogue()`. Idempotent: an object that
   * already exists is 'unchanged'.
   */
  applyObject(kind: string, name: string): ApplyResult
  /** The predefined objects apply can create. */
  applyCatalogue(): { kind: string; name: string }[]
  activeScenario: string | null
  scenarios: readonly Scenario[]
  reset(): void
}

/**
 * The controller yard's roster. Duplicated from world/layout.ts on purpose:
 * src/sim must never import three.js, and layout.ts does.
 */
export const CONTROLLER_IDS: readonly ControllerId[] = [
  'deployment',
  'replicaset',
  'statefulset',
  'daemonset',
  'job',
  'cronjob',
  'node',
  'endpointslice',
  'pv-binder',
  'hpa',
  'garbage-collector',
  'namespace',
  'serviceaccount',
] as const

const CONTROLLER_NAMES: Record<ControllerId, string> = {
  deployment: 'deployment-controller',
  replicaset: 'replicaset-controller',
  statefulset: 'statefulset-controller',
  daemonset: 'daemonset-controller',
  job: 'job-controller',
  cronjob: 'cronjob-controller',
  node: 'node-lifecycle-controller',
  endpointslice: 'endpointslice-controller',
  'pv-binder': 'persistentvolume-binder',
  'garbage-collector': 'garbage-collector',
  hpa: 'horizontal-pod-autoscaler',
  serviceaccount: 'serviceaccount-controller',
  namespace: 'namespace-controller',
}

/* ---------------------------------------------------------------------------
 * Pod templates for the demo cluster.
 * -------------------------------------------------------------------------*/

function webContainers(): ContainerSpec[] {
  return [
    {
      name: 'init-config',
      image: IMAGES.busybox,
      role: 'init',
      requestCpuMilli: 50,
      limitCpuMilli: 50,
      requestMemMib: 32,
      limitMemMib: 32,
      runSeconds: 3,
      idleCpuMilli: 40,
      idleMemMib: 26,
      hasReadinessProbe: false,
      hasLivenessProbe: false,
    },
    {
      name: 'web',
      image: IMAGES.webV1,
      role: 'app',
      requestCpuMilli: DEFAULT_KNOBS.requestCpuMilli,
      limitCpuMilli: DEFAULT_KNOBS.limitCpuMilli,
      requestMemMib: DEFAULT_KNOBS.requestMemMib,
      limitMemMib: DEFAULT_KNOBS.limitMemMib,
      startupSeconds: 4,
      idleCpuMilli: 18,
      idleMemMib: 148,
      trafficShare: MODEL.cpuPerRps,
      hasReadinessProbe: true,
      hasLivenessProbe: true,
    },
    {
      name: 'log-shipper',
      image: IMAGES.fluentbit,
      role: 'sidecar',
      requestCpuMilli: 50,
      limitCpuMilli: 50,
      requestMemMib: 64,
      limitMemMib: 64,
      startupSeconds: 1,
      idleCpuMilli: 11,
      idleMemMib: 44,
      trafficShare: 0.05,
      hasReadinessProbe: false,
      hasLivenessProbe: false,
    },
  ]
}

function simpleApp(
  name: string,
  image: string,
  req: [number, number, number, number],
  idle: [number, number],
  opts: Partial<ContainerSpec> = {},
): ContainerSpec {
  return {
    name,
    image,
    role: 'app',
    requestCpuMilli: req[0],
    limitCpuMilli: req[1],
    requestMemMib: req[2],
    limitMemMib: req[3],
    idleCpuMilli: idle[0],
    idleMemMib: idle[1],
    hasReadinessProbe: true,
    hasLivenessProbe: true,
    ...opts,
  }
}

/* ---------------------------------------------------------------------------
 * The initial cluster.
 * -------------------------------------------------------------------------*/

function makeNode(i: number): NodeState {
  return {
    name: `node-${i + 1}`,
    index: i,
    present: true,
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', sinceSeconds: 0 },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', sinceSeconds: 0 },
      { type: 'DiskPressure', status: 'False', reason: 'KubeletHasNoDiskPressure', sinceSeconds: 0 },
      { type: 'PIDPressure', status: 'False', reason: 'KubeletHasSufficientPID', sinceSeconds: 0 },
      { type: 'NetworkUnavailable', status: 'False', reason: 'RouteCreated', sinceSeconds: 0 },
    ],
    /* One node is reserved for batch work, so taints and tolerations are
     * visible in the default cluster rather than only under a scenario. */
    taints: i === N_NODES - 1 ? [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }] : [],
    unschedulable: false,
    capacityCpuMilli: NODE_CPU_MILLICORES,
    capacityMemMib: NODE_MEM_MIB,
    capacityPods: POD_SLOTS_PER_NODE,
    allocatableCpuMilli: NODE_CPU_MILLICORES - NODE_RESERVED_CPU_MILLICORES,
    allocatableMemMib: NODE_MEM_MIB - NODE_RESERVED_MEM_MIB,
    requestedCpuMilli: 0,
    requestedMemMib: 0,
    usedCpuMilli: 0,
    usedMemMib: 0,
    podUids: [],
    kubelet: { phase: 'idle', progress: 0, sinceLeaseSeconds: 0, plegHealthy: true, evicting: false },
    proxyRules: [],
    podCidr: `10.244.${i}.0/24`,
    imageCache: [IMAGES.pause],
  }
}

function makeEtcdMember(i: number): EtcdMember {
  return {
    id: (0x8e9e05c4 + i * 0x1111).toString(16),
    name: `etcd-${i + 1}`,
    role: i === 0 ? 'leader' : 'follower',
    matchIndex: 0,
    term: 1,
    sinceHeartbeat: 0,
    fsyncMs: DEFAULT_KNOBS.etcdFsyncMs,
  }
}

function makeControllers(): Record<ControllerId, ControllerState> {
  const out = {} as Record<ControllerId, ControllerState>
  for (const id of CONTROLLER_IDS) {
    out[id] = {
      id,
      name: CONTROLLER_NAMES[id],
      queueDepth: 0,
      phase: 'idle',
      progress: 0,
      cached: 0,
      reconciles: 0,
      errors: 0,
      backoffSeconds: 0,
      leading: true,
    }
  }
  return out
}

/*
 * What the DaemonSet controller writes onto every pod it creates, not what an
 * author typed. The two NoExecute entries are why a node agent is never evicted
 * from a machine nobody can reach: it is supposed to keep reporting for as long
 * as the Node object exists. Real Kubernetes adds them without
 * `tolerationSeconds`, which this model has no concept of — see
 * `toleratesTaint`.
 *
 * One owner. The roster in `daemonSets` and the pod template in `deploySpecs`
 * are two views of the same DaemonSet, and when they each carried their own
 * copy the eviction path read one while the scheduling path read the other.
 */
const DAEMONSET_TOLERATIONS: readonly Taint[] = [
  { key: '', effect: 'NoSchedule' },
  { key: TAINT_NOT_READY, effect: 'NoExecute' },
  { key: TAINT_UNREACHABLE, effect: 'NoExecute' },
]

export function createState(): SimState {
  const knobs: Knobs = { ...DEFAULT_KNOBS }
  const nodes: NodeState[] = []
  for (let i = 0; i < N_NODES; i++) nodes.push(makeNode(i))
  const members: EtcdMember[] = []
  for (let i = 0; i < N_ETCD_MEMBERS; i++) members.push(makeEtcdMember(i))

  return {
    t: 0,
    knobs,
    etcd: {
      members,
      /* Revision 1 is the empty cluster. Nothing ever moves it backwards. */
      revision: 1,
      compactedRevision: 0,
      log: [],
      hasQuorum: true,
      dbSizeMib: 64,
      dbQuotaMib: 2048,
      watchers: 0,
      writesPerSec: 0,
      readLatencyMs: knobs.etcdFsyncMs + 1,
      alarm: 'none',
    },
    api: {
      inflight: [],
      apfSeatsUsed: 0,
      apfSeatsTotal: MODEL.apfSeats,
      throttled: 0,
      webhooks: [
        {
          name: 'sidecar-injector.k8skylines.dev',
          kind: 'mutating',
          latencyMs: knobs.webhookLatencyMs,
          failurePolicy: 'Ignore',
          reachable: true,
        },
        {
          /* failurePolicy: Fail is the correct choice for a policy webhook and
           * also the reason an unreachable one takes the cluster down. */
          name: 'policy.k8skylines.dev',
          kind: 'validating',
          latencyMs: knobs.webhookLatencyMs,
          failurePolicy: 'Fail',
          reachable: true,
        },
      ],
      watchConnections: 0,
      watchCacheRevision: 1,
      requestsPerSec: 0,
      counts: { ok: 0, forbidden: 0, unauthorized: 0, rejected: 0, conflict: 0 },
      writable: true,
    },
    scheduler: {
      activeQueue: [],
      backoffQueue: [],
      unschedulableQueue: [],
      scheduled: 0,
      failed: 0,
      latencyMs: 0,
      leading: true,
    },
    controllers: makeControllers(),
    nodes,
    pods: new Map(),
    deployments: [
      {
        name: 'web',
        namespace: 'shop',
        replicas: knobs.replicas,
        maxSurge: knobs.maxSurge,
        maxUnavailable: knobs.maxUnavailable,
        revision: 0,
        replicaSets: [],
        statusReplicas: 0,
        readyReplicas: 0,
        availableReplicas: 0,
        updatedReplicas: 0,
        rollingOut: false,
        progressDeadlineExceeded: false,
        paused: false,
        selector: { app: 'web' },
      },
      {
        name: 'api',
        namespace: 'shop',
        replicas: 2,
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
        selector: { app: 'api' },
      },
      {
        name: 'coredns',
        namespace: 'kube-system',
        replicas: 2,
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
        selector: { app: 'coredns' },
      },
    ],
    replicaSets: [],
    statefulSets: [
      {
        name: 'db',
        namespace: 'shop',
        replicas: 2,
        readyReplicas: 0,
        serviceName: 'db',
        claimTemplate: 'data',
      },
    ],
    daemonSets: [
      {
        name: 'node-exporter',
        namespace: 'kube-system',
        desiredScheduled: 0,
        currentScheduled: 0,
        ready: 0,
        tolerations: [...DAEMONSET_TOLERATIONS],
      },
    ],
    jobs: [
      {
        name: 'migrate',
        namespace: 'shop',
        completions: 3,
        parallelism: 1,
        succeeded: 0,
        failed: 0,
        backoffLimit: 4,
        active: 0,
        complete: false,
      },
    ],
    hpas: [
      {
        name: 'web',
        namespace: 'shop',
        targetRef: 'Deployment/web',
        metric: 'cpu',
        targetUtilization: knobs.hpaTargetUtilization,
        currentUtilization: 0,
        minReplicas: knobs.hpaMinReplicas,
        maxReplicas: knobs.hpaMaxReplicas,
        desiredReplicas: knobs.replicas,
        stabilizationRemaining: 0,
        unknownMetrics: true,
      },
    ],
    pdbs: [
      {
        name: 'web-pdb',
        namespace: 'shop',
        minAvailable: 3,
        currentHealthy: 0,
        disruptionsAllowed: 0,
        selector: { app: 'web' },
      },
    ],
    services: [
      {
        name: 'kubernetes',
        namespace: 'default',
        type: 'ClusterIP',
        clusterIp: clusterIp(0),
        port: 443,
        targetPort: 6443,
        selector: {},
        /* The one Service whose endpoints are not pods: they are the API
         * servers' own addresses, written by the apiserver itself. */
        endpoints: [{ podUid: '', ip: '10.0.0.10', ready: true, serving: true }],
        rps: 0,
      },
      {
        name: 'kube-dns',
        namespace: 'kube-system',
        type: 'ClusterIP',
        clusterIp: clusterIp(9),
        port: 53,
        targetPort: 53,
        selector: { app: 'coredns' },
        endpoints: [],
        rps: 0,
      },
      {
        name: 'web',
        namespace: 'shop',
        type: 'ClusterIP',
        clusterIp: clusterIp(20),
        port: 80,
        targetPort: 8080,
        selector: { app: 'web' },
        endpoints: [],
        rps: 0,
      },
      {
        name: 'api',
        namespace: 'shop',
        type: 'ClusterIP',
        clusterIp: clusterIp(21),
        port: 80,
        targetPort: 8080,
        selector: { app: 'api' },
        endpoints: [],
        rps: 0,
      },
      {
        name: 'db',
        namespace: 'shop',
        type: 'Headless',
        /* A headless Service has no virtual IP at all: DNS answers with the
         * pod IPs directly, which is how StatefulSet peers find each other. */
        clusterIp: 'None',
        port: 5432,
        targetPort: 5432,
        selector: { app: 'db' },
        endpoints: [],
        rps: 0,
      },
      {
        name: 'web-lb',
        namespace: 'shop',
        type: 'LoadBalancer',
        clusterIp: clusterIp(22),
        port: 80,
        targetPort: 8080,
        nodePort: 30080,
        externalIp: '203.0.113.42',
        selector: { app: 'web' },
        endpoints: [],
        rps: 0,
      },
    ],
    ingresses: [
      {
        name: 'shop',
        namespace: 'shop',
        className: 'nginx',
        rules: [
          { host: 'shop.example.com', path: '/', service: 'web', port: 80 },
          { host: 'shop.example.com', path: '/api', service: 'api', port: 80 },
        ],
        tls: true,
        rps: 0,
        errorRate: 0,
      },
    ],
    networkPolicies: [],
    dns: { readyReplicas: 0, queriesPerSec: 0, cacheHitRatio: 0, nxdomainRate: 0, latencyMs: 0 },
    storageClasses: [
      {
        name: 'standard',
        provisioner: 'local.csi.k8skylines.dev',
        bindingMode: 'Immediate',
        reclaimPolicy: 'Delete',
        allowExpansion: true,
      },
      {
        name: 'fast-ssd',
        provisioner: 'local.csi.k8skylines.dev',
        bindingMode: 'WaitForFirstConsumer',
        reclaimPolicy: 'Delete',
        allowExpansion: true,
      },
    ],
    pvcs: [
      {
        name: 'uploads',
        namespace: 'shop',
        phase: 'Pending',
        requestGib: 4,
        storageClass: 'standard',
        waitingForConsumer: false,
      },
    ],
    pvs: [],
    csiOps: [],
    events: [],
    totals: {
      podsRunning: 0,
      podsPending: 0,
      podsFailed: 0,
      podsTerminating: 0,
      nodesReady: 0,
      nodesTotal: N_NODES,
      cpuRequestedMilli: 0,
      cpuAllocatableMilli: 0,
      memRequestedMib: 0,
      memAllocatableMib: 0,
      restarts: 0,
    },
  }
}

function installSpecs(ctx: SimCtx): void {
  const specs = ctx.store.deploySpecs
  const web: DeploySpec = {
    image: IMAGES.webV1,
    labels: { app: 'web', tier: 'frontend' },
    containers: webContainers(),
    tolerations: [],
    volumeClaims: [],
    priority: 0,
    antiAffinityKey: 'app',
    knobDriven: true,
    history: new Map(),
  }
  specs.set('shop/web', web)

  specs.set('shop/api', {
    image: IMAGES.api,
    labels: { app: 'api', tier: 'backend' },
    containers: [
      simpleApp('api', IMAGES.api, [200, 400, 192, 384], [15, 118], {
        startupSeconds: 3,
        trafficShare: 1.6,
      }),
    ],
    tolerations: [],
    volumeClaims: [],
    priority: 0,
    knobDriven: false,
    history: new Map(),
  })

  specs.set('kube-system/coredns', {
    image: IMAGES.coredns,
    labels: { app: 'coredns', 'k8s-app': 'kube-dns' },
    containers: [
      simpleApp('coredns', IMAGES.coredns, [100, 200, 70, 170], [8, 42], {
        startupSeconds: 2,
        trafficShare: 0.22,
      }),
    ],
    tolerations: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }],
    volumeClaims: [],
    priority: 2000000000,
    priorityClassName: 'system-cluster-critical',
    knobDriven: false,
    history: new Map(),
  })

  specs.set('shop/db', {
    image: IMAGES.postgres,
    labels: { app: 'db' },
    /* requests === limits on every resource, so this pod is Guaranteed and is
     * the last thing the kubelet evicts under memory pressure. */
    containers: [
      simpleApp('postgres', IMAGES.postgres, [500, 500, 768, 768], [58, 410], {
        startupSeconds: 6,
        trafficShare: 1,
      }),
    ],
    tolerations: [],
    volumeClaims: [],
    priority: 0,
    knobDriven: false,
    history: new Map(),
  })

  specs.set('kube-system/node-exporter', {
    image: IMAGES.nodeExporter,
    labels: { app: 'node-exporter' },
    /* No requests and no limits at all: BestEffort, and first out the door. */
    containers: [
      simpleApp('node-exporter', IMAGES.nodeExporter, [0, 0, 0, 0], [12, 44], {
        startupSeconds: 1,
        hasLivenessProbe: false,
      }),
    ],
    tolerations: [...DAEMONSET_TOLERATIONS],
    volumeClaims: [],
    priority: 2000000000,
    priorityClassName: 'system-node-critical',
    knobDriven: false,
    history: new Map(),
  })

  specs.set('shop/migrate', {
    image: IMAGES.migrate,
    labels: { app: 'migrate', 'job-name': 'migrate' },
    containers: [
      simpleApp('migrate', IMAGES.migrate, [200, 400, 256, 512], [180, 210], {
        runSeconds: 12,
        hasReadinessProbe: false,
        hasLivenessProbe: false,
      }),
    ],
    tolerations: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
    volumeClaims: [],
    priority: 0,
    knobDriven: false,
    history: new Map(),
  })

  specs.set('shop/report', {
    image: IMAGES.report,
    labels: { app: 'report', 'job-name': 'report' },
    containers: [
      simpleApp('report', IMAGES.report, [150, 300, 128, 256], [140, 110], {
        runSeconds: 8,
        hasReadinessProbe: false,
        hasLivenessProbe: false,
      }),
    ],
    tolerations: [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }],
    volumeClaims: [],
    priority: 0,
    knobDriven: false,
    history: new Map(),
  })
}

/* ---------------------------------------------------------------------------
 * Totals. The HUD reads these every frame, so they are recomputed every tick.
 * -------------------------------------------------------------------------*/

function updateTotals(ctx: SimCtx): void {
  const t = ctx.s.totals
  let running = 0
  let pending = 0
  let failed = 0
  let terminating = 0
  let restarts = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    for (let c = 0; c < p.containers.length; c++) restarts += p.containers[c].restartCount
    if (podIsTerminating(p)) {
      terminating += 1
      continue
    }
    switch (p.phase) {
      case 'Running':
        running += 1
        break
      case 'Pending':
        pending += 1
        break
      case 'Failed':
        failed += 1
        break
      default:
        break
    }
  }
  t.podsRunning = running
  t.podsPending = pending
  t.podsFailed = failed
  t.podsTerminating = terminating

  let nodesReady = 0
  let nodesTotal = 0
  let cpuReq = 0
  let cpuAlloc = 0
  let memReq = 0
  let memAlloc = 0
  for (let i = 0; i < ctx.s.nodes.length; i++) {
    const n = ctx.s.nodes[i]
    /* A machine that is not in the cluster contributes nothing — not capacity,
     * not a Ready count, and not a missing one. It simply is not there. */
    if (!n.present) continue
    nodesTotal += 1
    for (let c = 0; c < n.conditions.length; c++) {
      const cond = n.conditions[c]
      if (cond.type === 'Ready' && cond.status === 'True') nodesReady += 1
    }
    cpuReq += n.requestedCpuMilli
    cpuAlloc += n.allocatableCpuMilli
    memReq += n.requestedMemMib
    memAlloc += n.allocatableMemMib
  }
  t.nodesReady = nodesReady
  t.nodesTotal = nodesTotal
  t.cpuRequestedMilli = cpuReq
  t.cpuAllocatableMilli = cpuAlloc
  t.memRequestedMib = memReq
  t.memAllocatableMib = memAlloc
  t.restarts = restarts
}

/* ---------------------------------------------------------------------------
 * The tick.
 * -------------------------------------------------------------------------*/

/** Largest model step taken at once. Bigger steps make probes skip periods. */
const MAX_SUBSTEP = 0.1
/** Largest amount of model time one tick() call may advance. */
const MAX_STEP = 2

function stepOnce(ctx: SimCtx, dt: number): void {
  ctx.s.t += dt

  /* Cluster membership, derived every tick rather than on knob change, so the
   * flag can never drift from the knob whichever way the knob was set. */
  for (let i = 0; i < ctx.s.nodes.length; i++) {
    const present = i < ctx.s.knobs.nodeCount
    const node = ctx.s.nodes[i]
    if (node.present === present) continue
    node.present = present
    /*
     * Membership changed, so the Node object did too: one was deleted, or a
     * kubelet registered a new one. `unschedulable` is the only thing that has
     * to be dropped by hand — a cordon is written onto the object by an
     * operator and nothing in the control plane ever clears it, so a cordon
     * that outlived its Node would keep the scheduler off a machine nobody
     * cordoned. Conditions and taints need no help: the kubelet and the node
     * controller re-derive them within a tick. The image cache stays because
     * the disk does. Pod bindings stay because they are PodGC's to settle.
     */
    node.unschedulable = false
  }

  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) pods[i].ageSeconds += dt

  tickEtcd(ctx, dt)
  tickApiServer(ctx, dt)
  tickBackgroundClients(ctx, dt)
  tickLeaderElection(ctx, dt)

  tickControllers(ctx, dt)

  recomputeNodeAllocation(ctx)
  syncSchedulerQueue(ctx)
  tickScheduler(ctx, dt)

  tickKubelet(ctx, dt)
  recomputeNodeAllocation(ctx)

  tickNetwork(ctx, dt)
  tickStorage(ctx, dt)
  tickHpaStabilization(ctx, dt)

  updateTotals(ctx)
}

/* ---------------------------------------------------------------------------
 * Deletion.
 *
 * A delete is a write like any other: it goes through submit() so it commits
 * only once etcd has it, which is why deleting while quorum is lost does
 * nothing until quorum returns. The commit removes the object from state, and
 * the garbage collector (already reconciling every tick) cascades to whatever
 * that object owned. Nothing here reaches around the API server.
 * -------------------------------------------------------------------------*/

/** Match by name, and by namespace when one was given. */
function nsMatch(objNs: string, wantNs: string): boolean {
  return wantNs === '' || objNs === wantNs
}

function submitDelete(ctx: SimCtx, kind: Kind, ns: string, name: string, commit: (c: SimCtx) => void): void {
  submit(ctx, { verb: 'delete', kind, namespace: ns, name, subject: SUBJECTS.admin, commit })
}

/**
 * Delete a cluster object by kind and name. Returns whether one was found; the
 * removal itself happens a few ticks later, when the write commits — exactly
 * as `kubectl delete` returns before the object is fully gone.
 */
function deleteClusterObject(ctx: SimCtx, kind: string, ns: string, name: string): boolean {
  const s = ctx.s
  switch (kind) {
    case 'ingress': {
      if (!s.ingresses.some((x) => x.name === name && nsMatch(x.namespace, ns))) return false
      submitDelete(ctx, 'Ingress', ns, name, (c) => {
        spliceBy(c.s.ingresses, name, ns)
        emit(c, 'Normal', 'Deleted', `ingress/${name}`, `Deleted ingress ${name}; external traffic no longer reaches its backends`)
      })
      return true
    }
    case 'service': {
      if (!s.services.some((x) => x.name === name && nsMatch(x.namespace, ns))) return false
      submitDelete(ctx, 'Service', ns, name, (c) => {
        spliceBy(c.s.services, name, ns)
        /* The pods behind it keep running; only the rule tables that routed to
         * them disappear, which kube-proxy rebuilds empty on the next sync. */
        emit(c, 'Normal', 'Deleted', `service/${name}`, `Deleted service ${name}; its rule tables are removed from every node`)
      })
      return true
    }
    case 'networkpolicy': {
      if (!s.networkPolicies.some((x) => x.name === name && nsMatch(x.namespace, ns))) return false
      submitDelete(ctx, 'NetworkPolicy', ns, name, (c) => {
        spliceBy(c.s.networkPolicies, name, ns)
        /* The knob is what recreates this policy every tick, so deleting the
         * object means turning it off — anything else and it comes right back. */
        c.s.knobs.networkPolicyEnabled = false
        emit(c, 'Normal', 'Deleted', `networkpolicy/${name}`, `Deleted networkpolicy ${name}; its selected pods are no longer default-deny`)
      })
      return true
    }
    case 'horizontalpodautoscaler': {
      if (!s.hpas.some((x) => x.name === name && nsMatch(x.namespace, ns))) return false
      submitDelete(ctx, 'HorizontalPodAutoscaler', ns, name, (c) => {
        spliceBy(c.s.hpas, name, ns)
        /* The knob no longer has an object to drive, so replicas stop moving on
         * their own. Turn the knob off too, or a resync would recreate nothing
         * but the reader would still expect autoscaling. */
        c.s.knobs.hpaEnabled = false
        emit(c, 'Normal', 'Deleted', `horizontalpodautoscaler/${name}`, `Deleted hpa ${name}; the replica count is manual again`)
      })
      return true
    }
    case 'persistentvolumeclaim': {
      if (!s.pvcs.some((x) => x.name === name && nsMatch(x.namespace, ns))) return false
      submitDelete(ctx, 'PersistentVolumeClaim', ns, name, (c) => {
        spliceBy(c.s.pvcs, name, ns)
        enqueueKey(c, 'garbage-collector', 'cluster')
        emit(c, 'Normal', 'Deleted', `persistentvolumeclaim/${name}`, `Deleted pvc ${name}; its PersistentVolume is released`)
      })
      return true
    }
    case 'deployment': {
      const d = s.deployments.find((x) => x.name === name && nsMatch(x.namespace, ns))
      if (!d) return false
      submitDelete(ctx, 'Deployment', d.namespace, name, (c) => {
        spliceBy(c.s.deployments, name, d.namespace)
        c.store.deploySpecs.delete(key(d.namespace, name))
        /* The garbage collector removes the now-ownerless ReplicaSets, and
         * their pods orphan and follow. Kick it so the cascade starts now. */
        enqueueKey(c, 'garbage-collector', 'cluster')
        emit(c, 'Normal', 'Deleted', `deployment/${name}`, `Deleted deployment ${name}; its ReplicaSets and pods are garbage-collected`)
      })
      return true
    }
    case 'replicaset': {
      const r = s.replicaSets.find((x) => x.name === name && nsMatch(x.namespace, ns))
      if (!r) return false
      submitDelete(ctx, 'ReplicaSet', r.namespace, name, (c) => {
        spliceBy(c.s.replicaSets, name, r.namespace)
        c.store.rsTemplate.delete(key(r.namespace, name))
        /* If a Deployment still owns it, that controller recreates a current
         * ReplicaSet to hold the desired count — the pods come back. */
        enqueueKey(c, 'deployment', key(r.namespace, r.ownerDeployment))
        enqueueKey(c, 'garbage-collector', 'cluster')
        emit(c, 'Normal', 'Deleted', `replicaset/${name}`, `Deleted replicaset ${name}`)
      })
      return true
    }
    case 'pod': {
      const pod = [...s.pods.values()].find((p) => p.name === name && nsMatch(p.namespace, ns))
      if (!pod) return false
      const uid = pod.uid
      submitDelete(ctx, 'Pod', pod.namespace, name, (c) => {
        /* Graceful, like the real API: the object lingers for its grace period
         * and its controller creates a replacement to restore the count. */
        deletePod(c, uid, 'Deleted')
      })
      return true
    }
    default:
      return false
  }
}

/** Remove the first element matching name (and namespace, if given). */
function spliceBy<T extends { name: string; namespace: string }>(arr: T[], name: string, ns: string): void {
  const i = arr.findIndex((x) => x.name === name && nsMatch(x.namespace, ns))
  if (i >= 0) arr.splice(i, 1)
}

/* ---------------------------------------------------------------------------
 * Apply.
 *
 * There is no general `apply -f`: the model runs specific workloads with
 * specific shapes, not arbitrary specs, and pretending otherwise would teach
 * that it is a Kubernetes engine. So apply can only (re)create objects from the
 * seed catalogue — the same definitions bootstrap uses. It is idempotent, like
 * the real thing: applying an object that already exists changes nothing, and
 * it too goes through the API pipeline.
 * -------------------------------------------------------------------------*/

const APPLY_NETWORKPOLICY = 'api-allow-web'

export type ApplyResult = 'created' | 'unchanged' | 'unknown'

/** The predefined objects apply can create, so the UI can list and complete
 *  them. Built from the seed, plus the one knob-backed policy. */
function applyCatalogueOf(catalogue: SimState): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = []
  for (const d of catalogue.deployments) out.push({ kind: 'deployment', name: d.name })
  for (const v of catalogue.services) out.push({ kind: 'service', name: v.name })
  for (const i of catalogue.ingresses) out.push({ kind: 'ingress', name: i.name })
  for (const h of catalogue.hpas) out.push({ kind: 'horizontalpodautoscaler', name: h.name })
  for (const p of catalogue.pvcs) out.push({ kind: 'persistentvolumeclaim', name: p.name })
  out.push({ kind: 'networkpolicy', name: APPLY_NETWORKPOLICY })
  return out
}

function applyClusterObject(ctx: SimCtx, catalogue: SimState, kind: string, name: string): ApplyResult {
  const s = ctx.s

  /* Recreate `seedObj` into `live` via the API, unless it is already there.
   * `register` runs in the commit, after the create lands in etcd. */
  function create<T extends { name: string; namespace: string }>(
    live: T[],
    seedList: readonly T[],
    apiKind: Kind,
    register: (c: SimCtx, obj: T) => void,
  ): ApplyResult {
    if (live.some((x) => x.name === name)) return 'unchanged'
    const seedObj = seedList.find((x) => x.name === name)
    if (!seedObj) return 'unknown'
    const obj = structuredClone(seedObj) as T
    submit(ctx, {
      verb: 'create',
      kind: apiKind,
      namespace: obj.namespace,
      name,
      subject: SUBJECTS.admin,
      commit: (c) => {
        if (live.some((x) => x.name === name)) return
        register(c, obj)
      },
    })
    return 'created'
  }

  switch (kind) {
    case 'deployment':
      return create(s.deployments, catalogue.deployments, 'Deployment', (c, obj) => {
        /* installSpecs re-registers the workload template this Deployment needs
         * to make pods; it is keyed by name and idempotent for the others. */
        installSpecs(c)
        c.s.deployments.push(obj)
        enqueueKey(c, 'deployment', key(obj.namespace, name))
        emit(c, 'Normal', 'Applied', `deployment/${name}`, `Created deployment ${name}`)
      })
    case 'service':
      return create(s.services, catalogue.services, 'Service', (c, obj) => {
        c.s.services.push(obj)
        enqueueKey(c, 'endpointslice', key(obj.namespace, name))
        emit(c, 'Normal', 'Applied', `service/${name}`, `Created service ${name}`)
      })
    case 'ingress':
      return create(s.ingresses, catalogue.ingresses, 'Ingress', (c, obj) => {
        c.s.ingresses.push(obj)
        emit(c, 'Normal', 'Applied', `ingress/${name}`, `Created ingress ${name}`)
      })
    case 'persistentvolumeclaim':
      return create(s.pvcs, catalogue.pvcs, 'PersistentVolumeClaim', (c, obj) => {
        c.s.pvcs.push(obj)
        enqueueKey(c, 'pv-binder', key(obj.namespace, name))
        emit(c, 'Normal', 'Applied', `persistentvolumeclaim/${name}`, `Created pvc ${name}`)
      })
    case 'horizontalpodautoscaler':
      return create(s.hpas, catalogue.hpas, 'HorizontalPodAutoscaler', (c, obj) => {
        c.s.hpas.push(obj)
        /* An HPA with the knob off would exist but never scale — applying it is
         * a request for autoscaling, so turn it on. */
        c.s.knobs.hpaEnabled = true
        enqueueKey(c, 'hpa', key(obj.namespace, name))
        emit(c, 'Normal', 'Applied', `horizontalpodautoscaler/${name}`, `Created hpa ${name}`)
      })
    case 'networkpolicy': {
      if (name !== APPLY_NETWORKPOLICY) return 'unknown'
      if (s.knobs.networkPolicyEnabled && s.networkPolicies.some((p) => p.name === name)) return 'unchanged'
      /* The knob is the mechanism that creates this policy each tick; route the
       * create through the API so it, too, waits on etcd. */
      submit(ctx, {
        verb: 'create',
        kind: 'NetworkPolicy',
        namespace: 'shop',
        name,
        subject: SUBJECTS.admin,
        commit: (c) => {
          c.s.knobs.networkPolicyEnabled = true
        },
      })
      return 'created'
    }
    default:
      return 'unknown'
  }
}

/* ---------------------------------------------------------------------------
 * createSim.
 * -------------------------------------------------------------------------*/

const SCENARIO_SUMMARIES: readonly Scenario[] = SCENARIOS.map((s) => ({
  id: s.id,
  title: s.title,
  blurb: s.blurb,
}))

/** Knobs the user owns; a scenario must never restore over them. */
const TRANSPORT_KNOBS: readonly (keyof Knobs)[] = ['timeScale', 'paused']

/**
 * Test seam. The internal context is not part of the application's contract —
 * nothing outside src/sim may use it — but tests need to reach the subsystems
 * directly to pin behaviour that would otherwise only be observable after
 * minutes of model time.
 */
const CONTEXTS = new WeakMap<Sim, SimCtx>()
export function simContext(sim: Sim): SimCtx {
  const ctx = CONTEXTS.get(sim)
  if (!ctx) throw new Error('simContext: not a Sim from createSim()')
  return ctx
}

export function createSim(seed = 0x5eed1234): Sim {
  const state = createState()
  const ctx: SimCtx = {
    s: state,
    rng: new Rng(seed),
    store: createStore(CONTROLLER_IDS.slice()),
  }

  /* The apply catalogue: a pristine copy of the seed cluster. This model has no
   * general `apply -f` — it does not run arbitrary specs — so `apply` can only
   * (re)create the objects it was built to simulate. Snapshotting the seed here
   * means apply and the initial bootstrap are the exact same definitions. */
  const catalogue = createState()

  const watcher = (c: SimCtx, kind: Parameters<typeof controllerWatch>[1], ns: string, name: string): void => {
    controllerWatch(c, kind, ns, name)
    schedulerWatch(c, kind)
  }

  function bootstrap(): void {
    installSpecs(ctx)
    ctx.store.watchers.length = 0
    ctx.store.watchers.push(watcher)
    /* Prime every workqueue: this stands in for the initial informer LIST that
     * every controller does before it starts watching. */
    for (const d of ctx.s.deployments) enqueueKey(ctx, 'deployment', key(d.namespace, d.name))
    for (const s of ctx.s.statefulSets) enqueueKey(ctx, 'statefulset', key(s.namespace, s.name))
    for (const d of ctx.s.daemonSets) enqueueKey(ctx, 'daemonset', key(d.namespace, d.name))
    for (const j of ctx.s.jobs) enqueueKey(ctx, 'job', key(j.namespace, j.name))
    for (const s of ctx.s.services) enqueueKey(ctx, 'endpointslice', key(s.namespace, s.name))
    for (const p of ctx.s.pvcs) enqueueKey(ctx, 'pv-binder', key(p.namespace, p.name))
    for (const h of ctx.s.hpas) enqueueKey(ctx, 'hpa', key(h.namespace, h.name))
    for (const n of ctx.s.nodes) enqueueKey(ctx, 'node', n.name)
    for (const n of ctx.store.namespaces) enqueueKey(ctx, 'namespace', n)
    enqueueKey(ctx, 'cronjob', 'shop/report')
    enqueueKey(ctx, 'garbage-collector', 'cluster')
  }

  bootstrap()

  const sim: Sim = {
    state,
    activeScenario: null,
    scenarios: SCENARIO_SUMMARIES,

    tick(dtSeconds: number): void {
      const knobs = ctx.s.knobs
      if (knobs.paused) return
      let remaining = dtSeconds * knobs.timeScale
      if (!(remaining > 0)) return
      if (remaining > MAX_STEP) remaining = MAX_STEP
      while (remaining > 1e-6) {
        const step = remaining > MAX_SUBSTEP ? MAX_SUBSTEP : remaining
        stepOnce(ctx, step)
        remaining -= step
      }
      const active = sim.activeScenario
      if (active) {
        const def = SCENARIOS.find((s) => s.id === active)
        def?.step?.(ctx, dtSeconds * knobs.timeScale)
      }
    },

    setKnob<K extends keyof Knobs>(k: K, value: Knobs[K]): void {
      const knobs = ctx.s.knobs
      if (knobs[k] === value) return
      knobs[k] = value
      clampKnobs(knobs)
      applyKnob(ctx, k)
      bus.emit('knob', { key: k, value: knobs[k] })
      if (k === 'timeScale' || k === 'paused') {
        bus.emit('transport', { paused: knobs.paused, timeScale: knobs.timeScale })
      }
    },

    runScenario(id: string): void {
      const def = SCENARIOS.find((s) => s.id === id)
      if (!def) return
      if (sim.activeScenario) sim.stopScenario()
      const saved: Partial<Knobs> = {}
      const live = ctx.s.knobs as unknown as Record<string, unknown>
      for (const k in live) {
        if (TRANSPORT_KNOBS.indexOf(k as keyof Knobs) >= 0) continue
        ;(saved as unknown as Record<string, unknown>)[k] = live[k]
      }
      ctx.store.scenarioSaved = saved
      ctx.store.scenarioClock = 0
      ctx.store.scenarioStep = 0
      sim.activeScenario = id
      def.start(ctx)
      emit(ctx, 'Normal', 'ScenarioStarted', `scenario/${id}`, def.title)
      bus.emit('scenario', { id, running: true })
    },

    deleteObject(kind: string, namespace: string, name: string): boolean {
      return deleteClusterObject(ctx, kind, namespace, name)
    },

    applyObject(kind: string, name: string): ApplyResult {
      return applyClusterObject(ctx, catalogue, kind, name)
    },

    applyCatalogue(): { kind: string; name: string }[] {
      return applyCatalogueOf(catalogue)
    },

    stopScenario(): void {
      const id = sim.activeScenario
      if (!id) return
      const def = SCENARIOS.find((s) => s.id === id)
      sim.activeScenario = null
      def?.stop(ctx)
      const saved = ctx.store.scenarioSaved as unknown as Record<string, unknown> | null
      if (saved) {
        const live = ctx.s.knobs as unknown as Record<string, unknown>
        for (const k in saved) live[k] = saved[k]
        clampKnobs(ctx.s.knobs)
        applyAllKnobs(ctx)
      }
      ctx.store.scenarioSaved = null
      emit(ctx, 'Normal', 'ScenarioStopped', `scenario/${id}`, 'scenario reverted')
      bus.emit('scenario', { id, running: false })
    },

    reset(): void {
      sim.activeScenario = null
      /* Rebuild in place: everything downstream holds a reference to `state`. */
      const fresh = createState()
      Object.assign(state, fresh)
      ctx.store = createStore(CONTROLLER_IDS.slice())
      ctx.rng.reset(seed)
      bootstrap()
    },
  }

  CONTEXTS.set(sim, ctx)
  return sim
}

/* ---------------------------------------------------------------------------
 * Knob application. A knob is a `kubectl edit`, so it goes through the API.
 * -------------------------------------------------------------------------*/

function applyKnob(ctx: SimCtx, k: keyof Knobs): void {
  const knobs = ctx.s.knobs
  switch (k) {
    case 'replicas': {
      const d = ctx.s.deployments.find((x) => x.namespace === 'shop' && x.name === 'web')
      if (!d || d.replicas === knobs.replicas) return
      const want = knobs.replicas
      submit(ctx, {
        verb: 'patch',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'web',
        subject: SUBJECTS.admin,
        commit: (c) => {
          const dep = c.s.deployments.find((x) => x.namespace === 'shop' && x.name === 'web')
          if (dep) dep.replicas = want
          enqueueKey(c, 'deployment', 'shop/web')
        },
      })
      return
    }
    case 'maxSurge':
    case 'maxUnavailable': {
      const d = ctx.s.deployments.find((x) => x.namespace === 'shop' && x.name === 'web')
      if (!d) return
      d.maxSurge = knobs.maxSurge
      d.maxUnavailable = knobs.maxUnavailable
      enqueueKey(ctx, 'deployment', 'shop/web')
      return
    }
    case 'requestCpuMilli':
    case 'limitCpuMilli':
    case 'requestMemMib':
    case 'limitMemMib':
      /* Editing resources edits the pod template, and a template change is a
       * new revision. A real cluster starts a rolling update here too. */
      enqueueKey(ctx, 'deployment', 'shop/web')
      return
    case 'hpaEnabled':
    case 'hpaTargetUtilization':
    case 'hpaMinReplicas':
    case 'hpaMaxReplicas':
      enqueueKey(ctx, 'hpa', 'shop/web')
      return
    default:
      return
  }
}

function applyAllKnobs(ctx: SimCtx): void {
  applyKnob(ctx, 'replicas')
  applyKnob(ctx, 'maxSurge')
  applyKnob(ctx, 'requestCpuMilli')
  applyKnob(ctx, 'hpaEnabled')
}
