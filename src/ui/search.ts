import type { Bus } from '../core/bus'
import type { Registry } from '../core/registry'
import { COLOR, setPref } from '../core/theme'
import type { DistrictId, Knobs } from '../core/types'
import { formatCpu, formatMem } from '../core/util'
import { SCENARIOS } from '../sim/scenarios'
import { DISTRICTS } from '../world/layout'

/* ============================================================================
 * THE COMMAND PALETTE
 *
 * Everything the city can be asked to do, in one keyboard-driven list:
 * every registered component, every knob, every failure scenario, and the
 * district jumps. Selecting an item emits an intent on the bus — 'focus',
 * 'knob' or 'scenario' — and the simulation decides what that means.
 * ==========================================================================*/

export interface Search {
  dispose(): void
}

type CmdKind = 'component' | 'scenario' | 'knob' | 'go' | 'action'

interface Cmd {
  kind: CmdKind
  label: string
  sub: string
  /** Right-hand tag: the district, the knob key, or nothing. */
  tag: string
  /** Lower-cased haystack. Built once at construction. */
  terms: string
  accent: number
  run: () => void
}

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

/** Prefix beats word-start beats substring, so "pod" finds Pod before Podium. */
function score(terms: string, q: string): number {
  if (q === '') return 1
  if (terms.startsWith(q)) return 90
  const i = terms.indexOf(q)
  if (i < 0) return 0
  return terms.charAt(i - 1) === ' ' ? 60 : 30
}

/* ---------------------------------------------------------------------------
 * Scenarios come from the simulation's own catalogue rather than a copy kept
 * here: an id the palette invents is a command that silently does nothing, and
 * a blurb kept in two places drifts.
 * -------------------------------------------------------------------------*/

/* ---------------------------------------------------------------------------
 * Knobs. Each is one concrete value, because a palette entry that only says
 * "adjust replicas" cannot be executed by pressing Enter.
 * -------------------------------------------------------------------------*/

interface KnobDef {
  key: keyof Knobs
  value: number | boolean
  label: string
  sub: string
  terms: string
  /** Shown before anything is typed. Keeps the resting palette readable. */
  top?: boolean
}

