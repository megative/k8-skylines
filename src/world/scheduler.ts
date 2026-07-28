import * as THREE from 'three'
import { ANCHOR, CITY, DISTRICTS, route, routeCurve } from './layout'
import type { WorldCtx, WorldModule } from './module'
import { COLOR, ghost, mat, neon, structural } from '../core/theme'
import { N_NODES } from '../core/types'
import type {
  NodeState,
  NodeVerdict,
  PodState,
  SchedulerPhase,
  SchedulingCycle,
  SimState,
} from '../core/types'
import { clamp, formatCpu, formatMem, formatMs } from '../core/util'

/* ============================================================================
 * THE SCHEDULING HALL — kube-scheduler.
 *
 * The district is laid out as the cycle itself, running south to north:
 *
 *      queues (south)  ->  dequeue podium  ->  FILTER gate row
 *                      ->  SCORE towers    ->  RESERVE pads
 *                      ->  dispatch gantry ->  'scheduler-to-api' route
 *
 * Two claims the geometry has to get right, because they are the two things
 * people get wrong about Pending pods:
 *
 *  1. The filter compares the pod's *requests* against the node's *allocatable*
 *     minus the requests already bound there. Live usage is drawn as a thin
 *     white tick on the same meter and is deliberately not load-bearing.
 *  2. Binding is an API write. The decision leaves along 'scheduler-to-api';
 *     nothing travels from here to a node.
 * ==========================================================================*/

/* --------------------------------------------------------------------------
 * Shared unit geometry. Every mesh in this district scales one of these, so a
 * repeated shape costs one BufferGeometry. They are module-scoped singletons
 * and intentionally outlive dispose(): the district is a singleton too.
 * ------------------------------------------------------------------------*/

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1)
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14)
const UNIT_CONE = new THREE.ConeGeometry(0.5, 1, 4)
const UNIT_ICO = new THREE.IcosahedronGeometry(0.5, 1)

/* Scratch. The frame loop must not allocate. */
const V1 = new THREE.Vector3()
const V2 = new THREE.Vector3()

/* --------------------------------------------------------------------------
 * Text signage.
 *
 * There is no shared label helper in core, so this district carries its own.
 * A Label owns one canvas, one texture and one material; it repaints only when
 * the string it was handed actually changes, so the steady-state frame cost is
 * a string comparison. Labels are the only materials this district creates and
 * the only ones dispose() is allowed to free — theme materials are shared.
 * ------------------------------------------------------------------------*/

/** Canvas pixels per world unit. High enough to stay sharp at eye level. */
const LABEL_DPU = 16
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const fontCache = new Map<number, string>()

function fontOf(px: number): string {
  let f = fontCache.get(px)
  if (f === undefined) {
    f = `600 ${px}px ${FONT_STACK}`
    fontCache.set(px, f)
  }
  return f
}

const intCache = new Map<number, string>()

/** Integer to string without allocating once the value has been seen before. */
function intStr(n: number): string {
  const i = Math.round(n)
  let s = intCache.get(i)
  if (s === undefined) {
    if (intCache.size > 4096) intCache.clear()
    s = String(i)
    intCache.set(i, s)
  }
  return s
}

type LabelMode = 'one' | 'two' | 'lines'

class Label {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.MeshBasicMaterial
  private readonly texture: THREE.CanvasTexture | null = null
  private readonly ctx: CanvasRenderingContext2D | null = null
  private readonly cw: number
  private readonly ch: number
  private readonly align: 'center' | 'left'
  private mode: LabelMode = 'one'
  /* '\0' can never be produced by the sim, so the first set() always paints. */
  private a = '\0'
  private b = '\0'
  private hex: number

  constructor(w: number, h: number, color: number, align: 'center' | 'left' = 'center') {
    this.cw = Math.max(8, Math.round(w * LABEL_DPU))
    this.ch = Math.max(8, Math.round(h * LABEL_DPU))
    this.align = align
    this.hex = color
    /* Guarded so the district can be built headless, in tests. */
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = this.cw
      canvas.height = this.ch
      this.ctx = canvas.getContext('2d')
      this.texture = new THREE.CanvasTexture(canvas)
      this.texture.colorSpace = THREE.SRGBColorSpace
      this.texture.anisotropy = 4
    }
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(UNIT_PLANE, this.material)
    this.mesh.scale.set(w, h, 1)
    this.mesh.renderOrder = 3
  }

  set(text: string): void {
    if (this.mode === 'one' && this.a === text) return
    this.mode = 'one'
    this.a = text
    this.repaint()
  }

  /** Left-aligned key, right-aligned value. Used for "activeQueue   7". */
  set2(left: string, right: string): void {
    if (this.mode === 'two' && this.a === left && this.b === right) return
    this.mode = 'two'
    this.a = left
    this.b = right
    this.repaint()
  }

  setLines(top: string, bottom: string): void {
    if (this.mode === 'lines' && this.a === top && this.b === bottom) return
    this.mode = 'lines'
    this.a = top
    this.b = bottom
    this.repaint()
  }

  setColor(hex: number): void {
    if (this.hex === hex) return
    this.hex = hex
    this.material.color.setHex(hex)
  }

  set visible(v: boolean) {
    this.mesh.visible = v
  }

  private fit(ctx: CanvasRenderingContext2D, text: string, maxPx: number, startPx: number): number {
    let px = startPx
    while (px > 7) {
      ctx.font = fontOf(px)
      if (ctx.measureText(text).width <= maxPx) break
      px -= 1
    }
    ctx.font = fontOf(px)
    return px
  }

  private repaint(): void {
    const ctx = this.ctx
    if (!ctx) return
    const pad = Math.round(this.ch * 0.14)
    ctx.clearRect(0, 0, this.cw, this.ch)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    if (this.mode === 'lines') {
      const px = Math.floor(this.ch * 0.36)
      ctx.textAlign = 'center'
      this.fit(ctx, this.a, this.cw - pad * 2, px)
      ctx.fillText(this.a, this.cw / 2, this.ch * 0.29)
      this.fit(ctx, this.b, this.cw - pad * 2, px)
      ctx.fillText(this.b, this.cw / 2, this.ch * 0.71)
      if (this.texture) this.texture.needsUpdate = true
      return
    }
    const px = Math.floor(this.ch * 0.66)
    if (this.mode === 'two') {
      ctx.textAlign = 'left'
      this.fit(ctx, this.a, this.cw * 0.66 - pad, px)
      ctx.fillText(this.a, pad, this.ch / 2)
      ctx.textAlign = 'right'
      this.fit(ctx, this.b, this.cw * 0.3, px)
      ctx.fillText(this.b, this.cw - pad, this.ch / 2)
    } else if (this.align === 'left') {
      ctx.textAlign = 'left'
      this.fit(ctx, this.a, this.cw - pad * 2, px)
      ctx.fillText(this.a, pad, this.ch / 2)
    } else {
      ctx.textAlign = 'center'
      this.fit(ctx, this.a, this.cw - pad * 2, px)
      ctx.fillText(this.a, this.cw / 2, this.ch / 2)
    }
    if (this.texture) this.texture.needsUpdate = true
  }

  dispose(): void {
    this.material.dispose()
    this.texture?.dispose()
  }
}

/* --------------------------------------------------------------------------
 * District-local layout. Shared coordinates come from layout.ts; everything
 * below is detail inside the scheduler's own footprint.
 * ------------------------------------------------------------------------*/

