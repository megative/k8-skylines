import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { materialCount } from '../core/theme'
import { DEFAULT_KNOBS, N_NODES } from '../core/types'
import type {
  ControllerId,
  ControllerState,
  CsiOperation,
  PvState,
  PvcState,
  SimState,
  StorageClassState,
} from '../core/types'
import { Rng } from '../core/util'
import { CITY } from './layout'
import { createStorage } from './storage'
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

/** The smallest SimState that the storage district reads from. */
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
  return {
    scene: new THREE.Scene(),
    registry: new Registry(),
    bus: new Bus(),
    rng: new Rng(1),
  }
}

const sc = (over: Partial<StorageClassState>): StorageClassState => ({
  name: 'standard',
  provisioner: 'ebs.csi.aws.com',
  bindingMode: 'Immediate',
  reclaimPolicy: 'Delete',
  allowExpansion: true,
  ...over,
})

const pvc = (over: Partial<PvcState>): PvcState => ({
  name: 'data-web-0',
  namespace: 'shop',
  phase: 'Pending',
  requestGib: 10,
  storageClass: 'standard',
  waitingForConsumer: false,
  ...over,
})

const pv = (over: Partial<PvState>): PvState => ({
  name: 'pvc-0001',
  phase: 'Available',
  capacityGib: 10,
  storageClass: 'standard',
  accessMode: 'ReadWriteOnce',
  ...over,
})

const op = (over: Partial<CsiOperation>): CsiOperation => ({
  id: 'csi-1',
  op: 'attach',
  pv: 'pvc-0001',
  progress: 0.5,
  failed: false,
  ...over,
})

function run(m: { update(s: SimState, dt: number): void }, s: SimState, frames = 40): void {
  for (let i = 0; i < frames; i++) {
    s.t += 1 / 60
    m.update(s, 1 / 60)
  }
}

function find(g: THREE.Object3D, name: string): THREE.Object3D {
  const o = g.getObjectByName(name)
  if (!o) throw new Error(`missing object ${name}`)
  return o
}

