import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import { COLOR } from '../core/theme'
import type { DistrictId, Explainer, SimState } from '../core/types'
import { DISTRICTS } from '../world/layout'

/* ============================================================================
 * THE INSPECTOR
 *
 * One selected mechanism, rendered from its Explainer: what it is, what it is
 * doing right now, and what this model is not telling you about it. The panel
 * reads only the registry and never the world or the simulation's internals.
 *
 * The caveats block is always drawn. An entry that claims no simplification
 * still gets the cluster-wide disclosure, because a reader who never sees the
 * word "model" will read the city as a measurement.
 * ==========================================================================*/

export interface Panel {
  update(s: SimState): void
  dispose(): void
}

/** Metric rows are re-read at this rate, not per frame: `metrics()` allocates. */
const METRIC_HZ = 8

const MODEL_CAVEAT =
  'K8Skylines is a model, not an emulator: no Kubernetes code runs in this page. Durations are scaled so a person can watch them and counts are cut to what fits one screen. This entry claims no further simplification.'

/**
 * District accent colours come from the palette, never from a stylesheet, so
 * the inspector cannot label a building with a hue the city does not use.
 */
const DISTRICT_COLOR: Record<DistrictId, number> = {
  client: COLOR.desired,
  apiserver: COLOR.api,
  etcd: COLOR.etcd,
  scheduler: COLOR.scheduler,
  controllers: COLOR.controller,
  nodes: COLOR.kubelet,
  network: COLOR.network,
  storage: COLOR.storage,
  registry: COLOR.image,
}

const DISTRICT_LABEL = new Map<DistrictId, string>()
for (const d of DISTRICTS) DISTRICT_LABEL.set(d.id, d.label)

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Explainer prose marks code spans with backticks, the way the district files
 * write them. Split rather than parse: nothing here ever becomes markup, so a
 * caption can never inject an element.
 */
function prose(target: HTMLElement, text: string): void {
  target.textContent = ''
  const parts = text.split('`')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue
    if (i % 2 === 1) target.appendChild(el('code', 'pnl-code', parts[i]))
    else target.appendChild(document.createTextNode(parts[i]))
  }
}

interface MetricRow {
  root: HTMLElement
  key: HTMLElement
  num: HTMLElement
  hint: HTMLElement
  lastKey: string
  lastVal: string
  lastHint: string
}

/**
 * Related entries: siblings under the same dotted or hyphenated id prefix come
 * first, then the rest of the district. `api.stage.authz` should offer the
 * other admission floors before it offers the image registry.
 */
function relatedTo(registry: Registry, entry: Explainer, limit: number): Explainer[] {
  const cut = Math.max(entry.id.lastIndexOf('.'), entry.id.lastIndexOf('-'))
  const prefix = cut > 0 ? entry.id.slice(0, cut) : ''
  const siblings: Explainer[] = []
  const rest: Explainer[] = []
  for (const e of registry.district(entry.district)) {
    if (e.id === entry.id) continue
    if (prefix && e.id.startsWith(prefix)) siblings.push(e)
    else rest.push(e)
  }
  siblings.sort((a, b) => a.title.localeCompare(b.title))
  rest.sort((a, b) => a.title.localeCompare(b.title))
  return siblings.concat(rest).slice(0, limit)
}