const SCHED = ANCHOR.scheduler
const QUEUE = ANCHOR.schedulerQueue
/** Everything on the control plane stands on the mesa deck, not on grade. */
const DECK_Y = CITY.mesa.top

const LANES = N_NODES
const LANE_PITCH = 42
const laneX = (i: number): number => (i - (LANES - 1) / 2) * LANE_PITCH

/* Hall-local Z of each stage of the cycle. -Z is north, toward the API server. */
const Z_PODIUM = 34
const Z_METER = 17.5
const Z_GATE = 8
const Z_SCORE = -14
const Z_RESERVE = -32
const Z_RAIL_X = -84

const QUEUE_OFF_X = 46
const QUEUE_SLOTS = 5
const QUEUE_SLOT_PITCH = 7
const QUEUE_FRONT_Z = -14

const MAX_PLUGIN_BARS = 4
const MAX_VICTIMS = 3

const BIND_FLIGHT_SECONDS = 2.2
/** Bounce travel, then a hold so the reason stays readable. */
const BOUNCE_SECONDS = 1.3
const BOUNCE_HOLD_SECONDS = 3.5

const PHASE_ROW: Record<Exclude<SchedulerPhase, 'idle'>, number> = {
  dequeue: 0,
  filter: 1,
  score: 2,
  reserve: 3,
  bind: 4,
}

/* --------------------------------------------------------------------------
 * Kubernetes arithmetic the geometry depends on.
 * ------------------------------------------------------------------------*/

/**
 * A pod's effective request: max(sum of non-init containers, largest init
 * container). This — not usage — is what NodeResourcesFit compares against
 * allocatable.
 */
function effectiveRequestCpu(p: PodState): number {
  let sum = 0
  let maxInit = 0
  for (let i = 0; i < p.containers.length; i++) {
    const c = p.containers[i]!
    if (c.role === 'init') {
      if (c.requestCpuMilli > maxInit) maxInit = c.requestCpuMilli
    } else sum += c.requestCpuMilli
  }
  return sum > maxInit ? sum : maxInit
}

function effectiveRequestMem(p: PodState): number {
  let sum = 0
  let maxInit = 0
  for (let i = 0; i < p.containers.length; i++) {
    const c = p.containers[i]!
    if (c.role === 'init') {
      if (c.requestMemMib > maxInit) maxInit = c.requestMemMib
    } else sum += c.requestMemMib
  }
  return sum > maxInit ? sum : maxInit
}

function findVerdict(cycle: SchedulingCycle, nodeName: string): NodeVerdict | undefined {
  for (let i = 0; i < cycle.verdicts.length; i++) {
    const v = cycle.verdicts[i]!
    if (v.nodeName === nodeName) return v
  }
  return undefined
}

const EASE = (t: number): number => t * t * (3 - 2 * t)

/* ==========================================================================
 * Build.
 * ========================================================================*/

