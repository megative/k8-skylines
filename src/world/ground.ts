import * as THREE from 'three'
import type { DistrictId, Explainer, SimState } from '../core/types'
import { COLOR, getMode, glass, mat, neon, setMode, structural } from '../core/theme'
import { ANCHOR, CITY, DISTRICTS, inPit } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE GROUND — terrain, the excavation, the boundary, and the roads.
 *
 * Four claims are made by this geometry, and each is a real property of a
 * cluster rather than a scenic choice:
 *
 *   1. There is exactly one way in. The perimeter has a single gate, and the
 *      road from the client apron descends through it; nothing else crosses.
 *   2. Depth is durability. The ground is cut away over the etcd vault, and the
 *      strata on the pit wall run from volatile memory at grade to fsync'd disk
 *      at the bottom. You have to look *down* to see the only durable copy.
 *   3. The control plane stands apart from the data plane. The mesa is raised;
 *      the node grid is at grade; the spine road is the only link.
 *   4. The road network mirrors the API-mediated paths and nothing else. There
 *      is no road from the controller yard to a node, because there is no such
 *      path in Kubernetes.
 * ==========================================================================*/

const G = CITY.ground

/* The platform is a ship's helm — Kubernetes is the helmsman, and the whole
 * city stands on the wheel, the way the reference city stands on its mascot.
 * The disc holds every district; seven handle tabs on the rim make the
 * silhouette a wheel rather than a plate. Centred near the city's own centre so
 * nothing overhangs the edge. */
const PLAT_CZ = 20
const PLAT_R = 720
const HANDLE_N = 7
const HANDLE_OUT = 54

/* The excavation, restated from CITY.pit in the form the geometry needs. */
const PIT_X0 = CITY.pit.x - CITY.pit.hx
const PIT_X1 = CITY.pit.x + CITY.pit.hx
const PIT_Z0 = CITY.pit.z - CITY.pit.hz
const PIT_Z1 = CITY.pit.z + CITY.pit.hz
const PIT_DEPTH = CITY.pit.wallTop - CITY.pit.floorY

/* The mesa, and the notch its south edge gives up to the excavation. */
const MESA_X0 = -CITY.mesa.w / 2
const MESA_X1 = CITY.mesa.w / 2
const MESA_Z0 = CITY.mesa.z - CITY.mesa.d / 2
const MESA_Z1 = CITY.mesa.z + CITY.mesa.d / 2
const MESA_TOP = CITY.mesa.top

/* The client apron, outside the boundary, level with the mesa so the plateau
 * reads as continuous and the fence is visibly the only thing dividing it. */
const APRON_HX = 260
const APRON_Z0 = -540
const APRON_Z1 = MESA_Z0

/* The boundary and its single gate. */
const GATE_Z = ANCHOR.clusterGate[2]
/** The fence spans the plateau exactly; beyond it the 6 m escarpment continues. */
const FENCE_HALF = CITY.mesa.w / 2
const FENCE_PITCH = 20
const FENCE_TOP = 12
const GATE_HALF = 24
const GATE_HEIGHT = 22
/** Road cut through the mesa: the gate threshold is at grade, not on the mesa. */
const CUT_Z0 = GATE_Z - 42
const CUT_Z1 = GATE_Z + 42
const CUT_RAMP = 26
const ROAD_Y = 0.08

/* Strata boundaries on the pit wall, top to bottom. Depth is volatility. */
const STRATA: readonly { y0: number; y1: number; deck: boolean }[] = [
  { y0: 0, y1: -10, deck: false },
  { y0: -10, y1: -26, deck: true },
  { y0: -26, y1: -44, deck: false },
  { y0: -44, y1: CITY.pit.floorY, deck: true },
]
/** Below this line a write has been fsync'd. Above it, everything is memory. */
const DURABILITY_Y = -44

/* Grid spacing. 50 m minor gives a person-sized sense of scale from the air. */
const GRID_MINOR = 50
const GRID_MAJOR = 250

type RoadSeg = { x0: number; x1: number; z0: number; z1: number; y: number }

/**
 * Every road in the city. Grade roads run between the excavation and the edge;
 * mesa roads sit on the control-plane deck. A segment that overlapped the
 * excavation would be a floor over the vault, so the build asserts none does.
 */
const ROADS: readonly RoadSeg[] = [
  /* Grade. The spine runs the full length of the city in the 20 m gap the node
   * grid leaves at x = 0, so it enters the node blocks rather than skirting. */
  { x0: -8, x1: 8, z0: -50, z1: 592, y: 0 },
  { x0: -148, x1: -136, z0: -126, z1: -34, y: 0 },
  { x0: 136, x1: 148, z0: -126, z1: -34, y: 0 },
  { x0: -148, x1: 148, z0: -46, z1: -34, y: 0 },
  { x0: -430, x1: 430, z0: 53, z1: 67, y: 0 },
  { x0: -176, x1: -164, z0: 60, z1: 254, y: 0 },
  { x0: 164, x1: 176, z0: 60, z1: 254, y: 0 },
  { x0: -340, x1: 340, z0: 248, z1: 260, y: 0 },
  /* Mesa. */
  { x0: -260, x1: 260, z0: -267, z1: -253, y: MESA_TOP },
  { x0: -256, x1: -244, z0: -300, z1: -253, y: MESA_TOP },
  { x0: 244, x1: 256, z0: -300, z1: -253, y: MESA_TOP },
  { x0: -65, x1: -55, z0: -362, z1: -253, y: MESA_TOP },
  { x0: 55, x1: 65, z0: -362, z1: -253, y: MESA_TOP },
  { x0: -65, x1: 65, z0: -362, z1: -352, y: MESA_TOP },
  { x0: -148, x1: -136, z0: -267, z1: -150, y: MESA_TOP },
  { x0: 136, x1: 148, z0: -267, z1: -150, y: MESA_TOP },
  /* Client apron, outside the boundary. */
  { x0: -8, x1: 8, z0: -470, z1: CUT_Z0, y: MESA_TOP },
  { x0: -156, x1: 156, z0: -476, z1: -464, y: MESA_TOP },
]

