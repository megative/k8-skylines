import * as THREE from 'three'
import {
  CONTAINER_SLOTS_PER_POD,
  N_NODES,
  POD_SLOTS_PER_NODE,
  TIMING,
} from '../core/types'
import type {
  ContainerState,
  Explainer,
  PodState,
  SimState,
} from '../core/types'
import { COLOR, ghost, mat, neon, structural } from '../core/theme'
import { clamp, formatAge, formatCpu, formatMem, formatPercent, approach } from '../core/util'
import { ANCHOR, CITY, podPlotPos } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE POD DISTRICT — lots, not buildings.
 *
 * A Pod is not a container. It is a *lot* with utilities: one network namespace
 * (one IP for everything on it), one IPC namespace, and a shared volume set.
 * The pause/sandbox container is the lot itself — so the lot only becomes solid
 * matter once the kubelet has actually run RunPodSandbox and the CNI has handed
 * back an IP. Until then the lot is a hologram: a record in etcd, nothing on
 * the node. Containers are separate structures standing on the lot.
 *
 * The grammar used everywhere below:
 *   ghost()  = something declared  (spec: replicas, requests, limits, a
 *              container that does not exist yet)
 *   solid    = something that exists (matter: a running process, a sandbox)
 * A ghost never becomes solid by itself; a controller has to build it.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * Local geometry of one lot. Plot pitch is 26 x 30 (CITY.node.plot), so the lot
 * must stay inside that or neighbouring pods touch.
 * -------------------------------------------------------------------------*/

const LOT_W = 21
const LOT_D = 24
const SLAB_H = 0.9

/** World height that represents "at the memory limit". Usage rises toward it. */
const H_LIMIT = 9
/** Reference used when a container declares no limit — BestEffort has none. */
const MEM_REF_MIB = 1024
const CPU_REF_MILLI = 1000

const ROW_INIT_Z = -7.4
const ROW_APP_Z = 5.2

const BUILD_SECONDS = 0.8
const COLLAPSE_SECONDS = 0.55

/** Pods with no nodeName park here: north of the blocks, above the ground. */
const YARD_Z = ANCHOR.spineSouth[2] - 14
const YARD_Y = 3.0
const YARD_SLOTS = 12
const YARD_PITCH = 46

/** Desired-but-not-yet-existing replicas hover further north, and higher. */
const GHOST_Z = ANCHOR.spineSouth[2] - 46
const GHOST_Y = 11
const GHOST_SLOTS = 16
const GHOST_PITCH = 34

/* Plate (the address plaque on every lot) — drawn on a canvas, never remote. */
const PLATE_PX_W = 256
const PLATE_PX_H = 84
const PLATE_W = 15
const PLATE_H = 4.92
const CSS_BG = 'rgba(6,9,15,0.78)'
const CSS_TEXT = '#e8eef6'
const CSS_DIM = '#8fa0b8'
const CSS_NET = '#ff5fd2'
const CSS_PENDING = '#ffc14d'
const CSS_RUNNING = '#fff1d6'
const CSS_READY = '#4fe08a'
const CSS_FAILED = '#ff4d5e'
const CSS_TERM = '#a88bd6'
const FONT_NAME = '700 21px ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT_SMALL = '500 17px ui-monospace, SFMono-Regular, Menlo, monospace'
const NONE = '<none>'

/* Number-to-string tables: update() must never build a string. */
const RESTART_STR: string[] = []
const REV_STR: string[] = []
for (let i = 0; i < 128; i++) {
  RESTART_STR.push(`restarts ${i}`)
  REV_STR.push(`rev ${i}`)
}

/* ---------------------------------------------------------------------------
 * Pooled objects.
 * -------------------------------------------------------------------------*/

interface Plate {
  mesh: THREE.Mesh
  canvas: HTMLCanvasElement
  ctx2d: CanvasRenderingContext2D
  tex: THREE.CanvasTexture
  matl: THREE.MeshBasicMaterial
}

interface Unit {
  group: THREE.Group
  /** Declared request: a hologram at the request level, sized by the request. */
  reqPad: THREE.Mesh
  /** Declared limit: the ceiling. Hidden when the container declares none. */
  limitCeil: THREE.Mesh
  /** The container as specified but not yet created. */
  ghostTower: THREE.Mesh
  /** The container as it actually exists. Height tracks memory usage. */
  tower: THREE.Mesh
  lamp: THREE.Mesh
  cpuTrack: THREE.Mesh
  cpuFill: THREE.Mesh
  /** Backoff: track length is the interval (doubling), fill is the countdown. */
  backTrack: THREE.Mesh
  backFill: THREE.Mesh
  probeBar: THREE.Mesh
  tally: THREE.Mesh
  /** Eased so towers move instead of teleporting. */
  h: number
  cpu: number
  /** Seconds left of the OOM-kill flash. */
  flash: number
  boundId: string
}

interface Lot {
  group: THREE.Group
  slab: THREE.Mesh
  kerb: THREE.Mesh
  ipPost: THREE.Mesh
  ipLamp: THREE.Mesh
  riser: THREE.Mesh
  condPost: THREE.Mesh
  cond: THREE.Mesh[]
  qos: THREE.Mesh[]
  beacon: THREE.Mesh
  revBand: THREE.Mesh
  termTrack: THREE.Mesh
  termFill: THREE.Mesh
  units: Unit[]
  plate: Plate | null

  uid: string | null
  nodeIndex: number
  slot: number
  touched: number
  build: number
  dying: number
  wasTerminating: boolean
  rosterSig: number
  /** Plate cache — the canvas is redrawn only when one of these changes. */
  pName: string
  pIp: string
  pPhase: string
  pRestarts: number
  pRev: number
  pReady: boolean
}

interface GhostSlot {
  group: THREE.Group
  pad: THREE.Mesh
  tower: THREE.Mesh
  cap: THREE.Mesh
  a: number
}

interface Palette {
  slabGhost: THREE.Material
  slabSolid: THREE.Material
  slabTerm: THREE.Material
  kerbOn: THREE.Material
  kerbOff: THREE.Material
  ipOn: THREE.Material
  ipOff: THREE.Material
  riserOn: THREE.Material
  riserOff: THREE.Material
  post: THREE.Material
  condOn: THREE.Material
  condOff: THREE.Material
  qosOff: THREE.Material
  qosLit: THREE.Material[]
  beacon: THREE.Material[]
  revNew: THREE.Material
  revOld: THREE.Material
  reqPad: THREE.Material
  limitCeil: THREE.Material
  limitBreach: THREE.Material
  ghostTower: THREE.Material
  towerNew: THREE.Material
  towerOld: THREE.Material
  towerPull: THREE.Material
  towerDone: THREE.Material
  towerDim: THREE.Material
  lampReady: THREE.Material
  lampWait: THREE.Material
  lampBackoff: THREE.Material
  lampFail: THREE.Material
  lampDone: THREE.Material
  lampThrottle: THREE.Material
  lampOff: THREE.Material
  cpuTrack: THREE.Material
  cpuTrackCapped: THREE.Material
  cpuFill: THREE.Material
  cpuFillThrottled: THREE.Material
  backTrack: THREE.Material
  backFill: THREE.Material
  probeWarn: THREE.Material
  probeFail: THREE.Material
  tally: THREE.Material
}

/* Beacon material index == PodPhase, in a fixed order. */
const PHASE_PENDING = 0
const PHASE_RUNNING = 1
const PHASE_SUCCEEDED = 2
const PHASE_FAILED = 3
const PHASE_UNKNOWN = 4
const PHASE_TERMINATING = 5

/* ---------------------------------------------------------------------------
 * Pod predicates. These mirror the real controller-side filters, because the
 * whole desired-vs-actual animation depends on counting exactly what the
 * ReplicaSet controller counts.
 * -------------------------------------------------------------------------*/

/**
 * kubernetes/pkg/api/v1/pod.IsPodActive: a pod being deleted, or already
 * finished, does not count toward a controller's replica total. That is why the
 * ghost lights the instant you `kubectl delete pod`, while the doomed pod is
 * still draining its grace period.
 */
function isActive(p: PodState): boolean {
  return p.deletionGraceSeconds === undefined && p.phase !== 'Succeeded' && p.phase !== 'Failed'
}

function memRef(c: ContainerState): number {
  return c.limitMemMib > 0 ? c.limitMemMib : MEM_REF_MIB
}

function cpuRef(c: ContainerState): number {
  return c.limitCpuMilli > 0 ? c.limitCpuMilli : CPU_REF_MILLI
}

/* ==========================================================================*/

