import * as THREE from 'three'

import type { Bus } from '../core/bus'
import { registry } from '../core/registry'
import type { DistrictId, Explainer } from '../core/types'
import { N_NODES } from '../core/types'
import { approach, clamp } from '../core/util'
import { ANCHOR, CITY, DISTRICTS, inPit, nodeBounds } from '../world/layout'
import type { DistrictBounds } from '../world/layout'
import type { Gfx } from './renderer'

/* ============================================================================
 * One camera, three ways to drive it, no cut between them.
 *
 * Every mode writes the same four numbers — a target point, a distance back
 * from it, a yaw and a pitch — and the camera position is always
 * `target - forward(yaw, pitch) * distance`. Orbit keeps distance positive and
 * the target on the ground; fly and walk set distance to zero, which makes the
 * target the eye itself. Switching modes only reinterprets those numbers, so
 * the camera never jumps: orbit -> fly keeps the position and zeroes the
 * distance; fly -> orbit pushes the target out along the view ray by the same
 * distance it gives back. That is the whole trick behind "fly in, land, walk".
 *
 * Nothing here allocates per frame. Scratch vectors are module scope, the key
 * set is reused, and pointer state lives in fixed slots.
 * ==========================================================================*/

export type CameraMode = 'orbit' | 'fly' | 'walk'

export interface CameraRig {
  mode: CameraMode
  setMode(m: CameraMode): void
  update(dt: number): void
  focusObject(o: THREE.Object3D, padding?: number): void
  focusPoint(p: THREE.Vector3, distance?: number): void
  home(): void
  overview(): void
  dispose(): void
}

/* ---------------------------------------------------------------------------
 * Pure geometry and scaling. Exported beyond the rig interface only so the
 * tests can pin the formulas; nothing else should import them.
 * -------------------------------------------------------------------------*/

/** 89 degrees. Straight up or down would make yaw meaningless and gimbal-flip. */
export const PITCH_LIMIT = (89 * Math.PI) / 180
/** Orbit must stay above what it is looking at, or the city turns inside out. */
export const ORBIT_MAX_PITCH = (-3 * Math.PI) / 180

/**
 * Distance at which a sphere of `radius` fits the frustum on both axes.
 * The binding constraint is the *narrower* half-angle: on a wide window that is
 * the vertical one, on a tall phone the horizontal one.
 */
export function framingDistance(
  radius: number,
  fovDeg: number,
  aspect: number,
  padding = 1.35,
): number {
  const r = Math.max(radius, 0.001)
  const halfV = (Math.max(fovDeg, 1) * Math.PI) / 360
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.01))
  return (r / Math.sin(Math.min(halfV, halfH))) * Math.max(padding, 0.01)
}

/** Reference height at which fly speed equals the user's chosen base speed. */
const SPEED_REF_HEIGHT = 45
const SPEED_MIN_SCALE = 0.35
const SPEED_MAX_SCALE = 14
const SPEED_BOOST = 5
const SPEED_PRECISE = 0.15

/**
 * Flying at 400 m needs metres per frame; inspecting a container at 3 m needs
 * centimetres. Speed therefore scales with height above the ground under the
 * camera, clamped at both ends so it never stalls and never runs away.
 */
export function moveSpeed(
  base: number,
  heightAboveGround: number,
  boost: boolean,
  precise: boolean,
): number {
  const scale = clamp(Math.max(heightAboveGround, 0) / SPEED_REF_HEIGHT, SPEED_MIN_SCALE, SPEED_MAX_SCALE)
  return base * scale * (boost ? SPEED_BOOST : 1) * (precise ? SPEED_PRECISE : 1)
}

/** Pitch limits differ by mode: orbit may not pass under its own target. */
export function clampPitch(pitch: number, mode: CameraMode): number {
  if (mode === 'orbit') return clamp(pitch, -PITCH_LIMIT, ORBIT_MAX_PITCH)
  return clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT)
}

/* ---------------------------------------------------------------------------
 * The walkable surface. Only the shapes a person can stand on or fall off.
 * -------------------------------------------------------------------------*/

const MESA_HX = CITY.mesa.w / 2
const MESA_HZ = CITY.mesa.d / 2

const NODE_MIN_X = new Float64Array(N_NODES)
const NODE_MAX_X = new Float64Array(N_NODES)
let NODE_MIN_Z = 0
let NODE_MAX_Z = 0
for (let i = 0; i < N_NODES; i++) {
  const b = nodeBounds(i)
  NODE_MIN_X[i] = b.minX
  NODE_MAX_X[i] = b.maxX
  NODE_MIN_Z = b.minZ
  NODE_MAX_Z = b.maxZ
}

/**
 * Height of the surface under a point. The excavation is tested first because
 * it is cut *into* the control-plane mesa and must win in the overlap.
 */
function groundHeightAt(x: number, z: number): number {
  if (inPit(x, z)) return CITY.pit.floorY
  if (Math.abs(x) <= MESA_HX && Math.abs(z - CITY.mesa.z) <= MESA_HZ) return CITY.mesa.top
  if (z >= NODE_MIN_Z && z <= NODE_MAX_Z) {
    for (let i = 0; i < N_NODES; i++) {
      if (x >= NODE_MIN_X[i]! && x <= NODE_MAX_X[i]!) return CITY.node.top
    }
  }
  return 0
}

/* ---------------------------------------------------------------------------
 * Tuning.
 * -------------------------------------------------------------------------*/

const FOV = { orbit: 48, fly: 62, walk: 70 } as const

/* 3 let the camera inside its own geometry. The reference stops at 24 and that
 * is the right instinct: closer than this there is nothing to understand. */
const MIN_DIST = 24
const MAX_DIST = 2600
/* Closest a selection may pull the camera. Below this the surroundings leave
 * the frame and the reader loses the thread of where they are. */
const MIN_FOCUS_DIST = 58
/* Furthest a selection may push it. registry.resolve() walks UP the scene graph
 * to find what a mesh explains, so clicking a small part often resolves to its
 * whole district; framing that group by its bounding sphere threw the camera
 * hundreds of metres out and collapsed the city to a smudge. */
