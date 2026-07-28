import * as THREE from 'three'
import {
  API_STAGES,
  N_ETCD_MEMBERS,
  N_NODES,
  POD_SLOTS_PER_NODE,
  RAFT_LOG_SLOTS,
} from '../core/types'
import type { ApiStage, ControllerId, DistrictId } from '../core/types'

/* ============================================================================
 * THE CITY PLAN
 *
 * One coordinate system for everybody. Y is up, the ground plane is y = 0.
 * North is -Z, east is +X. One world unit is one metre; a person is ~1.75.
 *
 *                              ▲ -Z  (north)
 *      CLIENT TERMINAL     z ≈ -470     kubectl, CI, GitOps — outside
 *      CLUSTER BOUNDARY    z = -400     TLS fence, the only way in
 *      API SERVER TOWER    z = -318     x = 0, nine pipeline floors
 *      SCHEDULER  x = -250              CONTROLLER YARD  x = +250   z = -300
 *      ETCD EXCAVATION     z = -150     x = 0, floor at y = -62
 *      NODE GRID           z = +160     four blocks, x = -255 .. +255
 *      EDGE / INGRESS      z = +400     CoreDNS at x = -200
 *      STORAGE PLANT       x = -430     underground PV park
 *      IMAGE REGISTRY      x = +430
 *                              ▼ +Z  (south)
 *
 * The API server sits at x = 0 because in a real cluster every arrow points at
 * it. etcd is directly south of it and *below* grade, in an excavation, because
 * that is where the ground stops being memory and starts being durable truth.
 *
 * Districts must stay inside their footprint and must read every shared
 * position from ANCHOR or the helpers below. Never hard-code a coordinate that
 * another district also needs — put it here and import it.
 * ==========================================================================*/

export const CITY = {
  /** How far the ground plane and its grid extend. */
  ground: 1800,
  /* The far plane must sit well beyond the establishing shot's camera distance
   * (engine/camera.ts HOME_DIST), or the whole city renders inside the fog and
   * reads as a pale smear instead of a plan. */
  fog: { near: 900, far: 3200 },

  /** The control-plane mesa: raised ground the control plane stands on. */
  mesa: { z: -300, w: 760, d: 300, top: 6 },

  /** The API server tower. Requests enter at the top and sink to storage. */
  api: {
    x: 0,
    z: -318,
    w: 74,
    d: 74,
    /** Lowest pipeline floor's deck height, and the gap between floors. */
    baseY: 16,
    floorGap: 11,
    /** Slab thickness of one pipeline floor. */
    slab: 1.6,
  },

  /**
   * The excavation. The ground plane is cut away over this rectangle so the
   * etcd vault below is visible from the surface. Nothing that lives at y ≈ 0
   * may be placed inside these bounds.
   */
  pit: { x: 0, z: -150, hx: 132, hz: 96, floorY: -62, wallTop: 0 },

  /** etcd raft members stand on the pit floor in an arc facing the tower. */
  etcd: { ringRadius: 76, memberW: 30, memberH: 26 },

  /** One worker-node block. Pods stand on plots inside it. */
  node: {
    z: 160,
    /** Centre-to-centre spacing of the four blocks. */
    pitch: 170,
    w: 150,
    d: 176,
    /** Deck the whole block sits on. */
    top: 1.8,
    /** Pod plot grid inside a block. */
    plot: { cols: 4, rows: 3, pitchX: 26, pitchZ: 30, centerZ: -6 },
  },

  /** Southern edge: where traffic enters the cluster. */
  edge: { z: 400 },

  /** Storage plant, west, partly below grade. */
  storage: { x: -430, z: 60, y: -34, w: 190, d: 260 },

  /** Image registry, east. */
  registry: { x: 430, z: 60, w: 150, d: 200 },
} as const

/* Compile-time guard: the plot grid must hold every pod slot the sim can fill. */
const _plotCapacity: number = CITY.node.plot.cols * CITY.node.plot.rows
if (_plotCapacity < POD_SLOTS_PER_NODE) {
  throw new Error(`node plot grid holds ${_plotCapacity}, need ${POD_SLOTS_PER_NODE}`)
}

/* --------------------------------------------------------------------------
 * Named anchors. `[x, y, z]`.
 * ------------------------------------------------------------------------*/

