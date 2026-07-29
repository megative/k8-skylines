import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { registry } from '../core/registry'
import { createCameraRig } from './camera'
import type { CameraRig } from './camera'
import type { Gfx } from './renderer'

/* ============================================================================
 * The rig, driven the way a hand drives it.
 *
 * Everything here asserts a property the feel depends on — that rotation is
 * exactly 1:1, that motion coasts and then stops, that the wheel goes where the
 * cursor points — rather than that a function exists. The pure formulas are
 * pinned separately in camera.test.ts.
 *
 * No GPU is involved: the camera is an ordinary three.js object and the events
 * are dispatched into the listeners the rig registered on `window`.
 * ==========================================================================*/

const W = 1600
const H = 900

type Listener = (e: unknown) => void

class FakeTarget {
  private listeners = new Map<string, Listener[]>()
  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? []
    l.push(fn)
    this.listeners.set(type, l)
  }
  removeEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type)
    if (!l) return
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  fire(type: string, e: Record<string, unknown> = {}): void {
    for (const fn of (this.listeners.get(type) ?? []).slice()) {
      fn({ preventDefault: () => undefined, stopPropagation: () => undefined, ...e })
    }
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }
}

class FakeCanvas extends FakeTarget {
  style: Record<string, string> = {}
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect
  }
  requestPointerLock(): void {}
  focus(): void {}
}

interface Harness {
  rig: CameraRig
  win: FakeTarget
  canvas: FakeCanvas
  camera: THREE.PerspectiveCamera
  bus: Bus
  /** Advance the rig by whole frames at a fixed step. */
  run(frames: number, dt?: number): void
  /** Camera yaw around the world origin, for measuring an orbit. */
  yaw(): number
}

let installed: string[] = []

function harness(): Harness {
  const canvas = new FakeCanvas()
  const win = new FakeTarget()
  const g = globalThis as unknown as Record<string, unknown>

  installed = ['window', 'document']
  g.window = win
  g.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    pointerLockElement: null,
    exitPointerLock: () => undefined,
    activeElement: null,
    body: {},
    documentElement: {},
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(48, W / H, 4, 4200)
  const gfx = {
    renderer: {} as THREE.WebGLRenderer,
    scene,
    camera,
    render: () => undefined,
    resize: () => undefined,
    setQuality: () => undefined,
    setBloom: () => undefined,
    dispose: () => undefined,
  } as unknown as Gfx

  const bus = new Bus()
  const rig = createCameraRig(gfx, canvas as unknown as HTMLElement, bus)

  const run = (frames: number, dt = 1 / 60): void => {
    for (let i = 0; i < frames; i++) rig.update(dt)
  }
  /* Settle the opening transition before anything is measured. */
  rig.home()
  run(240)

  return {
    rig,
    win,
    canvas,
    camera,
    bus,
    run,
    yaw: () => Math.atan2(camera.position.x, camera.position.z),
  }
}

/** A left-drag with no modifier: the map-pan gesture. */
function pan(h: Harness, from: [number, number], to: [number, number], steps = 6): void {
  h.win.fire('pointerdown', { pointerId: 1, button: 0, clientX: from[0], clientY: from[1], target: h.canvas })
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps
    const y = from[1] + ((to[1] - from[1]) * i) / steps
    h.win.fire('pointermove', { pointerId: 1, clientX: x, clientY: y })
    h.run(1)
  }
  h.win.fire('pointerup', { pointerId: 1, clientX: to[0], clientY: to[1] })
}

/** Shift-left-drag: the orbit gesture. */
function orbit(h: Harness, from: [number, number], to: [number, number], steps = 6): void {
  h.win.fire('pointerdown', {
    pointerId: 2,
    button: 0,
    shiftKey: true,
    clientX: from[0],
    clientY: from[1],
    target: h.canvas,
  })
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps
    const y = from[1] + ((to[1] - from[1]) * i) / steps
    h.win.fire('pointermove', { pointerId: 2, shiftKey: true, clientX: x, clientY: y })
    h.run(1)
  }
  h.win.fire('pointerup', { pointerId: 2, clientX: to[0], clientY: to[1] })
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>
  for (const k of installed) delete g[k]
  registry.clear()
})

