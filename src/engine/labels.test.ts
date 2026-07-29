import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../core/registry'
import type { SimState } from '../core/types'
import { ANCHOR, DISTRICTS } from '../world/layout'
import { createLabels } from './labels'
import type { Gfx } from './renderer'

/* ============================================================================
 * The label layer is DOM, and this project ships no DOM environment, so the
 * test supplies the smallest one that can answer the questions being asked:
 * what is on screen, where, and how wide. Sizes are deterministic functions of
 * the text, which is what makes the overlap assertion meaningful.
 * ==========================================================================*/

const CHAR = 6.5

class FakeStyle {
  cssText = ''
  display = ''
  transform = ''
  opacity = ''
  textTransform = ''
  letterSpacing = ''
  fontSize = ''
  setProperty(k: string, v: string): void {
    ;(this as unknown as Record<string, string>)[k] = v
  }
}

class FakeEl {
  style = new FakeStyle()
  children: FakeEl[] = []
  parent: FakeEl | null = null
  textContent = ''
  clientWidth = 1600
  clientHeight = 900
  constructor(readonly tag: string) {}
  appendChild(c: FakeEl): FakeEl {
    c.parent = this
    this.children.push(c)
    return c
  }
  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }
  /** Longest visible line, the way a nowrap box would lay out. */
  lines(): string[] {
    if (this.children.length === 0) return this.style.display === 'none' ? [] : [this.textContent]
    const out: string[] = []
    for (const c of this.children) out.push(...c.lines())
    return out
  }
  get offsetWidth(): number {
    let max = 0
    for (const l of this.lines()) max = Math.max(max, l.length)
    return Math.round(16 + max * CHAR)
  }
  get offsetHeight(): number {
    return this.lines().filter((l) => l.length > 0).length > 1 ? 34 : 22
  }
}

function installDom(): FakeEl {
  const g = globalThis as unknown as Record<string, unknown>
  g.document = { createElement: (t: string) => new FakeEl(t), documentElement: new FakeEl('html') }
  g.window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    innerWidth: 1600,
    innerHeight: 900,
  }
  return new FakeEl('div')
}

interface Shown {
  text: string
  x: number
  y: number
  w: number
  h: number
}

function shown(container: FakeEl): Shown[] {
  const out: Shown[] = []
  for (const el of container.children) {
    if (el.style.display === 'none') continue
    const m = /translate3d\((-?\d+)px,(-?\d+)px/.exec(el.style.transform)
    if (!m) continue
    const box = el.children[0]
    out.push({
      text: box.lines().filter((l) => l.length > 0).join(' | '),
      x: Number(m[1]),
      y: Number(m[2]),
      w: box.offsetWidth,
      h: box.offsetHeight,
    })
  }
  return out
}

const SIM = {} as SimState

function scene(): { gfx: Gfx; registry: Registry; meshes: THREE.Mesh[] } {
  const sc = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.5, 4200)
  const registry = new Registry()
  const geo = new THREE.BoxGeometry(20, 40, 20)
  const meshes: THREE.Mesh[] = []
  /* A row of registered buildings on the control-plane mesa, close enough
   * together that some of them must lose the overlap contest. */
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(geo)
    m.position.set(ANCHOR.apiServer[0] + (i - 4) * 26, 30, ANCHOR.apiServer[2])
    sc.add(m)
    meshes.push(m)
    registry.register({
      id: `t.building-${i}`,
      title: `Building number ${i}`,
      district: 'apiserver',
      object: m,
      summary: 's',
      detail: ['d'],
      metrics: () => [{ label: 'queue', value: String(i) }],
    })
  }
  sc.updateMatrixWorld(true)
  return { gfx: { scene: sc, camera } as unknown as Gfx, registry, meshes }
}

function run(l: { update(s: SimState, dt: number): void }, frames = 6): void {
  for (let i = 0; i < frames; i++) l.update(SIM, 1 / 60)
}

const DISTRICT_LABELS = new Set(DISTRICTS.map((d) => d.label))