export function createPods(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'pods'

  /* -- geometry, built once and shared by every pooled object -------------- */
  const gBox = new THREE.BoxGeometry(1, 1, 1)
  const gPillar = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const gLamp = new THREE.IcosahedronGeometry(0.5, 1)
  const gCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 10).translate(0, 0.5, 0)
  const gPlate = new THREE.PlaneGeometry(PLATE_W, PLATE_H)
  const owned: THREE.BufferGeometry[] = [gBox, gPillar, gLamp, gCyl, gPlate]
  const plateMaterials: THREE.MeshBasicMaterial[] = []
  const plateTextures: THREE.CanvasTexture[] = []

  /* -- palette ------------------------------------------------------------ */
  let P = resolvePalette()

  function resolvePalette(): Palette {
    return {
      slabGhost: ghost(COLOR.desired, 0.2),
      slabSolid: mat(structural('concrete'), 0.86),
      slabTerm: mat(COLOR.terminating, 0.9),
      kerbOn: neon(COLOR.network, 1.5),
      kerbOff: mat(COLOR.edge, 0.95),
      ipOn: neon(COLOR.network, 2.2),
      ipOff: mat(COLOR.edge, 0.95),
      riserOn: neon(COLOR.storage, 1.4),
      riserOff: mat(structural('deck'), 0.9),
      post: mat(COLOR.edge, 0.9),
      condOn: neon(COLOR.ready, 1.9),
      condOff: mat(COLOR.edge, 0.95),
      qosOff: mat(COLOR.edge, 0.95),
      /* Brighter == evicted sooner. Guaranteed, Burstable, BestEffort. */
      qosLit: [neon(COLOR.terminating, 0.8), neon(COLOR.terminating, 1.5), neon(COLOR.terminating, 2.4)],
      beacon: [
        neon(COLOR.pending, 1.8),
        neon(COLOR.actual, 1.2),
        neon(COLOR.ready, 1.6),
        neon(COLOR.failed, 2.2),
        neon(COLOR.edge, 0.6),
        neon(COLOR.terminating, 2.0),
      ],
      revNew: neon(COLOR.desired, 1.7),
      revOld: mat(COLOR.edge, 0.9),
      /* requests and limits are *declarations*, so they are holograms. */
      reqPad: ghost(COLOR.scheduler, 0.24),
      limitCeil: ghost(COLOR.failed, 0.16),
      limitBreach: neon(COLOR.failed, 2.6),
      ghostTower: ghost(COLOR.desired, 0.22),
      towerNew: mat(COLOR.actual, 0.72),
      towerOld: mat(COLOR.edge, 0.8),
      towerPull: mat(COLOR.image, 0.6),
      towerDone: mat(COLOR.ready, 0.9),
      towerDim: mat(COLOR.terminating, 0.95),
      lampReady: neon(COLOR.ready, 2.0),
      lampWait: neon(COLOR.pending, 1.8),
      lampBackoff: neon(COLOR.backoff, 2.2),
      lampFail: neon(COLOR.failed, 2.4),
      lampDone: neon(COLOR.ready, 1.0),
      lampThrottle: neon(COLOR.throttled, 2.2),
      lampOff: mat(COLOR.edge, 0.95),
      cpuTrack: mat(COLOR.edge, 0.9),
      cpuTrackCapped: neon(COLOR.throttled, 1.1),
      cpuFill: neon(COLOR.actual, 1.1),
      cpuFillThrottled: neon(COLOR.throttled, 2.4),
      backTrack: mat(COLOR.backoff, 0.95),
      backFill: neon(COLOR.backoff, 2.0),
      probeWarn: neon(COLOR.pending, 1.6),
      probeFail: neon(COLOR.failed, 2.2),
      tally: neon(COLOR.backoff, 1.2),
    }
  }

  /* -- explainers --------------------------------------------------------- */
  const E = registerExplainers(ctx)

  /* -- pools -------------------------------------------------------------- */
  const allLots: Lot[] = []
  const nodeLots: Lot[][] = []
  const yardLots: Lot[] = []
  const ghosts: GhostSlot[] = []
  const lotByUid = new Map<string, Lot>()

  for (let n = 0; n < N_NODES; n++) {
    const row: Lot[] = []
    for (let s = 0; s < POD_SLOTS_PER_NODE; s++) {
      const lot = buildLot(n, s)
      row.push(lot)
      allLots.push(lot)
    }
    nodeLots.push(row)
  }
  for (let i = 0; i < YARD_SLOTS; i++) {
    const lot = buildLot(-1, i)
    yardLots.push(lot)
    allLots.push(lot)
  }
  for (let i = 0; i < GHOST_SLOTS; i++) ghosts.push(buildGhost(i))

  /* -- scratch ------------------------------------------------------------ */
  const rsToDep = new Map<string, string>()
  const cntByDep = new Map<string, number>()
  const cntBySts = new Map<string, number>()

  let cur: SimState | null = null
  let curDt = 0
  let frame = 0
  let clock = 0
  let maxRevision = 0
  let ghostCount = 0

  /* ------------------------------------------------------------------ build */

  function buildUnit(): Unit {
    const g = new THREE.Group()

    const reqPad = new THREE.Mesh(gBox, P.reqPad)
    const limitCeil = new THREE.Mesh(gBox, P.limitCeil)
    const ghostTower = new THREE.Mesh(gPillar, P.ghostTower)
    const tower = new THREE.Mesh(gPillar, P.towerNew)
    const lamp = new THREE.Mesh(gLamp, P.lampOff)
    const cpuTrack = new THREE.Mesh(gPillar, P.cpuTrack)
    const cpuFill = new THREE.Mesh(gPillar, P.cpuFill)
    const backTrack = new THREE.Mesh(gBox, P.backTrack)
    const backFill = new THREE.Mesh(gBox, P.backFill)
    const probeBar = new THREE.Mesh(gPillar, P.probeWarn)
    const tally = new THREE.Mesh(gBox, P.tally)

    limitCeil.scale.set(5.4, 0.14, 5.4)
    cpuTrack.position.set(2.4, 0, 0)
    cpuTrack.scale.set(0.45, H_LIMIT, 0.45)
    cpuFill.position.set(2.4, 0, 0)
    cpuFill.scale.set(0.62, 0.01, 0.62)
    backTrack.position.set(0, 0.18, 3.1)
    backTrack.scale.set(1, 0.22, 0.42)
    backFill.position.set(0, 0.4, 3.1)
    backFill.scale.set(1, 0.3, 0.5)
    probeBar.position.set(-2.2, 0, 0)
    probeBar.scale.set(0.5, 0.01, 0.5)
    tally.position.set(0, 0.16, -2.9)
    tally.scale.set(0.1, 0.2, 0.4)

    g.add(reqPad, limitCeil, ghostTower, tower, lamp, cpuTrack, cpuFill, backTrack, backFill, probeBar, tally)

    ctx.registry.bind(reqPad, E.resources)
    ctx.registry.bind(limitCeil, E.resources)
    ctx.registry.bind(cpuTrack, E.throttle)
    ctx.registry.bind(cpuFill, E.throttle)
    ctx.registry.bind(backTrack, E.crashloop)
    ctx.registry.bind(backFill, E.crashloop)
    ctx.registry.bind(probeBar, E.probes)
    ctx.registry.bind(lamp, E.states)
    ctx.registry.bind(tally, E.crashloop)
    ctx.registry.bind(ghostTower, E.states)
    ctx.registry.bind(tower, E.states)

    return {
      group: g,
      reqPad,
      limitCeil,
      ghostTower,
      tower,
      lamp,
      cpuTrack,
      cpuFill,
      backTrack,
      backFill,
      probeBar,
      tally,
      h: 0,
      cpu: 0,
      flash: 0,
      boundId: E.states.id,
    }
  }

  function buildPlate(): Plate | null {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = PLATE_PX_W
    canvas.height = PLATE_PX_H
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return null
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const matl = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    matl.toneMapped = false
    plateMaterials.push(matl)
    plateTextures.push(tex)
    const mesh = new THREE.Mesh(gPlate, matl)
    mesh.position.set(0, 3.4, LOT_D / 2 + 0.4)
    mesh.rotation.x = -0.22
    return { mesh, canvas, ctx2d, tex, matl }
  }

  function buildLot(nodeIndex: number, slot: number): Lot {
    const g = new THREE.Group()

    const slab = new THREE.Mesh(gBox, P.slabSolid)
    slab.scale.set(LOT_W, SLAB_H, LOT_D)
    slab.position.y = SLAB_H / 2

    /* The kerb is a light strip under the slab: the shared network namespace
     * wrapping everything that stands on the lot. It only lights once the CNI
     * has returned an IP, because before that there is no namespace to share. */
    const kerb = new THREE.Mesh(gBox, P.kerbOff)
    kerb.scale.set(LOT_W + 1.6, 0.42, LOT_D + 1.6)
    kerb.position.y = 0.21

    const ipPost = new THREE.Mesh(gCyl, P.post)
    ipPost.scale.set(0.5, 4.2, 0.5)
    ipPost.position.set(-LOT_W / 2 + 1.6, SLAB_H, LOT_D / 2 - 1.6)
    const ipLamp = new THREE.Mesh(gLamp, P.ipOff)
    ipLamp.scale.setScalar(1.5)
    ipLamp.position.set(ipPost.position.x, SLAB_H + 4.6, ipPost.position.z)

    /* Shared utilities riser: the volumes and IPC every container on the lot
     * mounts through the sandbox. Lit when the pod actually claims a volume. */
    const riser = new THREE.Mesh(gCyl, P.riserOff)
    riser.scale.set(1.5, 2.4, 1.5)
    riser.position.set(LOT_W / 2 - 2.4, SLAB_H, LOT_D / 2 - 2.6)

    const condPost = new THREE.Mesh(gCyl, P.post)
    condPost.scale.set(0.34, 6.2, 0.34)
    condPost.position.set(-LOT_W / 2 + 1.6, SLAB_H, -LOT_D / 2 + 1.8)
    const cond: THREE.Mesh[] = []
    for (let i = 0; i < 4; i++) {
      const l = new THREE.Mesh(gLamp, P.condOff)
      l.scale.setScalar(1.15)
      l.position.set(condPost.position.x, SLAB_H + 1.6 + i * 1.5, condPost.position.z)
      cond.push(l)
      g.add(l)
    }

    const qos: THREE.Mesh[] = []
    for (let i = 0; i < 3; i++) {
      const q = new THREE.Mesh(gPillar, P.qosOff)
      q.scale.set(1.1, 2.6 - i * 0.7, 1.1)
      q.position.set(LOT_W / 2 - 5.6 + i * 1.6, SLAB_H, -LOT_D / 2 + 1.8)
      qos.push(q)
      g.add(q)
    }

    const beacon = new THREE.Mesh(gLamp, P.beacon[PHASE_PENDING])
    beacon.scale.setScalar(1.9)
    beacon.position.set(LOT_W / 2 - 1.8, SLAB_H + 1.6, -LOT_D / 2 + 1.8)

    const revBand = new THREE.Mesh(gBox, P.revOld)
    revBand.scale.set(LOT_W * 0.5, 0.3, 0.55)
    revBand.position.set(0, SLAB_H + 0.1, -LOT_D / 2 + 1.1)

    const termTrack = new THREE.Mesh(gBox, P.backTrack)
    termTrack.scale.set(LOT_W - 4, 0.22, 0.5)
    termTrack.position.set(0, SLAB_H + 0.1, LOT_D / 2 - 1.2)
    const termFill = new THREE.Mesh(gBox, P.beacon[PHASE_TERMINATING])
    termFill.scale.set(0.01, 0.3, 0.62)
    termFill.position.set(0, SLAB_H + 0.22, LOT_D / 2 - 1.2)

    g.add(slab, kerb, ipPost, ipLamp, riser, condPost, beacon, revBand, termTrack, termFill)

    const units: Unit[] = []
    for (let i = 0; i < CONTAINER_SLOTS_PER_POD; i++) {
      const u = buildUnit()
      u.group.position.y = SLAB_H
      units.push(u)
      g.add(u.group)
    }

    const plate = buildPlate()
    if (plate) g.add(plate.mesh)

    ctx.registry.bind(slab, E.sandbox)
    ctx.registry.bind(kerb, E.netns)
    ctx.registry.bind(ipPost, E.netns)
    ctx.registry.bind(ipLamp, E.netns)
    ctx.registry.bind(riser, E.sandbox)
    ctx.registry.bind(condPost, E.conditions)
    for (let i = 0; i < cond.length; i++) ctx.registry.bind(cond[i], E.conditions)
    for (let i = 0; i < qos.length; i++) ctx.registry.bind(qos[i], E.qos)
    ctx.registry.bind(beacon, E.pod)
    ctx.registry.bind(revBand, E.revision)
    ctx.registry.bind(termTrack, E.termination)
    ctx.registry.bind(termFill, E.termination)
    if (plate) ctx.registry.bind(plate.mesh, E.owner)
    ctx.registry.bind(g, E.pod)

    /* A little scatter so the grid does not read as a spreadsheet. */
    g.rotation.y = ctx.rng.range(-0.028, 0.028)
    g.visible = false

    return {
      group: g,
      slab,
      kerb,
      ipPost,
      ipLamp,
      riser,
      condPost,
      cond,
      qos,
      beacon,
      revBand,
      termTrack,
      termFill,
      units,
      plate,
      uid: null,
      nodeIndex,
      slot,
      touched: -1,
      build: 0,
      dying: 0,
      wasTerminating: false,
      rosterSig: -1,
      pName: '',
      pIp: '',
      pPhase: '',
      pRestarts: -1,
      pRev: -1,
      pReady: false,
    }
  }

  function buildGhost(i: number): GhostSlot {
    const g = new THREE.Group()
    const pad = new THREE.Mesh(gBox, P.slabGhost)
    pad.scale.set(14, 0.4, 15)
    const tower = new THREE.Mesh(gPillar, P.ghostTower)
    tower.scale.set(5.2, 9, 5.2)
    tower.position.y = 0.2
    const cap = new THREE.Mesh(gBox, P.slabGhost)
    cap.scale.set(7, 0.4, 7)
    cap.position.y = 9.4
    g.add(pad, tower, cap)
    g.position.set((i - (GHOST_SLOTS - 1) / 2) * GHOST_PITCH, GHOST_Y, GHOST_Z)
    g.visible = false
    ctx.registry.bind(g, E.desired)
    ctx.registry.bind(pad, E.desired)
    ctx.registry.bind(tower, E.desired)
    ctx.registry.bind(cap, E.desired)
    group.add(g)
    return { group: g, pad, tower, cap, a: 0 }
  }

  /* ------------------------------------------------------------- allocation */

  function nodeIndexOf(s: SimState, name: string): number {
    for (let i = 0; i < s.nodes.length; i++) {
      if (s.nodes[i].name === name) return s.nodes[i].index
    }
    return -1
  }

  function acquire(nodeIndex: number): Lot | null {
    const pool = nodeIndex >= 0 && nodeIndex < nodeLots.length ? nodeLots[nodeIndex] : yardLots
    for (let i = 0; i < pool.length; i++) {
      const lot = pool[i]
      if (lot.uid === null && lot.dying === 0) return lot
    }
    return null
  }

  function place(lot: Lot): void {
    if (lot.nodeIndex >= 0) {
      podPlotPos(lot.nodeIndex, lot.slot, lot.group.position)
    } else {
      lot.group.position.set((lot.slot - (YARD_SLOTS - 1) / 2) * YARD_PITCH, YARD_Y, YARD_Z)
    }
  }

  function occupy(lot: Lot, uid: string): void {
    lot.uid = uid
    lot.build = 0
    lot.dying = 0
    lot.wasTerminating = false
    lot.rosterSig = -1
    lot.pName = ''
    lot.pIp = ''
    lot.pPhase = ''
    lot.pRestarts = -1
    lot.pRev = -1
    for (let i = 0; i < lot.units.length; i++) {
      const u = lot.units[i]
      u.h = 0
      u.cpu = 0
      u.flash = 0
    }
    place(lot)
    lot.group.visible = true
    group.add(lot.group)
    lotByUid.set(uid, lot)
  }

  function release(lot: Lot): void {
    if (lot.uid !== null) lotByUid.delete(lot.uid)
    lot.uid = null
    lot.dying = 0
    lot.build = 0
    lot.group.visible = false
    lot.group.scale.set(1, 1, 1)
    group.remove(lot.group)
  }

  /* ----------------------------------------------------------------- layout */

  /**
   * Container placement encodes the lifecycle: init containers stand in the
   * back row in spec order and app containers do not exist until every one of
   * them has exited 0. Sidecars stand beside the app they accompany.
   */
  function relayout(lot: Lot, pod: PodState): void {
    const n = Math.min(pod.containers.length, CONTAINER_SLOTS_PER_POD)
    let initCount = 0
    for (let i = 0; i < n; i++) if (pod.containers[i].role === 'init') initCount++
    const frontCount = n - initCount
    const initPitch = Math.min(5.6, 18 / Math.max(1, initCount))
    const frontPitch = Math.min(6.4, 18 / Math.max(1, frontCount))

    let iInit = 0
    let iFront = 0
    for (let i = 0; i < lot.units.length; i++) {
      const u = lot.units[i]
      if (i >= n) {
        u.group.visible = false
        continue
      }
      u.group.visible = true
      const c = pod.containers[i]
      const isInit = c.role === 'init'
      const idx = isInit ? iInit++ : iFront++
      const count = isInit ? initCount : frontCount
      const pitch = isInit ? initPitch : frontPitch
      const x = (idx - (count - 1) / 2) * pitch
      const z = isInit ? ROW_INIT_Z : ROW_APP_Z
      /* A sidecar is tucked back beside its app container and drawn slimmer. */
      u.group.position.set(x, SLAB_H, c.role === 'sidecar' ? z - 2.2 : z)
      const w = c.role === 'sidecar' ? 1.9 : 2.7
      u.tower.scale.x = w
      u.tower.scale.z = w
      u.ghostTower.scale.set(w, H_LIMIT * 0.55, w)
      u.limitCeil.scale.x = Math.min(5.4, pitch - 0.5)
      u.limitCeil.scale.z = Math.min(5.4, pitch - 0.5)

      const entry = isInit ? E.init : c.role === 'sidecar' ? E.sidecar : E.states
      if (u.boundId !== entry.id) {
        ctx.registry.bind(u.tower, entry)
        ctx.registry.bind(u.ghostTower, entry)
        u.boundId = entry.id
      }
    }
  }

  function rosterSignature(pod: PodState): number {
    let sig = pod.containers.length
    const n = Math.min(pod.containers.length, CONTAINER_SLOTS_PER_POD)
    for (let i = 0; i < n; i++) {
      const r = pod.containers[i].role
      sig = sig * 4 + (r === 'init' ? 1 : r === 'sidecar' ? 2 : 3)
    }
    return sig
  }

  /* ------------------------------------------------------------------ plate */

  function phaseCss(pod: PodState): string {
    if (pod.deletionGraceSeconds !== undefined) return CSS_TERM
    switch (pod.phase) {
      case 'Pending':
        return CSS_PENDING
      case 'Running':
        return pod.conditions.Ready ? CSS_READY : CSS_RUNNING
      case 'Succeeded':
        return CSS_READY
      case 'Failed':
        return CSS_FAILED
      default:
        return CSS_DIM
    }
  }

  function drawPlate(lot: Lot, pod: PodState, restarts: number): void {
    const p = lot.plate
    if (!p) return
    const c = p.ctx2d
    c.clearRect(0, 0, PLATE_PX_W, PLATE_PX_H)
    c.fillStyle = CSS_BG
    c.fillRect(0, 0, PLATE_PX_W, PLATE_PX_H)
    c.fillStyle = phaseCss(pod)
    c.fillRect(0, 0, 5, PLATE_PX_H)
    c.textBaseline = 'alphabetic'
    c.font = FONT_NAME
    c.fillStyle = CSS_TEXT
    c.fillText(pod.name, 12, 24)
    c.font = FONT_SMALL
    c.fillStyle = CSS_NET
    c.fillText(pod.ip ?? NONE, 12, 48)
    c.fillStyle = CSS_DIM
    c.fillText(pod.qos, 132, 48)
    c.fillStyle = phaseCss(pod)
    c.fillText(pod.deletionGraceSeconds !== undefined ? 'Terminating' : pod.phase, 12, 72)
    c.fillStyle = CSS_DIM
    if (restarts > 0) c.fillText(RESTART_STR[Math.min(restarts, 127)], 118, 72)
    else if (pod.revision !== undefined) c.fillText(REV_STR[Math.min(pod.revision, 127)], 118, 72)
    p.tex.needsUpdate = true
  }

  /* --------------------------------------------------------------- per-unit */

  function updateUnit(u: Unit, c: ContainerState, pod: PodState, s: SimState, dt: number, gated: boolean): void {
    const exists = !gated && (c.state === 'running' || c.state === 'terminated')
    const pulling = c.state === 'waiting' && c.pullProgress > 0 && c.pullProgress < 1
    const oomed = c.reason === 'OOMKilled'

    /* --- requests: a hologram at the request level, sized by the request.
     * It is subtracted from the node's allocatable the moment the pod is
     * bound, whether or not anything ever uses it. */
    const reqH = (c.requestMemMib / memRef(c)) * H_LIMIT
    const padW = 2.6 + 2.2 * clamp(c.requestCpuMilli / CPU_REF_MILLI, 0, 1)
    const padD = 2.6 + 2.2 * clamp(c.requestMemMib / MEM_REF_MIB, 0, 1)
    u.reqPad.visible = c.requestCpuMilli > 0 || c.requestMemMib > 0
    u.reqPad.scale.set(padW, 0.16, padD)
    u.reqPad.position.y = reqH
    u.reqPad.material = P.reqPad

    /* --- limits: the ceiling. No limit means no ceiling at all, which is the
     * whole risk of BestEffort. */
    u.limitCeil.visible = c.limitMemMib > 0
    /* Offset so a Guaranteed container — request == limit — shows two distinct
     * planes touching, rather than one z-fighting plane. */
    u.limitCeil.position.y = H_LIMIT + 0.14
    u.limitCeil.material = u.flash > 0 ? P.limitBreach : P.limitCeil

    /* --- the container itself. */
    let targetH: number
    if (pulling) {
      targetH = c.pullProgress * H_LIMIT * 0.55
    } else if (exists) {
      targetH = clamp(c.usedMemMib / memRef(c), 0, 1.06) * H_LIMIT
      if (c.state === 'terminated') targetH = 1.1
    } else {
      targetH = 0
    }

    if (oomed) {
      /* OOMKilled is a hard kill: SIGKILL, no grace, nothing to drain. The
       * structure is simply gone, and the ceiling it broke through flashes. */
      u.h = 0
      if (u.flash <= 0) u.flash = 0.9
    } else {
      u.h = approach(u.h, targetH, exists || pulling ? 6 : 12, dt)
    }
    if (u.flash > 0) u.flash = Math.max(0, u.flash - dt)

    u.tower.visible = u.h > 0.02
    u.tower.scale.y = Math.max(0.02, u.h)
    u.tower.material = pulling
      ? P.towerPull
      : c.state === 'terminated'
        ? c.reason === 'Completed'
          ? P.towerDone
          : P.towerDim
        : pod.deletionGraceSeconds !== undefined
          ? P.towerDim
          : isCurrentRevision(pod)
            ? P.towerNew
            : P.towerOld

    /* CPU quota clamps a running container; it never removes it. The squeeze
     * is drawn as a compression of the standing structure. */
    if (c.throttled && exists) {
      u.tower.scale.y = Math.max(0.02, u.h * (0.94 + Math.sin(clock * 22) * 0.03))
    }

    /* --- the declared-but-absent container. */
    u.ghostTower.visible = !exists && !pulling
    u.ghostTower.material = P.ghostTower

    /* --- state lamp, always at the top of whatever is standing. */
    u.lamp.position.y = Math.max(u.h, 0.9) + 0.7
    u.lamp.scale.setScalar(exists || pulling ? 0.95 : 0.7)
    u.lamp.material = lampFor(c, gated)

    /* --- CPU: usage climbing toward the quota. */
    const cpuTarget = clamp(c.usedCpuMilli / cpuRef(c), 0, 1) * H_LIMIT
    u.cpu = approach(u.cpu, exists ? cpuTarget : 0, 8, dt)
    u.cpuTrack.visible = exists
    u.cpuFill.visible = exists && u.cpu > 0.05
    u.cpuFill.scale.y = Math.max(0.02, u.cpu)
    u.cpuTrack.material = c.limitCpuMilli > 0 ? (c.throttled ? P.cpuTrackCapped : P.cpuTrack) : P.cpuTrack
    u.cpuFill.material = c.throttled ? P.cpuFillThrottled : P.cpuFill

    /* --- backoff: the track *is* the interval, so doubling is a visible step;
     * the fill is the countdown running out. */
    const showBackoff = c.backoffRemaining > 0 && c.backoffSeconds > 0
    u.backTrack.visible = showBackoff
    u.backFill.visible = showBackoff
    if (showBackoff) {
      const len = 1.2 * Math.log2(c.backoffSeconds / TIMING.crashBackoffStartSeconds + 1)
      const frac = clamp(c.backoffRemaining / c.backoffSeconds, 0, 1)
      u.backTrack.scale.x = Math.max(0.1, len)
      u.backFill.scale.x = Math.max(0.02, len * frac)
      u.backFill.position.x = -(len - len * frac) / 2
      u.backTrack.material = P.backTrack
      u.backFill.material = P.backFill
    }

    /* --- probes: consecutive failures stacking toward failureThreshold. */
    const threshold = Math.max(1, s.knobs.probeFailureThreshold)
    const fails = Math.max(c.livenessFailures, c.readinessFailures)
    u.probeBar.visible = exists && fails > 0
    if (u.probeBar.visible) {
      const f = clamp(fails / threshold, 0, 1)
      u.probeBar.scale.y = Math.max(0.05, f * H_LIMIT * 0.6)
      u.probeBar.material = fails >= threshold ? P.probeFail : P.probeWarn
    }

    /* --- restarts, as a bar that only ever grows. */
    u.tally.visible = c.restartCount > 0
    if (u.tally.visible) {
      u.tally.scale.x = 0.5 + Math.min(c.restartCount, 12) * 0.38
      u.tally.material = P.tally
    }
  }

  function lampFor(c: ContainerState, gated: boolean): THREE.Material {
    if (gated) return P.lampOff
    if (c.state === 'terminated') return c.reason === 'Completed' ? P.lampDone : P.lampFail
    if (c.state === 'waiting') {
      switch (c.reason) {
        case 'CrashLoopBackOff':
        case 'ImagePullBackOff':
          return P.lampBackoff
        case 'ErrImagePull':
        case 'CreateContainerConfigError':
        case 'OOMKilled':
        case 'Error':
          return P.lampFail
        default:
          return P.lampWait
      }
    }
    if (c.throttled) return P.lampThrottle
    return c.ready ? P.lampReady : P.lampWait
  }

  function isCurrentRevision(pod: PodState): boolean {
    return pod.revision === undefined || maxRevision === 0 || pod.revision >= maxRevision
  }

  /* ---------------------------------------------------------------- per-lot */

  function updateLot(lot: Lot, pod: PodState, s: SimState, dt: number): void {
    const terminating = pod.deletionGraceSeconds !== undefined
    lot.wasTerminating = terminating

    lot.build = Math.min(1, lot.build + dt / BUILD_SECONDS)
    const b = lot.build * lot.build * (3 - 2 * lot.build)

    const sig = rosterSignature(pod)
    if (sig !== lot.rosterSig) {
      relayout(lot, pod)
      lot.rosterSig = sig
    }

    /* The sandbox — and therefore the lot — exists only once the kubelet has
     * created it and the CNI has plugged it in. Before that the pod is a record
     * with no matter behind it anywhere in the cluster. */
    const hasSandbox = pod.ip !== undefined
    const grow = 0.35 + 0.65 * b
    lot.slab.material = terminating ? P.slabTerm : hasSandbox ? P.slabSolid : P.slabGhost
    lot.slab.scale.set(LOT_W * grow, SLAB_H, LOT_D * grow)
    lot.kerb.scale.set((LOT_W + 1.6) * grow, 0.42, (LOT_D + 1.6) * grow)
    lot.kerb.material = hasSandbox && !terminating ? P.kerbOn : P.kerbOff
    lot.ipLamp.material = hasSandbox && !terminating ? P.ipOn : P.ipOff
    lot.ipLamp.visible = hasSandbox
    lot.ipPost.visible = hasSandbox

    lot.riser.material = pod.volumeClaims.length > 0 && hasSandbox ? P.riserOn : P.riserOff

    /* Conditions light bottom-up in the order they actually become true. */
    lot.cond[0].material = pod.conditions.PodScheduled ? P.condOn : P.condOff
    lot.cond[1].material = pod.conditions.Initialized ? P.condOn : P.condOff
    lot.cond[2].material = pod.conditions.ContainersReady ? P.condOn : P.condOff
    lot.cond[3].material = pod.conditions.Ready ? P.condOn : P.condOff

    const qosIdx = pod.qos === 'Guaranteed' ? 0 : pod.qos === 'Burstable' ? 1 : 2
    for (let i = 0; i < 3; i++) lot.qos[i].material = i === qosIdx ? P.qosLit[i] : P.qosOff

    lot.beacon.material = P.beacon[terminating ? PHASE_TERMINATING : phaseIndex(pod)]

    lot.revBand.visible = pod.revision !== undefined
    lot.revBand.material = isCurrentRevision(pod) ? P.revNew : P.revOld

    /* Graceful termination: endpoints drop the pod immediately (the kerb goes
     * dark at once) while the containers keep running until the grace period
     * runs out and the kubelet sends SIGKILL. */
    lot.termTrack.visible = terminating
    lot.termFill.visible = terminating
    if (terminating) {
      const grace = pod.deletionGraceSeconds ?? 0
      const frac = clamp(1 - grace / TIMING.terminationGraceSeconds, 0, 1)
      const len = (LOT_W - 4) * frac
      lot.termFill.scale.x = Math.max(0.02, len)
      lot.termFill.position.x = -(LOT_W - 4) / 2 + len / 2
      lot.termFill.material = frac > 0.85 ? P.limitBreach : P.beacon[PHASE_TERMINATING]
      lot.group.position.y = (lot.nodeIndex >= 0 ? CITY.node.top : YARD_Y) - frac * 0.8
    } else {
      lot.group.position.y = lot.nodeIndex >= 0 ? CITY.node.top : YARD_Y
    }

    /* Init containers run to completion, in order, before the app containers
     * exist at all. Anything not-init is gated until they are all done. */
    let initsDone = true
    const n = Math.min(pod.containers.length, CONTAINER_SLOTS_PER_POD)
    for (let i = 0; i < n; i++) {
      const c = pod.containers[i]
      if (c.role === 'init' && !(c.state === 'terminated' && c.reason === 'Completed')) initsDone = false
    }
    for (let i = 0; i < lot.units.length; i++) {
      const u = lot.units[i]
      if (i >= n) {
        u.group.visible = false
        continue
      }
      const c = pod.containers[i]
      const gated = c.role !== 'init' && !initsDone
      u.group.visible = true
      u.group.scale.y = b
      updateUnit(u, c, pod, s, dt, gated)
    }

    /* Plate: only redrawn when the identity or a headline value changes. */
    if (lot.plate) {
      let restarts = 0
      for (let i = 0; i < n; i++) restarts += pod.containers[i].restartCount
      const ip = pod.ip ?? ''
      const phase = terminating ? 'Terminating' : pod.phase
      const rev = pod.revision ?? -1
      if (
        lot.pName !== pod.name ||
        lot.pIp !== ip ||
        lot.pPhase !== phase ||
        lot.pRestarts !== restarts ||
        lot.pRev !== rev ||
        lot.pReady !== pod.conditions.Ready
      ) {
        lot.pName = pod.name
        lot.pIp = ip
        lot.pPhase = phase
        lot.pRestarts = restarts
        lot.pRev = rev
        lot.pReady = pod.conditions.Ready
        drawPlate(lot, pod, restarts)
      }
    }
  }

  function phaseIndex(pod: PodState): number {
    switch (pod.phase) {
      case 'Pending':
        return PHASE_PENDING
      case 'Running':
        return PHASE_RUNNING
      case 'Succeeded':
        return PHASE_SUCCEEDED
      case 'Failed':
        return PHASE_FAILED
      default:
        return PHASE_UNKNOWN
    }
  }

  /**
   * A pod that vanished from the API takes its matter with it. If it never had
   * a grace period, the collapse is abrupt — that is what a SIGKILL looks like.
   */
  function collapse(lot: Lot, dt: number): void {
    lot.dying = Math.max(0, lot.dying - dt / COLLAPSE_SECONDS)
    const p = lot.dying
    lot.group.scale.set(1, p * p, 1)
    lot.beacon.material = lot.wasTerminating ? P.beacon[PHASE_TERMINATING] : P.beacon[PHASE_FAILED]
    lot.kerb.material = P.kerbOff
    if (lot.dying <= 0) release(lot)
  }

  /* ------------------------------------------------------------------- pass */

  const podPass = (pod: PodState, uid: string): void => {
    const s = cur
    if (!s) return

    /* Desired-vs-actual bookkeeping uses the controller's own active filter. */
    if (isActive(pod) && pod.owner) {
      const o = pod.owner
      if (o.kind === 'ReplicaSet') {
        const dep = rsToDep.get(o.name)
        if (dep !== undefined) cntByDep.set(dep, (cntByDep.get(dep) ?? 0) + 1)
      } else if (o.kind === 'StatefulSet') {
        cntBySts.set(o.name, (cntBySts.get(o.name) ?? 0) + 1)
      }
    }

    const ni = pod.nodeName === undefined ? -1 : nodeIndexOf(s, pod.nodeName)
    let lot = lotByUid.get(uid)
    if (lot && lot.nodeIndex !== ni) {
      /* Binding happened: the pod leaves the holding yard for its node. */
      release(lot)
      lot = undefined
    }
    if (!lot) {
      const fresh = acquire(ni)
      if (!fresh) return
      occupy(fresh, uid)
      lot = fresh
    }
    lot.touched = frame
    /* Other districts read pod.slot to find this building without a lookup. */
    pod.slot = ni >= 0 ? lot.slot : undefined
    updateLot(lot, pod, s, curDt)
  }

  /* ----------------------------------------------------------------- ghosts */

  function updateGhosts(s: SimState, dt: number): void {
    let want = 0
    for (let i = 0; i < s.deployments.length; i++) {
      const d = s.deployments[i]
      /* cntByDep was seeded with 0 for every Deployment that owns a ReplicaSet,
       * so `undefined` here means the ownership chain is unavailable — not that
       * the Deployment has no pods. Falling back to its own status then keeps
       * the model from conjuring a wall of holograms nothing is chasing. */
      want += Math.max(0, d.replicas - (cntByDep.get(d.name) ?? d.statusReplicas))
    }
    for (let i = 0; i < s.statefulSets.length; i++) {
      const st = s.statefulSets[i]
      want += Math.max(0, st.replicas - Math.max(cntBySts.get(st.name) ?? 0, st.readyReplicas))
    }
    /* DaemonSets and Jobs report the count that actually exists themselves. */
    for (let i = 0; i < s.daemonSets.length; i++) {
      const ds = s.daemonSets[i]
      want += Math.max(0, ds.desiredScheduled - ds.currentScheduled)
    }
    for (let i = 0; i < s.jobs.length; i++) {
      const j = s.jobs[i]
      const room = Math.min(j.parallelism, Math.max(0, j.completions - j.succeeded))
      want += Math.max(0, room - j.active)
    }
    ghostCount = Math.min(want, GHOST_SLOTS)

    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i]
      const on = i < ghostCount
      /* A ghost appears the instant the number changes — no easing on the way
       * in, because "the gap exists now" is the entire lesson. */
      g.a = on ? 1 : Math.max(0, g.a - dt * 3)
      g.group.visible = g.a > 0.01
      if (!g.group.visible) continue
      g.group.scale.set(1, g.a, 1)
      g.group.position.y = GHOST_Y + Math.sin(clock * 1.5 + i * 0.7) * 0.5
      g.pad.material = P.slabGhost
      g.cap.material = P.slabGhost
      g.tower.material = P.ghostTower
    }
  }

  /* ------------------------------------------------------------------ theme */

  const offTheme = ctx.bus.on('theme', () => {
    P = resolvePalette()
    /* Everything state-driven is re-assigned on the next frame; only the pool
     * objects that are currently idle need a nudge. */
    for (let i = 0; i < ghosts.length; i++) {
      ghosts[i].pad.material = P.slabGhost
      ghosts[i].cap.material = P.slabGhost
      ghosts[i].tower.material = P.ghostTower
    }
    for (let i = 0; i < allLots.length; i++) {
      const lot = allLots[i]
      lot.condPost.material = P.post
      lot.ipPost.material = P.post
    }
  })

  /* ----------------------------------------------------------------- update */

  function update(s: SimState, dt: number): void {
    cur = s
    curDt = dt
    clock += dt
    frame++

    maxRevision = 0
    for (let i = 0; i < s.deployments.length; i++) {
      if (s.deployments[i].revision > maxRevision) maxRevision = s.deployments[i].revision
    }

    rsToDep.clear()
    cntByDep.clear()
    cntBySts.clear()
    for (let i = 0; i < s.replicaSets.length; i++) {
      rsToDep.set(s.replicaSets[i].name, s.replicaSets[i].ownerDeployment)
      /* Seeded so "no entry" means "no ownership chain", not "no pods". */
      cntByDep.set(s.replicaSets[i].ownerDeployment, 0)
    }

    s.pods.forEach(podPass)

    for (let i = 0; i < allLots.length; i++) {
      const lot = allLots[i]
      if (lot.uid === null) continue
      if (lot.dying > 0) {
        collapse(lot, dt)
      } else if (lot.touched !== frame) {
        lot.dying = 1
        lotByUid.delete(lot.uid)
      }
    }

    updateGhosts(s, dt)
    cur = null
  }

  function dispose(): void {
    offTheme()
    for (let i = 0; i < owned.length; i++) owned[i].dispose()
    for (let i = 0; i < plateMaterials.length; i++) plateMaterials[i].dispose()
    for (let i = 0; i < plateTextures.length; i++) plateTextures[i].dispose()
  }

  return { group, update, dispose }
}