export function createPanel(bus: Bus, registry: Registry): Panel {
  /* Importable without a DOM so unit tests and tooling can load the module. */
  if (typeof document === 'undefined') {
    return { update: () => {}, dispose: () => {} }
  }
  const host = document.getElementById('panel')
  if (!host) {
    console.warn('[ui/panel] #panel is missing from the document; inspector disabled')
    return { update: () => {}, dispose: () => {} }
  }

  /* ------------------------------------------------------------------ shell */

  const article = el('article', 'pnl')

  const head = el('header', 'pnl-head')
  const eyebrow = el('div', 'pnl-eyebrow')
  const districtBtn = el('button', 'pnl-district')
  districtBtn.type = 'button'
  districtBtn.title = 'Frame this whole district'
  const closeBtn = el('button', 'pnl-close', '✕')
  closeBtn.type = 'button'
  closeBtn.title = 'Close (Esc)'
  closeBtn.setAttribute('aria-label', 'Close the inspector')
  eyebrow.append(districtBtn, closeBtn)

  const title = el('h2', 'pnl-title')
  const kubeName = el('code', 'pnl-kube')
  head.append(eyebrow, title, kubeName)

  const summary = el('p', 'pnl-summary')

  const metricsSec = el('section', 'pnl-sec pnl-metrics')
  const metricsHead = el('h3', 'pnl-h', 'Live')
  const metricsList = el('dl', 'pnl-mlist')
  metricsSec.append(metricsHead, metricsList)

  const detailSec = el('section', 'pnl-sec pnl-detail')

  const caveatSec = el('section', 'pnl-sec pnl-caveats')
  const caveatHead = el('h3', 'pnl-h', 'What this model simplifies')
  const caveatList = el('ul', 'pnl-clist')
  caveatSec.append(caveatHead, caveatList)

  const relatedSec = el('section', 'pnl-sec pnl-related')
  const relatedHead = el('h3', 'pnl-h', 'Related')
  const relatedChips = el('div', 'pnl-chips')
  relatedSec.append(relatedHead, relatedChips)

  const body = el('div', 'pnl-body')
  body.append(summary, metricsSec, detailSec, caveatSec, relatedSec)
  article.append(head, body)
  host.appendChild(article)
  host.hidden = true

  /* ------------------------------------------------------------------ state */

  let current: Explainer | undefined
  let isOpen = false
  let lastMetricAt = 0
  const rows: MetricRow[] = []

  const setOpen = (next: boolean): void => {
    if (next === isOpen) return
    isOpen = next
    host.hidden = !next
    if (next) document.documentElement.dataset.panel = 'open'
    else delete document.documentElement.dataset.panel
    bus.emit('overlay', { id: 'panel', open: next })
  }

  const close = (): void => {
    if (!isOpen) return
    current = undefined
    setOpen(false)
    bus.emit('blur', {})
  }

  /* ----------------------------------------------------------------- render */

  const unknown = (id: string): void => {
    current = undefined
    districtBtn.textContent = 'unregistered'
    districtBtn.disabled = true
    article.style.setProperty('--pnl-raw', hex(COLOR.failed))
    title.textContent = id
    kubeName.hidden = true
    summary.textContent =
      'Nothing in the registry explains this id. A mechanism with no Explainer is decoration, and decoration is a bug.'
    metricsSec.hidden = true
    detailSec.textContent = ''
    caveatList.textContent = ''
    caveatList.appendChild(el('li', undefined, MODEL_CAVEAT))
    relatedSec.hidden = true
    setOpen(true)
  }

  const render = (entry: Explainer): void => {
    current = entry
    const label = DISTRICT_LABEL.get(entry.district) ?? entry.district
    districtBtn.textContent = label
    districtBtn.disabled = false
    article.style.setProperty('--pnl-raw', hex(DISTRICT_COLOR[entry.district]))

    title.textContent = entry.title
    kubeName.hidden = !entry.kubeName
    if (entry.kubeName) kubeName.textContent = entry.kubeName

    prose(summary, entry.summary)

    detailSec.textContent = ''
    for (let i = 0; i < entry.detail.length; i++) {
      const p = el('p', 'pnl-p')
      prose(p, entry.detail[i])
      detailSec.appendChild(p)
    }

    caveatList.textContent = ''
    const caveats = entry.caveats && entry.caveats.length > 0 ? entry.caveats : [MODEL_CAVEAT]
    for (let i = 0; i < caveats.length; i++) {
      const li = el('li')
      prose(li, caveats[i])
      caveatList.appendChild(li)
    }

    relatedChips.textContent = ''
    const near = relatedTo(registry, entry, 10)
    relatedSec.hidden = near.length === 0
    for (let i = 0; i < near.length; i++) {
      const chip = el('button', 'pnl-chip', near[i].title)
      chip.type = 'button'
      chip.dataset.id = near[i].id
      chip.title = near[i].summary
      relatedChips.appendChild(chip)
    }

    /* A fresh entry starts at the top: the summary is the sentence that matters. */
    article.scrollTop = 0
    body.scrollTop = 0
    rows.length = 0
    metricsList.textContent = ''
    metricsSec.hidden = !entry.metrics
    lastMetricAt = 0
    setOpen(true)
  }

  const renderMetrics = (s: SimState): void => {
    const entry = current
    if (!entry || !entry.metrics) return
    let values
    try {
      values = entry.metrics(s)
    } catch (err) {
      console.error(`[ui/panel] metrics for "${entry.id}" threw`, err)
      metricsSec.hidden = true
      return
    }
    if (values.length === 0) {
      metricsSec.hidden = true
      return
    }
    metricsSec.hidden = false

    while (rows.length > values.length) {
      const dead = rows.pop()
      if (dead) dead.root.remove()
    }
    while (rows.length < values.length) {
      const root = el('div', 'pnl-mrow')
      const key = el('dt', 'pnl-mkey')
      const val = el('dd', 'pnl-mval')
      const num = el('span', 'pnl-mnum')
      const hint = el('span', 'pnl-mhint')
      hint.hidden = true
      val.append(num, hint)
      root.append(key, val)
      metricsList.appendChild(root)
      rows.push({ root, key, num, hint, lastKey: '', lastVal: '', lastHint: '' })
    }

    /* Touch the DOM only where a string actually changed: this runs forever. */
    for (let i = 0; i < values.length; i++) {
      const m = values[i]
      const row = rows[i]
      if (row.lastKey !== m.label) {
        row.lastKey = m.label
        row.key.textContent = m.label
      }
      if (row.lastVal !== m.value) {
        row.lastVal = m.value
        row.num.textContent = m.value
      }
      const hintText = m.hint ?? ''
      if (row.lastHint !== hintText) {
        row.lastHint = hintText
        row.hint.textContent = hintText
        row.hint.hidden = hintText === ''
      }
    }
  }

  /* ---------------------------------------------------------------- wiring */

  const offFocus = bus.on('focus', ({ id }) => {
    const entry = registry.get(id)
    if (entry) render(entry)
    else unknown(id)
  })

  const offBlur = bus.on('blur', () => {
    if (!isOpen) return
    current = undefined
    setOpen(false)
  })

  /* An overlay event naming this panel is an intent from elsewhere in the UI.
   * Only the close direction is honoured: opening needs an id to show. */
  const offOverlay = bus.on('overlay', (p) => {
    if (p.id === 'panel' && !p.open) close()
  })

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return
    if (target === closeBtn) {
      close()
      return
    }
    if (target === districtBtn && current) {
      bus.emit('focus-district', { id: current.district })
      return
    }
    const chip = target.closest('.pnl-chip')
    if (chip instanceof HTMLElement && chip.dataset.id) {
      bus.emit('focus', { id: chip.dataset.id, source: 'menu' })
    }
  }
  host.addEventListener('click', onClick)

  /* Keys typed at the inspector are the inspector's, not the camera's. */
  const onHostKey = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
    }
  }
  host.addEventListener('keydown', onHostKey)

  /* Bubble phase and defaultPrevented: a modal overlay that also wants Escape
   * listens in the capture phase and gets it first. */
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || !isOpen) return
    if (ev.key !== 'Escape') return
    close()
  }
  window.addEventListener('keydown', onKey)

  return {
    update(s: SimState): void {
      if (!isOpen || !current || !current.metrics) return
      const now = performance.now()
      if (now - lastMetricAt < 1000 / METRIC_HZ) return
      lastMetricAt = now
      renderMetrics(s)
    },
    dispose(): void {
      offFocus()
      offBlur()
      offOverlay()
      host.removeEventListener('click', onClick)
      host.removeEventListener('keydown', onHostKey)
      window.removeEventListener('keydown', onKey)
      host.textContent = ''
      host.hidden = true
      delete document.documentElement.dataset.panel
      rows.length = 0
      current = undefined
      isOpen = false
    },
  }
}
