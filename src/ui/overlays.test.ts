/* ============================================================================
 * The inspector, the command palette, the key map and the guided tour, tested
 * against a fake DOM.
 *
 * The stub below implements only the DOM surface these four files use. It can
 * build a tree, carry text, and hand a stored listener back so a click can be
 * delivered; it is not a browser and does not try to be one. Its job is to let
 * the parts that would actually mislead a reader be pinned by a test: a tour
 * that stops teaching, an inspector that drops its caveats, a legend that has
 * drifted away from the palette the city renders with.
 * ==========================================================================*/

import * as THREE from 'three'
import { beforeEach, describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import { Registry } from '../core/registry'
import { COLOR } from '../core/theme'
import type { SimState } from '../core/types'
import { Rng } from '../core/util'
import { SCENARIOS } from '../sim/scenarios'
import type { WorldCtx, WorldModule } from '../world/module'
import { createApiServer } from '../world/apiserver'
import { createControllers } from '../world/controllers'
import { createEtcd } from '../world/etcd'
import { createGround } from '../world/ground'
import { createNetwork } from '../world/network'
import { createNodes } from '../world/nodes'
import { createPods } from '../world/pods'
import { createScheduler } from '../world/scheduler'

import { createPanel } from './panel'
import { createSearch } from './search'
import { createHelp } from './help'
import { createTour } from './tour'

/* The real city, built once before any fake DOM exists — the districts detect
 * a headless environment by the absence of `document` and skip their canvas
 * atlases, so this has to happen at import time, ahead of installDom(). */
const CITY = buildCity()

function buildCity(): { registry: Registry; failed: string[] } {
  const registry = new Registry()
  const ctx: WorldCtx = {
    scene: new THREE.Scene(),
    registry,
    bus: new Bus(),
    rng: new Rng(0x85c171e5),
  }
  const failed: string[] = []
  const districts: [string, (c: WorldCtx) => WorldModule][] = [
    ['ground', createGround],
    ['etcd', createEtcd],
    ['apiserver', createApiServer],
    ['scheduler', createScheduler],
    ['controllers', createControllers],
    ['nodes', createNodes],
    ['pods', createPods],
    ['network', createNetwork],
  ]
  for (const [name, build] of districts) {
    try {
      build(ctx)
    } catch {
      failed.push(name)
    }
  }
  return { registry, failed }
}

/* ---------------------------------------------------------------------------
 * A DOM small enough to read.
 * -------------------------------------------------------------------------*/

type Listener = (ev: unknown) => void

class FakeNode {
  parentNode: FakeEl | null = null
  get textContent(): string {
    return ''
  }
}

class FakeText extends FakeNode {
  nodeValue: string
  constructor(text: string) {
    super()
    this.nodeValue = text
  }
  override get textContent(): string {
    return this.nodeValue
  }
}

class FakeEl extends FakeNode {
  tagName: string
  className = ''
  children: FakeNode[] = []
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  listeners = new Map<string, Listener[]>()
  style = { setProperty: (): void => {}, background: '' }
  hidden = false
  disabled = false
  title = ''
  type = ''
  value = ''
  placeholder = ''
  spellcheck = false
  autocapitalize = ''
  scrollTop = 0
  private own = ''

  constructor(tag: string) {
    super()
    this.tagName = tag.toUpperCase()
  }

  get isContentEditable(): boolean {
    return false
  }

  override get textContent(): string {
    if (this.children.length === 0) return this.own
    let out = ''
    for (const c of this.children) out += c.textContent
    return out
  }

  override set textContent(v: string) {
    this.children = []
    this.own = v
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this
    this.children.push(child)
    this.own = ''
    return child
  }

  append(...nodes: FakeNode[]): void {
    for (const n of nodes) this.appendChild(n)
  }

  remove(): void {
    const p = this.parentNode
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parentNode = null
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type)
    if (list) list.push(fn)
    else this.listeners.set(type, [fn])
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type)
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}

  get classList(): {
    add: (c: string) => void
    remove: (c: string) => void
    toggle: (c: string, on?: boolean) => void
    contains: (c: string) => boolean
  } {
    const parts = (): string[] => (this.className === '' ? [] : this.className.split(' '))
    return {
      add: (c) => {
        if (!parts().includes(c)) this.className = parts().concat(c).join(' ')
      },
      remove: (c) => {
        this.className = parts()
          .filter((p) => p !== c)
          .join(' ')
      },
      toggle: (c, on) => {
        const has = parts().includes(c)
        const want = on ?? !has
        if (want && !has) this.className = parts().concat(c).join(' ')
        if (!want && has) this.className = parts().filter((p) => p !== c).join(' ')
      },
      contains: (c) => parts().includes(c),
    }
  }

  /** The overlays only ever ask for a class. */
  closest(sel: string): FakeEl | null {
    const want = sel.replace('.', '')
    let node: FakeEl | null = this
    while (node) {
      if (node.className.split(' ').includes(want)) return node
      node = node.parentNode
    }
    return null
  }
}