describe('storage district', () => {
  it('registers every mechanism it draws', () => {
    const ctx = makeCtx()
    createStorage(ctx)
    const ids = ctx.registry.district('storage').map((e) => e.id)
    for (const id of [
      'storage.plant',
      'storage.storageclass',
      'storage.dynamic-provisioning',
      'storage.pvc',
      'storage.pv',
      'storage.binding',
      'storage.wait-for-first-consumer',
      'storage.access-modes',
      'storage.csi',
      'storage.csi.attach',
      'storage.csi.mount',
      'storage.reclaim-policy',
    ]) {
      expect(ids).toContain(id)
    }
    /* Every entry must disclose what it simplifies. */
    for (const e of ctx.registry.district('storage')) {
      expect(e.caveats?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('couples a Bound claim to its volume and leaves a Pending one unbound', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({})]
    s.pvs = [pv({ name: 'pvc-0001', phase: 'Bound', boundClaim: 'shop/data-web-0' })]
    s.pvcs = [
      pvc({ name: 'data-web-0', phase: 'Bound', boundPv: 'pvc-0001' }),
      pvc({ name: 'data-web-1', phase: 'Pending' }),
    ]
    run(m, s)

    expect(find(m.group, 'pvc-coupling-0').visible).toBe(true)
    expect(find(m.group, 'pvc-coupling-1').visible).toBe(false)

    /* The bound ticket travels to its tank; the pending one stays in the bay. */
    const bound = find(m.group, 'pvc-ticket-0')
    const tank = find(m.group, 'pv-tank-0')
    expect(Math.abs(bound.position.x - tank.position.x)).toBeLessThan(2)
    const pending = find(m.group, 'pvc-ticket-1')
    expect(Math.abs(pending.position.z - tank.position.z)).toBeGreaterThan(30)
  })

  it('holds the WaitForFirstConsumer barrier down until a consumer is scheduled', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({ name: 'gp3', bindingMode: 'WaitForFirstConsumer' })]
    s.pvcs = [pvc({ storageClass: 'gp3', phase: 'Pending', waitingForConsumer: true })]
    run(m, s, 90)

    const barrier = find(m.group, 'sc-barrier-0')
    expect(Math.abs(barrier.rotation.x)).toBeLessThan(0.05)
    /* Nothing may be provisioned behind a closed barrier. */
    expect(find(m.group, 'sc-shuttle-0').visible).toBe(false)

    /* The scheduler picks a node: the claim stops waiting and provisioning runs. */
    s.pvcs[0].waitingForConsumer = false
    s.pvs = [pv({ storageClass: 'gp3' })]
    s.csiOps = [op({ op: 'provision', progress: 0.3 })]
    run(m, s, 90)
    expect(Math.abs(barrier.rotation.x)).toBeGreaterThan(1)
    expect(find(m.group, 'sc-shuttle-0').visible).toBe(true)
  })

  it('refuses a second node on a ReadWriteOnce volume', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({})]
    s.pvs = [pv({ phase: 'Bound', attachedNode: 'node-0', accessMode: 'ReadWriteOnce' })]
    s.csiOps = [op({ op: 'attach', nodeName: 'node-1', progress: 0.4 })]
    run(m, s)
    expect(find(m.group, 'pv-refused-0').visible).toBe(true)

    /* ReadWriteMany has no such conflict. */
    s.pvs[0].accessMode = 'ReadWriteMany'
    run(m, s)
    expect(find(m.group, 'pv-refused-0').visible).toBe(false)
  })

  it('shows one socket for ReadWriteOnce and three for ReadWriteMany', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({})]
    s.pvs = [pv({ accessMode: 'ReadWriteOnce' })]
    run(m, s, 2)
    let open = 0
    for (let k = 0; k < 3; k++) if (find(m.group, `pv-socket-0-${k}`).visible) open++
    expect(open).toBe(1)

    s.pvs[0].accessMode = 'ReadWriteMany'
    run(m, s, 2)
    open = 0
    for (let k = 0; k < 3; k++) if (find(m.group, `pv-socket-0-${k}`).visible) open++
    expect(open).toBe(3)
  })

  it('sends a Delete-policy volume to the crusher and a Retain one to the siding', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({ name: 'del', reclaimPolicy: 'Delete' }), sc({ name: 'keep', reclaimPolicy: 'Retain' })]
    s.pvs = [
      pv({ name: 'pvc-0001', storageClass: 'del', phase: 'Released' }),
      pv({ name: 'pvc-0002', storageClass: 'keep', phase: 'Released' }),
    ]
    run(m, s, 240)
    expect(find(m.group, 'pv-tank-0').position.x).toBeGreaterThan(20)
    expect(find(m.group, 'pv-tank-1').position.x).toBeLessThan(-20)
    /* Only the Delete line owns a crusher; the Retain line owns a siding. */
    expect(find(m.group, 'sc-crusher-0').visible).toBe(true)
    expect(find(m.group, 'sc-siding-0').visible).toBe(false)
    expect(find(m.group, 'sc-crusher-1').visible).toBe(false)
    expect(find(m.group, 'sc-siding-1').visible).toBe(true)
  })

  it('keeps its working level above grade and inside the footprint layout gave it', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({}), sc({ name: 'gp3' })]
    s.pvs = [pv({}), pv({ name: 'pvc-0002', capacityGib: 4 })]
    s.pvcs = [pvc({}), pvc({ name: 'data-web-1' })]
    run(m, s, 30)
    m.group.updateMatrixWorld(true)

    const p = new THREE.Vector3()
    const names = ['sc-line-0', 'sc-line-1', 'pv-tank-0', 'pv-tank-1', 'pvc-ticket-0', 'pvc-ticket-1']
    for (const n of names) {
      find(m.group, n).getWorldPosition(p)
      expect(Math.abs(p.x - CITY.storage.x)).toBeLessThanOrEqual(CITY.storage.w / 2)
      expect(Math.abs(p.z - CITY.storage.z)).toBeLessThanOrEqual(CITY.storage.d / 2)
      /* The ground plane is only cut for the etcd pit, so anything below y = 0
       * here would be invisible. The plant's working level must stand at grade. */
      expect(p.y).toBeGreaterThanOrEqual(0)
    }
  })

  it('allocates no materials once running', () => {
    const ctx = makeCtx()
    const m = createStorage(ctx)
    const s = makeState()
    s.storageClasses = [sc({}), sc({ name: 'gp3', bindingMode: 'WaitForFirstConsumer', reclaimPolicy: 'Retain' })]
    s.pvs = [pv({ phase: 'Bound', attachedNode: 'node-0' }), pv({ name: 'pvc-0002' })]
    s.pvcs = [pvc({ phase: 'Bound', boundPv: 'pvc-0001' }), pvc({ name: 'data-web-1', waitingForConsumer: true })]
    s.csiOps = [op({ op: 'mount', nodeName: 'node-0' }), op({ id: 'csi-2', op: 'provision', pv: 'pvc-0002' })]
    run(m, s, 10)
    const before = materialCount()
    run(m, s, 120)
    expect(materialCount()).toBe(before)
  })
})
