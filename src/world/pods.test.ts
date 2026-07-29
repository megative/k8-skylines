import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { Rng } from '../core/util'
import { materialCount } from '../core/theme'
import {
  DEFAULT_KNOBS,
  N_NODES,
  NODE_CPU_MILLICORES,
  NODE_MEM_MIB,
  POD_SLOTS_PER_NODE,
} from '../core/types'
import type {
  ContainerState,
  ControllerId,
  ControllerState,
  NodeState,
  PodState,
  SimState,
} from '../core/types'
import { CITY, podPlotPos } from './layout'
import { createPods } from './pods'
import type { WorldCtx } from './module'

/* A SimState is large; these builders keep the tests about pods, not fixtures. */

function makeContainer(over: Partial<ContainerState> = {}): ContainerState {
  return {
    name: 'app',
    image: 'ghcr.io/example/web:1.4.2',
    role: 'app',
    state: 'running',
    reason: 'Running',
    restartCount: 0,
    backoffRemaining: 0,
    backoffSeconds: 0,
    requestCpuMilli: 250,
    limitCpuMilli: 500,
    requestMemMib: 256,
    limitMemMib: 512,
    usedCpuMilli: 180,
    usedMemMib: 300,
    throttled: false,
    ready: true,
    livenessFailures: 0,
    readinessFailures: 0,
    startupDone: true,
    pullProgress: 1,
    ...over,
  }
}

function makePod(uid: string, over: Partial<PodState> = {}): PodState {
  return {
    uid,
    name: `web-7d9f4c8b6-${uid}`,
    namespace: 'shop',
    owner: { kind: 'ReplicaSet', name: 'web-7d9f4c8b6', uid: 'rs-1', controller: true },
    phase: 'Running',
    conditions: { PodScheduled: true, Initialized: true, ContainersReady: true, Ready: true },
    qos: 'Burstable',
    priority: 0,
    containers: [makeContainer()],
    labels: { app: 'web' },
    tolerations: [],
    volumeClaims: [],
    ageSeconds: 30,
    revision: 1,
    ...over,
  }
}

function makeNode(i: number): NodeState {
  return {
    name: `node-${i}`,
    index: i,
    present: true,
    conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', sinceSeconds: 100 }],
    taints: [],
    unschedulable: false,
    capacityCpuMilli: NODE_CPU_MILLICORES,
    capacityMemMib: NODE_MEM_MIB,
    capacityPods: POD_SLOTS_PER_NODE,
    allocatableCpuMilli: NODE_CPU_MILLICORES,
    allocatableMemMib: NODE_MEM_MIB,
    requestedCpuMilli: 0,
    requestedMemMib: 0,
    usedCpuMilli: 0,
    usedMemMib: 0,
    podUids: [],
    kubelet: { phase: 'idle', progress: 0, sinceLeaseSeconds: 1, plegHealthy: true, evicting: false },
    proxyRules: [],
    podCidr: `10.244.${i}.0/24`,
    imageCache: [],
  }
}

function makeState(pods: PodState[], desiredReplicas = pods.length): SimState {
  const controllers = {} as Record<ControllerId, ControllerState>
  const podMap = new Map<string, PodState>()
  const nodes: NodeState[] = []
  for (let i = 0; i < N_NODES; i++) nodes.push(makeNode(i))
  for (const p of pods) {
    podMap.set(p.uid, p)
    if (p.nodeName) nodes.find((n) => n.name === p.nodeName)?.podUids.push(p.uid)
  }
  return {
    t: 0,
    knobs: { ...DEFAULT_KNOBS },
    etcd: {
      members: [],
      revision: 1,
      compactedRevision: 0,
      log: [],
      hasQuorum: true,
      dbSizeMib: 1,
      dbQuotaMib: 2048,
      watchers: 1,
      writesPerSec: 0,
      readLatencyMs: 1,
      alarm: 'none',
    },
    api: {
      inflight: [],
      apfSeatsUsed: 0,
      apfSeatsTotal: 100,
      throttled: 0,
      webhooks: [],
      watchConnections: 1,
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
      latencyMs: 5,
      leading: true,
    },
    controllers,
    nodes,
    pods: podMap,
    deployments: [
      {
        name: 'web',
        namespace: 'shop',
        replicas: desiredReplicas,
        maxSurge: 1,
        maxUnavailable: 0,
        revision: 1,
        replicaSets: ['web-7d9f4c8b6'],
        statusReplicas: pods.length,
        readyReplicas: pods.length,
        availableReplicas: pods.length,
        updatedReplicas: pods.length,
        rollingOut: false,
        progressDeadlineExceeded: false,
        paused: false,
        selector: { app: 'web' },
      },
    ],
    replicaSets: [
      {
        name: 'web-7d9f4c8b6',
        namespace: 'shop',
        ownerDeployment: 'web',
        revision: 1,
        replicas: desiredReplicas,
        statusReplicas: pods.length,
        readyReplicas: pods.length,
        selector: { app: 'web' },
        podTemplateLabels: { app: 'web' },
        image: 'ghcr.io/example/web:1.4.2',
      },
    ],
    statefulSets: [],
    daemonSets: [],
    jobs: [],
    hpas: [],
    pdbs: [],
    services: [],
    ingresses: [],
    networkPolicies: [],
    dns: { readyReplicas: 2, queriesPerSec: 0, cacheHitRatio: 0.9, nxdomainRate: 0, latencyMs: 1 },
    storageClasses: [],
    pvcs: [],
    pvs: [],
    csiOps: [],
    events: [],
    totals: {
      podsRunning: pods.length,
      podsPending: 0,
      podsFailed: 0,
      podsTerminating: 0,
      nodesReady: N_NODES,
      cpuRequestedMilli: 0,
      cpuAllocatableMilli: NODE_CPU_MILLICORES * N_NODES,
      memRequestedMib: 0,
      memAllocatableMib: NODE_MEM_MIB * N_NODES,
      restarts: 0,
    },
  }
}