describe('camera rig: rotation', () => {
  it('turns exactly as far as the hand did, with no lag', () => {
    const h = harness()
    const steps: number[] = []
    h.win.fire('pointerdown', { pointerId: 3, button: 0, shiftKey: true, clientX: 800, clientY: 400, target: h.canvas })
    let last = h.yaw()
    for (let i = 1; i <= 5; i++) {
      h.win.fire('pointermove', { pointerId: 3, shiftKey: true, clientX: 800 + i * 25, clientY: 400 })
      h.run(1)
      steps.push(h.yaw() - last)
      last = h.yaw()
    }
    h.win.fire('pointerup', { pointerId: 3 })

    /* Equal pointer deltas must produce equal rotation. Easing toward a goal
     * would make the first step short and later ones longer. */
    const first = steps[0]!
    for (const s of steps) expect(Math.abs(s - first)).toBeLessThan(Math.abs(first) * 0.02)
  })

  it('coasts after release and then stops', () => {
    const h = harness()
    orbit(h, [800, 400], [980, 400])
    const atRelease = h.yaw()

    h.run(6)
    const shortly = h.yaw()
    expect(Math.abs(shortly - atRelease)).toBeGreaterThan(0)

    /* Decay is exponential: each interval must move less than the one before. */
    h.run(6)
    const later = h.yaw()
    expect(Math.abs(later - shortly)).toBeLessThan(Math.abs(shortly - atRelease))

    h.run(240)
    const settled = h.yaw()
    h.run(120)
    expect(Math.abs(h.yaw() - settled)).toBeLessThan(1e-4)
  })

  it('does not coast when the hand stopped before letting go', () => {
    const h = harness()
    h.win.fire('pointerdown', { pointerId: 4, button: 0, shiftKey: true, clientX: 800, clientY: 400, target: h.canvas })
    h.win.fire('pointermove', { pointerId: 4, shiftKey: true, clientX: 900, clientY: 400 })
    h.run(1)
    /* Several frames of holding still: the velocity estimate must decay to nil. */
    h.run(30)
    h.win.fire('pointerup', { pointerId: 4 })
    const atRelease = h.yaw()
    h.run(60)
    expect(Math.abs(h.yaw() - atRelease)).toBeLessThan(1e-3)
  })
})

describe('camera rig: pan', () => {
  it('moves the view by the same amount at a shallow angle as at a steep one', () => {
    const steep = harness()
    const before = steep.camera.position.clone()
    pan(steep, [800, 450], [1000, 450])
    steep.run(4)
    const steepMoved = steep.camera.position.distanceTo(before)

    /* Tilt well down toward the horizon, then repeat the identical gesture. */
    const shallow = harness()
    orbit(shallow, [800, 400], [800, 140])
    shallow.run(200)
    const before2 = shallow.camera.position.clone()
    pan(shallow, [800, 450], [1000, 450])
    shallow.run(4)
    const shallowMoved = shallow.camera.position.distanceTo(before2)

    /* Grabbing a ground plane made this ratio explode as the view flattened.
     * Panning in the camera's own plane keeps it near one. */
    const ratio = shallowMoved / steepMoved
    expect(ratio).toBeGreaterThan(0.5)
    expect(ratio).toBeLessThan(2)
  })

  it('coasts after release', () => {
    const h = harness()
    pan(h, [800, 450], [1000, 450])
    const atRelease = h.camera.position.clone()
    h.run(30)
    expect(h.camera.position.distanceTo(atRelease)).toBeGreaterThan(0.5)
  })
})

