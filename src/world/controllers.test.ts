import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { Rng } from '../core/util'
import { materialCount } from '../core/theme'
import { CONTROLLER_ORDER } from './layout'
import type { ControllerId, ControllerState, SimState } from '../core/types'
import { createControllers } from './controllers'

function controller(id: ControllerId, over: Partial<ControllerState> = {}): ControllerState {
  return {
    id,
    name: id,
    queueDepth: 0,
    phase: 'idle',
    progress: 0,
    cached: 8,
    reconciles: 0,
    errors: 0,
    backoffSeconds: 0,
    leading: true,
    ...over,
  }
}

/** The smallest state this district reads. Everything else is left empty. */
function state(over: Partial<SimState> = {}): SimState {
  const controllers = {} as Record<ControllerId, ControllerState>
  for (const id of CONTROLLER_ORDER) controllers[id] = controller(id)
  return {
    t: 0,
    controllers,
    deployments: [],
    replicaSets: [],
    statefulSets: [],
    daemonSets: [],
    jobs: [],
    hpas: [],
    services: [],
    pvcs: [],
    nodes: [],
    pods: new Map(),
    ...over,
  } as unknown as SimState
}

function ctx() {
  return {
    scene: new THREE.Scene(),
    registry: new Registry(),
    bus: new Bus(),
    rng: new Rng(7),
  }
}

/** Snapshot of every instanced transform in the district. */
function matrices(group: THREE.Object3D): number[] {
  const out: number[] = []
  group.traverse((o) => {
    const im = o as THREE.InstancedMesh
    if (im.isInstancedMesh) for (const v of im.instanceMatrix.array) out.push(v)
  })
  return out
}

describe('controller yard', () => {
  it('registers one explainer per loop plus the shared mechanisms', () => {
    const c = ctx()
    createControllers(c)
    for (const id of CONTROLLER_ORDER) {
      const e = c.registry.get(`controllers.${id}`)
      expect(e, id).toBeDefined()
      expect(e!.detail.length).toBeGreaterThan(1)
      expect(e!.caveats?.length ?? 0).toBeGreaterThan(0)
    }
    for (const id of [
      'controllers.reconcile-loop',
      'controllers.desired-vs-actual',
      'controllers.informer',
      'controllers.workqueue',
      'controllers.rate-limiter',
      'controllers.leader-election',
      'controllers.write-back',
      'controllers.manager',
    ]) {
      expect(c.registry.get(id), id).toBeDefined()
    }
    expect(c.registry.district('controllers').length).toBe(CONTROLLER_ORDER.length + 8)
  })

  it('keeps turning while every loop is idle: level-triggered, not edge-triggered', () => {
    const c = ctx()
    const mod = createControllers(c)
    const s = state()
    mod.update(s, 0.016)
    const before = matrices(mod.group)
    for (let i = 0; i < 10; i++) {
      s.t += 0.1
      mod.update(s, 0.1)
    }
    const after = matrices(mod.group)
    expect(after).not.toEqual(before)
  })

  it('shows four ghosts against two solids during a scale-up, and the right write count', () => {
    const c = ctx()
    createControllers(c)
    const s = state({
      deployments: [
        { name: 'web', namespace: 'shop', replicas: 4, statusReplicas: 2, rollingOut: false },
      ],
      replicaSets: [
        { name: 'web-6f4b', namespace: 'shop', ownerDeployment: 'web', replicas: 4, statusReplicas: 2 },
      ],
    } as unknown as Partial<SimState>)

    const dep = c.registry.get('controllers.deployment')!.metrics!(s)
    const byLabel = (rows: { label: string; value: string }[], l: string) =>
      rows.find((r) => r.label === l)!.value
    expect(byLabel(dep, 'desired')).toBe('4')
    expect(byLabel(dep, 'actual')).toBe('2')
    /* One scale patch on one ReplicaSet — the Deployment controller makes no Pods. */
    expect(byLabel(dep, 'writes this pass')).toBe('1')

    const rs = c.registry.get('controllers.replicaset')!.metrics!(s)
    expect(byLabel(rs, 'desired')).toBe('4')
    expect(byLabel(rs, 'actual')).toBe('2')
    /* Two creates: this is the loop that actually makes Pods. */
    expect(byLabel(rs, 'writes this pass')).toBe('2')
  })

  it('freezes the whole yard when the lease is lost', () => {
    const c = ctx()
    const mod = createControllers(c)
    const s = state()
    for (const id of CONTROLLER_ORDER) {
      s.controllers[id].leading = false
      s.controllers[id].queueDepth = 5
      s.controllers[id].phase = 'diff'
      s.controllers[id].progress = 0.5
    }
    mod.update(s, 0.1)
    const before = matrices(mod.group)
    for (let i = 0; i < 5; i++) {
      s.t += 0.1
      mod.update(s, 0.1)
    }
    expect(matrices(mod.group)).toEqual(before)
  })

  it('allocates no materials across a run through every phase', () => {
    const c = ctx()
    const mod = createControllers(c)
    const s = state()
    mod.update(s, 0.016)
    const base = materialCount()
    const phases = ['idle', 'dequeue', 'diff', 'act', 'requeue'] as const
    for (let i = 0; i < 60; i++) {
      for (const id of CONTROLLER_ORDER) {
        const st = s.controllers[id]
        st.phase = phases[i % phases.length]
        st.progress = (i % 10) / 10
        st.queueDepth = i % 14
        st.cached = 4 + (i % 40)
        st.reconciles = i
        st.errors = Math.floor(i / 20)
        st.backoffSeconds = i % 30 === 0 ? 12 : 0
      }
      s.t += 0.05
      mod.update(s, 0.05)
    }
    expect(materialCount()).toBe(base)
    mod.dispose?.()
  })
})
