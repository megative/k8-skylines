/* ============================================================================
 * src/ui/hud.ts — the cluster's instrument panel.
 *
 * The HUD reads `SimState` and writes text. It never mutates the model, and it
 * never merges two fields that Kubernetes keeps apart: requested, allocatable
 * and used appear side by side on the same track precisely because conflating
 * them is the misunderstanding this project exists to fix.
 *
 * Everything here is built once. `update()` compares a number against the last
 * one it wrote and returns early when nothing moved, so a steady cluster costs
 * no DOM writes and no allocations; a string is formatted only on the frame a
 * value actually changes.
 * ==========================================================================*/

import type { Bus } from '../core/bus'
import { registry } from '../core/registry'
import { ETCD_QUORUM, type SimState } from '../core/types'
import { clamp, formatAge, formatCpu, formatMem, formatMs } from '../core/util'

export interface Hud {
  update(s: SimState, dt: number): void
  dispose(): void
}

/* A human cannot read faster than this, and the 3D scene wants the frame. */
const REFRESH_SECONDS = 1 / 12
const TICKER_ROWS = 6
const TOAST_SECONDS = 5
const TOAST_MAX = 4

/* ---------------------------------------------------------------------------
 * Cells. Each owns one node and the last value it wrote there.
 * -------------------------------------------------------------------------*/

const asInt = (v: number): string => String(v)
const asPct = (v: number): string => `${Math.round(v * 100)}%`
const asRate = (v: number): string => (v >= 100 ? String(Math.round(v)) : v.toFixed(1))

class Num {
  private last = Number.NaN
  constructor(
    private readonly node: HTMLElement,
    private readonly fmt: (v: number) => string = asInt,
  ) {}

  set(v: number): void {
    if (v === this.last) return
    this.last = v
    this.node.textContent = this.fmt(v)
  }
}

/** Enumerated text. Callers pass string literals, so `set` allocates nothing. */
class Label {
  private last: string | null = null
  constructor(private readonly node: HTMLElement) {}

  set(v: string): void {
    if (v === this.last) return
    this.last = v
    this.node.textContent = v
  }
}

class Flag {
  private last: boolean | null = null
  constructor(
    private readonly node: HTMLElement,
    private readonly cls: string,
  ) {}

  set(on: boolean): void {
    if (on === this.last) return
    this.last = on
    this.node.classList.toggle(this.cls, on)
  }
}

/** A 0..1 fraction written to one length property, quantized to 0.2%. */
class Frac {
  private last = -1
  constructor(
    private readonly node: HTMLElement,
    private readonly prop: 'width' | 'left',
  ) {}

  set(f: number): void {
    const q = Math.round(clamp(f, 0, 1) * 500)
    if (q === this.last) return
    this.last = q
    this.node.style[this.prop] = `${(q * 0.2).toFixed(1)}%`
  }
}

/* ---------------------------------------------------------------------------
 * Build-time DOM helpers. None of these run after the HUD exists.
 * -------------------------------------------------------------------------*/

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function panel(parent: HTMLElement, title: string, hue: string): HTMLElement {
  const sec = make('section', 'hud-panel')
  sec.style.setProperty('--hue', hue)
  const head = make('div', 'hud-panel-head')
  head.append(make('h2', 'hud-panel-title', title))
  sec.append(head)
  parent.append(sec)
  return sec
}

function hint(parent: HTMLElement, text: string): void {
  parent.append(make('p', 'hud-hint', text))
}

/** `LABEL  value` line. Returns the value node. */
function line(parent: HTMLElement, label: string, cls = ''): HTMLElement {
  const row = make('div', 'hud-line')
  row.append(make('span', 'hud-k', label))
  const v = make('span', `hud-v ${cls}`)
  row.append(v)
  parent.append(row)
  return v
}

/** `n / d` with the denominator visibly subordinate. */
function ratio(
  parent: HTMLElement,
  fmt: (v: number) => string = asInt,
): { num: Num; den: Num } {
  const n = make('span', 'hud-n')
  const d = make('span', 'hud-d')
  parent.append(n, make('span', 'hud-sep', '/'), d)
  return { num: new Num(n, fmt), den: new Num(d, fmt) }
}

