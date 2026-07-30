import type { Bus } from '../core/bus'
import { flowPath, PATHS } from '../world/paths'

/* ============================================================================
 * THE PATH READER
 *
 * A dock along the left edge: pick a chain, then walk it one hop at a time. The
 * city dims behind it (engine/trace.ts owns that), so the reader is looking at
 * one causal chain instead of the whole plan.
 *
 * This file owns no geometry and no camera. It emits `trace` and lets main.ts
 * decide what the scene does — the same intent-not-command rule every other
 * panel follows.
 * ==========================================================================*/

export interface PathReader {
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

export function createPathReader(bus: Bus): PathReader {
  if (typeof document === 'undefined') return { dispose: () => {} }
  const host = document.getElementById('paths')
  if (!host) {
    console.warn('[ui/paths] #paths is missing from the document; path reader disabled')
    return { dispose: () => {} }
  }

  const panel = el('div', 'pth')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Follow a flow')

  const head = el('div', 'pth-head')
  const title = el('h2', 'pth-title', 'Follow a flow')
  const close = el('button', 'pth-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Stop following')
  head.append(title, close)

  const blurb = el('p', 'pth-blurb', 'One chain at a time, with the rest of the city out of the way.')

  /* The picker: every chain, always reachable so switching costs one click. */
  const list = el('div', 'pth-list')
  const steps = el('ol', 'pth-steps')
  const foot = el('div', 'pth-foot')
  const prev = el('button', 'pth-btn', 'Back')
  prev.type = 'button'
  const next = el('button', 'pth-btn pth-btn-primary', 'Next')
  next.type = 'button'
  const counter = el('span', 'pth-count')
  foot.append(prev, next, counter)

  panel.append(head, blurb, list, steps, foot)
  host.append(panel)
  host.hidden = true

  /* ------------------------------------------------------------------ state */

  let activeId: string | null = null
  let hop = 0
  const stepNodes: HTMLElement[] = []

  const emit = (): void => {
    bus.emit('trace', { id: activeId, hop })
  }

  const renderPicker = (): void => {
    list.textContent = ''
    /* While a chain is running the catalogue is noise: collapse it to one row
     * that names the chain and offers the way back. */
    if (activeId !== null) {
      const p = flowPath(activeId)
      const back = el('button', 'pth-pick pth-pick-back')
      back.type = 'button'
      back.dataset.all = '1'
      back.append(
        el('span', 'pth-pick-title', p ? p.title : 'Follow a flow'),
        el('span', 'pth-pick-blurb', 'Pick a different chain'),
      )
      list.appendChild(back)
      return
    }
    for (const p of PATHS) {
      const b = el('button', 'pth-pick')
      b.type = 'button'
      b.dataset.id = p.id
      b.append(el('span', 'pth-pick-title', p.title), el('span', 'pth-pick-blurb', p.blurb))
      if (p.id === activeId) b.classList.add('is-on')
      list.appendChild(b)
    }
  }

  const renderSteps = (): void => {
    steps.textContent = ''
    stepNodes.length = 0
    const path = activeId ? flowPath(activeId) : undefined
    if (!path) {
      foot.hidden = true
      steps.hidden = true
      return
    }
    foot.hidden = false
    steps.hidden = false
    for (let i = 0; i < path.hops.length; i++) {
      const h = path.hops[i]
      const li = el('li', 'pth-step')
      li.dataset.i = String(i)
      if (i === hop) li.classList.add('is-on')
      if (i < hop) li.classList.add('is-done')
      li.append(el('span', 'pth-step-title', h.title), el('span', 'pth-step-detail', h.detail))
      steps.appendChild(li)
      stepNodes.push(li)
    }
    counter.textContent = `${hop + 1} / ${path.hops.length}`
    prev.toggleAttribute('disabled', hop === 0)
    next.toggleAttribute('disabled', hop >= path.hops.length - 1)
    stepNodes[hop]?.scrollIntoView({ block: 'nearest' })
  }

  const paint = (): void => {
    renderPicker()
    renderSteps()
  }

  const start = (id: string): void => {
    activeId = id
    hop = 0
    host.hidden = false
    bus.emit('overlay', { id: 'paths', open: true })
    paint()
    emit()
  }

  const stop = (): void => {
    activeId = null
    hop = 0
    host.hidden = true
    bus.emit('overlay', { id: 'paths', open: false })
    paint()
    emit()
  }

  const goto = (i: number): void => {
    const path = activeId ? flowPath(activeId) : undefined
    if (!path) return
    hop = Math.max(0, Math.min(path.hops.length - 1, i))
    renderSteps()
    renderPicker()
    emit()
  }

  /* ---------------------------------------------------------------- wiring */

  const onClick = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return
    if (t.closest('.pth-close')) {
      stop()
      return
    }
    const pick = t.closest('.pth-pick')
    if (pick instanceof HTMLElement && pick.dataset.all) {
      /* Back to the catalogue without releasing the city, so the reader can
       * switch chains without losing the isolated view. */
      activeId = null
      hop = 0
      paint()
      emit()
      return
    }
    if (pick instanceof HTMLElement && pick.dataset.id) {
      start(pick.dataset.id)
      return
    }
    const step = t.closest('.pth-step')
    if (step instanceof HTMLElement && step.dataset.i) {
      goto(Number(step.dataset.i))
      return
    }
    if (t === prev) goto(hop - 1)
    else if (t === next) goto(hop + 1)
  }
  host.addEventListener('click', onClick)

  const typing = (ev: KeyboardEvent): boolean => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return false
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  }

  /* While a chain is open the arrow keys walk it; the camera keeps the rest. */
  const onKey = (ev: KeyboardEvent): void => {
    if (typing(ev)) return
    if (activeId === null) {
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'f' || ev.key === 'F')) {
        ev.preventDefault()
        host.hidden = false
        bus.emit('overlay', { id: 'paths', open: true })
        paint()
      }
      return
    }
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault()
        stop()
        break
      case 'ArrowRight':
      case ' ':
        ev.preventDefault()
        goto(hop + 1)
        break
      case 'ArrowLeft':
        ev.preventDefault()
        goto(hop - 1)
        break
      default:
        break
    }
  }
  window.addEventListener('keydown', onKey, true)

  const offOverlay = bus.on('overlay', (p) => {
    if (p.id === 'paths') {
      if (p.open && host.hidden) {
        host.hidden = false
        paint()
      }
      return
    }
    /* A modal that takes the keyboard wins; stop following rather than fight. */
    if (p.open && (p.id === 'help' || p.id === 'tour' || p.id === 'search' || p.id === 'console')) {
      if (activeId !== null) stop()
      else if (!host.hidden) {
        host.hidden = true
        bus.emit('overlay', { id: 'paths', open: false })
      }
    }
  })

  paint()

  return {
    dispose(): void {
      offOverlay()
      host.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKey, true)
      host.textContent = ''
      host.hidden = true
      stepNodes.length = 0
      activeId = null
    },
  }
}
