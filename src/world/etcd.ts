import * as THREE from 'three'
import { COLOR, ghost, mat, neon, structural } from '../core/theme'
import {
  ETCD_QUORUM,
  N_ETCD_MEMBERS,
  RAFT_LOG_SLOTS,
  TIMING,
} from '../core/types'
import type { Explainer, SimState } from '../core/types'
import { ANCHOR, CITY, etcdMemberPos, raftLogSlotPos } from './layout'
import type { WorldCtx, WorldModule } from './module'
import { approach, clamp, formatMem, formatMs } from '../core/util'

/* ============================================================================
 * THE ETCD VAULT — the excavation under the API server.
 *
 * Everything in here is one claim: this is the only durable state in the
 * cluster, and exactly one process is allowed to touch it. The pit walls and
 * the ground cutaway belong to the ground district; this module builds what
 * lives inside: three member vaults on the floor, the leader's raft log running
 * along the south wall, the quorum ring overhead, and the revision board.
 *
 * Invariants for the frame loop:
 *  - update() allocates nothing. Scratch vectors are hoisted; every material
 *    variant a mesh can swap to is pre-warmed at build time, because
 *    theme.mat/neon/ghost allocate on a cache miss.
 *  - No theme material is ever mutated or disposed here; a swap assigns a
 *    different cached material instead.
 * ==========================================================================*/

/* ============================================================================
 * A tiny allocation-free text engine for the etcd vault.
 *
 * The vault has to show real strings — key paths, `NOSPACE`, a ten-digit
 * revision — and there is no font dependency in this project and no label
 * engine this district may import. So: one monospace glyph atlas baked to a
 * canvas at build time, one InstancedMesh of unit quads, one draw call.
 *
 * Every character cell's transform is baked when a run is claimed. Per frame a
 * run only rewrites two small typed arrays (glyph cell, colour), and only when
 * its value actually changed. Nothing here allocates after construction.
 * ==========================================================================*/

const GLYPH_COLS = 16
const GLYPH_ROWS = 6
const GLYPH_FIRST = 32 /* space */
const GLYPH_LAST = 126 /* ~ */
const ATLAS_CELL = 64
/** Horizontal pitch as a fraction of glyph height. Matches the atlas metrics. */
const ADVANCE = 0.58

const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _off = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _m4 = new THREE.Matrix4()

export interface TextPose {
  x: number
  y: number
  z: number
  /** Glyph cell height in world units. */
  size: number
  /** Pitch about the panel's own X, applied before the yaw. */
  rotX?: number
  /** Yaw about world Y. Use Math.PI for a panel that faces north (-Z). */
  rotY?: number
  align?: 'left' | 'center' | 'right'
}