const KNOBS: readonly KnobDef[] = [
  { key: 'replicas', value: 1, label: 'Scale to 1 replica', sub: 'Writes spec.replicas on the Deployment. Nothing else.', terms: 'scale replicas deployment' },
  { key: 'replicas', value: 3, label: 'Scale to 3 replicas', sub: 'Writes spec.replicas on the Deployment. Nothing else.', terms: 'scale replicas deployment', top: true },
  { key: 'replicas', value: 6, label: 'Scale to 6 replicas', sub: 'Writes spec.replicas on the Deployment. Nothing else.', terms: 'scale replicas deployment', top: true },
  { key: 'replicas', value: 12, label: 'Scale to 12 replicas', sub: 'More than one node can hold: some pods will stay Pending.', terms: 'scale replicas deployment pending' },

  { key: 'hpaEnabled', value: true, label: 'HorizontalPodAutoscaler on', sub: 'A controller on a 15s timer that writes the replica count for you.', terms: 'hpa autoscale autoscaler enable', top: true },
  { key: 'hpaEnabled', value: false, label: 'HorizontalPodAutoscaler off', sub: 'The desired count goes back to being yours alone.', terms: 'hpa autoscale autoscaler disable' },
  { key: 'hpaTargetUtilization', value: 50, label: 'HPA target 50% of requests', sub: 'Utilisation is measured against requests, never limits.', terms: 'hpa target utilisation utilization' },
  { key: 'hpaTargetUtilization', value: 70, label: 'HPA target 70% of requests', sub: 'Utilisation is measured against requests, never limits.', terms: 'hpa target utilisation utilization' },
  { key: 'hpaTargetUtilization', value: 90, label: 'HPA target 90% of requests', sub: 'Utilisation is measured against requests, never limits.', terms: 'hpa target utilisation utilization' },

  { key: 'trafficRps', value: 0, label: 'Traffic 0 rps', sub: 'Quiet the ingress; CPU falls and the HPA will want to scale down.', terms: 'traffic load rps ingress idle' },
  { key: 'trafficRps', value: 120, label: 'Traffic 120 rps', sub: 'External requests arriving at the ingress each second.', terms: 'traffic load rps ingress', top: true },
  { key: 'trafficRps', value: 600, label: 'Traffic 600 rps', sub: 'Enough to push CPU past a 70% HPA target.', terms: 'traffic load rps ingress spike', top: true },

  { key: 'requestCpuMilli', value: 100, label: `CPU request ${formatCpu(100)}`, sub: 'Requests are what the scheduler subtracts from allocatable.', terms: 'cpu request resources scheduling' },
  { key: 'requestCpuMilli', value: 250, label: `CPU request ${formatCpu(250)}`, sub: 'Requests are what the scheduler subtracts from allocatable.', terms: 'cpu request resources scheduling' },
  { key: 'requestCpuMilli', value: 1000, label: `CPU request ${formatCpu(1000)}`, sub: 'Four of these fill a node whatever the containers actually use.', terms: 'cpu request resources scheduling pending' },
  { key: 'limitCpuMilli', value: 250, label: `CPU limit ${formatCpu(250)}`, sub: 'Limits are a cgroup quota: they throttle, they never schedule.', terms: 'cpu limit throttle cgroup' },
  { key: 'limitCpuMilli', value: 500, label: `CPU limit ${formatCpu(500)}`, sub: 'Limits are a cgroup quota: they throttle, they never schedule.', terms: 'cpu limit throttle cgroup' },
  { key: 'requestMemMib', value: 256, label: `Memory request ${formatMem(256)}`, sub: 'Requests schedule. Memory requests are not a reservation the kernel enforces.', terms: 'memory request resources' },
  { key: 'limitMemMib', value: 512, label: `Memory limit ${formatMem(512)}`, sub: 'The memory limit is the number the OOM killer uses.', terms: 'memory limit oom' },
  { key: 'limitMemMib', value: 256, label: `Memory limit ${formatMem(256)}`, sub: 'Tight enough that a leaking container will be OOMKilled.', terms: 'memory limit oom kill' },

  { key: 'maxSurge', value: 0, label: 'maxSurge 0', sub: 'A rolling update may never exceed the desired count.', terms: 'maxsurge rollout rolling update' },
  { key: 'maxSurge', value: 1, label: 'maxSurge 1', sub: 'One extra pod may exist during a rolling update.', terms: 'maxsurge rollout rolling update' },
  { key: 'maxUnavailable', value: 0, label: 'maxUnavailable 0', sub: 'No promised pod may be missing: the safest and slowest rollout.', terms: 'maxunavailable rollout rolling update' },
  { key: 'maxUnavailable', value: 1, label: 'maxUnavailable 1', sub: 'One promised pod may be missing during a rolling update.', terms: 'maxunavailable rollout rolling update' },

  { key: 'imagePullSeconds', value: 2, label: 'Image pull takes 2s', sub: 'How long an uncached layer set takes to arrive.', terms: 'image pull registry seconds' },
  { key: 'imagePullSeconds', value: 20, label: 'Image pull takes 20s', sub: 'Slow enough to watch the node cache change the second pod.', terms: 'image pull registry seconds slow' },

  { key: 'readinessPeriodSeconds', value: 5, label: 'Readiness probe every 5s', sub: 'Readiness decides traffic, never restarts.', terms: 'readiness probe period' },
  { key: 'readinessPeriodSeconds', value: 30, label: 'Readiness probe every 30s', sub: 'Period times failureThreshold is how long a bad pod keeps traffic.', terms: 'readiness probe period slow' },
  { key: 'livenessPeriodSeconds', value: 10, label: 'Liveness probe every 10s', sub: 'Liveness restarts the container. It is a repair action.', terms: 'liveness probe period restart' },
  { key: 'probeFailureThreshold', value: 1, label: 'Probe failureThreshold 1', sub: 'One bad response is enough. Usually a mistake.', terms: 'probe failure threshold flap' },
  { key: 'probeFailureThreshold', value: 3, label: 'Probe failureThreshold 3', sub: 'The default: three consecutive failures before it counts.', terms: 'probe failure threshold' },

  { key: 'webhookLatencyMs', value: 40, label: 'Webhook latency 40ms', sub: 'Every matching write pays this, on the write path, every time.', terms: 'webhook admission latency' },
  { key: 'webhookLatencyMs', value: 800, label: 'Webhook latency 800ms', sub: 'Watch requests queue on the admission floor.', terms: 'webhook admission latency slow', top: true },
  { key: 'webhookReachable', value: false, label: 'Admission webhook unreachable', sub: 'With failurePolicy: Fail the apiserver returns 500 and writes stop.', terms: 'webhook admission down unreachable failurepolicy' },
  { key: 'webhookReachable', value: true, label: 'Admission webhook reachable', sub: 'Its backing Service has ready endpoints again.', terms: 'webhook admission up restore' },

  { key: 'etcdFsyncMs', value: 3, label: 'etcd fsync 3ms', sub: 'Healthy disk. Raft can acknowledge quickly.', terms: 'etcd fsync disk latency' },
  { key: 'etcdFsyncMs', value: 120, label: 'etcd fsync 120ms', sub: 'A slow disk under raft is what most control-plane pain actually is.', terms: 'etcd fsync disk latency slow', top: true },
  { key: 'etcdMembersDown', value: 1, label: 'Take 1 etcd member down', sub: 'Two of three still form a majority: writes continue.', terms: 'etcd member down quorum raft' },
  { key: 'etcdMembersDown', value: 2, label: 'Take 2 etcd members down', sub: 'No majority: no commits, and the API server cannot write.', terms: 'etcd member down quorum raft outage' },
  { key: 'etcdMembersDown', value: 0, label: 'Restore all etcd members', sub: 'The followers catch up from the leader\'s log.', terms: 'etcd member restore quorum' },

  { key: 'nodeDown', value: 1, label: 'Take 1 node down', sub: 'Its Lease stops: NotReady at 40s, pod eviction at 5 minutes.', terms: 'node down failure lease notready', top: true },
  { key: 'nodeDown', value: 0, label: 'Bring every node back', sub: 'The kubelet resumes renewing its Lease.', terms: 'node up restore' },

  { key: 'crashLoop', value: true, label: 'CrashLoopBackOff on', sub: 'The container exits immediately and kubelet backs off 10s, 20s, 40s...', terms: 'crashloop crash restart backoff' },
  { key: 'crashLoop', value: false, label: 'CrashLoopBackOff off', sub: 'The container starts cleanly again.', terms: 'crashloop crash off' },
  { key: 'imagePullFailure', value: true, label: 'Image pull failure on', sub: 'ErrImagePull, then ImagePullBackOff. The pod is scheduled and still not running.', terms: 'image pull failure errimagepull' },
  { key: 'imagePullFailure', value: false, label: 'Image pull failure off', sub: 'The registry answers again.', terms: 'image pull ok off' },
  { key: 'memoryLeak', value: true, label: 'Memory leak on', sub: 'Watch the eviction order: BestEffort, then Burstable over requests, then Guaranteed.', terms: 'memory leak oom eviction qos' },
  { key: 'memoryLeak', value: false, label: 'Memory leak off', sub: 'Memory use settles back to normal.', terms: 'memory leak off' },
  { key: 'networkPolicyEnabled', value: true, label: 'NetworkPolicy on', sub: 'Selecting a pod at all makes it default-deny for everything not allowed.', terms: 'networkpolicy network policy deny' },
  { key: 'networkPolicyEnabled', value: false, label: 'NetworkPolicy off', sub: 'Every pod can reach every pod again, which is the default.', terms: 'networkpolicy off' },
  { key: 'podAntiAffinity', value: true, label: 'Pod anti-affinity on', sub: 'One replica per node: the filter starts rejecting nodes that already host one.', terms: 'antiaffinity affinity spread topology' },
  { key: 'podAntiAffinity', value: false, label: 'Pod anti-affinity off', sub: 'Replicas may share a node again.', terms: 'antiaffinity off' },

  { key: 'paused', value: true, label: 'Pause the cluster', sub: 'Freeze model time. Geometry stays interactive.', terms: 'pause stop freeze transport', top: true },
  { key: 'paused', value: false, label: 'Resume', sub: 'Model time advances again.', terms: 'resume play unpause transport', top: true },
  { key: 'timeScale', value: 0.25, label: 'Speed 0.25x', sub: 'Slow enough to read a single admission stage.', terms: 'speed slow time scale' },
  { key: 'timeScale', value: 1, label: 'Speed 1x', sub: 'One model second per real second.', terms: 'speed normal time scale' },
  { key: 'timeScale', value: 4, label: 'Speed 4x', sub: 'Fast enough to sit through a 5-minute eviction timer.', terms: 'speed fast time scale' },
]

