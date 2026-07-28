import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { Rng } from '../core/util'
import { materialCount, setMode } from '../core/theme'
import type { SimState } from '../core/types'
import { CITY, inPit } from './layout'
import type { WorldCtx } from './module'
import { createGround } from './ground'
import { createSky } from './sky'

function makeCtx(): WorldCtx {
  return { scene: new THREE.Scene(), registry: new Registry(), bus: new Bus(), rng: new Rng(7) }
}

/** Only the fields ground/sky actually read. Casting keeps the test readable. */
function fakeState(requestsPerSec: number): SimState {
  return { api: { requestsPerSec } } as unknown as SimState
}

function findByName(root: THREE.Object3D, name: string): THREE.Mesh {
  const hit = root.getObjectByName(name)
  if (!hit) throw new Error(`no object named ${name}`)
  return hit as THREE.Mesh
}

describe('ground', () => {
  it('cuts a real hole over the excavation', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    const grade = findByName(ground.group, 'grade')
    const pos = grade.geometry.getAttribute('position')
    const index = grade.geometry.getIndex()
    expect(index).not.toBeNull()

    /* A triangle whose centroid is inside the pit would be a floor over the
     * vault, which is exactly the claim the excavation must not contradict. */
    let inside = 0
    for (let i = 0; i < index!.count; i += 3) {
      let x = 0
      let z = 0
      for (let k = 0; k < 3; k++) {
        const v = index!.getX(i + k)
        x += pos.getX(v)
        z += pos.getZ(v)
      }
      if (inPit(x / 3, z / 3, -0.5)) inside++
    }
    expect(inside).toBe(0)
    ground.dispose?.()
  })

  it('notches the mesa for the vault and cuts it for the gate road', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    const mesa = findByName(ground.group, 'control-plane-mesa')
    const pos = mesa.geometry.getAttribute('position')
    const index = mesa.geometry.getIndex()
    const at = (i: number): number => (index ? index.getX(i) : i)
    const count = index ? index.count : pos.count

    /* Area of the upward-facing cap. If the notch or the gate hole failed to
     * triangulate, this comes out as the plain rectangle instead. */
    let area = 0
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(pos, at(i))
      b.fromBufferAttribute(pos, at(i + 1))
      c.fromBufferAttribute(pos, at(i + 2))
      if (a.y < CITY.mesa.top - 0.01 || b.y < CITY.mesa.top - 0.01 || c.y < CITY.mesa.top - 0.01) continue
      b.sub(a)
      c.sub(a)
      area += b.cross(c).length() / 2
    }
    const notch = CITY.pit.hx * 2 * (CITY.mesa.z + CITY.mesa.d / 2 - (CITY.pit.z - CITY.pit.hz))
    const plain = CITY.mesa.w * CITY.mesa.d
    /* Notch present, and the gate road really is cut through the deck. */
    expect(area).toBeLessThan(plain - notch - 3000)
    expect(area).toBeGreaterThan(plain - notch - 6000)
    ground.dispose?.()
  })

  it('does not run grid lines across the excavation', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    const lines: THREE.LineSegments[] = []
    ground.group.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) lines.push(o as THREE.LineSegments)
    })
    expect(lines.length).toBe(2)

    let crossings = 0
    for (const l of lines) {
      const p = l.geometry.getAttribute('position')
      for (let i = 0; i < p.count; i += 2) {
        const mx = (p.getX(i) + p.getX(i + 1)) / 2
        const mz = (p.getZ(i) + p.getZ(i + 1)) / 2
        if (inPit(mx, mz, -0.5)) crossings++
      }
    }
    expect(crossings).toBe(0)
    ground.dispose?.()
  })

  it('leaves exactly one opening in the cluster boundary', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    let posts: THREE.InstancedMesh | undefined
    ground.group.traverse((o) => {
      const im = o as THREE.InstancedMesh
      if (im.isInstancedMesh && im.castShadow && im.count > 8) posts = im
    })
    expect(posts).toBeDefined()

    const m = new THREE.Matrix4()
    const v = new THREE.Vector3()
    const xs: number[] = []
    for (let i = 0; i < posts!.count; i++) {
      posts!.getMatrixAt(i, m)
      v.setFromMatrixPosition(m)
      xs.push(v.x)
    }
    xs.sort((a, b) => a - b)
    const pitch = 20
    const gaps = []
    for (let i = 1; i < xs.length; i++) {
      if (xs[i]! - xs[i - 1]! > pitch * 1.5) gaps.push((xs[i]! + xs[i - 1]!) / 2)
    }
    expect(gaps).toHaveLength(1)
    /* The one door is on the axis every route into the cluster follows. */
    expect(Math.abs(gaps[0]!)).toBeLessThan(1e-6)
    ground.dispose?.()
  })

  it('never paints a district marking over the void', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    const marks: THREE.Mesh[] = []
    ground.group.traverse((o) => {
      if (o.name.startsWith('district-mark:')) marks.push(o as THREE.Mesh)
    })
    /* Nine districts, so at least four edges each survived the clipping. */
    expect(marks.length).toBeGreaterThanOrEqual(36)

    for (const m of marks) {
      if (m.position.y <= CITY.pit.wallTop) continue
      const hx = m.scale.x / 2
      const hz = m.scale.z / 2
      const overlaps =
        m.position.x + hx > CITY.pit.x - CITY.pit.hx &&
        m.position.x - hx < CITY.pit.x + CITY.pit.hx &&
        m.position.z + hz > CITY.pit.z - CITY.pit.hz &&
        m.position.z - hz < CITY.pit.z + CITY.pit.hz
      expect(overlaps, `${m.name} at ${m.position.x},${m.position.z}`).toBe(false)
    }
    ground.dispose?.()
  })

  it('registers the mechanisms it draws, with caveats', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    for (const id of [
      'ground.cluster-boundary',
      'ground.excavation',
      'ground.durability-line',
      'ground.control-plane-mesa',
      'ground.node-grid',
      'ground.roads',
      'ground.client-apron',
    ]) {
      const e = ctx.registry.get(id)
      expect(e, id).toBeDefined()
      expect(e!.detail.length, id).toBeGreaterThan(0)
      expect(e!.caveats?.length ?? 0, id).toBeGreaterThan(0)
    }
    ground.dispose?.()
  })

  it('leaves nothing on the ground unexplained', () => {
    const ctx = makeCtx()
    const ground = createGround(ctx)
    const orphans: string[] = []
    ground.group.traverse((o) => {
      const r = o as THREE.Mesh
      if (!r.isMesh && !(o as THREE.LineSegments).isLineSegments) return
      if (!ctx.registry.resolve(o)) orphans.push(`${o.name || o.type} @ ${o.position.toArray().join(',')}`)
    })
    expect(orphans).toEqual([])
    ground.dispose?.()
  })

  it('allocates no materials in the frame loop', () => {
    setMode('night')
    const ctx = makeCtx()
    const ground = createGround(ctx)
    ground.update(fakeState(1), 0.016)
    const before = materialCount()
    for (let i = 0; i < 240; i++) ground.update(fakeState(i), 1 / 60)
    expect(materialCount()).toBe(before)
    ground.dispose?.()
  })
})

