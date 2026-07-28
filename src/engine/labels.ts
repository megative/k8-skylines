import * as THREE from 'three'
import type { Explainer, SimState } from '../core/types'
import type { Registry } from '../core/registry'
import { COLOR } from '../core/theme'
import { smoothstep } from '../core/util'
import { DISTRICTS } from '../world/layout'
import type { Gfx } from './renderer'

/* ============================================================================
 * LABELS — the city's signage.
 *
 * Text is DOM, not sprites: it stays crisp at every zoom, costs no texture
 * memory, and is readable by the browser's own zoom and accessibility tools.
 * The 3D scene supplies anchors; this file supplies typography.
 *
 * Two hazards govern the whole design.
 *
 *   1. Layout thrashing. Reading `offsetWidth` after writing `style` forces the
 *      browser to lay out synchronously. So every frame writes first and reads
 *      afterwards, and a measurement is taken only when a label's text actually
 *      changed. Placement uses last frame's measurement, which is wrong for one
 *      frame after a text change and invisible at 60 fps.
 *   2. Density. A city with a hundred labels lit at once is unreadable, so the
 *      level of detail is distance-driven: districts from orbit, component
 *      names as you descend, live values only when you are close enough that
 *      the number is the reason you came.
 * ==========================================================================*/

export interface Labels {
  update(s: SimState, dt: number): void
  setVisible(v: boolean): void
  dispose(): void
}

/** Hard ceiling on DOM nodes. Beyond this the establishing shot is noise. */
const MAX_SLOTS = 32

/* The level-of-detail ladder, in metres from the camera to the anchor. The two
 * ranges barely overlap on purpose: from the establishing shot at ~300 m up,
 * every district anchor is past DISTRICT_FADE1 and every component anchor is
 * past ENTRY_FADE1, so the city names its neighbourhoods and nothing else. */
const DISTRICT_FADE0 = 400
const DISTRICT_FADE1 = 620
const ENTRY_FADE0 = 340
const ENTRY_FADE1 = 560
/** Closer than this and a label earns its live values. */
const VALUE_DISTANCE = 260

/** Off-screen margin, in pixels, before a label is culled outright. */
const CULL_MARGIN = 64

/** Frames between re-reads of an anchor's world position. Most never move. */
const ANCHOR_REFRESH = 8
/** Live values are recomputed at most this often, per label. */
const VALUE_PERIOD = 0.3
/** `metrics()` allocates by contract, so only this many run per frame. */
const VALUE_BUDGET = 2

const TIER_DISTRICT = 0
const TIER_NAME = 1
const TIER_VALUE = 2

/* Scratch. The frame loop allocates nothing beyond the strings the DOM needs. */
const _view = new THREE.Vector3()
const _ndc = new THREE.Vector3()
const _viewInv = new THREE.Matrix4()

interface Cand {
  isDistrict: boolean
  entry: Explainer | null
  obj: THREE.Object3D | null
  text: string
  world: THREE.Vector3
  refreshIn: number
  /* Per-frame results. */
  sx: number
  sy: number
  dist: number
  opacity: number
  tier: number
  score: number
  slot: number
  valueClock: number
  valueText: string
}

interface Slot {
  el: HTMLDivElement
  box: HTMLDivElement
  tEl: HTMLSpanElement
  vEl: HTMLSpanElement
  cand: number
  text: string
  value: string
  district: boolean
  w: number
  h: number
  x: number
  y: number
  opacity: number
  shown: boolean
  measure: boolean
}

const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

