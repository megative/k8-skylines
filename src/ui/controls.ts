/* ============================================================================
 * src/ui/controls.ts — the knob rail.
 *
 * Every field of `Knobs` gets exactly one control here, and no control ever
 * writes to the model: it emits `knob` on the bus and the simulation decides
 * what the value becomes. `update()` then reflects whatever the simulation
 * actually settled on, which is why a slider snaps back when the HPA takes
 * ownership of `.spec.replicas`.
 *
 * Each knob carries one line saying what it changes in a real cluster. A slider
 * with no explanation teaches nothing; it just makes the city twitch.
 * ==========================================================================*/

import type { Bus } from '../core/bus'
import {
  DEFAULT_KNOBS,
  ETCD_QUORUM,
  N_ETCD_MEMBERS,
  N_NODES,
  type Knobs,
  type SimState,
} from '../core/types'
import { formatCpu, formatMem, formatMs } from '../core/util'

export interface Controls {
  update(s: SimState): void
  dispose(): void
}

/* Discrete speeds, because a continuous time dilation slider invites 1.37×,
 * which makes every timing in the city harder to reason about, not easier. */
const TIME_SCALES = [0.25, 0.5, 1, 2, 4, 8] as const

/* ---------------------------------------------------------------------------
 * Read-outs. Units are spelled the way Kubernetes spells them.
 * -------------------------------------------------------------------------*/

const fmtInt = (v: number): string => String(v)
/** 0 means the field is absent from the pod spec, which is a QoS decision. */
const fmtCpu = (v: number): string => (v > 0 ? formatCpu(v) : 'unset')
const fmtMem = (v: number): string => (v > 0 ? formatMem(v) : 'unset')
const fmtSec = (v: number): string => `${v}s`
const fmtPct = (v: number): string => `${v}%`
const fmtRps = (v: number): string => `${v}/s`
const fmtScale = (v: number): string => `${v}×`

type KnobKind = 'range' | 'toggle' | 'steps'

export interface KnobSpec {
  key: keyof Knobs
  label: string
  /** What turning this actually changes in a real cluster. One line. */
  why: string
  kind: KnobKind
  min?: number
  max?: number
  step?: number
  values?: readonly number[]
  fmt?: (v: number) => string
}

interface KnobGroup {
  id: string
  title: string
  hue: string
  note: string
  knobs: KnobSpec[]
}

/**
 * Every knob's definition lives here once. The inspector renders the same
 * specs inline on a component's card, so a slider cannot describe itself one
 * way in the rail and another way on the building it belongs to.
 */
export function knobSpec(key: keyof Knobs): KnobSpec | undefined {
  for (const g of GROUPS) for (const k of g.knobs) if (k.key === key) return k
  return undefined
}