function walk(root: FakeEl, out: FakeEl[] = []): FakeEl[] {
  out.push(root)
  for (const c of root.children) if (c instanceof FakeEl) walk(c, out)
  return out
}

function query(root: FakeEl, cls: string): FakeEl[] {
  return walk(root).filter((n) => n.className.split(' ').includes(cls))
}

/** Deliver an event the way the browser would: at the target, then upward. */
function fire(target: FakeEl, type: string, ev: Record<string, unknown> = {}): void {
  const base = {
    target,
    preventDefault: (): void => {},
    stopPropagation: (): void => {},
    ...ev,
  }
  let node: FakeEl | null = target
  while (node) {
    for (const fn of node.listeners.get(type) ?? []) fn(base)
    node = node.parentNode
  }
}

const HOST_IDS = ['panel', 'search', 'help', 'tour'] as const
let hosts: Record<string, FakeEl> = {}

function installDom(): void {
  hosts = {}
  for (const id of HOST_IDS) hosts[id] = new FakeEl('section')
  const g = globalThis as unknown as Record<string, unknown>
  g.HTMLElement = FakeEl
  g.document = {
    getElementById: (id: string): FakeEl | null => hosts[id] ?? null,
    createElement: (tag: string): FakeEl => new FakeEl(tag),
    createTextNode: (t: string): FakeText => new FakeText(t),
    documentElement: new FakeEl('html'),
  }
  g.window = {
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  }
}

const EMPTY_STATE = {} as SimState

beforeEach(() => {
  installDom()
})

/* --------------------------------------------------------------------- tour */

