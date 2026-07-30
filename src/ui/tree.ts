import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import type { SimState } from '../core/types'
import { docsFor } from './docs-map'
import { KINDS, type Kind, type Row } from './kubectl'
import { podManifestByRef } from './manifest'

/* ============================================================================
 * THE RESOURCE TREE — the cluster as a browsable list.
 *
 * The city answers "how does this work". The console answers a typed question.
 * This answers the third one an operator actually asks all day: "what is in
 * here, and what is wrong with it" — a tree of namespaces and kinds on the left,
 * the selected object on the right.
 *
 * It lists the kinds from `KINDS` in kubectl.ts rather than its own table. A
 * second copy of that catalogue is precisely how a listing and a console start
 * disagreeing about what the cluster contains.
 *
 * Selection here is a concrete object, not a mechanism, which is why it emits
 * `inspect` rather than `focus`: "this pod", not "what is a Pod".
 * ==========================================================================*/

export interface Tree {
  update(s: SimState, dt: number): void
  dispose(): void
}

/** Read cadence. The tree is browsed, not watched. */
const REFRESH = 1 / 4

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** The `kind/name` an event stamps, so a row can find its own events. */
function eventSubject(kind: Kind, name: string): string {
  return `${kind.id.split('.').pop()}/${name}`
}

interface Sel {
  kindId: string
  namespace: string
  name: string
}