/** District ground markings take the mechanism's own colour, never a new hue. */
const DISTRICT_COLOR: Record<string, number> = {
  client: COLOR.desired,
  apiserver: COLOR.api,
  etcd: COLOR.etcd,
  scheduler: COLOR.scheduler,
  controllers: COLOR.controller,
  nodes: COLOR.kubelet,
  network: COLOR.network,
  storage: COLOR.storage,
  registry: COLOR.image,
}

type Mats = ReturnType<typeof buildMats>
type MatKey = keyof Mats

function buildMats() {
  return {
    ground: mat(structural('ground'), 0.96),
    deck: mat(structural('deck'), 0.9),
    concrete: mat(structural('concrete'), 0.94),
    road: mat(structural('deck'), 0.86),
    stripe: mat(structural('concrete'), 0.7),
    wall: mat(structural('concrete'), 0.96),
    strataDeck: mat(structural('deck'), 0.95),
    post: mat(COLOR.edge, 0.68),
    panel: glass(COLOR.api, 0.07),
    durability: neon(COLOR.etcd, 1.3),
    gateIdle: neon(COLOR.api, 0.7),
    gateBusy: neon(COLOR.api, 1.7),
    gateFlood: neon(COLOR.api, 2.8),
  }
}

/* --------------------------------------------------------------------------
 * Shape helpers. A THREE.Shape lives in XY; rotating the mesh by -PI/2 about X
 * maps local (x, y) to world (x, -y) in the XZ plane and the extrusion depth to
 * world +Y. Everything below is therefore authored with `sy = -worldZ`.
 * ------------------------------------------------------------------------*/

function rectShape(x0: number, x1: number, z0: number, z1: number): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(x0, -z1)
  s.lineTo(x1, -z1)
  s.lineTo(x1, -z0)
  s.lineTo(x0, -z0)
  s.closePath()
  return s
}

/**
 * The platform outline: a disc of radius PLAT_R with seven handle tabs standing
 * out past the rim, so the whole footprint reads as a ship's helm from above.
 * Built as a polyline in shape space (where z maps to -y).
 */
function helmShape(): THREE.Shape {
  const s = new THREE.Shape()
  const steps = 630
  const stalkHalf = 0.05 /* radians; the angular width of a handle tab */
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * Math.PI * 2
    let r = PLAT_R
    for (let k = 0; k < HANDLE_N; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / HANDLE_N
      /* Wrapped angular distance to this handle. */
      const d = Math.abs(Math.atan2(Math.sin(th - a), Math.cos(th - a)))
      if (d < stalkHalf) r = PLAT_R + HANDLE_OUT
    }
    const x = r * Math.cos(th)
    const z = r * Math.sin(th) + PLAT_CZ
    if (i === 0) s.moveTo(x, -z)
    else s.lineTo(x, -z)
  }
  s.closePath()
  return s
}

function rectHole(x0: number, x1: number, z0: number, z1: number): THREE.Path {
  const p = new THREE.Path()
  p.moveTo(x0, -z1)
  p.lineTo(x0, -z0)
  p.lineTo(x1, -z0)
  p.lineTo(x1, -z1)
  p.closePath()
  return p
}

/** A flat slab from a Shape, lying in the XZ plane at y = 0 before placement. */
function slabGeometry(shape: THREE.Shape, thickness: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  })
  g.rotateX(-Math.PI / 2)
  return g
}

interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/** Footprints nothing at surface level may be drawn over: the void, and the cut. */
const PIT_RECT: Rect = { x0: PIT_X0, x1: PIT_X1, z0: PIT_Z0, z1: PIT_Z1 }
const CUT_RECT: Rect = { x0: -GATE_HALF, x1: GATE_HALF, z0: CUT_Z0, z1: CUT_Z1 }

/** AABB overlap against the excavation, used to police road placement. */
function overlapsPit(x0: number, x1: number, z0: number, z1: number): boolean {
  return x1 > PIT_X0 && x0 < PIT_X1 && z1 > PIT_Z0 && z0 < PIT_Z1
}

/** Remove [b0, b1] from a sorted list of disjoint spans. Build time only. */
function subtractSpan(spans: readonly (readonly [number, number])[], b0: number, b1: number): [number, number][] {
  const out: [number, number][] = []
  for (const [a0, a1] of spans) {
    if (b1 <= a0 || b0 >= a1) {
      out.push([a0, a1])
      continue
    }
    if (a0 < b0) out.push([a0, b0])
    if (b1 < a1) out.push([b1, a1])
  }
  return out
}

/** Surface height at a point: mesa and apron are a plateau, everything else grade. */
function groundY(x: number, z: number): number {
  const onMesa =
    x > MESA_X0 && x < MESA_X1 && z > MESA_Z0 && z < MESA_Z1 && !inPit(x, z) &&
    !(Math.abs(x) < GATE_HALF && z > CUT_Z0 && z < CUT_Z1)
  const onApron = Math.abs(x) < APRON_HX && z > APRON_Z0 && z < APRON_Z1
  return onMesa || onApron ? MESA_TOP : 0
}