/* ============================================================================
 * Explainers. Every mechanism drawn above states what it is, what it is not,
 * and where the model bends.
 * ==========================================================================*/

interface PodExplainers {
  pod: Explainer
  sandbox: Explainer
  netns: Explainer
  init: Explainer
  sidecar: Explainer
  states: Explainer
  imagepull: Explainer
  crashloop: Explainer
  oom: Explainer
  throttle: Explainer
  resources: Explainer
  qos: Explainer
  probes: Explainer
  conditions: Explainer
  owner: Explainer
  termination: Explainer
  pending: Explainer
  desired: Explainer
  revision: Explainer
}

function countContainers(s: SimState, pred: (c: ContainerState, p: PodState) => boolean): number {
  let n = 0
  s.pods.forEach((p) => {
    for (let i = 0; i < p.containers.length; i++) if (pred(p.containers[i], p)) n++
  })
  return n
}

function registerExplainers(ctx: WorldCtx): PodExplainers {
  const r = ctx.registry
  const podFocus: [number, number, number] = [0, 26, CITY.node.z - 40]
  const yardFocus: [number, number, number] = [0, 30, YARD_Z - 60]

  const pod = r.register({
    id: 'pod',
    title: 'Pod',
    district: 'nodes',
    kubeName: 'v1/Pod',
    focus: podFocus,
    summary:
      'The smallest thing Kubernetes schedules: a lot with shared utilities, on which one or more containers stand.',
    detail: [
      'A Pod is not a container. It is a set of shared namespaces — network, IPC, UTS — plus a shared volume set and a shared cgroup parent. Every container in the Pod joins those namespaces, which is why they all answer on one IP and can talk over localhost.',
      'A Pod is scheduled as a unit and lives on exactly one node for its whole life. Kubernetes never moves a running Pod: a "rescheduled" pod is a different object with a different UID and a different IP. That is why the ReplicaSet controller creates replacements rather than migrations.',
      'Each lot here shows one Pod. The slab is the sandbox, the light strip around it is the shared network namespace, the four lamps on the mast are the pod conditions, and the structures on top are the individual containers.',
    ],
    caveats: [
      'Only the first 12 pods per node are drawn; kubelet\'s real default cap is 110 per node.',
      'At most 4 containers are drawn per pod, and the geometry does not model ephemeral (debug) containers.',
    ],
    metrics: (s) => {
      let oldest = 0
      s.pods.forEach((p) => {
        if (p.ageSeconds > oldest) oldest = p.ageSeconds
      })
      return [
        { label: 'Running', value: String(s.totals.podsRunning) },
        { label: 'Pending', value: String(s.totals.podsPending), hint: 'no node accepted them yet' },
        { label: 'Failed', value: String(s.totals.podsFailed) },
        { label: 'Terminating', value: String(s.totals.podsTerminating) },
        { label: 'Restarts', value: String(s.totals.restarts) },
        { label: 'Oldest', value: formatAge(oldest) },
      ]
    },
    keywords: ['pod', 'lot', 'workload', 'kubectl get pods'],
  })

  const sandbox = r.register({
    id: 'pod.sandbox',
    title: 'Pod sandbox (the pause container)',
    district: 'nodes',
    kubeName: 'RunPodSandbox',
    focus: podFocus,
    summary:
      'The lot itself: the first container the runtime creates, whose only job is to hold the namespaces open.',
    detail: [
      'kubelet asks the CRI runtime for a PodSandbox before any of your containers exist. The runtime creates an infrastructure container — historically `pause`, an image whose entire program is to reap zombies and sleep — and creates the network, IPC and UTS namespaces around it.',
      'Every app container is then started with those namespaces already joined. The pause container is why containers can be restarted, one at a time, without the Pod losing its IP: the namespaces belong to the sandbox, not to any app process.',
      'The lot is a hologram until the sandbox exists. A Pod that is Pending — or bound but not yet started — has a record in etcd and nothing at all on the node.',
      'Shared volumes are mounted into the sandbox and bind-mounted into each container, which is the riser drawn at the corner of the lot; it lights when the Pod claims a volume.',
    ],
    caveats: [
      'The model does not draw the cgroup hierarchy (`kubepods/burstable/pod<uid>`) that the sandbox also creates.',
      'Sandboxes that keep running after all containers exit (a common cause of "stuck Terminating") are not modelled.',
    ],
    keywords: ['pause', 'sandbox', 'infra container', 'CRI', 'RunPodSandbox', 'namespaces'],
  })

  const netns = r.register({
    id: 'pod.netns',
    title: 'Shared network namespace',
    district: 'nodes',
    kubeName: 'CNI ADD',
    focus: podFocus,
    summary: 'One IP for the whole Pod, allocated by the CNI plugin after the sandbox exists.',
    detail: [
      'kubelet calls the CNI plugin with the sandbox\'s network namespace. The plugin creates a veth pair, moves one end into the namespace, allocates an address out of the node\'s podCIDR, and installs routes. The result is `status.podIP`.',
      'Because the namespace is shared, containers in the same Pod reach each other on 127.0.0.1 and must not both bind the same port — a second container binding :8080 gets EADDRINUSE, not a second listener.',
      'The Pod IP is not stable across restarts of the Pod object, and nothing outside the cluster should ever hold one. That instability is exactly why Services exist.',
      'The light strip runs around the whole lot rather than around any one building, because the address belongs to the Pod, not to a container.',
    ],
    caveats: [
      'The veth pair and the node bridge are drawn by the node district, not here.',
      '`hostNetwork: true` pods, which share the node\'s namespace and get the node IP, are not modelled.',
    ],
    metrics: (s) => {
      let withIp = 0
      let waiting = 0
      s.pods.forEach((p) => {
        if (p.ip) withIp++
        else waiting++
      })
      return [
        { label: 'Pods with an IP', value: String(withIp) },
        { label: 'Awaiting sandbox/CNI', value: String(waiting) },
      ]
    },
    keywords: ['CNI', 'podIP', 'veth', 'localhost', 'network namespace', 'podCIDR'],
  })

  const init = r.register({
    id: 'pod.init',
    title: 'Init containers',
    district: 'nodes',
    kubeName: 'spec.initContainers',
    focus: podFocus,
    summary: 'Run to completion, one at a time, in spec order — before any app container is created.',
    detail: [
      'Init containers are drawn in the back row. Each must exit 0 before the next starts; only when the last one has finished does the Initialized condition flip true and the app containers get created at all.',
      'While init containers run, the app containers are holograms here because that is literally true: the runtime has not been asked to create them, so there is no process, no cgroup and no log to read.',
      'A failing init container restarts according to the Pod\'s restartPolicy and keeps the Pod in Init:CrashLoopBackOff forever. This is the usual reason a Pod appears stuck with `0/1` and no application logs — the logs you want are `kubectl logs pod -c <init-container>`.',
      'Init containers can hold elevated privileges or credentials that the app container never gets, which is the main reason to use one instead of an entrypoint script.',
    ],
    caveats: [
      'Init containers get their resource requests treated as a maximum against the app containers\' sum; the model draws each request separately and does not compute that max.',
    ],
    metrics: (s) => [
      {
        label: 'Init containers running',
        value: String(countContainers(s, (c) => c.role === 'init' && c.state === 'running')),
      },
      {
        label: 'Completed',
        value: String(countContainers(s, (c) => c.role === 'init' && c.reason === 'Completed')),
      },
    ],
    keywords: ['init', 'initContainers', 'PodInitializing', 'Initialized'],
  })

  const sidecar = r.register({
    id: 'pod.sidecar',
    title: 'Sidecar containers',
    district: 'nodes',
    kubeName: 'restartPolicy: Always on an init container',
    focus: podFocus,
    summary: 'Long-running helpers that share the Pod\'s namespaces and lifetime with the app.',
    detail: [
      'A sidecar is an ordinary container that happens to serve the main one: a log shipper, a service-mesh proxy, a credential refresher. It shares the network namespace, so it can intercept the app\'s traffic on localhost, and shares volumes, so it can read the app\'s files.',
      'Since Kubernetes 1.29 there is a first-class form: an entry in initContainers with `restartPolicy: Always`. It starts before the app containers, keeps running alongside them, and — importantly for Jobs — does not prevent the Pod from reaching Succeeded when the main container exits.',
      'Before that mechanism existed, a sidecar in a Job would keep the Pod running forever after the work finished. That is still the failure mode when someone declares a mesh proxy as a plain container.',
    ],
    caveats: ['The model treats `role: sidecar` as a plain always-running container; startup ordering relative to app containers is not animated.'],
    keywords: ['sidecar', 'proxy', 'envoy', 'log shipper', 'restartPolicy'],
  })

  const states = r.register({
    id: 'pod.container',
    title: 'Container states',
    district: 'nodes',
    kubeName: 'status.containerStatuses',
    focus: podFocus,
    summary:
      'A container is waiting, running or terminated — and the `reason` string on that state is what you actually debug.',
    detail: [
      'waiting/ContainerCreating: the sandbox and volumes are being set up. waiting/PodInitializing: init containers have not all finished. waiting/ErrImagePull and ImagePullBackOff: the image could not be fetched. waiting/CreateContainerConfigError: a referenced ConfigMap or Secret key does not exist.',
      'running: the process started and the runtime reported it. Note that "running" says nothing about whether the application works — that is what the readiness probe is for, and it is the lamp colour here, not the fact that the structure is standing.',
      'terminated/Completed: exit code 0. terminated/Error: a non-zero exit. terminated/OOMKilled: the kernel killed it for exceeding the memory limit.',
      'The lamp on top of each structure carries the state; the structure itself carries the resources. A container that does not exist has no structure at all, only the hologram of what was declared.',
    ],
    caveats: [
      'Real `lastState` history (the previous termination, which `kubectl describe` shows) is not drawn.',
      'Exit codes are not modelled beyond Completed versus Error.',
    ],
    metrics: (s) => [
      { label: 'Running', value: String(countContainers(s, (c) => c.state === 'running')) },
      { label: 'Waiting', value: String(countContainers(s, (c) => c.state === 'waiting')) },
      { label: 'Terminated', value: String(countContainers(s, (c) => c.state === 'terminated')) },
      { label: 'Ready', value: String(countContainers(s, (c) => c.ready)) },
    ],
    keywords: ['ContainerCreating', 'PodInitializing', 'waiting', 'running', 'terminated', 'reason'],
  })

  const imagepull = r.register({
    id: 'pod.imagepull',
    title: 'Image pull, ErrImagePull and ImagePullBackOff',
    district: 'nodes',
    kubeName: 'kubelet imagePullPolicy',
    focus: podFocus,
    summary: 'The container cannot exist until its image is local; a failed pull backs off exactly like a crash does.',
    detail: [
      'kubelet asks the CRI to pull the image before it creates the container. The structure fills from the bottom in the image colour as the layers arrive; the container itself only appears once the pull completes.',
      'A pull that fails once gives ErrImagePull. kubelet retries with the same exponential backoff used for crashes, and the reason becomes ImagePullBackOff — the same delay bar is drawn for both, because it is the same mechanism.',
      'The usual causes are a typo in the tag, a private registry with no imagePullSecret, and rate limiting. `kubectl describe pod` shows the registry\'s own error under Events.',
      'With imagePullPolicy IfNotPresent, an image already in the node\'s cache is not fetched at all — which is why a mutable tag like `:latest` can run different code on different nodes.',
    ],
    caveats: ['Layer sharing between images and the content-addressed store are drawn in the registry district, not here.'],
    metrics: (s) => [
      {
        label: 'Pulling',
        value: String(countContainers(s, (c) => c.pullProgress > 0 && c.pullProgress < 1)),
      },
      {
        label: 'ImagePullBackOff',
        value: String(countContainers(s, (c) => c.reason === 'ImagePullBackOff' || c.reason === 'ErrImagePull')),
      },
    ],
    keywords: ['ImagePullBackOff', 'ErrImagePull', 'imagePullSecrets', 'imagePullPolicy', 'registry'],
  })

  const crashloop = r.register({
    id: 'pod.crashloop',
    title: 'CrashLoopBackOff',
    district: 'nodes',
    kubeName: 'kubelet backoff',
    focus: podFocus,
    summary:
      'Not an error state — a delay. kubelet is waiting before restarting a container that keeps exiting.',
    detail: [
      'When a container exits and restartPolicy allows a restart, kubelet waits before trying again: 10s, then 20s, 40s, 80s, 160s, capped at 5 minutes. The bar in front of the container is that interval — it visibly doubles on every restart — and the fill is the countdown running out.',
      'The backoff resets to 10s only after the container has stayed up for 10 minutes. A container that crashes every 9 minutes therefore keeps its long delay forever.',
      'CrashLoopBackOff tells you nothing about why the process died. The exit code and `kubectl logs --previous` do. The two most common causes are a config error the process refuses to start with, and a liveness probe killing a container that was merely slow.',
      'The restart tally next to the container is `restartCount`, which is what `kubectl get pods` prints in the RESTARTS column. It counts restarts of containers, not of the Pod: the Pod object is the same one throughout, with the same UID and IP.',
    ],
    caveats: [
      'Real kubelet applies jitter to the backoff; the model uses the exact doubling so the pattern is legible.',
      'restartPolicy is assumed Always; Never and OnFailure change whether a restart happens at all.',
    ],
    metrics: (s) => {
      let n = 0
      let longest = 0
      s.pods.forEach((p) => {
        for (let i = 0; i < p.containers.length; i++) {
          const c = p.containers[i]
          if (c.reason === 'CrashLoopBackOff') {
            n++
            if (c.backoffSeconds > longest) longest = c.backoffSeconds
          }
        }
      })
      return [
        { label: 'Containers backing off', value: String(n) },
        { label: 'Longest interval', value: `${longest}s`, hint: `capped at ${TIMING.crashBackoffMaxSeconds}s` },
        { label: 'Cluster restarts', value: String(s.totals.restarts) },
      ]
    },
    keywords: ['CrashLoopBackOff', 'backoff', 'restartCount', 'exponential', 'restartPolicy'],
  })

  const oom = r.register({
    id: 'pod.oom',
    title: 'OOMKilled',
    district: 'nodes',
    kubeName: 'cgroup memory.max',
    focus: podFocus,
    summary: 'A hard kill. Memory is incompressible, so exceeding the limit destroys the container instantly.',
    detail: [
      'The memory limit is written into the container\'s cgroup as memory.max. When the process touches one page beyond it and the kernel cannot reclaim, the cgroup OOM killer sends SIGKILL. There is no warning, no grace period, and no chance to flush anything.',
      'The container disappears and its restart is counted; the Pod survives, keeps its IP, and the other containers on the lot are untouched. `kubectl get pods` shows the Pod as Running with a bumped RESTARTS count, which is why an OOM loop is easy to miss.',
      'This is the opposite of CPU throttling. Compare the two: CPU is compressible, so the kernel just gives the process less of it. Memory cannot be compressed, so the only enforcement available is death.',
      'A container with no memory limit is not safe — it is merely killed later, by the node\'s global OOM killer or by kubelet\'s eviction manager, which may take a different, more valuable pod with it.',
    ],
    caveats: [
      'The model kills the container when usage crosses the limit; the real kernel kills on an allocation that cannot be satisfied after reclaim, so page cache can delay it.',
      'The distinction between an OOM kill of PID 1 and of a child process (which the container may survive) is not modelled.',
    ],
    metrics: (s) => [
      { label: 'OOMKilled containers', value: String(countContainers(s, (c) => c.reason === 'OOMKilled')) },
      {
        label: 'Over 90% of limit',
        value: String(
          countContainers(s, (c) => c.limitMemMib > 0 && c.usedMemMib > c.limitMemMib * 0.9),
        ),
      },
    ],
    keywords: ['OOMKilled', 'OOM', 'memory limit', 'SIGKILL', 'exit 137', 'memory.max'],
  })

  const throttle = r.register({
    id: 'pod.throttle',
    title: 'CPU throttling',
    district: 'nodes',
    kubeName: 'cgroup cpu.max (CFS quota)',
    focus: podFocus,
    summary: 'Not a kill. The kernel simply stops scheduling the container until the next 100ms period.',
    detail: [
      'A CPU limit becomes a CFS quota: so many microseconds of CPU per 100ms period. When the container spends its quota, every thread is descheduled until the period rolls over. The process stays alive, holds its memory, and gets slower — the structure here stays standing and gets squeezed.',
      'This is why a latency problem can look like nothing at all in `kubectl get pods`. The signal is `container_cpu_cfs_throttled_periods_total`, not a restart count.',
      'Throttling is per-period, so a service that uses little average CPU but bursts hard can be throttled while showing 20% utilisation. Multi-threaded runtimes are hit worst: 8 threads against a 200m quota exhaust the period in 25ms.',
      'CPU requests are enforced differently and continuously: they become cpu.shares, a relative weight applied only when the node is actually contended. A container is never throttled down to its request — only down to its limit.',
    ],
    caveats: [
      'The model shows throttling as a steady clamp; the real thing is a stutter at a 100ms period, far too fast to see.',
      'cpu.shares contention between pods on a busy node is not drawn.',
    ],
    metrics: (s) => [
      { label: 'Throttled containers', value: String(countContainers(s, (c) => c.throttled)) },
      { label: 'With no CPU limit', value: String(countContainers(s, (c) => c.limitCpuMilli === 0)), hint: 'never throttled' },
    ],
    keywords: ['throttling', 'CFS quota', 'cpu.max', 'cpu limit', 'latency', 'cpu.shares'],
  })

  const resources = r.register({
    id: 'pod.resources',
    title: 'Requests and limits',
    district: 'nodes',
    kubeName: 'resources.requests / resources.limits',
    focus: podFocus,
    summary: 'Requests are what schedules. Limits are what kills. They are two independent numbers.',
    detail: [
      'The green hologram under each container is its request. The scheduler subtracts it from the node\'s allocatable the moment the Pod is bound, and never looks at usage again. A node whose pods request everything is full even if every process is idle — this is the most common reason for a Pending pod on an apparently empty cluster.',
      'The red hologram above is the limit. Nothing enforces it until the process reaches it, and then enforcement is abrupt: SIGKILL for memory, descheduling for CPU.',
      'The solid structure between them is actual usage. Usage below the request is capacity you paid for and did not use; usage above the request is capacity you may lose the moment a neighbour wants it.',
      'A container with no limit has no ceiling drawn, because it genuinely has none. It can consume everything the node has left, and the consequence lands on whichever pod the eviction manager picks — not necessarily the greedy one.',
    ],
    caveats: [
      'Limit height is normalised per container so every ceiling is at the same height; a taller structure means a larger fraction of its own limit, not more memory than its neighbour.',
      'The request hologram\'s footprint encodes the CPU request on one axis and the memory request on the other.',
      'Only container-level resources are drawn; pod-level resources and the `resize` subresource are not.',
    ],
    metrics: (s) => [
      {
        label: 'CPU requested',
        value: `${formatCpu(s.totals.cpuRequestedMilli)} / ${formatCpu(s.totals.cpuAllocatableMilli)}`,
        hint: formatPercent(s.totals.cpuRequestedMilli / Math.max(1, s.totals.cpuAllocatableMilli)),
      },
      {
        label: 'Memory requested',
        value: `${formatMem(s.totals.memRequestedMib)} / ${formatMem(s.totals.memAllocatableMib)}`,
        hint: formatPercent(s.totals.memRequestedMib / Math.max(1, s.totals.memAllocatableMib)),
      },
    ],
    keywords: ['requests', 'limits', 'allocatable', 'overcommit', 'resources', 'scheduling'],
  })

  const qos = r.register({
    id: 'pod.qos',
    title: 'QoS class',
    district: 'nodes',
    kubeName: 'status.qosClass',
    focus: podFocus,
    summary: 'Derived from requests and limits, never set by you — and it decides who gets evicted first.',
    detail: [
      'Guaranteed: every container sets limits equal to requests, for both CPU and memory. Burstable: at least one request is set, but the numbers do not match. BestEffort: nothing is set at all.',
      'When a node runs out of memory, kubelet\'s eviction manager sorts pods: BestEffort first, then Burstable pods that are using more than they requested, and Guaranteed pods last. The ladder on each lot shows which rung the Pod is on; the brighter the lit rung, the sooner it goes.',
      'QoS also sets the kernel\'s oom_score_adj, so even a plain node OOM tends to take a BestEffort process before a Guaranteed one.',
      'Guaranteed pods get one more thing: on a node with the static CPU manager policy, integer-CPU Guaranteed pods get exclusive cores instead of a shared quota.',
    ],
    caveats: [
      'Eviction also weighs priority and how far over its request a pod is; the ladder shows only the class.',
      'The model does not draw the eviction manager\'s soft/hard thresholds or its grace periods.',
    ],
    metrics: (s) => {
      let g = 0
      let b = 0
      let e = 0
      s.pods.forEach((p) => {
        if (p.qos === 'Guaranteed') g++
        else if (p.qos === 'Burstable') b++
        else e++
      })
      return [
        { label: 'Guaranteed', value: String(g), hint: 'evicted last' },
        { label: 'Burstable', value: String(b) },
        { label: 'BestEffort', value: String(e), hint: 'evicted first' },
      ]
    },
    keywords: ['QoS', 'Guaranteed', 'Burstable', 'BestEffort', 'eviction', 'oom_score_adj'],
  })

  const probes = r.register({
    id: 'pod.probes',
    title: 'Startup, readiness and liveness probes',
    district: 'nodes',
    kubeName: 'spec.containers[].livenessProbe',
    focus: podFocus,
    summary: 'Three probes with three different consequences: delay, traffic, and death.',
    detail: [
      'The startup probe runs first and suspends the other two. Its job is to give a slow-booting process time without also giving a wedged process an unlimited liveness timeout.',
      'The readiness probe decides whether the Pod appears in its Service\'s EndpointSlice. Failing it removes the Pod from load balancing and changes nothing else — the process keeps running. This is the probe that makes a rolling update safe, and the one that wedges a rollout when it never passes.',
      'The liveness probe kills. On failureThreshold consecutive failures kubelet restarts the container, and the restart count climbs. A liveness probe pointed at a dependency, rather than at the process itself, turns one slow database into a cluster-wide restart storm.',
      'The bar beside a container is its consecutive failure count climbing toward failureThreshold. It resets to zero on a single success, which is why a probe that flaps can run for hours without ever tripping.',
    ],
    caveats: [
      'One failure counter is drawn per container; the model does not separate liveness from readiness geometry.',
      'Probe handlers (httpGet, exec, tcpSocket, gRPC) and their timeouts are not distinguished.',
    ],
    metrics: (s) => [
      { label: 'Probe period', value: `${s.knobs.readinessPeriodSeconds}s` },
      { label: 'Failure threshold', value: String(s.knobs.probeFailureThreshold) },
      { label: 'Containers not ready', value: String(countContainers(s, (c) => c.state === 'running' && !c.ready)) },
    ],
    keywords: ['probe', 'liveness', 'readiness', 'startupProbe', 'failureThreshold', 'endpoints'],
  })

  const conditions = r.register({
    id: 'pod.conditions',
    title: 'Pod conditions',
    district: 'nodes',
    kubeName: 'status.conditions',
    focus: podFocus,
    summary: 'Four booleans that light bottom-up and tell you exactly how far the Pod got.',
    detail: [
      'PodScheduled: the scheduler wrote a nodeName. Until this is true nothing on any node has heard of the Pod, and the reason on the condition is the scheduler\'s verdict — "0/4 nodes are available: 3 Insufficient cpu, 1 node(s) had untolerated taint".',
      'Initialized: every init container has exited 0. ContainersReady: every container\'s readiness probe passes. Ready: ContainersReady and any readiness gates.',
      'Ready is the one Services watch. A Pod can be Running with all containers up and still be excluded from every Service because one readiness probe fails.',
      'Phase is a coarse rollup of the same information: Pending until scheduled and started, Running once at least one container is up, Succeeded or Failed once everything has terminated. Phase never goes backwards.',
    ],
    caveats: ['Real conditions carry a reason, message and lastTransitionTime; only the boolean is drawn on the mast.'],
    metrics: (s) => {
      let sched = 0
      let ready = 0
      let total = 0
      s.pods.forEach((p) => {
        total++
        if (p.conditions.PodScheduled) sched++
        if (p.conditions.Ready) ready++
      })
      return [
        { label: 'PodScheduled', value: `${sched}/${total}` },
        { label: 'Ready', value: `${ready}/${total}` },
      ]
    },
    keywords: ['conditions', 'PodScheduled', 'Initialized', 'ContainersReady', 'Ready', 'phase'],
  })

  const owner = r.register({
    id: 'pod.owner',
    title: 'Owner references',
    district: 'nodes',
    kubeName: 'metadata.ownerReferences',
    focus: podFocus,
    summary: 'The chain Deployment → ReplicaSet → Pod is made of records; only the Pod is ever matter.',
    detail: [
      'A Pod created by a controller carries an ownerReference with controller: true pointing at its ReplicaSet, which carries one pointing at its Deployment. The name on each lot\'s plate shows the chain: `web-7d9f4c8b6-x2k4z` is a Pod of ReplicaSet `web-7d9f4c8b6` of Deployment `web`.',
      'The reference is what makes deletion cascade. Delete the Deployment and the garbage collector — not the Deployment controller — finds every object whose owner UID no longer resolves and deletes it. That is also why `kubectl delete deploy --cascade=orphan` leaves the pods running.',
      'It is also what makes adoption possible: a ReplicaSet adopts a matching Pod that has no controller owner, which is how `kubectl apply` over hand-made pods can quietly take them over.',
      'Nothing in this chain runs your code. A Deployment is a record that a controller reads; only the Pod ever becomes a building.',
    ],
    caveats: ['Finalizers and the foreground/background deletion distinction are not modelled here.'],
    metrics: (s) => {
      let owned = 0
      let orphan = 0
      s.pods.forEach((p) => {
        if (p.owner) owned++
        else orphan++
      })
      return [
        { label: 'Controller-owned pods', value: String(owned) },
        { label: 'Standalone pods', value: String(orphan), hint: 'nothing will recreate these' },
      ]
    },
    keywords: ['ownerReferences', 'garbage collection', 'cascade', 'adoption', 'ReplicaSet'],
  })

  const termination = r.register({
    id: 'pod.termination',
    title: 'Graceful termination',
    district: 'nodes',
    kubeName: 'deletionGracePeriodSeconds',
    focus: podFocus,
    summary: 'Delete sets a timestamp. Endpoints drop the Pod at once; the process gets 30 seconds to finish.',
    detail: [
      'Deleting a Pod does not remove it. The API server sets deletionTimestamp and a grace period, and the object stays in etcd, visible as Terminating.',
      'Two things then happen in parallel. The endpoint controllers mark the Pod not-serving and every node\'s kube-proxy stops sending it new connections — that is the light strip going dark here, immediately. kubelet, separately, runs the preStop hook and sends SIGTERM.',
      'They are not ordered with respect to each other. A Pod can receive SIGTERM before the last node has finished reprogramming its rules, which is why a preStop sleep of a few seconds removes far more 502s than any amount of readiness tuning.',
      'When the grace period expires, kubelet sends SIGKILL and the object is finally removed from etcd. The bar on the lot is that countdown; it turns red at the end, when the choice stops being the process\'s.',
      'The replacement does not wait for any of this: a terminating Pod is not counted as active, so the ReplicaSet controller creates its replacement the instant the timestamp is set. That is the hologram that lights while the old building is still draining.',
    ],
    caveats: [
      `The grace period is modelled as ${TIMING.terminationGraceSeconds}s, the API default; a Pod may set any value, and 0 means immediate SIGKILL.`,
      'Finalizers, which can hold a Pod in Terminating indefinitely, are not modelled.',
    ],
    metrics: (s) => [
      { label: 'Terminating', value: String(s.totals.podsTerminating) },
      { label: 'Grace period', value: `${TIMING.terminationGraceSeconds}s` },
    ],
    keywords: ['terminating', 'SIGTERM', 'preStop', 'grace period', 'deletionTimestamp', 'drain'],
  })

  const pending = r.register({
    id: 'pod.pending',
    title: 'Unscheduled pods',
    district: 'nodes',
    kubeName: 'spec.nodeName == ""',
    focus: yardFocus,
    summary: 'A Pod with no nodeName stands on no node — because there is nowhere for it to stand.',
    detail: [
      'These lots hold pods the scheduler has not bound. They are real API objects with a UID, labels and an owner, and they exist in etcd; they simply have no node, no sandbox, no IP and no container anywhere in the cluster.',
      'Pending is not a queue position. It means the scheduler ran its filter plugins over every node and none passed, or that it has not got to this pod yet. The reason is on the PodScheduled condition, and it names the failing filter per node.',
      'The commonest cause is that requests do not fit — remembering that the scheduler compares against the sum of *requests* on each node, not against actual usage. Taints, node affinity, volume topology and pod anti-affinity are the other usual suspects.',
      'Nothing about a Pending pod consumes node capacity. It costs one etcd key and a place in the scheduler\'s queue.',
    ],
    caveats: [
      'The queue itself — active, backoff and unschedulable — is drawn in the scheduler district.',
      'These lots hover north of the blocks purely so they are visible; real unscheduled pods have no location at all.',
    ],
    metrics: (s) => [
      { label: 'Pending pods', value: String(s.totals.podsPending) },
      { label: 'In the active queue', value: String(s.scheduler.activeQueue.length) },
      { label: 'Unschedulable', value: String(s.scheduler.unschedulableQueue.length) },
    ],
    keywords: ['Pending', 'unschedulable', 'nodeName', 'scheduler', 'FailedScheduling'],
  })

  const desired = r.register({
    id: 'pod.desired',
    title: 'Desired replicas',
    district: 'nodes',
    kubeName: 'spec.replicas',
    focus: yardFocus,
    summary: 'The gap between the number you wrote down and the number that exists. Controllers close it.',
    detail: [
      'Each hologram is one replica a workload wants and does not have. They appear the instant the number changes — writing `replicas: 6` is a single field update in etcd, and the gap is real before any controller has run.',
      'A controller then closes it: the ReplicaSet controller creates Pod objects, the scheduler binds them, kubelet builds them. Nothing pushes; each loop notices the difference on its own watch and acts.',
      'Kill a pod and the hologram lights immediately, because a pod being deleted stops counting toward the total the moment it gets a deletionTimestamp — exactly the filter the real ReplicaSet controller uses.',
      'This is the whole of Kubernetes in one picture: a declared number, an observed number, and a loop that reduces the difference. Every other controller in this city is the same shape.',
    ],
    caveats: [
      'Holograms are pooled: at most 16 are drawn no matter how large the gap gets.',
      'They hover in one row rather than at the node each replica will eventually land on, because at this point no node has been chosen.',
    ],
    metrics: (s) => {
      let desiredTotal = 0
      let actual = 0
      for (let i = 0; i < s.deployments.length; i++) {
        desiredTotal += s.deployments[i].replicas
        actual += s.deployments[i].statusReplicas
      }
      return [
        { label: 'Desired (Deployments)', value: String(desiredTotal) },
        { label: 'Actual', value: String(actual) },
        { label: 'Gap', value: String(Math.max(0, desiredTotal - actual)) },
      ]
    },
    keywords: ['desired', 'replicas', 'reconcile', 'ghost', 'level-triggered', 'actual state'],
  })

  const revision = r.register({
    id: 'pod.revision',
    title: 'Revisions during a rolling update',
    district: 'nodes',
    kubeName: 'deployment.kubernetes.io/revision',
    focus: podFocus,
    summary: 'Two ReplicaSets, both alive: old-revision pods keep serving while new-revision pods are proven.',
    detail: [
      'A Deployment change does not modify any Pod. It creates a new ReplicaSet with the new template and then moves replicas between the two, one at a time, within maxSurge and maxUnavailable.',
      'Pods of the current revision carry a lit band; superseded pods are drawn in plain structure and are removed as the rollout advances. Seeing both at once is the point — during a rollout your service is running two versions.',
      'The old ReplicaSet is not deleted when it reaches zero. It is kept, which is what makes `kubectl rollout undo` instant: the rollback is a scale-up of a ReplicaSet that already exists, not a new deployment.',
      'A rollout stalls when new pods never become Ready, because maxUnavailable stops the controller from removing more old ones. It stays stalled until progressDeadlineSeconds expires and the Progressing condition flips to ReplicaSetCreateError or ProgressDeadlineExceeded.',
    ],
    caveats: ['Revision colouring compares against the highest Deployment revision in the cluster, so a second Deployment mid-rollout can tint the other\'s pods.'],
    metrics: (s) => {
      let rolling = 0
      for (let i = 0; i < s.deployments.length; i++) if (s.deployments[i].rollingOut) rolling++
      return [
        { label: 'Deployments rolling out', value: String(rolling) },
        { label: 'ReplicaSets alive', value: String(s.replicaSets.length) },
      ]
    },
    keywords: ['rolling update', 'revision', 'maxSurge', 'maxUnavailable', 'rollback', 'ReplicaSet'],
  })

  return {
    pod,
    sandbox,
    netns,
    init,
    sidecar,
    states,
    imagepull,
    crashloop,
    oom,
    throttle,
    resources,
    qos,
    probes,
    conditions,
    owner,
    termination,
    pending,
    desired,
    revision,
  }
}
