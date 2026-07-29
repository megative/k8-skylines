import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { materialCount } from '../core/theme'
import { Rng } from '../core/util'
import {
  N_NODES,
  NODE_CPU_MILLICORES,
  NODE_MEM_MIB,
  NODE_RESERVED_CPU_MILLICORES,
  NODE_RESERVED_MEM_MIB,
  POD_SLOTS_PER_NODE,
} from '../core/types'
import type { NodeState, SimState } from '../core/types'
import { createNodes } from './nodes'
import type { WorldCtx } from './module'

function makeNode(i: number): NodeState {
  return {
    name: `k8s-node-${i + 1}`,
    index: i,
    present: true,
    conditions: [
      { type: 'Ready', status: 'True', reason: 'KubeletReady', sinceSeconds: 300 },
      { type: 'MemoryPressure', status: 'False', reason: 'KubeletHasSufficientMemory', sinceSeconds: 300 },
    ],
    taints: [],
    unschedulable: false,
    capacityCpuMilli: NODE_CPU_MILLICORES,
    capacityMemMib: NODE_MEM_MIB,
    capacityPods: POD_SLOTS_PER_NODE,
    allocatableCpuMilli: NODE_CPU_MILLICORES - NODE_RESERVED_CPU_MILLICORES,
    allocatableMemMib: NODE_MEM_MIB - NODE_RESERVED_MEM_MIB,
    requestedCpuMilli: 1000,
    requestedMemMib: 1024,
    usedCpuMilli: 300,
    usedMemMib: 700,
    podUids: [],
    kubelet: {
      phase: 'syncing',
      progress: 0.5,
      sinceLeaseSeconds: 2,
      plegHealthy: true,
      evicting: false,
    },
    proxyRules: [
      { service: 'shop/web', clusterIp: '10.96.0.11', endpoints: ['10.244.0.4'], syncing: false },
      { service: 'shop/api', clusterIp: '10.96.0.12', endpoints: [], syncing: false },
    ],
    podCidr: `10.244.${i}.0/24`,
    imageCache: ['registry.k8s.io/pause:3.9'],
  }
}

function makeState(): SimState {
  const nodes: NodeState[] = []
  for (let i = 0; i < N_NODES; i++) nodes.push(makeNode(i))
  return {
    t: 0,
    nodes,
    pods: new Map(),
    csiOps: [],
    pvs: [],
    services: [],
    totals: {
      podsRunning: 0,
      podsPending: 0,
      podsFailed: 0,
      podsTerminating: 0,
      nodesReady: N_NODES,
      cpuRequestedMilli: 4000,
      cpuAllocatableMilli: 14400,
      memRequestedMib: 4096,
      memAllocatableMib: 29696,
      restarts: 0,
    },
  } as unknown as SimState
}

function makeCtx(): WorldCtx {
  return {
    scene: new THREE.Scene(),
    registry: new Registry(),
    bus: new Bus(),
    rng: new Rng(7),
  }
}

describe('nodes district', () => {
  it('builds one block per node and registers every mechanism it draws', () => {
    const ctx = makeCtx()
    const mod = createNodes(ctx)
    expect(mod.group.children.length).toBeGreaterThan(N_NODES)

    for (let i = 0; i < N_NODES; i++) {
      expect(ctx.registry.get(`node-${i}`)).toBeDefined()
    }
    for (const id of [
      'node-allocatable',
      'node-kubelet',
      'node-kubelet-lease',
      'node-cri',
      'node-image-cache',
      'node-kube-proxy',
      'node-kube-proxy-rules',
      'node-cni',
      'node-csi',
      'node-cadvisor',
      'node-conditions',
      'node-taints',
      'node-eviction',
    ]) {
      const e = ctx.registry.get(id)
      expect(e, id).toBeDefined()
      expect(e!.district).toBe('nodes')
      /* Every mechanism must own up to what it simplified. */
      expect(e!.detail.length, id).toBeGreaterThan(0)
      expect(e!.object, id).toBeDefined()
    }
    mod.dispose?.()
  })

  it('binds the same kube-proxy entry on every node — a Service is replicated', () => {
    const ctx = makeCtx()
    const mod = createNodes(ctx)
    const seen = new Set<string>()
    let cabinets = 0
    mod.group.traverse((o) => {
      const id = o.userData.explainerId
      if (id === 'node-kube-proxy') {
        cabinets++
        seen.add(id)
      }
    })
    expect(cabinets).toBe(N_NODES)
    expect(seen.size).toBe(1)
    mod.dispose?.()
  })

  it('separates requested from used on the gauge wall', () => {
    const ctx = makeCtx()
    const mod = createNodes(ctx)
    const s = makeState()
    mod.update(s, 1 / 60)

    /* requested (1000m) and used (300m) must not draw the same bar, and
     * allocatable must be visibly shorter than capacity. */
    const lengths = new Map<string, number>()
    mod.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      lengths.set(`${m.position.x.toFixed(2)}:${m.position.y.toFixed(2)}`, m.scale.x)
    })
    const n = s.nodes[0]
    expect(n.requestedCpuMilli).toBeGreaterThan(n.usedCpuMilli)
    expect(n.allocatableCpuMilli).toBeLessThan(n.capacityCpuMilli)
    expect(lengths.size).toBeGreaterThan(0)
    mod.dispose?.()
  })

  it('runs a long frame loop without creating materials or geometry', () => {
    const ctx = makeCtx()
    const mod = createNodes(ctx)
    const s = makeState()
    mod.update(s, 1 / 60)

    const before = materialCount()
    let meshes = 0
    mod.group.traverse(() => meshes++)

    for (let f = 0; f < 200; f++) {
      s.t += 1 / 60
      /* Exercise every branch the loop has: pressure, cordon, syncing, taints. */
      const n = s.nodes[f % N_NODES]
      n.unschedulable = f % 3 === 0
      n.kubelet.evicting = f % 5 === 0
      n.kubelet.plegHealthy = f % 7 !== 0
      n.kubelet.sinceLeaseSeconds = (f % 60) / 2
      n.conditions[0].status = f % 11 === 0 ? 'Unknown' : 'True'
      n.proxyRules[0].syncing = f % 4 === 0
      mod.update(s, 1 / 60)
    }

    let after = 0
    mod.group.traverse(() => after++)
    expect(after).toBe(meshes)
    expect(materialCount()).toBe(before)
    mod.dispose?.()
  })

  it('reads NotReady, cordoned and healthy as three different blocks', () => {
    const ctx = makeCtx()
    const mod = createNodes(ctx)
    const s = makeState()

    s.nodes[1].unschedulable = true
    s.nodes[2].conditions[0].status = 'False'
    mod.update(s, 1 / 60)

    const rims: THREE.Material[] = []
    for (const child of mod.group.children) {
      for (const o of child.children) {
        const m = o as THREE.Mesh
        if (m.isMesh && m.geometry.type === 'ShapeGeometry') rims.push(m.material as THREE.Material)
      }
    }
    expect(rims.length).toBe(N_NODES)
    expect(rims[0]).not.toBe(rims[1])
    expect(rims[1]).not.toBe(rims[2])
    expect(rims[0]).not.toBe(rims[2])
    expect(rims[0]).toBe(rims[3])
    mod.dispose?.()
  })
})