const GROUPS: KnobGroup[] = [
  {
    id: 'deployment',
    title: 'Deployment',
    hue: 'var(--k8-desired)',
    note: 'The record you edit. It runs nothing itself: it scales one ReplicaSet up and another down, within this budget.',
    knobs: [
      {
        key: 'replicas',
        label: 'Replicas',
        why: 'Writes .spec.replicas. The ReplicaSet controller then creates or deletes Pods until as many exist as the record asks for.',
        kind: 'range',
        min: 0,
        max: 20,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'maxSurge',
        label: 'maxSurge',
        why: 'strategy.rollingUpdate.maxSurge — how many Pods may exist above .spec.replicas while a rollout runs.',
        kind: 'range',
        min: 0,
        max: 5,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'maxUnavailable',
        label: 'maxUnavailable',
        why: 'strategy.rollingUpdate.maxUnavailable — how many ready Pods the rollout may take away at once.',
        kind: 'range',
        min: 0,
        max: 5,
        step: 1,
        fmt: fmtInt,
      },
    ],
  },
  {
    id: 'pod',
    title: 'Pod',
    hue: 'var(--k8-ready)',
    note: 'The spec every replica is stamped from. Requests decide where it fits; limits decide how it dies.',
    knobs: [
      {
        key: 'requestCpuMilli',
        label: 'CPU request',
        why: 'resources.requests.cpu — subtracted from a node’s allocatable when the scheduler decides. It is a reservation, never a cap.',
        kind: 'range',
        min: 0,
        max: 2000,
        step: 50,
        fmt: fmtCpu,
      },
      {
        key: 'limitCpuMilli',
        label: 'CPU limit',
        why: 'resources.limits.cpu — enforced as a cgroup CFS quota. Exceed it and the container is throttled, never killed.',
        kind: 'range',
        min: 0,
        max: 4000,
        step: 50,
        fmt: fmtCpu,
      },
      {
        key: 'requestMemMib',
        label: 'Memory request',
        why: 'resources.requests.memory — reserved at scheduling time, and the line kubelet ranks eviction victims against.',
        kind: 'range',
        min: 0,
        max: 2048,
        step: 32,
        fmt: fmtMem,
      },
      {
        key: 'limitMemMib',
        label: 'Memory limit',
        why: 'resources.limits.memory — cross it and the kernel OOM-kills the process. That is a restart with reason OOMKilled, not an eviction.',
        kind: 'range',
        min: 0,
        max: 4096,
        step: 32,
        fmt: fmtMem,
      },
      {
        key: 'imagePullSeconds',
        label: 'Image pull time',
        why: 'How long a pull takes when the node has no cached layers. The Pod sits in ContainerCreating for the whole pull.',
        kind: 'range',
        min: 0,
        max: 30,
        step: 1,
        fmt: fmtSec,
      },
      {
        key: 'readinessPeriodSeconds',
        label: 'Readiness period',
        why: 'readinessProbe.periodSeconds. Failing it removes the Pod from its EndpointSlice and restarts nothing at all.',
        kind: 'range',
        min: 1,
        max: 60,
        step: 1,
        fmt: fmtSec,
      },
      {
        key: 'livenessPeriodSeconds',
        label: 'Liveness period',
        why: 'livenessProbe.periodSeconds. Failing it past the threshold makes kubelet kill the container and restart it.',
        kind: 'range',
        min: 1,
        max: 60,
        step: 1,
        fmt: fmtSec,
      },
      {
        key: 'probeFailureThreshold',
        label: 'failureThreshold',
        why: 'Consecutive failures before a probe counts as failed, so detection takes period × threshold — the number people forget to multiply.',
        kind: 'range',
        min: 1,
        max: 10,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'podAntiAffinity',
        label: 'Pod anti-affinity',
        why: 'requiredDuringSchedulingIgnoredDuringExecution on hostname — ask for more replicas than nodes and the surplus stays Pending.',
        kind: 'toggle',
      },
      {
        key: 'crashLoop',
        label: 'Crash loop',
        why: 'The app container exits nonzero at start. kubelet waits 10 s, 20, 40 … capped at 5 min: CrashLoopBackOff.',
        kind: 'toggle',
      },
      {
        key: 'imagePullFailure',
        label: 'Image pull failure',
        why: 'The registry refuses the pull: ErrImagePull, then ImagePullBackOff. The Pod is scheduled and still never runs.',
        kind: 'toggle',
      },
      {
        key: 'memoryLeak',
        label: 'Memory leak',
        why: 'Container memory climbs past its limit. The kernel OOM-kills it, and under node pressure BestEffort Pods are evicted first.',
        kind: 'toggle',
      },
    ],
  },
  {
    id: 'hpa',
    title: 'HorizontalPodAutoscaler',
    hue: 'var(--k8-controller)',
    note: 'Another controller writing .spec.replicas. It measures against requests, never limits.',
    knobs: [
      {
        key: 'hpaEnabled',
        label: 'HorizontalPodAutoscaler',
        why: 'Creates the HPA. From then on it owns .spec.replicas, and a replica count you set by hand is overwritten at the next sync.',
        kind: 'toggle',
      },
      {
        key: 'hpaTargetUtilization',
        label: 'Target utilisation',
        why: 'Target average CPU as a percentage of requests — not of limits, and not of what the node has.',
        kind: 'range',
        min: 10,
        max: 100,
        step: 5,
        fmt: fmtPct,
      },
      {
        key: 'hpaMinReplicas',
        label: 'minReplicas',
        why: 'The floor the HPA never scales below, however idle the workload gets.',
        kind: 'range',
        min: 1,
        max: 20,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'hpaMaxReplicas',
        label: 'maxReplicas',
        why: 'The ceiling. Reaching it is why a saturated Service sometimes simply stays saturated.',
        kind: 'range',
        min: 1,
        max: 24,
        step: 1,
        fmt: fmtInt,
      },
    ],
  },
  {
    id: 'ingress',
    title: 'Ingress',
    hue: 'var(--k8-ingress)',
    note: 'Traffic arriving from outside. It reaches pods only through ready endpoints.',
    knobs: [
      {
        key: 'trafficRps',
        label: 'Ingress traffic',
        why: 'Requests per second arriving from outside. The Service spreads them over ready endpoints only, and their CPU cost is what the HPA reads.',
        kind: 'range',
        min: 0,
        max: 600,
        step: 10,
        fmt: fmtRps,
      },
    ],
  },
  {
    id: 'networkpolicy',
    title: 'NetworkPolicy',
    hue: 'var(--k8-network)',
    note: 'Selecting a pod at all makes it default-deny. Nothing else about the cluster changes.',
    knobs: [
      {
        key: 'networkPolicyEnabled',
        label: 'NetworkPolicy',
        why: 'Applies a NetworkPolicy. Selecting a Pod at all makes it default-deny for ingress, so anything not listed gets nothing.',
        kind: 'toggle',
      },
    ],
  },
  {
    id: 'node',
    title: 'Node',
    hue: 'var(--k8-kubelet)',
    note: 'The machines. Removing one is not a failure; taking one down is.',
    knobs: [
      {
        key: 'nodeCount',
        label: 'Worker nodes',
        why: 'How many machines are in the cluster. Removing one is not a failure: its Node object is gone, so the scheduler never sees it and its capacity was never counted.',
        kind: 'range',
        min: 1,
        max: N_NODES,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'nodeDown',
        label: 'Nodes down',
        why: 'Stops the kubelet Lease renewal. NotReady after 40 s; the Pods are only evicted after the 300 s not-ready toleration.',
        kind: 'range',
        min: 0,
        max: N_NODES,
        step: 1,
        fmt: fmtInt,
      },
    ],
  },
  {
    id: 'etcd',
    title: 'etcd',
    hue: 'var(--k8-etcd)',
    note: 'The only durable truth. Below quorum every write fails while cached reads keep serving.',
    knobs: [
      {
        key: 'etcdMembersDown',
        label: 'etcd members down',
        why: `Members stopped. Quorum is floor(n/2)+1 = ${ETCD_QUORUM} of ${N_ETCD_MEMBERS}; below it no write commits, though cached reads still serve.`,
        kind: 'range',
        min: 0,
        max: N_ETCD_MEMBERS,
        step: 1,
        fmt: fmtInt,
      },
      {
        key: 'etcdFsyncMs',
        label: 'etcd fsync',
        why: 'Disk latency for a raft commit. Past roughly 100 ms heartbeats are missed, leaders change, and API writes start timing out.',
        kind: 'range',
        min: 0,
        max: 500,
        step: 5,
        fmt: formatMs,
      },
    ],
  },
  {
    id: 'apiserver',
    title: 'kube-apiserver',
    hue: 'var(--k8-api)',
    note: 'The one door. An admission webhook sits in the write path of every object it matches.',
    knobs: [
      {
        key: 'webhookReachable',
        label: 'Webhook reachable',
        why: 'Whether the webhook’s backing Service has ready endpoints. With failurePolicy: Fail, unreachable means every matching write is rejected.',
        kind: 'toggle',
      },
      {
        key: 'webhookLatencyMs',
        label: 'Webhook latency',
        why: 'Round-trip a MutatingWebhookConfiguration adds inside the API request, before the object is ever stored.',
        kind: 'range',
        min: 0,
        max: 2000,
        step: 10,
        fmt: formatMs,
      },
    ],
  },
  {
    id: 'transport',
    title: 'Model time',
    hue: 'var(--k8-dim)',
    note: 'Not a cluster resource: how fast this model runs, and whether it runs at all.',
    knobs: [
      {
        key: 'timeScale',
        label: 'Speed',
        why: 'Model seconds per wall-clock second. A 300 s eviction timer still takes 300 model seconds.',
        kind: 'steps',
        values: TIME_SCALES,
        fmt: fmtScale,
      },
      {
        key: 'paused',
        label: 'Paused',
        why: 'Freezes the model clock. Nothing reconciles, nothing ages, and no probe fires.',
        kind: 'toggle',
      },
    ],
  },
]