export const ANCHOR = {
  cityCenter: [0, 10, -40],

  /* Outside the cluster. */
  clientTerminal: [0, 6, -470],
  gitops: [-150, 6, -470],
  ci: [150, 6, -470],
  /** The boundary gate: TLS termination and authentication happen here. */
  clusterGate: [0, 0, -400],

  /* Control plane. */
  apiServer: [CITY.api.x, 0, CITY.api.z],
  apiServerTop: [CITY.api.x, 108, CITY.api.z],
  /** The tower's south door, where every admitted write leaves for etcd. */
  apiStorageDoor: [CITY.api.x, CITY.api.baseY + CITY.api.floorGap, CITY.api.z + 40],
  scheduler: [-250, 0, -300],
  schedulerQueue: [-250, 0, -232],
  controllerYard: [250, 0, -300],
  cloudController: [370, 0, -368],

  /* etcd, in the excavation. */
  etcdVault: [CITY.pit.x, CITY.pit.floorY, CITY.pit.z],
  etcdLeader: [CITY.pit.x, CITY.pit.floorY, CITY.pit.z - 40],
  raftLog: [CITY.pit.x, CITY.pit.floorY + 4, CITY.pit.z + 52],

  /* Data plane. */
  nodeGrid: [0, 0, CITY.node.z],
  /** The spine road running north-south between control plane and nodes. */
  spineNorth: [0, 0, -60],
  spineSouth: [0, 0, CITY.node.z - 120],

  /* Edge. */
  ingress: [0, 0, CITY.edge.z],
  loadBalancer: [0, 0, CITY.edge.z + 90],
  coreDns: [-200, 0, CITY.edge.z - 20],
  externalClients: [0, 8, CITY.edge.z + 190],

  /* Storage and registry. */
  storagePlant: [CITY.storage.x, CITY.storage.y, CITY.storage.z],
  pvPark: [CITY.storage.x, CITY.storage.y, CITY.storage.z + 110],
  imageRegistry: [CITY.registry.x, 0, CITY.registry.z],
} as const satisfies Record<string, readonly [number, number, number]>

export type AnchorId = keyof typeof ANCHOR

/** Anchor as a fresh Vector3. Never returns a shared instance. */
export function anchor(id: AnchorId): THREE.Vector3 {
  const a = ANCHOR[id]
  return new THREE.Vector3(a[0], a[1], a[2])
}

/** Write an anchor into a caller-owned vector. Allocates nothing. */
export function anchorInto(id: AnchorId, out: THREE.Vector3): THREE.Vector3 {
  const a = ANCHOR[id]
  return out.set(a[0], a[1], a[2])
}

/* --------------------------------------------------------------------------
 * The API server tower. Nine floors, one per pipeline stage, top to bottom in
 * request order: a write physically sinks through admission into the vault.
 * ------------------------------------------------------------------------*/

/** Deck height of a pipeline stage's floor. `tls` is highest, `response` lowest. */
export function apiFloorY(stage: ApiStage): number {
  const i = API_STAGES.indexOf(stage)
  if (i < 0) throw new Error(`unknown API stage: ${stage}`)
  /* API_STAGES runs tls -> response; floors descend, so invert the index. */
  return CITY.api.baseY + (API_STAGES.length - 1 - i) * CITY.api.floorGap
}

/** Centre of a pipeline floor, in world space. */
export function apiFloorPos(stage: ApiStage, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(CITY.api.x, apiFloorY(stage), CITY.api.z)
}

export const API_TOWER_TOP = CITY.api.baseY + (API_STAGES.length - 1) * CITY.api.floorGap

/* --------------------------------------------------------------------------
 * etcd members, arranged in an arc on the pit floor facing the tower.
 * ------------------------------------------------------------------------*/

export function etcdMemberPos(i: number, out = new THREE.Vector3()): THREE.Vector3 {
  /* Spread across a 140-degree arc opening north, toward the API server. */
  const spread = (140 * Math.PI) / 180
  const members: number = N_ETCD_MEMBERS
  const t = members === 1 ? 0.5 : i / (members - 1)
  const a = -Math.PI / 2 - spread / 2 + t * spread
  return out.set(
    CITY.pit.x + Math.cos(a) * CITY.etcd.ringRadius,
    CITY.pit.floorY,
    CITY.pit.z + Math.sin(a) * CITY.etcd.ringRadius,
  )
}

/** One slot in the raft log conveyor running along the pit's south wall. */
export function raftLogSlotPos(slot: number, out = new THREE.Vector3()): THREE.Vector3 {
  const span = CITY.pit.hx * 1.5
  const x = -span / 2 + (slot / Math.max(1, RAFT_LOG_SLOTS - 1)) * span
  return out.set(CITY.pit.x + x, CITY.pit.floorY + 5, CITY.pit.z + 58)
}

/** True when a surface-level position would fall into the open excavation. */
export function inPit(x: number, z: number, margin = 0): boolean {
  return (
    Math.abs(x - CITY.pit.x) < CITY.pit.hx + margin &&
    Math.abs(z - CITY.pit.z) < CITY.pit.hz + margin
  )
}

/* --------------------------------------------------------------------------
 * The controller yard. One machine per reconcile loop, in a grid.
 * ------------------------------------------------------------------------*/

