import type { Bus } from '../core/bus'
import type { CameraRig } from '../engine/camera'
import { getMode, type ThemeMode } from '../core/theme'

/* ============================================================================
 * The view bar: theme, camera mode, and the input map, always on screen.
 *
 * Every one of these already had a keyboard shortcut, and that was the problem
 * — a shortcut nobody can see is a feature nobody has. The bar states what a
 * first-time visitor cannot guess: that there is a daylight mode, that the read
 * outs can be summoned, that the model can be stepped, and which keys move the
 * camera.
 * ==========================================================================*/

export interface Viewbar {
  dispose(): void
}

interface Seg<T extends string> {
  value: T
  label: string
  hint: string
}

/* Sun and moon, drawn inline: the bundle takes no external asset and the mark
 * inherits `currentColor`, so it follows the theme it toggles. */
const ICON_SUN =
  '<circle cx="12" cy="12" r="4.2"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<path d="M12 2.4v2.6M12 19v2.6M2.4 12h2.6M19 12h2.6M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/></g>'
const ICON_MOON = '<path d="M20 14.6A8.6 8.6 0 0 1 9.4 4a8.6 8.6 0 1 0 10.6 10.6z"/>'

function themeIcon(mode: ThemeMode): string {
  /* Show what a click gives you, not what you already have. */
  return `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">${
    mode === 'night' ? ICON_SUN : ICON_MOON
  }</svg>`
}

export type PanelMode = 'minimal' | 'full'

/*
 * The city is the thing worth looking at, and it was losing. Six panels opened
 * at once left it about a quarter of the viewport, so the default is now the
 * city plus the top line, and every read-out is one click away.
 */
const PANELS: Seg<PanelMode>[] = [
  { value: 'minimal', label: 'Clean', hint: 'The city, uncovered. Click any building to inspect it.' },
  { value: 'full', label: 'Data', hint: 'Show the live read-outs and the knob rail as well.' },
]

function applyPanels(mode: PanelMode): void {
  document.documentElement.dataset.panels = mode
}

const KEYS: [string, string][] = [
  ['drag', 'pan'],
  ['wheel', 'zoom'],
  ['click', 'select'],
  ['WASD', 'move'],
  ['T', 'tour'],
  ['B', 'failures'],
  ['/', 'search'],
  ['?', 'all keys'],
]

function segmented<T extends string>(
  title: string,
  segs: Seg<T>[],
  current: T,
  onPick: (v: T) => void,
): { el: HTMLElement; set: (v: T) => void } {
  const wrap = document.createElement('div')
  wrap.className = 'vb-group'

  const label = document.createElement('span')
  label.className = 'vb-label'
  label.textContent = title
  wrap.appendChild(label)

  const row = document.createElement('div')
  row.className = 'vb-seg'
  row.setAttribute('role', 'radiogroup')
  row.setAttribute('aria-label', title)

  const buttons = new Map<T, HTMLButtonElement>()
  for (const s of segs) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'vb-btn'
    b.textContent = s.label
    b.title = s.hint
    b.setAttribute('role', 'radio')
    b.addEventListener('click', () => onPick(s.value))
    buttons.set(s.value, b)
    row.appendChild(b)
  }
  wrap.appendChild(row)

  const set = (v: T): void => {
    for (const [value, b] of buttons) {
      const on = value === v
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', on ? 'true' : 'false')
    }
  }
  set(current)
  return { el: wrap, set }
}

export function createViewbar(bus: Bus, rig: CameraRig): Viewbar {
  const root = document.createElement('div')
  root.id = 'viewbar'

  /* A single icon that states the alternative, not a two-word radio group. */
  const themeBtn = document.createElement('button')
  themeBtn.type = 'button'
  themeBtn.className = 'vb-icon'
  let themeMode: ThemeMode = getMode()
  const paintTheme = (): void => {
    themeBtn.innerHTML = themeIcon(themeMode)
    const to = themeMode === 'night' ? 'daylight' : 'night'
    themeBtn.title =
      themeMode === 'night'
        ? 'Switch to daylight — hue and value carry the meaning (N)'
        : 'Switch to night — matte structure, and only real signals glow (N)'
    themeBtn.setAttribute('aria-label', `Switch to ${to}`)
  }
  themeBtn.addEventListener('click', () => {
    bus.emit('theme', { mode: themeMode === 'night' ? 'day' : 'night' })
  })
  paintTheme()

  const startMode: PanelMode =
    document.documentElement.dataset.panels === 'full' ? 'full' : 'minimal'
  const panels = segmented<PanelMode>('Panels', PANELS, startMode, (v) => {
    applyPanels(v)
    panels.set(v)
  })
  applyPanels(startMode)

  /*
   * Model transport. A cluster that runs continuously cannot be studied: the
   * events outrun the reader and cause is separated from effect. These three
   * make it behave like a debugger.
   */
  const model = document.createElement('div')
  model.className = 'vb-group'
  const modelLabel = document.createElement('span')
  modelLabel.className = 'vb-label'
  modelLabel.textContent = 'Model'
  const modelRow = document.createElement('div')
  modelRow.className = 'vb-seg'

  const holdBtn = document.createElement('button')
  holdBtn.type = 'button'
  holdBtn.className = 'vb-btn'
  holdBtn.textContent = 'Hold'
  holdBtn.title = 'Freeze the cluster where it stands (K or P)'

  const stepEventBtn = document.createElement('button')
  stepEventBtn.type = 'button'
  stepEventBtn.className = 'vb-btn'
  stepEventBtn.textContent = 'Next event'
  stepEventBtn.title = 'Run until the cluster does something, then stop there'

  const stepSecBtn = document.createElement('button')
  stepSecBtn.type = 'button'
  stepSecBtn.className = 'vb-btn'
  stepSecBtn.textContent = '+1s'
  stepSecBtn.title = 'Advance exactly one model second'

  modelRow.append(holdBtn, stepEventBtn, stepSecBtn)
  model.append(modelLabel, modelRow)

  let paused = false
  let timeScale = 1
  const paintHold = (): void => {
    holdBtn.classList.toggle('on', paused)
    holdBtn.textContent = paused ? 'Held' : 'Hold'
  }
  holdBtn.addEventListener('click', () => {
    bus.emit('transport', { paused: !paused, timeScale })
  })
  stepEventBtn.addEventListener('click', () => bus.emit('step', { kind: 'event' }))
  stepSecBtn.addEventListener('click', () => bus.emit('step', { kind: 'second' }))

  const offTransport = bus.on('transport', (t) => {
    paused = t.paused
    timeScale = t.timeScale
    paintHold()
  })
  paintHold()

  const keys = document.createElement('div')
  keys.className = 'vb-keys'
  for (const [k, what] of KEYS) {
    const kbd = document.createElement('kbd')
    kbd.textContent = k
    const txt = document.createElement('span')
    txt.textContent = what
    const pair = document.createElement('span')
    pair.className = 'vb-key'
    pair.append(kbd, txt)
    keys.appendChild(pair)
  }

  root.append(themeBtn, panels.el, model, keys)
  document.body.appendChild(root)

  const offTheme = bus.on('theme', ({ mode }) => {
    themeMode = mode
    paintTheme()
  })

  return {
    dispose(): void {
      offTransport()
      offTheme()
      root.remove()
    },
  }
}
