/* ============================================================================
 * The HUD and the knob rail, tested against a fake DOM.
 *
 * Two claims are worth pinning here and neither needs a browser:
 *   - the HUD writes to the document only when a value actually changed, so a
 *     still cluster costs nothing per frame;
 *   - the rail never mutates the model, and every field of `Knobs` has exactly
 *     one control that emits the matching intent on the bus.
 *
 * The fake below implements only the DOM surface src/ui uses. If a UI file
 * starts using something else, this file must grow — which is the point: the
 * UI's dependency on the DOM stays small and visible.
 * ==========================================================================*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import {
  DEFAULT_KNOBS,
  type ClusterEvent,
  type ControllerId,
  type ControllerState,
  type Knobs,
  type NodeState,
  type SimState,
} from '../core/types'
import { createHud } from './hud'
import { createControls } from './controls'

/* ---------------------------------------------------------------------------
 * A DOM small enough to read.
 * -------------------------------------------------------------------------*/

const stats = { text: 0, style: 0, cls: 0 }

class FakeClassList {
  private set = new Set<string>()

  get value(): string {
    return [...this.set].join(' ')
  }

  set value(v: string) {
    this.set = new Set(v.split(' ').filter(Boolean))
  }

  add(c: string): void {
    this.set.add(c)
  }

  remove(c: string): void {
    this.set.delete(c)
  }

  contains(c: string): boolean {
    return this.set.has(c)
  }

  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c)
    if (on) this.set.add(c)
    else this.set.delete(c)
    stats.cls++
    return on
  }
}

class FakeStyle {
  private props = new Map<string, string>()
  private w = ''
  private l = ''

  get width(): string {
    return this.w
  }

  set width(v: string) {
    this.w = v
    stats.style++
  }

  get left(): string {
    return this.l
  }

  set left(v: string) {
    this.l = v
    stats.style++
  }

  setProperty(k: string, v: string): void {
    this.props.set(k, v)
  }

  getPropertyValue(k: string): string {
    return this.props.get(k) ?? ''
  }
}

type Listener = (e: unknown) => void

class FakeEl {
  readonly tagName: string
  readonly children: FakeEl[] = []
  parent: FakeEl | null = null
  readonly classList = new FakeClassList()
  readonly style = new FakeStyle()
  readonly dataset: Record<string, string> = {}
  readonly attrs = new Map<string, string>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private text = ''

  id = ''
  hidden = false
  title = ''
  type = ''
  value = ''
  checked = false
  disabled = false
  min = ''
  max = ''
  step = ''
  open = false
  htmlFor = ''
  isContentEditable = false

  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }

  get className(): string {
    return this.classList.value
  }

  set className(v: string) {
    this.classList.value = v
  }

  get textContent(): string {
    return this.text
  }

  set textContent(v: string) {
    this.text = v
    stats.text++
  }

  append(...nodes: FakeEl[]): void {
    for (const n of nodes) {
      n.parent = this
      this.children.push(n)
    }
  }

  replaceChildren(): void {
    this.children.length = 0
  }

  remove(): void {
    const p = this.parent
    if (p) {
      const i = p.children.indexOf(this)
      if (i >= 0) p.children.splice(i, 1)
    }
    this.parent = null
  }

  get firstElementChild(): FakeEl | null {
    return this.children[0] ?? null
  }

  get childElementCount(): number {
    return this.children.length
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v)
  }

  addEventListener(type: string, fn: Listener): void {
    let s = this.listeners.get(type)
    if (!s) {
      s = new Set()
      this.listeners.set(type, s)
    }
    s.add(fn)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }

  dispatch(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
}

const mounts = new Map<string, FakeEl>()
const html = new FakeEl('html')

function walk(el: FakeEl, out: FakeEl[] = []): FakeEl[] {
  out.push(el)
  for (const c of el.children) walk(c, out)
  return out
}

function findById(root: FakeEl, id: string): FakeEl | undefined {
  return walk(root).find((e) => e.id === id)
}

function textOf(root: FakeEl, cls: string): string | undefined {
  return walk(root).find((e) => e.classList.contains(cls))?.textContent
}