describe('camera rig: wheel', () => {
  it('goes toward the point under the cursor, not toward the pivot', () => {
    const left = harness()
    const beforeL = left.camera.position.clone()
    for (let i = 0; i < 5; i++) {
      left.win.fire('wheel', { deltaY: -120, clientX: 300, clientY: 650, target: left.canvas })
      left.run(8)
    }
    const movedLeft = left.camera.position.clone().sub(beforeL)

    const right = harness()
    const beforeR = right.camera.position.clone()
    for (let i = 0; i < 5; i++) {
      right.win.fire('wheel', { deltaY: -120, clientX: 1300, clientY: 650, target: right.canvas })
      right.run(8)
    }
    const movedRight = right.camera.position.clone().sub(beforeR)

    /* Zooming at opposite sides of the screen must lead to different places.
     * A plain distance zoom around a fixed pivot would give the same vector. */
    expect(movedLeft.distanceTo(movedRight)).toBeGreaterThan(20)
    expect(movedLeft.x).toBeLessThan(movedRight.x)
  })

  it('still works when the cursor points above the horizon', () => {
    const h = harness()
    const before = h.camera.position.clone()
    /* No ground plane meets this ray; the old implementation gave up here. */
    for (let i = 0; i < 5; i++) {
      h.win.fire('wheel', { deltaY: -120, clientX: 1400, clientY: 60, target: h.canvas })
      h.run(8)
    }
    expect(h.camera.position.distanceTo(before)).toBeGreaterThan(10)
  })

  it('never lets the camera inside its own subject', () => {
    const h = harness()
    for (let i = 0; i < 200; i++) {
      h.win.fire('wheel', { deltaY: -240, clientX: 800, clientY: 450, target: h.canvas })
      h.run(2)
    }
    h.run(200)
    /* MIN_DIST is 24; the pivot sits near the ground under the city centre. */
    expect(h.camera.position.y).toBeGreaterThan(1)
  })
})

describe('camera rig: focus', () => {
  function subject(): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4))
    m.position.set(85, 2, 160)
    m.updateMatrixWorld(true)
    return m
  }

  it('frames a small object without burying the camera in it', () => {
    const h = harness()
    const o = subject()
    h.rig.focusObject(o)
    h.run(300)
    const d = h.camera.position.distanceTo(o.position)
    expect(d).toBeGreaterThan(40)
    expect(d).toBeLessThan(600)
  })

  it('approaches from above, never along the ground', () => {
    const h = harness()
    /*
     * Drop the camera toward the horizon first. From the establishing shot the
     * direction to a subject is already steep, so the lift never engages and
     * the assertion below would hold with or without it — a test that passes
     * for the wrong reason. Mutation-checked: restoring the old 13-degree floor
     * must fail this.
     */
    orbit(h, [800, 400], [800, 120])
    h.run(200)
    const o = subject()
    h.rig.focusObject(o)
    h.run(300)
    const dx = h.camera.position.x - o.position.x
    const dz = h.camera.position.z - o.position.z
    const elevation = Math.atan2(h.camera.position.y - o.position.y, Math.hypot(dx, dz))
    /* Below about 20 degrees the surroundings leave the frame entirely. */
    expect(elevation).toBeGreaterThan((20 * Math.PI) / 180)
  })

  it('never runs away when the subject is a whole district', () => {
    const h = harness()
    const big = new THREE.Mesh(new THREE.BoxGeometry(900, 40, 900))
    big.position.set(0, 0, 0)
    big.updateMatrixWorld(true)
    h.rig.focusObject(big)
    h.run(300)
    expect(h.camera.position.length()).toBeLessThan(1400)
  })

  it('hands control back with nothing left over', () => {
    const h = harness()
    h.rig.focusObject(subject())
    h.run(12)

    /* Grab it mid-flight and let go without moving. */
    h.win.fire('pointerdown', { pointerId: 9, button: 0, clientX: 800, clientY: 450, target: h.canvas })
    h.run(2)
    const grabbed = h.camera.position.clone()
    h.win.fire('pointerup', { pointerId: 9, clientX: 800, clientY: 450 })

    h.run(180)
    /* The flight must not resume: taking the camera is a mode flip, not a pause. */
    expect(h.camera.position.distanceTo(grabbed)).toBeLessThan(0.5)
  })
})

describe('camera rig: lifecycle', () => {
  it('detaches every listener it attached', () => {
    const h = harness()
    const types = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup']
    for (const t of types) expect(h.win.count(t)).toBeGreaterThan(0)
    h.rig.dispose()
    for (const t of types) expect(h.win.count(t), t).toBe(0)
  })
})