describe('guided tour', () => {
  interface Harness {
    bus: Bus
    tour: ReturnType<typeof createTour>
    chapters: { index: number; title: string }[]
    moves: string[]
    intents: string[]
  }

  function open(registry = new Registry()): Harness {
    const bus = new Bus()
    const chapters: { index: number; title: string }[] = []
    const moves: string[] = []
    const intents: string[] = []
    bus.on('tour-chapter', (p) => chapters.push({ index: p.index, title: p.title }))
    bus.on('focus', (p) => moves.push(`focus:${p.id}`))
    bus.on('focus-district', (p) => moves.push(`district:${p.id}`))
    bus.on('knob', (p) => intents.push(`knob:${String(p.key)}=${String(p.value)}`))
    bus.on('scenario', (p) => intents.push(`scenario:${p.id}`))
    const tour = createTour(bus, registry)
    bus.emit('overlay', { id: 'tour', open: true })
    return { bus, tour, chapters, moves, intents }
  }

  const nextButton = (): FakeEl => {
    const found = walk(hosts.tour).find((n) => n.dataset.act === 'next')
    if (!found) throw new Error('the tour has no next button')
    return found
  }

  it('follows one apply through fourteen chapters', () => {
    const { chapters, moves } = open()
    expect(chapters).toHaveLength(1)
    expect(chapters[0].index).toBe(0)
    expect(moves).toHaveLength(1)

    const next = nextButton()
    for (let i = 0; i < 13; i++) fire(next, 'click')

    expect(chapters).toHaveLength(14)
    for (let i = 0; i < 14; i++) expect(chapters[i].index).toBe(i)
    /* Every chapter moves the camera exactly once, whether or not the district
     * that owns the id it wants has registered it yet. */
    expect(moves).toHaveLength(14)

    const titles = chapters.map((c) => c.title)
    expect(new Set(titles).size).toBe(14)
    for (const t of titles) expect(t.length).toBeGreaterThan(8)
  })

  it('closes the loop: the last chapter returns to the first', () => {
    const { chapters } = open()
    const next = nextButton()
    for (let i = 0; i < 14; i++) fire(next, 'click')
    expect(chapters).toHaveLength(15)
    expect(chapters[13].index).toBe(13)
    expect(chapters[14].index).toBe(0)
  })

  it('prefers a registered id and falls back to the district', () => {
    const registry = new Registry()
    registry.register({
      id: 'etcd-raft-log',
      title: 'raft log',
      district: 'etcd',
      summary: 'the log',
      detail: ['a'],
    })
    const { moves } = open(registry)
    const next = nextButton()
    fire(next, 'click')
    fire(next, 'click')
    expect(moves[2]).toBe('focus:etcd-raft-log')
    /* Chapter 1 has nothing registered in this registry, so the district moves. */
    expect(moves[0].startsWith('district:')).toBe(true)
  })

  it('is prose, not captions', () => {
    const { tour } = open()
    const next = nextButton()
    for (let i = 0; i < 14; i++) {
      const paras = query(hosts.tour, 'tour-p')
      expect(paras.length).toBeGreaterThanOrEqual(3)
      /* A short closing line is a rhetorical beat; a short chapter is a caption. */
      let chars = 0
      for (const p of paras) chars += p.textContent.length
      expect(chars).toBeGreaterThan(950)
      fire(next, 'click')
    }
    tour.dispose()
  })

  it('announces every change it makes to the cluster, and makes each one once', () => {
    const { tour, intents } = open()
    const next = nextButton()
    let announced = 0
    for (let i = 0; i < 14; i++) {
      const lines = query(hosts.tour, 'tour-act')
      announced += lines.length
      for (const line of lines) {
        expect(line.dataset.state).toBe('pending')
        expect(line.textContent.length).toBeGreaterThan(12)
      }
      /* Nothing fires on arrival: a chapter is read before it is obeyed. */
      tour.update(0)
      for (const line of lines) expect(line.dataset.state).toBe('pending')
      tour.update(600)
      for (const line of lines) expect(line.dataset.state).toBe('done')
      fire(next, 'click')
    }
    expect(announced).toBeGreaterThan(4)
    expect(intents).toHaveLength(announced)
    tour.update(600)
    expect(intents).toHaveLength(announced)
  })

  it('lands on a registered Explainer in every chapter of the real city', () => {
    const { moves } = open(CITY.registry)
    const next = nextButton()
    for (let i = 0; i < 13; i++) fire(next, 'click')
    /* A district fallback here means a chapter is pointing at an id that no
     * longer exists: the tour would still move, and quietly teach less. */
    expect({ fellBack: moves.filter((m) => m.startsWith('district:')), failed: CITY.failed }).toEqual(
      { fellBack: [], failed: [] },
    )
  })

  it('only runs scenarios the simulation actually defines', () => {
    const { tour, intents } = open(CITY.registry)
    const next = nextButton()
    for (let i = 0; i < 14; i++) {
      tour.update(600)
      fire(next, 'click')
    }
    const known = new Set(SCENARIOS.map((s) => s.id))
    const ran = intents.filter((i) => i.startsWith('scenario:'))
    expect(ran.length).toBeGreaterThan(0)
    /* An id the tour invents is a chapter that promises something and then
     * silently does nothing. */
    for (const i of ran) expect(known.has(i.slice('scenario:'.length))).toBe(true)
  })

  it('touches nothing while it is not running', () => {
    const bus = new Bus()
    const intents: string[] = []
    bus.on('knob', () => intents.push('knob'))
    bus.on('scenario', () => intents.push('scenario'))
    const tour = createTour(bus, new Registry())
    expect(tour.running).toBe(false)
    tour.update(600)
    expect(intents).toHaveLength(0)
  })

  it('ends on request and says so', () => {
    const { bus, tour } = open()
    let ended = 0
    bus.on('tour-end', () => (ended += 1))
    expect(tour.running).toBe(true)
    bus.emit('overlay', { id: 'tour', open: false })
    expect(tour.running).toBe(false)
    expect(ended).toBe(1)
  })
})