interface Gauge {
  req: Num
  alloc: Num
  pct: Num
  bar: Frac
  used: Frac
  usedText: Num
  over: Flag
}

/**
 * Requested against allocatable, with actual usage marked on the same track.
 * The bar is what the scheduler subtracts from; the tick is what the kernel
 * sees. They are deliberately different marks because they are different facts.
 */
function gauge(parent: HTMLElement, label: string, hue: string, fmt: (v: number) => string): Gauge {
  const g = make('div', 'hud-gauge')
  g.style.setProperty('--hue', hue)

  const head = make('div', 'hud-line')
  head.append(make('span', 'hud-k', label))
  const val = make('span', 'hud-v')
  const r = ratio(val, fmt)
  head.append(val)
  g.append(head)

  const track = make('div', 'hud-track')
  const fill = make('div', 'hud-fill')
  const tick = make('div', 'hud-tick')
  track.append(fill, tick)
  g.append(track)

  const foot = make('div', 'hud-foot')
  const usedWrap = make('span', 'hud-used')
  usedWrap.append(make('span', 'hud-k', 'used'))
  const usedVal = make('span', '', '')
  usedWrap.append(usedVal)
  const pct = make('span', 'hud-pct')
  foot.append(usedWrap, pct)
  g.append(foot)

  parent.append(g)
  return {
    req: r.num,
    alloc: r.den,
    pct: new Num(pct, asPct),
    bar: new Frac(fill, 'width'),
    used: new Frac(tick, 'left'),
    usedText: new Num(usedVal, fmt),
    over: new Flag(g, 'over'),
  }
}

interface QueueRow {
  count: Num
  bar: Frac
}

function queueRow(parent: HTMLElement, label: string, hue: string): QueueRow {
  const row = make('div', 'hud-queue')
  row.style.setProperty('--hue', hue)
  row.append(make('span', 'hud-k', label))
  const track = make('div', 'hud-track thin')
  const fill = make('div', 'hud-fill')
  track.append(fill)
  const n = make('span', 'hud-n small')
  row.append(track, n)
  parent.append(row)
  return { count: new Num(n), bar: new Frac(fill, 'width') }
}

interface TickerRow {
  age: Num
  reason: Label
  involved: Label
  message: Label
  count: Num
  countShown: Flag
  warn: Flag
  shown: Flag
  lastId: number
  lastCount: number
}

function tickerRow(parent: HTMLElement): TickerRow {
  const row = make('div', 'hud-ev')
  const age = make('span', 'hud-ev-age')
  const reason = make('span', 'hud-ev-reason')
  const involved = make('span', 'hud-ev-obj')
  const message = make('span', 'hud-ev-msg')
  const count = make('span', 'hud-ev-count')
  row.append(age, reason, involved, message, count)
  parent.append(row)
  return {
    age: new Num(age, formatAge),
    reason: new Label(reason),
    involved: new Label(involved),
    message: new Label(message),
    count: new Num(count),
    countShown: new Flag(count, 'on'),
    warn: new Flag(row, 'warn'),
    shown: new Flag(row, 'on'),
    lastId: -1,
    lastCount: -1,
  }
}

/* ---------------------------------------------------------------------------
 * The HUD.
 * -------------------------------------------------------------------------*/

