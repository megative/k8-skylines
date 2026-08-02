import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { Rng } from '../core/util'
import type { SimState } from '../core/types'
import { createSim } from '../sim/model'
import { manifestByRef } from '../ui/manifest'
import type { WorldBuilder, WorldModule } from './module'
import { createNetwork } from './network'
import { createNodes } from './nodes'
import { createPods } from './pods'
import { createStorage } from './storage'

/*
 * Identity stamps: the contract between a district and the picker.
 *
 * A district may stamp `userData.objectKind` plus either an address
 * (`objectName` / `objectNamespace`) or a `objectUid` the model can resolve.
 * The picker walks up the parent chain to the nearest stamp and reports that
 * object, which is how a click can say "this pod" rather than "a Pod".
 *
 * The hazard the stamps carry is staleness. Most districts draw a fixed pool of
 * slots and decide per frame which object stands in each, so a stamp written
 * once at build time starts naming the wrong object the moment anything is
 * deleted — and it does so silently, because the geometry still looks right.
 * These tests exist to make that failure loud.
 */

const DISTRICTS: Record<string, WorldBuilder> = {
  nodes: createNodes,
  storage: createStorage,
  pods: createPods,
  network: createNetwork,
}

interface Stamp {
  district: string
  kind: string
  namespace: string
  name: string
  uid: string
  /** The object's own name in the scene graph, for a legible failure. */
  where: string
  visible: boolean
}

/** Visible in its own subtree: a hidden ancestor hides everything below it. */
function shown(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let a: THREE.Object3D | null = o; a; a = a.parent) {
    if (!a.visible) return false
    if (a === root) break
  }
  return true
}

function collect(district: string, root: THREE.Object3D, out: Stamp[]): void {
  root.traverse((o) => {
    const kind = o.userData.objectKind
    if (typeof kind !== 'string' || kind === '') return
    out.push({
      district,
      kind,
      namespace: String(o.userData.objectNamespace ?? ''),
      name: String(o.userData.objectName ?? ''),
      uid: String(o.userData.objectUid ?? ''),
      where: o.name || '(unnamed)',
      visible: shown(o, root),
    })
  })
}

/**
 * The address a stamp points at. A uid is resolved through the model's own pod
 * map — the same lookup `main.ts` gives the picker — so this is the real
 * resolution path, not a copy of it.
 */
function address(st: Stamp, s: SimState): { namespace: string; name: string } | undefined {
  if (st.uid !== '') {
    const p = s.pods.get(st.uid)
    return p ? { namespace: p.namespace, name: p.name } : undefined
  }
  return st.name === '' ? undefined : { namespace: st.namespace, name: st.name }
}

interface Built {
  sim: ReturnType<typeof createSim>
  modules: WorldModule[]
  stamps(): Stamp[]
  run(seconds: number): void
  dispose(): void
}

function build(seed: number, warmup = 40): Built {
  const sim = createSim(seed)
  const ctx = { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(seed) }
  const entries = Object.entries(DISTRICTS).map(([id, make]) => [id, make(ctx)] as const)
  const modules = entries.map(([, m]) => m)

  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 10; i++) {
      sim.tick(0.1)
      for (const m of modules) m.update(sim.state, 0.1)
    }
  }
  run(warmup)

  return {
    sim,
    modules,
    run,
    stamps(): Stamp[] {
      const out: Stamp[] = []
      for (const [id, m] of entries) collect(id, m.group, out)
      return out
    },
    dispose(): void {
      for (const m of modules) m.dispose?.()
    },
  }
}

describe('identity stamps', () => {
  it('name objects that actually exist', () => {
    const w = build(0x1de71)
    const bad: string[] = []
    for (const st of w.stamps()) {
      const ref = address(st, w.sim.state)
      if (!ref) continue
      /* manifestByRef returns undefined for an object the model does not hold,
       * which is exactly the question being asked: is this a real object? */
      if (manifestByRef(st.kind, ref.namespace, ref.name, w.sim.state) === undefined) {
        bad.push(`${st.district}/${st.where}: ${st.kind} ${ref.namespace}/${ref.name}`)
      }
    }
    expect(bad).toEqual([])
    w.dispose()
  })

  it('leave no visible geometry claiming to be an object it is not', () => {
    const w = build(0x1de72)
    const blank = w
      .stamps()
      .filter((st) => st.visible && st.name === '' && st.uid === '')
      .map((st) => `${st.district}/${st.where} (${st.kind})`)
    expect(blank).toEqual([])
    w.dispose()
  })

  it('cover the kinds whose districts draw them one object at a time', () => {
    const w = build(0x1de73)
    const kinds = new Set(w.stamps().map((st) => st.kind))
    for (const k of ['node', 'pod', 'storage.pv', 'storage.pvc', 'net.service', 'net.ingress']) {
      expect(kinds, `no district stamps ${k}`).toContain(k)
    }
    w.dispose()
  })

  it('stop naming a node once it is removed from the cluster', () => {
    const w = build(0x1de74)
    const live = w.sim.state.nodes.filter((n) => n.present)
    const gone = live[live.length - 1].name
    const before = w.stamps().filter((st) => st.kind === 'node' && st.name === gone)
    expect(before.length, 'the node was never stamped, so the test proves nothing').toBe(1)

    /* Scaling the cluster down is the only path that removes a node today —
     * `deleteClusterObject` has no `node` case, which is its own defect. */
    w.sim.setKnob('nodeCount', live.length - 1)
    w.run(30)

    /* The block is still in the scene graph — it is a slot, not the machine.
     * What must not survive is the claim that the machine is standing in it. */
    const after = w.stamps().filter((st) => st.kind === 'node' && st.name === gone)
    expect(after).toEqual([])
    expect(w.sim.state.nodes.some((n) => n.present && n.name === gone)).toBe(false)
    w.dispose()
  })
})