/* -------------------------------------------------------------------- panel */

describe('inspector', () => {
  const entry = {
    id: 'pod.qos',
    title: 'QoS class',
    district: 'nodes' as const,
    kubeName: 'v1.PodQOSClass',
    summary: 'Derived from requests and limits, never set by hand.',
    detail: ['Guaranteed means every container sets requests equal to limits.'],
  }

  it('renders an Explainer and never drops the caveats', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register(entry)
    const panel = createPanel(bus, registry)

    expect(hosts.panel.hidden).toBe(true)
    bus.emit('focus', { id: 'pod.qos' })
    expect(hosts.panel.hidden).toBe(false)
    expect(query(hosts.panel, 'pnl-title')[0].textContent).toBe('QoS class')
    expect(query(hosts.panel, 'pnl-kube')[0].textContent).toBe('v1.PodQOSClass')
    expect(query(hosts.panel, 'pnl-district')[0].textContent).toBe('Nodes')

    /* An entry that claims no simplification still discloses the model itself. */
    const caveats = query(hosts.panel, 'pnl-clist')[0]
    expect(caveats.children).toHaveLength(1)
    expect(caveats.textContent).toContain('model, not an emulator')
    panel.dispose()
  })

  /*
   * One click emits a pair: `inspect` names the object, `focus` names the
   * mechanism that click landed on. The two ids live in different namespaces —
   * a kind id (`pod`) against an Explainer id (`pod.qos`) — and the panel used
   * to require them to be equal before it would believe the object. They happen
   * to coincide for a pod lot and a Service slot, so identity looked correct
   * while every other click silently fell back to a representative under a
   * header that named one specific object.
   */
  it('keeps the clicked object when the mechanism id is not the kind id', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register(entry)
    const panel = createPanel(bus, registry)

    bus.emit('inspect', { kind: 'pod', namespace: 'shop', name: 'web-7d9f4' })
    bus.emit('focus', { id: 'pod.qos', source: 'click' })

    expect(query(hosts.panel, 'pnl-title')[0].textContent).toBe('web-7d9f4')
    expect(query(hosts.panel, 'pnl-kube')[0].textContent).toContain('shop')
    panel.dispose()
  })

  it('drops the object when a mechanism is reached without a click', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register(entry)
    const panel = createPanel(bus, registry)

    bus.emit('inspect', { kind: 'pod', namespace: 'shop', name: 'web-7d9f4' })
    bus.emit('focus', { id: 'pod.qos', source: 'click' })
    expect(query(hosts.panel, 'pnl-title')[0].textContent).toBe('web-7d9f4')

    /* Search names a mechanism and nothing else. Carrying the last click's pod
     * into it would caption a general lesson with one arbitrary object. */
    bus.emit('focus', { id: 'pod.qos', source: 'search' })
    expect(query(hosts.panel, 'pnl-title')[0].textContent).toBe('QoS class')
    panel.dispose()
  })

  it('renders live metrics and closes on blur', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register({
      ...entry,
      id: 'pod.resources',
      metrics: () => [
        { label: 'requests', value: '250m' },
        { label: 'limits', value: '500m', hint: 'a cgroup quota' },
      ],
    })
    const panel = createPanel(bus, registry)
    bus.emit('focus', { id: 'pod.resources' })
    panel.update(EMPTY_STATE)

    const rows = query(hosts.panel, 'pnl-mrow')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('250m')
    expect(rows[1].textContent).toContain('a cgroup quota')

    bus.emit('blur', {})
    expect(hosts.panel.hidden).toBe(true)
    panel.dispose()
  })

  it('offers a way out: the district and its neighbours', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register(entry)
    registry.register({ ...entry, id: 'pod.probes', title: 'Probes' })
    const jumps: string[] = []
    bus.on('focus', (p) => jumps.push(p.id))
    const panel = createPanel(bus, registry)

    bus.emit('focus', { id: 'pod.qos' })
    const chips = query(hosts.panel, 'pnl-chip')
    expect(chips.map((c) => c.textContent)).toEqual(['Probes'])
    fire(chips[0], 'click')
    expect(jumps).toEqual(['pod.qos', 'pod.probes'])
    panel.dispose()
  })

  it('says so when geometry focuses an id nobody explained', () => {
    const bus = new Bus()
    const panel = createPanel(bus, new Registry())
    bus.emit('focus', { id: 'ghost.building' })
    expect(hosts.panel.hidden).toBe(false)
    expect(hosts.panel.textContent).toContain('decoration is a bug')
    panel.dispose()
  })
})