export function createHud(bus: Bus): Hud {
  const top = document.getElementById('hud-top')
  const left = document.getElementById('hud-left')
  const right = document.getElementById('hud-right')
  const bottom = document.getElementById('hud-bottom')
  const toastHost = document.getElementById('toasts')
  if (!top || !left || !right || !bottom) {
    throw new Error('hud: #hud-top, #hud-left, #hud-right and #hud-bottom must exist')
  }

  /* ---- top strip: what the cluster is doing right now ------------------- */

  const strip = make('div', 'hud-strip')
  top.append(strip)

  const brand = make('div', 'hud-brand')
  brand.append(make('span', 'hud-brand-mark', 'K8'), make('span', 'hud-brand-word', 'SKYLINES'))
  strip.append(brand)

  const nodesCell = make('div', 'hud-cell')
  nodesCell.append(make('span', 'hud-k', 'nodes'))
  const nodesVal = make('span', 'hud-v')
  const nodes = ratio(nodesVal)
  nodesVal.append(make('span', 'hud-t', 'Ready'))
  nodesCell.append(nodesVal)
  strip.append(nodesCell)
  const nodesDegraded = new Flag(nodesCell, 'bad')

  const phaseCell = make('div', 'hud-cell hud-phases')
  phaseCell.append(make('span', 'hud-k', 'pods'))
  const chip = (phase: string, label: string): Num => {
    const c = make('span', 'hud-chip')
    c.dataset.phase = phase
    const n = make('b')
    c.append(make('i', 'hud-dot'), n, make('span', 'hud-chip-label', label))
    phaseCell.append(c)
    return new Num(n)
  }
  const podsRunning = chip('running', 'Running')
  const podsPending = chip('pending', 'Pending')
  const podsFailed = chip('failed', 'Failed')
  const podsTerminating = chip('terminating', 'Terminating')
  strip.append(phaseCell)

  const restartsCell = make('div', 'hud-cell')
  restartsCell.append(make('span', 'hud-k', 'restarts'))
  const restartsNode = make('span', 'hud-v')
  restartsCell.append(restartsNode)
  strip.append(restartsCell)
  const restarts = new Num(restartsNode)
  const restartsHot = new Flag(restartsCell, 'warn')

  const clockCell = make('div', 'hud-cell')
  clockCell.append(make('span', 'hud-k', 'cluster age'))
  const clockNode = make('span', 'hud-v')
  clockCell.append(clockNode)
  strip.append(clockCell)
  const clock = new Num(clockNode, formatAge)

  strip.append(make('div', 'hud-spacer'))

  const transportCell = make('div', 'hud-cell hud-transport')
  const transportIcon = make('span', 'hud-transport-icon')
  const transportState = make('span', 'hud-transport-state')
  const transportScale = make('span', 'hud-transport-scale')
  transportCell.append(transportIcon, transportState, transportScale)
  strip.append(transportCell)
  const transportPaused = new Flag(transportCell, 'paused')
  const transportGlyph = new Label(transportIcon)
  const transportLabel = new Label(transportState)
  const transportRate = new Num(transportScale, (v) => `${v}×`)

  const selCell = make('div', 'hud-cell hud-selected')
  selCell.append(make('span', 'hud-k', 'selected'))
  const selName = make('span', 'hud-v')
  const selKube = make('span', 'hud-t')
  selCell.append(selName, selKube)
  strip.append(selCell)

  /* ---- left column: what the scheduler is allowed to hand out ----------- */

  const capacity = panel(left, 'Capacity', 'var(--k8-desired)')
  hint(
    capacity,
    'Requests schedule; limits kill. The bar is the sum of pod requests against allocatable (capacity minus kube-reserved); the tick is what the containers actually use.',
  )
  const cpu = gauge(capacity, 'cpu requested', 'var(--k8-scheduler)', formatCpu)
  const mem = gauge(capacity, 'memory requested', 'var(--k8-kubelet)', formatMem)
  hint(
    capacity,
    'Cluster totals hide fragmentation: a pod schedules only if one single node has room for it.',
  )

  const sched = panel(left, 'Scheduler queues', 'var(--k8-scheduler)')
  const qActive = queueRow(sched, 'active', 'var(--k8-scheduler)')
  const qBackoff = queueRow(sched, 'backoff', 'var(--k8-backoff)')
  const qUnsched = queueRow(sched, 'unschedulable', 'var(--k8-failed)')
  const schedFoot = make('div', 'hud-line hud-sub')
  schedFoot.append(make('span', 'hud-k', 'bound'))
  const schedBoundNode = make('span', 'hud-v small')
  schedFoot.append(schedBoundNode, make('span', 'hud-k', 'failed'))
  const schedFailedNode = make('span', 'hud-v small')
  schedFoot.append(schedFailedNode, make('span', 'hud-k', 'p50'))
  const schedLatNode = make('span', 'hud-v small')
  schedFoot.append(schedLatNode)
  sched.append(schedFoot)
  const schedBound = new Num(schedBoundNode)
  const schedFailed = new Num(schedFailedNode)
  const schedLatency = new Num(schedLatNode, formatMs)
  hint(
    sched,
    'Pending is a verdict, not a place in a line: every node failed a filter, and the reason is on the pod.',
  )

  /* ---- right column: the control plane --------------------------------- */

  const etcdPanel = panel(right, 'etcd', 'var(--k8-etcd)')
  const revVal = line(etcdPanel, 'revision', 'mono big')
  const revision = new Num(revVal)
  const quorumVal = line(etcdPanel, 'members up')
  const quorumRatio = ratio(quorumVal)
  const quorumBadge = make('span', 'hud-badge')
  quorumVal.append(quorumBadge)
  const quorumLabel = new Label(quorumBadge)
  const quorumLost = new Flag(etcdPanel, 'bad')
  const dbVal = line(etcdPanel, 'db size')
  const db = ratio(dbVal, (v) => `${v.toFixed(0)}Mi`)
  const dbTrack = make('div', 'hud-track thin')
  const dbFill = make('div', 'hud-fill')
  dbTrack.append(dbFill)
  etcdPanel.append(dbTrack)
  const dbBar = new Frac(dbFill, 'width')
  const etcdFoot = make('div', 'hud-line hud-sub')
  etcdFoot.append(make('span', 'hud-k', 'writes'))
  const etcdWritesNode = make('span', 'hud-v small')
  etcdFoot.append(etcdWritesNode, make('span', 'hud-k', 'quorum read'))
  const etcdReadNode = make('span', 'hud-v small')
  etcdFoot.append(etcdReadNode, make('span', 'hud-k', 'watchers'))
  const etcdWatchNode = make('span', 'hud-v small')
  etcdFoot.append(etcdWatchNode)
  etcdPanel.append(etcdFoot)
  const etcdWrites = new Num(etcdWritesNode, (v) => `${asRate(v)}/s`)
  const etcdRead = new Num(etcdReadNode, formatMs)
  const etcdWatchers = new Num(etcdWatchNode)
  const alarmRow = make('p', 'hud-alarm')
  etcdPanel.append(alarmRow)
  const alarmShown = new Flag(alarmRow, 'on')
  const alarmText = new Label(alarmRow)
  hint(
    etcdPanel,
    `A write commits only once ${ETCD_QUORUM} of the members have persisted it. Below quorum the store is read-only and every create, update and delete fails.`,
  )

  const apiPanel = panel(right, 'kube-apiserver', 'var(--k8-api)')
  const rpsVal = line(apiPanel, 'requests', 'mono big')
  const rpsNode = make('span')
  const readOnly = make('span', 'hud-badge bad', 'read-only')
  rpsVal.append(rpsNode, readOnly)
  const rps = new Num(rpsNode, (v) => `${asRate(v)}/s`)
  const readOnlyShown = new Flag(readOnly, 'on')

  const mixTrack = make('div', 'hud-mix')
  apiPanel.append(mixTrack)
  const OUTCOMES = ['ok', 'forbidden', 'unauthorized', 'rejected', 'conflict'] as const
  const mixSegs: Frac[] = []
  const mixCounts: Num[] = []
  const mixLegend = make('div', 'hud-legend')
  for (let i = 0; i < OUTCOMES.length; i++) {
    const name = OUTCOMES[i]!
    const seg = make('span', 'hud-seg')
    seg.dataset.outcome = name
    mixTrack.append(seg)
    mixSegs.push(new Frac(seg, 'width'))

    const item = make('span', 'hud-legend-item')
    item.dataset.outcome = name
    const n = make('b')
    item.append(make('i', 'hud-dot'), n, make('span', '', name))
    mixLegend.append(item)
    mixCounts.push(new Num(n))
  }
  apiPanel.append(mixLegend)

  const apfVal = line(apiPanel, 'APF seats')
  const apf = ratio(apfVal)
  const apiFoot = make('div', 'hud-line hud-sub')
  apiFoot.append(make('span', 'hud-k', 'throttled'))
  const throttledNode = make('span', 'hud-v small')
  apiFoot.append(throttledNode, make('span', 'hud-k', 'watches'))
  const watchNode = make('span', 'hud-v small')
  apiFoot.append(watchNode, make('span', 'hud-k', 'cache lag'))
  const lagNode = make('span', 'hud-v small')
  apiFoot.append(lagNode)
  apiPanel.append(apiFoot)
  const throttled = new Num(throttledNode)
  const watches = new Num(watchNode)
  const cacheLag = new Num(lagNode, (v) => `${v} rev`)
  const lagHot = new Flag(apiFoot, 'warn')
  hint(
    apiPanel,
    'Every component reads and writes through this one door, and watch is a streamed read the API server serves from its cache.',
  )

  /* ---- bottom: the cluster narrating itself ---------------------------- */

  const ticker = make('div', 'hud-ticker')
  const tickerHead = make('div', 'hud-ticker-head')
  tickerHead.append(make('span', 'hud-k', 'events'))
  tickerHead.append(
    make('span', 'hud-hint inline', 'kubectl get events — Warning stands out, count aggregates'),
  )
  ticker.append(tickerHead)
  const rows: TickerRow[] = []
  for (let i = 0; i < TICKER_ROWS; i++) rows.push(tickerRow(ticker))
  bottom.append(ticker)

  /* ---- selection and toasts, both event driven ------------------------- */

  const setSelection = (id: string | null): void => {
    if (id === null) {
      selName.textContent = 'nothing'
      selKube.textContent = ''
      selCell.classList.remove('on')
      return
    }
    const entry = registry.get(id)
    selName.textContent = entry ? entry.title : id
    selKube.textContent = entry?.kubeName ?? ''
    selCell.classList.add('on')
  }
  setSelection(null)

  const offFocus = bus.on('focus', (p) => setSelection(p.id))
  const offBlur = bus.on('blur', () => setSelection(null))

  const timers = new Set<number>()
  const offToast = bus.on('toast', (p) => {
    if (!toastHost) return
    while (toastHost.childElementCount >= TOAST_MAX) toastHost.firstElementChild?.remove()
    const el = make('div', `hud-toast ${p.kind}`, p.text)
    toastHost.append(el)
    const id = window.setTimeout(() => {
      timers.delete(id)
      el.remove()
    }, TOAST_SECONDS * 1000)
    timers.add(id)
  })

  /* ---- the frame path -------------------------------------------------- */

  let acc = REFRESH_SECONDS

  function update(s: SimState, dt: number): void {
    acc += dt
    if (acc < REFRESH_SECONDS) return
    /* Reset rather than subtract: a backgrounded tab must not come back and
     * run a burst of catch-up repaints nobody was there to read. */
    acc = 0

    const t = s.totals

    nodes.num.set(t.nodesReady)
    nodes.den.set(s.nodes.length)
    nodesDegraded.set(t.nodesReady < s.nodes.length)

    podsRunning.set(t.podsRunning)
    podsPending.set(t.podsPending)
    podsFailed.set(t.podsFailed)
    podsTerminating.set(t.podsTerminating)
    restarts.set(t.restarts)
    restartsHot.set(t.restarts > 0)
    clock.set(Math.floor(s.t))

    const paused = s.knobs.paused
    transportPaused.set(paused)
    transportLabel.set(paused ? 'paused' : 'running')
    transportGlyph.set(paused ? '❚❚' : '▶')
    transportRate.set(s.knobs.timeScale)

    /* Cluster usage is summed here rather than stored: SimState reports what
     * schedules (requests), and what runs (used) lives on the nodes. */
    let usedCpu = 0
    let usedMem = 0
    for (let i = 0; i < s.nodes.length; i++) {
      const n = s.nodes[i]!
      usedCpu += n.usedCpuMilli
      usedMem += n.usedMemMib
    }

    const cpuAlloc = Math.max(1, t.cpuAllocatableMilli)
    cpu.req.set(t.cpuRequestedMilli)
    cpu.alloc.set(t.cpuAllocatableMilli)
    cpu.bar.set(t.cpuRequestedMilli / cpuAlloc)
    cpu.pct.set(t.cpuRequestedMilli / cpuAlloc)
    cpu.used.set(usedCpu / cpuAlloc)
    cpu.usedText.set(Math.round(usedCpu))
    cpu.over.set(t.cpuRequestedMilli > t.cpuAllocatableMilli)

    const memAlloc = Math.max(1, t.memAllocatableMib)
    mem.req.set(t.memRequestedMib)
    mem.alloc.set(t.memAllocatableMib)
    mem.bar.set(t.memRequestedMib / memAlloc)
    mem.pct.set(t.memRequestedMib / memAlloc)
    mem.used.set(usedMem / memAlloc)
    mem.usedText.set(Math.round(usedMem))
    mem.over.set(t.memRequestedMib > t.memAllocatableMib)

    const sc = s.scheduler
    const qMax = Math.max(4, sc.activeQueue.length, sc.backoffQueue.length, sc.unschedulableQueue.length)
    qActive.count.set(sc.activeQueue.length)
    qActive.bar.set(sc.activeQueue.length / qMax)
    qBackoff.count.set(sc.backoffQueue.length)
    qBackoff.bar.set(sc.backoffQueue.length / qMax)
    qUnsched.count.set(sc.unschedulableQueue.length)
    qUnsched.bar.set(sc.unschedulableQueue.length / qMax)
    schedBound.set(sc.scheduled)
    schedFailed.set(sc.failed)
    schedLatency.set(Math.round(sc.latencyMs))

    const e = s.etcd
    revision.set(e.revision)
    let up = 0
    for (let i = 0; i < e.members.length; i++) if (e.members[i]!.role !== 'down') up++
    quorumRatio.num.set(up)
    quorumRatio.den.set(e.members.length)
    quorumLabel.set(e.hasQuorum ? 'quorum' : 'NO QUORUM')
    quorumLost.set(!e.hasQuorum)
    db.num.set(Math.round(e.dbSizeMib))
    db.den.set(e.dbQuotaMib)
    dbBar.set(e.dbSizeMib / Math.max(1, e.dbQuotaMib))
    etcdWrites.set(Math.round(e.writesPerSec * 10) / 10)
    etcdRead.set(Math.round(e.readLatencyMs * 10) / 10)
    etcdWatchers.set(e.watchers)
    alarmShown.set(e.alarm !== 'none')
    alarmText.set(
      e.alarm === 'NOSPACE'
        ? 'alarm NOSPACE — the backend quota is exceeded and the cluster is read-only until it is defragmented and the alarm disarmed'
        : e.alarm === 'CORRUPT'
          ? 'alarm CORRUPT — a member reports a mismatched hash of the keyspace'
          : '',
    )

    const a = s.api
    rps.set(Math.round(a.requestsPerSec * 10) / 10)
    readOnlyShown.set(!a.writable)
    let total = 0
    for (let i = 0; i < OUTCOMES.length; i++) total += a.counts[OUTCOMES[i]!]
    const denom = Math.max(1, total)
    for (let i = 0; i < OUTCOMES.length; i++) {
      const c = a.counts[OUTCOMES[i]!]
      mixSegs[i]!.set(c / denom)
      mixCounts[i]!.set(c)
    }
    apf.num.set(a.apfSeatsUsed)
    apf.den.set(a.apfSeatsTotal)
    throttled.set(a.throttled)
    watches.set(a.watchConnections)
    const lag = Math.max(0, e.revision - a.watchCacheRevision)
    cacheLag.set(lag)
    lagHot.set(lag > 5)

    const evs = s.events
    for (let i = 0; i < TICKER_ROWS; i++) {
      const row = rows[i]!
      const ev = evs[evs.length - 1 - i]
      if (!ev) {
        row.shown.set(false)
        continue
      }
      row.shown.set(true)
      if (row.lastId !== ev.id || row.lastCount !== ev.count) {
        row.lastId = ev.id
        row.lastCount = ev.count
        row.reason.set(ev.reason)
        row.involved.set(ev.involved)
        row.message.set(ev.message)
        row.count.set(ev.count)
        row.countShown.set(ev.count > 1)
        row.warn.set(ev.type === 'Warning')
      }
      row.age.set(Math.max(0, Math.floor(s.t - ev.at)))
    }
  }

  function dispose(): void {
    offFocus()
    offBlur()
    offToast()
    for (const id of timers) window.clearTimeout(id)
    timers.clear()
    top!.replaceChildren()
    left!.replaceChildren()
    right!.replaceChildren()
    bottom!.replaceChildren()
    toastHost?.replaceChildren()
  }

  return { update, dispose }
}