export function createGround(ctx: WorldCtx): WorldModule {
  /* The cut must agree with the predicate every other district uses to decide
   * whether a surface position is over the void. */
  if (!inPit(CITY.pit.x, CITY.pit.z) || inPit(PIT_X1 + 1, CITY.pit.z)) {
    throw new Error('ground: excavation geometry disagrees with inPit()')
  }

  const group = new THREE.Group()
  group.name = 'ground'
  const geoms: THREE.BufferGeometry[] = []
  let mats: Mats = buildMats()

  /* Static meshes whose material must be re-pointed after a theme flip clears
   * the material cache. Dynamic meshes re-read `mats` on the next frame. */
  const statics: { o: THREE.Mesh | THREE.InstancedMesh; k: MatKey }[] = []
  const pairStatics: { o: THREE.Mesh; a: MatKey; b: MatKey }[] = []

  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    geoms.push(g)
    return g
  }
  const add = (g: THREE.BufferGeometry, k: MatKey): THREE.Mesh => {
    const m = new THREE.Mesh(g, mats[k])
    statics.push({ o: m, k })
    group.add(m)
    return m
  }

  /* ------------------------------------------------------- the ground plane */

  const groundShape = helmShape()
  groundShape.holes.push(rectHole(PIT_X0, PIT_X1, PIT_Z0, PIT_Z1))
  const groundGeo = keep(new THREE.ShapeGeometry(groundShape, 1))
  groundGeo.rotateX(-Math.PI / 2)
  const groundMesh = add(groundGeo, 'ground')
  groundMesh.receiveShadow = true
  groundMesh.name = 'grade'

  /* The wheel's rim, as low structural relief so the platform reads as a helm
     rather than a plain disc. Matte, not emissive: it is the ground the city
     stands on, not a signal. */
  const rimGeo = keep(new THREE.TorusGeometry(PLAT_R, 5, 10, 200))
  const rim = add(rimGeo, 'concrete')
  rim.rotation.x = -Math.PI / 2
  rim.position.set(0, 2, PLAT_CZ)

  /* ------------------------------------------------------------- the grid */

  /* theme.ts has no line material; these two are district-owned and disposed
   * here. Their colours still come from the palette. */
  const minorMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 })
  const majorMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 })
  const applyGridColor = (m: 'day' | 'night'): void => {
    const c = m === 'day' ? COLOR.concrete : COLOR.edge
    minorMat.color.setHex(c)
    majorMat.color.setHex(c)
  }

  const gridMinor = new THREE.LineSegments(keep(buildGrid(GRID_MINOR, GRID_MAJOR)), minorMat)
  const gridMajor = new THREE.LineSegments(keep(buildGrid(GRID_MAJOR, 0)), majorMat)
  gridMinor.position.y = 0.06
  gridMajor.position.y = 0.07
  group.add(gridMinor, gridMajor)

  /* -------------------------------------------------------- the excavation */

  const wallNS = keep(new THREE.PlaneGeometry(CITY.pit.hx * 2, PIT_DEPTH))
  const wallEW = keep(new THREE.PlaneGeometry(CITY.pit.hz * 2, PIT_DEPTH))
  const wallY = CITY.pit.floorY + PIT_DEPTH / 2
  const pitWalls: THREE.Mesh[] = []
  const northWall = add(wallNS, 'wall')
  northWall.position.set(CITY.pit.x, wallY, PIT_Z0)
  const southWall = add(wallNS, 'wall')
  southWall.position.set(CITY.pit.x, wallY, PIT_Z1)
  southWall.rotation.y = Math.PI
  const eastWall = add(wallEW, 'wall')
  eastWall.position.set(PIT_X1, wallY, CITY.pit.z)
  eastWall.rotation.y = -Math.PI / 2
  const westWall = add(wallEW, 'wall')
  westWall.position.set(PIT_X0, wallY, CITY.pit.z)
  westWall.rotation.y = Math.PI / 2
  pitWalls.push(northWall, southWall, eastWall, westWall)
  for (const w of pitWalls) w.receiveShadow = true

  const pitFloorGeo = keep(new THREE.PlaneGeometry(CITY.pit.hx * 2, CITY.pit.hz * 2))
  pitFloorGeo.rotateX(-Math.PI / 2)
  const pitFloor = add(pitFloorGeo, 'concrete')
  pitFloor.position.set(CITY.pit.x, CITY.pit.floorY, CITY.pit.z)
  pitFloor.receiveShadow = true
  pitFloor.name = 'vault-floor'

  /* Strata ledges, drawn as belts standing slightly proud of each wall so the
   * layering reads from the surface without occluding the vault below. */
  const beltGeo = keep(new THREE.BoxGeometry(1, 1, 1))
  const strataBelts: THREE.Group[] = []
  for (const band of STRATA) {
    const h = band.y0 - band.y1
    const cy = (band.y0 + band.y1) / 2
    const k: MatKey = band.deck ? 'strataDeck' : 'concrete'
    strataBelts.push(placeBelt(beltGeo, k, cy, h, 0.6))
  }

  /* The one semantic mark in the excavation: everything below this line has
   * been written and fsync'd, everything above it is a copy that a restart
   * would lose. */
  const durabilityBelt = placeBelt(beltGeo, 'durability', DURABILITY_Y, 0.7, 1.1)

  function placeBelt(geo: THREE.BoxGeometry, k: MatKey, cy: number, h: number, proud: number): THREE.Group {
    const holder = new THREE.Group()
    const inset = 0.5 + proud / 2
    const mk = (sx: number, sz: number, px: number, pz: number): void => {
      const m = new THREE.Mesh(geo, mats[k])
      m.scale.set(sx, h, sz)
      m.position.set(px, cy, pz)
      statics.push({ o: m, k })
      holder.add(m)
    }
    mk(CITY.pit.hx * 2, proud, CITY.pit.x, PIT_Z0 + inset)
    mk(CITY.pit.hx * 2, proud, CITY.pit.x, PIT_Z1 - inset)
    mk(proud, CITY.pit.hz * 2, PIT_X1 - inset, CITY.pit.z)
    mk(proud, CITY.pit.hz * 2, PIT_X0 + inset, CITY.pit.z)
    group.add(holder)
    /* Binding the holder makes every one of the four wall segments resolve to
     * the same explainer; Registry.resolve walks up the parent chain. */
    return holder
  }

  /* ------------------------------------------------------------- the mesa */

  const mesaShape = new THREE.Shape()
  mesaShape.moveTo(MESA_X0, -MESA_Z1)
  mesaShape.lineTo(PIT_X0, -MESA_Z1)
  mesaShape.lineTo(PIT_X0, -PIT_Z0)
  mesaShape.lineTo(PIT_X1, -PIT_Z0)
  mesaShape.lineTo(PIT_X1, -MESA_Z1)
  mesaShape.lineTo(MESA_X1, -MESA_Z1)
  mesaShape.lineTo(MESA_X1, -MESA_Z0)
  mesaShape.lineTo(MESA_X0, -MESA_Z0)
  mesaShape.closePath()
  mesaShape.holes.push(rectHole(-GATE_HALF, GATE_HALF, CUT_Z0, CUT_Z1))
  const mesaGeo = keep(slabGeometry(mesaShape, MESA_TOP))
  const mesa = new THREE.Mesh(mesaGeo, [mats.deck, mats.concrete])
  mesa.receiveShadow = true
  mesa.castShadow = true
  mesa.name = 'control-plane-mesa'
  pairStatics.push({ o: mesa, a: 'deck', b: 'concrete' })
  group.add(mesa)

  const apronGeo = keep(slabGeometry(rectShape(-APRON_HX, APRON_HX, APRON_Z0, APRON_Z1), MESA_TOP))
  const apron = new THREE.Mesh(apronGeo, [mats.deck, mats.concrete])
  apron.receiveShadow = true
  apron.castShadow = true
  apron.name = 'client-apron'
  pairStatics.push({ o: apron, a: 'deck', b: 'concrete' })
  group.add(apron)

  /* ------------------------------------------------------------- the roads */

  const roadGeo = keep(new THREE.BoxGeometry(1, 0.2, 1))
  const roadMesh = new THREE.InstancedMesh(roadGeo, mats.road, ROADS.length)
  const stripeMesh = new THREE.InstancedMesh(roadGeo, mats.stripe, ROADS.length)
  roadMesh.receiveShadow = true
  const m4 = new THREE.Matrix4()
  const scratchPos = new THREE.Vector3()
  const scratchScale = new THREE.Vector3()
  const noRot = new THREE.Quaternion()
  for (let i = 0; i < ROADS.length; i++) {
    const r = ROADS[i]!
    if (overlapsPit(r.x0, r.x1, r.z0, r.z1)) {
      throw new Error(`ground: road ${i} lies over the excavation`)
    }
    const w = r.x1 - r.x0
    const d = r.z1 - r.z0
    scratchPos.set((r.x0 + r.x1) / 2, r.y + 0.1, (r.z0 + r.z1) / 2)
    scratchScale.set(w, 1, d)
    roadMesh.setMatrixAt(i, m4.compose(scratchPos, noRot, scratchScale))
    /* The centre stripe runs the long way, so a road reads as a road from the air. */
    scratchPos.y = r.y + 0.22
    scratchScale.set(w > d ? w - 4 : 1.2, 0.4, w > d ? 1.2 : d - 4)
    stripeMesh.setMatrixAt(i, m4.compose(scratchPos, noRot, scratchScale))
  }
  roadMesh.instanceMatrix.needsUpdate = true
  stripeMesh.instanceMatrix.needsUpdate = true
  statics.push({ o: roadMesh, k: 'road' }, { o: stripeMesh, k: 'stripe' })
  group.add(roadMesh, stripeMesh)

  /* Ramps. Solid wedges, not floating decks: from below, a road you can see
   * through reads as a rendering bug rather than as civil engineering. */
  const rampGate = 5.92
  const gateRampLen = Math.hypot(CUT_RAMP, rampGate)
  const gateRampAngle = Math.atan2(rampGate, CUT_RAMP)
  const gateRampGeo = keep(new THREE.BoxGeometry(GATE_HALF * 2, 2, gateRampLen))
  const rampNorth = add(gateRampGeo, 'road')
  rampNorth.rotation.x = gateRampAngle
  rampNorth.position.set(0, (MESA_TOP + ROAD_Y) / 2 - Math.cos(gateRampAngle), CUT_Z0 + CUT_RAMP / 2)
  const rampSouth = add(gateRampGeo, 'road')
  rampSouth.rotation.x = -gateRampAngle
  rampSouth.position.set(0, (MESA_TOP + ROAD_Y) / 2 - Math.cos(gateRampAngle), CUT_Z1 - CUT_RAMP / 2)
  const cutFloorGeo = keep(new THREE.BoxGeometry(GATE_HALF * 2, 0.2, CUT_Z1 - CUT_Z0 - 2 * CUT_RAMP))
  const cutFloor = add(cutFloorGeo, 'road')
  cutFloor.position.set(0, ROAD_Y, GATE_Z)
  cutFloor.receiveShadow = true

  const mesaRampRise = MESA_TOP - ROAD_Y
  const mesaRampRun = 24
  const mesaRampLen = Math.hypot(mesaRampRun, mesaRampRise)
  const mesaRampAngle = Math.atan2(mesaRampRise, mesaRampRun)
  const mesaRampGeo = keep(new THREE.BoxGeometry(12, 1.6, mesaRampLen + 2))
  const mesaRamps: THREE.Mesh[] = []
  for (const sx of [-142, 142]) {
    const r = add(mesaRampGeo, 'road')
    r.rotation.x = mesaRampAngle
    r.position.set(sx, (MESA_TOP + ROAD_Y) / 2 - 0.8 * Math.cos(mesaRampAngle), MESA_Z1 + mesaRampRun / 2)
    mesaRamps.push(r)
  }

  /* -------------------------------------------------- the cluster boundary */

  /* Post stations for one side of the gate, gate pylon outward to the escarpment. */
  const stations: number[] = []
  for (let x = GATE_HALF + 2; x < FENCE_HALF - 4; x += FENCE_PITCH) stations.push(x)
  stations.push(FENCE_HALF)

  const postGeo = keep(new THREE.BoxGeometry(0.9, 1, 0.9))
  const postMesh = new THREE.InstancedMesh(postGeo, mats.post, stations.length * 2)
  postMesh.castShadow = true
  let idx = 0
  for (const sgn of [-1, 1]) {
    for (const s of stations) {
      const x = sgn * s
      const base = groundY(x, GATE_Z)
      scratchPos.set(x, base + (FENCE_TOP + 0.6 - base) / 2, GATE_Z)
      scratchScale.set(1, FENCE_TOP + 0.6 - base, 1)
      postMesh.setMatrixAt(idx++, m4.compose(scratchPos, noRot, scratchScale))
    }
  }
  postMesh.instanceMatrix.needsUpdate = true
  statics.push({ o: postMesh, k: 'post' })
  group.add(postMesh)

  /* The infill is glass, not masonry: a cluster boundary is an authentication
   * boundary, not a wall. You can see through it; you still cannot cross it. */
  const panelGeo = keep(new THREE.BoxGeometry(1, 1, 0.3))
  const panelMesh = new THREE.InstancedMesh(panelGeo, mats.panel, (stations.length - 1) * 2)
  let pi = 0
  for (const sgn of [-1, 1]) {
    for (let j = 0; j + 1 < stations.length; j++) {
      const cx = (sgn * (stations[j]! + stations[j + 1]!)) / 2
      const base = groundY(cx, GATE_Z)
      const h = FENCE_TOP - 0.6 - base
      scratchPos.set(cx, base + 0.4 + h / 2, GATE_Z)
      scratchScale.set(stations[j + 1]! - stations[j]! - 1.2, h, 1)
      panelMesh.setMatrixAt(pi++, m4.compose(scratchPos, noRot, scratchScale))
    }
  }
  panelMesh.instanceMatrix.needsUpdate = true
  statics.push({ o: panelMesh, k: 'panel' })
  group.add(panelMesh)

  const railGeo = keep(new THREE.BoxGeometry(FENCE_HALF - GATE_HALF - 2, 0.7, 1.1))
  const rails: THREE.Mesh[] = []
  for (const sgn of [-1, 1]) {
    const rail = add(railGeo, 'post')
    rail.position.set((sgn * (FENCE_HALF + GATE_HALF + 2)) / 2, FENCE_TOP, GATE_Z)
    rails.push(rail)
  }

  /* The one door. Two pylons and a lit lintel: TLS terminates here and the
   * request is given an identity before anything inside will look at it. */
  const pylonGeo = keep(new THREE.BoxGeometry(5, GATE_HEIGHT - MESA_TOP, 7))
  const gatePylons: THREE.Mesh[] = []
  for (const sgn of [-1, 1]) {
    const p = add(pylonGeo, 'concrete')
    p.position.set(sgn * (GATE_HALF + 3), MESA_TOP + (GATE_HEIGHT - MESA_TOP) / 2, GATE_Z)
    p.castShadow = true
    gatePylons.push(p)
  }
  const lintelGeo = keep(new THREE.BoxGeometry(GATE_HALF * 2 + 12, 2.4, 5))
  const gateLamp = new THREE.Mesh(lintelGeo, mats.gateIdle)
  gateLamp.position.set(0, GATE_HEIGHT, GATE_Z)
  gateLamp.name = 'cluster-gate'
  group.add(gateLamp)

  /* --------------------------------------------------- district markings */

  const barGeo = keep(new THREE.BoxGeometry(1, 0.3, 1))
  let districtMats = DISTRICTS.map((d) => neon(DISTRICT_COLOR[d.id] ?? COLOR.edge, 0.55))
  const districtBars: THREE.Mesh[][] = []
  for (let i = 0; i < DISTRICTS.length; i++) {
    const d = DISTRICTS[i]!
    const y = d.id === 'etcd' ? CITY.pit.floorY + 0.2 : groundY(d.center[0], d.center[2]) + 0.16
    const bars: THREE.Mesh[] = []
    const bar = (cx: number, cz: number, sx: number, sz: number): void => {
      const m = new THREE.Mesh(barGeo, districtMats[i]!)
      m.name = `district-mark:${d.id}`
      m.scale.set(sx, 1, sz)
      m.position.set(cx, y, cz)
      bars.push(m)
      group.add(m)
    }
    const x0 = d.center[0] - d.hx
    const x1 = d.center[0] + d.hx
    const z0 = d.center[2] - d.hz
    const z1 = d.center[2] + d.hz
    /* A marking is paint on a surface. Where there is no surface — over the
     * excavation, or over the road cut through the boundary — it is omitted
     * rather than left floating. */
    const blockers: Rect[] = []
    if (y > CITY.pit.wallTop) blockers.push(PIT_RECT)
    if (y > 1) blockers.push(CUT_RECT)
    for (const cz of [z0, z1]) {
      let spans: [number, number][] = [[x0, x1]]
      for (const b of blockers) if (cz > b.z0 && cz < b.z1) spans = subtractSpan(spans, b.x0, b.x1)
      for (const [a0, a1] of spans) if (a1 - a0 > 4) bar((a0 + a1) / 2, cz, a1 - a0, 2.2)
    }
    for (const cx of [x0, x1]) {
      let spans: [number, number][] = [[z0, z1]]
      for (const b of blockers) if (cx > b.x0 && cx < b.x1) spans = subtractSpan(spans, b.z0, b.z1)
      for (const [a0, a1] of spans) if (a1 - a0 > 4) bar(cx, (a0 + a1) / 2, 2.2, a1 - a0)
    }
    districtBars.push(bars)
  }

  /* ------------------------------------------------------------ explainers */

  const boundary = ctx.registry.register({
    id: 'ground.cluster-boundary',
    title: 'Cluster boundary and its one gate',
    district: 'client',
    kubeName: 'kube-apiserver endpoint',
    summary:
      'Everything outside reaches the cluster through a single authenticated endpoint; there is no second way in.',
    detail: [
      'A cluster has one front door: the kube-apiserver HTTPS endpoint named in your kubeconfig. kubectl, a CI job, a GitOps agent, a controller and a kubelet all arrive at the same place and are all treated the same way — the connection terminates TLS, the request is given an identity by an authenticator (client certificate, ServiceAccount bearer token, or OIDC id_token), and only then is it authorised.',
      'Nothing else in the cluster is addressable from outside by design. No client talks to etcd, and no client talks to a kubelet to create a Pod. Changing the cluster means writing an object through this door and letting the controllers notice.',
      'That is why the gate is the only opening in the perimeter and why the road descends through it: every arrow in the city starts here.',
    ],
    caveats: [
      'The fence is an authentication boundary, not a firewall. Kubernetes ships no perimeter packet filter; a plain cluster has an open pod network unless NetworkPolicy or a service mesh says otherwise.',
      'Real clusters may expose NodePorts, LoadBalancers and the kubelet read-only port. Those carry traffic, not control: they cannot create or mutate API objects.',
      'The lintel brightens with request rate, which is a scale, not a count.',
    ],
    object: gateLamp,
    focus: [0, 34, GATE_Z - 90],
    keywords: ['kubeconfig', 'TLS', 'authentication', 'apiserver endpoint', 'boundary', 'gate'],
    metrics: (s) => [
      { label: 'requests/s', value: s.api.requestsPerSec.toFixed(1) },
      { label: 'watch connections', value: `${s.api.watchConnections}` },
      { label: 'writes accepted', value: `${s.api.counts.ok}` },
      { label: 'forbidden', value: `${s.api.counts.forbidden}`, hint: 'RBAC denied' },
    ],
  })
  for (const p of gatePylons) ctx.registry.bind(p, boundary)
  for (const r of rails) ctx.registry.bind(r, boundary)
  ctx.registry.bind(postMesh, boundary)
  ctx.registry.bind(panelMesh, boundary)
  /* The cut and its ramps are the door, not the road: they belong to the gate. */
  ctx.registry.bind(rampNorth, boundary)
  ctx.registry.bind(rampSouth, boundary)
  ctx.registry.bind(cutFloor, boundary)

  const excavation = ctx.registry.register({
    id: 'ground.excavation',
    title: 'The excavation',
    district: 'etcd',
    kubeName: 'etcd',
    summary:
      'The ground is cut away over etcd because depth here means durability: memory at grade, fsync\'d disk at the bottom.',
    detail: [
      'Everything at street level is a copy. A controller\'s informer cache, the API server\'s watch cache, kubectl\'s output — all of it is memory reconstructed from a stream of changes, and all of it is thrown away on restart. Losing any of it costs a resync, nothing more.',
      'The walls of the pit run from that volatile grade down to etcd\'s on-disk write-ahead log and bolt database. The layers you pass on the way down are the layers a write passes through: the API server\'s watch cache, etcd\'s in-memory B-tree index that maps a key to its revisions, and finally the WAL and backend file that survive a power cut.',
      'The cut exists so you have to look down to see the only durable copy in the cluster. If the vault is lost, the cluster is lost; every other building can be rebuilt from it.',
    ],
    caveats: [
      'Depth is a metaphor for volatility, not a physical layout. etcd\'s index and its backend live in the same process on the same host.',
      'A real cluster runs 3 or 5 etcd members on separate machines. Here they share one floor so the raft exchange is visible in one shot.',
      'The strata are logical layers, not proportional to bytes or latency.',
    ],
    object: pitFloor,
    focus: [0, 30, CITY.pit.z + 190],
    keywords: ['etcd', 'durability', 'vault', 'pit', 'excavation', 'wal', 'boltdb'],
    metrics: (s) => [
      { label: 'revision', value: `${s.etcd.revision}` },
      { label: 'compacted below', value: `${s.etcd.compactedRevision}` },
      { label: 'db size', value: `${s.etcd.dbSizeMib.toFixed(0)}Mi / ${s.etcd.dbQuotaMib}Mi` },
      { label: 'quorum', value: s.etcd.hasQuorum ? 'yes' : 'LOST' },
    ],
  })
  for (const w of pitWalls) ctx.registry.bind(w, excavation)
  for (const m of strataBelts) ctx.registry.bind(m, excavation)

  const durability = ctx.registry.register({
    id: 'ground.durability-line',
    title: 'The durability line',
    district: 'etcd',
    kubeName: 'raft WAL fsync',
    summary:
      'Below this line a write has been fsync\'d by a quorum and survives a crash; above it, it is only memory.',
    detail: [
      'A write is not accepted when the API server receives it, and not when the leader appends it to its log. It is accepted when a majority of etcd members have appended the entry to their write-ahead log and fsync\'d it to disk. Only then does the leader commit, apply it to the key-space, and hand a resourceVersion back up the pipeline.',
      'This is why etcd is so unforgiving about disk latency: every write costs at least one fsync on a quorum of machines, serialised behind raft ordering. A backing disk with 100 ms fsync does not make the cluster slow, it makes the control plane unable to commit — leader elections start, and the API server begins returning errors on writes while cached reads still succeed.',
      'The line is the boundary the `etcd_disk_wal_fsync_duration_seconds` histogram measures. Watch it while you raise the etcd disk-latency knob.',
    ],
    caveats: [
      'The commit shown is a model of raft, not an implementation. Term changes, log truncation and snapshot transfer are simplified.',
      'Real etcd also fsyncs the backend commit separately from the WAL; only one line is drawn.',
    ],
    object: durabilityBelt,
    focus: [0, DURABILITY_Y + 40, CITY.pit.z + 170],
    keywords: ['fsync', 'wal', 'raft', 'commit', 'quorum', 'durability'],
    metrics: (s) => [
      { label: 'fsync', value: `${s.knobs.etcdFsyncMs.toFixed(0)}ms` },
      { label: 'writes/s', value: s.etcd.writesPerSec.toFixed(1) },
      { label: 'apiserver writable', value: s.api.writable ? 'yes' : 'no' },
    ],
  })

  const split = ctx.registry.register({
    id: 'ground.control-plane-mesa',
    title: 'Control plane and data plane',
    district: 'apiserver',
    kubeName: 'control plane / worker nodes',
    summary:
      'The raised mesa holds the components that decide; the grade below holds the machines that run containers.',
    detail: [
      'The mesa carries kube-apiserver, kube-scheduler, kube-controller-manager and etcd beneath it. None of these runs your workload. They read and write objects, and the only thing they ever do to a Pod is write down which node it belongs on.',
      'The grade below carries the worker nodes: kubelet, the container runtime, kube-proxy, CNI and CSI. These are the only things that start a process, plug in a network interface or mount a volume.',
      'The two planes are joined by exactly one mechanism, not by a network of calls. A kubelet holds a watch open to the API server and reconciles what it sees; it is never told what to do by the scheduler or by a controller. That is why the mesa has one road down to the spine, and why an unreachable control plane leaves running pods running.',
    ],
    caveats: [
      'Control-plane components normally run as pods on control-plane nodes, so the height separation is a role separation, not a hardware one.',
      'Managed clusters hide the mesa entirely: you get the endpoint and never see these machines.',
      'Node components also run on control-plane nodes in a real cluster; here only the grade has them.',
    ],
    object: mesa,
    focus: [0, 190, CITY.mesa.z + 330],
    keywords: ['control plane', 'data plane', 'worker', 'mesa', 'split'],
    metrics: (s) => [
      { label: 'nodes ready', value: `${s.totals.nodesReady} / ${s.nodes.length}` },
      { label: 'pods running', value: `${s.totals.podsRunning}` },
      { label: 'apiserver writable', value: s.api.writable ? 'yes' : 'no' },
    ],
  })
  ctx.registry.bind(apron, split)

  const nodeGrid = ctx.registry.register({
    id: 'ground.node-grid',
    title: 'The node grid',
    district: 'nodes',
    kubeName: 'nodes',
    summary: 'Four blocks of ordinary machines. Everything the cluster actually runs happens here.',
    detail: [
      'A Node is not a Kubernetes component; it is a machine that registered itself. Its object in the API records capacity, allocatable, conditions, taints and a pod CIDR, and it is kept alive by a Lease its kubelet renews every 10 seconds. Delete the Node object and the machine keeps running — it simply re-registers.',
      'Each block is one node with its own kubelet, container runtime, kube-proxy rule table, CNI bridge and CSI plugin, and a grid of pod plots. Pods are placed on plots by the scheduler writing `nodeName`; nothing pushes them here.',
      'The blocks are deliberately identical and interchangeable. That is the point of the grid: a pod is scheduled onto whichever node passes the filters and scores best, and the city should never suggest that any block is special.',
    ],
    caveats: [
      'Four nodes with 12 visible plots each. A real node has 4 GiB–1 TiB of memory and kubelet\'s default cap is 110 pods.',
      'Node capacity here is 4 cores and 8Gi so the whole grid fits one screen and pressure is reachable in seconds.',
      'Control-plane nodes are not drawn as part of the grid.',
    ],
    focus: [0, 150, CITY.node.z + 300],
    keywords: ['node', 'kubelet', 'worker', 'grid', 'block', 'capacity', 'allocatable'],
    metrics: (s) => [
      { label: 'nodes ready', value: `${s.totals.nodesReady} / ${s.nodes.length}` },
      {
        label: 'cpu requested',
        value: `${((s.totals.cpuRequestedMilli / Math.max(1, s.totals.cpuAllocatableMilli)) * 100).toFixed(0)}%`,
        hint: 'of allocatable — requests schedule, not usage',
      },
      {
        label: 'memory requested',
        value: `${((s.totals.memRequestedMib / Math.max(1, s.totals.memAllocatableMib)) * 100).toFixed(0)}%`,
        hint: 'of allocatable',
      },
      { label: 'pods pending', value: `${s.totals.podsPending}` },
    ],
  })

  const roads = ctx.registry.register({
    id: 'ground.roads',
    title: 'The road network',
    district: 'apiserver',
    summary:
      'Every road ends at the API server, because every path in Kubernetes does. There is no road between a controller and a node.',
    detail: [
      'The spine runs north–south between the control-plane mesa and the node grid, and it carries the watch stream out and status reports back. Look for what is missing: there is no road from the controller yard to a node block, none from the scheduler to a kubelet, and none from anything to the vault except through the tower.',
      'That absence is the mechanism. The scheduler does not contact a kubelet; it writes `spec.nodeName` on the Pod. The Deployment controller does not start a container; it writes a ReplicaSet. A kubelet learns about its pods because it is watching, not because it was called.',
      'Only two roads bypass the API server, and both carry bytes rather than decisions: the image path from the registry to the nodes, and the volume path from the storage plant. Those are pulls and mounts, and they still only happen because an object said so.',
      'Each district the roads serve has its ground marked in that mechanism\'s own colour, so a place can be identified before anything is built on it.',
    ],
    caveats: [
      'The roads are where flows travel, not physical links. Everything drawn here is HTTPS to one endpoint.',
      'The spine detours around the excavation; in the model, watch traffic crosses above it.',
    ],
    object: roadMesh,
    focus: [0, 210, CITY.node.z - 40],
    keywords: ['road', 'spine', 'watch', 'path', 'topology'],
  })
  ctx.registry.bind(stripeMesh, roads)
  for (const r of mesaRamps) ctx.registry.bind(r, roads)

  const apronEntry = ctx.registry.register({
    id: 'ground.client-apron',
    title: 'Outside the cluster',
    district: 'client',
    kubeName: 'kubectl, CI, GitOps',
    summary: 'Everything on this apron only ever writes desired state. None of it runs anything.',
    detail: [
      'kubectl, a CI pipeline and a GitOps reconciler all do the same thing: they PUT or PATCH an object and stop. `kubectl apply` returns as soon as the object is stored, which is why it can succeed while the workload never becomes ready.',
      'This is the beginning of the loop the whole city is built around. A number is written down here; controllers inside notice the difference between that number and what exists; buildings are constructed until the difference is gone.',
      'The apron is marked in the desired-state colour for that reason. Nothing outside the boundary is ever the actual state of anything.',
    ],
    caveats: [
      'GitOps agents normally run *inside* the cluster and pull from git; they are drawn outside to keep the direction of writes readable.',
      'kubectl also reads: get, describe, logs and exec all come back through the same door.',
    ],
    object: apron,
    focus: [0, 60, ANCHOR.clientTerminal[2] - 120],
    keywords: ['kubectl', 'apply', 'gitops', 'ci', 'desired state', 'client'],
    metrics: (s) => [
      { label: 'desired replicas', value: `${s.knobs.replicas}` },
      { label: 'ready replicas', value: `${s.deployments[0]?.readyReplicas ?? 0}` },
    ],
  })

  /* Every marking resolves to the entry that owns the ground it is painted on,
   * so no piece of this district is unselectable decoration. */
  const markOwner: Partial<Record<DistrictId, Explainer>> = {
    client: apronEntry,
    apiserver: split,
    scheduler: split,
    controllers: split,
    etcd: excavation,
    nodes: nodeGrid,
    network: roads,
    storage: roads,
    registry: roads,
  }
  for (let i = 0; i < DISTRICTS.length; i++) {
    const owner = markOwner[DISTRICTS[i]!.id]
    if (!owner) continue
    for (const b of districtBars[i]!) ctx.registry.bind(b, owner)
  }
  /* The grade itself is the data plane's ground; the grid is how it is scaled.
   * The platform's rim is part of that same ground, not a separate mechanism. */
  ctx.registry.bind(groundMesh, split)
  ctx.registry.bind(gridMinor, split)
  ctx.registry.bind(gridMajor, split)
  ctx.registry.bind(rim, split)

  /* ------------------------------------------------------------ theme flips */

  const offTheme = ctx.bus.on('theme', ({ mode }) => {
    /* Districts are built before main.ts installs its own theme handler, so a
     * district may run first; setMode is idempotent and makes order irrelevant. */
    setMode(mode)
    mats = buildMats()
    for (const s of statics) s.o.material = mats[s.k]
    for (const p of pairStatics) p.o.material = [mats[p.a], mats[p.b]]
    districtMats = DISTRICTS.map((d) => neon(DISTRICT_COLOR[d.id] ?? COLOR.edge, 0.55))
    for (let i = 0; i < districtBars.length; i++) {
      for (const b of districtBars[i]!) b.material = districtMats[i]!
    }
    applyGridColor(mode)
  })
  /* Read the live theme, never a literal: the default lives in core/theme.ts,
   * and hard-coding 'night' here left the grid dark under a daylight city. */
  applyGridColor(getMode())

  /* ----------------------------------------------------------------- update */

  function update(s: SimState, _dt: number): void {
    /* The gate carries every request that will ever change the cluster, so its
     * lintel is the one lit thing on the perimeter. */
    const rps = s.api.requestsPerSec
    gateLamp.material = rps < 5 ? mats.gateIdle : rps < 60 ? mats.gateBusy : mats.gateFlood
  }

  function dispose(): void {
    offTheme()
    minorMat.dispose()
    majorMat.dispose()
    for (const g of geoms) g.dispose()
    geoms.length = 0
    group.removeFromParent()
  }

  return { group, update, dispose }
}