/* ------------------------------------------------------------------- search */

describe('command palette', () => {
  const findInput = (): FakeEl => {
    const found = walk(hosts.search).find((n) => n.tagName === 'INPUT')
    if (!found) throw new Error('the palette has no input')
    return found
  }

  it('offers scenarios and knobs before anything is typed', () => {
    const bus = new Bus()
    const search = createSearch(bus, new Registry())
    bus.emit('overlay', { id: 'search', open: true })
    expect(hosts.search.hidden).toBe(false)
    const items = query(hosts.search, 'cmd-item')
    expect(items.length).toBeGreaterThan(8)
    expect(items[0].className).toContain('is-on')
    search.dispose()
  })

  it('finds components through the registry and emits focus for them', () => {
    const bus = new Bus()
    const registry = new Registry()
    registry.register({
      id: 'etcd-quorum',
      title: 'Quorum',
      district: 'etcd',
      summary: 'A majority of members must persist an entry before it commits.',
      detail: ['x'],
      keywords: ['raft', 'majority'],
    })
    const focused: string[] = []
    bus.on('focus', (p) => focused.push(p.id))
    const search = createSearch(bus, registry)
    bus.emit('overlay', { id: 'search', open: true })

    const input = findInput()
    input.value = 'quorum'
    fire(input, 'input')

    const items = query(hosts.search, 'cmd-item')
    expect(items[0].textContent).toContain('Quorum')
    fire(items[0], 'click')
    expect(focused).toEqual(['etcd-quorum'])
    /* Selecting closes the palette: it is a command, not a browser. */
    expect(hosts.search.hidden).toBe(true)
    search.dispose()
  })

  it('turns a knob into one typed intent', () => {
    const bus = new Bus()
    const knobs: string[] = []
    bus.on('knob', (p) => knobs.push(`${String(p.key)}=${String(p.value)}`))
    const search = createSearch(bus, new Registry())
    bus.emit('overlay', { id: 'search', open: true })

    const input = findInput()
    input.value = 'crashloopbackoff on'
    fire(input, 'input')
    const items = query(hosts.search, 'cmd-item')
    expect(items.length).toBeGreaterThan(0)
    fire(items[0], 'click')
    expect(knobs).toEqual(['crashLoop=true'])
    search.dispose()
  })

  it('runs a scenario as an intent, never as a mutation', () => {
    const bus = new Bus()
    const runs: string[] = []
    bus.on('scenario', (p) => runs.push(`${p.id}:${String(p.running)}`))
    const search = createSearch(bus, new Registry())
    bus.emit('overlay', { id: 'search', open: true })

    const input = findInput()
    input.value = 'quorum loss'
    fire(input, 'input')
    fire(query(hosts.search, 'cmd-item')[0], 'click')
    expect(runs).toEqual(['etcd-quorum-loss:true'])
    search.dispose()
  })
})

/* --------------------------------------------------------------------- help */

describe('help', () => {
  it('generates the legend from the palette the city renders with', () => {
    const bus = new Bus()
    const help = createHelp(bus)
    bus.emit('overlay', { id: 'help', open: true })

    const named = query(hosts.help, 'help-swatch-name').map((n) => n.textContent)
    expect(named.slice().sort()).toEqual(Object.keys(COLOR).slice().sort())

    const hexes = query(hosts.help, 'help-swatch-hex').map((n) => n.textContent)
    expect(hexes).toContain('#38e8ff')
    expect(hexes).toHaveLength(named.length)
    help.dispose()
  })

  it('documents the keys the city actually binds', () => {
    const bus = new Bus()
    const help = createHelp(bus)
    bus.emit('overlay', { id: 'help', open: true })
    const text = hosts.help.textContent
    expect(text).toContain('Command palette')
    expect(text).toContain('Guided tour')
    expect(text).toContain('Pause and resume model time')
    help.dispose()
  })
})
