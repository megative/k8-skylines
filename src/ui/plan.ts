import type { Bus } from '../core/bus'
import { COLOR } from '../core/theme'
import type { PodState, SimState } from '../core/types'
import { ETCD_QUORUM } from '../core/types'
import { formatCpu, formatMem } from '../core/util'

/* ============================================================================
 * THE PLAN — the same cluster, flat.
 *
 * The 3D city earns two claims that a diagram cannot: depth is durability, and
 * desired state is a hologram while actual state is matter. It pays for them in
 * legibility — you cannot read a perspective view at a glance, and for some
 * readers the scene is a barrier rather than a help.
 *
 * So this is the whole cluster as a schematic: no perspective, no camera, every
 * district on screen at once. It is not a second simulation and not a second
 * vocabulary. Every colour means exactly what it means in the city, every box
 * resolves to the same Explainer, and every number is read from the same
 * SimState — so the plan and the city can disagree about layout and never about
 * facts.
 *
 * SVG rather than canvas: the text stays crisp, the boxes are already
 * hit-testable, and the palette can come from the same CSS custom properties the
 * rest of the UI uses.
 * ==========================================================================*/

export interface Plan {
  update(s: SimState, dt: number): void
  dispose(): void
}

const NS = 'http://www.w3.org/2000/svg'

/** Redraw cadence. The plan is read, not watched; 6/s is past perception. */
const REFRESH = 1 / 6

const W = 1000
const H = 640

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag)
  for (const k in attrs) el.setAttribute(k, String(attrs[k]))
  return el
}

interface BoxSpec {
  x: number
  y: number
  w: number
  h: number
  /** Explainer id, so a click lands on the same lesson the city would give. */
  id: string
  title: string
  accent: number
}

/** A pod's colour is its phase, exactly as the city paints it. */
function podColor(p: PodState): number {
  if (p.deletionGraceSeconds !== undefined) return COLOR.terminating
  for (const c of p.containers) {
    if (c.role === 'init') continue
    if (c.reason === 'CrashLoopBackOff' || c.reason === 'ImagePullBackOff' || c.reason === 'ErrImagePull') {
      return COLOR.backoff
    }
    if (c.reason === 'OOMKilled') return COLOR.failed
  }
  switch (p.phase) {
    case 'Running':
      return p.conditions.Ready ? COLOR.ready : COLOR.pending
    case 'Pending':
      return COLOR.pending
    case 'Failed':
      return COLOR.failed
    case 'Succeeded':
      return COLOR.kubelet
    default:
      return COLOR.edge
  }
}

