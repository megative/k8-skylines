import * as THREE from 'three'
import {
  N_NODES,
  POD_SLOTS_PER_NODE,
  TIMING,
} from '../core/types'
import type {
  ConditionStatus,
  KubeletPhase,
  NodeConditionType,
  NodeState,
  SimState,
  Explainer,
} from '../core/types'
import { COLOR, getMode, ghost, mat, neon, structural } from '../core/theme'
import type { ThemeMode } from '../core/theme'
import { approach, clamp, formatCpu, formatMem, formatPercent } from '../core/util'
import { CITY, NODE_PARTS, nodeAnchor, nodeBounds, nodePartPos } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE NODE BLOCKS.
 *
 * Everything that is fixed machinery on a worker node: the deck, the capacity
 * gauge wall, kubelet's office, the CRI workshop, kube-proxy's rule cabinet,
 * the CNI bridge, the CSI riser, cAdvisor's meter, and the status mast that
 * carries conditions and taints. Pods are built by src/world/pods.ts and stand
 * on the plots this file deliberately leaves empty.
 *
 * The lesson this district exists to teach: `requested` and `used` are two
 * different numbers measured by two different subsystems for two different
 * purposes, and `allocatable` is not `capacity`. The gauge wall draws all four
 * on one ruler so they cannot be confused.
 * ==========================================================================*/

/* --------------------------------------------------------------------------
 * Fixed model limits. Drawing more than this per node would make the geometry
 * unreadable long before it would make it slow.
 * ------------------------------------------------------------------------*/
const MAX_DRAWERS = 5
const MAX_TAINTS = 3
const MAX_SHELVES = 4
const MAX_ENDPOINT_PIPS = 8
/** kubelet's default hard eviction signal: `memory.available<100Mi`. */
const EVICTION_MEM_MIB = 100
/** metrics-server's default `--metric-resolution`. */
const SCRAPE_PERIOD_SECONDS = 15

const KUBELET_PHASES: readonly KubeletPhase[] = [
  'idle',
  'syncing',
  'pulling',
  'sandbox',
  'cni',
  'csi',
  'starting',
  'probing',
  'terminating',
]

const PRESSURE_CONDITIONS: readonly NodeConditionType[] = [
  'MemoryPressure',
  'DiskPressure',
  'PIDPressure',
  'NetworkUnavailable',
]

/* --------------------------------------------------------------------------
 * Scratch. update() runs every frame and must allocate nothing, so every
 * vector, matrix and colour it touches lives here.
 * ------------------------------------------------------------------------*/
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mat4 = new THREE.Matrix4()
const _hidden = new THREE.Vector3(0, 0, 0)
const _unit = new THREE.Vector3(1, 1, 1)

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const TEXT = hex(COLOR.text)

/* --------------------------------------------------------------------------
 * Canvas-backed labels. Text is unlit so it stays legible at every zoom and in
 * both themes; each label paints its own dark backing plate for contrast.
 * A headless environment (vitest, no DOM) yields null canvases and the scene
 * graph is built with the same shape, minus the glyphs.
 * ------------------------------------------------------------------------*/

interface Canvas2D {
  canvas: HTMLCanvasElement
  g: CanvasRenderingContext2D
}

function makeCanvas(w: number, h: number): Canvas2D | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return null
  return { canvas, g }
}

function backdrop(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.clearRect(0, 0, w, h)
  g.fillStyle = 'rgba(8, 11, 18, 0.74)'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(74, 90, 112, 0.9)'
  g.lineWidth = Math.max(2, h * 0.02)
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth)
}

function texFromCanvas(c: Canvas2D): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/**
 * A label whose text changes rarely (a node name, a taint, a Service in a
 * kube-proxy drawer). Callers compare the *source fields* first and only build
 * a string when one changed; the repaint itself is deferred and rate-limited by
 * the district so a burst of changes cannot stall a frame.
 */
class DynLabel {
  readonly material: THREE.MeshBasicMaterial
  private readonly c: Canvas2D | null
  private readonly tex: THREE.CanvasTexture | null
  private readonly fontPx: number
  private readonly align: 'left' | 'center'
  private pending: string | null = null
  private shown = ''

  constructor(wPx: number, hPx: number, fontPx: number, align: 'left' | 'center') {
    this.c = makeCanvas(wPx, hPx)
    this.tex = this.c ? texFromCanvas(this.c) : null
    this.fontPx = fontPx
    this.align = align
    this.material = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
  }

  /** Cheap: a string compare. Only mark dirty when the content really moved. */
  set(text: string): void {
    if (text !== this.shown && text !== this.pending) this.pending = text
  }

  get dirty(): boolean {
    return this.pending !== null
  }

  flush(): void {
    const next = this.pending
    if (next === null) return
    this.pending = null
    this.shown = next
    const c = this.c
    if (!c || !this.tex) return
    const w = c.canvas.width
    const h = c.canvas.height
    backdrop(c.g, w, h)
    c.g.fillStyle = TEXT
    c.g.font = `${this.fontPx}px ${FONT_STACK}`
    c.g.textBaseline = 'middle'
    c.g.textAlign = this.align
    c.g.fillText(next, this.align === 'center' ? w / 2 : h * 0.28, h / 2, w - h * 0.5)
    this.tex.needsUpdate = true
  }

  dispose(): void {
    this.tex?.dispose()
    this.material.dispose()
  }
}

/* --------------------------------------------------------------------------
 * Per-node handles. Built once; update() only writes into these.
 * ------------------------------------------------------------------------*/

interface GaugeBlock {
  /** capacity is the ruler: always the full bar. */
  allocatable: THREE.Mesh
  reserved: THREE.Mesh
  requested: THREE.Mesh
  used: THREE.Mesh
  /** Where allocatable ends — the ceiling the scheduler actually compares to. */
  ceiling: THREE.Mesh
}

interface DrawerParts {
  group: THREE.Group
  front: THREE.Mesh
  endpoints: THREE.Mesh
  refused: THREE.Mesh
  label: DynLabel
  svc: string
  ip: string
  eps: number
}

interface NodeParts {
  index: number
  group: THREE.Group
  phase: number
  entry: Explainer | null
  titled: boolean

  rim: THREE.Mesh
  gateArm: THREE.Object3D

  name: DynLabel
  cpu: GaugeBlock
  mem: GaugeBlock
  memEvictTick: THREE.Mesh
  podsUsed: THREE.Mesh

  syncRing: THREE.Object3D
  leaseBeacon: THREE.Mesh
  leaseBar: THREE.Mesh
  phaseLamps: THREE.Mesh[]
  plegLamp: THREE.Mesh
  evictLamp: THREE.Mesh
  evictVane: THREE.Object3D

  pullCan: THREE.Mesh
  stationLamps: THREE.Mesh[]
  sandboxFrame: THREE.Mesh
  runcRam: THREE.Mesh
  shelves: THREE.Mesh[]
  shelfLabels: DynLabel[]
  shelfLabelMeshes: THREE.Mesh[]
  shelfImages: string[]

  drawers: DrawerParts[]

  csiWheel: THREE.Object3D
  csiSleeves: THREE.Mesh[]
  csiMountLamp: THREE.Mesh
  csiUnmountLamp: THREE.Mesh

  cidr: DynLabel
  cidrText: string

  cpuNeedle: THREE.Object3D
  memNeedle: THREE.Object3D
  scrapeLamp: THREE.Mesh

  beacon: THREE.Mesh
  unknownRing: THREE.Mesh
  condLamps: THREE.Mesh[]
  notReadyColumn: THREE.Mesh
  cordonColumn: THREE.Mesh
  cordonPlate: THREE.Object3D
  taints: {
    plate: THREE.Mesh
    label: DynLabel
    labelMesh: THREE.Mesh
    key: string
    value: string
    effect: string
  }[]

  /** Objects a shared Explainer binds to, so a click anywhere lands correctly. */
  binds: Record<BindId, THREE.Object3D>
}

type BindId =
  | 'deck'
  | 'console'
  | 'kubelet'
  | 'lease'
  | 'runtime'
  | 'cache'
  | 'proxy'
  | 'proxyRules'
  | 'cni'
  | 'csi'
  | 'metrics'
  | 'mast'
  | 'taintRack'
  | 'evict'

/** Status of a condition, defaulting the way the API server does for absentees. */
function conditionStatus(
  n: NodeState,
  type: NodeConditionType,
  absent: ConditionStatus,
): ConditionStatus {
  const cs = n.conditions
  for (let i = 0; i < cs.length; i++) {
    if (cs[i].type === type) return cs[i].status
  }
  return absent
}

/* --------------------------------------------------------------------------
 * The capacity gauge wall's readout geometry, in panel-local units. The tilted
 * console face spans x ∈ [-44, 44], y ∈ [-13, 13]; bars and baked text share
 * this frame so a bar always lines up with its label.
 * ------------------------------------------------------------------------*/
const PANEL_W = 88
const PANEL_H = 26
const BAR_X0 = -19
const BAR_L = 62
const BAR_H = 1.15
const CPU_ROWS = [7.6, 6.0, 4.4, 2.8] as const
const MEM_ROWS = [-0.8, -2.4, -4.0, -5.6] as const
const POD_ROWS = [-9.4, -11.0] as const