export function createSearch(bus: Bus, registry: Registry): Search {
  if (typeof document === 'undefined') return { dispose: () => {} }
  const host = document.getElementById('search')
  if (!host) {
    console.warn('[ui/search] #search is missing from the document; palette disabled')
    return { dispose: () => {} }
  }

  /* ------------------------------------------------------------------ shell */

  const scrim = el('div', 'cmd-scrim')
  const dialog = el('div', 'cmd')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', 'Command palette')

  const bar = el('div', 'cmd-bar')
  const prompt = el('span', 'cmd-prompt', '>')
  const input = el('input', 'cmd-input')
  input.type = 'text'
  input.spellcheck = false
  input.autocapitalize = 'off'
  input.setAttribute('autocomplete', 'off')
  input.placeholder = 'Search components, knobs and scenarios'
  input.setAttribute('aria-label', 'Search components, knobs and scenarios')
  const esc = el('kbd', 'cmd-esc', 'Esc')
  bar.append(prompt, input, esc)

  const list = el('div', 'cmd-list')
  list.setAttribute('role', 'listbox')

  const foot = el('div', 'cmd-foot')
  foot.append(
    el('span', undefined, '↑↓ move'),
    el('span', undefined, '↵ select'),
    el('span', undefined, 'Esc close'),
  )

  dialog.append(bar, list, foot)
  host.append(scrim, dialog)
  host.hidden = true

  /* ------------------------------------------------------------------ state */

  let isOpen = false
  let cursor = 0
  const items: Cmd[] = []
  const nodes: HTMLElement[] = []

  /* ---------------------------------------------------------------- builders */

  const componentCmd = (id: string, title: string, sum: string, district: DistrictId): Cmd => ({
    kind: 'component',
    label: title,
    sub: sum,
    tag: DISTRICT_LABEL.get(district) ?? district,
    terms: '',
    accent: DISTRICT_COLOR[district],
    run: () => bus.emit('focus', { id, source: 'search' }),
  })

  const scenarioCmds: Cmd[] = SCENARIOS.map((s) => ({
    kind: 'scenario',
    label: s.title,
    sub: s.blurb,
    tag: 'scenario',
    terms: `${s.title} ${s.id} ${s.blurb}`.toLowerCase(),
    accent: COLOR.failed,
    run: () => {
      bus.emit('scenario', { id: s.id, running: true })
      bus.emit('toast', { text: `Scenario: ${s.title}`, kind: 'info' })
    },
  }))
  scenarioCmds.push({
    kind: 'scenario',
    label: 'Stop the running scenario',
    sub: 'Put the knobs back the way the scenario found them.',
    tag: 'scenario',
    terms: 'stop end cancel scenario reset',
    accent: COLOR.ready,
    run: () => bus.emit('scenario', { id: '', running: false }),
  })

  const knobCmds: Cmd[] = KNOBS.map((k) => ({
    kind: 'knob',
    label: k.label,
    sub: k.sub,
    tag: k.key,
    terms: `${k.label} ${k.key} ${k.terms}`.toLowerCase(),
    accent: COLOR.desired,
    run: () => {
      bus.emit('knob', { key: k.key, value: k.value })
      bus.emit('toast', { text: k.label, kind: 'info' })
    },
  }))
  const topKnobCmds: Cmd[] = knobCmds.filter((_, i) => KNOBS[i].top === true)

  const goCmds: Cmd[] = DISTRICTS.map((d) => ({
    kind: 'go',
    label: `Go to ${d.label}`,
    sub: 'Frame the whole district.',
    tag: d.id,
    terms: `go to district ${d.label} ${d.id}`.toLowerCase(),
    accent: DISTRICT_COLOR[d.id],
    run: () => bus.emit('focus-district', { id: d.id }),
  }))

  const actionCmds: Cmd[] = [
    {
      kind: 'action',
      label: 'Guided tour',
      sub: 'One kubectl apply followed the whole way, in fourteen chapters.',
      tag: 'T',
      terms: 'guided tour walkthrough teach chapters start',
      accent: COLOR.desired,
      run: () => bus.emit('overlay', { id: 'tour', open: true }),
    },
    {
      kind: 'action',
      label: 'Follow a flow',
      sub: 'Isolate one causal chain and step through it while the rest of the city dims.',
      tag: 'F',
      terms: 'follow flow path trace chain isolate step how does it work',
      accent: COLOR.ready,
      run: () => bus.emit('overlay', { id: 'paths', open: true }),
    },
    {
      kind: 'action',
      label: 'kubectl console',
      sub: 'A terminal that runs kubectl against the modelled cluster. get, describe, explain, scale.',
      tag: '`',
      terms: 'kubectl console terminal cli shell get describe explain command',
      accent: COLOR.api,
      run: () => bus.emit('overlay', { id: 'console', open: true }),
    },
    {
      kind: 'action',
      label: 'Keyboard map and colour legend',
      sub: 'Every input, and what every colour in the city means.',
      tag: '?',
      terms: 'help keys keyboard shortcuts legend colour color map',
      accent: COLOR.actual,
      run: () => bus.emit('overlay', { id: 'help', open: true }),
    },
    {
      kind: 'action',
      label: 'Night mode',
      sub: 'Structure goes matte and meaning glows.',
      tag: 'theme',
      terms: 'night dark theme mode',
      accent: COLOR.etcd,
      run: () => bus.emit('theme', { mode: setPref('night') }),
    },
    {
      kind: 'action',
      label: 'Day mode',
      sub: 'Hue and value carry meaning without bloom.',
      tag: 'theme',
      terms: 'day light theme mode',
      accent: COLOR.ingress,
      run: () => bus.emit('theme', { mode: setPref('day') }),
    },
    {
      kind: 'action',
      label: 'Reset cluster',
      sub: 'Re-seed everything. The only way to bring back a deleted Ingress, Service or Deployment.',
      tag: 'reset',
      terms: 'reset cluster reseed restore undo delete apply bring back',
      accent: COLOR.ready,
      run: () => bus.emit('reset', {}),
    },
    {
      kind: 'action',
      label: 'Close the inspector',
      sub: 'Clear the selection.',
      tag: 'Esc',
      terms: 'close inspector panel blur deselect',
      accent: COLOR.edge,
      run: () => bus.emit('overlay', { id: 'panel', open: false }),
    },
  ]

  /* ----------------------------------------------------------------- render */

  const addRow = (cmd: Cmd): void => {
    const row = el('button', 'cmd-item')
    row.type = 'button'
    row.setAttribute('role', 'option')
    row.dataset.i = String(items.length)
    row.style.setProperty('--cmd-raw', hex(cmd.accent))

    const kind = el('span', 'cmd-kind', cmd.kind)
    const main = el('span', 'cmd-main')
    main.append(el('span', 'cmd-label', cmd.label), el('span', 'cmd-sub', cmd.sub))
    const tag = el('span', 'cmd-tag', cmd.tag)

    row.append(kind, main, tag)
    list.appendChild(row)
    items.push(cmd)
    nodes.push(row)
  }

  const addSection = (heading: string, cmds: Cmd[]): void => {
    if (cmds.length === 0) return
    list.appendChild(el('div', 'cmd-group', heading))
    for (let i = 0; i < cmds.length; i++) addRow(cmds[i])
  }

  const rank = (source: Cmd[], q: string, limit: number): Cmd[] => {
    const out: { c: Cmd; s: number }[] = []
    for (let i = 0; i < source.length; i++) {
      const s = score(source[i].terms, q)
      if (s > 0) out.push({ c: source[i], s })
    }
    out.sort((a, b) => b.s - a.s)
    return out.slice(0, limit).map((o) => o.c)
  }

  const select = (next: number): void => {
    if (nodes.length === 0) return
    cursor = ((next % nodes.length) + nodes.length) % nodes.length
    for (let i = 0; i < nodes.length; i++) {
      const on = i === cursor
      nodes[i].classList.toggle('is-on', on)
      nodes[i].setAttribute('aria-selected', on ? 'true' : 'false')
    }
    nodes[cursor].scrollIntoView({ block: 'nearest' })
  }

  const render = (): void => {
    const q = input.value.trim().toLowerCase()
    list.textContent = ''
    items.length = 0
    nodes.length = 0

    if (q !== '') {
      const hits = registry.search(q, 14)
      const cmds: Cmd[] = []
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i]
        cmds.push(componentCmd(h.id, h.title, h.summary, h.district))
      }
      addSection('Components', cmds)
      addSection('Scenarios', rank(scenarioCmds, q, 6))
      addSection('Knobs', rank(knobCmds, q, 10))
      addSection('Go to', rank(goCmds, q, 4))
      addSection('Actions', rank(actionCmds, q, 4))
    } else {
      addSection('Start here', actionCmds.slice(0, 2))
      addSection('Scenarios', scenarioCmds.slice(0, 6))
      addSection('Knobs', topKnobCmds)
      addSection('Go to', goCmds)
      list.appendChild(
        el(
          'div',
          'cmd-note',
          `Type to search ${registry.size()} registered components, every knob and every scenario.`,
        ),
      )
    }

    if (items.length === 0) {
      list.appendChild(el('div', 'cmd-empty', `Nothing matches “${input.value.trim()}”.`))
    }
    select(0)
  }

  /* ------------------------------------------------------------------- open */

  const setOpen = (next: boolean): void => {
    if (next === isOpen) return
    isOpen = next
    host.hidden = !next
    bus.emit('overlay', { id: 'search', open: next })
    if (next) {
      input.value = ''
      render()
      input.focus()
    } else {
      input.blur()
    }
  }

  const run = (i: number): void => {
    const cmd = items[i]
    if (!cmd) return
    setOpen(false)
    cmd.run()
  }

  /* ---------------------------------------------------------------- wiring */

  const onInput = (): void => render()
  input.addEventListener('input', onInput)

  /* Everything typed while the palette is open belongs to the palette; the
   * camera listens on the window and must not see any of it. */
  const onDialogKey = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    switch (ev.key) {
      case 'Escape':
        ev.preventDefault()
        setOpen(false)
        break
      case 'ArrowDown':
        ev.preventDefault()
        select(cursor + 1)
        break
      case 'ArrowUp':
        ev.preventDefault()
        select(cursor - 1)
        break
      case 'Home':
        ev.preventDefault()
        select(0)
        break
      case 'End':
        ev.preventDefault()
        select(nodes.length - 1)
        break
      case 'Tab':
        ev.preventDefault()
        select(cursor + (ev.shiftKey ? -1 : 1))
        break
      case 'Enter':
        ev.preventDefault()
        run(cursor)
        break
      default:
        break
    }
  }
  dialog.addEventListener('keydown', onDialogKey)

  const onClick = (ev: MouseEvent): void => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return
    if (target === scrim) {
      setOpen(false)
      return
    }
    const row = target.closest('.cmd-item')
    if (row instanceof HTMLElement && row.dataset.i) run(Number(row.dataset.i))
  }
  host.addEventListener('click', onClick)

  const onMove = (ev: MouseEvent): void => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return
    const row = target.closest('.cmd-item')
    if (row instanceof HTMLElement && row.dataset.i) select(Number(row.dataset.i))
  }
  list.addEventListener('mousemove', onMove)

  const typing = (ev: KeyboardEvent): boolean => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return false
    return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
  }

  /* Capture phase: the palette's own shortcut must beat the camera's key map. */
  const onKey = (ev: KeyboardEvent): void => {
    if (isOpen || typing(ev)) return
    const meta = ev.ctrlKey || ev.metaKey
    if ((meta && (ev.key === 'k' || ev.key === 'K')) || (!meta && !ev.altKey && ev.key === '/')) {
      ev.preventDefault()
      ev.stopPropagation()
      setOpen(true)
    }
  }
  window.addEventListener('keydown', onKey, true)

  const offOverlay = bus.on('overlay', (p) => {
    if (p.id !== 'search') return
    setOpen(p.open)
  })

  /* Two modals on screen at once is a lost keyboard. */
  const offOther = bus.on('overlay', (p) => {
    if (p.open && (p.id === 'help' || p.id === 'tour' || p.id === 'console' || p.id === 'paths')) setOpen(false)
  })

  return {
    dispose(): void {
      offOverlay()
      offOther()
      input.removeEventListener('input', onInput)
      dialog.removeEventListener('keydown', onDialogKey)
      host.removeEventListener('click', onClick)
      list.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onKey, true)
      host.textContent = ''
      host.hidden = true
      items.length = 0
      nodes.length = 0
      isOpen = false
    },
  }
}
