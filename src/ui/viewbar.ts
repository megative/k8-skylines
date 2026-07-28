import type { Bus } from '../core/bus'
import type { CameraMode, CameraRig } from '../engine/camera'
import { getMode, type ThemeMode } from '../core/theme'

/* ============================================================================
 * The view bar: theme, camera mode, and the input map, always on screen.
 *
 * Every one of these already had a keyboard shortcut, and that was the problem
 * — a shortcut nobody can see is a feature nobody has. The bar states the three
 * things a first-time visitor cannot guess: that there is a daylight mode, that
 * the camera has three modes, and which keys move it.
 * ==========================================================================*/

export interface Viewbar {
  dispose(): void
}

interface Seg<T extends string> {
  value: T
  label: string
  hint: string
}

const THEMES: Seg<ThemeMode>[] = [
  { value: 'night', label: 'Night', hint: 'Matte structure, neon meaning. Only real signals glow.' },
  { value: 'day', label: 'Day', hint: 'Hue and value carry meaning. Easier to read the architecture.' },
]

const CAMERAS: Seg<CameraMode>[] = [
  { value: 'orbit', label: 'Orbit', hint: 'Drag to pan the map, Shift-drag to orbit, wheel to zoom. Key: F' },
  { value: 'fly', label: 'Fly', hint: 'WASD to fly, mouse to look, Space/C for altitude. Key: F' },
  { value: 'walk', label: 'Walk', hint: 'Street level, 1.75 m tall. WASD, Space jumps. Key: G' },
]

const KEYS: [string, string][] = [
  ['drag', 'pan'],
  ['wheel', 'zoom'],
  ['click', 'select'],
  ['WASD', 'move'],
  ['T', 'tour'],
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

  const theme = segmented<ThemeMode>('View', THEMES, getMode(), (v) => {
    /* The bar states an intent; main.ts owns the actual theme flip. */
    bus.emit('theme', { mode: v })
  })

  const camera = segmented<CameraMode>('Camera', CAMERAS, rig.mode, (v) => {
    rig.setMode(v)
    camera.set(v)
  })

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

  root.append(theme.el, camera.el, keys)
  document.body.appendChild(root)

  /* The bar reflects state it does not own: the theme can also change from the
   * N key, and the camera mode from F and G. Poll rather than subscribe,
   * because the rig exposes no change event. */
  let lastCam: CameraMode = rig.mode
  const poll = window.setInterval(() => {
    if (rig.mode !== lastCam) {
      lastCam = rig.mode
      camera.set(lastCam)
    }
  }, 200)

  const offTheme = bus.on('theme', ({ mode }) => theme.set(mode))

  return {
    dispose(): void {
      window.clearInterval(poll)
      offTheme()
      root.remove()
    },
  }
}