export function createNodes(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'district:nodes'

  /* ---- resources this district owns and must release ---- */
  const geos: THREE.BufferGeometry[] = []
  const textures: THREE.Texture[] = []
  const labels: DynLabel[] = []
  const owned: { m: THREE.MeshStandardMaterial; src: () => THREE.MeshStandardMaterial }[] = []
  const plateMats: THREE.MeshBasicMaterial[] = []

  function geo<T extends THREE.BufferGeometry>(g: T): T {
    geos.push(g)
    return g
  }

  /**
   * A private clone of a theme material. Districts swap material *references*
   * per frame to signal state; mutating the shared cache entry would repaint
   * every other district that happens to use the same hue. Clones keep a stable
   * identity so a theme flip can refresh them in place.
   */
  function own(src: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const m = src().clone()
    owned.push({ m, src })
    return m
  }

  let themeMode: ThemeMode = getMode()
  function refreshTheme(): void {
    for (let i = 0; i < owned.length; i++) {
      const o = owned[i]
      o.m.copy(o.src())
      o.m.needsUpdate = true
    }
  }

  /* ---- the palette. Every hue here names a mechanism, never a mood. ---- */
  const P = {
    deck: own(() => mat(structural('deck'))),
    concrete: own(() => mat(structural('concrete'))),
    edge: own(() => mat(COLOR.edge)),
    lampOff: own(() => mat(structural('concrete'), 0.95)),

    rimReady: own(() => neon(COLOR.ready, 1.7)),
    rimCordon: own(() => neon(COLOR.pending, 1.7)),
    rimDown: own(() => neon(COLOR.failed, 2.4)),

    kubelet: own(() => neon(COLOR.kubelet, 1.8)),
    kubeletUsed: own(() => neon(COLOR.kubelet, 1.35)),
    kubeletClaim: own(() => ghost(COLOR.kubelet, 0.26)),
    schedClaim: own(() => ghost(COLOR.scheduler, 0.34)),
    schedTick: own(() => neon(COLOR.scheduler, 1.6)),
    actual: own(() => neon(COLOR.actual, 1.2)),

    ok: own(() => neon(COLOR.ready, 1.6)),
    bad: own(() => neon(COLOR.failed, 2.2)),
    warn: own(() => neon(COLOR.pending, 1.8)),
    backoff: own(() => neon(COLOR.backoff, 2.0)),

    net: own(() => neon(COLOR.network, 1.7)),
    image: own(() => mat(COLOR.image, 0.55)),
    imageGhost: own(() => ghost(COLOR.image, 0.16)),
    storage: own(() => neon(COLOR.storage, 1.6)),
    sandbox: own(() => ghost(COLOR.desired, 0.3)),

    columnDown: own(() => ghost(COLOR.failed, 0.16)),
    columnCordon: own(() => ghost(COLOR.pending, 0.13)),
    taintNoExecute: own(() => neon(COLOR.failed, 1.5)),
    taintNoSchedule: own(() => neon(COLOR.pending, 1.5)),
    taintPrefer: own(() => ghost(COLOR.pending, 0.34)),
  }

  /* ---- shared geometry ---- */
  const gBox = geo(new THREE.BoxGeometry(1, 1, 1))
  /** Unit box anchored at its -x face: scale.x is a length that grows east. */
  const gBar = geo(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, 0))
  /** Unit box anchored at its -y face: scale.y is a height that grows up. */
  const gBarY = geo(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0))
  const gPlane = geo(new THREE.PlaneGeometry(1, 1))
  const gSphere = geo(new THREE.SphereGeometry(1, 18, 12))
  const gCyl = geo(new THREE.CylinderGeometry(1, 1, 1, 18))
  const gTorus = geo(new THREE.TorusGeometry(1, 0.1, 8, 40))
  const gLamp = geo(new THREE.BoxGeometry(1.3, 1.3, 0.5))
  const gSocket = geo(new THREE.BoxGeometry(2.8, 0.7, 2.8))
  const gPlug = geo(new THREE.BoxGeometry(1.9, 2.2, 1.9))

  const bounds0 = nodeBounds(0)
  const HX = (bounds0.maxX - bounds0.minX) / 2
  const HZ = (bounds0.maxZ - bounds0.minZ) / 2
  const DECK = CITY.node.top

  /* The deck rim is a rectangular ring lying flat; one geometry, four nodes. */
  const rimShape = new THREE.Shape()
  rimShape.moveTo(-HX, -HZ)
  rimShape.lineTo(HX, -HZ)
  rimShape.lineTo(HX, HZ)
  rimShape.lineTo(-HX, HZ)
  rimShape.closePath()
  const rimHole = new THREE.Path()
  const rt = 2.2
  rimHole.moveTo(-HX + rt, -HZ + rt)
  rimHole.lineTo(HX - rt, -HZ + rt)
  rimHole.lineTo(HX - rt, HZ - rt)
  rimHole.lineTo(-HX + rt, HZ - rt)
  rimHole.closePath()
  rimShape.holes.push(rimHole)
  const gRim = geo(new THREE.ShapeGeometry(rimShape).rotateX(-Math.PI / 2))

  /* ---- small builders ---- */
  function box(
    parent: THREE.Object3D,
    m: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(gBox, m)
    mesh.scale.set(w, h, d)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  function lamp(parent: THREE.Object3D, x: number, y: number, z = 0.55): THREE.Mesh {
    const mesh = new THREE.Mesh(gLamp, P.lampOff)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  /**
   * A face read from the north, where the control plane and the tour approach
   * from. Local +X reads left-to-right for that viewer and local +Z is toward
   * them, so decals and the lamps on top of them share one coordinate frame.
   */
  function northFace(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
    const g = new THREE.Group()
    g.position.set(x, y, z)
    g.rotation.y = Math.PI
    parent.add(g)
    return g
  }

  function plate(
    parent: THREE.Object3D,
    tex: THREE.Texture | null,
    w: number,
    h: number,
    z = 0.06,
  ): THREE.Mesh {
    const m = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: tex ? 1 : 0,
    })
    plateMats.push(m)
    const mesh = new THREE.Mesh(gPlane, m)
    mesh.scale.set(w, h, 1)
    mesh.position.z = z
    parent.add(mesh)
    return mesh
  }

  function dyn(
    parent: THREE.Object3D,
    label: DynLabel,
    w: number,
    h: number,
    x: number,
    y: number,
    z = 0.1,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(gPlane, label.material)
    mesh.scale.set(w, h, 1)
    mesh.position.set(x, y, z)
    parent.add(mesh)
    return mesh
  }

  function newLabel(wPx: number, hPx: number, fontPx: number, align: 'left' | 'center'): DynLabel {
    const l = new DynLabel(wPx, hPx, fontPx, align)
    labels.push(l)
    return l
  }

  function decal(
    wPx: number,
    hPx: number,
    draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  ): THREE.Texture | null {
    const c = makeCanvas(wPx, hPx)
    if (!c) return null
    backdrop(c.g, wPx, hPx)
    draw(c.g, wPx, hPx)
    const t = texFromCanvas(c)
    textures.push(t)
    return t
  }

  /* ------------------------------------------------------------------
   * Shared decals. The static text on a node is identical on every node,
   * so one texture serves all four blocks.
   * ----------------------------------------------------------------*/

  const CONSOLE_PX = 2048
  const CONSOLE_SCALE = CONSOLE_PX / PANEL_W
  const cpx = (x: number): number => (x + PANEL_W / 2) * CONSOLE_SCALE
  const cpy = (y: number): number => (PANEL_H / 2 - y) * CONSOLE_SCALE

  const consoleTex = decal(CONSOLE_PX, Math.round(PANEL_H * CONSOLE_SCALE), (g) => {
    const rowNames = ['CAPACITY', 'ALLOCATABLE', 'REQUESTED', 'USED'] as const
    g.fillStyle = TEXT
    g.textBaseline = 'middle'

    g.textAlign = 'left'
    g.font = `24px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('four measures, one ruler — a request is a claim, not consumption', cpx(-11), cpy(11.4))

    const block = (title: string, unit: string, rows: readonly number[], names: readonly string[]) => {
      g.textAlign = 'left'
      g.font = `bold 32px ${FONT_STACK}`
      g.fillStyle = TEXT
      g.fillText(title, cpx(-43), cpy(rows[0] + 1.6))
      g.font = `20px ${FONT_STACK}`
      g.fillStyle = hex(COLOR.edge)
      g.fillText(unit, cpx(-43) + 110, cpy(rows[0] + 1.6))
      for (let i = 0; i < rows.length; i++) {
        g.textAlign = 'right'
        g.font = `26px ${FONT_STACK}`
        g.fillStyle = TEXT
        g.fillText(names[i], cpx(-21), cpy(rows[i]))
        g.strokeStyle = 'rgba(74, 90, 112, 0.85)'
        g.lineWidth = 2
        g.strokeRect(
          cpx(BAR_X0),
          cpy(rows[i]) - (BAR_H * CONSOLE_SCALE) / 2,
          BAR_L * CONSOLE_SCALE,
          BAR_H * CONSOLE_SCALE,
        )
      }
      /* Percent ruler, so a bar can be read without a number on it. */
      const base = rows[rows.length - 1] - 1.5
      g.strokeStyle = 'rgba(74, 90, 112, 0.7)'
      g.textAlign = 'center'
      g.font = `17px ${FONT_STACK}`
      g.fillStyle = hex(COLOR.edge)
      for (let t = 0; t <= 4; t++) {
        const x = cpx(BAR_X0 + (BAR_L * t) / 4)
        g.beginPath()
        g.moveTo(x, cpy(base))
        g.lineTo(x, cpy(base) - 8)
        g.stroke()
        g.fillText(`${t * 25}%`, x, cpy(base) + 12)
      }
    }

    block('CPU', 'millicores', CPU_ROWS, rowNames)
    block('MEMORY', 'MiB', MEM_ROWS, rowNames)
    block('PODS', 'count', POD_ROWS, ['CAPACITY', 'RUNNING'])

    g.textAlign = 'left'
    g.font = `20px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText(
      'allocatable = capacity − kube-reserved − eviction threshold   ·   the scheduler adds up REQUESTED, the kernel enforces USED',
      cpx(-43),
      cpy(-12.4),
    )
  })

  /** Left column of a station face: a title and a list of labelled lamps. */
  function stationDecal(
    wPx: number,
    hPx: number,
    title: string,
    subtitle: string,
    rows: readonly string[],
    rowTopFrac: number,
    rowStepFrac: number,
    extras?: readonly { text: string; yFrac: number }[],
  ): THREE.Texture | null {
    return decal(wPx, hPx, (g, w, h) => {
      g.fillStyle = TEXT
      g.textBaseline = 'middle'
      g.textAlign = 'left'
      g.font = `bold ${Math.round(h * 0.085)}px ${FONT_STACK}`
      g.fillText(title, w * 0.06, h * 0.075)
      g.font = `${Math.round(h * 0.05)}px ${FONT_STACK}`
      g.fillStyle = hex(COLOR.edge)
      g.fillText(subtitle, w * 0.06, h * 0.155)
      g.font = `${Math.round(h * 0.055)}px ${FONT_STACK}`
      g.fillStyle = TEXT
      for (let i = 0; i < rows.length; i++) {
        g.fillText(rows[i], w * 0.24, h * (rowTopFrac + i * rowStepFrac))
      }
      if (extras) {
        g.fillStyle = hex(COLOR.edge)
        g.font = `${Math.round(h * 0.05)}px ${FONT_STACK}`
        for (let i = 0; i < extras.length; i++) {
          g.fillText(extras[i].text, w * 0.06, h * extras[i].yFrac)
        }
      }
    })
  }

  const kubeletTex = stationDecal(
    640,
    448,
    'kubelet',
    'the node agent · sync loop',
    KUBELET_PHASES as readonly string[],
    0.29,
    0.066,
    [
      { text: 'PLEG relist', yFrac: 0.885 },
      { text: 'eviction manager', yFrac: 0.955 },
    ],
  )

  const runtimeTex = stationDecal(
    640,
    384,
    'containerd',
    'CRI · runc · snapshotter',
    ['PullImage', 'RunPodSandbox', 'StartContainer'],
    0.42,
    0.14,
    [{ text: 'kubelet is only a gRPC client', yFrac: 0.93 }],
  )

  const cacheTex = decal(512, 320, (g, w, h) => {
    g.fillStyle = TEXT
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.font = `bold ${Math.round(h * 0.11)}px ${FONT_STACK}`
    g.fillText('image cache', w * 0.06, h * 0.11)
    g.font = `${Math.round(h * 0.07)}px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('present on disk — pull skipped', w * 0.06, h * 0.24)
  })

  const proxyTex = decal(512, 576, (g, w, h) => {
    g.fillStyle = TEXT
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.font = `bold ${Math.round(h * 0.062)}px ${FONT_STACK}`
    g.fillText('kube-proxy', w * 0.06, h * 0.055)
    g.font = `${Math.round(h * 0.037)}px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('Service rule table · one drawer per Service', w * 0.06, h * 0.115)
    g.fillText('the same drawers exist on every node', w * 0.06, h * 0.965)
  })

  const csiTex = stationDecal(
    448,
    384,
    'CSI node',
    'NodeStage / NodePublish',
    ['mount', 'unmount'],
    0.55,
    0.16,
    [{ text: 'provision + attach happen off-node', yFrac: 0.92 }],
  )

  const cniTex = decal(1024, 192, (g, w, h) => {
    g.fillStyle = TEXT
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.font = `bold ${Math.round(h * 0.24)}px ${FONT_STACK}`
    g.fillText('CNI bridge', w * 0.03, h * 0.28)
    g.font = `${Math.round(h * 0.15)}px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('one veth per pod sandbox · IPAM from this node’s podCIDR', w * 0.03, h * 0.62)
  })

  const metricsTex = decal(448, 384, (g, w, h) => {
    g.fillStyle = TEXT
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.font = `bold ${Math.round(h * 0.1)}px ${FONT_STACK}`
    g.fillText('cAdvisor', w * 0.06, h * 0.1)
    g.font = `${Math.round(h * 0.062)}px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('usage, not requests', w * 0.06, h * 0.21)
    g.textAlign = 'center'
    g.fillStyle = TEXT
    g.font = `${Math.round(h * 0.07)}px ${FONT_STACK}`
    g.fillText('CPU', w * 0.28, h * 0.93)
    g.fillText('MEM', w * 0.72, h * 0.93)
  })

  const mastTex = decal(512, 640, (g, w, h) => {
    g.fillStyle = TEXT
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    g.font = `bold ${Math.round(h * 0.055)}px ${FONT_STACK}`
    g.fillText('conditions', w * 0.06, h * 0.06)
    g.font = `${Math.round(h * 0.042)}px ${FONT_STACK}`
    g.fillStyle = TEXT
    for (let i = 0; i < PRESSURE_CONDITIONS.length; i++) {
      g.fillText(PRESSURE_CONDITIONS[i], w * 0.26, h * (0.17 + i * 0.085))
    }
    g.fillStyle = hex(COLOR.edge)
    g.font = `${Math.round(h * 0.038)}px ${FONT_STACK}`
    g.fillText('taints — repel pods that do not tolerate', w * 0.06, h * 0.56)
  })

  const cordonTex = decal(512, 128, (g, w, h) => {
    g.fillStyle = hex(COLOR.pending)
    g.textBaseline = 'middle'
    g.textAlign = 'center'
    g.font = `bold ${Math.round(h * 0.36)}px ${FONT_STACK}`
    g.fillText('SchedulingDisabled', w / 2, h * 0.38)
    g.font = `${Math.round(h * 0.24)}px ${FONT_STACK}`
    g.fillStyle = hex(COLOR.edge)
    g.fillText('spec.unschedulable — running pods stay', w / 2, h * 0.76)
  })

  const refusedTex = decal(256, 64, (g, w, h) => {
    g.fillStyle = hex(COLOR.failed)
    g.textBaseline = 'middle'
    g.textAlign = 'center'
    g.font = `bold ${Math.round(h * 0.5)}px ${FONT_STACK}`
    g.fillText('connection refused', w / 2, h / 2)
  })

  const gCylY = geo(new THREE.CylinderGeometry(1, 1, 1, 18).translate(0, 0.5, 0))

  /* ==================================================================
   * One node block.
   * ================================================================*/
  function buildNode(i: number): NodeParts {
    const root = new THREE.Group()
    nodeAnchor(i, _pos)
    root.position.copy(_pos)
    root.name = `node-${i}`
    group.add(root)

    /* ---- deck and its status rim ---- */
    const deck = box(root, P.deck, HX * 2, DECK, HZ * 2, 0, DECK / 2, 0)
    deck.receiveShadow = true
    const rim = new THREE.Mesh(gRim, P.rimReady)
    rim.position.y = DECK + 0.05
    root.add(rim)

    /* The cordon gate. `kubectl cordon` closes the block to *new* pods; the
     * ones already standing on the plots are untouched, so nothing else moves. */
    const gatePost = box(root, P.concrete, 1.6, 9, 1.6, -15, DECK + 4.5, -85)
    const gateArm = new THREE.Object3D()
    gateArm.position.set(-15, DECK + 8, -85)
    root.add(gateArm)
    const arm = new THREE.Mesh(gBar, P.warn)
    arm.scale.set(30, 1.1, 0.9)
    gateArm.add(arm)

    /* ---- the capacity gauge wall: a tilted console read from the north ---- */
    box(root, P.concrete, 92, 3.4, 7, 0, DECK + 1.7, -74)
    const consoleOuter = new THREE.Group()
    consoleOuter.position.set(0, 8, -68)
    consoleOuter.rotation.y = Math.PI
    root.add(consoleOuter)
    const panel = new THREE.Group()
    panel.rotation.x = -Math.PI / 3
    consoleOuter.add(panel)
    const panelBody = box(panel, P.concrete, PANEL_W + 2, PANEL_H + 1, 1.2, 0, 0, -0.7)
    plate(panel, consoleTex, PANEL_W, PANEL_H, 0.05)

    const name = newLabel(768, 72, 40, 'left')
    dyn(panel, name, 30, 2.4, -28, 11.4, 0.2)

    function gaugeBlock(rows: readonly number[]): GaugeBlock {
      /* CAPACITY is the ruler every other bar is measured against. */
      const cap = new THREE.Mesh(gBar, P.edge)
      cap.scale.set(BAR_L, BAR_H, 0.5)
      cap.position.set(BAR_X0, rows[0], 0.3)
      panel.add(cap)

      const allocatable = new THREE.Mesh(gBar, P.kubeletClaim)
      allocatable.position.set(BAR_X0, rows[1], 0.3)
      panel.add(allocatable)
      const reserved = new THREE.Mesh(gBar, P.edge)
      reserved.position.set(BAR_X0, rows[1], 0.28)
      panel.add(reserved)

      const requested = new THREE.Mesh(gBar, P.schedClaim)
      requested.position.set(BAR_X0, rows[2], 0.3)
      panel.add(requested)
      const ceiling = new THREE.Mesh(gBox, P.schedTick)
      ceiling.scale.set(0.45, BAR_H * 1.7, 0.6)
      ceiling.position.set(BAR_X0, rows[2], 0.4)
      panel.add(ceiling)

      const used = new THREE.Mesh(gBar, P.kubeletUsed)
      used.position.set(BAR_X0, rows[3], 0.3)
      panel.add(used)

      return { allocatable, reserved, requested, used, ceiling }
    }

    const cpu = gaugeBlock(CPU_ROWS)
    const mem = gaugeBlock(MEM_ROWS)
    const memEvictTick = new THREE.Mesh(gBox, P.bad)
    memEvictTick.scale.set(0.45, BAR_H * 1.7, 0.6)
    memEvictTick.position.set(BAR_X0, MEM_ROWS[3], 0.4)
    panel.add(memEvictTick)

    const podCap = new THREE.Mesh(gBar, P.edge)
    podCap.scale.set(BAR_L, BAR_H, 0.5)
    podCap.position.set(BAR_X0, POD_ROWS[0], 0.3)
    panel.add(podCap)
    const podsUsed = new THREE.Mesh(gBar, P.actual)
    podsUsed.position.set(BAR_X0, POD_ROWS[1], 0.3)
    panel.add(podsUsed)

    /* ---- kubelet's office ---- */
    const kx = NODE_PARTS.kubelet[0]
    const kz = NODE_PARTS.kubelet[2]
    const office = box(root, P.concrete, 20, 14, 20, kx, DECK + 7, kz)
    office.castShadow = true
    const kFace = northFace(root, kx, DECK + 7, kz - 10.1)
    plate(kFace, kubeletTex, 20, 14)
    const phaseLamps: THREE.Mesh[] = []
    for (let p = 0; p < KUBELET_PHASES.length; p++) {
      phaseLamps.push(lamp(kFace, -7.2, 7 - 14 * (0.29 + p * 0.066)))
    }
    const plegLamp = lamp(kFace, 8.0, 7 - 14 * 0.885)
    const evictLamp = lamp(kFace, 8.0, 7 - 14 * 0.955)

    /* The sync loop. It turns once per model second — kubelet's real relist
     * cadence — and stalls outright when PLEG stops reporting. */
    const syncRing = new THREE.Object3D()
    syncRing.position.set(kx, DECK + 15.8, kz)
    root.add(syncRing)
    const ring = new THREE.Mesh(gTorus, P.kubelet)
    ring.scale.set(5, 5, 5)
    ring.rotation.x = -Math.PI / 2
    syncRing.add(ring)
    const bead = new THREE.Mesh(gSphere, P.kubelet)
    bead.scale.setScalar(0.8)
    bead.position.set(5, 0, 0)
    syncRing.add(bead)

    box(root, P.concrete, 1.2, 6, 1.2, kx - 6, DECK + 17, kz)
    const leaseBeacon = new THREE.Mesh(gSphere, P.ok)
    leaseBeacon.scale.setScalar(1.7)
    leaseBeacon.position.set(kx - 6, DECK + 20.5, kz)
    root.add(leaseBeacon)
    const leaseBar = new THREE.Mesh(gBarY, P.kubelet)
    leaseBar.position.set(kx - 9, DECK + 14, kz)
    root.add(leaseBar)
    /* The mark the node controller acts on: 40s of silence is NotReady. */
    box(root, P.warn, 2.4, 0.3, 2.4, kx - 9, DECK + 14 + 9, kz)

    const evictVane = new THREE.Object3D()
    evictVane.position.set(kx + 6, DECK + 16.5, kz)
    root.add(evictVane)
    const evictBody = box(evictVane, P.lampOff, 4, 1.2, 1.2, 0, 0, 0)

    /* ---- the container runtime workshop ---- */
    const rx = NODE_PARTS.runtime[0]
    const rz = NODE_PARTS.runtime[2]
    const shed = box(root, P.concrete, 20, 12, 26, rx, DECK + 6, rz)
    shed.castShadow = true
    const rFace = northFace(root, rx, DECK + 6, rz - 13.1)
    plate(rFace, runtimeTex, 20, 12)
    const stationLamps: THREE.Mesh[] = []
    for (let p = 0; p < 3; p++) {
      stationLamps.push(lamp(rFace, -7.2, 6 - 12 * (0.42 + p * 0.14)))
    }
    const pullCan = new THREE.Mesh(gCylY, P.image)
    pullCan.position.set(rx - 6, DECK + 12, rz - 6)
    root.add(pullCan)
    box(root, P.edge, 5, 0.4, 5, rx - 6, DECK + 19.4, rz - 6)
    const sandboxFrame = new THREE.Mesh(gBox, P.sandbox)
    sandboxFrame.scale.set(7, 5, 7)
    sandboxFrame.position.set(rx, DECK + 15, rz + 4)
    root.add(sandboxFrame)
    const runcRam = box(root, P.lampOff, 3.4, 4, 3.4, rx, DECK + 23, rz + 4)

    /* ---- the image cache: layers already on this node's disk ---- */
    const cacheRack = box(root, P.edge, 20, 12, 6, rx, DECK + 6, -48)
    const cFace = northFace(root, rx, DECK + 6, -51.1)
    plate(cFace, cacheTex, 20, 12)
    const shelves: THREE.Mesh[] = []
    const shelfLabels: DynLabel[] = []
    const shelfLabelMeshes: THREE.Mesh[] = []
    const shelfImages: string[] = []
    for (let sIdx = 0; sIdx < MAX_SHELVES; sIdx++) {
      const y = DECK + 1.6 + sIdx * 2.3
      shelves.push(box(root, P.imageGhost, 17, 1.5, 4.4, rx, y, -48))
      const l = newLabel(512, 44, 26, 'left')
      shelfLabels.push(l)
      shelfLabelMeshes.push(dyn(cFace, l, 15, 1.5, 1.2, y - (DECK + 6), 0.12))
      shelfImages.push('')
    }

    /* ---- kube-proxy's rule cabinet ---- */
    const px2 = NODE_PARTS.proxy[0]
    const pz = NODE_PARTS.proxy[2]
    const cabinet = box(root, P.concrete, 18, 20, 20, px2, DECK + 10, pz)
    cabinet.castShadow = true
    const pFace = northFace(root, px2, DECK + 10, pz - 10.1)
    plate(pFace, proxyTex, 18, 20)
    const drawers: DrawerParts[] = []
    for (let d = 0; d < MAX_DRAWERS; d++) {
      const dg = new THREE.Group()
      dg.position.set(0, -6.5 + d * 3.3, 0.5)
      pFace.add(dg)
      const front = box(dg, P.net, 15.5, 2.9, 0.9, 0, 0, 0)
      const label = newLabel(640, 48, 26, 'left')
      dyn(dg, label, 13, 1.3, 0.6, 0.6, 0.6)
      const endpoints = new THREE.Mesh(gBar, P.net)
      endpoints.position.set(-6.2, -0.8, 0.6)
      endpoints.scale.set(0.001, 0.7, 0.4)
      dg.add(endpoints)
      const refused = plate(dg, refusedTex, 9.5, 1.2, 0.65)
      refused.position.set(1.4, -0.8, 0.65)
      drawers.push({ group: dg, front, endpoints, refused, label, svc: '', ip: '', eps: -1 })
    }

    /* ---- CSI node plugin riser ---- */
    const sx = NODE_PARTS.csi[0]
    const sz = NODE_PARTS.csi[2]
    box(root, P.concrete, 14, 3, 14, sx, DECK + 1.5, sz)
    const riser = box(root, P.edge, 3.2, 24, 3.2, sx, DECK + 15, sz)
    const csiWheel = new THREE.Object3D()
    csiWheel.position.set(sx, DECK + 27, sz)
    root.add(csiWheel)
    const wheel = new THREE.Mesh(gTorus, P.storage)
    wheel.scale.set(3.2, 3.2, 3.2)
    wheel.rotation.x = -Math.PI / 2
    csiWheel.add(wheel)
    const csiSleeves: THREE.Mesh[] = []
    for (let v = 0; v < 4; v++) {
      const sleeve = new THREE.Mesh(gTorus, P.lampOff)
      sleeve.scale.set(2.6, 2.6, 2.6)
      sleeve.rotation.x = -Math.PI / 2
      sleeve.position.set(sx, DECK + 5 + v * 4.6, sz)
      root.add(sleeve)
      csiSleeves.push(sleeve)
    }
    const csiFace = northFace(root, sx, DECK + 10, sz - 7.4)
    plate(csiFace, csiTex, 13, 11)
    const csiMountLamp = lamp(csiFace, -4.7, 5.5 - 11 * 0.55)
    const csiUnmountLamp = lamp(csiFace, -4.7, 5.5 - 11 * 0.71)

    /* ---- CNI bridge, where the pod veths land ---- */
    const cx = NODE_PARTS.cni[0]
    const cz = NODE_PARTS.cni[2]
    const bridge = box(root, P.edge, 116, 4, 10, cx, DECK + 2, cz)
    const cniFace = northFace(root, cx, DECK + 9, cz - 5.1)
    plate(cniFace, cniTex, 48, 9)
    const cidr = newLabel(640, 56, 30, 'center')
    dyn(cniFace, cidr, 22, 2.4, 0, -5.9, 0.12)

    /* ---- cAdvisor's meter ---- */
    const mx = NODE_PARTS.metrics[0]
    const mz = NODE_PARTS.metrics[2]
    const meter = box(root, P.concrete, 14, 10, 12, mx, DECK + 5, mz)
    const mFace = northFace(root, mx, DECK + 5, mz - 6.1)
    plate(mFace, metricsTex, 13, 9.5)
    const cpuNeedle = new THREE.Object3D()
    cpuNeedle.position.set(-2.86, 0.6, 0.5)
    mFace.add(cpuNeedle)
    const cpuHand = new THREE.Mesh(gBar, P.kubeletUsed)
    cpuHand.scale.set(2.4, 0.3, 0.25)
    cpuNeedle.add(cpuHand)
    const memNeedle = new THREE.Object3D()
    memNeedle.position.set(2.86, 0.6, 0.5)
    mFace.add(memNeedle)
    const memHand = new THREE.Mesh(gBar, P.kubeletUsed)
    memHand.scale.set(2.4, 0.3, 0.25)
    memNeedle.add(memHand)
    const scrapeLamp = lamp(mFace, 0, 3.3, 0.5)

    /* ---- the status mast: conditions, taints, cordon ---- */
    const tx = -66
    const tz = 66
    const pole = box(root, P.edge, 2.4, 46, 2.4, tx, DECK + 23, tz)
    const beacon = new THREE.Mesh(gSphere, P.ok)
    beacon.scale.setScalar(2.8)
    beacon.position.set(tx, DECK + 47, tz)
    root.add(beacon)
    /* Ready=Unknown is not Ready=False: nobody answered, so nobody said no. */
    const unknownRing = new THREE.Mesh(gTorus, P.warn)
    unknownRing.scale.set(4.6, 4.6, 4.6)
    unknownRing.rotation.x = -Math.PI / 2
    unknownRing.position.copy(beacon.position)
    unknownRing.visible = false
    root.add(unknownRing)

    const notReadyColumn = new THREE.Mesh(gCyl, P.columnDown)
    notReadyColumn.scale.set(6, 50, 6)
    notReadyColumn.position.set(tx, DECK + 25, tz)
    notReadyColumn.visible = false
    root.add(notReadyColumn)
    const cordonColumn = new THREE.Mesh(gCyl, P.columnCordon)
    cordonColumn.scale.set(9.5, 18, 9.5)
    cordonColumn.position.set(tx, DECK + 9, tz)
    cordonColumn.visible = false
    root.add(cordonColumn)

    const nameFace = northFace(root, tx + 9, DECK + 40, tz - 3.1)
    dyn(nameFace, name, 26, 4, 0, 0, 0)
    const mastFace = northFace(root, tx + 9, DECK + 26, tz - 3.1)
    plate(mastFace, mastTex, 14, 22)
    const condLamps: THREE.Mesh[] = []
    for (let c = 0; c < PRESSURE_CONDITIONS.length; c++) {
      condLamps.push(lamp(mastFace, -4.9, 11 - 22 * (0.17 + c * 0.085)))
    }
    const taints: NodeParts['taints'] = []
    for (let t = 0; t < MAX_TAINTS; t++) {
      const tp = box(mastFace, P.taintNoSchedule, 12, 2.2, 0.6, 0, -3.4 - t * 2.6, 0.4)
      tp.visible = false
      const l = newLabel(640, 48, 26, 'center')
      const lm = dyn(mastFace, l, 11.4, 1.7, 0, -3.4 - t * 2.6, 0.8)
      lm.visible = false
      taints.push({ plate: tp, label: l, labelMesh: lm, key: '', value: '', effect: '' })
    }
    const cordonPlate = northFace(root, tx + 21, DECK + 10, tz - 3.1)
    plate(cordonPlate, cordonTex, 22, 5.5)
    cordonPlate.visible = false

    return {
      index: i,
      group: root,
      phase: ctx.rng.next() * Math.PI * 2,
      entry: null,
      titled: false,
      rim,
      gateArm,
      name,
      cpu,
      mem,
      memEvictTick,
      podsUsed,
      syncRing,
      leaseBeacon,
      leaseBar,
      phaseLamps,
      plegLamp,
      evictLamp,
      evictVane,
      pullCan,
      stationLamps,
      sandboxFrame,
      runcRam,
      shelves,
      shelfLabels,
      shelfLabelMeshes,
      shelfImages,
      drawers,
      csiWheel,
      csiSleeves,
      csiMountLamp,
      csiUnmountLamp,
      cidr,
      cidrText: '',
      cpuNeedle,
      memNeedle,
      scrapeLamp,
      beacon,
      unknownRing,
      condLamps,
      notReadyColumn,
      cordonColumn,
      cordonPlate,
      taints,
      binds: {
        deck,
        console: panelBody,
        kubelet: office,
        lease: leaseBeacon,
        runtime: shed,
        cache: cacheRack,
        proxy: cabinet,
        proxyRules: pFace,
        cni: bridge,
        csi: riser,
        metrics: meter,
        mast: pole,
        taintRack: mastFace,
        evict: evictBody,
      },
    }
  }

  const parts: NodeParts[] = []
  for (let i = 0; i < N_NODES; i++) parts.push(buildNode(i))

  /* --------------------------------------------------------------------
   * Pod veth ports on every CNI bridge. 48 identical plugs across the grid,
   * so they are instanced; an instance that should not show is scaled to
   * zero rather than removed, which keeps the write allocation-free.
   * ------------------------------------------------------------------*/
  const PORTS = N_NODES * POD_SLOTS_PER_NODE
  const portBase: THREE.Vector3[] = []
  for (let i = 0; i < N_NODES; i++) {
    nodePartPos(i, 'cni', _pos)
    for (let k = 0; k < POD_SLOTS_PER_NODE; k++) {
      const x = _pos.x + (k - (POD_SLOTS_PER_NODE - 1) / 2) * 9
      portBase.push(new THREE.Vector3(x, DECK + 4.2, _pos.z))
    }
  }
  const portSockets = new THREE.InstancedMesh(gSocket, P.edge, PORTS)
  portSockets.frustumCulled = false
  for (let p = 0; p < PORTS; p++) {
    _mat4.compose(portBase[p], _quat.identity(), _unit)
    portSockets.setMatrixAt(p, _mat4)
  }
  portSockets.instanceMatrix.needsUpdate = true
  group.add(portSockets)

  const portPlugs = new THREE.InstancedMesh(gPlug, P.net, PORTS)
  portPlugs.frustumCulled = false
  portPlugs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  group.add(portPlugs)
  /* A sandbox that exists but has no IP yet: CNI ADD is still in flight. */
  const portPending = new THREE.InstancedMesh(gPlug, P.warn, PORTS)
  portPending.frustumCulled = false
  portPending.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  group.add(portPending)
  const portState = new Int8Array(PORTS)

  /* ==================================================================
   * Explainers. Ids are prefixed `node-` because the mechanisms drawn here
   * are node-local; the network district owns the Service objects these
   * rule tables realize.
   * ================================================================*/

  const pct = (a: number, b: number): string => formatPercent(b > 0 ? a / b : 0, 0)

  /** Register once, then bind the same entry on every node that draws it. */
  function shared(id: BindId, entry: Omit<Explainer, 'object'>): void {
    const e = ctx.registry.register({ ...entry, object: parts[0].binds[id] })
    for (let i = 1; i < parts.length; i++) ctx.registry.bind(parts[i].binds[id], e)
  }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    p.entry = ctx.registry.register({
      id: `node-${i}`,
      title: `Worker node ${i + 1}`,
      district: 'nodes',
      kubeName: 'Node',
      object: p.binds.deck,
      summary:
        'A machine that runs pods. It reports its own hardware, kubelet pulls work down to it, and nothing in the control plane ever pushes anything here.',
      detail: [
        'A Node object is a record *of* a machine, created and kept current by the kubelet running on it. The scheduler writes a pod\'s `spec.nodeName`; the kubelet on that node sees it through its watch on the API server and starts the work. There is no channel from the control plane to the node.',
        'Every structure on this block is one process or one kernel facility: kubelet and its Lease, the CRI runtime and its image cache, kube-proxy\'s rule table, the CNI bridge that owns pod networking, the CSI node plugin, and cAdvisor\'s meter. The pods themselves stand on the plots in the middle.',
        'Deleting a Node object does not stop the machine. It makes the control plane forget it, and a kubelet that is still alive will simply re-register. The pods that were bound to it are orphans: PodGC waits out a short quarantine, confirms the Node really is gone, and force deletes them. That is not an eviction — there is no NotReady condition and no `NoExecute` taint anywhere in the story, so nothing tolerates it and nothing waits 300 seconds.',
      ],
      caveats: [
        'This model draws 12 pod plots; kubelet\'s real default cap is 110 (`--max-pods`).',
        'Hardware is scaled to 4 cores and 8Gi so the whole grid fits one screen.',
      ],
      keywords: ['node', 'worker', 'machine', 'kubelet', 'block'],
      metrics: (s) => {
        const n = s.nodes[i]
        if (!n) return []
        /* No Node object, so there are no conditions to report and no capacity
         * to count. Printing "Ready: True" for a machine that is not in the
         * cluster is the same falsehood the nodes readout used to tell. */
        if (!n.present) {
          return [
            { label: 'name', value: n.name },
            { label: 'in cluster', value: 'no', hint: 'Node object deleted' },
            {
              label: 'pods still bound',
              value: String(n.podUids.length),
              hint: n.podUids.length > 0 ? 'awaiting PodGC' : '',
            },
          ]
        }
        const ready = conditionStatus(n, 'Ready', 'Unknown')
        return [
          { label: 'name', value: n.name },
          { label: 'Ready', value: ready, hint: n.unschedulable ? 'SchedulingDisabled' : '' },
          {
            label: 'cpu requested',
            value: `${formatCpu(n.requestedCpuMilli)} / ${formatCpu(n.allocatableCpuMilli)}`,
            hint: pct(n.requestedCpuMilli, n.allocatableCpuMilli),
          },
          {
            label: 'cpu used',
            value: `${formatCpu(n.usedCpuMilli)} / ${formatCpu(n.allocatableCpuMilli)}`,
            hint: pct(n.usedCpuMilli, n.allocatableCpuMilli),
          },
          {
            label: 'memory requested',
            value: `${formatMem(n.requestedMemMib)} / ${formatMem(n.allocatableMemMib)}`,
            hint: pct(n.requestedMemMib, n.allocatableMemMib),
          },
          {
            label: 'memory used',
            value: `${formatMem(n.usedMemMib)} / ${formatMem(n.allocatableMemMib)}`,
            hint: pct(n.usedMemMib, n.allocatableMemMib),
          },
          { label: 'pods', value: `${n.podUids.length} / ${n.capacityPods}` },
          { label: 'podCIDR', value: n.podCidr },
          { label: 'taints', value: n.taints.length === 0 ? '<none>' : String(n.taints.length) },
        ]
      },
    })
  }

  shared('console', {
    id: 'node-allocatable',
    title: 'Capacity vs allocatable vs requested vs used',
    district: 'nodes',
    kubeName: 'Node.status.allocatable',
    summary:
      'Four different numbers measured by three different subsystems. Conflating requested with used is the single most common way to misread a cluster.',
    detail: [
      '`capacity` is the hardware kubelet detected. `allocatable` is capacity minus `--kube-reserved`, `--system-reserved` and the hard eviction threshold — the slice the node keeps for kubelet, the container runtime and the OS. The scheduler never sees capacity; it only ever sees allocatable.',
      'REQUESTED is the sum of `resources.requests` over every pod bound here. That sum, and nothing else, is what the scheduler\'s NodeResourcesFit filter compares against allocatable. A node whose pods request all of allocatable is full — `Insufficient cpu` — even if every one of them is idle.',
      'USED is what the kernel is actually accounting through the cgroup, read by cAdvisor. It is the number that gets a container throttled when it passes its CPU *limit*, OOM-killed when it passes its memory *limit*, and the node evicting when the node-level thresholds are crossed.',
      'So the honest reading of this wall: the two translucent bars are claims in a ledger, the solid bar is matter. Usage above requests is normal and invisible to the scheduler; requests far above usage is how a cluster reports 100% full at 8% utilisation.',
    ],
    caveats: [
      'The red tick on the memory row is drawn at capacity − 100Mi, kubelet\'s default hard `memory.available<100Mi`. Real kubelet also subtracts that threshold when computing allocatable; this model folds it into kube-reserved.',
      'Pods allocatable is drawn equal to pods capacity, which is true unless a `system-reserved` pid/pod reservation is configured.',
    ],
    keywords: ['allocatable', 'capacity', 'requests', 'limits', 'kube-reserved', 'utilisation', 'gauge'],
    metrics: (s) => {
      const t = s.totals
      return [
        {
          label: 'cluster cpu requested',
          value: `${formatCpu(t.cpuRequestedMilli)} / ${formatCpu(t.cpuAllocatableMilli)}`,
          hint: pct(t.cpuRequestedMilli, t.cpuAllocatableMilli),
        },
        {
          label: 'cluster memory requested',
          value: `${formatMem(t.memRequestedMib)} / ${formatMem(t.memAllocatableMib)}`,
          hint: pct(t.memRequestedMib, t.memAllocatableMib),
        },
        { label: 'nodes Ready', value: `${t.nodesReady} / ${s.nodes.length}` },
      ]
    },
  })

  shared('kubelet', {
    id: 'node-kubelet',
    title: 'kubelet',
    district: 'nodes',
    kubeName: 'kubelet',
    summary:
      'The one agent on every node. It watches the API server for pods bound to this node and drives the runtime until reality matches the spec — continuously, not once.',
    detail: [
      'kubelet is level-triggered like every other loop in Kubernetes. Each sync it takes the whole desired pod set for this node, asks the runtime what actually exists, and issues whatever CRI calls close the gap. It is not driven by messages, so a dropped watch event costs it nothing: the next relist has the truth.',
      'The lamps are `KubeletState.phase` for the pod it is working on right now — pull the image, create the sandbox, CNI ADD, CSI mount, start the containers, then probe them. Those steps are strictly ordered and each has its own failure and its own reason string.',
      'kubelet also owns everything the pod\'s lifecycle needs afterwards: probes, restarts and their exponential backoff, cgroup enforcement of limits, container log rotation, and node-pressure eviction.',
      'PLEG — the Pod Lifecycle Event Generator — relists containers from the runtime about once a second. If that relist takes longer than three minutes, kubelet reports `PLEG is not healthy`, stops renewing its Lease, and the node goes NotReady even though the machine is fine. The ring on this roof stops turning.',
    ],
    caveats: [
      'A real kubelet syncs many pods concurrently (one goroutine per pod); the model shows one pod at a time so the phase is readable.',
    ],
    keywords: ['kubelet', 'sync loop', 'PLEG', 'node agent', 'syncPod'],
    metrics: (s) => {
      const rows: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i]
        rows.push({
          label: n.name,
          value: n.kubelet.phase,
          hint: n.kubelet.plegHealthy ? '' : 'PLEG is not healthy',
        })
      }
      return rows
    },
  })

  shared('lease', {
    id: 'node-kubelet-lease',
    title: 'Node heartbeat (Lease)',
    district: 'nodes',
    kubeName: 'coordination.k8s.io/v1 Lease',
    summary:
      'kubelet renews a tiny Lease object every 10 seconds. The node controller watches that lease, not the machine — so NotReady means silence, not a crash.',
    detail: [
      `kubelet writes a Lease named after the node in the \`kube-node-lease\` namespace every ${TIMING.kubeletLeaseSeconds}s. It replaced the old full NodeStatus heartbeat because a NodeStatus write is kilobytes of conditions and images: at a few thousand nodes that alone would saturate etcd.`,
      `If no renewal lands for \`--node-monitor-grace-period\` (${TIMING.nodeMonitorGraceSeconds}s), the node controller — not kubelet — sets Ready=Unknown. The bar beside the beacon is the lease age against exactly that deadline.`,
      `Ready=Unknown then adds \`node.kubernetes.io/unreachable:NoExecute\`. Every pod carries a default toleration of ${TIMING.notReadyTolerationSeconds}s for it, which is why a dead node's pods are not recreated for five minutes; a StatefulSet's pods are not recreated at all until you delete the Node or force-delete them, because two copies of the same ordinal must never run.`,
    ],
    caveats: [
      'Lease age is read from `KubeletState.sinceLeaseSeconds`; the Lease object itself is not drawn in the etcd vault.',
    ],
    keywords: ['lease', 'heartbeat', 'NotReady', 'node monitor', 'unreachable', 'grace period'],
    metrics: (s) => {
      const rows: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i]
        rows.push({
          label: n.name,
          value: `${n.kubelet.sinceLeaseSeconds.toFixed(1)}s ago`,
          hint: `grace ${TIMING.nodeMonitorGraceSeconds}s`,
        })
      }
      return rows
    },
  })

  shared('runtime', {
    id: 'node-cri',
    title: 'Container runtime (CRI)',
    district: 'nodes',
    kubeName: 'containerd',
    summary:
      'containerd or CRI-O, reached over a gRPC socket. kubelet never runs a container itself — it is a client that asks, and believes the answer.',
    detail: [
      'kubelet calls `PullImage`, `RunPodSandbox`, `CreateContainer`, `StartContainer` and `ListPodSandbox` over a unix socket. The runtime does the work through runc and reports what actually exists; that report, not kubelet\'s memory, is the actual state kubelet reconciles against.',
      'The sandbox comes first. `RunPodSandbox` creates the pause container, which holds the pod\'s network and IPC namespaces open. The app containers then join those namespaces. This is why a pod is a *lot with utilities* and not a container, and why containers in a pod reach each other on `localhost`.',
      'Only once the sandbox exists is CNI ADD called for its netns, then volumes are mounted, then init containers run to completion in order, then app containers start. Every one of those steps blocks the next.',
      'The failures users actually read come from this workshop: `ErrImagePull` and `ImagePullBackOff` from the pull, `CreateContainerConfigError` when a referenced ConfigMap or Secret key is missing, `CrashLoopBackOff` when the process keeps exiting after a successful start.',
    ],
    caveats: [
      'containerd is used as the example; the CRI contract is identical for CRI-O, and Docker has not been in this path since dockershim was removed in 1.24.',
      'Init containers, probes and restart backoff are drawn on the pod plots rather than here.',
    ],
    keywords: ['CRI', 'containerd', 'runc', 'sandbox', 'pause container', 'RunPodSandbox'],
  })

  shared('cache', {
    id: 'node-image-cache',
    title: 'Image cache',
    district: 'nodes',
    kubeName: 'imageFs',
    summary:
      'Layers already unpacked on this node\'s disk. A cache hit skips the pull entirely — the reason the same pod starts in two seconds here and forty seconds there.',
    detail: [
      'Images are content-addressed layer blobs. The runtime\'s snapshotter keeps them unpacked on the image filesystem; a pull only fetches layers whose digests are missing, which is why a new tag of a familiar image is nearly free.',
      '`imagePullPolicy` decides whether the cache may be trusted. `IfNotPresent` uses it. `Always` still contacts the registry to resolve the tag to a digest, then pulls nothing if the digest already exists — it costs a round trip, not a download, and it is what makes a mutable tag safe. `Never` fails with `ErrImageNeverPull` if the image is absent.',
      'kubelet garbage-collects images when the image filesystem crosses `--image-gc-high-threshold` (85% by default), deleting least-recently-used images down to the low threshold (80%). The same filesystem filling up is what raises DiskPressure and starts evicting pods, so image sprawl and eviction are the same problem.',
    ],
    caveats: [
      'Shelves hold whole images; the real cache is per-layer and shared between images that share a base.',
    ],
    keywords: ['image', 'pull', 'layers', 'imagePullPolicy', 'ImagePullBackOff', 'snapshotter', 'registry'],
  })

  shared('proxy', {
    id: 'node-kube-proxy',
    title: 'kube-proxy',
    district: 'nodes',
    kubeName: 'kube-proxy',
    summary:
      'A per-node daemon that turns Services and EndpointSlices into kernel packet-rewriting rules. Despite the name, no packet ever passes through it.',
    detail: [
      'kube-proxy watches Services and EndpointSlices and programs this node\'s iptables (or IPVS, or nftables) so that a packet addressed to a ClusterIP is DNAT\'d to one of the ready backend pod IPs, picked at random per connection and remembered by conntrack for the life of that connection.',
      'It runs as a DaemonSet — one pod per node — and it only ever writes rules. Once written, traffic flows whether kube-proxy is alive or not; a dead kube-proxy does not break existing routing, it freezes it, which is why stale endpoints are its classic failure and not an outage.',
      'There is no load-balancer object anywhere in the cluster. "The Service" is this cabinet, replicated onto every node. Open two nodes\' cabinets and compare: same drawers, same ClusterIPs.',
    ],
    caveats: [
      'Drawn with iptables-mode semantics. IPVS and nftables modes program different kernel objects to mean the same thing.',
      'Real syncs are batched: kube-proxy rewrites the affected chains on a timer, not once per endpoint change.',
    ],
    keywords: ['kube-proxy', 'iptables', 'IPVS', 'DNAT', 'conntrack', 'daemonset'],
    metrics: (s) => {
      const rows: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.services.length; i++) {
        const svc = s.services[i]
        let ready = 0
        for (let e = 0; e < svc.endpoints.length; e++) if (svc.endpoints[e].ready) ready++
        rows.push({
          label: svc.name,
          value: `${svc.clusterIp}:${svc.port}`,
          hint: ready === 0 ? 'no endpoints — connection refused' : `${ready} endpoints`,
        })
      }
      return rows
    },
  })

  shared('proxyRules', {
    id: 'node-kube-proxy-rules',
    title: 'Service rule table',
    district: 'nodes',
    kubeName: 'EndpointSlice',
    summary:
      'One drawer per Service: its ClusterIP and the endpoint IPs currently programmed. An empty drawer is a connection refused, not a timeout.',
    detail: [
      'A ClusterIP is a virtual address. Nothing listens on it, no interface owns it, and it exists only as the match half of these rules. That is why most ClusterIPs do not answer ping and why tcpdump on the service IP shows nothing — the address is rewritten before it ever reaches a wire.',
      'The endpoints come from EndpointSlice, which the endpointslice controller fills from pods matching the Service selector **that are Ready**. A pod failing its readiness probe is removed here within a sync. That is the entire mechanism behind "readiness gates traffic": readiness is not a state the pod enforces, it is a row in this drawer.',
      'When the last endpoint leaves, the rule remains with no backend and the kernel rejects immediately: `connection refused`. A NetworkPolicy drop, by contrast, times out. Those two symptoms tell you which of the two you are looking at before you read a single log line.',
      'A terminating pod is marked serving=false and drops out of the drawer at once, before SIGTERM has finished — which is why a graceful shutdown must outlive the endpoint propagation, not race it.',
    ],
    caveats: [
      'Endpoints are drawn as a count gauge capped at 8 per drawer.',
      'Real rules are per (service, port, protocol); this model draws one drawer per Service.',
    ],
    keywords: ['service', 'clusterip', 'endpointslice', 'endpoints', 'readiness', 'connection refused'],
  })

  shared('cni', {
    id: 'node-cni',
    title: 'CNI bridge',
    district: 'nodes',
    kubeName: 'CNI',
    summary:
      'Where a pod\'s veth lands. The CNI plugin gives the sandbox an interface, an IP from this node\'s podCIDR, and routes.',
    detail: [
      'After `RunPodSandbox`, kubelet calls the CNI plugin with the sandbox\'s network namespace. The plugin creates a veth pair — one end becomes eth0 inside the pod, the other lands on this bridge — asks its IPAM for an address out of the node\'s podCIDR, and writes the routes.',
      'The podCIDR is handed to the node by the controller manager when `--allocate-node-cidrs` is set, so a pod IP tells you which node the pod lives on. Kubernetes requires a flat network: every pod can reach every other pod at its real address, with no NAT between them. Everything a CNI plugin does is in service of that one requirement.',
      'kubelet reads the IP back out of the plugin\'s result and writes it into `pod.status.podIP`; only then can the endpointslice controller put the pod in a Service. Until ADD returns, the pod has a sandbox and no address — the port here is amber.',
      'When CNI fails, the pod sits in `ContainerCreating` with `failed to setup network for sandbox`, and the node may report NetworkUnavailable. Nothing retries faster than the next kubelet sync.',
    ],
    caveats: [
      'Drawn as a bridge/veth plugin. Overlay plugins (VXLAN) and routed plugins (BGP) land the same veth and differ only in how the packet leaves the node.',
      'Ports are drawn one per pod plot; a real bridge has one veth per pod sandbox with no fixed slots.',
    ],
    keywords: ['cni', 'veth', 'podCIDR', 'ipam', 'pod ip', 'network namespace'],
  })

  shared('csi', {
    id: 'node-csi',
    title: 'CSI node plugin',
    district: 'nodes',
    kubeName: 'CSINode',
    summary:
      'The half of a storage driver that runs on every node. It mounts; it does not provision and it does not attach.',
    detail: [
      'A CSI driver is split in two. The controller plugin — one deployment, off-node — does CreateVolume and ControllerPublishVolume: provision and attach. The node plugin, a DaemonSet, does NodeStageVolume (mount once per node) and NodePublishVolume (bind-mount into each pod that asks), plus their inverses.',
      'kubelet will not start a pod\'s containers until every volume is mounted. A pod stuck in `ContainerCreating` with `Unable to attach or mount volumes` is waiting on this riser — most often because a ReadWriteOnce volume is still attached to the node the pod used to run on, and detach is waiting on a kubelet that is gone.',
      'The AttachDetachController in the kube-controller-manager, not kubelet, decides when a volume attaches; it writes a VolumeAttachment and kubelet waits for it to report attached. This split is why a stuck volume is usually a control-plane problem wearing a node-shaped symptom.',
    ],
    caveats: [
      'Provision, attach, detach and delete are drawn at the storage plant; only mount and unmount are node-local.',
      'The lit sleeves count PersistentVolumes reporting this node in `attachedNode`.',
    ],
    keywords: ['csi', 'volume', 'mount', 'NodePublishVolume', 'attach', 'ReadWriteOnce'],
  })

  shared('metrics', {
    id: 'node-cadvisor',
    title: 'cAdvisor',
    district: 'nodes',
    kubeName: 'cAdvisor',
    summary:
      'Embedded in kubelet, it reads the cgroup counters and reports what containers are actually burning. This is the number that is not requests.',
    detail: [
      `kubelet serves cAdvisor's view of the cgroup tree at \`/metrics/resource\`. metrics-server scrapes every node's kubelet roughly every ${SCRAPE_PERIOD_SECONDS}s and serves the aggregate through the \`metrics.k8s.io\` API — which is what \`kubectl top\` and the HorizontalPodAutoscaler read. Nothing here is stored in etcd; it is a live pipeline with no history.`,
      'Memory is reported as the container\'s *working set*, not RSS: it excludes reclaimable file cache. Working set is the figure compared against the memory limit for an OOM kill and against the node\'s eviction signals, which is why a container can look enormous in `docker stats` and be perfectly healthy here.',
      'The needles read usage against allocatable. They say nothing about whether this node will accept another pod — that answer is on the gauge wall, in the requests ledger.',
    ],
    caveats: [
      `The scrape pulse is drawn on metrics-server's default ${SCRAPE_PERIOD_SECONDS}s resolution; the scrape request itself is not simulated.`,
      'metrics-server is not installed in a bare cluster. Without it `kubectl top` fails and an HPA reports unknown metrics.',
    ],
    keywords: ['cadvisor', 'metrics-server', 'kubectl top', 'working set', 'usage', 'hpa'],
  })

  shared('mast', {
    id: 'node-conditions',
    title: 'Node conditions',
    district: 'nodes',
    kubeName: 'Node.status.conditions',
    summary:
      '`Ready` says whether kubelet is alive and willing. The pressure conditions say what the node is running out of. Neither is the same as cordoned.',
    detail: [
      'Ready=True means kubelet posted a heartbeat and is healthy. Ready=False means kubelet itself said no — the runtime is down, the network plugin is not ready. Ready=Unknown means nobody has heard from it within the grace period, and it was the node controller that wrote that, not the node.',
      'MemoryPressure, DiskPressure and PIDPressure are set by kubelet\'s eviction manager when a signal crosses a threshold. They are not decoration: kubelet taints the node with the matching `node.kubernetes.io/*-pressure` taint, so the scheduler stops sending new pods there, and eviction begins locally.',
      'NetworkUnavailable is set when the node\'s pod routes are not configured — by the cloud route controller, or by a CNI that has not finished initialising.',
      'A NotReady node is not a cordoned node. Cordon is a field you set (`spec.unschedulable`): it closes the gate to new pods and leaves the running ones completely alone. NotReady is a status somebody reported, and after the toleration expires it evicts everything.',
    ],
    caveats: [
      'Five condition types are drawn. Cloud providers and node-problem-detector add more, and any controller may add its own.',
    ],
    keywords: ['conditions', 'ready', 'notready', 'MemoryPressure', 'DiskPressure', 'cordon', 'unschedulable'],
    metrics: (s) => {
      const rows: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i]
        rows.push({
          label: n.name,
          value: conditionStatus(n, 'Ready', 'Unknown') === 'True' ? 'Ready' : 'NotReady',
          hint: n.unschedulable ? 'SchedulingDisabled' : '',
        })
      }
      return rows
    },
  })

  shared('taintRack', {
    id: 'node-taints',
    title: 'Taints and tolerations',
    district: 'nodes',
    kubeName: 'Node.spec.taints',
    summary:
      'A taint repels pods from a node. A toleration on the pod is the only thing that lets it stay. NoSchedule filters, PreferNoSchedule scores, NoExecute evicts.',
    detail: [
      '`NoSchedule` makes the scheduler\'s TaintToleration filter reject the node — this is the `node(s) had untolerated taint` you read on a Pending pod. `PreferNoSchedule` only lowers the node\'s score, so a pod still lands there if nothing better exists. `NoExecute` also evicts pods already running that do not tolerate it.',
      'Most taints are applied by the control plane, not by you: `node.kubernetes.io/not-ready`, `unreachable`, `memory-pressure`, `disk-pressure`, `pid-pressure`, `unschedulable`, and `node.kubernetes.io/network-unavailable`. Admission adds every pod a 300s toleration for not-ready and unreachable, which is the five minutes before a dead node\'s pods move.',
      '`kubectl cordon` does not add a taint you wrote — it sets `spec.unschedulable`, which the node controller mirrors as `node.kubernetes.io/unschedulable:NoSchedule`. `kubectl drain` cordons first and then evicts pod by pod through the eviction API, so PodDisruptionBudgets can refuse.',
      'A toleration is permission, never a preference. Tolerating a taint does not attract a pod to that node; only nodeAffinity or nodeSelector does that. Dedicated hardware needs both.',
    ],
    caveats: ['Up to three taints are drawn per node; a node may carry more.'],
    keywords: ['taint', 'toleration', 'NoSchedule', 'NoExecute', 'cordon', 'drain', 'untolerated'],
    metrics: (s) => {
      const rows: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.nodes.length; i++) {
        const n = s.nodes[i]
        for (let t = 0; t < n.taints.length; t++) {
          const tt = n.taints[t]
          rows.push({
            label: n.name,
            value: tt.value ? `${tt.key}=${tt.value}` : tt.key,
            hint: tt.effect,
          })
        }
      }
      if (rows.length === 0) rows.push({ label: 'taints', value: '<none>' })
      return rows
    },
  })

  shared('evict', {
    id: 'node-eviction',
    title: 'Node-pressure eviction',
    district: 'nodes',
    kubeName: 'kubelet eviction manager',
    summary:
      'When the node itself runs out of memory, disk or PIDs, kubelet picks pods and kills them. Not the scheduler, not the API server — kubelet, locally, without asking.',
    detail: [
      'kubelet watches its own signals — `memory.available`, `nodefs.available`, `imagefs.available`, `pid.available` — against thresholds. The defaults include hard `memory.available<100Mi` and `nodefs.available<10%`. Crossing a hard threshold evicts immediately; a soft threshold waits out its own grace period first and honours the pod\'s termination grace.',
      'Victims are ranked, and the ranking is the whole reason to set requests honestly: BestEffort pods first, then Burstable pods using more than they requested, then Guaranteed pods. Within a tier, the pod furthest over its requests goes first, with priority as a tiebreaker. A pod using less than it requested is nearly untouchable.',
      'An evicted pod gets `status.phase: Failed` and reason `Evicted`, the node takes the matching pressure taint so the scheduler stops feeding it, and the pod\'s owner creates a replacement — which the scheduler then places somewhere else. The eviction is local; the recovery is a full trip through the control plane.',
      'This is not an OOM kill. An OOM kill is the kernel destroying one container that crossed its own memory limit, and the pod survives with a restart. Eviction is kubelet destroying a whole pod to save the node.',
    ],
    caveats: [
      'The eviction manager is drawn as a lamp and a vane on the kubelet office; victim selection itself is not animated.',
      'API-initiated eviction (`kubectl drain`, PodDisruptionBudgets) is a different mechanism and lives with the controllers.',
    ],
    keywords: ['eviction', 'MemoryPressure', 'DiskPressure', 'Evicted', 'OOMKilled', 'qos', 'BestEffort'],
  })

  /* ==================================================================
   * The frame loop. Nothing below this line may allocate: no `new`, no
   * array or object literal, no template string, no `.map`.
   * ================================================================*/

  const TAU = Math.PI * 2
  const RAM_UP = DECK + 23
  const RAM_DOWN = DECK + 19.5
  let labelBudget = 0

  function setLen(mesh: THREE.Mesh, frac: number): void {
    mesh.position.x = BAR_X0
    mesh.scale.set(Math.max(0.001, clamp(frac, 0, 1) * BAR_L), BAR_H, 0.5)
  }

  function setSeg(mesh: THREE.Mesh, from: number, to: number): void {
    const a = clamp(from, 0, 1) * BAR_L
    const b = clamp(to, 0, 1) * BAR_L
    mesh.position.x = BAR_X0 + a
    mesh.scale.set(Math.max(0.001, b - a), BAR_H, 0.5)
  }

  function setTick(mesh: THREE.Mesh, frac: number): void {
    mesh.position.x = BAR_X0 + clamp(frac, 0, 1) * BAR_L
  }

  function updateGauge(
    g: GaugeBlock,
    capacity: number,
    allocatable: number,
    requested: number,
    used: number,
  ): void {
    const cap = capacity > 0 ? capacity : 1
    const alloc = allocatable / cap
    setLen(g.allocatable, alloc)
    setSeg(g.reserved, alloc, 1)
    setLen(g.requested, requested / cap)
    setTick(g.ceiling, alloc)
    setLen(g.used, used / cap)
  }

  function updateNode(s: SimState, dt: number, p: NodeParts): void {
    const n = s.nodes[p.index]
    if (!n) {
      p.group.visible = false
      return
    }
    p.group.visible = true
    const k = n.kubelet
    const ready = conditionStatus(n, 'Ready', 'Unknown')
    const isReady = ready === 'True'

    p.name.set(n.name)
    if (!p.titled && p.entry) {
      p.entry.title = 'Node ' + n.name
      p.titled = true
    }

    /* Establishing shot: NotReady is a red block, cordoned is an amber one
     * with the gate down. They must never be mistaken for each other. */
    p.rim.material = !isReady ? P.rimDown : n.unschedulable ? P.rimCordon : P.rimReady
    p.gateArm.rotation.z = approachAngle(
      p.gateArm.rotation.z,
      n.unschedulable ? 0 : Math.PI * 0.47,
      dt,
    )
    p.notReadyColumn.visible = !isReady
    p.cordonColumn.visible = n.unschedulable
    p.cordonPlate.visible = n.unschedulable

    /* ---- capacity gauge wall ---- */
    updateGauge(
      p.cpu,
      n.capacityCpuMilli,
      n.allocatableCpuMilli,
      n.requestedCpuMilli,
      n.usedCpuMilli,
    )
    updateGauge(p.mem, n.capacityMemMib, n.allocatableMemMib, n.requestedMemMib, n.usedMemMib)
    const memCap = n.capacityMemMib > 0 ? n.capacityMemMib : 1
    setTick(p.memEvictTick, (memCap - EVICTION_MEM_MIB) / memCap)
    setLen(p.podsUsed, n.podUids.length / (n.capacityPods > 0 ? n.capacityPods : 1))

    /* ---- kubelet ---- */
    /* One turn per model second is kubelet's real relist cadence, and a stalled
     * relist is exactly what "PLEG is not healthy" means. */
    if (k.plegHealthy && isReady) p.syncRing.rotation.y += dt * TAU
    const phaseIdx = KUBELET_PHASES.indexOf(k.phase)
    for (let j = 0; j < p.phaseLamps.length; j++) {
      p.phaseLamps[j].material = j === phaseIdx ? P.kubelet : P.lampOff
    }
    p.plegLamp.material = k.plegHealthy ? P.ok : P.bad
    p.evictLamp.material = k.evicting ? P.backoff : P.lampOff
    if (k.evicting) p.evictVane.rotation.y += dt * 5

    const leaseFrac = k.sinceLeaseSeconds / TIMING.nodeMonitorGraceSeconds
    p.leaseBar.scale.set(1.4, Math.max(0.08, clamp(leaseFrac, 0, 1.35) * 9), 1.4)
    p.leaseBar.material = leaseFrac >= 1 ? P.bad : P.kubelet
    const beat = Math.exp(-k.sinceLeaseSeconds * 1.6)
    p.leaseBeacon.scale.setScalar(1.7 * (1 + 1.3 * beat))
    p.leaseBeacon.material = leaseFrac >= 1 ? P.bad : P.ok

    /* ---- CRI workshop ---- */
    const pod = k.currentPodUid ? s.pods.get(k.currentPodUid) : undefined
    let pull = 0
    if (pod) {
      for (let c = 0; c < pod.containers.length; c++) {
        const cs = pod.containers[c]
        if (cs.pullProgress > pull) pull = cs.pullProgress
      }
    }
    p.stationLamps[0].material = k.phase === 'pulling' ? P.kubelet : P.lampOff
    p.stationLamps[1].material = k.phase === 'sandbox' ? P.kubelet : P.lampOff
    p.stationLamps[2].material = k.phase === 'starting' ? P.kubelet : P.lampOff
    p.pullCan.scale.set(2.2, 0.4 + pull * 7, 2.2)
    p.pullCan.material = pull > 0 ? P.image : P.imageGhost
    const sandboxUp = k.phase === 'sandbox' || k.phase === 'cni' || k.phase === 'csi'
    p.sandboxFrame.visible = sandboxUp || k.phase === 'starting'
    const sbScale = sandboxUp ? 0.25 + 0.75 * clamp(k.progress, 0, 1) : 1
    p.sandboxFrame.scale.set(7 * sbScale, 5 * sbScale, 7 * sbScale)
    p.runcRam.position.y = approach(
      p.runcRam.position.y,
      k.phase === 'starting' ? RAM_DOWN : RAM_UP,
      9,
      dt,
    )
    p.runcRam.material = k.phase === 'starting' ? P.kubelet : P.lampOff

    /* ---- image cache ---- */
    for (let j = 0; j < p.shelves.length; j++) {
      const img = j < n.imageCache.length ? n.imageCache[j] : ''
      if (p.shelfImages[j] !== img) {
        p.shelfImages[j] = img
        p.shelfLabels[j].set(img)
      }
      p.shelves[j].material = img ? P.image : P.imageGhost
      p.shelfLabelMeshes[j].visible = img.length > 0
    }

    /* ---- kube-proxy drawers ---- */
    for (let d = 0; d < p.drawers.length; d++) {
      const dr = p.drawers[d]
      if (d >= n.proxyRules.length) {
        dr.group.visible = false
        continue
      }
      dr.group.visible = true
      const rule = n.proxyRules[d]
      const eps = rule.endpoints.length
      if (dr.svc !== rule.service || dr.ip !== rule.clusterIp || dr.eps !== eps) {
        dr.svc = rule.service
        dr.ip = rule.clusterIp
        dr.eps = eps
        dr.label.set(rule.service + '  ' + rule.clusterIp)
      }
      dr.front.material = rule.syncing ? P.warn : eps === 0 ? P.bad : P.net
      dr.refused.visible = eps === 0 && !rule.syncing
      dr.endpoints.visible = eps > 0
      const epLen = (Math.min(eps, MAX_ENDPOINT_PIPS) / MAX_ENDPOINT_PIPS) * 12.4
      dr.endpoints.scale.set(Math.max(0.001, epLen), 0.7, 0.4)
      /* A drawer being reprogrammed is pulled out: rules are being rewritten. */
      dr.group.position.z = approach(dr.group.position.z, rule.syncing ? 2.6 : 0.5, 9, dt)
    }

    /* ---- CSI node plugin ---- */
    let mounting = false
    let unmounting = false
    let csiBusy = false
    for (let c = 0; c < s.csiOps.length; c++) {
      const op = s.csiOps[c]
      if (op.nodeName !== n.name) continue
      csiBusy = true
      if (op.op === 'mount') mounting = true
      else if (op.op === 'unmount') unmounting = true
    }
    let attached = 0
    for (let v = 0; v < s.pvs.length; v++) {
      if (s.pvs[v].attachedNode === n.name) attached++
    }
    if (csiBusy) p.csiWheel.rotation.y += dt * 3.4
    for (let v = 0; v < p.csiSleeves.length; v++) {
      p.csiSleeves[v].material = v < attached ? P.storage : P.lampOff
    }
    p.csiMountLamp.material = mounting ? P.storage : P.lampOff
    p.csiUnmountLamp.material = unmounting ? P.warn : P.lampOff

    /* ---- CNI: which plots have a veth, and which are still waiting ---- */
    if (p.cidrText !== n.podCidr) {
      p.cidrText = n.podCidr
      p.cidr.set(n.podCidr)
    }
    const base = p.index * POD_SLOTS_PER_NODE
    for (let q = 0; q < POD_SLOTS_PER_NODE; q++) portState[base + q] = 0
    for (let u = 0; u < n.podUids.length; u++) {
      const pd = s.pods.get(n.podUids[u])
      if (!pd) continue
      const slot = pd.slot === undefined ? u : pd.slot
      if (slot < 0 || slot >= POD_SLOTS_PER_NODE) continue
      portState[base + slot] = pd.ip ? 1 : 2
    }

    /* ---- cAdvisor ---- */
    const cpuFrac = clamp(n.usedCpuMilli / Math.max(1, n.allocatableCpuMilli), 0, 1)
    const memFrac = clamp(n.usedMemMib / Math.max(1, n.allocatableMemMib), 0, 1)
    p.cpuNeedle.rotation.z = (0.75 - cpuFrac * 1.5) * Math.PI
    p.memNeedle.rotation.z = (0.75 - memFrac * 1.5) * Math.PI
    const scrapePhase = (s.t + p.phase) % SCRAPE_PERIOD_SECONDS
    p.scrapeLamp.material = scrapePhase < 0.7 ? P.kubelet : P.lampOff

    /* ---- conditions and taints ---- */
    p.beacon.material = isReady ? P.ok : P.bad
    p.unknownRing.visible = ready === 'Unknown'
    if (ready === 'Unknown') {
      p.unknownRing.rotation.z += dt * 1.4
      p.beacon.scale.setScalar(2.8 + Math.sin(s.t * 3) * 0.5)
    } else {
      p.beacon.scale.setScalar(2.8)
    }
    for (let c = 0; c < p.condLamps.length; c++) {
      const st = conditionStatus(n, PRESSURE_CONDITIONS[c], 'False')
      p.condLamps[c].material = st === 'True' ? P.bad : P.lampOff
    }
    for (let t = 0; t < p.taints.length; t++) {
      const slot = p.taints[t]
      if (t >= n.taints.length) {
        slot.plate.visible = false
        slot.labelMesh.visible = false
        continue
      }
      const tt = n.taints[t]
      slot.plate.visible = true
      slot.labelMesh.visible = true
      const value = tt.value === undefined ? '' : tt.value
      if (slot.key !== tt.key || slot.value !== value || slot.effect !== tt.effect) {
        slot.key = tt.key
        slot.value = value
        slot.effect = tt.effect
        slot.label.set((value ? tt.key + '=' + value : tt.key) + ':' + tt.effect)
      }
      slot.plate.material =
        tt.effect === 'NoExecute'
          ? P.taintNoExecute
          : tt.effect === 'NoSchedule'
            ? P.taintNoSchedule
            : P.taintPrefer
    }
  }

  /** Frame-rate independent approach that works on an angle in radians. */
  function approachAngle(current: number, target: number, dt: number): number {
    return approach(current, target, 5, dt)
  }

  function update(s: SimState, dt: number): void {
    /* A theme flip disposes the shared cache; refresh the private clones in
     * place so no mesh is ever left holding a disposed material. */
    const nowMode = getMode()
    if (nowMode !== themeMode) {
      themeMode = nowMode
      refreshTheme()
    }

    /* A machine that is not in the cluster is not drawn at all. Dimming it or
     * marking it NotReady would say "this is broken"; it is simply not here. */
    for (let i = 0; i < parts.length; i++) {
      const here = s.nodes[i] === undefined ? true : s.nodes[i].present
      if (parts[i].group.visible !== here) parts[i].group.visible = here
      if (here) updateNode(s, dt, parts[i])
    }

    for (let q = 0; q < PORTS; q++) {
      const st = portState[q]
      _scale.copy(st === 1 ? _unit : _hidden)
      _mat4.compose(portBase[q], _quat, _scale)
      portPlugs.setMatrixAt(q, _mat4)
      _scale.copy(st === 2 ? _unit : _hidden)
      _mat4.compose(portBase[q], _quat, _scale)
      portPending.setMatrixAt(q, _mat4)
    }
    portPlugs.instanceMatrix.needsUpdate = true
    portPending.instanceMatrix.needsUpdate = true

    /* Repainting a canvas is not frame work. Two per frame is enough to keep
     * up with a cluster's rate of change and cannot stall a frame. */
    labelBudget = 2
    for (let i = 0; i < labels.length && labelBudget > 0; i++) {
      if (labels[i].dirty) {
        labels[i].flush()
        labelBudget--
      }
    }
  }

  function dispose(): void {
    for (let i = 0; i < geos.length; i++) geos[i].dispose()
    for (let i = 0; i < textures.length; i++) textures[i].dispose()
    for (let i = 0; i < plateMats.length; i++) plateMats[i].dispose()
    for (let i = 0; i < labels.length; i++) labels[i].dispose()
    /* Only the private clones. Theme cache materials belong to core/theme. */
    for (let i = 0; i < owned.length; i++) owned[i].m.dispose()
    portSockets.dispose()
    portPlugs.dispose()
    portPending.dispose()
  }

  return { group, update, dispose }
}
