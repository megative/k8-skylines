import * as THREE from 'three'
import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import { COLOR } from '../core/theme'
import type { Gfx } from './renderer'

/* ============================================================================
 * PICKING — turning a pointer into an Explainer.
 *
 * The picker never decides what a thing *is*: it finds the object under the
 * cursor and hands it to `registry.resolve()`, which walks up the parent chain
 * until something is bound. That indirection is what lets a district draw one
 * mechanism as thirty meshes and still have all thirty select the same entry.
 *
 * Three constraints shape the implementation:
 *   - A raycast walks the whole scene graph, so hover raycasts run at a few
 *     hertz and only after the pointer has actually moved. Selection raycasts
 *     are immediate, because a click must never feel sampled.
 *   - While the pointer is locked (first-person flight) the cursor position is
 *     meaningless, so hover is switched off entirely and a click picks the
 *     crosshair at the centre of the screen.
 *   - Nothing is selected through an overlay. The DOM is asked what is actually
 *     on top before a click is honoured, which covers overlays this module has
 *     never heard of.
 * ==========================================================================*/

export interface Picker {
  update(dt: number): void
  dispose(): void
}

/** Hover raycasts per second. Hover is a hint; it does not need to be exact. */
const HOVER_PERIOD = 0.2
/** Pointer travel, in CSS pixels, that turns a click into a camera drag. */
const DRAG_SLOP = 6
/** Press-and-hold that opens the context menu, matching platform convention. */
const LONG_PRESS = 0.5
/** A press longer than this is not a click even if the pointer never moved. */
const CLICK_MAX = 0.7
/** The bounding rectangle is a layout read; refresh it on a slow clock. */
const RECT_PERIOD = 0.5

/**
 * Overlays that own the pointer while they are open. The inspector and the
 * control rail are deliberately absent: the city stays interactive underneath
 * them, which is the whole point of a side panel.
 */
const MODAL_OVERLAYS = ['search', 'help', 'tour', 'menu', 'scenarios'] as const

const _ndc = new THREE.Vector2()
const _box = new THREE.Box3()
const _center = new THREE.Vector3()
const _size = new THREE.Vector3()
const _m4 = new THREE.Matrix4()