/* ---------------------------------------------------------------------------
 * Small helpers. All of these run at build time only.
 * -------------------------------------------------------------------------*/

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function nearestIndex(values: readonly number[], v: number): number {
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const d = Math.abs(values[i]! - v)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** A note that is either shown or not. The text never changes, so it is set once. */
function note(parent: HTMLElement, cls: string, text: string): (on: boolean) => void {
  const p = make('p', cls, text)
  parent.append(p)
  let last: boolean | null = null
  return (on: boolean): void => {
    if (on === last) return
    last = on
    p.classList.toggle('on', on)
  }
}

interface Bound {
  sync(k: Knobs): void
}

const QOS_WHY = {
  Guaranteed:
    'requests equal limits for cpu and memory on every container — evicted last, and never for exceeding its own request',
  Burstable:
    'at least one request or limit is set and they differ — evicted after BestEffort, once usage passes its requests',
  BestEffort:
    'no requests and no limits at all — first out under node pressure, and it fits on any node because it asks for nothing',
} as const

type QosName = keyof typeof QOS_WHY

/** The real rule: Guaranteed needs every request to equal its limit and be set. */
function qosOf(k: Knobs): QosName {
  const noneSet =
    k.requestCpuMilli === 0 && k.limitCpuMilli === 0 && k.requestMemMib === 0 && k.limitMemMib === 0
  if (noneSet) return 'BestEffort'
  const guaranteed =
    k.limitCpuMilli > 0 &&
    k.limitMemMib > 0 &&
    k.requestCpuMilli === k.limitCpuMilli &&
    k.requestMemMib === k.limitMemMib
  return guaranteed ? 'Guaranteed' : 'Burstable'
}

/* ---------------------------------------------------------------------------
 * The rail.
 * -------------------------------------------------------------------------*/

export function createControls(bus: Bus, knobs: Knobs): Controls {
  const host = document.getElementById('controls')
  if (!host) throw new Error('controls: #controls must exist')

  host.hidden = false
  host.classList.add('ctl-rail')

  const emitKnob = (key: keyof Knobs, value: Knobs[keyof Knobs]): void => {
    bus.emit('knob', { key, value })
  }

  /* Transport is announced on its own event as well, because the renderer and
   * the camera care that the world stopped, not that a field changed. */
  const setTransport = (paused: boolean, timeScale: number): void => {
    if (paused !== knobs.paused) emitKnob('paused', paused)
    if (timeScale !== knobs.timeScale) emitKnob('timeScale', timeScale)
    bus.emit('transport', { paused, timeScale })
  }

  /* ---- header ---------------------------------------------------------- */

  const head = make('header', 'ctl-head')
  head.append(make('span', 'ctl-title', 'Controls'))
  const resetBtn = make('button', 'ctl-btn', 'Reset')
  resetBtn.type = 'button'
  resetBtn.title = 'Restore every knob to its default (R)'
  const collapseBtn = make('button', 'ctl-collapse', '›')
  collapseBtn.type = 'button'
  collapseBtn.title = 'Show or hide the knob rail'
  collapseBtn.setAttribute('aria-label', 'Show or hide the knob rail')
  head.append(resetBtn, collapseBtn)
  host.append(head)

  const scroll = make('div', 'ctl-scroll')
  host.append(scroll)

  /* ---- knobs ----------------------------------------------------------- */

  const bound: Bound[] = []
  const inputs = new Map<string, HTMLInputElement>()

  for (const group of GROUPS) {
    const details = make('details', 'ctl-group')
    details.open = true
    details.style.setProperty('--hue', group.hue)
    const summary = make('summary', 'ctl-summary')
    summary.append(make('span', 'ctl-g-name', group.title))
    details.append(summary)
    const body = make('div', 'ctl-body')
    body.append(make('p', 'ctl-note', group.note))
    details.append(body)
    scroll.append(details)

    for (const spec of group.knobs) {
      const id = `ctl-${String(spec.key)}`
      const wrap = make('div', `ctl-knob ${spec.kind === 'toggle' ? 'is-toggle' : ''}`)
      const row = make('div', 'ctl-row')
      const label = make('label', 'ctl-label', spec.label)
      label.htmlFor = id
      row.append(label)

      if (spec.kind === 'toggle') {
        const input = make('input', 'ctl-sw')
        input.type = 'checkbox'
        input.id = id
        const sw = make('span', 'ctl-sw-ui')
        const swWrap = make('span', 'ctl-sw-wrap')
        swWrap.append(input, sw)
        row.append(swWrap)
        wrap.append(row)

        input.addEventListener('input', () => {
          const v = input.checked
          if (spec.key === 'paused') setTransport(v, knobs.timeScale)
          else emitKnob(spec.key, v)
        })

        let last: boolean | null = null
        bound.push({
          sync(k) {
            const v = k[spec.key] === true
            if (v === last) return
            last = v
            input.checked = v
          },
        })
        inputs.set(String(spec.key), input)
      } else {
        const out = make('output', 'ctl-out')
        row.append(out)
        wrap.append(row)

        const input = make('input', 'ctl-range')
        input.type = 'range'
        input.id = id
        const values = spec.values
        input.min = String(values ? 0 : (spec.min ?? 0))
        input.max = String(values ? values.length - 1 : (spec.max ?? 1))
        input.step = String(values ? 1 : (spec.step ?? 1))
        wrap.append(input)

        const fmt = spec.fmt ?? fmtInt

        input.addEventListener('input', () => {
          const raw = Number(input.value)
          const v = values ? (values[raw] ?? values[0]!) : raw
          if (spec.key === 'timeScale') setTransport(knobs.paused, v)
          else emitKnob(spec.key, v)
        })

        let last = Number.NaN
        bound.push({
          sync(k) {
            const v = Number(k[spec.key])
            if (v === last) return
            last = v
            input.value = String(values ? nearestIndex(values, v) : v)
            out.textContent = fmt(v)
          },
        })
        inputs.set(String(spec.key), input)
      }

      wrap.append(make('p', 'ctl-why', spec.why))
      body.append(wrap)
    }

    /* Group-local read-outs and validity notes. */
    if (group.id === 'pod') {
      const qosRow = make('p', 'ctl-derived')
      qosRow.append(make('span', 'ctl-k', 'QoS class'))
      const qosName = make('b', 'ctl-qos')
      const qosWhy = make('span', 'ctl-qos-why')
      qosRow.append(qosName, qosWhy)
      body.append(qosRow)

      let lastQos: QosName | null = null
      bound.push({
        sync(k) {
          const q = qosOf(k)
          if (q === lastQos) return
          lastQos = q
          qosName.textContent = q
          qosName.dataset.qos = q
          qosWhy.textContent = QOS_WHY[q]
        },
      })

      const cpuInvalid = note(
        body,
        'ctl-warn',
        'A container whose cpu request exceeds its cpu limit is rejected by the API server.',
      )
      const memInvalid = note(
        body,
        'ctl-warn',
        'A container whose memory request exceeds its memory limit is rejected by the API server.',
      )
      const budgetInvalid = note(
        body,
        'ctl-warn',
        'maxSurge and maxUnavailable may not both be 0: a rolling update could never make progress, and the API server rejects it.',
      )
      bound.push({
        sync(k) {
          cpuInvalid(k.limitCpuMilli > 0 && k.requestCpuMilli > k.limitCpuMilli)
          memInvalid(k.limitMemMib > 0 && k.requestMemMib > k.limitMemMib)
          budgetInvalid(k.maxSurge === 0 && k.maxUnavailable === 0)
        },
      })
    }

    if (group.id === 'hpa') {
      const owned = note(
        body,
        'ctl-note-live',
        'The HPA owns .spec.replicas now — the Replicas slider follows it instead of driving it.',
      )
      const rangeInvalid = note(
        body,
        'ctl-warn',
        'minReplicas above maxReplicas is invalid; the HPA reports ScalingActive=False and stops acting.',
      )
      const replicasInput = inputs.get('replicas')
      let lastEnabled: boolean | null = null
      bound.push({
        sync(k) {
          owned(k.hpaEnabled)
          rangeInvalid(k.hpaMinReplicas > k.hpaMaxReplicas)
          if (k.hpaEnabled === lastEnabled) return
          lastEnabled = k.hpaEnabled
          if (replicasInput) replicasInput.disabled = k.hpaEnabled
        },
      })
    }

    if (group.id === 'etcd') {
      const lost = note(
        body,
        'ctl-warn',
        `Fewer than ${ETCD_QUORUM} members are up: no write can commit, so the whole control plane is read-only.`,
      )
      const webhookDown = note(
        body,
        'ctl-warn',
        'An unreachable webhook with failurePolicy: Fail blocks every matching write, including the ones controllers need to recover.',
      )
      bound.push({
        sync(k) {
          lost(N_ETCD_MEMBERS - k.etcdMembersDown < ETCD_QUORUM)
          webhookDown(!k.webhookReachable)
        },
      })
    }
  }

  const keys = make('p', 'ctl-keys')
  keys.append(
    make('span', '', 'K pause'),
    make('span', '', ', . speed'),
    make('span', '', 'N day/night'),
    make('span', '', 'L labels'),
    make('span', '', 'R reset'),
  )
  scroll.append(keys)

  /* ---- transport shortcuts, reset, theme, labels ------------------------ */

  const resetAll = (): void => {
    for (const key of Object.keys(DEFAULT_KNOBS) as (keyof Knobs)[]) {
      if (knobs[key] !== DEFAULT_KNOBS[key]) emitKnob(key, DEFAULT_KNOBS[key])
    }
    bus.emit('transport', { paused: DEFAULT_KNOBS.paused, timeScale: DEFAULT_KNOBS.timeScale })
    bus.emit('toast', { text: 'Every knob back to its default', kind: 'info' })
  }

  const nudgeSpeed = (dir: number): void => {
    const i = nearestIndex(TIME_SCALES, knobs.timeScale)
    const next = TIME_SCALES[Math.min(TIME_SCALES.length - 1, Math.max(0, i + dir))]!
    setTransport(knobs.paused, next)
  }

  let labelsOn = true
  const toggleLabels = (): void => {
    labelsOn = !labelsOn
    bus.emit('overlay', { id: 'labels', open: labelsOn })
  }

  const toggleTheme = (): void => {
    const day = document.documentElement.dataset.theme === 'day'
    bus.emit('theme', { mode: day ? 'night' : 'day' })
  }

  const isTyping = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    if (!el || typeof el.tagName !== 'string') return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  }

  /* Camera keys belong to the camera rig; this handler owns only the keys the
   * knob rail is responsible for, and it never claims a modified chord. */
  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (isTyping(e.target)) return
    const k = e.key
    let handled = true
    if (k === 'k' || k === 'K' || k === 'p' || k === 'P') setTransport(!knobs.paused, knobs.timeScale)
    else if (k === ',' || k === '<') nudgeSpeed(-1)
    else if (k === '.' || k === '>') nudgeSpeed(1)
    else if (k === 'n' || k === 'N') toggleTheme()
    else if (k === 'l' || k === 'L') toggleLabels()
    else if (k === 'r' || k === 'R') resetAll()
    else handled = false
    if (handled) e.preventDefault()
  }
  window.addEventListener('keydown', onKey)

  resetBtn.addEventListener('click', resetAll)

  /* ---- open / closed --------------------------------------------------- */

  let open = window.innerWidth >= 1100
  const applyOpen = (): void => {
    host.classList.toggle('open', open)
    document.documentElement.dataset.rail = open ? 'open' : 'closed'
    collapseBtn.textContent = open ? '›' : '‹'
    bus.emit('overlay', { id: 'controls', open })
  }
  collapseBtn.addEventListener('click', () => {
    open = !open
    applyOpen()
  })
  const offOverlay = bus.on('overlay', (p) => {
    if (p.id !== 'controls' || p.open === open) return
    open = p.open
    applyOpen()
  })
  applyOpen()

  /* ---- frame path ------------------------------------------------------ */

  function update(s: SimState): void {
    const k = s.knobs
    for (let i = 0; i < bound.length; i++) bound[i]!.sync(k)
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKey)
    offOverlay()
    host!.replaceChildren()
    host!.hidden = true
  }

  return { update, dispose }
}