/**
 * Grid lines out to the city extent, split where they would cross the open
 * excavation. `skip` suppresses lines that a coarser grid already draws.
 */
function buildGrid(step: number, skip: number): THREE.BufferGeometry {
  const pts: number[] = []
  /* The grid is paint on the platform, so it stops at the wheel's rim: each
   * line is clipped to the chord the disc allows, then split at the pit. */
  const pushX = (z: number): void => {
    const inside = PLAT_R * PLAT_R - (z - PLAT_CZ) * (z - PLAT_CZ)
    if (inside <= 1) return
    const w = Math.sqrt(inside)
    if (z > PIT_Z0 && z < PIT_Z1) {
      const a1 = Math.min(PIT_X0, w)
      const b0 = Math.max(PIT_X1, -w)
      if (a1 > -w) pts.push(-w, 0, z, a1, 0, z)
      if (w > b0) pts.push(b0, 0, z, w, 0, z)
    } else {
      pts.push(-w, 0, z, w, 0, z)
    }
  }
  const pushZ = (x: number): void => {
    const inside = PLAT_R * PLAT_R - x * x
    if (inside <= 1) return
    const h = Math.sqrt(inside)
    const lo = PLAT_CZ - h
    const hi = PLAT_CZ + h
    if (x > PIT_X0 && x < PIT_X1) {
      const a1 = Math.min(PIT_Z0, hi)
      const b0 = Math.max(PIT_Z1, lo)
      if (a1 > lo) pts.push(x, 0, lo, x, 0, a1)
      if (hi > b0) pts.push(x, 0, b0, x, 0, hi)
    } else {
      pts.push(x, 0, lo, x, 0, hi)
    }
  }
  /* Stepped outward from the origin so the grid is symmetric about the tower
   * and the coarse grid lands on exact multiples of its own spacing. */
  const reach = PLAT_R + Math.abs(PLAT_CZ) + step
  for (let v = 0; v <= reach; v += step) {
    if (skip > 0 && v % skip === 0) continue
    pushX(v)
    pushZ(v)
    if (v > 0) {
      pushX(-v)
      pushZ(-v)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
}