export function createScheduler(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'scheduler'

  const labels: Label[] = []
  const label = (w: number, h: number, color: number, align: 'center' | 'left' = 'center'): Label => {
    const l = new Label(w, h, color, align)
    labels.push(l)
    return l
  }

  /* Materials are fetched once, here. A frame never builds or mutates one:
   * theme's cache is shared with every other district. */
  const CONCRETE = structural('concrete')
  const DECK = structural('deck')
  const M_CONCRETE = mat(CONCRETE)
  const M_DECK = mat(DECK)
  const M_DARK = mat(CONCRETE, 0.95)
  const M_SCHED_DIM = neon(COLOR.scheduler, 0.55)
  const M_SCHED = neon(COLOR.scheduler, 1.6)
  const M_SCHED_HOT = neon(COLOR.scheduler, 2.6)
  const M_FAIL = neon(COLOR.failed, 1.9)
  const M_PENDING = neon(COLOR.pending, 1.5)
  const M_BACKOFF = neon(COLOR.backoff, 1.4)
  const M_API = neon(COLOR.api, 2.0)
  const M_ACTUAL = neon(COLOR.actual, 1.2)
  const M_TERMINATING = neon(COLOR.terminating, 1.6)
  const M_READY = neon(COLOR.ready, 2.2)
  const M_GHOST_FIT = ghost(COLOR.desired, 0.36)
  const M_GHOST_OVER = ghost(COLOR.failed, 0.4)
  const M_GHOST_ASSUME = ghost(COLOR.scheduler, 0.34)

  const box = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(UNIT_BOX, m)
    mesh.scale.set(w, h, d)
    return mesh
  }
  const cyl = (r: number, h: number, m: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(UNIT_CYL, m)
    mesh.scale.set(r * 2, h, r * 2)
    return mesh
  }

  /* ------------------------------------------------------------------
   * The hall.
   * ----------------------------------------------------------------*/

  const hall = new THREE.Group()
  hall.position.set(SCHED[0], DECK_Y, SCHED[2])
  group.add(hall)

  const hallDeck = box(196, 1.2, 112, M_DECK)
  hallDeck.position.set(0, -0.6, -4)
  hallDeck.receiveShadow = true
  hall.add(hallDeck)

  const hallSign = label(46, 4.4, COLOR.scheduler)
  hallSign.set('kube-scheduler')
  hallSign.mesh.position.set(0, 6, 52)
  hall.add(hallSign.mesh)

  /* The cycle rail: one lamp and one caption per phase, standing beside the
   * row of geometry that phase actually drives. */
  const railLamps: THREE.Mesh[] = []
  const RAIL_Z = [Z_PODIUM, Z_GATE, Z_SCORE, Z_RESERVE, -46]
  const RAIL_TEXT = ['1 dequeue', '2 filter', '3 score', '4 reserve', '5 bind']
  for (let i = 0; i < RAIL_Z.length; i++) {
    const lamp = box(3, 3, 3, M_DARK)
    lamp.position.set(Z_RAIL_X, 2, RAIL_Z[i]!)
    hall.add(lamp)
    railLamps.push(lamp)
    const cap = label(22, 3.2, COLOR.text, 'left')
    cap.set(RAIL_TEXT[i]!)
    cap.mesh.rotation.x = -Math.PI / 2
    cap.mesh.position.set(Z_RAIL_X + 14, 0.3, RAIL_Z[i]!)
    hall.add(cap.mesh)
  }

  /* The lesson label for the fit meters, on the deck where you walk past it. */
  const meterLegend = label(58, 6, COLOR.text)
  meterLegend.setLines(
    'filter: pod requests vs node allocatable',
    'white tick = live usage, which the filter ignores',
  )
  meterLegend.mesh.rotation.x = -Math.PI / 2
  meterLegend.mesh.position.set(0, 0.3, Z_METER + 12)
  hall.add(meterLegend.mesh)

  const cpuTag = label(9, 2.4, COLOR.text, 'left')
  cpuTag.set('cpu')
  cpuTag.mesh.rotation.x = -Math.PI / 2
  cpuTag.mesh.position.set(-92, 1.4, Z_METER - 2)
  hall.add(cpuTag.mesh)
  const memTag = label(9, 2.4, COLOR.text, 'left')
  memTag.set('mem')
  memTag.mesh.rotation.x = -Math.PI / 2
  memTag.mesh.position.set(-92, 1.4, Z_METER + 2)
  hall.add(memTag.mesh)

  /* ------------------------------------------------------------------
   * One lane per node: fit meters, filter gate, score tower, reserve pad.
   * ----------------------------------------------------------------*/

  interface Lane {
    root: THREE.Group
    nameSign: Label
    /* Filter */
    gateLamp: THREE.Mesh
    gatePosts: THREE.Mesh[]
    reason: Label
    cpuFill: THREE.Mesh
    cpuAdd: THREE.Mesh
    cpuTick: THREE.Mesh
    memFill: THREE.Mesh
    memAdd: THREE.Mesh
    memTick: THREE.Mesh
    /* Score */
    scoreBoard: THREE.Group
    scoreFill: THREE.Mesh
    scoreText: Label
    bars: THREE.Mesh[]
    barLabels: Label[]
    /* Reserve / winner */
    assume: THREE.Mesh
    beacon: THREE.Mesh
  }

  const lanes: Lane[] = []
  const METER_LEN = 28

  for (let i = 0; i < LANES; i++) {
    const root = new THREE.Group()
    root.position.set(laneX(i), 0, 0)
    hall.add(root)

    /* --- meter plinth: what the filter actually reads --- */
    const plinth = box(30, 1, 12, M_CONCRETE)
    plinth.position.set(0, 0.5, Z_METER)
    plinth.receiveShadow = true
    root.add(plinth)

    const mkMeter = (z: number) => {
      const track = box(METER_LEN, 1.1, 2.2, M_DARK)
      track.position.set(0, 1.55, z)
      root.add(track)
      const fill = box(1, 1.5, 2.6, M_SCHED)
      fill.position.set(0, 1.8, z)
      root.add(fill)
      const add = new THREE.Mesh(UNIT_BOX, M_GHOST_FIT)
      add.scale.set(1, 2.2, 3)
      add.position.set(0, 2.1, z)
      root.add(add)
      const tick = box(0.7, 3.2, 3.2, M_ACTUAL)
      tick.position.set(0, 2.3, z)
      root.add(tick)
      return { fill, add, tick }
    }
    const cpuMeter = mkMeter(Z_METER - 2)
    const memMeter = mkMeter(Z_METER + 2)

    /* --- filter gate --- */
    const postL = box(2, 13, 2, M_CONCRETE)
    postL.position.set(-7, 6.5, Z_GATE)
    postL.castShadow = true
    root.add(postL)
    const postR = box(2, 13, 2, M_CONCRETE)
    postR.position.set(7, 6.5, Z_GATE)
    postR.castShadow = true
    root.add(postR)
    const lintel = box(16, 2, 2.4, M_CONCRETE)
    lintel.position.set(0, 14, Z_GATE)
    root.add(lintel)

    const gateLamp = box(11, 5, 0.8, M_SCHED_DIM)
    gateLamp.position.set(0, 8.5, Z_GATE)
    root.add(gateLamp)

    const nameSign = label(15, 3, COLOR.text)
    nameSign.mesh.position.set(0, 16.5, Z_GATE)
    root.add(nameSign.mesh)

    const reason = label(28, 3.4, COLOR.failed)
    reason.mesh.position.set(0, 4.2, Z_GATE + 1.6)
    reason.visible = false
    root.add(reason.mesh)

    /* --- score tower --- */
    const scoreTrack = box(2.2, 26, 2.2, M_DARK)
    scoreTrack.position.set(-9, 13, Z_SCORE)
    root.add(scoreTrack)
    const scoreFill = box(3, 1, 3, M_SCHED)
    scoreFill.position.set(-9, 0, Z_SCORE)
    root.add(scoreFill)
    const scoreText = label(13, 3.6, COLOR.scheduler)
    scoreText.mesh.position.set(-9, 29, Z_SCORE)
    root.add(scoreText.mesh)

    /* --- per-plugin breakdown, a small horizontal bar chart --- */
    const scoreBoard = new THREE.Group()
    scoreBoard.position.set(2, 0, Z_SCORE)
    root.add(scoreBoard)
    const backing = box(18, 16, 0.4, M_DARK)
    backing.position.set(9, 11, -0.6)
    scoreBoard.add(backing)
    const bars: THREE.Mesh[] = []
    const barLabels: Label[] = []
    for (let b = 0; b < MAX_PLUGIN_BARS; b++) {
      const y = 17 - b * 3.6
      const bar = box(1, 1, 0.8, M_SCHED_DIM)
      bar.position.set(1, y - 1.1, 0)
      scoreBoard.add(bar)
      bars.push(bar)
      const bl = label(16, 1.9, COLOR.text, 'left')
      bl.mesh.position.set(9, y + 0.3, 0.1)
      scoreBoard.add(bl.mesh)
      barLabels.push(bl)
    }

    /* --- reserve pad: where the assume ticket lands --- */
    const pad = box(16, 0.7, 12, M_CONCRETE)
    pad.position.set(0, 0.35, Z_RESERVE)
    root.add(pad)
    const assume = new THREE.Mesh(UNIT_BOX, M_GHOST_ASSUME)
    assume.scale.set(10, 6, 8)
    assume.position.set(0, 3.7, Z_RESERVE)
    assume.visible = false
    root.add(assume)

    const beacon = cyl(1.2, 40, M_SCHED_HOT)
    beacon.position.set(0, 20, Z_SCORE)
    beacon.visible = false
    root.add(beacon)

    lanes.push({
      root,
      nameSign,
      gateLamp,
      gatePosts: [postL, postR],
      reason,
      cpuFill: cpuMeter.fill,
      cpuAdd: cpuMeter.add,
      cpuTick: cpuMeter.tick,
      memFill: memMeter.fill,
      memAdd: memMeter.add,
      memTick: memMeter.tick,
      scoreBoard,
      scoreFill,
      scoreText,
      bars,
      barLabels,
      assume,
      beacon,
    })
  }

  /* ------------------------------------------------------------------
   * The podium, the unschedulable banner, preemption, leader election.
   * ----------------------------------------------------------------*/

  const podium = cyl(7, 2, M_CONCRETE)
  podium.position.set(0, 1, Z_PODIUM)
  hall.add(podium)

  const banner = label(64, 5, COLOR.failed)
  banner.mesh.position.set(0, 17, Z_PODIUM - 1)
  banner.visible = false
  hall.add(banner.mesh)

  /* Preemption yard, east of the hall. */
  const preempt = new THREE.Group()
  preempt.position.set(84, 0, -18)
  hall.add(preempt)
  const preemptPad = box(28, 0.8, 30, M_CONCRETE)
  preemptPad.position.set(0, 0.4, 0)
  preempt.add(preemptPad)
  const preemptSign = label(26, 3.4, COLOR.terminating)
  preemptSign.set('preemption: victims')
  preemptSign.mesh.position.set(0, 12, 0)
  preempt.add(preemptSign.mesh)
  const victims: { body: THREE.Mesh; name: Label }[] = []
  for (let i = 0; i < MAX_VICTIMS; i++) {
    const body = box(6, 5, 6, M_TERMINATING)
    body.position.set(0, 3.3, -9 + i * 9)
    preempt.add(body)
    const nm = label(16, 2.4, COLOR.terminating)
    nm.mesh.position.set(0, 7.6, -9 + i * 9)
    preempt.add(nm.mesh)
    victims.push({ body, name: nm })
  }

  /* Leader election: the Lease mast. */
  const leaderMast = new THREE.Group()
  leaderMast.position.set(84, 0, 36)
  hall.add(leaderMast)
  const mastPole = cyl(1, 20, M_CONCRETE)
  mastPole.position.set(0, 10, 0)
  mastPole.castShadow = true
  leaderMast.add(mastPole)
  const leaderBeacon = new THREE.Mesh(UNIT_ICO, M_READY)
  leaderBeacon.scale.setScalar(4)
  leaderBeacon.position.set(0, 22, 0)
  leaderMast.add(leaderBeacon)
  const leaderSign = label(30, 6, COLOR.text)
  leaderSign.mesh.position.set(0, 28, 0)
  leaderMast.add(leaderSign.mesh)

  /* ------------------------------------------------------------------
   * The queue yard: three physically separate pens.
   * ----------------------------------------------------------------*/

  interface Pen {
    sign: Label
    overflow: Label
    carriers: { body: THREE.Mesh; name: Label }[]
    frontWorld: THREE.Vector3
  }

  const yard = new THREE.Group()
  yard.position.set(QUEUE[0], DECK_Y, QUEUE[2])
  group.add(yard)

  const yardDeck = box(150, 1, 56, M_DECK)
  yardDeck.position.set(0, -0.5, 0)
  yardDeck.receiveShadow = true
  yard.add(yardDeck)

  const PEN_COLOR = [COLOR.scheduler, COLOR.backoff, COLOR.failed]
  const PEN_TITLE = ['activeQueue', 'backoffQueue', 'unschedulableQueue']
  const PEN_MAT = [M_SCHED_DIM, M_BACKOFF, M_FAIL]
  const pens: Pen[] = []

  for (let q = 0; q < 3; q++) {
    const ox = (q - 1) * QUEUE_OFF_X
    const pen = new THREE.Group()
    pen.position.set(ox, 0, 0)
    yard.add(pen)

    const floor = box(36, 0.8, 44, M_CONCRETE)
    floor.position.set(0, 0.4, 0)
    floor.receiveShadow = true
    pen.add(floor)
    const railW = box(0.8, 2.2, 44, PEN_MAT[q]!)
    railW.position.set(-17.6, 1.6, 0)
    pen.add(railW)
    const railE = box(0.8, 2.2, 44, PEN_MAT[q]!)
    railE.position.set(17.6, 1.6, 0)
    pen.add(railE)
    const railS = box(36, 2.2, 0.8, PEN_MAT[q]!)
    railS.position.set(0, 1.6, 21.6)
    pen.add(railS)

    const sign = label(34, 3.6, PEN_COLOR[q]!)
    sign.mesh.position.set(0, 7, 22)
    pen.add(sign.mesh)

    const overflow = label(18, 2.4, COLOR.text)
    overflow.mesh.position.set(0, 3.4, 22)
    overflow.visible = false
    pen.add(overflow.mesh)

    const carriers: { body: THREE.Mesh; name: Label }[] = []
    for (let k = 0; k < QUEUE_SLOTS; k++) {
      const z = QUEUE_FRONT_Z + k * QUEUE_SLOT_PITCH
      const body = box(5.5, 4, 5, M_PENDING)
      body.position.set(0, 2.8, z)
      pen.add(body)
      const nm = label(15, 2.2, COLOR.text)
      nm.mesh.position.set(0, 6.4, z)
      pen.add(nm.mesh)
      carriers.push({ body, name: nm })
    }

    pens.push({
      sign,
      overflow,
      carriers,
      frontWorld: new THREE.Vector3(QUEUE[0] + ox, DECK_Y + 2.8, QUEUE[2] + QUEUE_FRONT_Z),
    })
  }

  /* Return paths: backoff expiry and cluster events feed the activeQueue. */
  for (let a = 0; a < 2; a++) {
    const arrow = new THREE.Mesh(UNIT_CONE, M_SCHED_DIM)
    arrow.scale.set(4, 7, 4)
    arrow.rotation.z = Math.PI / 2
    arrow.position.set(a === 0 ? -QUEUE_OFF_X / 2 : QUEUE_OFF_X / 2, 3, -19)
    yard.add(arrow)
  }
  const returnTag = label(40, 2.6, COLOR.text)
  returnTag.set('backoff expiry / cluster event -> activeQueue')
  returnTag.mesh.rotation.x = -Math.PI / 2
  returnTag.mesh.position.set(0, 1.2, -25)
  yard.add(returnTag.mesh)

  /* ------------------------------------------------------------------
   * The pod under consideration. It lives in world space because it walks
   * between the yard, the hall and back again.
   * ----------------------------------------------------------------*/

  const podCarrier = new THREE.Group()
  group.add(podCarrier)
  const podBody = box(7, 5.5, 7, M_PENDING)
  podBody.position.y = 2.8
  podCarrier.add(podBody)
  const podName = label(20, 3, COLOR.text)
  podName.mesh.position.set(0, 8.4, 0)
  podCarrier.add(podName.mesh)
  const podReq = label(26, 2.6, COLOR.desired)
  podReq.mesh.position.set(0, 11.6, 0)
  podCarrier.add(podReq.mesh)
  podCarrier.visible = false

  /* ------------------------------------------------------------------
   * The dispatch gantry and the Binding envelope. The gantry stands exactly
   * on the first point of the 'scheduler-to-api' route so the envelope never
   * jumps when it picks the route up.
   * ----------------------------------------------------------------*/

  const bindRoute = route('scheduler-to-api')
  const p0 = bindRoute.points[0]!
  const DISPATCH = new THREE.Vector3(p0[0], p0[1], p0[2])
  const bindCurve = routeCurve('scheduler-to-api')
  /* Warm the arc-length table now; getPointAt() must not build it in a frame. */
  bindCurve.getPointAt(0, V1)

  const gantry = new THREE.Group()
  gantry.position.set(DISPATCH.x, DECK_Y, DISPATCH.z)
  group.add(gantry)
  const gantryPole = cyl(1.4, DISPATCH.y - DECK_Y, M_CONCRETE)
  gantryPole.position.y = (DISPATCH.y - DECK_Y) / 2
  gantryPole.castShadow = true
  gantry.add(gantryPole)
  const gantryDeck = box(10, 1, 8, M_CONCRETE)
  gantryDeck.position.y = DISPATCH.y - DECK_Y
  gantry.add(gantryDeck)
  const gantrySign = label(30, 3, COLOR.api)
  gantrySign.set('POST pods/binding')
  gantrySign.mesh.position.set(0, DISPATCH.y - DECK_Y + 4.5, 0)
  gantry.add(gantrySign.mesh)

  const envelope = new THREE.Group()
  group.add(envelope)
  const envBody = box(5, 3.4, 6, M_API)
  envelope.add(envBody)
  const envTag = box(5.4, 0.8, 1.2, M_SCHED_HOT)
  envTag.position.set(0, 2.2, 0)
  envelope.add(envTag)
  const envLabel = label(24, 2.8, COLOR.api)
  envLabel.mesh.position.set(0, 5, 0)
  envelope.add(envLabel.mesh)
  envelope.visible = false

  /* Precomputed world targets for the pod carrier. No allocation per frame. */
  const W_PODIUM = new THREE.Vector3(SCHED[0], DECK_Y + 2, SCHED[2] + Z_PODIUM)
  const W_RESERVE: THREE.Vector3[] = []
  for (let i = 0; i < LANES; i++) {
    W_RESERVE.push(new THREE.Vector3(SCHED[0] + laneX(i), DECK_Y + 0.7, SCHED[2] + Z_RESERVE))
  }

  /* ------------------------------------------------------------------
   * Explainers.
   * ----------------------------------------------------------------*/

  const reg = ctx.registry

  const eScheduler = reg.register({
    id: 'scheduler',
    title: 'Scheduler',
    district: 'scheduler',
    kubeName: 'kube-scheduler',
    object: hall,
    focus: [SCHED[0] - 40, 70, SCHED[2] + 130],
    summary:
      'Watches for Pods that have no spec.nodeName, picks one node for each, and writes that choice back to the API server.',
    detail: [
      'The scheduler is an ordinary API client. It watches Pods, Nodes, PersistentVolumes, StorageClasses and more through informers, keeps a local cache, and runs one scheduling cycle at a time out of its own queues. It never talks to a kubelet and it never starts a container.',
      'A cycle is: pop a pod from activeQueue, run the Filter plugins to find feasible nodes, run the Score plugins over the survivors, take the highest-scoring node, Reserve (assume) it in the local cache, then POST a Binding. Everything before the Binding happens inside this building.',
      'Because Reserve only touches the scheduler\'s own cache, the next pod\'s cycle can start before the API write lands — that is how one scheduler keeps up. If the write fails, the assumption is un-reserved and the pod goes back into a queue.',
    ],
    caveats: [
      'The real scheduler splits the work into a synchronous scheduling cycle and an asynchronous binding cycle so several binds can be in flight. The model shows one pod at a time.',
      'The full extension-point list is PreEnqueue, QueueSort, PreFilter, Filter, PostFilter, PreScore, Score, NormalizeScore, Reserve, Permit, PreBind, Bind, PostBind. Only the phases with a distinct visible consequence are built here.',
      'Timings are scaled so a human can watch them; a real cycle on a small cluster takes single-digit milliseconds.',
    ],
    keywords: ['scheduling', 'pending', 'nodeName', 'binding', 'kube-scheduler'],
    metrics: (s) => [
      { label: 'leader', value: s.scheduler.leading ? 'yes' : 'no (standby)' },
      { label: 'phase', value: s.scheduler.cycle ? s.scheduler.cycle.phase : 'idle' },
      { label: 'pod', value: s.scheduler.cycle ? s.scheduler.cycle.podName : '—' },
      { label: 'scheduled', value: intStr(s.scheduler.scheduled) },
      { label: 'failed attempts', value: intStr(s.scheduler.failed) },
      { label: 'e2e latency', value: formatMs(s.scheduler.latencyMs), hint: 'scheduler_e2e_scheduling_duration_seconds' },
      {
        label: 'queued',
        value: `${s.scheduler.activeQueue.length} / ${s.scheduler.backoffQueue.length} / ${s.scheduler.unschedulableQueue.length}`,
        hint: 'active / backoff / unschedulable',
      },
    ],
  })
  reg.bind(podium, eScheduler)
  reg.bind(podCarrier, eScheduler)

  const eActive = reg.register({
    id: 'scheduler-active-queue',
    title: 'activeQueue',
    district: 'scheduler',
    kubeName: 'SchedulingQueue.activeQ',
    object: yard.children[1]!,
    summary: 'The run queue: pods eligible for a scheduling attempt right now, ordered by priority and then by the time they were queued.',
    detail: [
      'activeQueue is a heap ordered by the QueueSort plugin. The default, PrioritySort, compares spec.priority first — a pod from a higher PriorityClass is popped before an older, lower-priority one.',
      'A pod arrives here when it is created without a nodeName, when its backoff timer expires, or when a cluster event moves it out of the unschedulable queue.',
      'Depth here is not a problem by itself. A queue that never drains is either a scheduler that lost its lease, or pods that keep failing and cycling through backoff.',
    ],
    caveats: ['Real depth is unbounded; the pen shows the first few carriers and a count.'],
    keywords: ['queue', 'prioritysort', 'priority', 'fifo'],
    metrics: (s) => [
      { label: 'depth', value: intStr(s.scheduler.activeQueue.length) },
      { label: 'head', value: s.scheduler.activeQueue[0] ?? '—' },
    ],
  })

  const eBackoff = reg.register({
    id: 'scheduler-backoff-queue',
    title: 'backoffQueue',
    district: 'scheduler',
    kubeName: 'SchedulingQueue.podBackoffQ',
    object: yard.children[2]!,
    summary: 'Pods whose last attempt failed and which are serving an exponential backoff before they may be retried.',
    detail: [
      'Backoff starts at podInitialBackoffSeconds (1s) and doubles up to podMaxBackoffSeconds (10s), per pod. It exists so one unschedulable pod cannot spin the scheduler at full speed.',
      'A pod here is not blocked by anything you can read — it is waiting out a timer. When the timer expires it is moved to activeQueue and tried again with no memory of why it failed.',
      'This is the difference people miss: backoff is a rate limit, unschedulable is a verdict.',
    ],
    caveats: ['The timer runs on the simulation clock, which is scaled.'],
    keywords: ['backoff', 'retry', 'rate limit'],
    metrics: (s) => [{ label: 'depth', value: intStr(s.scheduler.backoffQueue.length) }],
  })

  const eUnsched = reg.register({
    id: 'scheduler-unschedulable-queue',
    title: 'unschedulableQueue',
    district: 'scheduler',
    kubeName: 'SchedulingQueue.unschedulablePods',
    object: yard.children[3]!,
    summary: 'Pods that no node could satisfy. They are parked rather than retried on a timer, waiting for an event that could change the answer.',
    detail: [
      'This pen is what a long-lived Pending pod actually is. kubectl describe pod prints the FailedScheduling event with the per-node tally, e.g. "0/4 nodes are available: 2 Insufficient cpu, 2 node(s) had untolerated taint."',
      'Pods leave when the scheduler sees a cluster event a plugin registered interest in — a node added or updated, a pod deleted, a PVC bound — or when the flush interval (30s) sweeps the whole pen back into activeQueue.',
      'Changing the cluster is what moves them. Deleting and recreating the pod does not, and neither does restarting the scheduler: the same filters will produce the same verdict.',
    ],
    caveats: [
      'Real gating is per-plugin via QueueingHint, so only events a failing plugin cares about wake a given pod. The model treats the pen as one group.',
    ],
    keywords: ['pending', 'unschedulable', 'failedscheduling', 'stuck'],
    metrics: (s) => [
      { label: 'depth', value: intStr(s.scheduler.unschedulableQueue.length) },
      { label: 'last reason', value: s.scheduler.cycle?.unschedulableReason ?? '—' },
    ],
  })

  const eFilter = reg.register({
    id: 'scheduler-filter',
    title: 'Filter phase',
    district: 'scheduler',
    kubeName: 'Filter plugins',
    object: lanes[0]!.gateLamp,
    summary: 'One yes/no gate per node. The answer for a rejected node is the string the user later reads on the Pending pod.',
    detail: [
      'NodeResourcesFit compares the pod\'s effective requests against status.allocatable minus the requests of the pods already bound to that node. It never reads live CPU or memory usage. The white tick on each meter is that live usage, drawn only to show that the gate ignores it.',
      'This is why a node sitting at 12% CPU in `kubectl top` can still answer "Insufficient cpu": allocatable is already committed to requests those pods are not using.',
      'The other gates in the row are TaintToleration, NodeAffinity / NodeSelector, NodeUnschedulable (what kubectl cordon sets), PodTopologySpread, InterPodAffinity, VolumeBinding (the node affinity of an already-bound PV), NodeName and NodePorts.',
      'If every gate rejects, PostFilter runs — and PostFilter is where preemption lives.',
    ],
    caveats: [
      'Every node is evaluated here. Real scheduling stops early once percentageOfNodesToScore (adaptive, at least 5%) nodes are found feasible, so on a large cluster the winner is the best of a sample, not of the cluster.',
      'The meters use effective pod request = max(sum of non-init containers, largest init container). Pod overhead from a RuntimeClass is real and is not drawn.',
    ],
    keywords: ['filter', 'noderesourcesfit', 'insufficient cpu', 'requests', 'allocatable', 'predicates'],
    metrics: (s) => {
      const c = s.scheduler.cycle
      let pass = 0
      if (c) for (const v of c.verdicts) if (v.passed) pass++
      return [
        { label: 'feasible nodes', value: c ? `${pass}/${c.verdicts.length}` : '—' },
        { label: 'cluster requested cpu', value: formatCpu(s.totals.cpuRequestedMilli), hint: 'this is what schedules' },
        { label: 'cluster allocatable cpu', value: formatCpu(s.totals.cpuAllocatableMilli) },
        { label: 'cluster requested mem', value: formatMem(s.totals.memRequestedMib) },
        { label: 'cluster allocatable mem', value: formatMem(s.totals.memAllocatableMib) },
      ]
    },
  })
  for (const lane of lanes) {
    reg.bind(lane.gateLamp, eFilter)
    reg.bind(lane.cpuFill, eFilter)
    reg.bind(lane.memFill, eFilter)
    reg.bind(lane.gatePosts[0]!, eFilter)
    reg.bind(lane.gatePosts[1]!, eFilter)
  }

  const eScore = reg.register({
    id: 'scheduler-score',
    title: 'Score phase',
    district: 'scheduler',
    kubeName: 'Score plugins',
    object: lanes[0]!.scoreBoard,
    summary: 'Each feasible node gets a 0-100 score from every Score plugin; the weighted sum picks the winner. Rejected nodes are never scored.',
    detail: [
      'Default plugins include NodeResourcesFit (LeastAllocated strategy), NodeResourcesBalancedAllocation, InterPodAffinity, NodeAffinity, PodTopologySpread (weight 2), TaintToleration and ImageLocality — the last is why a node that already has the image often wins.',
      'Each plugin is normalized to 0-100, multiplied by its weight and summed. The bars on each board are those per-plugin contributions.',
      'Ties are broken by picking uniformly at random among the top-scoring nodes, which is why two identical clusters do not always place pods identically.',
      'Scoring is a preference, never a rule. A pod lands happily on the worst-scoring node if it is the only one that passed the filter.',
    ],
    caveats: [
      'The model uses a small representative plugin set and shows normalized scores; real weights are configurable through a KubeSchedulerConfiguration profile.',
    ],
    keywords: ['score', 'priorities', 'leastallocated', 'imagelocality', 'weight'],
    metrics: (s) => {
      const c = s.scheduler.cycle
      const out: { label: string; value: string }[] = []
      if (!c) return [{ label: 'scoring', value: 'idle' }]
      for (const v of c.verdicts) {
        out.push({ label: v.nodeName, value: v.score === undefined ? 'not scored' : intStr(v.score) })
      }
      out.push({ label: 'winner', value: c.chosen ?? '—' })
      return out
    },
  })
  for (const lane of lanes) {
    reg.bind(lane.scoreBoard, eScore)
    reg.bind(lane.scoreFill, eScore)
  }

  const eBind = reg.register({
    id: 'scheduler-bind',
    title: 'Reserve and Bind',
    district: 'scheduler',
    kubeName: 'pods/binding',
    object: gantry,
    summary: 'Binding is a POST to the pod\'s binding subresource. The scheduler never contacts the chosen node.',
    detail: [
      'Reserve ("assume") writes the choice into the scheduler\'s own cache first, so the next cycle already counts this pod\'s requests against the node. Nothing outside this process knows yet — that is the translucent ticket on the reserve pad.',
      'Bind then POSTs a Binding object naming the pod and the target node. The API server sets spec.nodeName and the write rides the same admission pipeline and the same etcd commit as any other write. That is why the envelope leaves along the road to the API server and not toward the node.',
      'The kubelet on that node finds the pod through its own watch, filtered by spec.nodeName. Nothing was pushed to it, and the scheduler is finished the moment the write returns 201.',
      'If the write fails — conflict, webhook rejection, etcd unavailable — the assumption is un-reserved and the pod returns to a queue.',
    ],
    caveats: [
      'The real bind runs asynchronously and can be replaced by a Bind plugin (that is how a scheduler extender or a custom scheduler hooks in). The model dispatches one envelope per cycle.',
      'The envelope is the Binding, not the pod. The pod object never moves; only its spec.nodeName changes.',
    ],
    keywords: ['bind', 'binding', 'assume', 'reserve', 'nodeName'],
    metrics: (s) => [
      { label: 'bound', value: intStr(s.scheduler.scheduled) },
      { label: 'API writable', value: s.api.writable ? 'yes' : 'no — binds will fail' },
      { label: 'target', value: s.scheduler.cycle?.chosen ?? '—' },
    ],
  })
  reg.bind(envelope, eBind)
  for (const lane of lanes) reg.bind(lane.assume, eBind)

  const ePreempt = reg.register({
    id: 'scheduler-preemption',
    title: 'Preemption',
    district: 'scheduler',
    kubeName: 'PostFilter / DefaultPreemption',
    object: preempt,
    summary: 'When no node is feasible, PostFilter looks for a node where deleting lower-priority pods would make it feasible, and marks those pods for deletion.',
    detail: [
      'Preemption only happens for a pod whose spec.priority beats the victims\'. Priority comes from a PriorityClass; a pod with no PriorityClass has priority 0 and preempts nothing.',
      'The scheduler picks the node needing the fewest and lowest-priority victims, prefers not to violate a PodDisruptionBudget, and then deletes the victims with their normal terminationGracePeriodSeconds.',
      'The preemptor is not bound at this point. It gets status.nominatedNodeName so other pods can see the reservation, and it must still win a later scheduling cycle — a different pod can take the space in the meantime.',
      'This is why preemption looks slow: the grace period has to elapse before the requests are actually released.',
    ],
    caveats: [
      'PDB is a soft constraint here: the scheduler prefers not to break one, but will if there is no alternative. That differs from the eviction API, where a PDB is hard.',
    ],
    keywords: ['preemption', 'priorityclass', 'nominatednodename', 'eviction', 'postfilter'],
    metrics: (s) => [
      { label: 'victims', value: intStr(s.scheduler.cycle?.preempting.length ?? 0) },
      { label: 'preemptor', value: s.scheduler.cycle?.podName ?? '—' },
    ],
  })

  const eLeader = reg.register({
    id: 'scheduler-leader-election',
    title: 'Leader election',
    district: 'scheduler',
    kubeName: 'Lease kube-system/kube-scheduler',
    object: leaderMast,
    summary: 'Only one kube-scheduler schedules. The replicas race for a Lease; the losers run their informers and nothing else.',
    detail: [
      'The holder renews the Lease within renewDeadline (10s) against a leaseDuration of 15s, retrying every 2s. A standby that observes the lease expire acquires it and starts its own cycles.',
      'A standby is not a hot spare doing half the work: it runs no scheduling cycle at all, so its queues stay empty and its metrics stay flat. That is why "pods are not being scheduled" is a leader-election question before it is a capacity question.',
      'The same mechanism runs kube-controller-manager. It is deliberately boring: a Lease object in kube-system, visible with kubectl get lease -n kube-system.',
    ],
    caveats: [
      'The model draws one visible replica and takes leadership from a single boolean. A real cluster runs two or three replicas, and only the holder\'s building would be lit.',
    ],
    keywords: ['leader election', 'lease', 'standby', 'ha', 'kube-system'],
    metrics: (s) => [
      { label: 'holder', value: s.scheduler.leading ? 'this replica' : 'another replica' },
      { label: 'leaseDuration', value: '15s' },
      { label: 'renewDeadline', value: '10s' },
    ],
  })
  void eActive
  void eBackoff
  void eUnsched
  void ePreempt
  void eLeader

  /* ------------------------------------------------------------------
   * Frame state. All of it is scalars and pre-owned objects.
   * ----------------------------------------------------------------*/

  let flight = -1
  let flightLane = 0
  let bounce = -1
  let bouncedUid = ''
  let boundUid = ''
  let pulse = 0

  const districtBounds = DISTRICTS.find((d) => d.id === 'scheduler')
  void districtBounds

  function podLabel(s: SimState, key: string): string {
    const p = s.pods.get(key)
    return p ? p.name : key
  }

  function updateQueues(s: SimState): void {
    for (let q = 0; q < 3; q++) {
      const list =
        q === 0
          ? s.scheduler.activeQueue
          : q === 1
            ? s.scheduler.backoffQueue
            : s.scheduler.unschedulableQueue
      const pen = pens[q]!
      pen.sign.set2(PEN_TITLE[q]!, intStr(list.length))
      for (let k = 0; k < QUEUE_SLOTS; k++) {
        const c = pen.carriers[k]!
        const has = k < list.length
        c.body.visible = has
        c.name.visible = has
        if (has) c.name.set(podLabel(s, list[k]!))
      }
      const extra = list.length - QUEUE_SLOTS
      pen.overflow.visible = extra > 0
      if (extra > 0) pen.overflow.set2(intStr(extra), 'more')
    }
  }

  function updateMeters(s: SimState, cycle: SchedulingCycle | undefined): void {
    let reqCpu = 0
    let reqMem = 0
    if (cycle) {
      const pod = s.pods.get(cycle.podUid)
      if (pod) {
        reqCpu = effectiveRequestCpu(pod)
        reqMem = effectiveRequestMem(pod)
      }
    }
    for (let i = 0; i < LANES; i++) {
      const lane = lanes[i]!
      const node: NodeState | undefined = s.nodes[i]
      if (!node) {
        lane.root.visible = false
        continue
      }
      lane.root.visible = true

      const cpuBase = clamp(node.requestedCpuMilli / Math.max(1, node.allocatableCpuMilli), 0, 1)
      const memBase = clamp(node.requestedMemMib / Math.max(1, node.allocatableMemMib), 0, 1)
      const cpuAdd = clamp(reqCpu / Math.max(1, node.allocatableCpuMilli), 0, 1)
      const memAdd = clamp(reqMem / Math.max(1, node.allocatableMemMib), 0, 1)
      const cpuUse = clamp(node.usedCpuMilli / Math.max(1, node.allocatableCpuMilli), 0, 1)
      const memUse = clamp(node.usedMemMib / Math.max(1, node.allocatableMemMib), 0, 1)

      lane.cpuFill.scale.x = Math.max(0.001, METER_LEN * cpuBase)
      lane.cpuFill.position.x = -METER_LEN / 2 + (METER_LEN * cpuBase) / 2
      lane.memFill.scale.x = Math.max(0.001, METER_LEN * memBase)
      lane.memFill.position.x = -METER_LEN / 2 + (METER_LEN * memBase) / 2

      /* The ghost is the request this pod would add. Clipped at the end of the
       * track, and red when it does not fit: that clipping IS "Insufficient". */
      const cpuRoom = Math.min(cpuAdd, 1 - cpuBase)
      const memRoom = Math.min(memAdd, 1 - memBase)
      lane.cpuAdd.visible = cpuAdd > 0
      lane.cpuAdd.scale.x = Math.max(0.001, METER_LEN * Math.max(cpuRoom, cpuAdd > 0 ? 0.02 : 0))
      lane.cpuAdd.position.x = -METER_LEN / 2 + METER_LEN * cpuBase + (METER_LEN * cpuRoom) / 2
      lane.cpuAdd.material = cpuAdd > 1 - cpuBase ? M_GHOST_OVER : M_GHOST_FIT
      lane.memAdd.visible = memAdd > 0
      lane.memAdd.scale.x = Math.max(0.001, METER_LEN * Math.max(memRoom, memAdd > 0 ? 0.02 : 0))
      lane.memAdd.position.x = -METER_LEN / 2 + METER_LEN * memBase + (METER_LEN * memRoom) / 2
      lane.memAdd.material = memAdd > 1 - memBase ? M_GHOST_OVER : M_GHOST_FIT

      lane.cpuTick.position.x = -METER_LEN / 2 + METER_LEN * cpuUse
      lane.memTick.position.x = -METER_LEN / 2 + METER_LEN * memUse

      lane.nameSign.set(node.name)
    }
  }

  function updateCycle(s: SimState, cycle: SchedulingCycle | undefined, active: boolean): void {
    const phase: SchedulerPhase = cycle && active ? cycle.phase : 'idle'
    const reached = (p: SchedulerPhase): boolean => {
      if (!cycle || !active) return false
      return PHASE_ROW[p as Exclude<SchedulerPhase, 'idle'>] <= (PHASE_ROW[cycle.phase as Exclude<SchedulerPhase, 'idle'>] ?? -1)
    }
    const filterDone = reached('filter')
    const scoreDone = reached('score')

    for (let i = 0; i < LANES; i++) {
      const lane = lanes[i]!
      const node = s.nodes[i]
      const verdict = cycle && node ? findVerdict(cycle, node.name) : undefined
      const known = filterDone && verdict !== undefined

      /* Passed nodes stay lit; rejected nodes go dark and show the reason. */
      if (!known) {
        lane.gateLamp.material = active ? M_SCHED_DIM : M_DARK
        lane.reason.visible = false
      } else if (verdict!.passed) {
        lane.gateLamp.material = M_SCHED
        lane.reason.visible = false
      } else {
        lane.gateLamp.material = M_DARK
        const r = verdict!.reason
        if (r) {
          lane.reason.set(r)
          lane.reason.visible = true
        } else {
          lane.reason.visible = false
        }
      }

      /* Only feasible nodes are scored. A rejected lane's board stays empty. */
      const scored = scoreDone && verdict !== undefined && verdict.passed && verdict.score !== undefined
      lane.scoreBoard.visible = scored
      lane.scoreText.visible = scored
      lane.scoreFill.visible = scored
      if (scored) {
        const sc = clamp(verdict!.score!, 0, 100) / 100
        const h = Math.max(0.2, 26 * sc)
        lane.scoreFill.scale.y = h
        lane.scoreFill.position.y = h / 2
        lane.scoreText.set(intStr(verdict!.score!))
        const bd = verdict!.scoreBreakdown
        for (let b = 0; b < MAX_PLUGIN_BARS; b++) {
          const item = bd ? bd[b] : undefined
          const bar = lane.bars[b]!
          const bl = lane.barLabels[b]!
          bar.visible = item !== undefined
          bl.visible = item !== undefined
          if (item) {
            const w = Math.max(0.2, (clamp(item.score, 0, 100) / 100) * 15)
            bar.scale.x = w
            bar.position.x = 1 + w / 2
            bl.set2(item.plugin, intStr(item.score))
          }
        }
      }

      const isWinner = active && cycle?.chosen !== undefined && node !== undefined && cycle.chosen === node.name
      lane.beacon.visible = isWinner === true && (phase === 'reserve' || phase === 'bind')
      lane.assume.visible = isWinner === true && (phase === 'reserve' || phase === 'bind')
    }

    /* Phase rail. */
    const row = cycle && active ? PHASE_ROW[cycle.phase as Exclude<SchedulerPhase, 'idle'>] : undefined
    for (let i = 0; i < railLamps.length; i++) {
      railLamps[i]!.material = row === i ? M_SCHED_HOT : row !== undefined && i < row ? M_SCHED_DIM : M_DARK
    }
  }

  function updateCarrier(s: SimState, cycle: SchedulingCycle | undefined, active: boolean, dt: number): void {
    /* The bounce owns the carrier while it runs, even after the cycle is gone. */
    if (bounce >= 0) {
      bounce += dt
      const t = clamp(bounce / BOUNCE_SECONDS, 0, 1)
      const e = EASE(t)
      const target = pens[2]!.frontWorld
      V1.copy(W_PODIUM).lerp(target, e)
      V1.y += Math.sin(Math.PI * t) * 16
      podCarrier.position.copy(V1)
      podCarrier.visible = true
      podBody.material = M_PENDING
      banner.visible = true
      if (bounce > BOUNCE_SECONDS + BOUNCE_HOLD_SECONDS) {
        bounce = -1
        banner.visible = false
        podCarrier.visible = false
      }
      return
    }
    banner.visible = false

    if (!cycle || !active) {
      podCarrier.visible = false
      return
    }
    podCarrier.visible = true
    podName.set(cycle.podName)

    const pod = s.pods.get(cycle.podUid)
    if (pod) {
      /* Formatting allocates, so it runs only when the pod under consideration
       * changes — never on a frame where nothing happened. */
      if (boundUid !== cycle.podUid) {
        boundUid = cycle.podUid
        podReq.set2('requests', `${formatCpu(effectiveRequestCpu(pod))} / ${formatMem(effectiveRequestMem(pod))}`)
      }
    }

    const p = clamp(cycle.progress, 0, 1)
    let laneIdx = -1
    if (cycle.chosen !== undefined) {
      for (let i = 0; i < LANES; i++) {
        if (s.nodes[i]?.name === cycle.chosen) {
          laneIdx = i
          break
        }
      }
    }

    if (cycle.phase === 'dequeue') {
      V1.copy(pens[0]!.frontWorld).lerp(W_PODIUM, EASE(p))
      V1.y += Math.sin(Math.PI * p) * 10
      podCarrier.position.copy(V1)
      podBody.material = M_PENDING
    } else if (cycle.phase === 'reserve' && laneIdx >= 0) {
      V1.copy(W_PODIUM).lerp(W_RESERVE[laneIdx]!, EASE(p))
      V1.y += Math.sin(Math.PI * p) * 8
      podCarrier.position.copy(V1)
      podBody.material = M_PENDING
    } else if (cycle.phase === 'bind' && laneIdx >= 0) {
      podCarrier.position.copy(W_RESERVE[laneIdx]!)
      /* Assumed, not yet bound: the scheduler's cache says so, etcd does not. */
      podBody.material = M_GHOST_ASSUME
    } else {
      podCarrier.position.copy(W_PODIUM)
      podBody.material = M_PENDING
    }
  }

  function updateBind(s: SimState, cycle: SchedulingCycle | undefined, active: boolean, dt: number): void {
    if (flight < 0 && cycle && active && cycle.phase === 'bind' && cycle.chosen !== undefined) {
      for (let i = 0; i < LANES; i++) {
        if (s.nodes[i]?.name === cycle.chosen) {
          flightLane = i
          break
        }
      }
      envLabel.set2(cycle.podName, cycle.chosen)
      flight = 0
    }
    if (flight < 0) {
      envelope.visible = false
      return
    }
    flight += dt / BIND_FLIGHT_SECONDS
    if (flight >= 1) {
      flight = -1
      envelope.visible = false
      return
    }
    envelope.visible = true
    /* First a climb from the reserve pad to the gantry, then the shared route.
     * Bind is an API write: it must be seen leaving for the API server. */
    if (flight < 0.25) {
      const t = EASE(flight / 0.25)
      V1.copy(W_RESERVE[flightLane]!).lerp(DISPATCH, t)
      V1.y += Math.sin(Math.PI * (flight / 0.25)) * 4
      envelope.position.copy(V1)
    } else {
      bindCurve.getPointAt((flight - 0.25) / 0.75, V2)
      envelope.position.copy(V2)
    }
  }

  function update(s: SimState, dt: number): void {
    const sched = s.scheduler
    const active = sched.leading
    const cycle = sched.cycle

    pulse += dt

    /* Leader election. A standby runs no cycle at all — that is the lesson. */
    leaderBeacon.material = active ? M_READY : M_DARK
    leaderBeacon.scale.setScalar(active ? 4 + Math.sin(pulse * 3) * 0.5 : 3)
    if (active) {
      leaderSign.setLines('LEADING', 'Lease kube-system/kube-scheduler')
      leaderSign.setColor(COLOR.ready)
    } else {
      leaderSign.setLines('STANDBY', 'holds no lease, schedules nothing')
      leaderSign.setColor(COLOR.edge)
    }

    updateQueues(s)
    updateMeters(s, active ? cycle : undefined)
    updateCycle(s, cycle, active)

    /* Unschedulable: the pod visibly returns to the pen with its reason. */
    if (active && cycle && cycle.unschedulableReason && bouncedUid !== cycle.podUid) {
      bouncedUid = cycle.podUid
      bounce = 0
      banner.set(cycle.unschedulableReason)
      podName.set(cycle.podName)
    }

    updateCarrier(s, cycle, active, dt)
    updateBind(s, cycle, active, dt)

    /* Preemption victims, marked for deletion but still running out their
     * grace period — which is why the preemptor is not bound yet. */
    const pre = active && cycle ? cycle.preempting : undefined
    preempt.visible = pre !== undefined && pre.length > 0
    for (let i = 0; i < MAX_VICTIMS; i++) {
      const v = victims[i]!
      const has = pre !== undefined && i < pre.length
      v.body.visible = has
      v.name.visible = has
      if (has) {
        v.name.set(podLabel(s, pre![i]!))
        v.body.position.y = 3.3 + Math.sin(pulse * 4 + i) * 0.35
      }
    }
    if (pre && pre.length > MAX_VICTIMS) {
      preemptSign.set2('victims', intStr(pre.length))
    } else {
      preemptSign.set('preemption: victims')
    }
  }

  function dispose(): void {
    /* Only the label textures and materials belong to this district. Theme
     * materials and the unit geometries are shared and must survive. */
    for (const l of labels) l.dispose()
    labels.length = 0
  }

  return { group, update, dispose }
}