export function createTree(bus: Bus, registry: Registry): Tree {
  if (typeof document === 'undefined') return { update: () => {}, dispose: () => {} }
  const host = document.getElementById('tree')
  if (!host) {
    console.warn('[ui/tree] #tree is missing from the document; the tree view is disabled')
    return { update: () => {}, dispose: () => {} }
  }

  const wrap = el('div', 'tr-wrap')

  /* ------------------------------------------------------------------- left */

  const side = el('aside', 'tr-side')
  const searchRow = el('div', 'tr-search')
  const search = el('input', 'tr-input')
  search.type = 'search'
  search.placeholder = 'Filter by name…'
  search.spellcheck = false
  search.setAttribute('aria-label', 'Filter resources by name')
  searchRow.append(search)
  const listing = el('div', 'tr-list')
  side.append(searchRow, listing)

  /* ------------------------------------------------------------------ right */

  const detail = el('section', 'tr-detail')
  const dHead = el('div', 'tr-dhead')
  const dKind = el('span', 'tr-dkind')
  const dName = el('h2', 'tr-dname', 'Nothing selected')
  const dNs = el('span', 'tr-dns')
  dHead.append(dKind, dName, dNs)
  const dBody = el('div', 'tr-dbody')
  detail.append(dHead, dBody)

  wrap.append(side, detail)
  host.append(wrap)
  host.hidden = true

  /* ------------------------------------------------------------------ state */

  let sel: Sel | null = null
  let filter = ''
  let acc = 0
  /* Which kinds the reader has collapsed. Namespaces stay open: the tree is
   * small enough that hiding them by default would only add clicks. */
  const collapsed = new Set<string>()

  /* -------------------------------------------------------------- the tree */

  const paintList = (s: SimState): void => {
    listing.textContent = ''
    const q = filter.trim().toLowerCase()

    /* Group namespace -> kind -> rows, so the shape matches how an operator
     * thinks: a namespace is the unit of ownership, not the kind. */
    const byNs = new Map<string, Map<Kind, Row[]>>()
    for (const kind of KINDS) {
      let rows = kind.rows(s)
      if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      if (rows.length === 0) continue
      for (const r of rows) {
        const ns = kind.namespaced ? r.namespace : 'cluster-scoped'
        let kinds = byNs.get(ns)
        if (!kinds) {
          kinds = new Map()
          byNs.set(ns, kinds)
        }
        const list = kinds.get(kind)
        if (list) list.push(r)
        else kinds.set(kind, [r])
      }
    }

    if (byNs.size === 0) {
      listing.append(el('p', 'tr-empty', q ? `Nothing matches “${filter.trim()}”.` : 'No resources.'))
      return
    }

    /* Cluster-scoped last: it is the smallest group and not what a reader is
     * usually looking for. */
    const namespaces = [...byNs.keys()].sort((a, b) => {
      if (a === 'cluster-scoped') return 1
      if (b === 'cluster-scoped') return -1
      return a.localeCompare(b)
    })

    for (const ns of namespaces) {
      const nsBlock = el('div', 'tr-ns')
      nsBlock.append(el('div', 'tr-ns-t', ns))
      const kinds = byNs.get(ns)!
      for (const [kind, rows] of kinds) {
        const key = `${ns}/${kind.id}`
        const isShut = collapsed.has(key)
        const kindRow = el('button', 'tr-kind')
        kindRow.type = 'button'
        kindRow.dataset.collapse = key
        kindRow.append(
          el('span', 'tr-caret', isShut ? '▸' : '▾'),
          el('span', 'tr-kind-t', kind.title),
          el('span', 'tr-count', String(rows.length)),
        )
        nsBlock.append(kindRow)
        if (isShut) continue

        for (const r of rows) {
          const item = el('button', 'tr-item')
          item.type = 'button'
          item.dataset.kind = kind.id
          item.dataset.ns = r.namespace
          item.dataset.name = r.name
          /* Column 2 is the one that says whether this object is healthy for
           * every kind that has one; showing it here is what makes the tree
           * scannable rather than a list of names. */
          const status = kind.columns.length > 1 ? (r.cells[1] ?? '') : ''
          item.append(el('span', 'tr-item-t', r.name))
          if (status) item.append(el('span', `tr-item-s ${statusClass(status)}`, status))
          if (sel && sel.kindId === kind.id && sel.name === r.name && sel.namespace === r.namespace) {
            item.classList.add('is-on')
          }
          nsBlock.append(item)
        }
      }
      listing.append(nsBlock)
    }
  }

  /** Health from the status text, using the same words kubectl prints. */
  const statusClass = (status: string): string => {
    if (/CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|Failed|NotReady/.test(status)) return 'is-bad'
    if (/Pending|Terminating|Unknown|Init:/.test(status)) return 'is-warn'
    if (/Ready|Running|Bound|Completed|Succeeded/.test(status)) return 'is-ok'
    /* A ratio like 3/4 is healthy only when it is whole. */
    const m = /^(\d+)\/(\d+)$/.exec(status)
    if (m) return m[1] === m[2] ? 'is-ok' : 'is-warn'
    return ''
  }

  /* ------------------------------------------------------------ the detail */

  const paintDetail = (s: SimState): void => {
    dBody.textContent = ''
    if (!sel) {
      dKind.textContent = ''
      dName.textContent = 'Nothing selected'
      dNs.textContent = ''
      dBody.append(el('p', 'tr-hint', 'Pick a resource on the left. Everything shown is read from the running model.'))
      return
    }
    const kind = KINDS.find((k) => k.id === sel!.kindId)
    const row = kind?.rows(s).find((r) => r.name === sel!.name && r.namespace === sel!.namespace)
    dKind.textContent = kind ? kind.title : sel.kindId
    dName.textContent = sel.name
    dNs.textContent = kind?.namespaced ? sel.namespace : 'cluster-scoped'

    if (!kind || !row) {
      /* The object went away while it was selected — a deleted pod, a removed
       * node. Say so instead of showing the last values as if they were live. */
      dBody.append(el('p', 'tr-gone', 'This object no longer exists in the cluster.'))
      return
    }

    /* Status: the kind's own columns, which is exactly what `kubectl get` shows. */
    const table = el('div', 'tr-rows')
    const cols = kind.wide ? [...kind.columns, ...kind.wide] : kind.columns
    for (let i = 1; i < cols.length; i++) {
      const r = el('div', 'tr-row')
      r.append(el('span', 'tr-k', cols[i].toLowerCase()), el('span', 'tr-v', row.cells[i] ?? ''))
      table.append(r)
    }
    dBody.append(sectionTitle('Status'), table)

    /* What this kind is, from the same Explainer the city uses. */
    const entry = registry.get(kind.focus)
    if (entry) {
      dBody.append(sectionTitle(`What a ${kind.title} is`))
      dBody.append(el('p', 'tr-prose', entry.summary))
      const doc = docsFor(kind.focus)
      if (doc) {
        const a = el('a', 'tr-doc')
        a.href = doc.url
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        a.textContent = `kubernetes.io — ${doc.text}`
        dBody.append(a)
      }
    }

    /* The manifest, per object where the model can build one honestly. */
    dBody.append(sectionTitle('Manifest'))
    if (kind.id === 'pod') {
      const pod = [...s.pods.values()].find((p) => p.name === sel!.name && p.namespace === sel!.namespace)
      if (pod) {
        const pre = el('pre', 'tr-yaml')
        pre.textContent = podManifestByRef(pod)
        dBody.append(pre)
      }
    } else {
      /* Being straight about the gap beats printing another object's YAML and
       * letting the reader believe it is this one's. */
      dBody.append(
        el('p', 'tr-hint', 'A per-object manifest is only modelled for Pods so far. Use the console: kubectl get ' + kind.names[1] + ' ' + sel.name + ' -o yaml'),
      )
    }

    /* Events about this exact object, newest last. */
    const subj = eventSubject(kind, sel.name)
    const evs = s.events.filter((e) => e.involved === subj).slice(-8)
    dBody.append(sectionTitle('Events'))
    if (evs.length === 0) {
      dBody.append(el('p', 'tr-hint', 'No events for this object.'))
    } else {
      const list = el('div', 'tr-evs')
      for (const e of evs) {
        const row2 = el('div', `tr-ev ${e.type === 'Warning' ? 'is-warn' : ''}`)
        row2.append(
          el('span', 'tr-ev-r', e.reason),
          el('span', 'tr-ev-m', e.message),
          el('span', 'tr-ev-c', e.count > 1 ? `×${e.count}` : ''),
        )
        list.append(row2)
      }
      dBody.append(list)
    }
  }

  const sectionTitle = (t: string): HTMLElement => el('h3', 'tr-sec', t)

  /* ---------------------------------------------------------------- update */

  const update = (s: SimState, dt: number): void => {
    if (host.hidden) return
    acc += dt
    if (acc < REFRESH) return
    acc = 0
    paintList(s)
    paintDetail(s)
  }

  /* --------------------------------------------------------------- wiring */

  let last: SimState | null = null
  const repaint = (): void => {
    if (last) {
      paintList(last)
      paintDetail(last)
    }
  }
  const updateWrapped = (s: SimState, dt: number): void => {
    last = s
    update(s, dt)
  }

  const onClick = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return
    const shut = t.closest('.tr-kind')
    if (shut instanceof HTMLElement && shut.dataset.collapse) {
      const k = shut.dataset.collapse
      if (collapsed.has(k)) collapsed.delete(k)
      else collapsed.add(k)
      repaint()
      return
    }
    const item = t.closest('.tr-item')
    if (item instanceof HTMLElement && item.dataset.kind && item.dataset.name) {
      sel = { kindId: item.dataset.kind, namespace: item.dataset.ns ?? '', name: item.dataset.name }
      bus.emit('inspect', { kind: sel.kindId, namespace: sel.namespace, name: sel.name })
      repaint()
    }
  }
  host.addEventListener('click', onClick)

  const onInput = (): void => {
    filter = search.value
    repaint()
  }
  search.addEventListener('input', onInput)

  /* Typing in the filter must not reach the camera or any global shortcut. */
  const onKey = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
  }
  side.addEventListener('keydown', onKey)

  /* Another surface selected an object: follow it, so the three views agree. */
  const offInspect = bus.on('inspect', (p) => {
    if (!p.name) {
      sel = null
    } else if (!sel || sel.kindId !== p.kind || sel.name !== p.name || sel.namespace !== p.namespace) {
      sel = { kindId: p.kind, namespace: p.namespace, name: p.name }
    } else {
      return
    }
    repaint()
  })

  return {
    update: updateWrapped,
    dispose(): void {
      offInspect()
      host.removeEventListener('click', onClick)
      search.removeEventListener('input', onInput)
      side.removeEventListener('keydown', onKey)
      host.textContent = ''
      host.hidden = true
      sel = null
    },
  }
}
