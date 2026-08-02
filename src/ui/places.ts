import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import type { CameraRig } from '../engine/camera'
import { DISTRICTS } from '../world/layout'

/* ============================================================================
 * PLACES — the way out of wherever you ended up.
 *
 * A 3D city on a flat screen has three navigation problems, and the literature
 * on the metaphor names all three: you cannot tell where you are, you cannot
 * get back, and you cannot see what else there is. Signage answers the first
 * two only while a sign happens to be on screen, which inside a district it is
 * not.
 *
 * So: every district, always listed, always reachable, with the one you are
 * standing in marked. Nothing here decides anything — a row emits the same
 * `focus-district` the labels and the command palette emit, and the camera rig
 * owns the flight. This is a table of contents, not a second camera.
 * ==========================================================================*/

export interface Places {
  update(): void
  dispose(): void
}

export function createPlaces(bus: Bus, rig: CameraRig, registry: Registry): Places {
  if (typeof document === 'undefined') return { update: () => {}, dispose: () => {} }
  const host = document.getElementById('places')
  if (!host) {
    console.warn('[ui/places] #places is missing from the document; the place list is disabled')
    return { update: () => {}, dispose: () => {} }
  }

  host.innerHTML = ''
  host.setAttribute('aria-label', 'Places in the city')

  const toggle = document.createElement('button')
  toggle.className = 'pl-toggle'
  toggle.type = 'button'
  toggle.textContent = 'Places'
  toggle.setAttribute('aria-expanded', 'false')
  host.append(toggle)

  const drawer = document.createElement('div')
  drawer.className = 'pc-drawer'
  drawer.hidden = true
  host.append(drawer)

  /* Two ways out that are not a district: the establishing shot, and the seat
   * the city was composed to be read from. Both were keyboard-only, which for a
   * first-time reader is the same as absent. */
  const wide = document.createElement('button')
  wide.className = 'pc-row pc-wide'
  wide.type = 'button'
  wide.textContent = 'Overview'
  wide.title = 'The whole cluster from above (O)'
  const home = document.createElement('button')
  home.className = 'pc-row pc-wide'
  home.type = 'button'
  home.textContent = 'Home'
  home.title = 'Back to the opening view (H)'
  drawer.append(wide, home)

  /*
   * Two levels, because one is a dead end. Flying to Controllers and stopping
   * there leaves the reader looking at a quarter with no idea what is in it —
   * the same "what am I looking at" they started with, one altitude lower. A
   * district opens into the mechanisms it holds, read from the registry rather
   * than written out here, so a district that registers a new Explainer gains
   * a row without anyone remembering to add one.
   */
  const list = document.createElement('div')
  list.className = 'pc-list'
  drawer.append(list)

  /** The expanded district, or '' for none. One at a time: this is a way to
   *  find something, not a tree to browse. */
  let opened = ''

  function paint(): void {
    list.textContent = ''
    for (const d of DISTRICTS) {
      const row = document.createElement('button')
      row.className = 'pc-row pc-district'
      row.type = 'button'
      row.textContent = d.label
      row.dataset.district = d.id
      row.setAttribute('aria-expanded', String(opened === d.id))
      row.classList.toggle('is-open', opened === d.id)
      row.title = `Fly to ${d.label}`
      list.append(row)
      if (opened !== d.id) continue

      /* An entry with no anchor object is a lesson nothing in the scene can be
       * selected for, so a row would fly the camera nowhere. The search palette
       * lists those. */
      const inside = registry.all().filter((e) => e.district === d.id && e.object)
      if (inside.length === 0) {
        const none = document.createElement('div')
        none.className = 'pc-empty'
        none.textContent = 'nothing registered here'
        list.append(none)
        continue
      }
      for (const e of inside) {
        const sub = document.createElement('button')
        sub.className = 'pc-row pc-sub'
        sub.type = 'button'
        sub.textContent = e.title
        sub.dataset.entry = e.id
        sub.title = e.kubeName ? `${e.title} — ${e.kubeName}` : e.title
        list.append(sub)
      }
    }
  }
  paint()

  let open = false
  const setOpen = (v: boolean): void => {
    open = v
    drawer.hidden = !v
    toggle.setAttribute('aria-expanded', String(v))
    toggle.classList.toggle('is-on', v)
    /* The camera must release the keyboard while a menu is up, and take it back
     * when the menu goes away. */
    bus.emit('overlay', { id: 'places', open: v })
  }

  const onToggle = (): void => setOpen(!open)
  toggle.addEventListener('click', onToggle)

  const onRow = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return
    if (t === wide) return rig.overview()
    if (t === home) return rig.home()
    const district = t.dataset.district
    if (district) {
      /* Both, in this order: go there, and show what is there. Expanding
       * without flying makes the list a document; flying without expanding is
       * the dead end this second level exists to fix. */
      opened = opened === district ? '' : district
      paint()
      bus.emit('focus-district', { id: district as (typeof DISTRICTS)[number]['id'] })
      return
    }
    const entry = t.dataset.entry
    /* 'menu', not 'click': a click means "the thing under my cursor", and the
     * camera answers it with whatever the picker last resolved — which from a
     * list is some object elsewhere in the city. */
    if (entry) bus.emit('focus', { id: entry, source: 'menu' })
  }
  drawer.addEventListener('click', onRow)

  /*
   * The camera rig listens for pointer events on `window`, so a press anywhere
   * — including on this menu — starts a drag and cancels whatever flight is
   * under way. Clicking "Nodes" therefore emitted the intent and then killed
   * the flight it had just asked for, in the same gesture. Chrome keeps its
   * own presses to itself.
   */
  const swallow = (ev: Event): void => ev.stopPropagation()
  host.addEventListener('pointerdown', swallow)
  host.addEventListener('pointerup', swallow)

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !open) return
    /* Escape closes the deepest thing that is open, so it never discards more
     * than the reader asked to leave. */
    if (opened) {
      opened = ''
      paint()
      return
    }
    setOpen(false)
  }
  window.addEventListener('keydown', onKey)

  /*
   * "You are here" is deliberately absent.
   *
   * It was written and then removed: marking the district under the camera
   * needs a rule for when a district *fills the frame* rather than merely sits
   * in it, and the two obvious signals both fail. Altitude cannot separate
   * them — framing the wide Nodes district puts the camera as high as the
   * establishing shot does — and range measured in the district's own radii was
   * guessed at rather than derived, so it marked everything or nothing
   * depending on the multiplier.
   *
   * A marker that is wrong is worse than no marker in a surface whose whole job
   * is to tell you where you are. The honest version reads the framing distance
   * from the camera rig instead of re-deriving it here; see task #13.
   */
  function update(): void {}

  return {
    update,
    dispose(): void {
      toggle.removeEventListener('click', onToggle)
      drawer.removeEventListener('click', onRow)
      window.removeEventListener('keydown', onKey)
      host.removeEventListener('pointerdown', swallow)
      host.removeEventListener('pointerup', swallow)
      host.innerHTML = ''
    },
  }
}