const MAX_FOCUS_DIST = 560
/* An orbit pivot is a point of interest and must stay over the city. An eye is
 * not: at full zoom-out the orbit camera itself already sits TARGET_LIMIT +
 * MAX_DIST away, so the free-flight bounds have to contain that or switching
 * out of orbit would yank the camera hundreds of metres. */
const TARGET_LIMIT = CITY.ground * 0.55
const TARGET_CEILING = 1600
const EYE_LIMIT = TARGET_LIMIT + MAX_DIST
const EYE_CEILING = TARGET_CEILING + MAX_DIST
const FLOOR = CITY.pit.floorY - 20

const DRAG_ROT_PER_PX = 0.0042
const LOOK_PER_PX = 0.0022
const TOUCH_TILT_PER_PX = 0.004

const EASE_TARGET = { orbit: 15, fly: 14, walk: 0 } as const
const EASE_ROT = { orbit: 18, fly: 24, walk: 30 } as const

/*
 * Rotation is 1:1 with the hand, and then it coasts.
 *
 * Easing the angles toward a goal put a lag between the pointer and the
 * picture, and stopping dead on release left no follow-through, so the camera
 * managed to feel mushy and lifeless at the same time. Only quantities that are
 * NOT 1:1 — distance and the pivot — stay smoothed.
 *
 * Decay is per second; at 13 a flick settles in about a quarter of a second.
 */
const SPIN_DECAY = 13
/** How fast the velocity estimator chases the hand while dragging. */
const VEL_TRACK = 26
/** Below this the coast is over; snapping to zero stops endless tiny updates. */
const SPIN_DEAD = 1e-4
/** Squared speed below which a pan coast has finished. */
const PAN_DEAD = 1e-4
const EASE_DIST = 13
const EASE_FOCUS = 3.2
const EASE_FOV = 7

const ORBIT_LIFT_RATE = 0.55
const ORBIT_PAN_RATE = 0.55

const FLY_BASE_DEFAULT = 26
const FLY_BASE_MIN = 1.5
const FLY_BASE_MAX = 400
const FLY_ACCEL = 11

const EYE_STAND = 1.75
const EYE_CROUCH = 1.05
const WALK_SPEED = 5.5
const WALK_RUN = 2.6
const WALK_CROUCH = 0.45
const WALK_ACCEL = 16
const GRAVITY = 22
const JUMP_SPEED = 7
const TERMINAL_SPEED = 60
/** A kerb you can step over, and a drop you would take without a stretcher. */
const STEP_UP = 0.75
const STEP_DOWN = 4.5

/* The establishing shot: south of the city centre, looking north, so the node
 * blocks are in the foreground and the control plane sits behind them exactly
 * as the city plan is drawn. */
/* The city spans roughly 900 units across and 960 deep. At 620 the frame cut
 * off the outer districts, which left a first-time visitor with no idea what
 * they were looking at or which way to drag; the establishing shot has to
 * establish. */
const HOME_DIST = 1180
const HOME_PITCH = -0.6

/* The overview frames the teaching core — control-plane mesa through the node
 * grid — not the outlying yards, which are only reachable by name anyway. */
const CORE_MIN_Z = CITY.mesa.z - CITY.mesa.d / 2
const CORE_MAX_Z = CITY.node.z + CITY.node.d / 2
const CORE_Z = (CORE_MIN_Z + CORE_MAX_Z) / 2
const CORE_HZ = (CORE_MAX_Z - CORE_MIN_Z) / 2
const CORE_HX = (N_NODES * CITY.node.pitch) / 2

/* ---------------------------------------------------------------------------
 * Scratch. Never allocate below this line.
 * -------------------------------------------------------------------------*/

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _upv = new THREE.Vector3()
const _box = new THREE.Box3()
const _sphere = new THREE.Sphere()
const _frustum = new THREE.Frustum()
const _pm = new THREE.Matrix4()

/**
 * How much of the viewport's height a thing has to cover before selecting it
 * is allowed to leave the camera where it is.
 *
 * Below this it is a speck and the reader needs to be taken to it; above it
 * they are already looking at the thing they clicked, and moving would throw
 * away the view they built. Roughly a fifteenth of the screen — enough to see
 * a pod's lot, not enough to read the writing on it.
 */
const READABLE_FRACTION = 0.07
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

interface Pose {
  target: THREE.Vector3
  dist: number
  yaw: number
  pitch: number
}

function forwardFrom(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const cp = Math.cos(pitch)
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
}

function rightFrom(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw))
}

function posFromPose(p: Pose, out: THREE.Vector3): THREE.Vector3 {
  forwardFrom(p.yaw, p.pitch, out)
  return out.multiplyScalar(-p.dist).add(p.target)
}

interface PointerSlot {
  id: number
  active: boolean
  touch: boolean
  x: number
  y: number
  button: number
}

