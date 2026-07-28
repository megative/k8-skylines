import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { createPicker } from './picker'
import type { Gfx } from './renderer'

/* ============================================================================
 * Picking is pointer behaviour, so the test supplies a canvas that records its
 * listeners and can be told to fire them. The raycast itself is real: the scene
 * and camera below are ordinary three.js objects and no GPU is involved.
 * ==========================================================================*/

const W = 1600
const H = 900

class FakeCanvas {
  style = { cursor: '' }
  private listeners = new Map<string, ((e: unknown) => void)[]>()
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const l = this.listeners.get(type) ?? []
    l.push(fn)
    this.listeners.set(type, l)
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    const l = this.listeners.get(type)
    if (!l) return
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect
  }
  count(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }
  fire(type: string, e: Record<string, unknown>): void {
    const l = this.listeners.get(type)
    if (!l) return
    for (const fn of l.slice()) fn({ preventDefault: () => undefined, button: 0, ...e })
  }
}

function installDom(canvas: FakeCanvas): void {
  const g = globalThis as unknown as Record<string, unknown>
  g.document = {
    pointerLockElement: null,
    documentElement: { style: { setProperty: () => undefined } },
    elementFromPoint: () => canvas,
  }
}

function lock(on: boolean): void {
  const d = (globalThis as unknown as Record<string, Record<string, unknown> | undefined>).document
  if (d) d.pointerLockElement = on ? {} : null
}

interface Harness {
  gfx: Gfx
  registry: Registry
  bus: Bus
  canvas: FakeCanvas
  focus: string[]
  blurs: number
  overlays: { id: string; open: boolean }[]
}

function harness(): Harness {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(48, W / H, 0.5, 4200)
  camera.position.set(0, 0, 120)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30))
  mesh.name = 'target'
  scene.add(mesh)
  scene.updateMatrixWorld(true)

  const registry = new Registry()
  registry.register({
    id: 'test.target',
    title: 'Target',
    district: 'apiserver',
    object: mesh,
    summary: 's',
    detail: ['d'],
  })

  const bus = new Bus()
  const h: Harness = {
    gfx: { scene, camera } as unknown as Gfx,
    registry,
    bus,
    canvas: new FakeCanvas(),
    focus: [],
    blurs: 0,
    overlays: [],
  }
  bus.on('focus', (p) => h.focus.push(p.source === 'click' ? p.id : `?${p.id}`))
  bus.on('blur', () => {
    h.blurs++
  })
  bus.on('overlay', (p) => h.overlays.push(p))
  installDom(h.canvas)
  return h
}

function build(h: Harness) {
  return createPicker(h.gfx, h.registry, h.bus, h.canvas as unknown as HTMLElement)
}

const CENTER = { clientX: W / 2, clientY: H / 2 }
const CORNER = { clientX: 8, clientY: 8 }

describe('picker', () => {
  beforeEach(() => lock(false))

  it('selects what is under the pointer and reports the click as the source', () => {
    const h = harness()
    const p = build(h)
    h.canvas.fire('pointerdown', CENTER)
    h.canvas.fire('pointerup', CENTER)
    expect(h.focus).toEqual(['test.target'])
    expect(h.blurs).toBe(0)
    p.dispose()
  })

  it('clears the selection when the click hits nothing', () => {
    const h = harness()
    const p = build(h)
    h.canvas.fire('pointerdown', CORNER)
    h.canvas.fire('pointerup', CORNER)
    expect(h.focus).toHaveLength(0)
    expect(h.blurs).toBe(1)
    p.dispose()
  })

  it('treats a dragged pointer as a camera gesture, not a selection', () => {
    const h = harness()
    const p = build(h)
    h.canvas.fire('pointerdown', CENTER)
    h.canvas.fire('pointermove', { clientX: W / 2 + 40, clientY: H / 2 + 12 })
    h.canvas.fire('pointerup', { clientX: W / 2 + 40, clientY: H / 2 + 12 })
    expect(h.focus).toHaveLength(0)
    expect(h.blurs).toBe(0)
    p.dispose()
  })

  it('highlights on hover without touching the selection', () => {
    const h = harness()
    const p = build(h)
    const hl = h.gfx.scene.getObjectByName('picker:highlight')!
    expect(hl.visible).toBe(false)
    h.canvas.fire('pointermove', CENTER)
    p.update(0.25)
    expect(hl.visible).toBe(true)
    expect(h.canvas.style.cursor).toBe('pointer')
    expect(h.focus).toHaveLength(0)

    h.canvas.fire('pointermove', CORNER)
    p.update(0.25)
    expect(hl.visible).toBe(false)
    expect(h.canvas.style.cursor).toBe('')
    p.dispose()
  })

  it('raycasts on hover at a few hertz, not every frame', () => {
    const h = harness()
    const p = build(h)
    const hl = h.gfx.scene.getObjectByName('picker:highlight')!
    h.canvas.fire('pointermove', CENTER)
    p.update(1 / 60)
    expect(hl.visible).toBe(false)
    p.update(0.2)
    expect(hl.visible).toBe(true)
    p.dispose()
  })

  it('does not hover while the pointer is locked', () => {
    const h = harness()
    const p = build(h)
    const hl = h.gfx.scene.getObjectByName('picker:highlight')!
    h.canvas.fire('pointermove', CENTER)
    lock(true)
    p.update(0.5)
    expect(hl.visible).toBe(false)
    /* A click still works: locked means the crosshair, not the cursor. */
    h.canvas.fire('pointerdown', CORNER)
    h.canvas.fire('pointerup', CORNER)
    expect(h.focus).toEqual(['test.target'])
    p.dispose()
  })

  it('opens the context menu on right-click and on a long press', () => {
    const h = harness()
    const p = build(h)
    h.canvas.fire('contextmenu', CENTER)
    expect(h.overlays).toEqual([{ id: 'context-menu', open: true }])
    expect(h.focus).toEqual(['test.target'])

    h.overlays.length = 0
    h.canvas.fire('pointerdown', CENTER)
    p.update(0.2)
    expect(h.overlays).toHaveLength(0)
    p.update(0.4)
    expect(h.overlays).toEqual([{ id: 'context-menu', open: true }])
    /* The press was consumed by the menu; releasing must not also select. */
    const focused = h.focus.length
    h.canvas.fire('pointerup', CENTER)
    expect(h.focus).toHaveLength(focused)
    p.dispose()
  })

  it('does not select through a modal overlay', () => {
    const h = harness()
    const p = build(h)
    h.bus.emit('overlay', { id: 'search', open: true })
    h.canvas.fire('pointerdown', CENTER)
    h.canvas.fire('pointerup', CENTER)
    expect(h.focus).toHaveLength(0)
    expect(h.blurs).toBe(0)

    h.bus.emit('overlay', { id: 'search', open: false })
    h.canvas.fire('pointerdown', CENTER)
    h.canvas.fire('pointerup', CENTER)
    expect(h.focus).toEqual(['test.target'])
    p.dispose()
  })

  it('leaves no listeners or scene objects behind', () => {
    const h = harness()
    const p = build(h)
    expect(h.canvas.count('pointermove')).toBe(1)
    p.dispose()
    expect(h.canvas.count('pointermove')).toBe(0)
    expect(h.gfx.scene.getObjectByName('picker:highlight')).toBeUndefined()
  })
})