function buildAtlas(): THREE.Texture {
  /* Headless (vitest) has no DOM; the geometry still has to build so the
   * district can be unit-tested without a canvas. */
  if (typeof document === 'undefined') return new THREE.Texture()
  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_COLS * ATLAS_CELL
  canvas.height = GLYPH_ROWS * ATLAS_CELL
  const g = canvas.getContext('2d')
  if (!g) return new THREE.Texture()
  g.clearRect(0, 0, canvas.width, canvas.height)
  g.font = `600 ${Math.round(ATLAS_CELL * 0.7)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#ffffff'
  for (let code = GLYPH_FIRST; code <= GLYPH_LAST; code++) {
    const i = code - GLYPH_FIRST
    const col = i % GLYPH_COLS
    const row = (i / GLYPH_COLS) | 0
    g.fillText(
      String.fromCharCode(code),
      col * ATLAS_CELL + ATLAS_CELL * 0.5,
      row * ATLAS_CELL + ATLAS_CELL * 0.54,
    )
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const VERT = /* glsl */ `
attribute vec2 aGlyph;
attribute vec3 aColor;
uniform vec2 uCell;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = (uv + aGlyph) * uCell;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  /* Cut out rather than blend: an opaque glyph sorts correctly against the
   * vault's geometry without a transparency pass. */
  if (t.a < 0.45) discard;
  gl_FragColor = vec4(vColor, 1.0);
}`

/** One run of characters at a fixed place. Its transform never changes. */
export class TextRun {
  /** 0 = never written, 1 = string, 2 = integer, 3 = fixed, 4 = ratio. */
  private kind = 0
  private str: string | null = null
  private num = Number.NaN
  private num2 = Number.NaN
  private col = -1

  constructor(
    private readonly bank: TextBank,
    private readonly start: number,
    readonly len: number,
  ) {}

  private put(slot: number, code: number): void {
    const idx = code < GLYPH_FIRST || code > GLYPH_LAST ? 0 : code - GLYPH_FIRST
    this.bank.glyph.setXY(this.start + slot, idx % GLYPH_COLS, GLYPH_ROWS - 1 - ((idx / GLYPH_COLS) | 0))
  }

  /** Left-aligned. A string longer than the run shows its tail, which is the
   * informative end of a `/registry/...` key. */
  setString(s: string): void {
    if (this.kind === 1 && this.str === s) return
    this.kind = 1
    this.str = s
    const from = s.length > this.len ? s.length - this.len : 0
    const n = s.length - from
    for (let i = 0; i < this.len; i++) this.put(i, i < n ? s.charCodeAt(from + i) : 32)
    this.bank.dirty = true
  }

  /** Right-aligned, space padded. Overflow shows the low-order digits. */
  setInt(v: number): void {
    if (this.kind === 2 && this.num === v) return
    this.kind = 2
    this.num = v
    this.str = null
    let x = Math.trunc(v)
    const neg = x < 0
    if (neg) x = -x
    let i = this.len - 1
    if (x === 0) this.put(i--, 48)
    while (x > 0 && i >= 0) {
      this.put(i--, 48 + (x % 10))
      x = (x / 10) | 0
    }
    if (neg && i >= 0) this.put(i--, 45)
    while (i >= 0) this.put(i--, 32)
    this.bank.dirty = true
  }

  /** Right-aligned fixed point, e.g. setFixed(3.14, 1) -> "3.1". */
  setFixed(v: number, decimals: number): void {
    if (this.kind === 3 && this.num === v && this.num2 === decimals) return
    this.kind = 3
    this.num = v
    this.num2 = decimals
    this.str = null
    let pow = 1
    for (let d = 0; d < decimals; d++) pow *= 10
    let x = Math.round(Math.abs(v) * pow)
    const neg = v < 0
    let i = this.len - 1
    for (let d = 0; d < decimals && i >= 0; d++) {
      this.put(i--, 48 + (x % 10))
      x = (x / 10) | 0
    }
    if (decimals > 0 && i >= 0) this.put(i--, 46)
    if (x === 0 && i >= 0) this.put(i--, 48)
    while (x > 0 && i >= 0) {
      this.put(i--, 48 + (x % 10))
      x = (x / 10) | 0
    }
    if (neg && i >= 0) this.put(i--, 45)
    while (i >= 0) this.put(i--, 32)
    this.bank.dirty = true
  }

  /** Right-aligned "a/b", the shape quorum and replica counts read best in. */
  setRatio(a: number, b: number): void {
    if (this.kind === 4 && this.num === a && this.num2 === b) return
    this.kind = 4
    this.num = a
    this.num2 = b
    this.str = null
    let i = this.len - 1
    let x = Math.max(0, Math.trunc(b))
    if (x === 0) this.put(i--, 48)
    while (x > 0 && i >= 0) {
      this.put(i--, 48 + (x % 10))
      x = (x / 10) | 0
    }
    if (i >= 0) this.put(i--, 47)
    x = Math.max(0, Math.trunc(a))
    if (x === 0) this.put(i--, 48)
    while (x > 0 && i >= 0) {
      this.put(i--, 48 + (x % 10))
      x = (x / 10) | 0
    }
    while (i >= 0) this.put(i--, 32)
    this.bank.dirty = true
  }

  setColor(hex: number): void {
    if (this.col === hex) return
    this.col = hex
    const r = ((hex >> 16) & 255) / 255
    const g = ((hex >> 8) & 255) / 255
    const b = (hex & 255) / 255
    for (let i = 0; i < this.len; i++) this.bank.color.setXYZ(this.start + i, r, g, b)
    this.bank.dirty = true
  }

  /** Blank the run without touching its transform. */
  clear(): void {
    this.setString('')
  }
}

export class TextBank {
  readonly mesh: THREE.InstancedMesh
  readonly glyph: THREE.InstancedBufferAttribute
  readonly color: THREE.InstancedBufferAttribute
  readonly material: THREE.ShaderMaterial
  readonly texture: THREE.Texture
  dirty = false
  private next = 0

  constructor(private readonly capacity: number) {
    this.texture = buildAtlas()
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.texture },
        uCell: { value: new THREE.Vector2(1 / GLYPH_COLS, 1 / GLYPH_ROWS) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    })
    const geo = new THREE.PlaneGeometry(1, 1)
    this.glyph = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    geo.setAttribute('aGlyph', this.glyph)
    geo.setAttribute('aColor', this.color)
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity)
    /* One draw call spread across the whole pit; culling it per-instance would
     * cost more than drawing it. */
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    _m4.makeScale(0, 0, 0)
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m4)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  claim(chars: number, pose: TextPose, colorHex: number): TextRun {
    const start = this.next
    if (start + chars > this.capacity) {
      throw new Error(`etcd text bank exhausted: need ${chars}, have ${this.capacity - start}`)
    }
    this.next += chars
    const adv = pose.size * ADVANCE
    const align = pose.align ?? 'left'
    const shift = align === 'center' ? -((chars - 1) / 2) * adv : align === 'right' ? -(chars - 1) * adv : 0
    _e.set(pose.rotX ?? 0, pose.rotY ?? 0, 0, 'YXZ')
    _q.setFromEuler(_e)
    _scale.set(pose.size, pose.size, 1)
    for (let i = 0; i < chars; i++) {
      _off.set(shift + i * adv, 0, 0).applyQuaternion(_q)
      _pos.set(pose.x + _off.x, pose.y + _off.y, pose.z + _off.z)
      _m4.compose(_pos, _q, _scale)
      this.mesh.setMatrixAt(start + i, _m4)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    const run = new TextRun(this, start, chars)
    run.setColor(colorHex)
    run.clear()
    return run
  }

  /** Static text: claimed and written once, never touched again. */
  label(text: string, pose: TextPose, colorHex: number): TextRun {
    const run = this.claim(text.length, pose, colorHex)
    run.setString(text)
    return run
  }

  /** Called once per frame after all runs have been written. */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    this.glyph.needsUpdate = true
    this.color.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}

/* ---------------------------------------------------------------------------
 * Local geometry of the vault. Every shared coordinate comes from layout.ts;
 * only detail inside the pit's own footprint is decided here.
 * -------------------------------------------------------------------------*/

const PIT = CITY.pit
const MEMBER_W = CITY.etcd.memberW
const MEMBER_D = CITY.etcd.memberW * 0.8
const MEMBER_H = CITY.etcd.memberH
/** How much taller the leader stands. It must be unmistakable from orbit. */
const LEADER_EXTRA = 15
/** Height of the matchIndex column beside each member. */
const COL_H = 22
/** Radius of the quorum ring, just outside the member arc. */
const RING_R = CITY.etcd.ringRadius + 9
const RING_Y = PIT.floorY + 34

/** Revisions represented by the full width of the history bar. */
const HISTORY_WINDOW = 4000
/** Half-width of the board mounted on the pit's south wall. */
const BOARD_HX = 100
const BOARD_Z = PIT.z + PIT.hz - 4
const BOARD_TEXT_Z = BOARD_Z - 0.9
/** Panels on the south wall face north, where the API server tower is. */
const FACE_N = Math.PI

const HB_PER_LINK = 2
/** Heartbeats per model second: etcd's --heartbeat-interval is 100 ms. */
const HB_HZ = 1000 / TIMING.raftHeartbeatMs
/** Write-arm cycles per model second. The dwell *fraction* carries the fact. */
const ARM_HZ = 1.6

const TXT_STALL = 'NO QUORUM: WRITES STALL, CONTROL PLANE IS READ-ONLY'
const TXT_NOSPACE = 'ALARM NOSPACE: QUOTA EXCEEDED, ETCD IS READ-ONLY'
const TXT_CORRUPT = 'ALARM CORRUPT: BACKEND HASH MISMATCH BETWEEN MEMBERS'
const TXT_BLANK = ''
const TXT_SATURATED = 'DISK SATURATED'
/* Interned so the per-frame comparison in TextRun.setString never allocates. */
const OP_PUT = 'put'
const OP_DEL = 'del'

/* Scratch. Reused by update(); never read across a call boundary. */
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _um = new THREE.Matrix4()
const _us = new THREE.Vector3()

const ZERO_Q = new THREE.Quaternion()

type MatKey =
  | 'concrete'
  | 'deck'
  | 'dark'
  | 'etcd'
  | 'etcdDim'
  | 'raft'
  | 'raftDim'
  | 'actual'
  | 'ready'
  | 'failed'
  | 'failedDim'
  | 'pending'
  | 'api'
  | 'apiDim'
  | 'ghostRaft'
  | 'ghostTarget'

type MatBag = Record<MatKey, THREE.MeshStandardMaterial>

function resolveMaterials(): MatBag {
  return {
    concrete: mat(structural('concrete')),
    deck: mat(structural('deck')),
    dark: mat(structural('ground'), 0.95),
    etcd: neon(COLOR.etcd, 1.9),
    etcdDim: neon(COLOR.etcd, 0.45),
    raft: neon(COLOR.raft, 1.7),
    raftDim: neon(COLOR.raft, 0.6),
    actual: neon(COLOR.actual, 1.3),
    ready: neon(COLOR.ready, 1.8),
    failed: neon(COLOR.failed, 2.1),
    failedDim: neon(COLOR.failed, 0.55),
    pending: neon(COLOR.pending, 2.0),
    api: neon(COLOR.api, 1.7),
    apiDim: neon(COLOR.api, 0.3),
    ghostRaft: ghost(COLOR.raft, 0.24),
    ghostTarget: ghost(COLOR.desired, 0.18),
  }
}

export function createEtcd(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'etcd'

  let M = resolveMaterials()
  /* Meshes whose material is fixed. Re-applied when the theme flips, because
   * theme.setMode() disposes the cache we are holding references into. */
  const styled: { mesh: THREE.Mesh | THREE.InstancedMesh; key: MatKey }[] = []
  const owned: THREE.BufferGeometry[] = []

  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    owned.push(g)
    return g
  }
  const box = (w: number, h: number, d: number) => geo(new THREE.BoxGeometry(w, h, d))
  /** Box whose origin sits on its own base, so scaling Y grows it upward. */
  const riser = (w: number, h: number, d: number) => {
    const g = new THREE.BoxGeometry(w, h, d)
    g.translate(0, h / 2, 0)
    return geo(g)
  }
  const put = (g: THREE.BufferGeometry, key: MatKey, parent: THREE.Object3D): THREE.Mesh => {
    const m = new THREE.Mesh(g, M[key])
    styled.push({ mesh: m, key })
    parent.add(m)
    return m
  }

  const text = new TextBank(1500)
  /* Labels annotate; they never intercept a pick. Clicking a log entry's key
   * must select the log entry, not the glyph quad floating in front of it. */
  text.mesh.raycast = () => {}
  group.add(text.mesh)

  /* ------------------------------------------------------------------ vault */

  const vault = new THREE.Group()
  vault.position.set(ANCHOR.etcdVault[0], ANCHOR.etcdVault[1], ANCHOR.etcdVault[2])
  group.add(vault)

  /* A plinth, not the pit floor: the excavation itself belongs to the ground
   * district. This is the slab the store stands on. */
  const plinth = put(box(PIT.hx * 1.86, 2.4, PIT.hz * 1.82), 'concrete', vault)
  plinth.position.y = -1.2

  const plinthRim = put(box(PIT.hx * 1.9, 0.5, PIT.hz * 1.86), 'etcdDim', vault)
  plinthRim.position.y = 0.15

  /* -------------------------------------------------------------- the door */

  /* etcd has exactly one client. The conduit from the API server's storage
   * floor lands here and nowhere else; there is no second entrance to build. */
  const door = new THREE.Group()
  door.position.set(ANCHOR.etcdLeader[0], ANCHOR.etcdLeader[1], ANCHOR.etcdLeader[2])
  group.add(door)

  const doorPad = put(geo(new THREE.CylinderGeometry(15, 17, 2.2, 8)), 'deck', door)
  doorPad.position.y = 1.1

  const doorPostGeo = riser(2.2, 16, 2.2)
  const doorL = put(doorPostGeo, 'concrete', door)
  doorL.position.set(-7.5, 2.2, 0)
  const doorR = put(doorPostGeo, 'concrete', door)
  doorR.position.set(7.5, 2.2, 0)
  const lintel = put(box(19, 2.4, 3), 'concrete', door)
  lintel.position.set(0, 19.4, 0)

  /* The client link itself: a shaft of API-blue rising out of the pit toward
   * the tower's storage floor. Dim when etcd cannot serve writes. */
  const doorShaft = put(geo(new THREE.CylinderGeometry(3.2, 3.2, 44, 12, 1, true)), 'api', door)
  doorShaft.position.y = 24

  text.label('KUBE-APISERVER: THE ONLY CLIENT', {
    x: ANCHOR.etcdLeader[0],
    y: ANCHOR.etcdLeader[1] + 23,
    z: ANCHOR.etcdLeader[2] - 1.8,
    size: 2,
    rotY: FACE_N,
    align: 'center',
  }, COLOR.api)

  /* Forwarding link door -> current leader. One baked beam per member; only
   * the leader's is visible, so the frame loop does no transform maths. */
  const forwardBeams: THREE.Mesh[] = []
  const linkGeo = geo(new THREE.CylinderGeometry(0.7, 0.7, 1, 6))
  linkGeo.translate(0, 0.5, 0)
  for (let i = 0; i < N_ETCD_MEMBERS; i++) {
    etcdMemberPos(i, _a)
    const from = new THREE.Vector3(ANCHOR.etcdLeader[0], ANCHOR.etcdLeader[1] + 9, ANCHOR.etcdLeader[2])
    const to = new THREE.Vector3(_a.x, _a.y + 14, _a.z)
    const beam = put(linkGeo, 'api', group)
    beam.position.copy(from)
    beam.scale.set(1, from.distanceTo(to), 1)
    beam.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      to.clone().sub(from).normalize(),
    )
    beam.visible = false
    forwardBeams.push(beam)
  }

  /* ---------------------------------------------------------------- members */

  interface MemberRig {
    root: THREE.Group
    body: THREE.Mesh
    core: THREE.Mesh
    beacon: THREE.Mesh
    crown: THREE.Mesh
    downMark: THREE.Mesh
    colTarget: THREE.Mesh
    colFill: THREE.Mesh
    armPivot: THREE.Group
    armHead: THREE.Mesh
    platter: THREE.Mesh
    nameRun: TextRun
    roleRun: TextRun
    termRun: TextRun
    matchRun: TextRun
    lagRun: TextRun
    fsyncRun: TextRun
    diskRun: TextRun
    /* Smoothed so a leadership change is a building rising, not a pop. */
    height: number
    armAngle: number
    hbPhase: number
  }

  const bodyGeo = riser(MEMBER_W, MEMBER_H, MEMBER_D)
  const coreGeo = riser(MEMBER_W * 0.24, MEMBER_H, MEMBER_W * 0.24)
  const baseGeo = box(MEMBER_W + 7, 3, MEMBER_D + 7)
  const beaconGeo = riser(3.2, 6, 3.2)
  const crownGeo = geo(new THREE.TorusGeometry(9, 1.1, 8, 24))
  const downGeo = box(MEMBER_W * 0.7, 1.4, 1.4)
  const colGeo = riser(3, COL_H, 3)
  const platterGeo = geo(new THREE.CylinderGeometry(6.5, 6.5, 0.7, 24))
  const spindleGeo = riser(1.2, 4, 1.2)
  const armGeo = box(9, 0.9, 1.6)
  const headGeo = box(1.6, 1.1, 1.9)
  const placardGeo = box(31, 15, 0.7)

  const members: MemberRig[] = []
  for (let i = 0; i < N_ETCD_MEMBERS; i++) {
    etcdMemberPos(i, _a)
    const root = new THREE.Group()
    root.position.copy(_a)
    group.add(root)

    const base = put(baseGeo, 'deck', root)
    base.position.y = 1.5

    const body = put(bodyGeo, 'concrete', root)
    body.position.y = 3

    /* The keyspace itself, glowing inside the shell. */
    const core = put(coreGeo, 'etcd', root)
    core.position.set(0, 3.4, -MEMBER_D * 0.5 - 0.4)

    const beacon = put(beaconGeo, 'raft', root)
    beacon.position.y = 3 + MEMBER_H

    const crown = put(crownGeo, 'etcd', root)
    crown.rotation.x = Math.PI / 2
    crown.position.y = 3 + MEMBER_H + 12
    crown.visible = false

    const downMark = put(downGeo, 'failed', root)
    downMark.position.set(0, 3 + MEMBER_H * 0.55, -MEMBER_D / 2 - 0.9)
    downMark.visible = false

    /* matchIndex: the ghost is the leader's log, the solid bar is what this
     * member has actually persisted. Desired versus actual, again. */
    const colTarget = put(colGeo, 'ghostTarget', root)
    colTarget.position.set(-MEMBER_W / 2 - 6, 3, -MEMBER_D / 2 + 2)
    const colFill = put(colGeo, 'raft', root)
    colFill.position.copy(colTarget.position)
    colFill.scale.y = 0.001

    /* The write arm. etcd must fsync the WAL before it may acknowledge. */
    const diskX = MEMBER_W / 2 + 10
    const platter = put(platterGeo, 'deck', root)
    platter.position.set(diskX, 3.4, 0)
    const spindle = put(spindleGeo, 'concrete', root)
    spindle.position.set(diskX, 3.4, 0)
    const armPivot = new THREE.Group()
    armPivot.position.set(diskX + 8, 7.2, 0)
    root.add(armPivot)
    const arm = put(armGeo, 'concrete', armPivot)
    arm.position.set(-4.5, 0, 0)
    const armHead = put(headGeo, 'raft', armPivot)
    armHead.position.set(-8.6, -0.8, 0)

    const placard = put(placardGeo, 'deck', root)
    placard.position.set(0, 10, -MEMBER_D / 2 - 4)
    placard.rotation.y = FACE_N

    const px = _a.x
    const py = _a.y
    const pz = _a.z - MEMBER_D / 2 - 4.5
    const pose = (dy: number, size: number, dx: number, align: 'left' | 'right' | 'center') => ({
      x: px + dx,
      y: py + dy,
      z: pz,
      size,
      rotY: FACE_N,
      align,
    })
    /* Panel faces north (-Z), so a run's local +X lands on the viewer's right. */
    const nameRun = text.claim(14, pose(15.6, 2.4, 0, 'center'), COLOR.etcd)
    const roleRun = text.claim(9, pose(12.4, 2.1, 0, 'center'), COLOR.raft)
    text.label('TERM', pose(9.4, 1.7, 13, 'left'), COLOR.edge)
    const termRun = text.claim(5, pose(9.4, 1.7, -13, 'right'), COLOR.raft)
    text.label('MATCH', pose(6.9, 1.7, 13, 'left'), COLOR.edge)
    const matchRun = text.claim(8, pose(6.9, 1.7, -13, 'right'), COLOR.raft)
    text.label('LAG', pose(4.4, 1.7, 13, 'left'), COLOR.edge)
    const lagRun = text.claim(6, pose(4.4, 1.7, -13, 'right'), COLOR.pending)
    text.label('FSYNC', pose(1.9, 1.7, 13, 'left'), COLOR.edge)
    text.label('ms', pose(1.9, 1.7, -13, 'right'), COLOR.edge)
    const fsyncRun = text.claim(6, pose(1.9, 1.7, -15.6, 'right'), COLOR.raft)
    const diskRun = text.claim(TXT_SATURATED.length, {
      x: px + MEMBER_W / 2 + 10,
      y: py + 12,
      z: pz + 3,
      size: 1.5,
      rotY: FACE_N,
      align: 'center',
    }, COLOR.failed)

    members.push({
      root,
      body,
      core,
      beacon,
      crown,
      downMark,
      colTarget,
      colFill,
      armPivot,
      armHead,
      platter,
      nameRun,
      roleRun,
      termRun,
      matchRun,
      lagRun,
      fsyncRun,
      diskRun,
      height: MEMBER_H,
      armAngle: -0.12,
      hbPhase: ctx.rng.next(),
    })
  }

  /* --------------------------------------------------------- the raft log */

  interface CrateRig {
    root: THREE.Group
    crate: THREE.Mesh
    lid: THREE.Mesh
    stuck: THREE.Mesh
    idxRun: TextRun
    opRun: TextRun
    termRun: TextRun
    keyRun: TextRun
  }

  const logGroup = new THREE.Group()
  group.add(logGroup)

  raftLogSlotPos(0, _a)
  raftLogSlotPos(RAFT_LOG_SLOTS - 1, _b)
  const slotPitch = RAFT_LOG_SLOTS > 1 ? (_b.x - _a.x) / (RAFT_LOG_SLOTS - 1) : 12
  const rail = put(box(_b.x - _a.x + 14, 1.6, 15), 'deck', logGroup)
  rail.position.set((_a.x + _b.x) / 2, _a.y - 4.2, _a.z)
  const railRim = put(box(_b.x - _a.x + 14, 0.4, 15.6), 'raftDim', logGroup)
  railRim.position.set((_a.x + _b.x) / 2, _a.y - 3.3, _a.z)

  const crateGeo = box(9, 7, 12)
  const lidGeo = box(9.6, 0.9, 12.6)
  const stuckGeo = box(9.6, 0.7, 12.6)

  const crates: CrateRig[] = []
  for (let slot = 0; slot < RAFT_LOG_SLOTS; slot++) {
    raftLogSlotPos(slot, _a)
    const root = new THREE.Group()
    root.position.copy(_a)
    logGroup.add(root)

    const crate = put(crateGeo, 'ghostRaft', root)
    const lid = put(lidGeo, 'actual', root)
    lid.position.y = 3.9
    lid.visible = false
    const stuck = put(stuckGeo, 'failed', root)
    stuck.position.y = -3.9
    stuck.visible = false

    const x = _a.x
    const y = _a.y
    const z = _a.z
    /* Index and op lie flat on the crate lid, read from the north. */
    const idxRun = text.claim(7, { x, y: y + 3.6, z: z - 3.4, size: 1.7, rotX: -Math.PI / 2, rotY: FACE_N, align: 'center' }, COLOR.actual)
    const opRun = text.claim(3, { x, y: y + 3.6, z: z + 2.6, size: 1.5, rotX: -Math.PI / 2, rotY: FACE_N, align: 'center' }, COLOR.raft)
    /* The key and term ride the crate's north face. The panel faces -Z, so a
     * left-aligned run advances toward world -X, which is the viewer's right. */
    const keyRun = text.claim(18, { x, y: y - 1.6, z: z - 6.3, size: 0.95, rotY: FACE_N, align: 'center' }, COLOR.raft)
    text.label('TERM', { x: x + 3.2, y: y + 0.5, z: z - 6.3, size: 0.85, rotY: FACE_N, align: 'left' }, COLOR.edge)
    const termRun = text.claim(4, { x: x + 3.2 - 4 * 0.85 * 0.58, y: y + 0.5, z: z - 6.3, size: 0.85, rotY: FACE_N, align: 'left' }, COLOR.edge)

    crates.push({ root, crate, lid, stuck, idxRun, opRun, termRun, keyRun })
  }

  /* Proposals in flight: one instance per (entry, follower) pair. An instance
   * is only alive while that follower's matchIndex is behind that entry. */
  const packetCount = RAFT_LOG_SLOTS * Math.max(1, N_ETCD_MEMBERS - 1)
  const packetGeo = geo(new THREE.OctahedronGeometry(1.5, 0))
  const packets = new THREE.InstancedMesh(packetGeo, M.raft, packetCount)
  packets.frustumCulled = false
  packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  styled.push({ mesh: packets, key: 'raft' })
  group.add(packets)

  /* AppendEntries heartbeats: the leader's proof of life, every 100 ms. */
  const pulseGeo = geo(new THREE.SphereGeometry(1.6, 8, 6))
  const beats = new THREE.InstancedMesh(pulseGeo, M.raft, N_ETCD_MEMBERS * HB_PER_LINK)
  beats.frustumCulled = false
  beats.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  styled.push({ mesh: beats, key: 'raft' })
  group.add(beats)

  /* RequestVote, only during an election. */
  const votes = new THREE.InstancedMesh(pulseGeo, M.pending, N_ETCD_MEMBERS * N_ETCD_MEMBERS)
  votes.frustumCulled = false
  votes.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  styled.push({ mesh: votes, key: 'pending' })
  group.add(votes)

  const hideInstance = (mesh: THREE.InstancedMesh, i: number): void => {
    _um.makeScale(0, 0, 0)
    mesh.setMatrixAt(i, _um)
  }
  const placeInstance = (mesh: THREE.InstancedMesh, i: number, s: number): void => {
    _us.set(s, s, s)
    _um.compose(_c, ZERO_Q, _us)
    mesh.setMatrixAt(i, _um)
  }
  for (let i = 0; i < packetCount; i++) hideInstance(packets, i)
  for (let i = 0; i < beats.count; i++) hideInstance(beats, i)
  for (let i = 0; i < votes.count; i++) hideInstance(votes, i)
  packets.instanceMatrix.needsUpdate = true
  beats.instanceMatrix.needsUpdate = true
  votes.instanceMatrix.needsUpdate = true

  /* ------------------------------------------------------------ quorum ring */

  /* One arc per member. An arc lights only while its member can vote, so the
   * ring is visibly incomplete at 2 of 3 and visibly broken at 1 of 3. */
  const arcSpan = ((Math.PI * 2) / N_ETCD_MEMBERS) * 0.78
  const arcGeo = geo(new THREE.TorusGeometry(RING_R, 1.3, 8, 40, arcSpan))
  arcGeo.rotateZ(-arcSpan / 2)
  const ringArcs: THREE.Mesh[] = []
  for (let i = 0; i < N_ETCD_MEMBERS; i++) {
    etcdMemberPos(i, _a)
    const az = Math.atan2(_a.z - PIT.z, _a.x - PIT.x)
    const yaw = new THREE.Group()
    yaw.position.set(PIT.x, RING_Y, PIT.z)
    yaw.rotation.y = -az
    group.add(yaw)
    const arc = put(arcGeo, 'raft', yaw)
    arc.rotation.x = -Math.PI / 2
    ringArcs.push(arc)
  }

  const hub = put(geo(new THREE.CylinderGeometry(7, 7, 1.4, 20)), 'ready', group)
  hub.position.set(PIT.x, RING_Y, PIT.z)
  const hubBeam = put(geo(new THREE.CylinderGeometry(1.1, 1.1, 30, 8)), 'ready', group)
  hubBeam.position.set(PIT.x, RING_Y - 15, PIT.z)

  text.label('MEMBERS UP', {
    x: PIT.x + 12,
    y: RING_Y + 5,
    z: PIT.z - 1,
    size: 2.6,
    rotY: FACE_N,
    align: 'left',
  }, COLOR.edge)
  const quorumRun = text.claim(6, {
    x: PIT.x - 15,
    y: RING_Y + 5,
    z: PIT.z - 1,
    size: 2.6,
    rotY: FACE_N,
    align: 'right',
  }, COLOR.ready)
  text.label('MAJORITY NEEDED', {
    x: PIT.x + 12,
    y: RING_Y + 1,
    z: PIT.z - 1,
    size: 2,
    rotY: FACE_N,
    align: 'left',
  }, COLOR.edge)
  const upRun = text.claim(4, {
    x: PIT.x - 15,
    y: RING_Y + 1,
    z: PIT.z - 1,
    size: 2,
    rotY: FACE_N,
    align: 'right',
  }, COLOR.raft)

  /* --------------------------------------------------------- revision board */

  const boardY = PIT.floorY + 32
  const board = put(box(BOARD_HX * 2 + 8, 52, 1.4), 'concrete', group)
  board.position.set(PIT.x, boardY, BOARD_Z)
  const boardTrim = put(box(BOARD_HX * 2 + 8, 0.8, 2), 'etcdDim', group)
  boardTrim.position.set(PIT.x, boardY + 26.4, BOARD_Z - 0.2)

  const row = (dy: number) => boardY + dy
  /* The board faces north, so the viewer's right is world -X. `dx` is measured
   * from the viewer's point of view: -96 is the left edge of the board. */
  const bpose = (dx: number, dy: number, size: number, align: 'left' | 'right' | 'center') => ({
    x: PIT.x - dx,
    y: row(dy),
    z: BOARD_TEXT_Z,
    size,
    rotY: FACE_N,
    align,
  })

  text.label('REVISION', bpose(-96, 17, 3.6, 'left'), COLOR.edge)
  /* Monotonic: nothing in etcd's API can make this number go down. */
  const revisionRun = text.claim(12, bpose(96, 14, 9, 'right'), COLOR.etcd)
  const revTick = put(box(4, 1.2, 0.6), 'actual', group)
  revTick.position.set(PIT.x - 92, row(9.4), BOARD_TEXT_Z - 0.3)
  revTick.visible = false

  /* History bar: the keyspace's revision window. Everything left of the
   * boundary has been compacted away and can never be read again. */
  const histW = 176
  /* Newest revision at the viewer's right (world -X); the compacted past runs
   * off to the viewer's left. Local +Y maps to world +X after the rotation. */
  const histNow = PIT.x - histW / 2
  const histVoid = put(box(histW, 3, 0.6), 'dark', group)
  histVoid.position.set(PIT.x, row(4), BOARD_TEXT_Z - 0.2)
  const histKept = put(riser(3, 1, 0.9), 'etcd', group)
  histKept.rotation.z = -Math.PI / 2
  histKept.position.set(histNow, row(4), BOARD_TEXT_Z - 0.5)
  const histMark = put(box(1.2, 7, 1.1), 'etcd', group)
  histMark.position.set(histNow, row(4), BOARD_TEXT_Z - 0.6)

  text.label('COMPACTED BELOW', bpose(-96, -2, 2.1, 'left'), COLOR.edge)
  const compactedRun = text.claim(12, bpose(-30, -2, 2.6, 'right'), COLOR.etcd)
  text.label('TERM', bpose(6, -2, 2.1, 'left'), COLOR.edge)
  const boardTermRun = text.claim(6, bpose(46, -2, 2.6, 'right'), COLOR.raft)
  text.label('WATCHERS', bpose(56, -2, 2.1, 'left'), COLOR.edge)
  const watchRun = text.claim(6, bpose(96, -2, 2.6, 'right'), COLOR.api)

  /* db size against the 2 GiB default quota. */
  text.label('DB', bpose(-96, -9, 2.4, 'left'), COLOR.edge)
  /* Empty at the viewer's left, quota line at the right: the bar fills toward
   * the cliff. Local +Y maps to world -X after the rotation. */
  const dbTrackLen = 104
  const dbLeft = PIT.x + 74
  const dbTrack = put(box(dbTrackLen, 3.4, 0.6), 'dark', group)
  dbTrack.position.set(dbLeft - dbTrackLen / 2, row(-8.5), BOARD_TEXT_Z - 0.2)
  const dbFill = put(riser(3.4, 1, 0.9), 'etcd', group)
  dbFill.rotation.z = Math.PI / 2
  dbFill.position.set(dbLeft, row(-8.5), BOARD_TEXT_Z - 0.5)
  const dbQuotaLine = put(box(1.2, 6, 1.1), 'failedDim', group)
  dbQuotaLine.position.set(dbLeft - dbTrackLen, row(-8.5), BOARD_TEXT_Z - 0.6)
  const dbSizeRun = text.claim(7, bpose(44, -9, 2.4, 'right'), COLOR.etcd)
  text.label('Mi OF', bpose(46, -9, 2.4, 'left'), COLOR.edge)
  const dbQuotaRun = text.claim(6, bpose(84, -9, 2.4, 'right'), COLOR.edge)
  text.label('Mi', bpose(86, -9, 2.4, 'left'), COLOR.edge)

  text.label('WRITES/S', bpose(-96, -15, 2.1, 'left'), COLOR.edge)
  const wpsRun = text.claim(7, bpose(-52, -15, 2.4, 'right'), COLOR.raft)
  text.label('QUORUM READ', bpose(-44, -15, 2.1, 'left'), COLOR.edge)
  const readRun = text.claim(7, bpose(14, -15, 2.4, 'right'), COLOR.raft)
  text.label('ms', bpose(16, -15, 2.1, 'left'), COLOR.edge)

  /* Two banners, both normally blank. */
  const alarmPlate = put(box(BOARD_HX * 2, 6, 0.6), 'failed', group)
  alarmPlate.position.set(PIT.x, row(-20.5), BOARD_TEXT_Z - 0.4)
  alarmPlate.visible = false
  const alarmRun = text.claim(TXT_NOSPACE.length, bpose(0, -21, 2.6, 'center'), COLOR.failed)

  const stallPlate = put(box(BOARD_HX * 2, 6, 0.6), 'failedDim', group)
  stallPlate.position.set(PIT.x, row(-25.5), BOARD_TEXT_Z - 0.4)
  stallPlate.visible = false
  const stallRun = text.claim(TXT_STALL.length, bpose(0, -26, 2.6, 'center'), COLOR.failed)

  /* ------------------------------------------------------------- explainers */

  const ONLY_CLIENT_CAVEAT =
    'Only kube-apiserver may talk to etcd. Controllers, the scheduler, kubelets and kubectl never open a connection here — they all go through the API server, which owns authentication, authorization, admission, validation and the watch cache. The single conduit into this pit is that rule, drawn.'
  const SCALE_CAVEAT =
    'This is a model, not etcd. Counts, rates and sizes are scaled so a human can watch them; the mechanisms and the field names are the real ones.'

  const reg = (e: Explainer): Explainer => ctx.registry.register(e)

  const vaultEntry = reg({
    id: 'etcd-vault',
    title: 'etcd vault',
    district: 'etcd',
    kubeName: 'etcd',
    object: vault,
    focus: [PIT.x, PIT.floorY + 46, PIT.z - 150],
    summary:
      'The cluster\'s only durable state. Every object you can kubectl get is a key in this keyspace, and exactly one process is allowed through the door.',
    detail: [
      'etcd is a strongly consistent, replicated key-value store. Kubernetes writes each object under a key shaped like /registry/<resource>/<namespace>/<name>, with a protobuf-encoded value. There is no second database and no cache of record: lose etcd and you have lost the cluster; restore an etcd snapshot and the cluster comes back exactly as of that revision.',
      'The vault is dug in below the API server because this is where the cluster stops being memory and starts being durable truth. A write only counts once a majority of these members has it on disk.',
      'Reads are linearizable by default: a get costs a ReadIndex round trip to a quorum before the leader will answer, which is why read latency tracks member health. Serializable reads (etcdctl --consistency=s) and the API server\'s own watch cache skip that round trip and may be slightly stale — that staleness is why a controller can briefly act on an old view and why optimistic concurrency on resourceVersion exists.',
      'The excavation has one conduit and one gate. That is not decoration: it is the entire security model of the control plane. Anything that can reach etcd directly can read every Secret in the cluster and write any object without passing RBAC or admission.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      SCALE_CAVEAT,
      'The keyspace itself is not drawn key by key. What you see is the raft layer that makes it durable, plus the revision and quota accounting that make it fail.',
    ],
    keywords: ['etcd', 'store', 'keyspace', 'registry', 'durable', 'database'],
    metrics: (s) => [
      { label: 'revision', value: String(s.etcd.revision) },
      { label: 'compacted below', value: String(s.etcd.compactedRevision) },
      { label: 'db size', value: `${formatMem(s.etcd.dbSizeMib)} of ${formatMem(s.etcd.dbQuotaMib)}` },
      { label: 'quorum', value: s.etcd.hasQuorum ? `yes (${ETCD_QUORUM} of ${N_ETCD_MEMBERS})` : 'LOST' },
      { label: 'watchers', value: String(s.etcd.watchers), hint: 'almost all of them the API server\'s' },
      { label: 'writes/s', value: s.etcd.writesPerSec.toFixed(1) },
      { label: 'quorum read', value: formatMs(s.etcd.readLatencyMs) },
      { label: 'alarm', value: s.etcd.alarm },
    ],
  })
  ctx.registry.bind(plinth, vaultEntry)
  ctx.registry.bind(door, vaultEntry)

  for (let i = 0; i < N_ETCD_MEMBERS; i++) {
    const idx = i
    const rig = members[idx]
    const entry = reg({
      id: `etcd-member-${idx}`,
      title: `etcd member ${idx}`,
      district: 'etcd',
      kubeName: 'etcd',
      object: rig.root,
      summary:
        'One raft peer. It holds a full copy of the log and of the keyspace; its role — leader, follower, candidate — is decided by election, not by configuration.',
      detail: [
        'Every member stores the whole dataset. There is no sharding in etcd: adding members buys availability, never capacity or write throughput. Each extra member makes every write slower, because the leader must ship it to more disks.',
        'The leader is the only member that accepts proposals. It appends an entry to its own log, fsyncs it, and sends AppendEntries to the followers; when a majority (including itself) has persisted the entry, the leader marks it committed and tells the others in the next AppendEntries. Each member then applies committed entries to its MVCC store in index order.',
        'matchIndex and nextIndex are the leader\'s bookkeeping about this follower, not something the follower advertises. A follower that falls far enough behind that the leader has already discarded the entries it needs gets a snapshot instead of a log stream.',
        'A follower that hears no AppendEntries within its randomized election timeout (etcd default --election-timeout 1000ms, --heartbeat-interval 100ms) increments its term, becomes a candidate, votes for itself, and asks the others for votes. A member grants at most one vote per term, and only to a candidate whose log is at least as up to date as its own — which is why a lagging member can never win and erase committed history.',
      ],
      caveats: [
        ONLY_CLIENT_CAVEAT,
        'Roles here change because the model decides they do; there is no real network partition underneath. A real election is also triggered by lost packets and slow disks, not just by a member being stopped.',
        'Snapshot transfer to a badly lagging follower is not drawn.',
      ],
      keywords: ['raft', 'member', 'leader', 'follower', 'candidate', 'peer', 'election', 'matchIndex'],
      metrics: (s) => {
        const m = s.etcd.members[idx]
        if (!m) return [{ label: 'member', value: 'absent' }]
        let lead = -1
        for (let k = 0; k < s.etcd.members.length; k++) {
          if (s.etcd.members[k].role === 'leader') lead = k
        }
        const head = lead >= 0 ? s.etcd.members[lead].matchIndex : m.matchIndex
        return [
          { label: 'name', value: m.name },
          { label: 'id', value: m.id },
          { label: 'role', value: m.role },
          { label: 'term', value: String(m.term) },
          { label: 'matchIndex', value: String(m.matchIndex) },
          { label: 'lag', value: String(Math.max(0, head - m.matchIndex)), hint: 'entries behind the leader' },
          { label: 'since heartbeat', value: formatMs(m.sinceHeartbeat * 1000) },
          { label: 'wal fsync', value: formatMs(m.fsyncMs) },
        ]
      },
    })
    ctx.registry.bind(rig.body, entry)
    ctx.registry.bind(rig.colTarget, entry)
  }

  const logEntry = reg({
    id: 'etcd-raft-log',
    title: 'raft log',
    district: 'etcd',
    kubeName: 'etcd raft',
    object: logGroup,
    summary:
      'The ordered list of proposed mutations. Every member replays it in the same order, which is the only reason they agree on what the cluster looks like.',
    detail: [
      'Each crate is one log entry: an index, the term it was proposed in, the key it mutates and whether it is a put or a delete. A translucent crate is a proposal — appended and fsynced, but not yet durable truth. A solid crate has been committed by a quorum. A crate with a warm-white lid has also been applied to the MVCC store, which is the moment the change becomes visible to a get.',
      'Raft guarantees three things worth memorising. Log Matching: if two members have an entry with the same index and term, their logs are identical up to that point. Leader Completeness: an entry committed in some term is present in the log of every future leader, so a committed write can never be lost by an election. State Machine Safety: no two members ever apply different entries at the same index.',
      'What raft does not guarantee: that a follower is current. A follower can be arbitrarily far behind and still be a perfectly legal raft member, which is exactly why a read has to go through the leader with a ReadIndex confirmation instead of being served locally.',
      'The conveyor is the leader\'s log. It is a sliding window of the newest entries, not the whole history — a real log is truncated behind a snapshot, which is a different mechanism from keyspace compaction.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'Raft log truncation (driven by --snapshot-count) and MVCC compaction are separate things. The board\'s compaction boundary is about the keyspace, not about these crates.',
      'Entry payloads are shown as a key path only. A real entry carries a full protobuf request, and one entry may be a transaction touching several keys.',
    ],
    keywords: ['raft', 'log', 'appendentries', 'commit', 'apply', 'index', 'term', 'wal'],
    metrics: (s) => {
      const log = s.etcd.log
      let committed = 0
      let applied = 0
      for (let i = 0; i < log.length; i++) {
        if (log[i].committed) committed++
        if (log[i].applied) applied++
      }
      return [
        { label: 'entries in window', value: String(log.length) },
        { label: 'committed', value: String(committed) },
        { label: 'applied', value: String(applied) },
        { label: 'in flight', value: String(log.length - committed) },
        { label: 'writes/s', value: s.etcd.writesPerSec.toFixed(1) },
      ]
    },
  })
  ctx.registry.bind(rail, logEntry)
  for (let i = 0; i < crates.length; i++) ctx.registry.bind(crates[i].root, logEntry)
  ctx.registry.bind(packets, logEntry)

  const quorumEntry = reg({
    id: 'etcd-quorum',
    title: 'quorum',
    district: 'etcd',
    kubeName: 'etcd quorum',
    object: hub,
    summary: `A write commits only when a majority of members has it on disk. With ${N_ETCD_MEMBERS} members that majority is ${ETCD_QUORUM}.`,
    detail: [
      `Majority means floor(n/2)+1. With ${N_ETCD_MEMBERS} members, ${ETCD_QUORUM} must acknowledge, so the cluster survives ${N_ETCD_MEMBERS - ETCD_QUORUM} failure. Two of these three down means no majority: no entry can commit, the leader steps down, linearizable reads fail, and every write through the API server returns an error.`,
      'This is why member counts are odd. Four members still need three for a majority — you paid for another disk and another network hop and bought exactly zero extra fault tolerance over three.',
      'Losing quorum does not stop the cluster from serving traffic. Kubelets keep the containers they already have running, kube-proxy keeps its existing rules, and pods keep answering requests. What stops is change: nothing can be scheduled, no controller can record a decision, no Lease can be renewed, so after the node monitor grace period the control plane\'s own view of the world starts to rot too.',
      'Recovery is not automatic if the members are truly gone. Bringing back a majority resumes service immediately; if a majority is permanently lost you restore from a snapshot and force a new single-member cluster, accepting whatever writes happened after that snapshot are gone.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'The model flips quorum by taking members down (knob: etcdMembersDown). Real quorum loss is more often a network partition, in which case the minority side is still up and still refusing writes — which looks identical from the API server.',
    ],
    keywords: ['quorum', 'majority', 'raft', 'split brain', 'availability', 'read-only'],
    metrics: (s) => {
      let up = 0
      for (let i = 0; i < s.etcd.members.length; i++) {
        if (s.etcd.members[i].role !== 'down') up++
      }
      return [
        { label: 'members up', value: `${up} of ${s.etcd.members.length}` },
        { label: 'needed', value: String(ETCD_QUORUM) },
        { label: 'has quorum', value: s.etcd.hasQuorum ? 'yes' : 'no' },
        { label: 'API server writable', value: s.api.writable ? 'yes' : 'no' },
      ]
    },
  })
  for (let i = 0; i < ringArcs.length; i++) ctx.registry.bind(ringArcs[i], quorumEntry)
  ctx.registry.bind(hubBeam, quorumEntry)

  const revisionEntry = reg({
    id: 'etcd-revision',
    title: 'revision',
    district: 'etcd',
    kubeName: 'metadata.resourceVersion',
    object: board,
    summary:
      'A single cluster-wide counter that increments once per committed transaction. It is where every object\'s resourceVersion comes from.',
    detail: [
      'The revision is global, not per key. Writing one ConfigMap bumps the same counter that every Pod, Node and Lease is versioned against, so resourceVersions are comparable across resources but are not a per-object edit count.',
      'Kubernetes surfaces the revision as metadata.resourceVersion, and treats it as an opaque token: you may compare it for equality and pass it back, but you must never do arithmetic on it. An update carries the resourceVersion you read; if etcd\'s current revision for that key differs, the transaction fails and the API server returns 409 Conflict. That is optimistic concurrency, and it is why controllers are written to retry rather than to lock.',
      'A watch is a subscription starting at a revision: give the API server a resourceVersion and it replays every change after it. That is what makes informers cheap and what makes the whole level-triggered model work.',
      'The counter only ever moves forward. Nothing in the API can decrement it, deleting keys does not reclaim revisions, and a restored snapshot resumes from the revision it was taken at.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'The model bumps the revision once per write it simulates. A real cluster bumps it far faster, mostly from Lease and Event churn that has nothing to do with your workloads.',
    ],
    keywords: ['revision', 'resourceVersion', 'mvcc', 'conflict', '409', 'optimistic concurrency', 'watch'],
    metrics: (s) => [
      { label: 'revision', value: String(s.etcd.revision) },
      { label: 'apiserver watch cache at', value: String(s.api.watchCacheRevision), hint: 'how far the cache lags etcd' },
      { label: 'cache lag', value: String(Math.max(0, s.etcd.revision - s.api.watchCacheRevision)) },
      { label: 'conflicts (409)', value: String(s.api.counts.conflict) },
    ],
  })
  ctx.registry.bind(boardTrim, revisionEntry)
  ctx.registry.bind(revTick, revisionEntry)

  const compactionEntry = reg({
    id: 'etcd-compaction',
    title: 'compaction',
    district: 'etcd',
    kubeName: 'etcd compact',
    object: histVoid,
    summary:
      'The boundary behind which history no longer exists. Below the compacted revision, superseded versions have been discarded and cannot be read or watched.',
    detail: [
      'etcd keeps every version of every key, indexed by revision — that is what makes a watch from an old revision possible. Left alone, that history grows without bound, so something must throw it away. The API server does it for you: kube-apiserver runs a compaction loop on --etcd-compaction-interval, 5 minutes by default.',
      'Reading or watching from a revision below the boundary fails with "mvcc: required revision has been compacted". The API server turns that into 410 Gone, "too old resource version", and a client informer responds by throwing away its cache and doing a full relist. A cluster whose write rate outruns its compaction interval makes every informer in the cluster relist, and the resulting list storm on the API server is a classic self-inflicted outage.',
      'Compaction does not shrink the file. It marks pages free inside the bbolt backend so future writes can reuse them; the file stays the size of its high-water mark. Returning space to the filesystem requires etcdctl defrag, which blocks the member it runs on — so you defrag one member at a time, never the leader first.',
      'The current revision is unaffected by compaction. You lose old versions, never the live value of a key.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'The bar shows a fixed window of recent revisions, not the whole history since cluster creation.',
      'Raft log truncation via snapshots is a separate mechanism and is not drawn.',
    ],
    keywords: ['compaction', 'compact', 'ErrCompacted', '410', 'too old resource version', 'defrag', 'relist'],
    metrics: (s) => [
      { label: 'compacted below', value: String(s.etcd.compactedRevision) },
      { label: 'revisions retained', value: String(Math.max(0, s.etcd.revision - s.etcd.compactedRevision)) },
      { label: 'compaction interval', value: `${TIMING.etcdCompactionIntervalSeconds}s`, hint: 'kube-apiserver --etcd-compaction-interval' },
    ],
  })
  ctx.registry.bind(histMark, compactionEntry)
  ctx.registry.bind(histKept, compactionEntry)

  const quotaEntry = reg({
    id: 'etcd-db-quota',
    title: 'backend quota and the NOSPACE alarm',
    district: 'etcd',
    kubeName: 'etcd alarm NOSPACE',
    object: dbTrack,
    summary:
      'etcd refuses to grow past --quota-backend-bytes, 2 GiB by default. Crossing it raises a cluster-wide NOSPACE alarm and etcd goes read-only.',
    detail: [
      'The quota is a deliberate cliff, not a soft limit. When the backend file exceeds it, etcd raises an alarm and rejects every write from every client until the alarm is cleared. From the outside this looks like a total control-plane outage: kubectl apply fails, no pod can be created, no Lease can be renewed, so nodes start going NotReady.',
      'Recovery is a fixed sequence: compact the history, defrag each member to actually return the pages to the filesystem, then etcdctl alarm disarm. Skipping the defrag means the file is still over quota and the alarm comes straight back.',
      'What fills a backend is almost never your workload objects. It is Events, Leases, oversized ConfigMaps and Secrets, and CRDs written in a tight loop by a badly behaved operator. The default 2 GiB is generous for object storage and small for garbage.',
      'CORRUPT is the other alarm you can see here: it means members disagree about the hash of their keyspace. That one is not a capacity problem and cannot be fixed by defrag.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'The model tracks one backend size for the cluster. In reality each member has its own file, and the alarm is raised cluster-wide as soon as any one member crosses the quota.',
      'db size here grows with the model\'s write volume, not with real object sizes.',
    ],
    keywords: ['quota', 'NOSPACE', 'alarm', 'defrag', 'read-only', 'quota-backend-bytes', 'db size'],
    metrics: (s) => [
      { label: 'db size', value: formatMem(s.etcd.dbSizeMib) },
      { label: 'quota', value: formatMem(s.etcd.dbQuotaMib) },
      { label: 'used', value: `${((s.etcd.dbSizeMib / Math.max(1, s.etcd.dbQuotaMib)) * 100).toFixed(1)}%` },
      { label: 'alarm', value: s.etcd.alarm },
      { label: 'API server writable', value: s.api.writable ? 'yes' : 'no' },
    ],
  })
  ctx.registry.bind(dbFill, quotaEntry)
  ctx.registry.bind(dbQuotaLine, quotaEntry)
  ctx.registry.bind(alarmPlate, quotaEntry)

  const fsyncEntry = reg({
    id: 'etcd-fsync',
    title: 'fsync latency',
    district: 'etcd',
    kubeName: 'etcd_disk_wal_fsync_duration_seconds',
    object: members[0].platter,
    summary:
      'Raft cannot acknowledge an entry until it is durable, so every proposal waits on a disk write. Slow disks are the number one way real etcd clusters fail.',
    detail: [
      'Each write arm is one member\'s WAL. It comes down, dwells for the fsync, and lifts. The fraction of time it spends down is the disk\'s duty cycle: write rate multiplied by fsync duration. At 3 ms the arm is idle most of the time; at 300 ms it never lifts, and proposals queue behind it.',
      'The two metrics that matter are etcd_disk_wal_fsync_duration_seconds (the raft WAL append) and etcd_disk_backend_commit_duration_seconds (the MVCC commit). A p99 WAL fsync above roughly 10 ms means you are on the wrong storage; anything approaching the 100 ms heartbeat interval means the leader will miss heartbeats.',
      'That is how a disk problem becomes an availability problem. A leader too busy fsyncing to send AppendEntries within a follower\'s election timeout gets replaced; the new leader inherits the same slow storage; the cluster oscillates between terms and every API server write times out. The symptom users report is "kubectl is slow", and the cause is a disk.',
      'This is also why etcd wants dedicated low-latency storage and never a network filesystem, and why fsync latency dominates the choice of instance type far more than CPU does.',
    ],
    caveats: [
      ONLY_CLIENT_CAVEAT,
      'The arm cycles at a fixed, watchable rate. What is faithful is the dwell fraction — write rate times fsync duration — not the individual cycle time.',
      'Real fsync latency is a distribution with a long tail; the model carries one number per member (knob: etcdFsyncMs).',
    ],
    keywords: ['fsync', 'wal', 'disk', 'latency', 'iops', 'slow disk', 'backend commit'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.etcd.members.length; i++) {
        const m = s.etcd.members[i]
        const duty = (m.fsyncMs * s.etcd.writesPerSec) / 1000
        out.push({
          label: `${m.name} wal fsync`,
          value: formatMs(m.fsyncMs),
          hint: `disk busy ${Math.min(100, duty * 100).toFixed(0)}%`,
        })
      }
      out.push({ label: 'heartbeat interval', value: `${TIMING.raftHeartbeatMs}ms` })
      out.push({ label: 'election timeout', value: `${TIMING.raftElectionTimeoutMs}ms` })
      return out
    },
  })
  for (let i = 0; i < members.length; i++) {
    ctx.registry.bind(members[i].platter, fsyncEntry)
    ctx.registry.bind(members[i].armPivot, fsyncEntry)
  }

  /* ------------------------------------------------------------------ theme */

  const offTheme = ctx.bus.on('theme', () => {
    /* theme.setMode() disposes the material cache we hold references into, so
     * re-resolve and re-apply. Never inside update(). */
    M = resolveMaterials()
    for (let i = 0; i < styled.length; i++) styled[i].mesh.material = M[styled[i].key]
  })

  /* ------------------------------------------------------------------ frame */

  let conveyorShift = 0
  let lastFirstIndex = -1
  let lastRevision = -1
  let revFlash = 0

  function update(s: SimState, dt: number): void {
    const e = s.etcd
    const mem = e.members
    const nMem = mem.length < N_ETCD_MEMBERS ? mem.length : N_ETCD_MEMBERS
    const stalled = !e.hasQuorum

    let leader = -1
    let up = 0
    let maxTerm = 0
    for (let i = 0; i < nMem; i++) {
      const m = mem[i]
      if (m.role !== 'down') up++
      if (m.role === 'leader') leader = i
      if (m.term > maxTerm) maxTerm = m.term
    }

    const logLen = e.log.length
    const windowStart = logLen > RAFT_LOG_SLOTS ? logLen - RAFT_LOG_SLOTS : 0
    const headIndex = logLen > 0 ? e.log[logLen - 1].index : 0

    /* ---- members ---- */
    for (let i = 0; i < members.length; i++) {
      const rig = members[i]
      const m = i < nMem ? mem[i] : undefined
      if (!m) {
        rig.root.visible = false
        continue
      }
      rig.root.visible = true
      const down = m.role === 'down'
      const isLeader = m.role === 'leader'

      const targetH = MEMBER_H + (isLeader ? LEADER_EXTRA : 0)
      rig.height = approach(rig.height, targetH, 6, dt)
      const hs = rig.height / MEMBER_H
      rig.body.scale.y = hs
      rig.core.scale.y = hs
      rig.beacon.position.y = 3 + rig.height
      rig.crown.position.y = 3 + rig.height + 12
      rig.crown.visible = isLeader
      rig.downMark.visible = down

      rig.body.material = down ? M.dark : M.concrete
      rig.core.visible = !down
      rig.core.material = stalled ? M.etcdDim : M.etcd
      rig.beacon.material = down
        ? M.failedDim
        : m.role === 'candidate'
          ? M.pending
          : isLeader
            ? M.etcd
            : M.raftDim
      /* A candidate is campaigning: make the beacon breathe so an election is
       * impossible to miss even from the surface. */
      const beat = m.role === 'candidate' ? 1 + Math.sin(s.t * 9) * 0.35 : 1
      rig.beacon.scale.set(beat, beat, beat)

      /* matchIndex: ghost is the leader's log head, solid is this member. */
      const lag = headIndex > m.matchIndex ? headIndex - m.matchIndex : 0
      const frac = down ? 0 : 1 - clamp(lag / RAFT_LOG_SLOTS, 0, 1)
      rig.colFill.scale.y = frac < 0.002 ? 0.002 : frac
      rig.colFill.material = down ? M.failedDim : stalled ? M.raftDim : M.raft
      rig.colTarget.visible = !down

      /* Write arm. Down-fraction is write rate times fsync duration: the real
       * relationship between a slow disk and a stalled proposal. */
      const duty = down ? 0 : clamp((m.fsyncMs * e.writesPerSec) / 1000, 0.03, 1)
      const saturated = duty > 0.95
      const phase = (s.t * ARM_HZ + rig.hbPhase) % 1
      const writing = !down && (saturated || phase < duty)
      rig.armAngle = approach(rig.armAngle, writing ? 0.3 : -0.14, 14, dt)
      rig.armPivot.rotation.z = rig.armAngle
      rig.armHead.material = down ? M.dark : saturated ? M.failed : writing ? M.raft : M.raftDim
      rig.platter.rotation.y = down ? rig.platter.rotation.y : rig.platter.rotation.y + dt * 3
      rig.diskRun.setString(saturated ? TXT_SATURATED : TXT_BLANK)

      rig.nameRun.setString(m.name)
      rig.nameRun.setColor(down ? COLOR.failed : COLOR.etcd)
      rig.roleRun.setString(m.role)
      rig.roleRun.setColor(
        down ? COLOR.failed : m.role === 'candidate' ? COLOR.pending : isLeader ? COLOR.etcd : COLOR.raft,
      )
      rig.termRun.setInt(m.term)
      rig.termRun.setColor(m.term < maxTerm ? COLOR.pending : COLOR.raft)
      rig.matchRun.setInt(m.matchIndex)
      rig.lagRun.setInt(lag)
      rig.lagRun.setColor(lag > 0 ? COLOR.pending : COLOR.edge)
      rig.fsyncRun.setFixed(m.fsyncMs, 1)
      rig.fsyncRun.setColor(m.fsyncMs > TIMING.raftHeartbeatMs ? COLOR.failed : m.fsyncMs > 10 ? COLOR.pending : COLOR.raft)
    }

    /* ---- the one door, and which member it forwards to ---- */
    doorShaft.material = s.api.writable ? M.api : M.apiDim
    for (let i = 0; i < forwardBeams.length; i++) forwardBeams[i].visible = i === leader
    /* A write that lands on a follower is forwarded; with no leader there is
     * nowhere to forward it, which is what a stalled control plane looks like. */

    /* ---- raft log conveyor ---- */
    const firstIndex = logLen > 0 ? e.log[windowStart].index : 0
    if (lastFirstIndex >= 0 && firstIndex > lastFirstIndex) {
      const slid = firstIndex - lastFirstIndex
      conveyorShift += (slid < RAFT_LOG_SLOTS ? slid : RAFT_LOG_SLOTS) * slotPitch
    }
    lastFirstIndex = firstIndex
    conveyorShift = approach(conveyorShift, 0, 9, dt)
    logGroup.position.x = conveyorShift

    for (let slot = 0; slot < crates.length; slot++) {
      const c = crates[slot]
      const ei = windowStart + slot
      if (ei >= logLen) {
        c.root.visible = false
        continue
      }
      const entry = e.log[ei]
      c.root.visible = true
      c.crate.material = !entry.committed ? M.ghostRaft : stalled ? M.raftDim : M.raft
      c.lid.visible = entry.applied
      c.stuck.visible = stalled && !entry.committed
      c.idxRun.setInt(entry.index)
      c.idxRun.setColor(entry.applied ? COLOR.actual : entry.committed ? COLOR.raft : COLOR.edge)
      c.opRun.setString(entry.op === 'delete' ? OP_DEL : OP_PUT)
      c.termRun.setInt(entry.term)
      c.keyRun.setString(entry.key)
    }

    /* ---- proposals in flight ---- */
    let pi = 0
    for (let slot = 0; slot < crates.length; slot++) {
      const ei = windowStart + slot
      const entry = ei < logLen ? e.log[ei] : undefined
      for (let f = 0; f < members.length; f++) {
        if (f === leader) continue
        const inst = pi++
        if (inst >= packetCount) break
        const m = f < nMem ? mem[f] : undefined
        const live =
          entry !== undefined &&
          m !== undefined &&
          m.role !== 'down' &&
          leader >= 0 &&
          !entry.committed &&
          m.matchIndex < entry.index &&
          entry.replication > 0.001 &&
          entry.replication < 0.999
        if (!live || entry === undefined) {
          hideInstance(packets, inst)
          continue
        }
        _a.copy(crates[slot].root.position)
        _a.x += conveyorShift
        _a.y += 5
        _b.copy(members[f].root.position)
        _b.y += 14
        _c.copy(_a).lerp(_b, entry.replication)
        placeInstance(packets, inst, 1)
      }
    }
    packets.instanceMatrix.needsUpdate = true

    /* ---- heartbeats: the leader's proof of life, every raftHeartbeatMs ---- */
    for (let i = 0; i < members.length; i++) {
      const m = i < nMem ? mem[i] : undefined
      const live = leader >= 0 && i !== leader && m !== undefined && m.role !== 'down'
      for (let j = 0; j < HB_PER_LINK; j++) {
        const inst = i * HB_PER_LINK + j
        if (!live) {
          hideInstance(beats, inst)
          continue
        }
        const ph = (s.t * HB_HZ + j / HB_PER_LINK) % 1
        _a.copy(members[leader].root.position)
        _a.y += 3 + MEMBER_H * 0.8
        _b.copy(members[i].root.position)
        _b.y += 3 + MEMBER_H * 0.8
        _c.copy(_a).lerp(_b, ph)
        placeInstance(beats, inst, 1 - ph * 0.4)
      }
    }
    beats.instanceMatrix.needsUpdate = true

    /* ---- RequestVote, only while somebody is campaigning ---- */
    for (let c = 0; c < members.length; c++) {
      const cm = c < nMem ? mem[c] : undefined
      const campaigning = cm !== undefined && cm.role === 'candidate'
      for (let j = 0; j < members.length; j++) {
        const inst = c * members.length + j
        const tm = j < nMem ? mem[j] : undefined
        if (!campaigning || j === c || tm === undefined || tm.role === 'down') {
          hideInstance(votes, inst)
          continue
        }
        const ph = (s.t * 2.4 + j * 0.31) % 1
        _a.copy(members[c].root.position)
        _a.y += 3 + MEMBER_H
        _b.copy(members[j].root.position)
        _b.y += 3 + MEMBER_H * 0.8
        _c.copy(_a).lerp(_b, ph)
        placeInstance(votes, inst, 1.3)
      }
    }
    votes.instanceMatrix.needsUpdate = true

    /* ---- quorum ring ---- */
    for (let i = 0; i < ringArcs.length; i++) {
      const m = i < nMem ? mem[i] : undefined
      const alive = m !== undefined && m.role !== 'down'
      ringArcs[i].material = alive ? (e.hasQuorum ? M.raft : M.raftDim) : M.failedDim
    }
    hub.material = e.hasQuorum ? M.ready : M.failed
    hubBeam.material = e.hasQuorum ? M.ready : M.failed
    const hubBeat = e.hasQuorum ? 1 : 1 + Math.sin(s.t * 5) * 0.25
    hub.scale.set(hubBeat, 1, hubBeat)
    quorumRun.setRatio(up, nMem)
    quorumRun.setColor(e.hasQuorum ? COLOR.ready : COLOR.failed)
    upRun.setInt(ETCD_QUORUM)

    /* ---- the board ---- */
    revisionRun.setInt(e.revision)
    if (e.revision !== lastRevision) {
      lastRevision = e.revision
      revFlash = 0.35
    }
    revFlash = revFlash > dt ? revFlash - dt : 0
    revTick.visible = revFlash > 0
    revisionRun.setColor(stalled ? COLOR.edge : COLOR.etcd)

    const retained = e.revision > e.compactedRevision ? e.revision - e.compactedRevision : 0
    const keptFrac = clamp(retained / HISTORY_WINDOW, 0.004, 1)
    histKept.scale.y = keptFrac * histW
    histMark.position.x = histNow + histW * keptFrac
    compactedRun.setInt(e.compactedRevision)

    boardTermRun.setInt(maxTerm)
    watchRun.setInt(e.watchers)

    const dbFrac = clamp(e.dbSizeMib / (e.dbQuotaMib > 0 ? e.dbQuotaMib : 1), 0, 1)
    dbFill.scale.y = dbFrac * dbTrackLen
    dbFill.material = e.alarm !== 'none' ? M.failed : dbFrac > 0.8 ? M.pending : M.etcd
    dbSizeRun.setInt(Math.round(e.dbSizeMib))
    dbSizeRun.setColor(e.alarm !== 'none' ? COLOR.failed : dbFrac > 0.8 ? COLOR.pending : COLOR.etcd)
    dbQuotaRun.setInt(Math.round(e.dbQuotaMib))

    wpsRun.setFixed(e.writesPerSec, 1)
    readRun.setFixed(e.readLatencyMs, 1)
    readRun.setColor(e.readLatencyMs > 100 ? COLOR.failed : e.readLatencyMs > 25 ? COLOR.pending : COLOR.raft)

    alarmPlate.visible = e.alarm !== 'none'
    alarmRun.setString(e.alarm === 'NOSPACE' ? TXT_NOSPACE : e.alarm === 'CORRUPT' ? TXT_CORRUPT : TXT_BLANK)
    stallPlate.visible = stalled
    stallRun.setString(stalled ? TXT_STALL : TXT_BLANK)

    /* The whole vault reads stalled when the majority is gone. */
    plinthRim.material = stalled ? M.failedDim : M.etcdDim
    railRim.material = stalled ? M.failedDim : M.raftDim
    boardTrim.material = stalled ? M.failedDim : M.etcdDim

    text.flush()
  }

  function dispose(): void {
    offTheme()
    packets.dispose()
    beats.dispose()
    votes.dispose()
    for (let i = 0; i < owned.length; i++) owned[i].dispose()
    owned.length = 0
    text.dispose()
  }

  return { group, update, dispose }
}