export function createPicker(gfx: Gfx, registry: Registry, bus: Bus, dom: HTMLElement): Picker {
  const raycaster = new THREE.Raycaster()
  /* Defaults are tuned for unit-scale scenes; this city is ~1800 metres across
   * and a 1-metre line threshold would let grid lines swallow every click. */
  raycaster.params.Line.threshold = 0.4
  raycaster.params.Points.threshold = 1

  const hits: THREE.Intersection[] = []

  /* The hover highlight: one unit wireframe box, moved and scaled. depthTest is
   * off so the outline survives being behind a building, and the colour is the
   * UI's own neutral — a highlight is chrome, not a mechanism, and must not
   * borrow a hue that means something elsewhere in the city. */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const hlGeo = new THREE.EdgesGeometry(boxGeo)
  boxGeo.dispose()
  const hlMat = new THREE.LineBasicMaterial({
    color: COLOR.text,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
  })
  const highlight = new THREE.LineSegments(hlGeo, hlMat)
  highlight.name = 'picker:highlight'
  highlight.renderOrder = 999
  highlight.frustumCulled = false
  highlight.visible = false
  gfx.scene.add(highlight)

  let rect = dom.getBoundingClientRect()
  let rectClock = 0

  let px = 0
  let py = 0
  let pointerInside = false
  let pointerMoved = false
  let hoverClock = 0

  let pressing = false
  let pressT = 0
  let downX = 0
  let downY = 0

  let modalOpen = 0
  let hoverObject: THREE.Object3D | null = null
  let hoverInstance = -1
  let cursorOn = false

  /* Set by pick(): the picker has no allocation budget for a result object. */
  let hitEntryId = ''
  let hitObject: THREE.Object3D | null = null
  let hitInstance = -1

  /*
   * Track which modals are open by id, not how many opened.
   *
   * A counter assumed every `open: true` is matched by exactly one `false`, and
   * it is not: the command palette announces the tour and the help sheet as it
   * launches them, and those surfaces announce themselves as well. Two opens
   * and one close left the counter stuck above zero and selection dead for the
   * rest of the session, with nothing on screen to explain why.
   */
  const openModals = new Set<string>()
  const offOverlay = bus.on('overlay', ({ id, open }) => {
    if (MODAL_OVERLAYS.indexOf(id as (typeof MODAL_OVERLAYS)[number]) < 0) return
    if (open) openModals.add(id)
    else openModals.delete(id)
    modalOpen = openModals.size
    if (modalOpen > 0) clearHover()
  })

  function locked(): boolean {
    return document.pointerLockElement !== null
  }

  function clearHover(): void {
    hoverObject = null
    hoverInstance = -1
    if (highlight.visible) highlight.visible = false
    if (cursorOn) {
      cursorOn = false
      dom.style.cursor = ''
    }
  }

  /**
   * Raycast at normalised device coordinates. Returns true and fills the `hit*`
   * variables when the ray struck something the registry can explain.
   */
  function pick(ndcX: number, ndcY: number): boolean {
    hitEntryId = ''
    hitObject = null
    hitInstance = -1
    _ndc.set(ndcX, ndcY)
    raycaster.setFromCamera(_ndc, gfx.camera)
    hits.length = 0
    raycaster.intersectObject(gfx.scene, true, hits)
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]
      const o = h.object
      if (o === highlight) continue
      if (o.userData.nopick) continue
      const entry = registry.resolve(o)
      if (!entry) continue
      hitEntryId = entry.id
      hitObject = o
      hitInstance = h.instanceId === undefined ? -1 : h.instanceId
      return true
    }
    return false
  }

  function pickAtPointer(): boolean {
    if (locked()) return pick(0, 0)
    if (rect.width <= 0 || rect.height <= 0) return false
    return pick(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1)
  }

  /** Fit the wireframe to what the ray actually struck, instance included. */
  function frameHighlight(): void {
    const o = hitObject
    if (!o) return clearHover()
    const im = o as THREE.InstancedMesh
    if (hitInstance >= 0 && im.isInstancedMesh) {
      const g = im.geometry
      if (!g.boundingBox) g.computeBoundingBox()
      if (!g.boundingBox) return clearHover()
      im.getMatrixAt(hitInstance, _m4)
      _m4.premultiply(im.matrixWorld)
      _box.copy(g.boundingBox).applyMatrix4(_m4)
    } else {
      /* Box3.setFromObject walks the subtree. It runs on a hover change, never
       * per frame, which is the only reason it is affordable here. */
      _box.setFromObject(o)
    }
    if (_box.isEmpty()) return clearHover()
    _box.getCenter(_center)
    _box.getSize(_size)
    highlight.position.copy(_center)
    highlight.scale.set(
      Math.max(_size.x, 0.4) * 1.08,
      Math.max(_size.y, 0.4) * 1.08,
      Math.max(_size.z, 0.4) * 1.08,
    )
    highlight.visible = true
    if (!cursorOn) {
      cursorOn = true
      dom.style.cursor = 'pointer'
    }
  }

  function doHover(): void {
    if (!pickAtPointer()) {
      clearHover()
      return
    }
    /* An instanced hit moves under a stationary cursor, so it is re-fitted on
     * every hover pass; a plain mesh only when the hit itself changed. */
    const im = hitObject as THREE.InstancedMesh
    if (hitObject !== hoverObject || hitInstance !== hoverInstance || im.isInstancedMesh) {
      hoverObject = hitObject
      hoverInstance = hitInstance
      frameHighlight()
    }
  }

  /** True when the point is over the canvas itself rather than over an overlay. */
  function pointerOnCanvas(): boolean {
    if (locked()) return true
    const top = document.elementFromPoint(px, py)
    return top === dom || top === null
  }

  function select(): void {
    if (pickAtPointer()) bus.emit('focus', { id: hitEntryId, source: 'click' })
    else bus.emit('blur', {})
  }

  function openMenu(): void {
    if (pickAtPointer()) bus.emit('focus', { id: hitEntryId, source: 'click' })
    /* The context menu is DOM and needs a screen position. The bus carries no
     * coordinates, so they are published as custom properties on the root. */
    const root = document.documentElement
    root.style.setProperty('--menu-x', `${Math.round(px)}px`)
    root.style.setProperty('--menu-y', `${Math.round(py)}px`)
    bus.emit('overlay', { id: 'context-menu', open: true })
  }

  /* ------------------------------------------------------------------------
   * Pointer events.
   * ----------------------------------------------------------------------*/
  const onMove = (e: PointerEvent): void => {
    px = e.clientX
    py = e.clientY
    pointerInside = true
    pointerMoved = true
    if (pressing && Math.abs(px - downX) + Math.abs(py - downY) > DRAG_SLOP) {
      /* The camera rig owns this gesture now. */
      pressing = false
    }
  }

  const onDown = (e: PointerEvent): void => {
    px = e.clientX
    py = e.clientY
    downX = px
    downY = py
    pointerInside = true
    /* A right-click arrives as a `contextmenu` event; pressing only tracks the
     * primary button, so a middle-drag never turns into a selection. */
    pressing = e.button === 0 && modalOpen === 0
    pressT = 0
  }

  const onUp = (e: PointerEvent): void => {
    px = e.clientX
    py = e.clientY
    const wasPressing = pressing
    pressing = false
    if (!wasPressing || pressT > CLICK_MAX) return
    if (modalOpen > 0 || !pointerOnCanvas()) return
    select()
  }

  const onCancel = (): void => {
    pressing = false
  }

  const onLeave = (): void => {
    pointerInside = false
    pressing = false
    clearHover()
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    px = e.clientX
    py = e.clientY
    pressing = false
    if (modalOpen > 0 || !pointerOnCanvas()) return
    openMenu()
  }

  dom.addEventListener('pointermove', onMove, { passive: true })
  dom.addEventListener('pointerdown', onDown, { passive: true })
  dom.addEventListener('pointerup', onUp, { passive: true })
  dom.addEventListener('pointercancel', onCancel, { passive: true })
  dom.addEventListener('pointerleave', onLeave, { passive: true })
  dom.addEventListener('contextmenu', onContextMenu)

  function update(dt: number): void {
    rectClock += dt
    if (rectClock >= RECT_PERIOD) {
      rectClock = 0
      rect = dom.getBoundingClientRect()
    }

    if (pressing) {
      pressT += dt
      if (pressT >= LONG_PRESS) {
        pressing = false
        if (modalOpen === 0 && pointerOnCanvas()) openMenu()
      }
    }

    /* Hover is a hint about where the pointer is. With the pointer locked there
     * is no pointer, and with a modal open the city is not the subject. */
    if (locked() || modalOpen > 0 || !pointerInside) {
      if (hoverObject) clearHover()
      return
    }

    hoverClock += dt
    if (hoverClock < HOVER_PERIOD || !pointerMoved) return
    hoverClock = 0
    pointerMoved = false
    doHover()
  }

  function dispose(): void {
    offOverlay()
    dom.removeEventListener('pointermove', onMove)
    dom.removeEventListener('pointerdown', onDown)
    dom.removeEventListener('pointerup', onUp)
    dom.removeEventListener('pointercancel', onCancel)
    dom.removeEventListener('pointerleave', onLeave)
    dom.removeEventListener('contextmenu', onContextMenu)
    dom.style.cursor = ''
    highlight.removeFromParent()
    hlGeo.dispose()
    hlMat.dispose()
    hits.length = 0
  }

  return { update, dispose }
}