export function createCameraRig(gfx: Gfx, dom: HTMLElement, bus: Bus): CameraRig {
  const camera = gfx.camera

  let mode: CameraMode = 'orbit'

  const cur: Pose = { target: new THREE.Vector3(0, 10, -40), dist: HOME_DIST, yaw: 0, pitch: HOME_PITCH }
  const goal: Pose = { target: cur.target.clone(), dist: cur.dist, yaw: cur.yaw, pitch: cur.pitch }

  const vel = new THREE.Vector3()
  let flyBase = FLY_BASE_DEFAULT

  let eye = EYE_STAND
  let vy = 0
  let grounded = false
  /** Entering walk from altitude eases down instead of free-falling 300 m. */
  let landing = false

  /** Distance to restore when returning to orbit from fly or walk. */
  let lastOrbitDist = HOME_DIST

  let focusActive = false
  let disposed = false

  const keys = new Set<string>()
  let overlayOpen = false

  const pointers: PointerSlot[] = []
  for (let i = 0; i < 4; i++) {
    pointers.push({ id: -1, active: false, touch: false, x: 0, y: 0, button: 0 })
  }
  let pointerCount = 0

  type Drag = 'none' | 'pan' | 'orbit' | 'look'
  let drag: Drag = 'none'
  let lastX = 0
  let lastY = 0
  const grab = new THREE.Vector3()
  let grabPlaneY = 0
  let grabValid = false

  /* Two-finger gesture memory. */
  let gestureDist = 0
  let gestureAngle = 0
  let gestureCy = 0
  let gestureActive = false

  let locked = false

  /* ------------------------------------------------------------------------
   * Pose plumbing.
   * ----------------------------------------------------------------------*/

  function applyPose(): void {
    posFromPose(cur, _v)
    camera.position.copy(_v)
    _euler.set(cur.pitch, cur.yaw, 0, 'YXZ')
    camera.quaternion.setFromEuler(_euler)
  }

  /** Sync the camera now, so a pointer handler can raycast against this frame. */
  function syncCamera(): void {
    applyPose()
    camera.updateMatrixWorld(true)
  }

  function clampTarget(p: THREE.Vector3): void {
    const lim = mode === 'orbit' ? TARGET_LIMIT : EYE_LIMIT
    const top = mode === 'orbit' ? TARGET_CEILING : EYE_CEILING
    p.x = clamp(p.x, -lim, lim)
    p.z = clamp(p.z, -lim, lim)
    p.y = clamp(p.y, FLOOR, top)
  }

  /*
   * Hand the camera back with zero snap.
   *
   * Clearing the flag alone left `goal` sitting on the focus destination, so
   * the ordinary easing carried on flying there after the user had already
   * grabbed the camera — the camera visibly fighting the hand. Adopting the
   * live pose as the new intent makes taking control a pure mode flip: nothing
   * to finish, nothing to snap back from, and any inertia from the flight is
   * dropped rather than inherited.
   */
  function cancelFocus(): void {
    if (!focusActive) return
    focusActive = false
    goal.target.copy(cur.target)
    goal.dist = cur.dist
    goal.yaw = cur.yaw
    goal.pitch = cur.pitch
    velYaw = 0
    velPitch = 0
    panVel.set(0, 0, 0)
    pannedDelta.set(0, 0, 0)
    spunYaw = 0
    spunPitch = 0
  }

  /* ------------------------------------------------------------------------
   * Screen to world. NDC in, a point on a horizontal plane out.
   * ----------------------------------------------------------------------*/

  function ndcX(clientX: number): number {
    const rect = dom.getBoundingClientRect()
    return ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
  }

  function ndcY(clientY: number): number {
    const rect = dom.getBoundingClientRect()
    return -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
  }

  function rayToPlane(nx: number, ny: number, planeY: number, out: THREE.Vector3): boolean {
    out.set(nx, ny, 0.5).unproject(camera)
    out.sub(camera.position)
    if (Math.abs(out.y) < 1e-6) return false
    const t = (planeY - camera.position.y) / out.y
    if (!(t > 0) || !Number.isFinite(t)) return false
    out.multiplyScalar(t).add(camera.position)
    return true
  }

  /* ------------------------------------------------------------------------
   * Modes.
   * ----------------------------------------------------------------------*/

  function enterOrbit(): void {
    syncCamera()
    posFromPose(cur, _v)
    let d = lastOrbitDist
    /* Pivot around whatever was under the crosshair, so the switch reads as
     * "put that down on the table" rather than "teleport". */
    if (rayToPlane(0, 0, 0, _v2)) {
      const hit = _v2.distanceTo(_v)
      if (hit > MIN_DIST && hit < MAX_DIST) d = hit
    }
    d = clamp(d, MIN_DIST, MAX_DIST)
    forwardFrom(cur.yaw, cur.pitch, _fwd)
    cur.dist = d
    cur.target.copy(_v).addScaledVector(_fwd, d)
    goal.target.copy(cur.target)
    goal.dist = d
    goal.yaw = cur.yaw
    /* Only the goal is bounded — pitch into orbit's range, target into the city.
     * `cur` eases into both, so a camera that was looking at the sky tilts down
     * instead of snapping, and the eye never teleports at the switch. */
    goal.pitch = clampPitch(cur.pitch, 'orbit')
    clampTarget(goal.target)
    vel.set(0, 0, 0)
  }

  function enterFree(next: 'fly' | 'walk'): void {
    posFromPose(cur, _v)
    if (mode === 'orbit') lastOrbitDist = cur.dist
    cur.target.copy(_v)
    cur.dist = 0
    goal.target.copy(_v)
    goal.dist = 0
    goal.yaw = cur.yaw
    goal.pitch = cur.pitch
    vel.set(0, 0, 0)
    if (next === 'walk') {
      vy = 0
      grounded = false
      landing = true
    }
  }

  function setMode(m: CameraMode): void {
    if (m === mode || disposed) return
    cancelFocus()
    if (m === 'orbit') {
      enterOrbit()
      mode = 'orbit'
      exitPointerLock()
    } else {
      enterFree(m)
      mode = m
    }
  }

  /* ------------------------------------------------------------------------
   * Framing.
   * ----------------------------------------------------------------------*/

  /** Put the eye at one point looking at another, in whichever mode is live. */
  function placeCamera(
    px: number,
    py: number,
    pz: number,
    lx: number,
    ly: number,
    lz: number,
  ): void {
    _v2.set(px - lx, py - ly, pz - lz)
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0.5, 1)
    const dist = clamp(_v2.length(), MIN_DIST, MAX_DIST)
    _v2.normalize()

    goal.yaw = Math.atan2(_v2.x, _v2.z)
    goal.pitch = clampPitch(Math.asin(-clamp(_v2.y, -1, 1)), mode)

    if (mode === 'orbit') {
      goal.target.set(lx, ly, lz)
      goal.dist = dist
      lastOrbitDist = dist
    } else {
      goal.target.set(lx, ly, lz).addScaledVector(_v2, dist)
      goal.dist = 0
      landing = false
    }
    clampTarget(goal.target)
    focusActive = true
  }

  /** Frame a point from `dist` away, keeping the direction we are already at. */
  function frameAt(cx: number, cy: number, cz: number, dist: number): void {
    if (mode === 'walk') setMode('orbit')
    posFromPose(cur, _v)
    _v2.set(_v.x - cx, _v.y - cy, _v.z - cz)
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0.55, 1)
    _v2.normalize()
    /*
     * Never approach from below grade, and never from nearly level with it
     * either. At the old floor of 0.22 the camera sat about thirteen degrees
     * above the horizon, which put it on the deck looking down a road to the
     * vanishing point with the selected thing lost in it. A third of the way up
     * gives the three-quarter view the city is drawn to be read from.
     */
    if (_v2.y < 0.55) {
      _v2.y = 0.55
      _v2.normalize()
    }
    const d = clamp(dist, MIN_DIST, MAX_DIST)
    placeCamera(cx + _v2.x * d, cy + _v2.y * d, cz + _v2.z * d, cx, cy, cz)
  }

  function focusObject(o: THREE.Object3D, padding = 1.35): void {
    /* No building can be framed from eye height; leave walk before measuring so
     * the field of view used for the framing distance is the one we land in. */
    if (mode === 'walk') setMode('orbit')
    o.updateWorldMatrix(true, false)
    _box.setFromObject(o)
    let cx: number
    let cy: number
    let cz: number
    let radius: number
    if (_box.isEmpty()) {
      o.getWorldPosition(_v)
      cx = _v.x
      cy = _v.y
      cz = _v.z
      radius = 8
    } else {
      _box.getBoundingSphere(_sphere)
      cx = _sphere.center.x
      cy = _sphere.center.y
      cz = _sphere.center.z
      radius = Math.max(_sphere.radius, 2)
    }
    /*
     * Framing a two-metre object by its own radius alone puts the camera a few
     * metres from it — inside the city, with nothing recognisable in frame.
     * Selecting a pause container should move you close enough to read it and
     * no closer than you can still tell which node you are standing on.
     */
    /*
     * Selecting something you are already looking at must not move the camera.
     *
     * Home is 1180 metres out and the closest a focus may land is 58, so one
     * click could throw the reader twenty times closer in a single move — into
     * a gap between buildings, with every landmark they had been navigating by
     * out of frame. That is the whole of "you click and end up somewhere
     * unrecognisable", and it fired even when the thing clicked was already
     * large and centred, which is the most common case of all: you look at a
     * node, you click that node.
     *
     * So the flight is for fetching something you cannot see. If it is on
     * screen and big enough to look at, the view the reader built stands.
     */
    if (isReadable(cx, cy, cz, radius)) return
    const fitted = framingDistance(radius, FOV[mode], camera.aspect, padding)
    frameAt(cx, cy, cz, clamp(fitted, MIN_FOCUS_DIST, MAX_FOCUS_DIST))
  }

  /** On screen, and covering enough of it to be worth looking at from here. */
  function isReadable(cx: number, cy: number, cz: number, radius: number): boolean {
    /* A flight already under way is the reader being taken somewhere; judging
     * against the pose it is passing through would strand them mid-air. */
    if (focusActive) return false
    camera.updateMatrixWorld()
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_pm)
    _v.set(cx, cy, cz)
    if (!_frustum.containsPoint(_v)) return false
    const dist = camera.position.distanceTo(_v)
    if (dist <= radius) return false
    const fov = (camera.fov * Math.PI) / 180
    return (2 * Math.atan(radius / dist)) / fov >= READABLE_FRACTION
  }

  function focusPoint(p: THREE.Vector3, distance?: number): void {
    const d = distance !== undefined ? distance : Math.max(cur.dist, 90)
    frameAt(p.x, p.y, p.z, d)
  }

  function focusDistrict(d: DistrictBounds): void {
    if (mode === 'walk') setMode('orbit')
    const radius = Math.hypot(d.hx, d.hz)
    frameAt(
      d.center[0],
      d.center[1],
      d.center[2],
      framingDistance(radius, FOV[mode], camera.aspect, 1.25),
    )
  }

  function districtById(id: DistrictId): DistrictBounds | undefined {
    for (let i = 0; i < DISTRICTS.length; i++) {
      if (DISTRICTS[i]!.id === id) return DISTRICTS[i]
    }
    return undefined
  }

  function home(): void {
    if (mode !== 'orbit') setMode('orbit')
    goal.target.set(ANCHOR.cityCenter[0], ANCHOR.cityCenter[1], ANCHOR.cityCenter[2])
    goal.dist = HOME_DIST
    goal.yaw = 0
    goal.pitch = HOME_PITCH
    lastOrbitDist = HOME_DIST
    focusActive = true
  }

  function overview(): void {
    if (mode !== 'orbit') setMode('orbit')
    const halfV = (FOV.orbit * Math.PI) / 360
    const t = Math.tan(halfV)
    const dist = Math.max(CORE_HZ / t, CORE_HX / (t * Math.max(camera.aspect, 0.01))) * 1.06
    goal.target.set(0, 0, CORE_Z)
    goal.dist = clamp(dist, MIN_DIST, MAX_DIST)
    /* Yaw 0 with the camera straight down puts north at the top of the screen,
     * which is how the city plan is drawn. */
    goal.yaw = 0
    goal.pitch = -PITCH_LIMIT
    lastOrbitDist = goal.dist
    focusActive = true
  }

  /* ------------------------------------------------------------------------
   * Input state helpers.
   * ----------------------------------------------------------------------*/

  const held = (code: string): boolean => keys.has(code)
  const boost = (): boolean => held('ShiftLeft') || held('ShiftRight')
  const precise = (): boolean => held('AltLeft') || held('AltRight')
  const axis = (neg: boolean, pos: boolean): number => (pos ? 1 : 0) - (neg ? 1 : 0)
  const inputForward = (): number =>
    axis(held('KeyS') || held('ArrowDown'), held('KeyW') || held('ArrowUp'))
  const inputRight = (): number =>
    axis(held('KeyA') || held('ArrowLeft'), held('KeyD') || held('ArrowRight'))

  /* ------------------------------------------------------------------------
   * Per-mode motion.
   * ----------------------------------------------------------------------*/

  function updateOrbit(dt: number): void {
    const lift = axis(held('PageDown'), held('PageUp'))
    if (lift !== 0) {
      cancelFocus()
      goal.target.y += lift * ORBIT_LIFT_RATE * goal.dist * dt
    }
    const f = inputForward()
    const r = inputRight()
    if (f !== 0 || r !== 0) {
      cancelFocus()
      const sp = goal.dist * ORBIT_PAN_RATE * (boost() ? 3 : 1) * (precise() ? 0.25 : 1) * dt
      const sy = Math.sin(cur.yaw)
      const cy = Math.cos(cur.yaw)
      goal.target.x += (-sy * f + cy * r) * sp
      goal.target.z += (-cy * f - sy * r) * sp
    }
    clampTarget(goal.target)
  }

  function updateFly(dt: number): void {
    const f = inputForward()
    const r = inputRight()
    const u = axis(held('KeyC') || held('KeyQ'), held('Space') || held('KeyE'))

    _v.set(0, 0, 0)
    if (f !== 0 || r !== 0 || u !== 0) {
      cancelFocus()
      forwardFrom(cur.yaw, cur.pitch, _fwd)
      rightFrom(cur.yaw, _right)
      _v.addScaledVector(_fwd, f).addScaledVector(_right, r)
      _v.y += u
      if (_v.lengthSq() > 1e-8) {
        const height = goal.target.y - groundHeightAt(goal.target.x, goal.target.z)
        _v.normalize().multiplyScalar(moveSpeed(flyBase, height, boost(), precise()))
      }
    }

    vel.x = approach(vel.x, _v.x, FLY_ACCEL, dt)
    vel.y = approach(vel.y, _v.y, FLY_ACCEL, dt)
    vel.z = approach(vel.z, _v.z, FLY_ACCEL, dt)
    goal.target.addScaledVector(vel, dt)
    clampTarget(goal.target)
  }

  /** Step-up and drop limits are the whole collision model. */
  function canStand(fromY: number, x: number, z: number): boolean {
    const h = groundHeightAt(x, z)
    if (h - fromY > STEP_UP) return false
    if (fromY - h > STEP_DOWN) return false
    return true
  }

  function updateWalk(dt: number): void {
    const crouching = held('KeyC') || held('ControlLeft') || held('ControlRight')
    eye = approach(eye, crouching ? EYE_CROUCH : EYE_STAND, 12, dt)

    const f = inputForward()
    const r = inputRight()
    _v.set(0, 0, 0)
    if (f !== 0 || r !== 0) {
      cancelFocus()
      const sy = Math.sin(cur.yaw)
      const cy = Math.cos(cur.yaw)
      /* Pitch is deliberately ignored: looking up must not launch you. */
      _v.set(-sy * f + cy * r, 0, -cy * f - sy * r)
      const sp =
        WALK_SPEED * (boost() ? WALK_RUN : 1) * (crouching ? WALK_CROUCH : 1) * (precise() ? 0.4 : 1)
      _v.normalize().multiplyScalar(sp)
    }
    vel.x = approach(vel.x, _v.x, WALK_ACCEL, dt)
    vel.z = approach(vel.z, _v.z, WALK_ACCEL, dt)

    const p = goal.target
    const standing = groundHeightAt(p.x, p.z)
    const nx = p.x + vel.x * dt
    const nz = p.z + vel.z * dt
    if (canStand(standing, nx, nz)) {
      p.x = nx
      p.z = nz
    } else if (canStand(standing, nx, p.z)) {
      p.x = nx
      vel.z = 0
    } else if (canStand(standing, p.x, nz)) {
      p.z = nz
      vel.x = 0
    } else {
      vel.x = 0
      vel.z = 0
    }

    const floorY = groundHeightAt(p.x, p.z) + eye

    if (landing) {
      p.y = approach(p.y, floorY, 3.2, dt)
      if (Math.abs(p.y - floorY) < 0.05) {
        p.y = floorY
        vy = 0
        grounded = true
        landing = false
      }
    } else {
      if (grounded && held('Space')) {
        cancelFocus()
        vy = JUMP_SPEED
        grounded = false
      }
      vy = Math.max(vy - GRAVITY * dt, -TERMINAL_SPEED)
      p.y += vy * dt
      if (p.y <= floorY) {
        p.y = floorY
        vy = 0
        grounded = true
      } else {
        grounded = false
      }
    }
    clampTarget(p)
  }

  /* ------------------------------------------------------------------------
   * The frame.
   * ----------------------------------------------------------------------*/

  function update(dt: number): void {
    if (disposed) return
    const step = dt > 0 ? Math.min(dt, 1 / 15) : 0

    if (!overlayOpen && step > 0) {
      if (mode === 'orbit') updateOrbit(step)
      else if (mode === 'fly') updateFly(step)
      else updateWalk(step)
    }

    const rate = focusActive ? EASE_FOCUS : EASE_TARGET[mode]
    if (rate <= 0) {
      cur.target.copy(goal.target)
    } else {
      cur.target.x = approach(cur.target.x, goal.target.x, rate, step)
      cur.target.y = approach(cur.target.y, goal.target.y, rate, step)
      cur.target.z = approach(cur.target.z, goal.target.z, rate, step)
    }
    cur.dist = approach(cur.dist, goal.dist, focusActive ? EASE_FOCUS : EASE_DIST, step)

    if (focusActive) {
      /* A scripted flight owns the angles; the hand does not fight it. */
      cur.yaw = approach(cur.yaw, goal.yaw, EASE_FOCUS, step)
      cur.pitch = approach(cur.pitch, goal.pitch, EASE_FOCUS, step)
      velYaw = 0
      velPitch = 0
      spunYaw = 0
      spunPitch = 0
    } else {
      const rotating = drag === 'orbit' || drag === 'look'
      if (rotating) {
        const inv = 1 / Math.max(step, 1e-4)
        velYaw = approach(velYaw, spunYaw * inv, VEL_TRACK, step)
        velPitch = approach(velPitch, spunPitch * inv, VEL_TRACK, step)
      } else if (velYaw !== 0 || velPitch !== 0) {
        goal.yaw += velYaw * step
        goal.pitch = clampPitch(goal.pitch + velPitch * step, mode)
        velYaw = approach(velYaw, 0, SPIN_DECAY, step)
        velPitch = approach(velPitch, 0, SPIN_DECAY, step)
        if (velYaw < SPIN_DEAD && velYaw > -SPIN_DEAD) velYaw = 0
        if (velPitch < SPIN_DEAD && velPitch > -SPIN_DEAD) velPitch = 0
      }
      spunYaw = 0
      spunPitch = 0
      /* 1:1. The angles are the hand's, not a target to chase. */
      cur.yaw = goal.yaw
      cur.pitch = goal.pitch

      /* The same treatment for the grabbed ground: exact under the hand, and
       * it keeps sliding for a moment once the hand lets go. */
      if (drag === 'pan') {
        const inv = 1 / Math.max(step, 1e-4)
        _v.copy(pannedDelta).multiplyScalar(inv)
        panVel.x = approach(panVel.x, _v.x, VEL_TRACK, step)
        panVel.y = approach(panVel.y, _v.y, VEL_TRACK, step)
        panVel.z = approach(panVel.z, _v.z, VEL_TRACK, step)
      } else if (panVel.lengthSq() > PAN_DEAD) {
        goal.target.addScaledVector(panVel, step)
        clampTarget(goal.target)
        cur.target.copy(goal.target)
        panVel.multiplyScalar(Math.exp(-SPIN_DECAY * step))
      } else if (panVel.lengthSq() !== 0) {
        panVel.set(0, 0, 0)
      }
      pannedDelta.set(0, 0, 0)
    }

    /* Yaw accumulates without bound under pointer lock; fold both copies at
     * once so easing never sees a discontinuity. */
    if (cur.yaw > Math.PI * 4 || cur.yaw < -Math.PI * 4) {
      const turns = Math.round(cur.yaw / (Math.PI * 2)) * Math.PI * 2
      cur.yaw -= turns
      goal.yaw -= turns
    }

    if (focusActive) {
      const dx = cur.target.x - goal.target.x
      const dy = cur.target.y - goal.target.y
      const dz = cur.target.z - goal.target.z
      if (dx * dx + dy * dy + dz * dz < 0.25 && Math.abs(cur.dist - goal.dist) < 0.5) {
        focusActive = false
      }
    }

    const wantFov = FOV[mode]
    if (Math.abs(camera.fov - wantFov) > 0.005) {
      const next = approach(camera.fov, wantFov, EASE_FOV, step)
      camera.fov = Math.abs(next - wantFov) < 0.02 ? wantFov : next
      camera.updateProjectionMatrix()
    }

    applyPose()
  }

  /* ------------------------------------------------------------------------
   * Pointer lock.
   * ----------------------------------------------------------------------*/

  function requestPointerLock(): void {
    if (locked || overlayOpen) return
    try {
      void Promise.resolve(dom.requestPointerLock()).catch(() => {
        /* Denied (no user gesture, or iframe policy): drag-look still works. */
      })
    } catch {
      /* Older browsers: ignore and fall back to drag-look. */
    }
  }

  function exitPointerLock(): void {
    if (typeof document === 'undefined') return
    if (document.pointerLockElement === dom) document.exitPointerLock()
  }

  const onPointerLockChange = (): void => {
    locked = typeof document !== 'undefined' && document.pointerLockElement === dom
    /* Leaving the lock with the button still down would otherwise resume
     * drag-look from a pointer position hundreds of pixels stale. */
    if (!locked) drag = 'none'
  }

  /* ------------------------------------------------------------------------
   * Pointer and touch.
   * ----------------------------------------------------------------------*/

  function slotFor(id: number): PointerSlot | undefined {
    for (let i = 0; i < pointers.length; i++) if (pointers[i]!.id === id) return pointers[i]
    return undefined
  }

  function freeSlot(): PointerSlot | undefined {
    for (let i = 0; i < pointers.length; i++) if (!pointers[i]!.active) return pointers[i]
    return undefined
  }

  /** Events that started on an overlay belong to the overlay. */
  function isSceneTarget(e: Event): boolean {
    const t = e.target
    return t === dom || t === document.body || t === document.documentElement
  }

  function beginGroundGrab(clientX: number, clientY: number): void {
    syncCamera()
    grabPlaneY = cur.target.y
    grabValid = rayToPlane(ndcX(clientX), ndcY(clientY), grabPlaneY, grab)
  }

  /**
   * Pan: 1:1 in the camera's own plane.
   *
   * This used to grab the ground — intersect the cursor ray with a horizontal
   * plane and keep the grabbed point under the cursor. That reads well from
   * straight above and badly from anywhere else: at a shallow angle a small
   * vertical drag sweeps the intersection across half the city, and moving the
   * mouse down means "travel forward over the terrain" rather than "move the
   * picture down". The result was a pan whose gain depended on where you were
   * looking, which is what makes it feel like the perspective is fighting you.
   *
   * Moving the pivot along the camera's own right and up vectors, scaled by
   * world units per pixel at the pivot's distance, makes the image track the
   * hand exactly at every angle — the way dragging a photograph does.
   */
  function dragPan(dx: number, dy: number): void {
    _panBefore.copy(goal.target)
    syncCamera()
    const h = Math.max(1, dom.getBoundingClientRect().height)
    const wpp = (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(cur.dist, 1)) / h
    _right.setFromMatrixColumn(camera.matrixWorld, 0)
    _upv.setFromMatrixColumn(camera.matrixWorld, 1)
    _v.set(0, 0, 0)
    _v.addScaledVector(_right, -dx * wpp)
    _v.addScaledVector(_upv, dy * wpp)
    goal.target.add(_v)
    clampTarget(goal.target)
    /* Panning is exact, never eased: the grabbed point must not drift. */
    cur.target.copy(goal.target)
    /* What the clamp allowed, so a pan into the world bounds builds no coast. */
    pannedDelta.add(goal.target).sub(_panBefore)
  }

  /** Pivot velocity carried after the pointer lets go, in units a second. */
  const panVel = new THREE.Vector3()
  const pannedDelta = new THREE.Vector3()
  const _panBefore = new THREE.Vector3()

  /** Angular velocity carried after the pointer lets go, in radians a second. */
  let velYaw = 0
  let velPitch = 0
  /** Rotation applied since the last frame, used to estimate that velocity. */
  let spunYaw = 0
  let spunPitch = 0

  function dragRotate(dx: number, dy: number): void {
    const dYaw = -dx * DRAG_ROT_PER_PX
    const before = goal.pitch
    goal.yaw += dYaw
    goal.pitch = clampPitch(goal.pitch - dy * DRAG_ROT_PER_PX, mode)
    spunYaw += dYaw
    /* Measure what the clamp actually allowed, or a drag into the pitch limit
     * would launch a coast the picture never made. */
    spunPitch += goal.pitch - before
  }

  function updateGesture(a: PointerSlot, b: PointerSlot): void {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const angle = Math.atan2(dy, dx)
    const cy = (a.y + b.y) / 2
    if (!gestureActive) {
      gestureDist = dist
      gestureAngle = angle
      gestureCy = cy
      gestureActive = true
      return
    }
    cancelFocus()

    /* Pinch. */
    if (gestureDist > 1 && dist > 1) {
      const ratio = gestureDist / dist
      if (mode === 'orbit') {
        goal.dist = clamp(goal.dist * ratio, MIN_DIST, MAX_DIST)
      } else {
        forwardFrom(cur.yaw, cur.pitch, _fwd)
        goal.target.addScaledVector(_fwd, (1 - ratio) * Math.max(20, flyBase))
        clampTarget(goal.target)
      }
    }

    /* Twist orbits. */
    let dA = angle - gestureAngle
    while (dA > Math.PI) dA -= Math.PI * 2
    while (dA < -Math.PI) dA += Math.PI * 2
    goal.yaw += dA

    /* Two-finger drag tilts. */
    goal.pitch = clampPitch(goal.pitch - (cy - gestureCy) * TOUCH_TILT_PER_PX, mode)

    gestureDist = dist
    gestureAngle = angle
    gestureCy = cy
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (overlayOpen || !isSceneTarget(e)) return
    const slot = slotFor(e.pointerId) ?? freeSlot()
    if (!slot) return
    if (!slot.active) pointerCount++
    slot.id = e.pointerId
    slot.active = true
    slot.touch = e.pointerType === 'touch'
    slot.x = e.clientX
    slot.y = e.clientY
    slot.button = e.button
    lastX = e.clientX
    lastY = e.clientY

    if (pointerCount >= 2) {
      drag = 'none'
      gestureActive = false
      return
    }

    cancelFocus()
    if (mode === 'orbit') {
      const rotating = !slot.touch && (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey))
      if (e.button === 1 || (e.button === 0 && !rotating)) {
        drag = 'pan'
        beginGroundGrab(e.clientX, e.clientY)
      } else if (rotating) {
        drag = 'orbit'
      }
    } else {
      if (!slot.touch && e.button === 0) requestPointerLock()
      drag = 'look'
    }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (locked) {
      if (overlayOpen) return
      cancelFocus()
      goal.yaw -= e.movementX * LOOK_PER_PX
      goal.pitch = clampPitch(goal.pitch - e.movementY * LOOK_PER_PX, mode)
      /* Mouse look under pointer lock is 1:1 and unsmoothed. Any lag between
       * hand and view reads as input latency, not as weight. */
      cur.yaw = goal.yaw
      cur.pitch = goal.pitch
      return
    }

    const slot = slotFor(e.pointerId)
    if (!slot || !slot.active) return
    slot.x = e.clientX
    slot.y = e.clientY

    if (pointerCount >= 2) {
      let a: PointerSlot | undefined
      let b: PointerSlot | undefined
      for (let i = 0; i < pointers.length; i++) {
        const s = pointers[i]!
        if (!s.active) continue
        if (!a) a = s
        else if (!b) b = s
      }
      if (a && b) updateGesture(a, b)
      lastX = e.clientX
      lastY = e.clientY
      return
    }

    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    /* Any drag takes the camera back, panning included: it used to leave a
     * focus flight running underneath and the two pulled against each other. */
    if (drag === 'pan') {
      cancelFocus()
      dragPan(dx, dy)
    } else if (drag === 'orbit' || drag === 'look') {
      cancelFocus()
      dragRotate(dx, dy)
    }
    lastX = e.clientX
    lastY = e.clientY
  }

  const onPointerUp = (e: PointerEvent): void => {
    const slot = slotFor(e.pointerId)
    if (slot && slot.active) {
      slot.active = false
      slot.id = -1
      pointerCount = Math.max(0, pointerCount - 1)
    }
    if (pointerCount < 2) gestureActive = false
    if (pointerCount === 0) {
      drag = 'none'
      grabValid = false
    }
  }

  const onWheel = (e: WheelEvent): void => {
    if (overlayOpen || !isSceneTarget(e)) return
    e.preventDefault()
    cancelFocus()
    /* deltaMode 1 is lines, 2 is pages; normalise so a trackpad and a mouse
     * wheel move the camera by comparable amounts. */
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1
    const delta = e.deltaY * unit

    if (mode === 'orbit') {
      const dOld = goal.dist
      const dNew = clamp(dOld * Math.exp(delta * 0.0011), MIN_DIST, MAX_DIST)
      if (dNew !== dOld) {
        syncCamera()
        /*
         * Dolly along the cursor ray, in world space.
         *
         * This used to intersect the cursor ray with the horizontal plane at
         * the pivot's height and scale the pivot about that point — which only
         * works while the ray meets that plane. Aim at a tower, at the sky, or
         * anywhere above the horizon and there is no intersection, so the zoom
         * silently degraded to changing the radius around a fixed pivot: a
         * model on a turntable rather than a city you move through.
         *
         * Holding the point under the cursor fixed while the distance changes
         * gives pivot' = pivot + (dOld - dNew) * (ray - view), with both
         * directions unit vectors from the camera. It needs no plane at all.
         */
        _v.set(ndcX(e.clientX), ndcY(e.clientY), 0.5).unproject(camera).sub(camera.position)
        if (_v.lengthSq() > 1e-8) {
          _v.normalize()
          _v2.set(0, 0, -1).applyQuaternion(camera.quaternion)
          _v.sub(_v2).multiplyScalar(dOld - dNew)
          /* One notch may not throw the pivot across the city. */
          const maxShift = dOld * 0.75
          if (_v.lengthSq() > maxShift * maxShift) _v.setLength(maxShift)
          goal.target.add(_v)
          clampTarget(goal.target)
        }
      }
      goal.dist = dNew
    } else if (mode === 'fly') {
      flyBase = clamp(flyBase * Math.exp(-delta * 0.0011), FLY_BASE_MIN, FLY_BASE_MAX)
    }
  }

  /* ------------------------------------------------------------------------
   * Keyboard.
   * ----------------------------------------------------------------------*/

  function typingTarget(): boolean {
    const el = document.activeElement
    if (!el || el === document.body) return false
    const tag = el.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (el as HTMLElement).isContentEditable === true
    )
  }

  const MOVEMENT_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space', 'PageUp', 'PageDown', 'Home',
  ])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (typingTarget()) return
    if (e.code === 'Escape') {
      exitPointerLock()
      return
    }
    if (overlayOpen) return

    /* Recorded before the modifier bail-out, because Control is itself a bound
     * key: it crouches, and its own keydown reports ctrlKey true. */
    keys.add(e.code)

    /* Let the browser keep its own chords: swallowing Cmd/Ctrl combinations
     * breaks reload, find and devtools. */
    if (e.metaKey || e.ctrlKey) return

    if (MOVEMENT_CODES.has(e.code)) e.preventDefault()

    if (e.repeat) return
    switch (e.code) {
      /* F and G used to enter fly and walk. Both are gone from the product:
       * orbit is the only way the city is meant to be read, and a mode the UI
       * does not offer must not be reachable by a stray keypress either. */
      case 'KeyF':
        break
      case 'KeyG':
        break
      case 'KeyH':
      case 'Home':
        home()
        break
      case 'KeyO':
        overview()
        break
      default:
        break
    }
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code)
  }

  /* A tab switch mid-stride would otherwise leave the key held forever. */
  const onBlur = (): void => {
    keys.clear()
    drag = 'none'
    gestureActive = false
    pointerCount = 0
    for (let i = 0; i < pointers.length; i++) {
      pointers[i]!.active = false
      pointers[i]!.id = -1
    }
  }

  /* ------------------------------------------------------------------------
   * Bus.
   * ----------------------------------------------------------------------*/

  function focusExplainer(entry: Explainer): void {
    if (entry.focus) {
      /* `focus` says where the camera should sit; the object, or failing that
       * the district centre, says what it should be pointed at. */
      let lx = 0
      let ly = 0
      let lz = 0
      if (entry.object) {
        entry.object.updateWorldMatrix(true, false)
        entry.object.getWorldPosition(_v)
        lx = _v.x
        ly = _v.y
        lz = _v.z
      } else {
        const d = districtById(entry.district)
        if (d) {
          lx = d.center[0]
          ly = d.center[1]
          lz = d.center[2]
        }
      }
      if (mode === 'walk') setMode('orbit')
      placeCamera(entry.focus[0], entry.focus[1], entry.focus[2], lx, ly, lz)
      return
    }
    if (entry.object) {
      focusObject(entry.object)
      return
    }
    const d = districtById(entry.district)
    if (d) focusDistrict(d)
  }

  const offFocus = bus.on('focus', ({ id, source }) => {
    const entry = registry.get(id)
    if (!entry) return
    /* A click names an instance; search, the tour and deep links name a concept.
     * Frame what was actually clicked, or the third pod sends you to the first. */
    const picked = registry.lastResolved
    if (source === 'click' && picked) focusObject(picked)
    else focusExplainer(entry)
  })

  const offDistrict = bus.on('focus-district', ({ id }) => {
    const d = districtById(id)
    if (d) focusDistrict(d)
  })

  /*
   * Only a modal surface owns the keyboard.
   *
   * This used to read the event's `open` flag and ignore its `id`, so anything
   * that announced itself on this channel silenced the camera: the label
   * toggle emits `overlay { id: 'labels' }`, the knob rail emits
   * `overlay { id: 'controls' }`, and the inspector — a side panel you are
   * meant to read *while* flying — emitted one too. Labels start on, so the
   * camera was deaf from load until something happened to send `open: false`,
   * which is why the first keypress went nowhere and why an open inspector
   * froze the controls.
   *
   * Track them by id, and let only the surfaces that genuinely take the whole
   * keyboard count.
   */
  const KEYBOARD_OWNERS = new Set(['help', 'search', 'tour', 'scenarios', 'console'])
  const openOverlays = new Set<string>()
  const offOverlay = bus.on('overlay', ({ id, open }) => {
    if (!KEYBOARD_OWNERS.has(id)) return
    if (open) openOverlays.add(id)
    else openOverlays.delete(id)
    overlayOpen = openOverlays.size > 0
    if (overlayOpen) {
      keys.clear()
      drag = 'none'
      exitPointerLock()
    }
  })

  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  window.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('pointerlockchange', onPointerLockChange)

  applyPose()

  const rig: CameraRig = {
    get mode(): CameraMode {
      return mode
    },
    set mode(m: CameraMode) {
      setMode(m)
    },
    setMode,
    update,
    focusObject,
    focusPoint,
    home,
    overview,
    dispose(): void {
      disposed = true
      exitPointerLock()
      offFocus()
      offDistrict()
      offOverlay()
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      keys.clear()
    },
  }
  return rig
}