export const CONTROLLER_ORDER: readonly ControllerId[] = [
  'deployment',
  'replicaset',
  'statefulset',
  'daemonset',
  'job',
  'cronjob',
  'node',
  'endpointslice',
  'pv-binder',
  'hpa',
  'garbage-collector',
  'namespace',
  'serviceaccount',
] as const

const YARD_COLS = 3
const YARD_PITCH_X = 46
const YARD_PITCH_Z = 40

export function controllerPos(id: ControllerId, out = new THREE.Vector3()): THREE.Vector3 {
  const i = CONTROLLER_ORDER.indexOf(id)
  if (i < 0) throw new Error(`unknown controller: ${id}`)
  const col = i % YARD_COLS
  const row = Math.floor(i / YARD_COLS)
  const rows = Math.ceil(CONTROLLER_ORDER.length / YARD_COLS)
  const a = ANCHOR.controllerYard
  return out.set(
    a[0] + (col - (YARD_COLS - 1) / 2) * YARD_PITCH_X,
    a[1],
    a[2] + (row - (rows - 1) / 2) * YARD_PITCH_Z,
  )
}

/* --------------------------------------------------------------------------
 * Worker nodes. A block, its pod plots, and its fixed machinery.
 * ------------------------------------------------------------------------*/

/** Centre of node block `i` at grade. */
export function nodeAnchor(i: number, out = new THREE.Vector3()): THREE.Vector3 {
  const x = (i - (N_NODES - 1) / 2) * CITY.node.pitch
  return out.set(x, 0, CITY.node.z)
}

export function nodeBounds(i: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const x = (i - (N_NODES - 1) / 2) * CITY.node.pitch
  return {
    minX: x - CITY.node.w / 2,
    maxX: x + CITY.node.w / 2,
    minZ: CITY.node.z - CITY.node.d / 2,
    maxZ: CITY.node.z + CITY.node.d / 2,
  }
}

/**
 * Where pod `slot` stands inside node `i`. Slots fill left-to-right, back-to-
 * front, so a scaling Deployment grows in a readable direction.
 */
export function podPlotPos(nodeIndex: number, slot: number, out = new THREE.Vector3()): THREE.Vector3 {
  const p = CITY.node.plot
  const col = slot % p.cols
  const row = Math.floor(slot / p.cols)
  const base = nodeAnchor(nodeIndex, out)
  return out.set(
    base.x + (col - (p.cols - 1) / 2) * p.pitchX,
    CITY.node.top,
    base.z + p.centerZ + (row - (p.rows - 1) / 2) * p.pitchZ,
  )
}

/** Fixed machinery inside every node block, in block-local offsets. */
export const NODE_PARTS = {
  /** The foreman's office: kubelet's sync loop and its Lease beacon. */
  kubelet: [-60, 0, -74],
  /** Container runtime workshop — CRI, image snapshotter, runc. */
  runtime: [-60, 0, -18],
  /** kube-proxy's rule table cabinet. */
  proxy: [60, 0, -74],
  /** CSI node plugin: the plumbing riser. */
  csi: [60, 0, -18],
  /** CNI bridge along the block's south edge, where pod veths land. */
  cni: [0, 0, 76],
  /** cAdvisor / metrics meter on the block's east face. */
  metrics: [60, 0, 40],
} as const satisfies Record<string, readonly [number, number, number]>

export type NodePartId = keyof typeof NODE_PARTS

/** World position of a node's fixed machinery. */
export function nodePartPos(
  nodeIndex: number,
  part: NodePartId,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const off = NODE_PARTS[part]
  const base = nodeAnchor(nodeIndex, out)
  return out.set(base.x + off[0], off[1], base.z + off[2])
}

/* --------------------------------------------------------------------------
 * District bounds, used by the overview camera, fog, search and the minimap.
 * ------------------------------------------------------------------------*/

export interface DistrictBounds {
  id: DistrictId
  label: string
  center: readonly [number, number, number]
  /** Half-extents on x and z. */
  hx: number
  hz: number
}

export const DISTRICTS: readonly DistrictBounds[] = [
  { id: 'client', label: 'Clients', center: ANCHOR.clientTerminal, hx: 260, hz: 70 },
  { id: 'apiserver', label: 'API server', center: ANCHOR.apiServer, hx: 90, hz: 90 },
  { id: 'etcd', label: 'etcd', center: ANCHOR.etcdVault, hx: CITY.pit.hx, hz: CITY.pit.hz },
  { id: 'scheduler', label: 'Scheduler', center: ANCHOR.scheduler, hx: 110, hz: 110 },
  { id: 'controllers', label: 'Controllers', center: ANCHOR.controllerYard, hx: 110, hz: 110 },
  { id: 'nodes', label: 'Nodes', center: ANCHOR.nodeGrid, hx: (N_NODES * CITY.node.pitch) / 2, hz: CITY.node.d / 2 },
  { id: 'network', label: 'Network edge', center: ANCHOR.ingress, hx: 300, hz: 140 },
  { id: 'storage', label: 'Storage', center: ANCHOR.storagePlant, hx: CITY.storage.w / 2, hz: CITY.storage.d / 2 },
  { id: 'registry', label: 'Registry', center: ANCHOR.imageRegistry, hx: CITY.registry.w / 2, hz: CITY.registry.d / 2 },
] as const