const winListeners = new Map<string, Set<Listener>>()
const fakeWindow = {
  innerWidth: 1400,
  addEventListener(type: string, fn: Listener): void {
    let s = winListeners.get(type)
    if (!s) {
      s = new Set()
      winListeners.set(type, s)
    }
    s.add(fn)
  },
  removeEventListener(type: string, fn: Listener): void {
    winListeners.get(type)?.delete(fn)
  },
  setTimeout(fn: () => void, ms: number): number {
    return Number(setTimeout(fn, ms))
  },
  clearTimeout(id: number): void {
    clearTimeout(id)
  },
}

function key(k: string, mods: Partial<KeyboardEvent> = {}): void {
  let prevented = false
  const ev = {
    key: k,
    target: null,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true
    },
    ...mods,
  }
  for (const fn of winListeners.get('keydown') ?? []) fn(ev)
  void prevented
}

globalThis.document = {
  createElement: (tag: string) => new FakeEl(tag),
  getElementById: (id: string) => mounts.get(id) ?? null,
  documentElement: html,
} as unknown as Document

globalThis.window = fakeWindow as unknown as Window & typeof globalThis

/* ---------------------------------------------------------------------------
 * A cluster to look at.
 * -------------------------------------------------------------------------*/

function node(index: number, ready: boolean): NodeState {
  return {
    name: `node-${index}`,
    index,
    present: true,
    conditions: [
      { type: 'Ready', status: ready ? 'True' : 'False', reason: 'KubeletReady', sinceSeconds: 60 },
    ],
    taints: [],
    unschedulable: false,
    capacityCpuMilli: 4000,
    capacityMemMib: 8192,
    capacityPods: 12,
    allocatableCpuMilli: 3600,
    allocatableMemMib: 7424,
    requestedCpuMilli: 900,
    requestedMemMib: 1024,
    usedCpuMilli: 420,
    usedMemMib: 700,
    podUids: [],
    kubelet: { phase: 'idle', progress: 0, sinceLeaseSeconds: 1, plegHealthy: true, evicting: false },
    proxyRules: [],
    podCidr: `10.244.${index}.0/24`,
    imageCache: [],
  }
}

function fixture(): SimState {
  return {
    t: 300,
    knobs: { ...DEFAULT_KNOBS },
    etcd: {
      members: [
        { id: 'm1', name: 'etcd-0', role: 'leader', matchIndex: 9, term: 2, sinceHeartbeat: 0, fsyncMs: 3 },
        { id: 'm2', name: 'etcd-1', role: 'follower', matchIndex: 9, term: 2, sinceHeartbeat: 0, fsyncMs: 3 },
        { id: 'm3', name: 'etcd-2', role: 'follower', matchIndex: 9, term: 2, sinceHeartbeat: 0, fsyncMs: 3 },
      ],
      revision: 128,
      compactedRevision: 0,
      log: [],
      hasQuorum: true,
      dbSizeMib: 24,
      dbQuotaMib: 2048,
      watchers: 6,
      writesPerSec: 4,
      readLatencyMs: 2,
      alarm: 'none',
    },
    api: {
      inflight: [],
      apfSeatsUsed: 3,
      apfSeatsTotal: 24,
      throttled: 0,
      webhooks: [],
      watchConnections: 11,
      watchCacheRevision: 128,
      requestsPerSec: 12.5,
      counts: { ok: 40, forbidden: 1, unauthorized: 0, rejected: 0, conflict: 2 },
      writable: true,
    },
    scheduler: {
      activeQueue: [],
      backoffQueue: [],
      unschedulableQueue: [],
      scheduled: 7,
      failed: 1,
      latencyMs: 14,
      leading: true,
    },
    controllers: {} as Record<ControllerId, ControllerState>,
    nodes: [node(0, true), node(1, true), node(2, true), node(3, true)],
    pods: new Map(),
    deployments: [],
    replicaSets: [],
    statefulSets: [],
    daemonSets: [],
    jobs: [],
    hpas: [],
    pdbs: [],
    services: [],
    ingresses: [],
    networkPolicies: [],
    dns: { readyReplicas: 2, queriesPerSec: 8, cacheHitRatio: 0.9, nxdomainRate: 0, latencyMs: 1 },
    storageClasses: [],
    pvcs: [],
    pvs: [],
    csiOps: [],
    events: [],
    totals: {
      podsRunning: 4,
      podsPending: 0,
      podsFailed: 0,
      podsTerminating: 0,
      nodesReady: 4,
      nodesTotal: 4,
      cpuRequestedMilli: 3600,
      cpuAllocatableMilli: 14400,
      memRequestedMib: 4096,
      memAllocatableMib: 29696,
      restarts: 0,
    },
  }
}

