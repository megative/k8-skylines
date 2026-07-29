import type { Bus } from '../core/bus'
import type { ScenarioCategory, ScenarioDef, ScenarioStep, SimState } from '../core/types'
import { SCENARIOS } from '../sim/scenarios'
import '../styles/scenarios.css'

/* ============================================================================
 * THE FAILURE CURRICULUM, BROWSABLE
 *
 * The scenarios were reachable only by typing their names into the command
 * palette, which meant a reader had to already know what the cluster could be
 * asked to break. This panel is the index: every pathology grouped by the part
 * of the cluster it happens in, each one showing the line `kubectl` prints when
 * you meet it in real life.
 *
 * While a scenario runs the panel narrates it the way the tour narrates a
 * chapter — the beats are walked by *model* time, not wall-clock, so pausing
 * the simulation pauses the story and the time scale speeds both up together.
 * Each beat moves the camera to the place where the next thing goes wrong.
 *
 * Nothing here simulates anything. The panel emits `scenario` intents and the
 * model decides; it also listens for that same event, so a scenario started
 * from the palette or by the tour is narrated exactly as if it had been started
 * from this list.
 * ==========================================================================*/

export interface ScenarioBrowser {
  update(s: SimState, dt: number): void
  dispose(): void
}

/* ---------------------------------------------------------------------------
 * Sections. A category takes the hue of the district it teaches, because a
 * colour that names no mechanism is decoration. The hues themselves live in
 * tokens.css and are applied by CSS from `data-category`.
 * -------------------------------------------------------------------------*/

interface Section {
  id: ScenarioCategory
  label: string
  note: string
}

const SECTIONS: readonly Section[] = [
  {
    id: 'workload',
    label: 'Workloads',
    note: 'The object exists and a node has it. Everything that goes wrong after that: images, exit codes, memory limits, probes, and rollouts that will not finish.',
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    note: 'Why a pod stays Pending. Every verdict here is arithmetic against requests and allocatable, never against what a container is using.',
  },
  {
    id: 'node',
    label: 'Nodes',
    note: 'A machine stops renewing its Lease, runs out of memory, or is drained on purpose. The timers that follow are the lesson.',
  },
  {
    id: 'control-plane',
    label: 'Control plane',
    note: 'etcd, the API server, and the loops that depend on both. While this is broken the pods that are already running keep running, and nothing new is decided.',
  },
  {
    id: 'network',
    label: 'Networking',
    note: 'Services, EndpointSlices, DNS and the ingress path: the chain between a name and a container that is willing to answer.',
  },
  {
    id: 'storage',
    label: 'Storage',
    note: 'Claims, binding, attach and mount. A volume that will not mount stops a pod before its first container has run at all.',
  },
]

/** Anything whose category this file does not know about still gets a home. */
const FALLBACK_SECTION: Section = {
  id: 'workload',
  label: 'Elsewhere',
  note: 'Scenarios whose category this panel does not recognise.',
}

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id))

/** Shared empty list: a `?? []` in the frame loop would allocate one per frame. */
const NO_STEPS: readonly ScenarioStep[] = []

/* ---------------------------------------------------------------------------
 * Small helpers. None of these run per frame.
 * -------------------------------------------------------------------------*/

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

/** Prose marks code spans with backticks. Split, never parse: no markup here. */
function prose(target: HTMLElement, text: string): void {
  target.textContent = ''
  const parts = text.split('`')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue
    if (i % 2 === 1) target.appendChild(el('code', 'scn-code', parts[i]))
    else target.appendChild(document.createTextNode(parts[i]))
  }
}