/* --------------------------------------------------------------------------
 * Routes. Named polylines the flow engine animates packets along. Every
 * cross-district path lives here so two districts cannot disagree about where
 * the road between them runs.
 * ------------------------------------------------------------------------*/

export type RouteId =
  | 'client-to-api'
  | 'api-to-etcd'
  | 'etcd-to-api'
  | 'api-to-scheduler'
  | 'api-to-controllers'
  | 'controllers-to-api'
  | 'scheduler-to-api'
  | 'api-to-nodes'
  | 'nodes-to-api'
  | 'registry-to-nodes'
  | 'storage-to-nodes'
  | 'ingress-to-nodes'
  | 'external-to-ingress'

export interface RouteDef {
  id: RouteId
  /** Polyline in world space. The flow engine interpolates along it. */
  points: readonly (readonly [number, number, number])[]
  /** What travels here — picks the flow's colour and glyph. */
  kind: 'request' | 'watch' | 'raft' | 'bind' | 'image' | 'volume' | 'traffic'
}

const A = ANCHOR

export const ROUTES: readonly RouteDef[] = [
  {
    id: 'client-to-api',
    kind: 'request',
    points: [A.clientTerminal, A.clusterGate, [0, apiFloorY('tls'), CITY.api.z - 60], [0, apiFloorY('tls'), CITY.api.z]],
  },
  {
    id: 'api-to-etcd',
    kind: 'raft',
    points: [A.apiStorageDoor, [0, apiFloorY('storage') - 6, CITY.api.z + 60], [0, -30, CITY.pit.z - 70], A.etcdLeader],
  },
  {
    id: 'etcd-to-api',
    kind: 'watch',
    points: [A.etcdLeader, [0, -20, CITY.pit.z - 70], [0, apiFloorY('storage'), CITY.api.z + 50], A.apiStorageDoor],
  },
  {
    id: 'api-to-scheduler',
    kind: 'watch',
    points: [[0, apiFloorY('response'), CITY.api.z], [-140, 40, -310], [A.scheduler[0], 34, A.scheduler[2]]],
  },
  {
    id: 'api-to-controllers',
    kind: 'watch',
    points: [[0, apiFloorY('response'), CITY.api.z], [140, 40, -310], [A.controllerYard[0], 34, A.controllerYard[2]]],
  },
  {
    id: 'controllers-to-api',
    kind: 'request',
    points: [[A.controllerYard[0], 30, A.controllerYard[2] - 40], [120, 46, -350], [0, apiFloorY('tls'), CITY.api.z]],
  },
  {
    id: 'scheduler-to-api',
    kind: 'bind',
    points: [[A.scheduler[0], 30, A.scheduler[2] - 40], [-120, 46, -350], [0, apiFloorY('tls'), CITY.api.z]],
  },
  {
    id: 'api-to-nodes',
    kind: 'watch',
    points: [[0, apiFloorY('response'), CITY.api.z + 40], A.spineNorth, A.spineSouth, A.nodeGrid],
  },
  {
    id: 'nodes-to-api',
    kind: 'request',
    points: [A.nodeGrid, A.spineSouth, A.spineNorth, [0, apiFloorY('tls'), CITY.api.z]],
  },
  {
    id: 'registry-to-nodes',
    kind: 'image',
    points: [A.imageRegistry, [CITY.registry.x - 120, 20, CITY.node.z], A.nodeGrid],
  },
  {
    id: 'storage-to-nodes',
    kind: 'volume',
    points: [A.storagePlant, [CITY.storage.x + 130, -20, CITY.node.z], A.nodeGrid],
  },
  {
    id: 'ingress-to-nodes',
    kind: 'traffic',
    points: [A.ingress, [0, 6, CITY.edge.z - 90], A.nodeGrid],
  },
  {
    id: 'external-to-ingress',
    kind: 'traffic',
    points: [A.externalClients, A.loadBalancer, A.ingress],
  },
] as const

const ROUTE_BY_ID = new Map<RouteId, RouteDef>(ROUTES.map((r) => [r.id, r]))

export function route(id: RouteId): RouteDef {
  const r = ROUTE_BY_ID.get(id)
  if (!r) throw new Error(`unknown route: ${id}`)
  return r
}

/** Build a THREE.CatmullRomCurve3 for a route. Call once at build time. */
export function routeCurve(id: RouteId): THREE.CatmullRomCurve3 {
  const pts = route(id).points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.25)
}