const event = (id: number, type: 'Normal' | 'Warning', reason: string): ClusterEvent => ({
  id,
  type,
  reason,
  namespace: 'shop',
  involved: 'pod/web-7d9f-x2k4b',
  message: 'something happened',
  at: 290,
  count: 1,
})

const MOUNTS = ['hud-top', 'hud-left', 'hud-right', 'hud-bottom', 'toasts', 'controls']

beforeEach(() => {
  mounts.clear()
  for (const id of MOUNTS) {
    const el = new FakeEl('div')
    el.id = id
    mounts.set(id, el)
  }
  winListeners.clear()
  stats.text = 0
  stats.style = 0
  stats.cls = 0
})

/* ---------------------------------------------------------------------------
 * HUD.
 * -------------------------------------------------------------------------*/

describe('createHud', () => {
  let bus: Bus
  let hud: ReturnType<typeof createHud>

  beforeEach(() => {
    bus = new Bus()
    hud = createHud(bus)
  })

  afterEach(() => hud.dispose())

  it('mounts into every HUD region and nowhere else', () => {
    for (const id of ['hud-top', 'hud-left', 'hud-right', 'hud-bottom']) {
      expect(mounts.get(id)!.childElementCount).toBeGreaterThan(0)
    }
    expect(mounts.get('toasts')!.childElementCount).toBe(0)
  })

  it('writes nothing to the document when no value changed', () => {
    const s = fixture()
    hud.update(s, 1)
    expect(stats.text).toBeGreaterThan(0)

    stats.text = 0
    stats.style = 0
    stats.cls = 0
    hud.update(s, 1)
    hud.update(s, 1)
    expect(stats.text).toBe(0)
    expect(stats.style).toBe(0)
    expect(stats.cls).toBe(0)
  })

  it('writes exactly one text node when exactly one number moved', () => {
    const s = fixture()
    hud.update(s, 1)
    stats.text = 0

    s.totals.podsPending = 3
    hud.update(s, 1)
    expect(stats.text).toBe(1)
  })

  it('holds off until the refresh interval has elapsed', () => {
    const s = fixture()
    hud.update(s, 1)
    stats.text = 0
    s.totals.restarts = 9
    /* Well under 1/12 s: the value is not on screen yet. */
    hud.update(s, 0.001)
    expect(stats.text).toBe(0)
    hud.update(s, 1)
    expect(stats.text).toBeGreaterThan(0)
  })

  it('reports nodes, phases and requested against allocatable', () => {
    const s = fixture()
    s.totals.nodesReady = 3
    hud.update(s, 1)

    const top = mounts.get('hud-top')!
    expect(walk(top).some((e) => e.textContent === '3')).toBe(true)
    /* Requested is shown against allocatable, in kubectl's own cpu spelling. */
    const left = mounts.get('hud-left')!
    const texts = walk(left).map((e) => e.textContent)
    expect(texts).toContain('3.6')
    expect(texts).toContain('14.4')
  })

  it('counts nodes against the cluster, not against the city', () => {
    const s = fixture()
    /* Two machines were removed. Nothing failed, so the readout must be
     * "2 / 2" and calm; "2 / 4" in red would describe a casualty. */
    s.totals.nodesReady = 2
    s.totals.nodesTotal = 2
    hud.update(s, 1)

    const top = mounts.get('hud-top')!
    const cell = walk(top)
      .filter((e) => e.classList.contains('hud-cell'))
      .find((e) => walk(e).some((c) => c.textContent === 'nodes'))!
    expect(walk(cell).map((e) => e.textContent)).toContain('2')
    expect(walk(cell).some((e) => e.textContent === String(s.nodes.length))).toBe(false)
    expect(cell.classList.contains('bad')).toBe(false)
  })

  it('marks lost quorum on the etcd panel', () => {
    const s = fixture()
    hud.update(s, 1)
    const right = mounts.get('hud-right')!
    expect(textOf(right, 'hud-badge')).toBe('quorum')

    s.etcd.hasQuorum = false
    s.etcd.members[2]!.role = 'down'
    s.api.writable = false
    hud.update(s, 1)
    expect(textOf(right, 'hud-badge')).toBe('NO QUORUM')
    expect(walk(right).some((e) => e.classList.contains('bad') && e.classList.contains('hud-panel'))).toBe(
      true,
    )
  })

  it('shows the newest events first and flags Warnings', () => {
    const s = fixture()
    s.events.push(event(1, 'Normal', 'Scheduled'), event(2, 'Warning', 'FailedScheduling'))
    hud.update(s, 1)

    const rows = walk(mounts.get('hud-bottom')!).filter((e) => e.classList.contains('hud-ev'))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(textOf(rows[0]!, 'hud-ev-reason')).toBe('FailedScheduling')
    expect(rows[0]!.classList.contains('warn')).toBe(true)
    expect(rows[1]!.classList.contains('warn')).toBe(false)
    /* Rows with no event behind them are not drawn at all. */
    expect(rows[2]!.classList.contains('on')).toBe(false)
  })

  it('names the selected component and clears it on blur', () => {
    const top = mounts.get('hud-top')!
    bus.emit('focus', { id: 'etcd.raft-log' })
    expect(textOf(top, 'hud-v')).toBeDefined()
    expect(walk(top).some((e) => e.textContent === 'etcd.raft-log')).toBe(true)
    bus.emit('blur', {})
    expect(walk(top).some((e) => e.textContent === 'nothing')).toBe(true)
  })

  it('shows the transport state', () => {
    const s = fixture()
    s.knobs.paused = true
    s.knobs.timeScale = 4
    hud.update(s, 1)
    const top = mounts.get('hud-top')!
    expect(textOf(top, 'hud-transport-state')).toBe('paused')
    expect(textOf(top, 'hud-transport-scale')).toBe('4×')
  })

  it('renders toasts and caps how many are on screen', () => {
    const toasts = mounts.get('toasts')!
    for (let i = 0; i < 6; i++) bus.emit('toast', { text: `t${i}`, kind: 'info' })
    expect(toasts.childElementCount).toBe(4)
    expect(toasts.children[3]!.textContent).toBe('t5')
  })
})

