import * as THREE from 'three'
import { COLOR, getMode } from '../core/theme'
import { routeCurve, type RouteId } from '../world/layout'
import type { FlowPath } from '../world/paths'
import type { Gfx } from './renderer'

/* ============================================================================
 * PATH ISOLATION — quiet the city so one chain can be read.
 *
 * The city draws every mechanism at once. To follow a single causal chain the
 * rest has to get out of the way, and the cheapest honest way to do that is a
 * scrim: one camera-facing quad that dims the whole rendered scene uniformly,
 * with the path's own geometry drawn on top of it.
 *
 * This never touches a shared material. Dimming by editing the materials in
 * core/theme.ts would dim every other district that shares them, and disposing
 * one would break live geometry elsewhere. The scrim leaves the scene alone.
 *
 * The scrim is deliberately not emissive, so it stays out of the bloom layer and
 * cannot brighten what it is supposed to be hiding.
 * ==========================================================================*/

export interface Trace {
  /** Isolate `path`, with `hop` current. Pass null to release the city. */
  show(path: FlowPath | null, hop: number): void
  /** World point of a hop, so the caller can frame it. False if it has none. */
  hopPoint(path: FlowPath, hop: number, out: THREE.Vector3): boolean
  update(dt: number): void
  dispose(): void
}

/** How dark the rest of the city goes. Enough to read the path against, not so
 *  much that the reader loses where they are. */
const SCRIM_NIGHT = 0.72
const SCRIM_DAY = 0.62
/** Distance in front of the camera. Must clear the near plane (renderer NEAR). */
const SCRIM_DIST = 12
const FADE_RATE = 5.2

/** Tube radius for a route in an isolated chain. */
const R_TUBE = 2.6