describe('sky', () => {
  it('installs fog matching the city plan and repaints on a theme flip', () => {
    setMode('night')
    const ctx = makeCtx()
    const sky = createSky(ctx)

    const fog = ctx.scene.fog as THREE.Fog
    expect(fog).toBeInstanceOf(THREE.Fog)
    expect(fog.near).toBe(CITY.fog.near)
    expect(fog.far).toBe(CITY.fog.far)

    const night = fog.color.getHex()
    const nightLum = fog.color.r + fog.color.g + fog.color.b
    ctx.bus.emit('theme', { mode: 'day' })
    expect(fog.color.getHex()).not.toBe(night)
    /* Daylight has to carry value, not bloom: the haze is an order of
     * magnitude brighter than the night haze it replaces. */
    expect(fog.color.r + fog.color.g + fog.color.b).toBeGreaterThan(nightLum * 10)
    expect((ctx.scene.background as THREE.Color).getHex()).toBe(fog.color.getHex())

    sky.dispose?.()
    setMode('night')
  })

  it('covers the excavation floor with the shadow camera', () => {
    const ctx = makeCtx()
    const sky = createSky(ctx)
    let key: THREE.DirectionalLight | undefined
    sky.group.traverse((o) => {
      const l = o as THREE.DirectionalLight
      if (l.isDirectionalLight && l.castShadow) key = l
    })
    expect(key).toBeDefined()
    const cam = key!.shadow.camera
    expect(cam.far).toBeGreaterThan(key!.position.length() + Math.abs(CITY.pit.floorY))
    expect(cam.right - cam.left).toBeGreaterThan(CITY.node.pitch * 4)
    sky.dispose?.()
  })

  it('leaves the scene clean when disposed', () => {
    const ctx = makeCtx()
    const sky = createSky(ctx)
    expect(ctx.scene.fog).not.toBeNull()
    sky.dispose?.()
    expect(ctx.scene.fog).toBeNull()
    expect(ctx.scene.background).toBeNull()
  })
})