export function createLabels(gfx: Gfx, registry: Registry, container: HTMLElement): Labels {
  const text = css(COLOR.text)
  const edge = css(COLOR.edge)

  /* ------------------------------------------------------------------------
   * The pool. Built once; never grown, never rebuilt.
   * ----------------------------------------------------------------------*/
  const slots: Slot[] = []
  for (let i = 0; i < MAX_SLOTS; i++) {
    const el = document.createElement('div')
    el.style.cssText = 'position:absolute;left:0;top:0;display:none;will-change:transform;'

    /* The inner box carries the -50%/-100% offset so the outer element's
     * transform stays a pure translation and can be written as one string. */
    const box = document.createElement('div')
    box.style.cssText =
      'transform:translate(-50%,-100%);white-space:nowrap;padding:2px 7px 3px;border-radius:4px;' +
      `background:rgba(8,11,18,.46);border:1px solid ${edge}59;color:${text};` +
      'font:500 12px/1.3 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      'letter-spacing:.01em;text-shadow:0 1px 3px rgba(0,0,0,.85);'

    const tEl = document.createElement('span')
    tEl.style.cssText = 'display:block;'
    const vEl = document.createElement('span')
    vEl.style.cssText = 'display:none;font-size:11px;opacity:.72;font-variant-numeric:tabular-nums;'

    box.appendChild(tEl)
    box.appendChild(vEl)
    el.appendChild(box)
    container.appendChild(el)

    slots.push({
      el,
      box,
      tEl,
      vEl,
      cand: -1,
      text: '',
      value: '',
      district: false,
      w: 60,
      h: 20,
      x: 0,
      y: 0,
      opacity: 0,
      shown: false,
      measure: false,
    })
  }

  /* ------------------------------------------------------------------------
   * Candidates. Rebuilt only when the registry's size changes: districts add
   * their entries during construction, and the tour may add more later.
   * ----------------------------------------------------------------------*/
  const cands: Cand[] = []
  let knownRegistrySize = -1

  function sync(): void {
    cands.length = 0
    for (let i = 0; i < DISTRICTS.length; i++) {
      const d = DISTRICTS[i]
      cands.push({
        isDistrict: true,
        entry: null,
        obj: null,
        text: d.label,
        /* Districts are named above their own ground, clear of their tallest
         * building; the etcd pit is below grade, so lift from zero. */
        world: new THREE.Vector3(d.center[0], Math.max(d.center[1], 0) + 74, d.center[2]),
        refreshIn: 1 << 30,
        sx: 0,
        sy: 0,
        dist: 0,
        opacity: 0,
        tier: TIER_DISTRICT,
        score: 0,
        slot: -1,
        valueClock: 0,
        valueText: '',
      })
    }
    const all = registry.all()
    for (let i = 0; i < all.length; i++) {
      const e = all[i]
      if (!e.object) continue
      cands.push({
        isDistrict: false,
        entry: e,
        obj: e.object,
        text: e.title,
        world: new THREE.Vector3(),
        refreshIn: 0,
        sx: 0,
        sy: 0,
        dist: 0,
        opacity: 0,
        tier: TIER_NAME,
        score: 0,
        slot: -1,
        valueClock: 0,
        valueText: '',
      })
    }
    knownRegistrySize = registry.size()
    order = new Int32Array(cands.length)
    for (let i = 0; i < slots.length; i++) slots[i].cand = -1
  }

  let order = new Int32Array(0)

  /* ------------------------------------------------------------------------
   * Viewport. A layout read, so it happens on resize and not per frame.
   * ----------------------------------------------------------------------*/
  let vw = 1
  let vh = 1
  function readViewport(): void {
    vw = container.clientWidth || window.innerWidth || 1
    vh = container.clientHeight || window.innerHeight || 1
  }
  readViewport()
  const onResize = (): void => readViewport()
  window.addEventListener('resize', onResize, { passive: true })

  /* Placement bookkeeping. Fixed-size: no allocation during layout. */
  const rx0 = new Float32Array(MAX_SLOTS)
  const ry0 = new Float32Array(MAX_SLOTS)
  const rx1 = new Float32Array(MAX_SLOTS)
  const ry1 = new Float32Array(MAX_SLOTS)
  const freeSlot = new Int32Array(MAX_SLOTS)
  const taken = new Uint8Array(MAX_SLOTS)
  const OFFSETS = [0, -1, -2, 1]

  let visible = true
  let frame = 0

  function estimateW(t: string, district: boolean): number {
    return 16 + t.length * (district ? 7.6 : 6.5)
  }

  function place(i: number, w: number, h: number, placed: number): number {
    /* Greedy, in priority order: try the anchor, then a step up, two steps up,
     * one step down. A label that cannot find room is dropped, never stacked. */
    const c = cands[i]
    for (let k = 0; k < OFFSETS.length; k++) {
      const y = c.sy + OFFSETS[k] * (h + 6)
      const x0 = c.sx - w / 2
      const x1 = c.sx + w / 2
      const y0 = y - h
      const y1 = y
      let clash = false
      for (let p = 0; p < placed; p++) {
        if (x0 < rx1[p] && x1 > rx0[p] && y0 < ry1[p] && y1 > ry0[p]) {
          clash = true
          break
        }
      }
      if (!clash) {
        rx0[placed] = x0
        rx1[placed] = x1
        ry0[placed] = y0
        ry1[placed] = y1
        c.sy = y
        return 1
      }
    }
    return 0
  }

  function update(s: SimState, dt: number): void {
    if (!visible) return
    if (registry.size() !== knownRegistrySize) sync()
    if (cands.length === 0) return

    frame++
    if ((frame & 63) === 0) readViewport()

    const cam = gfx.camera
    cam.updateMatrixWorld()
    _viewInv.copy(cam.matrixWorld).invert()

    const cx = vw * 0.5
    const cy = vh * 0.5

    /* --- project, cull, score. No DOM touched in this pass. --- */
    let n = 0
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]
      c.opacity = 0

      const obj = c.obj
      if (obj) {
        if (!obj.visible) continue
        if (--c.refreshIn <= 0) {
          c.refreshIn = ANCHOR_REFRESH
          obj.getWorldPosition(c.world)
        }
      }

      _view.copy(c.world).applyMatrix4(_viewInv)
      /* Camera space looks down -Z, so anything at or behind the eye is out. */
      if (_view.z > -1) continue
      const dist = _view.length()

      let op: number
      let tier: number
      if (c.isDistrict) {
        op = smoothstep(DISTRICT_FADE0, DISTRICT_FADE1, dist)
        tier = TIER_DISTRICT
      } else {
        op = 1 - smoothstep(ENTRY_FADE0, ENTRY_FADE1, dist)
        tier = dist <= VALUE_DISTANCE ? TIER_VALUE : TIER_NAME
      }
      if (op <= 0.02) continue

      _ndc.copy(_view).applyMatrix4(cam.projectionMatrix)
      const sx = (_ndc.x * 0.5 + 0.5) * vw
      const sy = (-_ndc.y * 0.5 + 0.5) * vh
      if (sx < -CULL_MARGIN || sx > vw + CULL_MARGIN) continue
      if (sy < -CULL_MARGIN || sy > vh + CULL_MARGIN) continue

      c.sx = sx
      c.sy = sy
      c.dist = dist
      c.opacity = op
      c.tier = tier
      /* Districts outrank components; among components, nearer and closer to
       * the centre of the screen wins, because that is what the user aimed at. */
      const off = Math.abs(sx - cx) + Math.abs(sy - cy)
      c.score = (c.isDistrict ? 6000 : 2400) + op * 900 - dist * 0.6 - off * 0.25
      order[n++] = i
    }

    /* Insertion sort: n is at most a few hundred and usually far less, and it
     * costs no allocation, unlike a comparator-driven sort. */
    for (let a = 1; a < n; a++) {
      const v = order[a]
      const sv = cands[v].score
      let b = a - 1
      while (b >= 0 && cands[order[b]].score < sv) {
        order[b + 1] = order[b]
        b--
      }
      order[b + 1] = v
    }

    /* --- allocate slots, resolving overlaps in priority order --- */
    for (let i = 0; i < cands.length; i++) if (cands[i].opacity <= 0.02) cands[i].slot = -1
    taken.fill(0)
    let placed = 0
    let keep = 0
    for (let k = 0; k < n && placed < MAX_SLOTS; k++) {
      const i = order[k]
      const c = cands[i]
      const w = c.slot >= 0 && slots[c.slot].cand === i ? slots[c.slot].w : estimateW(c.text, c.isDistrict)
      const h = c.slot >= 0 && slots[c.slot].cand === i ? slots[c.slot].h : c.tier === TIER_VALUE ? 34 : 22
      if (place(i, w, h, placed) === 0) {
        c.slot = -1
        continue
      }
      placed++
      /* Keep a label in the slot it already had: a moved slot is a text
       * rewrite, and a rewrite is a forced re-measure. */
      if (c.slot >= 0 && slots[c.slot].cand === i && taken[c.slot] === 0) {
        taken[c.slot] = 1
      } else {
        c.slot = -2
      }
      order[keep++] = i
    }
    let nFree = 0
    for (let sI = 0; sI < MAX_SLOTS; sI++) if (taken[sI] === 0) freeSlot[nFree++] = sI
    let freeAt = 0
    for (let k = 0; k < keep; k++) {
      const c = cands[order[k]]
      if (c.slot === -2) {
        c.slot = freeAt < nFree ? freeSlot[freeAt++] : -1
        if (c.slot >= 0) taken[c.slot] = 1
      }
    }
    for (let sI = 0; sI < MAX_SLOTS; sI++) if (taken[sI] === 0) slots[sI].cand = -1

    /* --- live values: the only place per-frame allocation is unavoidable, so
     * it is rationed and only ever runs for labels at the closest tier. --- */
    let budget = VALUE_BUDGET
    for (let k = 0; k < keep && budget > 0; k++) {
      const c = cands[order[k]]
      if (c.tier !== TIER_VALUE || !c.entry?.metrics) {
        c.valueText = ''
        continue
      }
      c.valueClock -= dt
      if (c.valueClock > 0) continue
      c.valueClock = VALUE_PERIOD
      budget--
      let next = ''
      try {
        const m = c.entry.metrics(s)
        if (m.length > 0) next = `${m[0].label} ${m[0].value}`
      } catch {
        /* A metrics function that throws must not take the signage with it. */
        next = ''
      }
      c.valueText = next
    }

    /* --- write. Every DOM mutation in this project happens below here. --- */
    for (let k = 0; k < keep; k++) {
      const i = order[k]
      const c = cands[i]
      if (c.slot < 0) continue
      const sl = slots[c.slot]
      const fresh = sl.cand !== i
      sl.cand = i

      if (fresh || sl.text !== c.text) {
        sl.text = c.text
        sl.tEl.textContent = c.text
        sl.measure = true
      }
      if (fresh || sl.district !== c.isDistrict) {
        sl.district = c.isDistrict
        sl.box.style.textTransform = c.isDistrict ? 'uppercase' : 'none'
        sl.box.style.letterSpacing = c.isDistrict ? '.16em' : '.01em'
        sl.box.style.fontSize = c.isDistrict ? '13px' : '12px'
        sl.measure = true
      }
      const wantValue = c.tier === TIER_VALUE && c.valueText.length > 0
      if (sl.value !== (wantValue ? c.valueText : '')) {
        sl.value = wantValue ? c.valueText : ''
        sl.vEl.textContent = sl.value
        sl.vEl.style.display = wantValue ? 'block' : 'none'
        sl.measure = true
      }

      const x = Math.round(c.sx)
      const y = Math.round(c.sy)
      if (x !== sl.x || y !== sl.y || fresh) {
        sl.x = x
        sl.y = y
        sl.el.style.transform = `translate3d(${x}px,${y}px,0)`
      }
      const op = c.opacity
      if (Math.abs(op - sl.opacity) > 0.02 || fresh) {
        sl.opacity = op
        sl.el.style.opacity = op < 1 ? op.toFixed(2) : ''
      }
      if (!sl.shown) {
        sl.shown = true
        sl.el.style.display = ''
      }
    }
    for (let sI = 0; sI < MAX_SLOTS; sI++) {
      const sl = slots[sI]
      if (sl.cand === -1 && sl.shown) {
        sl.shown = false
        sl.el.style.display = 'none'
      }
    }

    /* --- read, once, at the end: the only forced layout of the frame, and
     * only for labels whose text actually changed. --- */
    for (let sI = 0; sI < MAX_SLOTS; sI++) {
      const sl = slots[sI]
      if (!sl.measure || !sl.shown) continue
      sl.measure = false
      sl.w = sl.box.offsetWidth
      sl.h = sl.box.offsetHeight
    }
  }

  function setVisible(v: boolean): void {
    visible = v
    container.style.display = v ? '' : 'none'
  }

  function dispose(): void {
    window.removeEventListener('resize', onResize)
    for (let i = 0; i < slots.length; i++) slots[i].el.remove()
    slots.length = 0
    cands.length = 0
  }

  sync()
  return { update, setVisible, dispose }
}