export function createTrace(gfx: Gfx): Trace {
  const group = new THREE.Group()
  group.name = 'trace'
  gfx.scene.add(group)

  /* ------------------------------------------------------------- the scrim */

  const scrimMat = new THREE.MeshBasicMaterial({
    color: 0x05070c,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const scrim = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), scrimMat)
  scrim.name = 'trace-scrim'
  scrim.frustumCulled = false
  /* Above the city, below the path. */
  scrim.renderOrder = 900
  scrim.visible = false
  group.add(scrim)

  /* --------------------------------------------------------- path geometry

     Tubes are built once per path and cached: a CatmullRom tube is real
     geometry work and must never happen inside the frame loop. */
  const tubes = new Map<RouteId, THREE.Mesh>()
  const owned: THREE.BufferGeometry[] = []

  /* depthTest stays ON. Drawn over the top the route read as a line flying
   * straight through the buildings; occluded, it reads as something travelling
   * inside the city, which is the only honest picture. */
  const lineMat = new THREE.MeshBasicMaterial({ color: COLOR.desired, transparent: true, opacity: 0, depthWrite: false })
  const activeMat = new THREE.MeshBasicMaterial({ color: COLOR.ready, transparent: true, opacity: 0, depthWrite: false })
  const markMat = new THREE.MeshBasicMaterial({ color: COLOR.desired, transparent: true, opacity: 0, depthWrite: false })
  const markActiveMat = new THREE.MeshBasicMaterial({ color: COLOR.ready, transparent: true, opacity: 0, depthWrite: false })

  const tubeFor = (id: RouteId): THREE.Mesh => {
    const found = tubes.get(id)
    if (found) return found
    const geo = new THREE.TubeGeometry(routeCurve(id), 90, R_TUBE, 8, false)
    owned.push(geo)
    const m = new THREE.Mesh(geo, lineMat)
    m.name = `trace-route:${id}`
    m.frustumCulled = false
    m.renderOrder = 910
    m.visible = false
    group.add(m)
    tubes.set(id, m)
    return m
  }

  /* Hop markers: one small sphere per hop, at the end of the route that reaches
   * it. A stationary hop borrows the previous route's end. */
  const markGeo = new THREE.SphereGeometry(3.4, 16, 12)
  owned.push(markGeo)
  const marks: THREE.Mesh[] = []
  const markFor = (i: number): THREE.Mesh => {
    let m = marks[i]
    if (m) return m
    m = new THREE.Mesh(markGeo, markMat)
    m.name = 'trace-hop'
    m.frustumCulled = false
    m.renderOrder = 920
    m.visible = false
    group.add(m)
    marks[i] = m
    return m
  }

  /* ------------------------------------------------------------------ state */

  let current: FlowPath | null = null
  let currentHop = 0
  let alpha = 0
  let target = 0
  /* The bloom pass is composited on top of the base render, so the scrim cannot
   * touch it: every neon sign in the city punched straight through the dim. It
   * has to be switched off while a chain is isolated, and restored on release —
   * daylight never uses it, so the resting state comes from the theme. */
  let bloomSuspended = false

  const _fwd = new THREE.Vector3()

  /** Lay out the tubes and markers for `path`. Never called per frame. */
  const build = (path: FlowPath, hop: number): void => {
    for (const m of tubes.values()) m.visible = false
    for (const m of marks) m.visible = false

    let lastEnd: THREE.Vector3 | null = null
    for (let i = 0; i < path.hops.length; i++) {
      const h = path.hops[i]
      if (h.route) {
        /* The hop being read is lit; the rest of the chain stays dim, so the
         * eye finds the current step without having to compare thicknesses. */
        const t = tubeFor(h.route)
        t.visible = true
        t.material = i === hop ? activeMat : lineMat
        lastEnd = routeCurve(h.route).getPoint(1, new THREE.Vector3())
      }
      const mk = markFor(i)
      if (lastEnd) {
        mk.visible = true
        mk.position.copy(lastEnd)
        mk.material = i === hop ? markActiveMat : markMat
        mk.scale.setScalar(i === hop ? 1.35 : 1)
      }
    }
  }

  function show(path: FlowPath | null, hop: number): void {
    if (path === null) {
      target = 0
      current = null
      if (bloomSuspended) {
        bloomSuspended = false
        gfx.setBloom(getMode() === 'night')
      }
      return
    }
    if (!bloomSuspended) {
      bloomSuspended = true
      gfx.setBloom(false)
    }
    /* Idempotent: rebuilding the tubes is real geometry work, so a caller that
     * asks for the state it already has must not pay for it. */
    if (path === current && hop === currentHop && target === 1) return
    current = path
    currentHop = hop
    target = 1
    build(path, hop)
    scrim.visible = true
  }

  function update(dt: number): void {
    /* Ease the whole overlay in and out; a hard cut reads as a glitch. */
    const d = target - alpha
    if (Math.abs(d) > 1e-3) alpha += d * Math.min(1, FADE_RATE * dt)
    else alpha = target

    if (alpha <= 1e-3) {
      if (scrim.visible) {
        scrim.visible = false
        for (const m of tubes.values()) m.visible = false
        for (const m of marks) m.visible = false
      }
      return
    }

    const dim = getMode() === 'night' ? SCRIM_NIGHT : SCRIM_DAY
    scrimMat.opacity = alpha * dim
    lineMat.opacity = alpha * 0.5
    activeMat.opacity = alpha * 0.95
    markMat.opacity = alpha * 0.55
    markActiveMat.opacity = alpha

    /* Keep the scrim pinned in front of the camera, sized to cover the frustum
     * at that distance. Reuses one vector; allocates nothing. */
    const cam = gfx.camera
    cam.getWorldDirection(_fwd)
    scrim.position.copy(cam.position).addScaledVector(_fwd, SCRIM_DIST)
    scrim.quaternion.copy(cam.quaternion)
    const h = 2 * Math.tan((cam.fov * Math.PI) / 360) * SCRIM_DIST
    scrim.scale.set(h * cam.aspect * 1.2, h * 1.2, 1)
  }

  /** The world point of a hop, so the caller can frame it. */
  function hopPoint(path: FlowPath, hop: number, out: THREE.Vector3): boolean {
    for (let i = hop; i >= 0; i--) {
      const r = path.hops[i]?.route
      if (r) {
        routeCurve(r).getPoint(1, out)
        return true
      }
    }
    return false
  }

  function dispose(): void {
    if (bloomSuspended) gfx.setBloom(getMode() === 'night')
    for (const g of owned) g.dispose()
    owned.length = 0
    scrim.geometry.dispose()
    scrimMat.dispose()
    lineMat.dispose()
    activeMat.dispose()
    markMat.dispose()
    markActiveMat.dispose()
    group.removeFromParent()
    tubes.clear()
    marks.length = 0
  }

  return { show, hopPoint, update, dispose }
}