/* ---------------------------------------------------------------------------
 * Controls.
 * -------------------------------------------------------------------------*/

describe('createControls', () => {
  let bus: Bus
  let knobs: Knobs
  let controls: ReturnType<typeof createControls>
  let seen: { key: keyof Knobs; value: unknown }[]
  let transports: { paused: boolean; timeScale: number }[]

  beforeEach(() => {
    bus = new Bus()
    knobs = { ...DEFAULT_KNOBS }
    seen = []
    transports = []
    bus.on('knob', (p) => seen.push({ key: p.key, value: p.value }))
    bus.on('transport', (p) => transports.push({ paused: p.paused, timeScale: p.timeScale }))
    controls = createControls(bus, knobs)
  })

  afterEach(() => controls.dispose())

  const input = (k: keyof Knobs): FakeEl => {
    const el = findById(mounts.get('controls')!, `ctl-${String(k)}`)
    if (!el) throw new Error(`no control for knob "${String(k)}"`)
    return el
  }

  it('gives every field of Knobs exactly one control', () => {
    const ids = walk(mounts.get('controls')!)
      .filter((e) => e.tagName === 'INPUT')
      .map((e) => e.id)
    for (const k of Object.keys(DEFAULT_KNOBS)) {
      expect(ids.filter((id) => id === `ctl-${k}`).length).toBe(1)
    }
  })

  it('explains every knob in one line', () => {
    const whys = walk(mounts.get('controls')!).filter((e) => e.classList.contains('ctl-why'))
    expect(whys.length).toBe(Object.keys(DEFAULT_KNOBS).length)
    for (const w of whys) expect(w.textContent.length).toBeGreaterThan(40)
  })

  it('emits an intent and never touches the model', () => {
    const before = { ...knobs }
    const el = input('replicas')
    el.value = '9'
    el.dispatch('input', {})
    expect(seen).toContainEqual({ key: 'replicas', value: 9 })
    expect(knobs).toEqual(before)
  })

  it('emits booleans for switches', () => {
    const el = input('crashLoop')
    el.checked = true
    el.dispatch('input', {})
    expect(seen).toContainEqual({ key: 'crashLoop', value: true })
  })

  it('maps the speed slider onto discrete time scales', () => {
    const el = input('timeScale')
    el.value = '0'
    el.dispatch('input', {})
    expect(seen).toContainEqual({ key: 'timeScale', value: 0.25 })
    expect(transports.at(-1)).toEqual({ paused: false, timeScale: 0.25 })
  })

  it('reflects a value the simulation changed underneath it', () => {
    const s = fixture()
    s.knobs.replicas = 7
    controls.update(s)
    expect(input('replicas').value).toBe('7')
    /* The HPA owns .spec.replicas, so the slider stops driving it. */
    expect(input('replicas').disabled).toBe(false)
    s.knobs.hpaEnabled = true
    controls.update(s)
    expect(input('replicas').disabled).toBe(true)
  })

  it('names the QoS class the requests and limits actually produce', () => {
    const s = fixture()
    const qos = (): string | undefined => textOf(mounts.get('controls')!, 'ctl-qos')

    controls.update(s)
    expect(qos()).toBe('Burstable')

    s.knobs.limitCpuMilli = s.knobs.requestCpuMilli
    s.knobs.limitMemMib = s.knobs.requestMemMib
    controls.update(s)
    expect(qos()).toBe('Guaranteed')

    s.knobs.requestCpuMilli = 0
    s.knobs.limitCpuMilli = 0
    s.knobs.requestMemMib = 0
    s.knobs.limitMemMib = 0
    controls.update(s)
    expect(qos()).toBe('BestEffort')
  })

  it('pauses on K and on P, and steps the speed on , and .', () => {
    key('k')
    expect(transports.at(-1)).toEqual({ paused: true, timeScale: 1 })
    expect(seen).toContainEqual({ key: 'paused', value: true })

    knobs.paused = true
    key('p')
    expect(transports.at(-1)).toEqual({ paused: false, timeScale: 1 })

    knobs.paused = false
    key('.')
    expect(transports.at(-1)).toEqual({ paused: false, timeScale: 2 })
    key(',')
    expect(transports.at(-1)).toEqual({ paused: false, timeScale: 0.5 })
  })

  it('leaves modified chords and typing alone', () => {
    key('k', { metaKey: true })
    const typing = new FakeEl('input')
    key('k', { target: typing as unknown as EventTarget })
    expect(transports).toEqual([])
    expect(seen).toEqual([])
  })

  it('toggles theme on N and labels on L', () => {
    const themes: string[] = []
    const overlays: { id: string; open: boolean }[] = []
    bus.on('theme', (p) => themes.push(p.mode))
    bus.on('overlay', (p) => overlays.push({ id: p.id, open: p.open }))

    key('n')
    expect(themes).toEqual(['day'])
    html.dataset.theme = 'day'
    key('n')
    expect(themes).toEqual(['day', 'night'])

    key('l')
    expect(overlays).toContainEqual({ id: 'labels', open: false })
    key('l')
    expect(overlays).toContainEqual({ id: 'labels', open: true })
  })

  it('restores defaults on R, and only for knobs that moved', () => {
    knobs.replicas = 11
    knobs.crashLoop = true
    key('r')
    expect(seen).toContainEqual({ key: 'replicas', value: DEFAULT_KNOBS.replicas })
    expect(seen).toContainEqual({ key: 'crashLoop', value: false })
    expect(seen.some((e) => e.key === 'memoryLeak')).toBe(false)
  })
})
