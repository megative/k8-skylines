import * as THREE from 'three'
import { mat, structural } from '../core/theme'

/* ============================================================================
 * PROCESS HALLS — the frame that says "this is all one binary".
 *
 * The scheduler and the controller manager were each drawn as an open yard with
 * furniture scattered on it, which reads as a collection of separate machines.
 * That under-claims: `kube-scheduler` is one process, and `kube-controller-
 * manager` is one process running many loops inside itself. A frame around the
 * yard is the honest statement of that boundary — everything standing inside it
 * is one binary.
 *
 * It also happens to be what the city's composition needed. With one tall tower
 * and nothing else above knee height, the establishing shot had a spike on a
 * plate. A tower flanked by two lower halls is a legible massing hierarchy, and
 * the hierarchy matches the architecture: everything talks to the apiserver, so
 * the apiserver is taller than the things that talk to it.
 *
 * Deliberately open: columns, a perimeter beam and a sparse roof grid, with no
 * walls and no roof deck. The furniture inside is the lesson and must never be
 * hidden by the frame that explains it. Everything here is matte structure, so
 * it can never cross the bloom threshold and steal attention from a real signal.
 * ==========================================================================*/

export interface HallOpts {
  /** District centre in world space. */
  center: readonly [number, number, number]
  /** Half-extents of the footprint the frame encloses. */
  hx: number
  hz: number
  /** Deck the columns stand on. */
  baseY: number
  /** Height of the perimeter beam above `baseY`. */
  height: number
  /** Columns strictly between the corners, per side. */
  bays?: number
}

export interface Hall {
  group: THREE.Group
  dispose(): void
}

const COL = 3.2
const BEAM = 2.4

export function buildHall(opts: HallOpts): Hall {
  const { center, hx, hz, baseY, height } = opts
  const bays = opts.bays ?? 2

  const group = new THREE.Group()
  group.name = 'hall'
  group.position.set(center[0], baseY, center[2])

  const geoms: THREE.BufferGeometry[] = []
  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    geoms.push(g)
    return g
  }

  const M_COL = mat(structural('concrete'))
  const M_BEAM = mat(structural('deck'))

  /* --------------------------------------------------------------- columns */

  const colGeo = own(new THREE.BoxGeometry(COL, height, COL))
  const post = (x: number, z: number): void => {
    const m = new THREE.Mesh(colGeo, M_COL)
    m.position.set(x, height / 2, z)
    m.castShadow = true
    group.add(m)
  }

  /* Corners carry the frame; the bay columns give it scale to be read against,
   * the same job the tower's mullions do. */
  for (let i = 0; i < 4; i++) {
    post((i & 1 ? 1 : -1) * hx, (i & 2 ? 1 : -1) * hz)
  }
  for (let i = 1; i <= bays; i++) {
    const t = i / (bays + 1)
    const px = (t * 2 - 1) * hx
    const pz = (t * 2 - 1) * hz
    post(px, -hz)
    post(px, hz)
    post(-hx, pz)
    post(hx, pz)
  }

  /* ------------------------------------------------- perimeter beam and roof */

  const beamX = own(new THREE.BoxGeometry(hx * 2 + COL, BEAM, BEAM))
  const beamZ = own(new THREE.BoxGeometry(BEAM, BEAM, hz * 2 + COL))
  const ring = (geo: THREE.BufferGeometry, x: number, z: number): void => {
    const m = new THREE.Mesh(geo, M_BEAM)
    m.position.set(x, height, z)
    group.add(m)
  }
  ring(beamX, 0, -hz)
  ring(beamX, 0, hz)
  ring(beamZ, -hx, 0)
  ring(beamZ, hx, 0)

  /* A sparse grid, not a deck: three ribs each way still reads as a roof from
   * the establishing shot while leaving the yard fully visible from above. */
  const RIBS = 3
  const ribX = own(new THREE.BoxGeometry(hx * 2, 1.1, 1.1))
  const ribZ = own(new THREE.BoxGeometry(1.1, 1.1, hz * 2))
  for (let i = 1; i <= RIBS; i++) {
    const t = i / (RIBS + 1)
    const mx = new THREE.Mesh(ribX, M_BEAM)
    mx.position.set(0, height - 0.2, (t * 2 - 1) * hz)
    group.add(mx)
    const mz = new THREE.Mesh(ribZ, M_BEAM)
    mz.position.set((t * 2 - 1) * hx, height - 0.2, 0)
    group.add(mz)
  }

  return {
    group,
    dispose(): void {
      /* Only the geometries built here. The two materials come from theme's
       * shared cache and belong to every other district too. */
      for (const g of geoms) g.dispose()
      geoms.length = 0
    },
  }
}