/** A stopwatch, not kubectl's age column: this is a duration being watched. */
function clock(seconds: number): string {
  const whole = seconds > 0 ? Math.round(seconds) : 0
  const mins = Math.floor(whole / 60)
  const secs = whole % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

/** The last beat is a floor on the runtime when no duration was declared. */
function lastBeatAt(def: ScenarioDef): number {
  const steps = def.steps ?? NO_STEPS
  return steps.length > 0 ? steps[steps.length - 1]!.at : 0
}

function runtimeOf(def: ScenarioDef): number {
  return def.durationSeconds ?? lastBeatAt(def)
}

export function createScenarioBrowser(bus: Bus): ScenarioBrowser {
  const inert: ScenarioBrowser = { update: () => {}, dispose: () => {} }
  if (typeof document === 'undefined') return inert

  /* The panel owns its container. index.html knows nothing about it, so a
   * document that has one already (a test harness, a future shell) is reused
   * rather than duplicated. */
  let host = document.getElementById('scenarios')
  if (!host) {
    const body = document.body
    if (!body) {
      console.warn('[ui/scenarios] no document.body to mount into; browser disabled')
      return inert
    }
    host = el('div')
    host.id = 'scenarios'
    body.appendChild(host)
  }
  host.className = 'overlay scn-host'
  host.hidden = true

  /* ------------------------------------------------------------------ shell */

  const scrim = el('div', 'scn-scrim')
  scrim.dataset.act = 'close'

  const sheet = el('div', 'scn-sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-label', 'Failure scenarios')
  sheet.tabIndex = -1

  const head = el('div', 'scn-head')
  const heading = el('div', 'scn-heading')
  const title = el('h2', 'scn-title', 'The failure curriculum')
  const count = el('span', 'scn-count')
  heading.append(title, count)
  const close = el('button', 'scn-close', '×')
  close.type = 'button'
  close.dataset.act = 'close'
  close.title = 'Close (Esc)'
  close.setAttribute('aria-label', 'Close the scenario list')
  head.append(heading, close)

  const intro = el('p', 'scn-intro')
  prose(
    intro,
    'Nobody needs a visualization of a healthy cluster. Every scenario below is a pathology an on-call engineer has been paged for, staged so it propagates through the city in the correct order and with the correct delay. Starting one turns knobs and writes objects; the cluster’s own loops do the rest, and stopping puts the knobs back the way the scenario found them.',
  )

  const body = el('div', 'scn-body')
  const list = el('div', 'scn-list')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Scenarios')
  const detail = el('div', 'scn-detail')
  body.append(list, detail)

  const foot = el('div', 'scn-foot')
  const hint = el('span', 'scn-hint', '↑ ↓ choose · Enter runs it · Esc closes · B reopens this list')
  const footRun = el('div', 'scn-foot-run')
  const footLabel = el('span', 'scn-foot-label')
  const footClock = el('span', 'scn-clock')
  const footStop = el('button', 'scn-btn scn-btn-stop', 'Stop')
  footStop.type = 'button'
  footStop.dataset.act = 'stop'
  footRun.append(footLabel, footClock, footStop)
  footRun.hidden = true
  foot.append(hint, footRun)

  sheet.append(head, intro, body, foot)

  /* ------------------------------------------------------- the running band */

  /* When the list is closed the narration keeps going in a strip over the city,
   * because the whole point of a scenario is the thing happening behind it. */
  const band = el('div', 'scn-band')
  band.setAttribute('role', 'status')
  const bandCard = el('div', 'scn-band-card')
  const bandRail = el('div', 'scn-rail')
  const bandHead = el('div', 'scn-band-head')
  const bandEyebrow = el('span', 'scn-eyebrow')
  const bandTitle = el('span', 'scn-band-title')
  const bandClock = el('span', 'scn-clock')
  bandHead.append(bandEyebrow, bandTitle, bandClock)
  const bandBeat = el('p', 'scn-band-beat')
  const bandBar = el('div', 'scn-bar')
  const bandFill = el('div', 'scn-bar-fill')
  bandBar.appendChild(bandFill)
  const bandFoot = el('div', 'scn-band-foot')
  const bandStop = el('button', 'scn-btn scn-btn-stop', 'Stop')
  bandStop.type = 'button'
  bandStop.dataset.act = 'stop'
  const bandOpen = el('button', 'scn-btn', 'All scenarios')
  bandOpen.type = 'button'
  bandOpen.dataset.act = 'open'
  const bandBack = el('button', 'scn-btn', '‹ Back')
  bandBack.type = 'button'
  bandBack.dataset.act = 'back'
  bandBack.title = 'Replay from the start up to the previous beat (←)'
  const bandNext = el('button', 'scn-btn scn-btn-run', 'Next ›')
  bandNext.type = 'button'
  bandNext.dataset.act = 'next'
  bandNext.title = 'Let the cluster run on to the next beat (→ or Space)'
  const bandPlay = el('button', 'scn-btn', 'Play')
  bandPlay.type = 'button'
  bandPlay.dataset.act = 'play'
  bandPlay.title = 'Stop stepping and let the whole thing play out'
  const bandStep = el('span', 'scn-clock')

  const bandHint = el(
    'span',
    'scn-hint',
    '[ and ] walk the beats · the cluster is held still between them · Play lets it run out.',
  )
  bandFoot.append(bandBack, bandNext, bandPlay, bandStep, bandStop, bandOpen, bandHint)
  bandCard.append(bandRail, bandHead, bandBeat, bandBar, bandFoot)
  band.appendChild(bandCard)
  band.hidden = true

  host.append(scrim, sheet, band)

  /* ------------------------------------------------------------------ state */

  const catalogue: readonly ScenarioDef[] = SCENARIOS
  /** Rows in list order, which is also the order the arrow keys walk. */
  const rows: HTMLElement[] = []
  const defs: ScenarioDef[] = []

  let sheetOpen = false
  let tourOpen = false
  /** Another modal owns the keyboard while it is up. */
  let blocked = false

  let selected = -1
  let runningIndex = -1
  let runDuration = 0
  /** Model seconds at which the running scenario began. NaN until the first tick. */
  let startT = Number.NaN
  let beat = -1
  let lastSec = -1
  let lastFill = -1

  /*
   * Stepping. A failure that plays out on a timer is a video; the reader wants
   * to stand inside each beat, turn the camera, and move on when ready. So the
   * default is manual: the model runs only until the next beat is due and then
   * pauses itself, and Next releases it again.
   *
   * `targetBeat` is where the run is allowed to get to. Going back replays from
   * the start rather than rewinding, because the simulation is seeded and
   * deterministic but not reversible.
   */
  let stepMode = true
  let targetBeat = 0
  let lastTimeScale = 1

  /** Beat nodes, rebuilt when the detail pane or the running scenario changes. */
  let detailBeats: HTMLElement[] = []
  let bandDots: HTMLElement[] = []
  let detailClock: HTMLElement | null = null

  /* -------------------------------------------------------------- the list */

  const grouped = new Map<string, ScenarioDef[]>()
  for (const def of catalogue) {
    const key = SECTION_IDS.has(def.category) ? def.category : FALLBACK_SECTION.label
    const bucket = grouped.get(key)
    if (bucket) bucket.push(def)
    else grouped.set(key, [def])
  }

  const addRow = (def: ScenarioDef, index: number): void => {
    const row = el('button', 'scn-row')
    row.type = 'button'
    row.dataset.i = String(index)
    row.dataset.category = def.category
    row.setAttribute('role', 'option')

    const rowHead = el('div', 'scn-row-head')
    rowHead.appendChild(el('span', 'scn-row-title', def.title))
    const live = el('span', 'scn-row-live', 'running')
    rowHead.appendChild(live)
    row.appendChild(rowHead)

    const blurb = el('div', 'scn-row-blurb')
    prose(blurb, def.blurb)
    row.appendChild(blurb)

    if (def.symptom) row.appendChild(el('div', 'scn-row-symptom', def.symptom))

    list.appendChild(row)
    rows.push(row)
    defs.push(def)
  }

  for (const section of SECTIONS) {
    const bucket = grouped.get(section.id)
    if (!bucket || bucket.length === 0) continue
    const group = el('div', 'scn-group')
    group.dataset.category = section.id
    group.appendChild(el('h3', 'scn-group-label', section.label))
    group.appendChild(el('p', 'scn-group-note', section.note))
    list.appendChild(group)
    for (const def of bucket) addRow(def, defs.length)
  }
  const strays = grouped.get(FALLBACK_SECTION.label)
  if (strays && strays.length > 0) {
    const group = el('div', 'scn-group')
    group.appendChild(el('h3', 'scn-group-label', FALLBACK_SECTION.label))
    group.appendChild(el('p', 'scn-group-note', FALLBACK_SECTION.note))
    list.appendChild(group)
    for (const def of strays) addRow(def, defs.length)
  }

  count.textContent = `${defs.length} ways a cluster breaks`

  /* ------------------------------------------------------------ the detail */

  const detailSection = (parent: HTMLElement, label: string): HTMLElement => {
    const block = el('div', 'scn-block')
    block.appendChild(el('h4', 'scn-block-label', label))
    parent.appendChild(block)
    return block
  }

  const renderDetail = (): void => {
    detail.textContent = ''
    detailBeats = []
    detailClock = null

    const def = defs[selected]
    if (!def) {
      const empty = el('p', 'scn-empty')
      prose(
        empty,
        'Pick a scenario. Each one names the mechanism it breaks, the line `kubectl` prints when it breaks, and what an operator does next.',
      )
      detail.appendChild(empty)
      return
    }

    detail.dataset.category = def.category

    const eyebrow = el('div', 'scn-eyebrow')
    const section = SECTIONS.find((s) => s.id === def.category) ?? FALLBACK_SECTION
    eyebrow.textContent = section.label
    detail.appendChild(eyebrow)
    detail.appendChild(el('h3', 'scn-detail-title', def.title))

    const blurb = el('p', 'scn-detail-blurb')
    prose(blurb, def.blurb)
    detail.appendChild(blurb)

    if (def.symptom) {
      const block = detailSection(detail, 'What kubectl shows')
      block.appendChild(el('div', 'scn-symptom', def.symptom))
    }

    const watch = def.watchFor ?? []
    if (watch.length > 0) {
      const block = detailSection(detail, 'What to watch for')
      const ul = el('ul', 'scn-watch')
      for (const line of watch) {
        const li = el('li', 'scn-watch-item')
        prose(li, line)
        ul.appendChild(li)
      }
      block.appendChild(ul)
    }

    if (def.teaches) {
      const block = detailSection(detail, 'What it teaches')
      const p = el('p', 'scn-teaches')
      prose(p, def.teaches)
      block.appendChild(p)
    }

    /* Actions come before the beat list: the reader should not have to scroll
     * past the story to reach the button that starts it. */
    const actions = el('div', 'scn-actions')
    const run = el('button', 'scn-btn scn-btn-run', selected === runningIndex ? 'Run it again' : 'Run this scenario')
    run.type = 'button'
    run.dataset.act = 'run'
    const stop = el('button', 'scn-btn scn-btn-stop', 'Stop')
    stop.type = 'button'
    stop.dataset.act = 'stop'
    stop.disabled = runningIndex < 0
    actions.append(run, stop)

    const runtime = runtimeOf(def)
    const timing = el('span', 'scn-timing')
    if (def.durationSeconds !== undefined) {
      timing.textContent = `About ${clock(def.durationSeconds)} of model time`
    } else if (runtime > 0) {
      timing.textContent = `Last beat at ${clock(runtime)}; it keeps running until you stop it`
    } else {
      timing.textContent = 'Runs until you stop it'
    }
    actions.appendChild(timing)
    detail.appendChild(actions)

    if (selected === runningIndex) {
      const live = el('div', 'scn-live')
      live.appendChild(el('span', 'scn-live-dot'))
      live.appendChild(el('span', 'scn-live-label', 'Running now'))
      detailClock = el('span', 'scn-clock')
      live.appendChild(detailClock)
      detail.appendChild(live)
      lastSec = -1
    }

    const steps = def.steps ?? NO_STEPS
    if (steps.length > 0) {
      const block = detailSection(detail, 'How it plays out')
      const ol = el('ol', 'scn-beats')
      for (const step of steps) {
        const li = el('li', 'scn-beat')
        li.dataset.state = 'next'
        li.appendChild(el('span', 'scn-beat-at', clock(step.at)))
        const text = el('span', 'scn-beat-text')
        prose(text, step.text)
        li.appendChild(text)
        ol.appendChild(li)
        detailBeats.push(li)
      }
      block.appendChild(ol)
    }

    const note = el('p', 'scn-note')
    prose(
      note,
      'Times are model seconds. The time scale multiplies them, so a scenario runs through in less of your own time at 4× and stops advancing entirely while the simulation is paused.',
    )
    detail.appendChild(note)

    paintBeats()
  }

  /* ------------------------------------------------------------- narration */

  const paintBeats = (): void => {
    for (let i = 0; i < bandDots.length; i++) {
      bandDots[i]!.dataset.state = i < beat ? 'done' : i === beat ? 'now' : 'next'
    }
    if (selected !== runningIndex) return
    for (let i = 0; i < detailBeats.length; i++) {
      detailBeats[i]!.dataset.state = i < beat ? 'done' : i === beat ? 'now' : 'next'
    }
  }

  const showBeat = (): void => {
    const def = defs[runningIndex]
    const steps = def ? (def.steps ?? NO_STEPS) : NO_STEPS
    const step = beat >= 0 ? steps[beat] : undefined
    if (step) {
      prose(bandBeat, step.text)
      if (step.focus) bus.emit('focus', { id: step.focus, source: 'menu' })
    } else if (def) {
      prose(bandBeat, def.blurb)
    }
    paintBeats()
    if (detailBeats.length > 0 && selected === runningIndex) {
      const node = detailBeats[beat]
      if (node) node.scrollIntoView({ block: 'nearest' })
    }
  }

  /* ---------------------------------------------------------------- stepping */

  const stepsOf = (): readonly ScenarioStep[] =>
    runningIndex >= 0 ? (defs[runningIndex]!.steps ?? NO_STEPS) : NO_STEPS

  const syncStepUi = (): void => {
    const n = stepsOf().length
    const showStep = stepMode && n > 0
    bandBack.hidden = !showStep
    bandNext.hidden = !showStep
    bandPlay.hidden = n === 0
    bandStep.hidden = n === 0
    bandBack.disabled = beat <= 0
    bandNext.disabled = beat >= n - 1
    bandPlay.textContent = stepMode ? 'Play' : 'Step'
    bandStep.textContent = n > 0 ? `beat ${Math.min(n, Math.max(1, beat + 1))} of ${n}` : ''
  }

  /* The panel never writes the model. It asks, and main.ts decides. */
  const holdModel = (paused: boolean): void => {
    bus.emit('transport', { paused, timeScale: lastTimeScale })
  }

  const stepNext = (): void => {
    const steps = stepsOf()
    if (runningIndex < 0 || beat >= steps.length - 1) return
    targetBeat = beat + 1
    holdModel(false)
    syncStepUi()
  }

  const stepBack = (): void => {
    if (runningIndex < 0 || beat <= 0) return
    /* Nothing rewinds a simulation, so go back by replaying: stop, start again,
     * and run forward to the beat before this one. The model is seeded, so the
     * replay lands in the same state it did the first time. */
    const want = beat - 1
    const id = defs[runningIndex]!.id
    bus.emit('scenario', { id, running: false })
    bus.emit('scenario', { id, running: true })
    targetBeat = want
    holdModel(false)
    syncStepUi()
  }

  const toggleStepMode = (): void => {
    stepMode = !stepMode
    if (stepMode) targetBeat = beat
    else {
      targetBeat = Number.POSITIVE_INFINITY
      holdModel(false)
    }
    syncStepUi()
  }

  /** One string per model second, never one per frame. */
  const writeClock = (seconds: number): void => {
    const text = runDuration > 0 ? `${clock(seconds)} / ${clock(runDuration)}` : clock(seconds)
    bandClock.textContent = text
    footClock.textContent = text
    if (detailClock) detailClock.textContent = text
  }

  /* --------------------------------------------------------------- visibility */

  const syncVisibility = (): void => {
    const running = runningIndex >= 0
    /* The tour owns this band while it is up, and it narrates its own
     * scenarios; two strips in the same place would fight. */
    const bandOn = running && !sheetOpen && !tourOpen
    sheet.hidden = !sheetOpen
    scrim.hidden = !sheetOpen
    band.hidden = !bandOn
    footRun.hidden = !running
    host.hidden = !sheetOpen && !bandOn
  }

  const setOpen = (open: boolean): void => {
    if (open === sheetOpen) return
    sheetOpen = open
    if (open) {
      if (runningIndex >= 0) selected = runningIndex
      else if (selected < 0 && defs.length > 0) selected = 0
      renderDetail()
      const row = rows[selected]
      if (row) row.scrollIntoView({ block: 'nearest' })
      sheet.focus()
    }
    paintRows()
    syncVisibility()
    bus.emit('overlay', { id: 'scenarios', open })
  }

  const paintRows = (): void => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      row.classList.toggle('is-on', i === selected)
      row.classList.toggle('is-running', i === runningIndex)
      row.setAttribute('aria-selected', i === selected ? 'true' : 'false')
    }
  }

  const select = (i: number, scroll: boolean): void => {
    if (defs.length === 0) return
    const next = ((i % defs.length) + defs.length) % defs.length
    if (next === selected) return
    selected = next
    paintRows()
    renderDetail()
    detail.scrollTop = 0
    if (scroll) {
      const row = rows[selected]
      if (row) row.scrollIntoView({ block: 'nearest' })
    }
  }

  /* ------------------------------------------------------------ run control */

  const onScenario = (id: string, running: boolean): void => {
    if (!running) {
      /* The palette stops "whatever is running" with an empty id, and the model
       * echoes the real one back. Either ends the narration. */
      if (id !== '' && runningIndex >= 0 && defs[runningIndex]!.id !== id) return
      runningIndex = -1
      beat = -1
      startT = Number.NaN
      lastSec = -1
      lastFill = -1
      bandDots = []
      bandRail.textContent = ''
      bandFill.style.width = '0%'
      paintRows()
      if (sheetOpen) renderDetail()
      syncVisibility()
      return
    }

    const index = defs.findIndex((d) => d.id === id)
    if (index < 0) return
    runningIndex = index
    /* A fresh run always starts parked on its first beat. */
    targetBeat = stepMode ? 0 : Number.POSITIVE_INFINITY
    const def = defs[index]!
    runDuration = runtimeOf(def)
    startT = Number.NaN
    beat = -1
    lastSec = -1
    lastFill = -1

    const section = SECTIONS.find((s) => s.id === def.category) ?? FALLBACK_SECTION
    bandEyebrow.textContent = section.label
    bandTitle.textContent = def.title
    bandCard.dataset.category = def.category
    bandFill.style.width = '0%'
    writeClock(0)

    bandRail.textContent = ''
    bandDots = []
    const steps = def.steps ?? NO_STEPS
    for (let i = 0; i < steps.length; i++) {
      const dot = el('span', 'scn-dot')
      dot.dataset.state = 'next'
      dot.title = `${clock(steps[i]!.at)} — ${steps[i]!.text}`
      bandRail.appendChild(dot)
      bandDots.push(dot)
    }
    bandRail.hidden = steps.length === 0

    footLabel.textContent = def.title
    prose(bandBeat, def.blurb)

    if (sheetOpen) {
      selected = index
      renderDetail()
    }
    paintRows()
    syncVisibility()
  }

  /* ---------------------------------------------------------------- wiring */

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return

    const row = target.closest('.scn-row')
    if (row instanceof HTMLElement && row.dataset.i) {
      select(Number(row.dataset.i), false)
      return
    }

    const act = target.closest('[data-act]')
    if (!(act instanceof HTMLElement)) return
    switch (act.dataset.act) {
      case 'close':
        setOpen(false)
        break
      case 'open':
        setOpen(true)
        break
      case 'next':
        stepNext()
        break
      case 'back':
        stepBack()
        break
      case 'play':
        toggleStepMode()
        break
      case 'run': {
        const def = defs[selected]
        if (def) {
          bus.emit('scenario', { id: def.id, running: true })
          /* Get out of the way: the scenario is happening in the city, not in
           * this list. The band keeps narrating it. */
          setOpen(false)
        }
        break
      }
      case 'stop':
        bus.emit('scenario', { id: '', running: false })
        break
      default:
        break
    }
  }
  host.addEventListener('click', onClick)

  const typing = (ev: KeyboardEvent): boolean => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return false
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (typing(ev)) return
    if (!sheetOpen) {
      if (blocked || ev.ctrlKey || ev.metaKey || ev.altKey) return

      /* Stepping keys, live only while a scenario is actually running. They are
       * brackets and not arrows or space on purpose: those belong to the camera
       * in every mode, and binding S here once already stole a movement key. */
      if (runningIndex >= 0 && (ev.key === ']' || ev.key === '[')) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.key === ']') stepNext()
        else stepBack()
        return
      }

      /* B for "break it". NOT S: that is the camera's backward key, and orbit
       * mode holds no pointer lock, so binding S here stole a movement key in
       * the default camera mode and popped a modal instead of stepping back. */
      if (ev.key !== 'b' && ev.key !== 'B') return
      ev.preventDefault()
      ev.stopPropagation()
      setOpen(true)
      return
    }
    if (blocked) return
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault()
        ev.stopPropagation()
        setOpen(false)
        break
      case 'b':
      case 'B':
        ev.preventDefault()
        ev.stopPropagation()
        setOpen(false)
        break
      case 'ArrowDown':
      case 'PageDown':
        ev.preventDefault()
        ev.stopPropagation()
        select(selected + 1, true)
        break
      case 'ArrowUp':
      case 'PageUp':
        ev.preventDefault()
        ev.stopPropagation()
        select(selected - 1, true)
        break
      case 'Enter': {
        ev.preventDefault()
        ev.stopPropagation()
        const def = defs[selected]
        if (def) {
          bus.emit('scenario', { id: def.id, running: true })
          setOpen(false)
        }
        break
      }
      default:
        break
    }
  }
  window.addEventListener('keydown', onKey, true)

  const offOverlay = bus.on('overlay', (p) => {
    if (p.id === 'scenarios') {
      setOpen(p.open)
      return
    }
    if (p.id === 'tour') {
      tourOpen = p.open
      syncVisibility()
      return
    }
    if (p.id === 'search' || p.id === 'help') blocked = p.open
  })

  const offTourEnd = bus.on('tour-end', () => {
    tourOpen = false
    syncVisibility()
  })

  const offScenario = bus.on('scenario', (p) => {
    onScenario(p.id, p.running)
  })

  renderDetail()
  paintRows()
  syncVisibility()

  /* ------------------------------------------------------------ frame loop */

  const api: ScenarioBrowser = {
    update(s: SimState): void {
      if (runningIndex < 0) return
      const t = s.t
      if (typeof t !== 'number' || !Number.isFinite(t)) return
      if (!Number.isFinite(startT)) startT = t
      const elapsed = t - startT

      const sec = elapsed > 0 ? Math.floor(elapsed) : 0
      if (sec !== lastSec) {
        lastSec = sec
        writeClock(sec)
      }

      if (runDuration > 0) {
        /* Quantized to 0.2% so a style write happens only when it would be
         * visible, the same trick the HUD's gauges use. */
        const frac = elapsed <= 0 ? 0 : elapsed >= runDuration ? 1 : elapsed / runDuration
        const q = Math.round(frac * 500)
        if (q !== lastFill) {
          lastFill = q
          bandFill.style.width = `${(q * 0.2).toFixed(1)}%`
        }
      }

      if (s.knobs && typeof s.knobs.timeScale === 'number' && s.knobs.timeScale > 0) {
        lastTimeScale = s.knobs.timeScale
      }

      const steps = defs[runningIndex]!.steps ?? NO_STEPS
      let i = beat
      /* In step mode the run is only allowed as far as the beat the reader
       * asked for; in play mode it walks whatever model time has reached. */
      while (
        i + 1 < steps.length &&
        steps[i + 1]!.at <= elapsed &&
        (!stepMode || i + 1 <= targetBeat)
      ) {
        i++
      }
      if (i !== beat) {
        beat = i
        showBeat()
        syncStepUi()
      }

      /* Arrived: hold the cluster here until the reader moves on. */
      if (stepMode && beat >= targetBeat && s.knobs && !s.knobs.paused) {
        holdModel(true)
      }
    },

    dispose(): void {
      offOverlay()
      offTourEnd()
      offScenario()
      host.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKey, true)
      host.textContent = ''
      host.hidden = true
      host.remove()
      rows.length = 0
      defs.length = 0
    },
  }

  return api
}