export function createPlan(bus: Bus): Plan {
  if (typeof document === 'undefined') return { update: () => {}, dispose: () => {} }
  const host = document.getElementById('plan')
  if (!host) {
    console.warn('[ui/plan] #plan is missing from the document; the flat view is disabled')
    return { update: () => {}, dispose: () => {} }
  }

  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Flat plan of the cluster',
  })
  root.classList.add('pl-svg')
  host.append(root)
  host.hidden = true

  /* Static scaffolding is built once; only the live layers are rewritten. */
  const wires = svg('g', { class: 'pl-wires' })
  const frames = svg('g', { class: 'pl-frames' })
  const live = svg('g', { class: 'pl-live' })
  root.append(wires, frames, live)

  /* ------------------------------------------------------------------ boxes */

  const box = (b: BoxSpec, sub?: string): void => {
    const g = svg('g', { class: 'pl-box', tabindex: '0', role: 'button' })
    g.dataset.id = b.id
    g.append(
      svg('rect', {
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        rx: 7,
        class: 'pl-rect',
        style: `--pl-accent:${hex(b.accent)}`,
      }),
    )
    const t = svg('text', { x: b.x + 10, y: b.y + 19, class: 'pl-t' })
    t.textContent = b.title
    g.append(t)
    if (sub) {
      const st = svg('text', { x: b.x + 10, y: b.y + 33, class: 'pl-sub' })
      st.textContent = sub
      g.append(st)
    }
    const label = svg('title')
    label.textContent = `${b.title} — click to inspect`
    g.append(label)
    frames.append(g)
  }

  const band = (x: number, y: number, w: number, h: number, text: string): void => {
    frames.append(svg('rect', { x, y, width: w, height: h, rx: 9, class: 'pl-band' }))
    const t = svg('text', { x: x + 11, y: y + 16, class: 'pl-band-t' })
    t.textContent = text
    frames.append(t)
  }

  const wire = (pts: [number, number][], accent: number, dashed = false): void => {
    wires.append(
      svg('polyline', {
        points: pts.map(([x, y]) => `${x},${y}`).join(' '),
        class: dashed ? 'pl-wire pl-wire-dash' : 'pl-wire',
        style: `--pl-accent:${hex(accent)}`,
      }),
    )
  }

  /* ---------------------------------------------------------------- geometry

     Top to bottom is the causal order the city also uses: clients, control
     plane, the nodes that do the work, then the edge traffic arrives at. */

  band(20, 46, W - 40, 150, 'CONTROL PLANE')
  box({ x: 430, y: 8, w: 140, h: 30, id: 'ground.cluster-boundary', title: 'clients', accent: COLOR.desired })
  box({ x: 415, y: 66, w: 170, h: 46, id: 'api.tower', title: 'kube-apiserver', accent: COLOR.api }, 'the one door')
  box({ x: 60, y: 128, w: 170, h: 46, id: 'scheduler', title: 'kube-scheduler', accent: COLOR.scheduler }, 'filter, score, bind')
  box({ x: 415, y: 128, w: 170, h: 46, id: 'etcd-vault', title: 'etcd', accent: COLOR.etcd }, 'raft, the only storage')
  box({ x: 770, y: 128, w: 170, h: 46, id: 'controllers.manager', title: 'controller-manager', accent: COLOR.controller }, 'reconcile loops')

  band(20, 214, W - 40, 226, 'NODES')

  band(20, 458, W - 40, 74, 'SERVICES — rule tables replicated to every node')

  band(20, 548, W - 40, 74, 'EDGE')
  box({ x: 60, y: 566, w: 150, h: 42, id: 'net.ingress', title: 'Ingress', accent: COLOR.ingress }, 'L7 rules')
  box({ x: 240, y: 566, w: 170, h: 42, id: 'net.service.loadbalancer', title: 'LoadBalancer', accent: COLOR.network }, 'L4, own address')
  box({ x: 440, y: 566, w: 150, h: 42, id: 'net.coredns', title: 'CoreDNS', accent: COLOR.dns }, 'cluster names')
  box({ x: 620, y: 566, w: 150, h: 42, id: 'storage.plant', title: 'Storage', accent: COLOR.storage }, 'PV / CSI')
  box({ x: 800, y: 566, w: 140, h: 42, id: 'registry.yard', title: 'Registry', accent: COLOR.image }, 'image layers')

  /* Wires. Each is a real relationship, and its colour is the mechanism's. */
  wire([[500, 38], [500, 66]], COLOR.desired)
  wire([[470, 112], [470, 128]], COLOR.etcd)
  wire([[530, 128], [530, 112]], COLOR.raft)
  wire([[415, 89], [145, 89], [145, 128]], COLOR.api, true)
  wire([[585, 89], [855, 89], [855, 128]], COLOR.api, true)
  wire([[145, 174], [145, 196], [430, 196], [430, 112]], COLOR.scheduler)
  wire([[855, 174], [855, 196], [570, 196], [570, 112]], COLOR.controller)
  /* The API server tells the kubelets, and the kubelets only ever pull. */
  wire([[500, 174], [500, 214]], COLOR.kubelet, true)

  /* ------------------------------------------------------------- live layer */

  let acc = 0
  const nodeCols = 4
  /* The plan is a second way of selecting the same thing, so it has to show the
   * current selection however it was made — a click here, a click in the city,
   * the palette, or a step of a followed chain. */
  let selected: string | null = null
  const markSelected = (): void => {
    for (const el of root.querySelectorAll('.pl-box, .pl-pod')) {
      const g = el as SVGElement
      g.classList.toggle('is-on', selected !== null && g.dataset.id === selected)
    }
  }

  const drawNodes = (s: SimState): void => {
    const present = s.nodes.filter((n) => n.present)
    const cw = (W - 80) / nodeCols
    for (let i = 0; i < present.length; i++) {
      const n = present[i]
      const x = 40 + (i % nodeCols) * cw
      const y = 238
      const w = cw - 16
      const h = 186
      let ready = 'Unknown'
      for (const c of n.conditions) if (c.type === 'Ready') ready = c.status === 'True' ? 'Ready' : c.status === 'False' ? 'NotReady' : 'Unknown'
      const accent = ready === 'Ready' ? COLOR.kubelet : ready === 'Unknown' ? COLOR.terminating : COLOR.failed

      const g = svg('g', { class: 'pl-box', tabindex: '0', role: 'button' })
      g.dataset.id = `node-${n.index}`
      g.append(
        svg('rect', { x, y, width: w, height: h, rx: 7, class: 'pl-rect', style: `--pl-accent:${hex(accent)}` }),
      )
      const t = svg('text', { x: x + 10, y: y + 19, class: 'pl-t' })
      t.textContent = n.name
      const st = svg('text', { x: x + 10, y: y + 33, class: 'pl-sub' })
      st.textContent = `${ready} · ${n.podUids.length} pods`
      const rt = svg('text', { x: x + 10, y: y + 47, class: 'pl-sub' })
      /* Requests, not usage: this is the number the scheduler subtracts. */
      rt.textContent = `req ${formatCpu(n.requestedCpuMilli)} / ${formatMem(n.requestedMemMib)}`
      g.append(t, st, rt)
      live.append(g)

      /* Pods as a grid of chips inside the node, coloured by phase. */
      const pods: PodState[] = []
      for (const uid of n.podUids) {
        const p = s.pods.get(uid)
        if (p) pods.push(p)
      }
      const cols = 4
      const cs = 15
      const gap = 4
      for (let k = 0; k < pods.length && k < 12; k++) {
        const px = x + 10 + (k % cols) * (cs + gap)
        const py = y + 60 + Math.floor(k / cols) * (cs + gap)
        const pg = svg('g', { class: 'pl-pod', tabindex: '0', role: 'button' })
        pg.dataset.id = 'pod'
        pg.append(
          svg('rect', {
            x: px,
            y: py,
            width: cs,
            height: cs,
            rx: 3,
            class: 'pl-pod-r',
            style: `--pl-accent:${hex(podColor(pods[k]))}`,
          }),
        )
        const tip = svg('title')
        tip.textContent = `${pods[k].namespace}/${pods[k].name} — ${pods[k].phase}`
        pg.append(tip)
        live.append(pg)
      }
      if (pods.length > 12) {
        const more = svg('text', { x: x + 10, y: y + 60 + 3 * (cs + gap) + 12, class: 'pl-sub' })
        more.textContent = `+${pods.length - 12} more`
        live.append(more)
      }
    }
    /* Machines that are not in the cluster are absent, not broken: nothing is
     * drawn for them at all, the same claim the city's empty ground makes. */
  }

  const drawServices = (s: SimState): void => {
    const n = Math.min(s.services.length, 6)
    const cw = (W - 80) / 6
    for (let i = 0; i < n; i++) {
      const v = s.services[i]
      const x = 40 + i * cw
      const y = 482
      const w = cw - 14
      const accent = v.type === 'LoadBalancer' ? COLOR.network : v.type === 'Headless' ? COLOR.edge : COLOR.traffic
      let ready = 0
      for (const e of v.endpoints) if (e.ready) ready += 1

      const g = svg('g', { class: 'pl-box', tabindex: '0', role: 'button' })
      g.dataset.id = 'net.service'
      g.append(svg('rect', { x, y, width: w, height: 42, rx: 6, class: 'pl-rect', style: `--pl-accent:${hex(accent)}` }))
      const t = svg('text', { x: x + 8, y: y + 17, class: 'pl-t pl-t-s' })
      t.textContent = v.name
      const st = svg('text', { x: x + 8, y: y + 31, class: 'pl-sub' })
      /* A Headless Service has no address at all; saying "None" is the lesson. */
      st.textContent = `${v.type === 'Headless' ? 'None' : v.clusterIp} · ${ready} ready`
      g.append(t, st)
      const tip = svg('title')
      tip.textContent = `${v.namespace}/${v.name} (${v.type}) — ${ready} ready endpoints`
      g.append(tip)
      live.append(g)
    }
  }

  const drawStatus = (s: SimState): void => {
    const q = s.etcd.members.filter((m) => m.role !== 'down').length
    const txt = svg('text', { x: 585, y: 158, class: 'pl-stat' })
    txt.textContent = s.etcd.hasQuorum ? `quorum ${q}/${ETCD_QUORUM}` : 'NO QUORUM'
    txt.setAttribute('style', `--pl-accent:${hex(s.etcd.hasQuorum ? COLOR.ready : COLOR.failed)}`)
    live.append(txt)

    const api = svg('text', { x: 597, y: 96, class: 'pl-stat' })
    api.textContent = s.api.writable ? `${Math.round(s.api.requestsPerSec)} req/s` : 'read-only'
    api.setAttribute('style', `--pl-accent:${hex(s.api.writable ? COLOR.api : COLOR.failed)}`)
    live.append(api)

    const t = s.totals
    const pods = svg('text', { x: 300, y: 228, class: 'pl-stat' })
    pods.textContent = `${t.podsRunning} running · ${t.podsPending} pending · ${t.podsFailed} failed`
    pods.setAttribute('style', `--pl-accent:${hex(t.podsFailed > 0 ? COLOR.failed : COLOR.ready)}`)
    live.append(pods)
  }

  const update = (s: SimState, dt: number): void => {
    if (host.hidden) return
    acc += dt
    if (acc < REFRESH) return
    acc = 0
    /* One wholesale rewrite of the live layer. The plan is small enough that
     * diffing it would cost more to maintain than it saves. */
    live.textContent = ''
    drawNodes(s)
    drawServices(s)
    drawStatus(s)
    markSelected()
  }

  /* ---------------------------------------------------------------- wiring */

  const onClick = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof Element)) return
    const hit = t.closest('.pl-box, .pl-pod')
    if (hit instanceof SVGElement && hit.dataset.id) {
      bus.emit('focus', { id: hit.dataset.id, source: 'menu' })
    }
  }
  host.addEventListener('click', onClick)

  const offFocus = bus.on('focus', ({ id }) => {
    selected = id
    markSelected()
  })
  const offBlur = bus.on('blur', () => {
    selected = null
    markSelected()
  })

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const t = ev.target
    if (!(t instanceof Element)) return
    const hit = t.closest('.pl-box, .pl-pod')
    if (hit instanceof SVGElement && hit.dataset.id) {
      ev.preventDefault()
      bus.emit('focus', { id: hit.dataset.id, source: 'menu' })
    }
  }
  host.addEventListener('keydown', onKey)

  return {
    update,
    dispose(): void {
      offFocus()
      offBlur()
      host.removeEventListener('click', onClick)
      host.removeEventListener('keydown', onKey)
      host.textContent = ''
      host.hidden = true
    },
  }
}
