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
  /* Traffic is redrawn with the live layer: its speed is a fact, not scenery. */
  const flowLayer = svg('g', { class: 'pl-flows' })
  const frames = svg('g', { class: 'pl-frames' })
  const live = svg('g', { class: 'pl-live' })
  root.append(wires, flowLayer, frames, live)

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

  /*
   * A flow. The dash march is done in CSS so it stays smooth between the
   * plan's four-per-second repaints, and the period carries the rate: busier
   * means faster, and zero means the wire is simply not drawn. A wire that is
   * always visible would say traffic is flowing when it is not.
   */
  const flow = (pts: [number, number][], accent: number, rps: number, label?: string): void => {
    if (rps <= 0.01) return
    const period = Math.max(0.35, Math.min(4, 26 / rps))
    const p = svg('polyline', {
      points: pts.map(([x, y]) => `${x},${y}`).join(' '),
      class: 'pl-flow',
      style: `--pl-accent:${hex(accent)};animation-duration:${period.toFixed(2)}s`,
    })
    flowLayer.append(p)
    if (label) {
      const mid = pts[Math.floor(pts.length / 2)]
      const t = svg('text', { x: mid[0] + 6, y: mid[1] - 4, class: 'pl-rate' })
      t.textContent = label
      t.setAttribute('style', `--pl-accent:${hex(accent)}`)
      flowLayer.append(t)
    }
  }

  /* ---------------------------------------------------------------- geometry

     Top to bottom is the causal order the city also uses: clients, control
     plane, the nodes that do the work, then the edge traffic arrives at.

     The vertical extent is not fixed. A node card used to be 186px whatever it
     held, so it showed nine pods and then the words "+3 more": a machine
     running twelve pods looked exactly like one running two, which is the one
     thing a plan of a cluster must not do — density is the whole reason to
     look at it. Cards are sized from their contents instead, and everything
     below them moves. The same goes for the Services row, which was capped at
     six and silently dropped the seventh. */

  /** One pod row inside a node card. */
  const POD_ROW = 13
  /** Name, condition and requests, above the first pod row. */
  const NODE_HEAD = 58
  const NODE_FOOT = 10
  const SVC_H = 42
  const SVC_GAP = 14
  const SVC_PER_ROW = 6

  interface Layout {
    nodesBandY: number
    nodeY: number
    nodeH: number
    nodesBandH: number
    svcBandY: number
    svcY: number
    svcRows: number
    svcBandH: number
    edgeBandY: number
    edgeY: number
    H: number
  }

  const layoutOf = (s: SimState): Layout => {
    let mostPods = 0
    for (const n of s.nodes) if (n.present) mostPods = Math.max(mostPods, n.podUids.length)
    /* A floor, so an empty cluster still reads as machines rather than slivers. */
    const nodeH = Math.max(120, NODE_HEAD + mostPods * POD_ROW + NODE_FOOT)
    const nodesBandY = 214
    const nodeY = nodesBandY + 24
    const nodesBandH = nodeH + 40

    const svcRows = Math.max(1, Math.ceil(s.services.length / SVC_PER_ROW))
    const svcBandY = nodesBandY + nodesBandH + 18
    const svcY = svcBandY + 24
    const svcBandH = 24 + svcRows * SVC_H + (svcRows - 1) * SVC_GAP + 12

    const edgeBandY = svcBandY + svcBandH + 16
    return {
      nodesBandY,
      nodeY,
      nodeH,
      nodesBandH,
      svcBandY,
      svcY,
      svcRows,
      svcBandH,
      edgeBandY,
      edgeY: edgeBandY + 18,
      H: edgeBandY + 74 + 18,
    }
  }

  /*
   * The scaffolding depends on how tall the live content is, so it is rebuilt
   * when that changes rather than once at construction. The signature keeps
   * that to the frames where it actually moved — this runs at most six times a
   * second, and re-creating a hundred SVG nodes on every one of them for a
   * layout that did not change would be waste.
   */
  const buildFrame = (L: Layout): void => {
    wires.textContent = ''
    frames.textContent = ''
    root.setAttribute('viewBox', `0 0 ${W} ${L.H}`)

    band(20, 46, W - 40, 150, 'CONTROL PLANE')
    box({ x: 430, y: 8, w: 140, h: 30, id: 'ground.cluster-boundary', title: 'clients', accent: COLOR.desired })
    box({ x: 415, y: 66, w: 170, h: 46, id: 'api.tower', title: 'kube-apiserver', accent: COLOR.api }, 'the one door')
    box({ x: 60, y: 128, w: 170, h: 46, id: 'scheduler', title: 'kube-scheduler', accent: COLOR.scheduler }, 'filter, score, bind')
    box({ x: 415, y: 128, w: 170, h: 46, id: 'etcd-vault', title: 'etcd', accent: COLOR.etcd }, 'raft, the only storage')
    box({ x: 770, y: 128, w: 170, h: 46, id: 'controllers.manager', title: 'controller-manager', accent: COLOR.controller }, 'reconcile loops')

    band(20, L.nodesBandY, W - 40, L.nodesBandH, 'NODES')
    band(20, L.svcBandY, W - 40, L.svcBandH, 'SERVICES — rule tables replicated to every node')

    band(20, L.edgeBandY, W - 40, 74, 'EDGE')
    box({ x: 60, y: L.edgeY, w: 150, h: 42, id: 'net.ingress', title: 'Ingress', accent: COLOR.ingress }, 'L7 rules')
    box({ x: 240, y: L.edgeY, w: 170, h: 42, id: 'net.service.loadbalancer', title: 'LoadBalancer', accent: COLOR.network }, 'L4, own address')
    box({ x: 440, y: L.edgeY, w: 150, h: 42, id: 'net.coredns', title: 'CoreDNS', accent: COLOR.dns }, 'cluster names')
    box({ x: 620, y: L.edgeY, w: 150, h: 42, id: 'storage.plant', title: 'Storage', accent: COLOR.storage }, 'PV / CSI')
    box({ x: 800, y: L.edgeY, w: 140, h: 42, id: 'registry.yard', title: 'Registry', accent: COLOR.image }, 'image layers')

    /* Wires. Each is a real relationship, and its colour is the mechanism's. */
    wire([[500, 38], [500, 66]], COLOR.desired)
    wire([[470, 112], [470, 128]], COLOR.etcd)
    wire([[530, 128], [530, 112]], COLOR.raft)
    wire([[415, 89], [145, 89], [145, 128]], COLOR.api, true)
    wire([[585, 89], [855, 89], [855, 128]], COLOR.api, true)
    wire([[145, 174], [145, 196], [430, 196], [430, 112]], COLOR.scheduler)
    wire([[855, 174], [855, 196], [570, 196], [570, 112]], COLOR.controller)
    /* The API server tells the kubelets, and the kubelets only ever pull. */
    wire([[500, 174], [500, L.nodesBandY]], COLOR.kubelet, true)
  }

  let frameSig = ''

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

  const drawNodes = (s: SimState, L: Layout): void => {
    const present = s.nodes.filter((n) => n.present)
    const cw = (W - 80) / nodeCols
    for (let i = 0; i < present.length; i++) {
      const n = present[i]
      const x = 40 + (i % nodeCols) * cw
      const y = L.nodeY
      const w = cw - 16
      const h = L.nodeH
      let ready = 'Unknown'
      for (const c of n.conditions) if (c.type === 'Ready') ready = c.status === 'True' ? 'Ready' : c.status === 'False' ? 'NotReady' : 'Unknown'
      const accent = ready === 'Ready' ? COLOR.kubelet : ready === 'Unknown' ? COLOR.terminating : COLOR.failed

      const g = svg('g', { class: 'pl-box', tabindex: '0', role: 'button' })
      /* Two different things, and conflating them is what made the inspector
       * show a representative: `id` names the lesson, `kind` names the API
       * kind the object belongs to. For a node those are `node-0` and `node`. */
      g.dataset.id = `node-${n.index}`
      g.dataset.kind = 'node'
      g.dataset.name = n.name
      g.dataset.ns = ''
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
      /*
       * Rows, not a grid of bare chips. A chip whose only information is its
       * colour cannot be talked about — you cannot tell someone "look at the
       * red one" and have them find it again — and the names fit, as the tree
       * already proves.
       */
      const rowH = POD_ROW
      for (let k = 0; k < pods.length; k++) {
        const p = pods[k]
        const py = y + NODE_HEAD + k * rowH
        const pg = svg('g', { class: 'pl-pod', tabindex: '0', role: 'button' })
        pg.dataset.id = 'pod'
        pg.dataset.kind = 'pod'
        pg.dataset.name = p.name
        pg.dataset.ns = p.namespace
        pg.append(
          svg('rect', {
            x: x + 10,
            y: py,
            width: 7,
            height: 7,
            rx: 1.5,
            class: 'pl-pod-r',
            style: `--pl-accent:${hex(podColor(p))}`,
          }),
        )
        const nameT = svg('text', { x: x + 22, y: py + 7, class: 'pl-pod-t' })
        /* Trim from the front: the generated suffix is what distinguishes two
         * pods of the same workload, so it is the half worth keeping. */
        const maxChars = Math.max(8, Math.floor((w - 34) / 4.4))
        nameT.textContent = p.name.length > maxChars ? '…' + p.name.slice(-(maxChars - 1)) : p.name
        pg.append(nameT)
        const tip = svg('title')
        tip.textContent = `${p.namespace}/${p.name} — ${p.phase}`
        pg.append(tip)
        live.append(pg)
      }
    }
    /* Machines that are not in the cluster are absent, not broken: nothing is
     * drawn for them at all, the same claim the city's empty ground makes. */
  }

  const drawServices = (s: SimState, L: Layout): void => {
    const cw = (W - 80) / SVC_PER_ROW
    for (let i = 0; i < s.services.length; i++) {
      const v = s.services[i]
      const x = 40 + (i % SVC_PER_ROW) * cw
      const y = L.svcY + Math.floor(i / SVC_PER_ROW) * (SVC_H + SVC_GAP)
      const w = cw - 14
      const accent = v.type === 'LoadBalancer' ? COLOR.network : v.type === 'Headless' ? COLOR.edge : COLOR.traffic
      let ready = 0
      for (const e of v.endpoints) if (e.ready) ready += 1

      const g = svg('g', { class: 'pl-box', tabindex: '0', role: 'button' })
      g.dataset.id = 'net.service'
      g.dataset.kind = 'net.service'
      g.dataset.name = v.name
      g.dataset.ns = v.namespace
      g.append(svg('rect', { x, y, width: w, height: SVC_H, rx: 6, class: 'pl-rect', style: `--pl-accent:${hex(accent)}` }))
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

  /*
   * Where the traffic actually is. The plan drew every object and not one
   * flow, so the question it was most often opened to answer — where are the
   * requests going — was the one it could not.
   */
  const drawFlows = (s: SimState, L: Layout): void => {
    const svcRps = (n: string): number => s.services.find((v) => v.name === n)?.rps ?? 0
    const ingRps = s.ingresses.reduce((a, i) => a + i.rps, 0)
    const lbRps = svcRps('web-lb')

    /* North-south: the two doors, each on its own address. */
    const svcBottom = L.svcBandY + L.svcBandH
    flow([[135, L.edgeY], [135, svcBottom]], COLOR.ingress, ingRps, `${Math.round(ingRps)} rps`)
    flow([[325, L.edgeY], [325, svcBottom]], COLOR.network, lbRps, `${Math.round(lbRps)} rps`)

    /* Each Service up into the node band it feeds. Only the first row of cards
     * is wired: a second row means more Services than the model seeds, and a
     * lane drawn to the wrong card would be worse than none. */
    const cw = (W - 80) / SVC_PER_ROW
    const n = Math.min(s.services.length, SVC_PER_ROW)
    for (let i = 0; i < n; i++) {
      const v = s.services[i]
      if (v.rps <= 0.01) continue
      let ready = 0
      for (const e of v.endpoints) if (e.ready) ready += 1
      /* No ready endpoint means the connection is refused, so nothing is drawn
       * however much the knob is asking for. */
      if (ready === 0) continue
      const x = 40 + i * cw + (cw - 14) / 2
      flow([[x, L.svcY], [x, L.nodesBandY + L.nodesBandH]], COLOR.traffic, v.rps)
    }

    /* The control plane's own conversation, which never stops. */
    flow([[500, 38], [500, 66]], COLOR.desired, s.api.requestsPerSec)
    /* Writes are what reaches raft; the model tracks the etcd revision rather
     * than a write rate, so this follows whether commits are landing at all. */
    flow([[470, 112], [470, 128]], COLOR.raft, s.etcd.hasQuorum ? s.api.requestsPerSec * 0.35 : 0)
    flow([[500, 174], [500, L.nodesBandY]], COLOR.kubelet, s.nodes.filter((x) => x.present).length)
  }

  const drawStatus = (s: SimState, L: Layout): void => {
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
    const L = layoutOf(s)
    const sig = `${L.H}:${L.nodeH}:${L.svcRows}`
    if (sig !== frameSig) {
      frameSig = sig
      buildFrame(L)
    }
    live.textContent = ''
    flowLayer.textContent = ''
    drawFlows(s, L)
    drawNodes(s, L)
    drawServices(s, L)
    drawStatus(s, L)
    markSelected()
  }

  /* ---------------------------------------------------------------- wiring */

  const onClick = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof Element)) return
    const hit = t.closest('.pl-box, .pl-pod')
    if (hit instanceof SVGElement && hit.dataset.id) {
      /* Both intents: `inspect` names the object the reader actually clicked,
       * `focus` names the mechanism it is an instance of. Surfaces that emit
       * only one of them make the three views disagree about the selection. */
      if (hit.dataset.name) {
        bus.emit('inspect', { kind: hit.dataset.kind ?? hit.dataset.id, namespace: hit.dataset.ns ?? '', name: hit.dataset.name })
      }
      /* 'click' is what tells the inspector this focus arrived with an object;
       * any other source means a mechanism was named on its own. */
      bus.emit('focus', { id: hit.dataset.id, source: 'click' })
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
      /* The same pair the pointer path emits: keyboard selection must not
       * select less than a click on the same card. */
      if (hit.dataset.name) {
        bus.emit('inspect', { kind: hit.dataset.kind ?? hit.dataset.id, namespace: hit.dataset.ns ?? '', name: hit.dataset.name })
      }
      bus.emit('focus', { id: hit.dataset.id, source: 'click' })
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
