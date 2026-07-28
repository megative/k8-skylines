import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { COLOR, materialCount, neon } from '../core/theme'
import { DEFAULT_KNOBS, N_NODES } from '../core/types'
import type {
  ContainerReason,
  ContainerState,
  ControllerId,
  ControllerState,
  PodState,
  SimState,
} from '../core/types'
import { Rng } from '../core/util'
import { createRegistryYard } from './registry-yard'
import type { WorldCtx } from './module'

const CONTROLLERS: ControllerId[] = [
  'deployment',
  'replicaset',
  'statefulset',
  'daemonset',
  'job',
  'cronjob',
  'node',
  'endpointslice',
  'pv-binder',
  'garbage-collector',
  'hpa',
  'serviceaccount',
  'namespace',
]

function controllerMap(): Record<ControllerId, ControllerState> {
  const out = {} as Record<ControllerId, ControllerState>
  for (const id of CONTROLLERS) {
    out[id] = {
      id,
      name: id,
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

function makeState(): SimState {
  const nodes = []
  for (let i = 0; i < N_NODES; i++) {
    nodes.push({
      name: `node-${i}`,
      index: i,
      conditions: [],
      taints: [],
      unschedulable: false,
      capacityCpuMilli: 4000,
      capacityMemMib: 8192,
      capacityPods: 12,
      allocatableCpuMilli: 3600,
      allocatableMemMib: 7424,
      requestedCpuMilli: 0,
      requestedMemMib: 0,
      usedCpuMilli: 0,
      usedMemMib: 0,
      podUids: [],
      kubelet: {
        phase: 'idle' as const,
        progress: 0,
        sinceLeaseSeconds: 0,
        plegHealthy: true,
        evicting: false,
      },
      proxyRules: [],
      podCidr: `10.244.${i}.0/24`,
      imageCache: [] as string[],
    })
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
      apfSeatsTotal: 8,
      throttled: 0,
      webhooks: [],
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
      latencyMs: 1,
      leading: true,
    },
    controllers: controllerMap(),
    nodes,
    pods: new Map(),
    deployments: [],
    replicaSets: [],
    statefulSets: [],
    daemonSets: [],
    jobs: [],
    hpas: [],
    pdbs: [],
    services: [],
    ingresses: [],
    networkPolicies: [],
    dns: { readyReplicas: 2, queriesPerSec: 0, cacheHitRatio: 0.8, nxdomainRate: 0, latencyMs: 2 },
    storageClasses: [],
    pvcs: [],
    pvs: [],
    csiOps: [],
    events: [],
    totals: {
      podsRunning: 0,
      podsPending: 0,
      podsFailed: 0,
      podsTerminating: 0,
      nodesReady: N_NODES,
      cpuRequestedMilli: 0,
      cpuAllocatableMilli: 0,
      memRequestedMib: 0,
      memAllocatableMib: 0,
      restarts: 0,
    },
  }
}

function makeCtx(): WorldCtx {
  return { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(2) }
}

function container(image: string, reason: ContainerReason, pullProgress: number): ContainerState {
  return {
    name: 'web',
    image,
    role: 'app',
    state: 'waiting',
    reason,
    restartCount: 0,
    backoffRemaining: 0,
    backoffSeconds: 0,
    requestCpuMilli: 250,
    limitCpuMilli: 500,
    requestMemMib: 256,
    limitMemMib: 512,
    usedCpuMilli: 0,
    usedMemMib: 0,
    throttled: false,
    ready: false,
    livenessFailures: 0,
    readinessFailures: 0,
    startupDone: false,
    pullProgress,
  }
}

function pod(uid: string, nodeName: string, c: ContainerState): PodState {
  return {
    uid,
    name: uid,
    namespace: 'shop',
    phase: 'Pending',
    conditions: { PodScheduled: true, Initialized: false, ContainersReady: false, Ready: false },
    nodeName,
    qos: 'Burstable',
    priority: 0,
    containers: [c],
    labels: { app: 'web' },
    tolerations: [],
    volumeClaims: [],
    ageSeconds: 3,
  }
}

function run(m: { update(s: SimState, dt: number): void }, s: SimState, frames = 5): void {
  for (let i = 0; i < frames; i++) {
    s.t += 1 / 60
    m.update(s, 1 / 60)
  }
}

function crates(g: THREE.Object3D, convoy: number): number {
  let n = 0
  for (let k = 0; k < 4; k++) {
    const c = g.getObjectByName(`pull-crate-${convoy}-${k}`)
    if (c && c.visible) n++
  }
  return n
}

const IMG_A = 'registry.k8s.io/shop/web:1.7.3'
const IMG_A2 = 'registry.k8s.io/shop/web:1.8.0'

describe('image registry yard', () => {
  it('registers every mechanism it draws', () => {
    const ctx = makeCtx()
    createRegistryYard(ctx)
    const ids = ctx.registry.district('registry').map((e) => e.id)
    for (const id of [
      'registry.yard',
      'registry.image',
      'registry.layers',
      'registry.pull',
      'registry.content-store',
      'registry.image-pull-backoff',
    ]) {
      expect(ids).toContain(id)
    }
    for (const e of ctx.registry.district('registry')) {
      expect(e.caveats?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('carries every layer to a cold node', () => {
    const ctx = makeCtx()
    const m = createRegistryYard(ctx)
    const s = makeState()
    s.pods.set('p1', pod('p1', 'node-0', container(IMG_A, 'ContainerCreating', 0.4)))
    run(m, s)
    const convoy = m.group.getObjectByName('pull-convoy-0')!
    expect(convoy.visible).toBe(true)
    expect(crates(m.group, 0)).toBe(4)
  })

  it('transfers only the layers the node is missing', () => {
    const ctx = makeCtx()
    const m = createRegistryYard(ctx)
    const s = makeState()
    /* node-0 already holds the previous tag of the same repository, so its base
     * and runtime layers are already in the content store. */
    s.nodes[0].imageCache = [IMG_A]
    s.pods.set('p1', pod('p1', 'node-0', container(IMG_A2, 'ContainerCreating', 0.4)))
    run(m, s)
    const moved = crates(m.group, 0)
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThanOrEqual(2)
  })

  it('sends no convoy at all for an image the node already has', () => {
    const ctx = makeCtx()
    const m = createRegistryYard(ctx)
    const s = makeState()
    s.nodes[1].imageCache = [IMG_A]
    s.pods.set('p1', pod('p1', 'node-1', container(IMG_A, 'ContainerCreating', 1)))
    run(m, s)
    expect(m.group.getObjectByName('pull-convoy-0')!.visible).toBe(false)
  })

  it('halts a convoy in ImagePullBackOff and reddens a failed attempt', () => {
    const ctx = makeCtx()
    const m = createRegistryYard(ctx)
    const s = makeState()
    s.knobs.imagePullFailure = true
    s.pods.set('p1', pod('p1', 'node-0', container(IMG_A, 'ImagePullBackOff', 0.25)))
    run(m, s)
    const convoy = m.group.getObjectByName('pull-convoy-0') as THREE.Group
    const bed = convoy.children[0] as THREE.Mesh
    expect(bed.material).toBe(neon(COLOR.backoff, 1.8))

    /* ErrImagePull is the attempt that failed, not the wait after it. */
    s.pods.get('p1')!.containers[0].reason = 'ErrImagePull'
    run(m, s, 1)
    expect(bed.material).not.toBe(neon(COLOR.backoff, 1.8))
  })

  it('allocates no materials once running', () => {
    const ctx = makeCtx()
    const m = createRegistryYard(ctx)
    const s = makeState()
    s.nodes[0].imageCache = [IMG_A]
    s.pods.set('p1', pod('p1', 'node-0', container(IMG_A2, 'ContainerCreating', 0.2)))
    s.pods.set('p2', pod('p2', 'node-2', container(IMG_A, 'ImagePullBackOff', 0.1)))
    run(m, s, 10)
    const before = materialCount()
    run(m, s, 120)
    expect(materialCount()).toBe(before)
  })
})
