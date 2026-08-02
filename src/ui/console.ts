import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import type { SimState } from '../core/types'
import type { Sim } from '../sim/model'
import {
  completeKubectl,
  commonPrefix,
  DEFAULT_NAMESPACE,
  runKubectl,
  type KubectlEnv,
  type OutLine,
} from './kubectl'

/* ============================================================================
 * THE CONSOLE
 *
 * A terminal that runs the kubectl in kubectl.ts against the live model. This
 * file is only the glue: it owns the scrollback, the prompt line, history and
 * a visible completion menu, and forwards the engine's intents to the bus.
 * Every decision about what a command means lives in the pure engine next door,
 * where it is tested without a DOM.
 * ==========================================================================*/

export interface Console {
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const BANNER: readonly OutLine[] = [
  { text: 'K8Skylines console — kubectl against the modelled cluster.', cls: 'head' },
  { text: `No apiserver is contacted; every value is read from the running simulation. Namespace defaults to "${DEFAULT_NAMESPACE}".`, cls: 'dim' },
  { text: 'Try:  get pods   ·   describe node node-1   ·   explain hpa   ·   help', cls: 'dim' },
]

export function createConsole(bus: Bus, registry: Registry, sim: Sim): Console {
  if (typeof document === 'undefined') return { dispose: () => {} }
  const host = document.getElementById('console')
  if (!host) {
    console.warn('[ui/console] #console is missing from the document; console disabled')
    return { dispose: () => {} }
  }

  const getState = (): SimState => sim.state
  const env: KubectlEnv = {
    state: getState,
    explain: (id) => {
      const e = registry.get(id)
      return e ? { summary: e.summary, caveats: e.caveats } : undefined
    },
    catalogue: () => sim.applyCatalogue(),
  }

  /* -------------------------------------------------------------- shell */

  const scrim = el('div', 'kc-scrim')
  const dialog = el('div', 'kc')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', 'kubectl console')

  const bar = el('div', 'kc-titlebar')
  bar.append(el('span', 'kc-dot'), el('span', 'kc-title', 'kubectl'), el('kbd', 'kc-esc', 'Esc'))

  const out = el('div', 'kc-out')
  out.setAttribute('role', 'log')
  out.setAttribute('aria-live', 'polite')

  /* The completion menu sits just above the prompt, the way a shell's does. */
  const menu = el('div', 'kc-menu')
  menu.hidden = true

  const lineWrap = el('div', 'kc-line')
  const prompt = el('span', 'kc-prompt', '$')

  /* An input cannot style part of its own text, so the "ghost" suffix lives in
   * a mirror behind the input: a hidden copy of what is typed pushes a dim copy
   * of the completion to exactly the caret position. */
  const field = el('div', 'kc-field')
  const ghost = el('div', 'kc-ghost')
  const ghostTyped = el('span', 'kc-ghost-typed')
  const ghostSuffix = el('span', 'kc-ghost-suffix')
  ghost.append(ghostTyped, ghostSuffix)
  const input = el('input', 'kc-input')
  input.type = 'text'
  input.spellcheck = false
  input.autocapitalize = 'off'
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('aria-label', 'kubectl command')
  field.append(ghost, input)
  lineWrap.append(prompt, field)

  const foot = el('div', 'kc-foot')
  foot.append(
    el('span', undefined, 'Tab / → complete'),
    el('span', undefined, '↑↓ history'),
    el('span', undefined, 'Esc close'),
  )

  dialog.append(bar, out, menu, lineWrap, foot)
  host.append(scrim, dialog)
  host.hidden = true

  /* -------------------------------------------------------------- state */

  let isOpen = false
  let bannered = false
  const history: string[] = []
  let histCursor = 0 /* points one past the last entry when not browsing */

  /* Live completion for the token under the caret. */
  let suggestions: string[] = []
  let suggestIdx = 0
  let suggestToken = ''

  /* -------------------------------------------------------------- render */

  const write = (lines: readonly OutLine[]): void => {
    for (const l of lines) {
      const row = el('div', l.cls ? `kc-row kc-${l.cls}` : 'kc-row')
      /* A leading/trailing empty line must still take vertical space. */
      row.textContent = l.text === '' ? ' ' : l.text
      out.appendChild(row)
    }
    out.scrollTop = out.scrollHeight
  }

  const echo = (cmd: string): void => {
    const row = el('div', 'kc-row kc-echo')
    row.append(el('span', 'kc-prompt', '$'), el('span', undefined, ' ' + cmd))
    out.appendChild(row)
  }

  /* Recompute completions for whatever is typed and paint the ghost + menu. */
  const refreshSuggest = (): void => {
    const c = completeKubectl(input.value, getState(), sim.applyCatalogue())
    suggestions = c.options
    suggestToken = c.token
    suggestIdx = 0
    paintSuggest()
  }

  const paintSuggest = (): void => {
    /* Ghost: the active candidate's remaining letters, in place. */
    const active = suggestions[suggestIdx]
    ghostTyped.textContent = input.value
    ghostSuffix.textContent =
      active && active.startsWith(suggestToken) && input.value.length > 0
        ? active.slice(suggestToken.length)
        : ''

    /* Menu: one chip per candidate, the active one lit. Hidden when a single
     * candidate already equals what is typed, so it never nags. */
    menu.textContent = ''
    const worth = suggestions.filter((o) => o !== suggestToken)
    if (worth.length === 0 || input.value.trim() === '') {
      menu.hidden = true
      return
    }
    menu.hidden = false
    for (let i = 0; i < suggestions.length; i++) {
      const chip = el('button', 'kc-chip', suggestions[i])
      chip.type = 'button'
      chip.dataset.i = String(i)
      if (i === suggestIdx) chip.classList.add('is-on')
      menu.appendChild(chip)
    }
  }

  const clearSuggest = (): void => {
    suggestions = []
    suggestToken = ''
    suggestIdx = 0
    ghostTyped.textContent = ''
    ghostSuffix.textContent = ''
    menu.textContent = ''
    menu.hidden = true
  }

  /* -------------------------------------------------------------- run */

  const submit = (): void => {
    const cmd = input.value
    input.value = ''
    clearSuggest()
    echo(cmd)
    if (cmd.trim() !== '' && history[history.length - 1] !== cmd.trim()) history.push(cmd.trim())
    histCursor = history.length

    const result = runKubectl(cmd, env)
    if (result.clear) {
      out.textContent = ''
    } else {
      write(result.lines)
    }
    for (const it of result.intents) {
      if (it.kind === 'knob') bus.emit('knob', { key: it.key, value: it.value })
      else if (it.kind === 'focus') bus.emit('focus', { id: it.id, source: 'menu' })
      else if (it.kind === 'toast') bus.emit('toast', { text: it.text, kind: it.level })
      else if (it.kind === 'delete') bus.emit('delete', { kind: it.resource, namespace: it.namespace, name: it.name })
      else if (it.kind === 'apply') bus.emit('apply', { kind: it.resource, name: it.name })
      else if (it.kind === 'edit') {
        bus.emit('edit', { kind: it.resource, namespace: it.namespace, name: it.name, path: it.path, value: it.value })
      }
    }
    out.scrollTop = out.scrollHeight
  }

  /* --------------------------------------------------------- completion */

  const replaceToken = (token: string, next: string): void => {
    const v = input.value
    const end = v.length - token.length
    input.value = v.slice(0, end) + next
  }

  /** Accept one candidate, add a space, and advance to the next token so Tab
   *  walks verb → kind → name without pausing. */
  const accept = (option: string): void => {
    replaceToken(suggestToken, option + ' ')
    refreshSuggest()
    input.focus()
  }

  /** Tab: fill the longest shared prefix first (the classic shell behaviour),
   *  and only commit to a whole candidate once it is unambiguous. */
  const complete = (): void => {
    if (suggestions.length === 0) return
    if (suggestions.length === 1) {
      accept(suggestions[0])
      return
    }
    const shared = commonPrefix(suggestions)
    if (shared.length > suggestToken.length) {
      replaceToken(suggestToken, shared)
      refreshSuggest()
    } else {
      /* Already at the shared prefix: accept the highlighted candidate. */
      accept(suggestions[suggestIdx])
    }
  }

  /* -------------------------------------------------------------- open */

  const setOpen = (next: boolean): void => {
    if (next === isOpen) return
    isOpen = next
    host.hidden = !next
    bus.emit('overlay', { id: 'console', open: next })
    if (next) {
      if (!bannered) {
        write(BANNER)
        bannered = true
      }
      input.focus()
      out.scrollTop = out.scrollHeight
    } else {
      input.blur()
      clearSuggest()
    }
  }

  /* -------------------------------------------------------------- wiring */

  const onInput = (): void => refreshSuggest()
  input.addEventListener('input', onInput)

  const onDialogKey = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault()
        setOpen(false)
        break
      case 'Enter':
        ev.preventDefault()
        submit()
        break
      case 'Tab':
        ev.preventDefault()
        /* Shift-Tab walks the menu; Tab alone completes. */
        if (ev.shiftKey && suggestions.length > 1) {
          suggestIdx = (suggestIdx - 1 + suggestions.length) % suggestions.length
          paintSuggest()
        } else {
          complete()
        }
        break
      case 'ArrowRight':
        /* Accept the ghost only when the caret is at the end and there is one. */
        if (input.selectionStart === input.value.length && ghostSuffix.textContent) {
          ev.preventDefault()
          accept(suggestions[suggestIdx])
        }
        break
      case 'ArrowUp':
        ev.preventDefault()
        if (histCursor > 0) {
          histCursor -= 1
          input.value = history[histCursor] ?? ''
          refreshSuggest()
        }
        break
      case 'ArrowDown':
        ev.preventDefault()
        if (histCursor < history.length) {
          histCursor += 1
          input.value = history[histCursor] ?? ''
          refreshSuggest()
        }
        break
      case 'l':
      case 'L':
        if (ev.ctrlKey) {
          ev.preventDefault()
          out.textContent = ''
        }
        break
      default:
        break
    }
  }
  dialog.addEventListener('keydown', onDialogKey)

  /* Keep the ghost aligned when the input scrolls horizontally on a long line. */
  const onScroll = (): void => {
    ghost.style.transform = `translateX(${-input.scrollLeft}px)`
  }
  input.addEventListener('scroll', onScroll)

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target
    if (target === scrim) {
      setOpen(false)
      return
    }
    if (target instanceof HTMLElement) {
      const chip = target.closest('.kc-chip')
      if (chip instanceof HTMLElement && chip.dataset.i) {
        accept(suggestions[Number(chip.dataset.i)])
        return
      }
    }
    /* A click anywhere else in the dialog returns focus to the prompt. */
    input.focus()
  }
  host.addEventListener('click', onClick)

  const typing = (ev: KeyboardEvent): boolean => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return false
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  }

  /* Backtick opens the console, the way a game console does. Capture phase so
   * it beats the camera's key map, and never while another field has focus. */
  const onKey = (ev: KeyboardEvent): void => {
    if (isOpen || typing(ev)) return
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === '`' || ev.key === '~')) {
      ev.preventDefault()
      ev.stopPropagation()
      setOpen(true)
    }
  }
  window.addEventListener('keydown', onKey, true)

  const offOverlay = bus.on('overlay', (p) => {
    if (p.id === 'console') {
      if (p.open !== isOpen) setOpen(p.open)
      return
    }
    /* Two modals at once is a lost keyboard: yield to any other overlay. */
    if (p.open && (p.id === 'help' || p.id === 'tour' || p.id === 'search' || p.id === 'scenarios')) setOpen(false)
  })

  return {
    dispose(): void {
      offOverlay()
      input.removeEventListener('input', onInput)
      input.removeEventListener('scroll', onScroll)
      dialog.removeEventListener('keydown', onDialogKey)
      host.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKey, true)
      host.textContent = ''
      host.hidden = true
      isOpen = false
    },
  }
}