describe('labels', () => {
  let container: FakeEl

  beforeEach(() => {
    container = installDom()
  })

  it('shows only district names from the establishing shot', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 900, 620)
    gfx.camera.lookAt(0, 0, -40)
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels)
    const list = shown(container)
    expect(list.length).toBeGreaterThan(2)
    for (const l of list) expect(DISTRICT_LABELS.has(l.text), l.text).toBe(true)
  })

  it('shows component names once the camera is inside the city', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 180, ANCHOR.apiServer[2] + 230)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels)
    const list = shown(container)
    const names = list.map((l) => l.text)
    expect(names.some((t) => t.startsWith('Building number'))).toBe(true)
    /* At this range the component name is enough; the numbers are not earned. */
    for (const t of names) expect(t.includes('queue')).toBe(false)
  })

  it('adds live values only at the closest tier', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 60, ANCHOR.apiServer[2] + 90)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    /* Values are rationed to a couple of labels per frame by design. */
    run(labels, 40)
    const list = shown(container)
    expect(list.some((l) => l.text.includes('queue'))).toBe(true)
  })

  it('drops a label whose anchor is inside a hidden group', () => {
    const { gfx, registry, meshes } = scene()
    gfx.camera.position.set(0, 180, ANCHOR.apiServer[2] + 230)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels, 30)
    expect(shown(container).some((l) => l.text === 'Building number 3')).toBe(true)

    /*
     * Hidden the way a district hides one of its own: the group goes, not the
     * anchor. three.js `visible` is per-object, so the anchor's own flag stays
     * true — and a nameplate left hovering over bare ground is how a machine
     * removed from the cluster kept announcing itself.
     */
    const hide = new THREE.Group()
    const anchor = meshes[3]
    gfx.scene.add(hide)
    hide.add(anchor)
    hide.visible = false
    gfx.scene.updateMatrixWorld(true)
    expect(anchor.visible).toBe(true)

    run(labels, 30)
    expect(shown(container).some((l) => l.text === 'Building number 3')).toBe(false)

    /* And it comes back when the group does. */
    hide.visible = true
    run(labels, 30)
    expect(shown(container).some((l) => l.text === 'Building number 3')).toBe(true)
  })

  it('never lets two labels overlap', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 90, ANCHOR.apiServer[2] + 150)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels, 30)
    const list = shown(container)
    expect(list.length).toBeGreaterThan(1)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const overlapX = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2)
        const overlapY = Math.min(a.y, b.y) - Math.max(a.y - a.h, b.y - b.h)
        expect(overlapX < 1.5 || overlapY < 1.5, `${a.text} overlaps ${b.text}`).toBe(true)
      }
    }
  })

  it('hides everything behind the camera', () => {
    const { gfx, registry } = scene()
    /* South of the whole city, facing further south: every anchor is behind. */
    gfx.camera.position.set(0, 90, 1000)
    gfx.camera.lookAt(0, 90, 2000)
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels)
    expect(shown(container)).toHaveLength(0)
  })

  it('reuses its pool instead of rebuilding the list', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 180, ANCHOR.apiServer[2] + 230)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    const nodes = container.children.length
    run(labels, 30)
    gfx.camera.position.set(0, 900, 620)
    gfx.camera.lookAt(0, 0, -40)
    run(labels, 30)
    expect(container.children.length).toBe(nodes)
    labels.dispose()
    expect(container.children.length).toBe(0)
  })

  it('stops drawing when switched off', () => {
    const { gfx, registry } = scene()
    gfx.camera.position.set(0, 180, ANCHOR.apiServer[2] + 230)
    gfx.camera.lookAt(0, 30, ANCHOR.apiServer[2])
    const labels = createLabels(gfx, registry, container as unknown as HTMLElement)
    run(labels)
    expect(shown(container).length).toBeGreaterThan(0)
    labels.setVisible(false)
    run(labels)
    expect(container.style.display).toBe('none')
  })
})