function makeCtx(): WorldCtx {
  return {
    scene: new THREE.Scene(),
    registry: new Registry(),
    bus: new Bus(),
    rng: new Rng(7),
  }
}

/** Depth-first search for a visible mesh whose world position is near `p`. */
function anyVisibleNear(root: THREE.Object3D, x: number, z: number, r: number): boolean {
  let hit = false
  root.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  root.traverseVisible((o) => {
    if (hit || !(o instanceof THREE.Mesh)) return
    o.getWorldPosition(v)
    if (Math.hypot(v.x - x, v.z - z) < r) hit = true
  })
  return hit
}

describe('pods district', () => {
  it('registers an explainer for every mechanism it draws', () => {
    const ctx = makeCtx()
    createPods(ctx)
    for (const id of [
      'pod',
      'pod.sandbox',
      'pod.netns',
      'pod.init',
      'pod.sidecar',
      'pod.container',
      'pod.imagepull',
      'pod.crashloop',
      'pod.oom',
      'pod.throttle',
      'pod.resources',
      'pod.qos',
      'pod.probes',
      'pod.conditions',
      'pod.owner',
      'pod.termination',
      'pod.pending',
      'pod.desired',
      'pod.revision',
    ]) {
      expect(ctx.registry.get(id), id).toBeDefined()
    }
  })

  it('stands a bound pod on its node plot and publishes the slot', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pod = makePod('p1', { nodeName: 'node-2', ip: '10.244.2.7' })
    const s = makeState([pod])
    for (let i = 0; i < 90; i++) mod.update(s, 1 / 60)

    expect(pod.slot).toBe(0)
    const want = podPlotPos(2, 0)
    expect(anyVisibleNear(mod.group, want.x, want.z, 6)).toBe(true)
  })

  it('parks a pod with no nodeName away from every node block', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pod = makePod('p1', {
      phase: 'Pending',
      conditions: { PodScheduled: false, Initialized: false, ContainersReady: false, Ready: false },
      containers: [makeContainer({ state: 'waiting', reason: 'ContainerCreating', ready: false })],
    })
    const s = makeState([pod])
    for (let i = 0; i < 60; i++) mod.update(s, 1 / 60)

    expect(pod.slot).toBeUndefined()
    /* Nothing of it may appear on any pod plot of any node. */
    const p = new THREE.Vector3()
    for (let n = 0; n < N_NODES; n++) {
      for (let slot = 0; slot < POD_SLOTS_PER_NODE; slot++) {
        podPlotPos(n, slot, p)
        expect(anyVisibleNear(mod.group, p.x, p.z, 10)).toBe(false)
      }
    }
    /* But it must be somewhere visible, north of the node blocks. */
    let minZ = Infinity
    mod.group.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    mod.group.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.getWorldPosition(v)
      if (v.z < minZ) minZ = v.z
    })
    expect(minZ).toBeLessThan(CITY.node.z - CITY.node.d / 2)
  })

  it('lights a desired ghost the instant a pod is deleted, before a replacement exists', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pods = [makePod('p1', { nodeName: 'node-0', ip: '10.244.0.5' })]
    const s = makeState(pods, 1)
    for (let i = 0; i < 60; i++) mod.update(s, 1 / 60)
    const before = countGhosts(mod.group)

    /* kubectl delete pod: the object stays, with a grace period. */
    pods[0].deletionGraceSeconds = 30
    mod.update(s, 1 / 60)

    expect(before).toBe(0)
    expect(countGhosts(mod.group)).toBe(1)
  })

  it('keeps the ghost lit while the doomed building is still draining', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pod = makePod('p1', { nodeName: 'node-0', ip: '10.244.0.5', deletionGraceSeconds: 20 })
    const s = makeState([pod], 1)
    for (let i = 0; i < 30; i++) mod.update(s, 1 / 60)

    const want = podPlotPos(0, 0)
    expect(anyVisibleNear(mod.group, want.x, want.z, 6)).toBe(true)
    expect(countGhosts(mod.group)).toBe(1)
  })

  it('collapses and frees the lot when the pod object disappears', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pod = makePod('p1', { nodeName: 'node-1', ip: '10.244.1.9' })
    const s = makeState([pod])
    for (let i = 0; i < 60; i++) mod.update(s, 1 / 60)
    const want = podPlotPos(1, 0)
    expect(anyVisibleNear(mod.group, want.x, want.z, 6)).toBe(true)

    s.pods.delete('p1')
    for (let i = 0; i < 90; i++) mod.update(s, 1 / 60)
    expect(anyVisibleNear(mod.group, want.x, want.z, 6)).toBe(false)

    /* The freed lot must be reusable by the replacement pod. */
    const next = makePod('p2', { nodeName: 'node-1', ip: '10.244.1.10' })
    s.pods.set('p2', next)
    for (let i = 0; i < 60; i++) mod.update(s, 1 / 60)
    expect(next.slot).toBe(0)
    expect(anyVisibleNear(mod.group, want.x, want.z, 6)).toBe(true)
  })

  it('allocates no materials while running, whatever the pods are doing', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pods = [
      makePod('p1', {
        nodeName: 'node-0',
        ip: '10.244.0.2',
        containers: [
          makeContainer({ role: 'init', state: 'terminated', reason: 'Completed', ready: false }),
          makeContainer(),
          makeContainer({ role: 'sidecar', name: 'proxy' }),
        ],
      }),
      makePod('p2', {
        nodeName: 'node-1',
        ip: '10.244.1.2',
        qos: 'BestEffort',
        containers: [
          makeContainer({
            state: 'waiting',
            reason: 'CrashLoopBackOff',
            restartCount: 5,
            backoffRemaining: 12,
            backoffSeconds: 160,
            ready: false,
          }),
        ],
      }),
      makePod('p3', {
        nodeName: 'node-2',
        ip: '10.244.2.2',
        qos: 'Guaranteed',
        containers: [makeContainer({ throttled: true, usedCpuMilli: 500, readinessFailures: 2, ready: false })],
      }),
      makePod('p4', { phase: 'Pending', containers: [makeContainer({ state: 'waiting', reason: 'ErrImagePull' })] }),
    ]
    const s = makeState(pods, 8)
    for (let i = 0; i < 20; i++) mod.update(s, 1 / 60)

    const baseline = materialCount()
    for (let i = 0; i < 400; i++) {
      /* Move the numbers around so every branch of the update is exercised. */
      pods[1].containers[0].backoffRemaining = (i % 160) + 1
      pods[2].containers[0].usedMemMib = 100 + (i % 400)
      pods[0].containers[1].reason = i % 2 === 0 ? 'Running' : 'OOMKilled'
      mod.update(s, 1 / 60)
    }
    expect(materialCount()).toBe(baseline)
  })

  it('draws no app container while an init container is still running', () => {
    const ctx = makeCtx()
    const mod = createPods(ctx)
    const pod = makePod('p1', {
      nodeName: 'node-0',
      ip: '10.244.0.3',
      conditions: { PodScheduled: true, Initialized: false, ContainersReady: false, Ready: false },
      containers: [
        makeContainer({ role: 'init', name: 'wait-for-db', state: 'running', ready: false }),
        makeContainer({ state: 'waiting', reason: 'PodInitializing', ready: false, usedMemMib: 0 }),
      ],
    })
    const s = makeState([pod])
    for (let i = 0; i < 120; i++) mod.update(s, 1 / 60)

    let solidTowers = 0
    mod.group.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.explainerId !== 'pod.container') return
      const m = o.material as THREE.Material
      /* Holograms are transparent; matter is not. Only matter counts. */
      if (!m.transparent && o.scale.y > 1) solidTowers++
    })
    /* The init container's own structure is bound to pod.init, so the only
     * thing that could be standing here is the app container — and it must not
     * be, because the runtime has not been asked to create it yet. */
    expect(solidTowers).toBe(0)
  })
})

function countGhosts(root: THREE.Object3D): number {
  let n = 0
  for (const child of root.children) {
    if (child instanceof THREE.Group && child.visible && child.userData.explainerId === 'pod.desired') n++
  }
  return n
}
