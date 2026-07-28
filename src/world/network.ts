import * as THREE from 'three'
import { N_NODES } from '../core/types'
import type { IngressState, ServiceState, SimState } from '../core/types'
import { COLOR, ghost, glass, mat, neon, structural } from '../core/theme'
import { Rng, clamp, formatMs, formatPercent } from '../core/util'
import { ANCHOR, CITY, nodeAnchor, nodePartPos, routeCurve } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE NETWORK EDGE — where the cluster meets the world, and where the three
 * abstractions with no process behind them live.
 *
 * The load-bearing claim of this district is that A SERVICE IS NOT A PROCESS.
 * A ClusterIP is a virtual address: nothing listens on it, nothing routes to it,
 * no packet is ever delivered *to* it. It is realised as an identical rule table
 * replicated onto every node by kube-proxy, and a packet addressed to it is
 * rewritten (DNAT) to a pod IP by the kernel on the sending node before it ever
 * leaves. So the Service is drawn as a hologram with no matter inside, and its
 * reality is the strands running down to every node's rule cabinet at once.
 *
 * Geometry contract for this file: nothing here is decorative. If a strand is
 * lit, a rule exists. If a strand dims, an endpoint left the EndpointSlice, and
 * it dims on every node in the same frame because that is what actually happens.
 * ==========================================================================*/

/* Visible capacity. The sim may hold more; the overflow is reported, not drawn,
 * because a hologram you cannot read teaches nothing. */
const MAX_SERVICES = 6
const MAX_EP = 6
const MAX_RULES = 4
const POLICY_LANES = 4

/* Where the address holograms hover: above the corridor between the node grid
 * and the edge, high enough to clear every building in both districts. */
const SVC_Y = 116
const SVC_Z = 300
const SVC_PITCH = 104
/* Local offsets inside a service hologram. */
const SVC_CARD_Y = -11
const SVC_PIP_PITCH = 5.2

/* kube-proxy rule rows stack above each node's rule cabinet. */
const RULE_Y0 = 13
const RULE_DY = 2.9

/* NodePort doors sit in the node block's south wall, facing the outside world. */
const DOOR_Z = CITY.node.z + CITY.node.d / 2 + 4
const DOOR_PITCH = 17

/* NetworkPolicy checkpoints straddle the ingress→pod path, inside this
 * district's own footprint and clear of the node blocks. */
const GATE_Z = 290

/* Model scaling, disclosed in the Explainer caveats. */
const RPS_PER_PACKET = 5
const EXT_PACKETS = 48
const INT_PACKETS = 48
const ERR_SPARKS = 24
const DNS_PACKETS = 24
const DENY_SPARKS = N_NODES * POLICY_LANES

/* CoreDNS is a Deployment. Four floors, lit by however many pods are Ready. */
const DNS_FLOORS = 4
/* resolv.conf in a pod: `search <ns>.svc.cluster.local svc.cluster.local
 * cluster.local` + `options ndots:5`. Three search domains, then the name as
 * typed — four lookups for any external name with fewer than five dots. */
const NDOTS_RUNGS = 4

/* --------------------------------------------------------------------------
 * Frame-loop scratch. Hoisted: update() must allocate nothing.
 * ------------------------------------------------------------------------*/
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _c = new THREE.Color()
const _m4 = new THREE.Matrix4()

/* --------------------------------------------------------------------------
 * Materials. Theme materials are shared and are destroyed on a theme flip, so
 * every reference is held in one record that can be refilled, and meshes that
 * are skinned once at build time are re-skinned when the flip happens.
 * ------------------------------------------------------------------------*/
type MatKey =
  | 'vip'
  | 'vipDead'
  | 'shell'
  | 'cage'
  | 'ready'
  | 'pending'
  | 'term'
  | 'failed'
  | 'ruleOn'
  | 'ruleSync'
  | 'ruleReject'
  | 'off'
  | 'doorOn'
  | 'traffic'
  | 'crypt'
  | 'dns'
  | 'dnsGhost'
  | 'ingress'
  | 'tls'
  | 'concrete'
  | 'deck'
  | 'boundary'
  | 'policy'

type Mats = Record<MatKey, THREE.MeshStandardMaterial>

function buildMats(): Mats {
  return {
    vip: ghost(COLOR.network, 0.3),
    vipDead: ghost(COLOR.failed, 0.34),
    shell: ghost(COLOR.network, 0.1),
    cage: ghost(COLOR.dns, 0.16),
    ready: neon(COLOR.ready, 1.9),
    pending: neon(COLOR.pending, 1.5),
    term: neon(COLOR.terminating, 1.3),
    failed: neon(COLOR.failed, 2.1),
    ruleOn: neon(COLOR.network, 1.5),
    ruleSync: neon(COLOR.pending, 1.4),
    ruleReject: neon(COLOR.failed, 1.9),
    off: mat(COLOR.edge, 0.9),
    doorOn: neon(COLOR.ingress, 1.7),
    traffic: neon(COLOR.traffic, 1.9),
    crypt: neon(COLOR.ingress, 1.9),
    dns: neon(COLOR.dns, 1.7),
    dnsGhost: ghost(COLOR.dns, 0.18),
    ingress: neon(COLOR.ingress, 1.5),
    tls: glass(COLOR.ingress, 0.24),
    concrete: mat(structural('concrete')),
    deck: mat(structural('deck')),
    boundary: glass(COLOR.edge, 0.1),
    policy: neon(COLOR.network, 1.2),
  }
}

/* --------------------------------------------------------------------------
 * Labels. Canvas textures with system fonts only — no remote font may be
 * fetched. Text is redrawn only when the underlying identity changes (a name,
 * a VIP, a host rule), never per frame; numbers live in the inspector instead.
 * Headless-safe: with no DOM the label is an inert stub so the district can be
 * built and stepped in tests.
 * ------------------------------------------------------------------------*/
class Label {
  readonly object: THREE.Object3D
  private readonly cv: HTMLCanvasElement | null
  private readonly g2d: CanvasRenderingContext2D | null
  private readonly tex: THREE.CanvasTexture | null
  private readonly matl: THREE.SpriteMaterial | null
  private a = ''
  private b = ''
  private c = ''

  constructor(worldWidth: number, rows: number, tint: number) {
    const px = 512
    const ph = rows * 96
    if (typeof document === 'undefined') {
      this.cv = null
      this.g2d = null
      this.tex = null
      this.matl = null
      this.object = new THREE.Object3D()
      return
    }
    const cv = document.createElement('canvas')
    cv.width = px
    cv.height = ph
    this.cv = cv
    this.g2d = cv.getContext('2d')
    this.tex = new THREE.CanvasTexture(cv)
    this.tex.colorSpace = THREE.SRGBColorSpace
    this.matl = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      color: tint,
    })
    const sprite = new THREE.Sprite(this.matl)
    sprite.scale.set(worldWidth, (worldWidth * ph) / px, 1)
    this.object = sprite
  }

  /** No-op unless one of the three lines actually changed. */
  set(l0: string, l1: string, l2: string): void {
    if (l0 === this.a && l1 === this.b && l2 === this.c) return
    this.a = l0
    this.b = l1
    this.c = l2
    const g = this.g2d
    const cv = this.cv
    if (!g || !cv || !this.tex) return
    g.clearRect(0, 0, cv.width, cv.height)
    g.fillStyle = 'rgba(6,9,16,0.72)'
    g.fillRect(0, 0, cv.width, cv.height)
    g.fillStyle = '#e8eef6'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const rows = cv.height / 96
    const step = cv.height / rows
    g.font = '600 58px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    if (rows > 0 && l0) g.fillText(l0, cv.width / 2, step * 0.5, cv.width - 16)
    g.font = '500 48px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    if (rows > 1 && l1) g.fillText(l1, cv.width / 2, step * 1.5, cv.width - 16)
    if (rows > 2 && l2) g.fillText(l2, cv.width / 2, step * 2.5, cv.width - 16)
    this.tex.needsUpdate = true
  }

  dispose(): void {
    this.tex?.dispose()
    this.matl?.dispose()
  }
}

/* --------------------------------------------------------------------------
 * Slot records. Every array is sized at build time; update() only reads.
 * ------------------------------------------------------------------------*/
interface ServiceSlot {
  group: THREE.Group
  core: THREE.Mesh
  halo: THREE.Mesh
  cage: THREE.Mesh
  boundary: THREE.Mesh
  dead: THREE.Mesh
  sliceCard: THREE.Mesh
  pips: THREE.Mesh[]
  overflow: THREE.Mesh
  label: Label
  portLabel: Label
  doors: THREE.Mesh[]
  ruleRows: THREE.Mesh[]
  /* Identity cache, so label textures are rebuilt only on a real change. */
  sName: string
  sNs: string
  sIp: string
  sType: string
  sPort: number
  sNodePort: number
}

interface RuleBay {
  slab: THREE.Mesh
  lamp: THREE.Mesh
  label: Label
  host: string
  path: string
  service: string
  targetSlot: number
}

interface PolicyGate {
  group: THREE.Group
  lanes: THREE.Mesh[]
  beacon: THREE.Mesh
}

/** Van der Corput sequence: any prefix of it is evenly spread over [0,1), so a
 * packet stream can be shortened by lowering the instance count without the
 * survivors bunching up on one stretch of the route. */
function vdc(i: number): number {
  let bits = i
  let out = 0
  let f = 0.5
  while (bits > 0) {
    out += (bits & 1) * f
    bits >>= 1
    f *= 0.5
  }
  return out
}

function driveFlow(
  im: THREE.InstancedMesh,
  curve: THREE.CatmullRomCurve3,
  offsets: Float32Array,
  active: number,
  speed: number,
  time: number,
  size: number,
  reverse: boolean,
): void {
  im.count = active
  for (let i = 0; i < active; i++) {
    let u = (time * speed + offsets[i]) % 1
    if (reverse) u = 1 - u
    curve.getPointAt(u, _v)
    _m4.makeScale(size, size, size)
    _m4.setPosition(_v)
    im.setMatrixAt(i, _m4)
  }
  im.instanceMatrix.needsUpdate = true
}

/** Endpoint counts drive nearly every colour in this district. */
function readyEndpoints(svc: ServiceState): number {
  let n = 0
  for (let i = 0; i < svc.endpoints.length; i++) {
    const e = svc.endpoints[i]
    if (e.ready && e.serving) n++
  }
  return n
}

/** Ingress rules name a Service by name; accept "ns/name" too. */
function serviceSlotFor(s: SimState, ref: string): number {
  const n = Math.min(s.services.length, MAX_SERVICES)
  for (let i = 0; i < n; i++) {
    const svc = s.services[i]
    if (svc.name === ref) return i
    /* charCodeAt, not charAt: this runs per bay per frame and must not allocate. */
    if (ref.length > svc.name.length && ref.endsWith(svc.name) && ref.charCodeAt(ref.length - svc.name.length - 1) === 47) {
      return i
    }
  }
  return -1
}

/** Ratios arrive from the sim as fractions; tolerate a percentage anyway rather
 * than render a silently saturated bar. */
function ratio(v: number): number {
  return clamp(v > 1 ? v / 100 : v, 0, 1)
}

export function createNetwork(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'district:network'

  /* Own RNG: drawing from ctx.rng inside update() would make every other
   * district's scatter depend on this one's frame count. */
  const rng = new Rng((ctx.rng.next() * 0xffffffff) >>> 0)

  let M = buildMats()
  const skinned: { mesh: THREE.Mesh; key: MatKey }[] = []
  const geos: THREE.BufferGeometry[] = []
  const labels: Label[] = []

  const BOX = new THREE.BoxGeometry(1, 1, 1)
  const SPH = new THREE.SphereGeometry(1, 12, 8)
  const OCT = new THREE.OctahedronGeometry(1, 0)
  const CYL = new THREE.CylinderGeometry(1, 1, 1, 14)
  const RING_H = new THREE.TorusGeometry(1, 0.05, 8, 48)
  RING_H.rotateX(-Math.PI / 2)
  const RING_V = new THREE.TorusGeometry(1, 0.12, 8, 32)
  geos.push(BOX, SPH, OCT, CYL, RING_H, RING_V)

  function part(
    geo: THREE.BufferGeometry,
    key: MatKey,
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, M[key])
    m.position.set(x, y, z)
    m.scale.set(sx, sy, sz)
    parent.add(m)
    skinned.push({ mesh: m, key })
    return m
  }

  function label(worldWidth: number, rows: number, tint: number): Label {
    const l = new Label(worldWidth, rows, tint)
    labels.push(l)
    return l
  }

  /* ------------------------------------------------------------------------
   * Strands: the whole point of the district. One LineSegments for every
   * (service, endpoint, target) triple. Positions are fixed at build time —
   * a rule's *location* never moves, only whether it is programmed and whether
   * its backend is ready. Colour is the only per-frame write.
   *
   * Targets per endpoint: one rule cabinet on each node, plus one strand to
   * CoreDNS used only by Headless services, which get no kube-proxy rules at
   * all and are answered as pod-IP A records instead.
   * ----------------------------------------------------------------------*/
  const TARGETS = N_NODES + 1
  const STRANDS = MAX_SERVICES * MAX_EP * TARGETS
  const strandPos = new Float32Array(STRANDS * 6)
  const strandCol = new Float32Array(STRANDS * 6)
  const strandGeo = new THREE.BufferGeometry()
  strandGeo.setAttribute('position', new THREE.BufferAttribute(strandPos, 3))
  strandGeo.setAttribute('color', new THREE.BufferAttribute(strandCol, 3))
  geos.push(strandGeo)

  /* Line materials are not part of the theme palette (it ships surfaces only),
   * so this district owns them and disposes them itself. */
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const strands = new THREE.LineSegments(strandGeo, lineMat)
  strands.name = 'network:strands'
  strands.frustumCulled = false
  group.add(strands)

  const svcSlotX = (i: number): number => (i - (MAX_SERVICES - 1) / 2) * SVC_PITCH
  const pipX = (p: number): number => (p - (MAX_EP - 1) / 2) * SVC_PIP_PITCH

  /* CoreDNS answer port: where a Headless service's pod-IP records come out. */
  const dnsAnswerY = 40

  for (let i = 0; i < MAX_SERVICES; i++) {
    for (let p = 0; p < MAX_EP; p++) {
      const ax = svcSlotX(i) + pipX(p)
      const ay = SVC_Y + SVC_CARD_Y
      const az = SVC_Z
      for (let t = 0; t < TARGETS; t++) {
        const seg = ((i * MAX_EP + p) * TARGETS + t) * 6
        strandPos[seg] = ax
        strandPos[seg + 1] = ay
        strandPos[seg + 2] = az
        if (t < N_NODES) {
          nodePartPos(t, 'proxy', _v)
          strandPos[seg + 3] = _v.x
          strandPos[seg + 4] = RULE_Y0 + i * RULE_DY
          strandPos[seg + 5] = _v.z
        } else {
          strandPos[seg + 3] = ANCHOR.coreDns[0] + (i - 2.5) * 2
          strandPos[seg + 4] = dnsAnswerY
          strandPos[seg + 5] = ANCHOR.coreDns[2]
        }
      }
    }
  }
  strandGeo.attributes.position.needsUpdate = true

  /* ------------------------------------------------------------------------
   * Service holograms.
   * ----------------------------------------------------------------------*/
  const slots: ServiceSlot[] = []
  for (let i = 0; i < MAX_SERVICES; i++) {
    const g = new THREE.Group()
    g.position.set(svcSlotX(i), SVC_Y, SVC_Z)
    group.add(g)

    /* The VIP itself: a shape with nothing solid in it. */
    const core = part(OCT, 'vip', g, 0, 0, 0, 6.5, 6.5, 6.5)
    const halo = part(RING_H, 'shell', g, 0, 0, 0, 11, 11, 11)
    /* Headless: the record exists, the address does not. An empty cage. */
    const cage = part(BOX, 'cage', g, 0, 0, 0, 13, 13, 13)
    /* ClusterIP/NodePort are reachable only from inside the cluster. */
    const boundary = part(RING_H, 'shell', g, 0, -6, 0, 15, 15, 15)
    /* No ready endpoints: the kernel answers with a REJECT, not a timeout. */
    const dead = part(BOX, 'failed', g, 0, 0, 0, 17, 0.9, 0.9)
    dead.rotation.z = Math.PI / 5

    const sliceCard = part(BOX, 'off', g, 0, SVC_CARD_Y, 0, MAX_EP * SVC_PIP_PITCH + 5, 0.7, 6)
    const pips: THREE.Mesh[] = []
    for (let p = 0; p < MAX_EP; p++) {
      pips.push(part(SPH, 'ready', g, pipX(p), SVC_CARD_Y + 1.4, 0, 1.5, 1.5, 1.5))
    }
    /* Lit when the EndpointSlice holds more entries than there are pips. */
    const overflow = part(BOX, 'pending', g, (MAX_EP * SVC_PIP_PITCH) / 2 + 1.5, SVC_CARD_Y + 1.4, 0, 1.4, 1.4, 4)

    const lab = label(30, 3, 0xffffff)
    lab.object.position.set(0, 15, 0)
    g.add(lab.object)

    const portLab = label(15, 1, 0xffffff)

    /* A NodePort opens the same port in every node's wall, and a rule row for
     * this Service exists in every node's cabinet. Both are per-node facts. */
    const doors: THREE.Mesh[] = []
    const ruleRows: THREE.Mesh[] = []
    for (let n = 0; n < N_NODES; n++) {
      nodeAnchor(n, _v)
      const d = part(BOX, 'off', group, _v.x + (i - (MAX_SERVICES - 1) / 2) * DOOR_PITCH, 5, DOOR_Z, 9, 10, 2)
      doors.push(d)
      nodePartPos(n, 'proxy', _v2)
      const r = part(BOX, 'off', group, _v2.x, RULE_Y0 + i * RULE_DY, _v2.z, 14, 1.5, 9)
      ruleRows.push(r)
    }
    portLab.object.position.set(doors[0].position.x, 12.5, DOOR_Z + 2)
    group.add(portLab.object)

    slots.push({
      group: g,
      core,
      halo,
      cage,
      boundary,
      dead,
      sliceCard,
      pips,
      overflow,
      label: lab,
      portLabel: portLab,
      doors,
      ruleRows,
      sName: '',
      sNs: '',
      sIp: '',
      sType: '',
      sPort: -1,
      sNodePort: -1,
    })
  }

  /* The mast each node's rule stack stands on. kube-proxy is the agent that
   * writes those rows; it is not in the data path, so it is structure, not
   * signal. */
  const proxyRisers: THREE.Mesh[] = []
  for (let n = 0; n < N_NODES; n++) {
    nodePartPos(n, 'proxy', _v)
    const riserTop = RULE_Y0 + (MAX_SERVICES - 1) * RULE_DY
    proxyRisers.push(part(CYL, 'concrete', group, _v.x, riserTop / 2, _v.z, 1.1, riserTop, 1.1))
  }

  /* External-address strands, LoadBalancer only: an address that exists outside
   * the cluster, handed out by the cloud controller manager. */
  const extPos = new Float32Array(MAX_SERVICES * 6)
  const extCol = new Float32Array(MAX_SERVICES * 6)
  const extGeo = new THREE.BufferGeometry()
  extGeo.setAttribute('position', new THREE.BufferAttribute(extPos, 3))
  extGeo.setAttribute('color', new THREE.BufferAttribute(extCol, 3))
  geos.push(extGeo)
  for (let i = 0; i < MAX_SERVICES; i++) {
    const o = i * 6
    extPos[o] = svcSlotX(i)
    extPos[o + 1] = SVC_Y + SVC_CARD_Y - 3
    extPos[o + 2] = SVC_Z
    extPos[o + 3] = ANCHOR.loadBalancer[0] + (i - 2.5) * 6
    extPos[o + 4] = 44
    extPos[o + 5] = ANCHOR.loadBalancer[2]
  }
  const extLinks = new THREE.LineSegments(extGeo, lineMat)
  extLinks.frustumCulled = false
  group.add(extLinks)

  /* ------------------------------------------------------------------------
   * Ingress gatehouse.
   * ----------------------------------------------------------------------*/
  const IX = ANCHOR.ingress[0]
  const IZ = ANCHOR.ingress[2]
  const ingressGroup = new THREE.Group()
  group.add(ingressGroup)

  const ingressPad = part(BOX, 'deck', ingressGroup, IX, 1.5, IZ, 150, 3, 76)
  part(BOX, 'concrete', ingressGroup, IX - 48, 17, IZ, 10, 34, 12)
  part(BOX, 'concrete', ingressGroup, IX + 48, 17, IZ, 10, 34, 12)
  const lintel = part(BOX, 'ingress', ingressGroup, IX, 38, IZ, 110, 5, 12)
  /* Width of this band is the 5xx rate: the only part of a broken rollout that
   * an actual user ever sees. */
  const errBand = part(BOX, 'failed', ingressGroup, IX, 43.5, IZ, 1, 2.4, 13)
  /* Height is arriving request rate. */
  const rpsColumn = part(BOX, 'traffic', ingressGroup, IX - 64, 10, IZ, 6, 20, 6)

  /* TLS: the encrypted face of the gatehouse. Everything south of this plane is
   * ciphertext; everything north of it is plaintext HTTP inside the cluster. */
  const tlsShell = part(BOX, 'tls', ingressGroup, IX, 20, IZ + 18, 96, 32, 2)
  const tlsLock = part(RING_V, 'crypt', ingressGroup, IX, 24, IZ + 19.5, 5, 5, 5)

  const bays: RuleBay[] = []
  for (let r = 0; r < MAX_RULES; r++) {
    const bx = IX + (r - (MAX_RULES - 1) / 2) * 34
    const slab = part(BOX, 'off', ingressGroup, bx, 5, IZ - 24, 30, 3, 20)
    const lamp = part(BOX, 'off', ingressGroup, bx, 9.5, IZ - 30, 3.4, 3.4, 3.4)
    const lab = label(28, 2, 0xffffff)
    lab.object.position.set(bx, 14, IZ - 24)
    ingressGroup.add(lab.object)
    /* -2 means "never resolved", so the first frame always writes the rail. */
    bays.push({ slab, lamp, label: lab, host: '', path: '', service: '', targetSlot: -2 })
  }

  /* Which Service a host/path rule names. A reference, not a data path: see the
   * ingress-controller Explainer. */
  const railPos = new Float32Array(MAX_RULES * 6)
  const railCol = new Float32Array(MAX_RULES * 6)
  const railGeo = new THREE.BufferGeometry()
  railGeo.setAttribute('position', new THREE.BufferAttribute(railPos, 3))
  railGeo.setAttribute('color', new THREE.BufferAttribute(railCol, 3))
  geos.push(railGeo)
  for (let r = 0; r < MAX_RULES; r++) {
    const o = r * 6
    railPos[o] = IX + (r - (MAX_RULES - 1) / 2) * 34
    railPos[o + 1] = 14
    railPos[o + 2] = IZ - 30
  }
  const rails = new THREE.LineSegments(railGeo, lineMat)
  rails.frustumCulled = false
  group.add(rails)

  /* The controller is a ghost here because it does not actually stand at the
   * edge: it is a Deployment whose pods run on the node blocks like any other
   * workload. The link says where the matter really is. */
  const controllerGhost = part(BOX, 'cage', ingressGroup, IX + 58, 13, IZ - 14, 26, 20, 22)
  const ghostPos = new Float32Array(6)
  const ghostCol = new Float32Array(6)
  ghostPos[0] = IX + 58
  ghostPos[1] = 13
  ghostPos[2] = IZ - 14
  ghostPos[3] = ANCHOR.nodeGrid[0] + CITY.node.pitch
  ghostPos[4] = 10
  ghostPos[5] = ANCHOR.nodeGrid[2]
  const ghostGeo = new THREE.BufferGeometry()
  ghostGeo.setAttribute('position', new THREE.BufferAttribute(ghostPos, 3))
  ghostGeo.setAttribute('color', new THREE.BufferAttribute(ghostCol, 3))
  geos.push(ghostGeo)
  const ghostLink = new THREE.LineSegments(ghostGeo, lineMat)
  ghostLink.frustumCulled = false
  group.add(ghostLink)

  const ingressTitle = label(46, 1, 0xffffff)
  ingressTitle.object.position.set(IX, 48, IZ)
  ingressGroup.add(ingressTitle.object)
  ingressTitle.set('INGRESS', '', '')

  /* ------------------------------------------------------------------------
   * Load balancer and the outside world.
   * ----------------------------------------------------------------------*/
  const LX = ANCHOR.loadBalancer[0]
  const LZ = ANCHOR.loadBalancer[2]
  const lbGroup = new THREE.Group()
  group.add(lbGroup)
  /* The cluster boundary. Everything south of it is not Kubernetes. */
  part(BOX, 'boundary', lbGroup, IX, 22, IZ + 45, 620, 44, 0.6)
  part(BOX, 'deck', lbGroup, LX, 1.5, LZ, 70, 3, 44)
  part(CYL, 'concrete', lbGroup, LX, 20, LZ, 3.4, 40, 3.4)
  const lbPlate = part(BOX, 'off', lbGroup, LX, 42, LZ, 40, 5, 6)
  const lbTitle = label(52, 2, 0xffffff)
  lbTitle.object.position.set(LX, 52, LZ)
  lbGroup.add(lbTitle.object)
  lbTitle.set('LOAD BALANCER', 'provisioned outside the cluster', '')

  const EX = ANCHOR.externalClients[0]
  const EZ = ANCHOR.externalClients[2]
  const clientBeacons: THREE.Mesh[] = []
  for (let i = 0; i < 6; i++) {
    const x = EX + (i - 2.5) * 26
    part(BOX, 'concrete', lbGroup, x, 5, EZ, 14, 10, 14)
    clientBeacons.push(part(BOX, 'off', lbGroup, x, 12, EZ, 4, 4, 4))
  }
  const extTitle = label(60, 1, 0xffffff)
  extTitle.object.position.set(EX, 26, EZ)
  lbGroup.add(extTitle.object)
  extTitle.set('EXTERNAL CLIENTS', '', '')

  /* ------------------------------------------------------------------------
   * CoreDNS: a directory tower that is itself a Deployment.
   * ----------------------------------------------------------------------*/
  const DX = ANCHOR.coreDns[0]
  const DZ = ANCHOR.coreDns[2]
  const dnsGroup = new THREE.Group()
  group.add(dnsGroup)
  part(BOX, 'deck', dnsGroup, DX, 1.5, DZ, 56, 3, 56)
  const dnsFloors: THREE.Mesh[] = []
  for (let f = 0; f < DNS_FLOORS; f++) {
    dnsFloors.push(part(BOX, 'off', dnsGroup, DX, 7 + f * 9, DZ, 20, 7, 20))
  }
  const dnsBeacon = part(OCT, 'off', dnsGroup, DX, DNS_FLOORS * 9 + 8, DZ, 4, 6, 4)
  /* Cache plugin: the fraction of answers that never leave this building. */
  part(CYL, 'concrete', dnsGroup, DX - 20, 10, DZ, 5, 20, 5)
  const dnsCacheFill = part(CYL, 'dns', dnsGroup, DX - 20, 5, DZ, 4.2, 10, 4.2)

  /* The ndots:5 search-path ladder. A short name resolves on rung 0; an
   * external name pays for rungs 0..2 before rung 3 answers. */
  const ndotsRungs: THREE.Mesh[] = []
  for (let r = 0; r < NDOTS_RUNGS; r++) {
    ndotsRungs.push(part(BOX, 'off', dnsGroup, DX + 22, 8 + r * 8, DZ, 16, 1.6, 5))
  }
  const ndotsToken = part(SPH, 'traffic', dnsGroup, DX + 22, 8, DZ, 1.8, 1.8, 1.8)
  const NDOTS_TEXT: readonly string[] = [
    '+ <ns>.svc.cluster.local',
    '+ svc.cluster.local',
    '+ cluster.local',
    'name as typed',
  ]
  for (let r = 0; r < NDOTS_RUNGS; r++) {
    const lab = label(30, 1, 0xffffff)
    lab.object.position.set(DX + 46, 8 + r * 8, DZ)
    dnsGroup.add(lab.object)
    lab.set(NDOTS_TEXT[r], '', '')
  }
  const dnsTitle = label(40, 2, 0xffffff)
  dnsTitle.object.position.set(DX, DNS_FLOORS * 9 + 18, DZ)
  dnsGroup.add(dnsTitle.object)
  dnsTitle.set('CoreDNS', 'kube-system/kube-dns', '')

  /* ------------------------------------------------------------------------
   * NetworkPolicy checkpoints, one per node block, on the path traffic takes
   * from the edge into the pods.
   * ----------------------------------------------------------------------*/
  const gates: PolicyGate[] = []
  for (let n = 0; n < N_NODES; n++) {
    nodeAnchor(n, _v)
    const g = new THREE.Group()
    g.position.set(_v.x, 0, GATE_Z)
    group.add(g)
    part(BOX, 'concrete', g, -16, 8, 0, 3, 16, 3)
    part(BOX, 'concrete', g, 16, 8, 0, 3, 16, 3)
    part(BOX, 'concrete', g, 0, 17, 0, 35, 2.5, 3)
    const lanes: THREE.Mesh[] = []
    for (let l = 0; l < POLICY_LANES; l++) {
      lanes.push(part(BOX, 'off', g, (l - (POLICY_LANES - 1) / 2) * 7.4, 6, 0, 6, 11, 1.2))
    }
    const beacon = part(SPH, 'off', g, 0, 20, 0, 1.8, 1.8, 1.8)
    gates.push({ group: g, lanes, beacon })
  }
  const policyTitle = label(50, 2, 0xffffff)
  policyTitle.object.position.set(0, 26, GATE_Z)
  group.add(policyTitle.object)
  policyTitle.set('NETWORKPOLICY', 'selected pods are default-deny', '')

  /* ------------------------------------------------------------------------
   * Traffic. Packets ride the shared routes so no two districts can disagree
   * about where the road runs.
   * ----------------------------------------------------------------------*/
  const extCurve = routeCurve('external-to-ingress')
  const intCurve = routeCurve('ingress-to-nodes')
  /* Warm the arc-length cache once; getPointAt must not build it mid-frame. */
  extCurve.getLengths(200)
  intCurve.getLengths(200)

  const PKT = new THREE.SphereGeometry(1, 6, 4)
  geos.push(PKT)

  const extPackets = new THREE.InstancedMesh(PKT, M.crypt, EXT_PACKETS)
  extPackets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  extPackets.frustumCulled = false
  group.add(extPackets)

  const intPackets = new THREE.InstancedMesh(PKT, M.traffic, INT_PACKETS)
  intPackets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  intPackets.frustumCulled = false
  group.add(intPackets)

  const errSparks = new THREE.InstancedMesh(PKT, M.failed, ERR_SPARKS)
  errSparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  errSparks.frustumCulled = false
  group.add(errSparks)

  const dnsPackets = new THREE.InstancedMesh(PKT, M.dns, DNS_PACKETS)
  dnsPackets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  dnsPackets.frustumCulled = false
  group.add(dnsPackets)

  const denySparks = new THREE.InstancedMesh(PKT, M.failed, DENY_SPARKS)
  denySparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  denySparks.frustumCulled = false
  group.add(denySparks)

  const extOffsets = new Float32Array(EXT_PACKETS)
  const intOffsets = new Float32Array(INT_PACKETS)
  const errOffsets = new Float32Array(ERR_SPARKS)
  for (let i = 0; i < EXT_PACKETS; i++) extOffsets[i] = vdc(i + 1)
  for (let i = 0; i < INT_PACKETS; i++) intOffsets[i] = vdc(i + 1)
  for (let i = 0; i < ERR_SPARKS; i++) errOffsets[i] = vdc(i + 1)

  /* DNS query path: pods ask, the tower answers. A straight local hop, so the
   * round trip can be scaled by the reported latency without fighting a route. */
  const dnsFrom = new THREE.Vector3(ANCHOR.nodeGrid[0] - 60, 16, CITY.node.z + 60)
  const dnsTo = new THREE.Vector3(DX, dnsAnswerY - 4, DZ)

  /* Per-spark denial state at the checkpoints. */
  const denyPhase = new Float32Array(DENY_SPARKS)
  for (let i = 0; i < DENY_SPARKS; i++) denyPhase[i] = rng.next()

  /* ------------------------------------------------------------------------
   * Explainers. A building with no entry here is decoration, and decoration is
   * a bug.
   * ----------------------------------------------------------------------*/
  const R = ctx.registry

  const eService = R.register({
    id: 'net.service',
    title: 'Service',
    district: 'network',
    kubeName: 'v1/Service',
    object: slots[0].core,
    focus: [0, SVC_Y + 40, SVC_Z + 120],
    summary:
      'A stable virtual address for a changing set of pods. It is a record, not a process — nothing is listening on a ClusterIP.',
    detail: [
      'A Service selects pods by label. The EndpointSlice controller watches those pods and writes their IPs into EndpointSlice objects; kube-proxy on every node watches EndpointSlices and programs the kernel so that packets addressed to the Service are rewritten to one of those pod IPs.',
      'That is the entire mechanism. There is no proxy process in the data path in iptables or IPVS mode, no daemon holding the ClusterIP, and no machine you can ssh into that "is" the Service. The hologram hovering above the city is the address; the strands running down to every node are the only thing that makes it real.',
      'Because the rules live on the *sending* node, a pod talking to a Service never emits a packet with the ClusterIP on the wire. Destination NAT happens in the sender\'s own kernel, before the packet leaves. This is why you cannot tcpdump a ClusterIP on the network, and why `ping <clusterIP>` usually fails even when the Service works perfectly.',
    ],
    caveats: [
      'Endpoint count is capped at six pips per Service here; a real EndpointSlice holds up to 100 endpoints and a Service can have many slices.',
      'Session affinity, topology-aware routing and the `internalTrafficPolicy`/`externalTrafficPolicy` fields are not modelled: every ready endpoint is treated as equally reachable from every node.',
      'The model draws one strand per endpoint per node. Real kube-proxy programs one chain per Service plus one rule per endpoint, not one rule per (endpoint, node) pair — the per-node repetition is what the geometry is showing.',
    ],
    keywords: ['service', 'clusterip', 'vip', 'virtual ip', 'selector', 'endpoints'],
    metrics: (s) => {
      let ready = 0
      let total = 0
      let rps = 0
      for (const svc of s.services) {
        total += svc.endpoints.length
        ready += readyEndpoints(svc)
        rps += svc.rps
      }
      return [
        { label: 'services', value: `${s.services.length}` },
        { label: 'ready endpoints', value: `${ready} / ${total}`, hint: 'entries with ready=true and serving=true' },
        { label: 'service rps', value: rps.toFixed(0) },
      ]
    },
  })
  for (const slot of slots) {
    R.bind(slot.group, eService)
  }

  const eClusterIp = R.register({
    id: 'net.service.clusterip',
    title: 'ClusterIP (the default type)',
    district: 'network',
    kubeName: 'spec.type: ClusterIP',
    object: slots[0].halo,
    summary: 'An address from the service CIDR that is only routable from inside the cluster, because only cluster nodes have the rules for it.',
    detail: [
      'The API server allocates a ClusterIP out of `--service-cluster-ip-range` (10.96.0.0/12 in this model) and stores it on the object. The address is never assigned to an interface anywhere.',
      'It is reachable from inside the cluster and nowhere else, and that is not a firewall decision — it is simply that no router outside the cluster has ever been told the address exists. The ring under each hologram marks that boundary.',
      'Every other Service type is a ClusterIP plus something extra: NodePort adds a port in every node\'s wall, LoadBalancer adds a NodePort plus an external address, and Headless is the one type that opts out of having a VIP at all.',
    ],
    caveats: ['The service CIDR is fixed in this model; a real cluster sizes it at install time and cannot change it without rebuilding the control plane.'],
    keywords: ['clusterip', 'service cidr', '10.96', 'virtual ip'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const svc of s.services) {
        if (svc.type === 'Headless') continue
        out.push({ label: `${svc.namespace}/${svc.name}`, value: `${svc.clusterIp}:${svc.port}` })
      }
      return out
    },
  })

  const eRuleTable = R.register({
    id: 'net.clusterip-rule-table',
    title: 'ClusterIP as a rule table',
    district: 'network',
    kubeName: 'iptables KUBE-SERVICES',
    object: slots[0].ruleRows[0],
    summary: 'The reality behind a virtual IP: an identical set of DNAT rules programmed into every node\'s kernel.',
    detail: [
      'In iptables mode kube-proxy writes a KUBE-SERVICES chain that matches the ClusterIP and port, jumps to a per-service KUBE-SVC-xxxx chain, and from there picks one endpoint chain using a statistic module with probability 1/n, 1/(n-1), ... so the choice is uniform. IPVS mode does the same job with a real load-balancer table and scales better past a few thousand services.',
      'Each row above a node\'s cabinet is one Service\'s rule on that node, and its width is the number of backends currently programmed. The rows are identical on all four nodes because the rule set is not sharded — every node carries the rules for every Service in the cluster.',
      'A Service with zero ready endpoints does not get an empty rule: kube-proxy installs a REJECT rule, so the connection is refused immediately with ICMP port-unreachable rather than hanging until the client times out. That is why a scaled-to-zero backend produces instant errors, not slow ones.',
    ],
    caveats: [
      'Rule counts are not modelled; a real node with a thousand Services holds tens of thousands of iptables rules, and the time to reprogram them is a well-known scaling limit.',
      'The model shows one row per Service. Real chains are per (Service, port) and there is a separate chain set for NodePort and external traffic.',
    ],
    keywords: ['iptables', 'ipvs', 'dnat', 'kube-services', 'rule table', 'reject'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const n of s.nodes) {
        let backends = 0
        let syncing = 0
        for (const r of n.proxyRules) {
          backends += r.endpoints.length
          if (r.syncing) syncing++
        }
        out.push({
          label: n.name,
          value: `${n.proxyRules.length} rules, ${backends} backends${syncing > 0 ? ' (syncing)' : ''}`,
        })
      }
      return out
    },
  })
  for (const slot of slots) for (const r of slot.ruleRows) R.bind(r, eRuleTable)

  const eKubeProxy = R.register({
    id: 'net.kube-proxy',
    title: 'kube-proxy',
    district: 'network',
    kubeName: 'kube-system/kube-proxy (DaemonSet)',
    object: proxyRisers[0],
    summary: 'A per-node agent that watches Services and EndpointSlices and translates them into kernel rules. It never carries traffic.',
    detail: [
      'kube-proxy runs as a DaemonSet, one pod per node. Its whole job is reconciliation: watch the API server, compute the rule set the node should have, and write it. If kube-proxy dies, existing rules keep working — traffic does not stop, it just stops tracking changes. New pods will not receive traffic and deleted ones will keep receiving it.',
      'The name is a lie left over from the original userspace mode, where kube-proxy really did accept and forward connections. Since Kubernetes 1.2 the default has been iptables mode, where the kernel does the work and kube-proxy only programs it. Newer clusters may run nftables mode or replace kube-proxy entirely with an eBPF dataplane such as Cilium.',
      'Reprogramming is batched and rate-limited (`minSyncPeriod`), which is why an endpoint change takes a moment to take effect on every node rather than landing atomically everywhere.',
    ],
    caveats: [
      'Sync is instantaneous in this model apart from the syncing flag; a real cluster takes tens to hundreds of milliseconds, and much longer with tens of thousands of endpoints.',
    ],
    keywords: ['kube-proxy', 'daemonset', 'iptables', 'nftables', 'ebpf', 'cilium'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const n of s.nodes) {
        let syncing = false
        for (const r of n.proxyRules) if (r.syncing) syncing = true
        out.push({ label: n.name, value: syncing ? 'reprogramming rules' : 'in sync' })
      }
      return out
    },
  })
  for (const r of proxyRisers) R.bind(r, eKubeProxy)

  const eEndpointSlice = R.register({
    id: 'net.endpointslice',
    title: 'EndpointSlice',
    district: 'network',
    kubeName: 'discovery.k8s.io/v1 EndpointSlice',
    object: slots[0].sliceCard,
    summary: 'The list of pod IPs behind a Service, maintained by a controller and watched by every node.',
    detail: [
      'The EndpointSlice controller watches pods matching a Service\'s selector and records, for each one, its IP, its node and two independent booleans: `ready` (its readiness probe passes) and `serving` (it is not terminating). A pod that fails readiness is kept in the slice with ready=false rather than removed, so consumers can tell "known but not accepting traffic" from "gone".',
      'A pod entering termination is marked serving=false the instant the deletion timestamp is set — before SIGTERM is even delivered — so traffic stops arriving while the pod drains. This is the mechanism behind graceful shutdown, and it is why a preStop hook plus a termination grace period matters.',
      'EndpointSlices replaced the single Endpoints object, which had to be rewritten in full on every change: one pod flapping in a 5000-pod Service produced a 5000-entry write, fanned out to every node, several times a second. Slices cap at 100 endpoints each so a change rewrites only one slice.',
    ],
    caveats: [
      'The model shows one slice per Service with at most six visible entries. Real Services with many pods have several slices, and the mapping of pods to slices is not stable.',
    ],
    keywords: ['endpointslice', 'endpoints', 'ready', 'serving', 'terminating', 'discovery'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (const svc of s.services) {
        const ready = readyEndpoints(svc)
        out.push({
          label: `${svc.namespace}/${svc.name}`,
          value: `${ready}/${svc.endpoints.length} ready`,
          hint: ready === 0 ? 'no backends: connections are refused' : undefined,
        })
      }
      return out
    },
  })
  for (const slot of slots) {
    R.bind(slot.sliceCard, eEndpointSlice)
    R.bind(slot.overflow, eEndpointSlice)
    for (const p of slot.pips) R.bind(p, eEndpointSlice)
  }

  const eNodePort = R.register({
    id: 'net.service.nodeport',
    title: 'NodePort',
    district: 'network',
    kubeName: 'spec.type: NodePort',
    object: slots[0].doors[0],
    summary: 'The same high-numbered port opened on every node, forwarding into the Service.',
    detail: [
      'The API server allocates a port from 30000–32767 and kube-proxy opens it on every node — not only nodes running a backend pod. Hit that port on any node and the kernel DNATs the connection to some ready endpoint, possibly on a different node entirely.',
      'That second hop costs an extra network traversal and, worse, rewrites the source address so the backend sees the node\'s IP instead of the client\'s. Setting `externalTrafficPolicy: Local` avoids both by refusing to forward off-node — at the cost of imbalanced load and of nodes with no local pod failing the health check.',
      'A NodePort Service is still a ClusterIP Service: it keeps its VIP and its rule table, and the node port is an additional entrance.',
    ],
    caveats: [
      'externalTrafficPolicy and source-IP preservation are not modelled; the door is drawn as a plain entrance.',
      'The port range is not actually allocated in this model — the numbers shown come from the simulation.',
    ],
    keywords: ['nodeport', '30000', '32767', 'externaltrafficpolicy'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const svc of s.services) {
        if (svc.nodePort === undefined) continue
        out.push({ label: `${svc.namespace}/${svc.name}`, value: `:${svc.nodePort} on all ${s.nodes.length} nodes` })
      }
      return out.length > 0 ? out : [{ label: 'NodePort services', value: 'none' }]
    },
  })
  for (const slot of slots) for (const d of slot.doors) R.bind(d, eNodePort)

  const eLoadBalancer = R.register({
    id: 'net.service.loadbalancer',
    title: 'LoadBalancer',
    district: 'network',
    kubeName: 'spec.type: LoadBalancer',
    object: lbPlate,
    focus: [LX, 70, LZ + 90],
    summary: 'A NodePort plus an address provisioned outside the cluster by the cloud controller manager.',
    detail: [
      'Kubernetes itself cannot create a load balancer. When you set type: LoadBalancer, the API server allocates a ClusterIP and a NodePort as usual, and then the cloud controller manager sees the object, calls its provider\'s API, and writes the resulting address back into `status.loadBalancer.ingress`. The pylon south of the boundary is that external thing; the fence marks where Kubernetes stops.',
      'Until a controller answers, the Service sits with `<pending>` in the EXTERNAL-IP column forever. On a bare-metal cluster with no cloud provider and no MetalLB, that is the permanent state — one of the most common "my Service is broken" reports.',
      'The external load balancer usually forwards to the NodePort on every node, so the traffic path is: external address → some node → kernel DNAT → pod, which may be on a third node.',
    ],
    caveats: [
      'The cloud controller manager is drawn elsewhere in the city; the provisioning call itself is not animated here.',
      'Health checking of nodes by the external load balancer is not modelled.',
    ],
    keywords: ['loadbalancer', 'external ip', 'cloud controller manager', 'metallb', 'pending'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const svc of s.services) {
        if (svc.type !== 'LoadBalancer') continue
        out.push({ label: `${svc.namespace}/${svc.name}`, value: svc.externalIp ?? '<pending>' })
      }
      return out.length > 0 ? out : [{ label: 'LoadBalancer services', value: 'none' }]
    },
  })
  R.bind(lbGroup, eLoadBalancer)

  const eHeadless = R.register({
    id: 'net.service.headless',
    title: 'Headless Service',
    district: 'network',
    kubeName: 'spec.clusterIP: None',
    object: slots[0].cage,
    summary: 'A Service with no virtual IP: DNS returns the pod IPs directly and kube-proxy programs nothing.',
    detail: [
      'Setting `clusterIP: None` tells the API server not to allocate an address. There is no VIP, so there is no rule table and no load balancing — the empty cage is the whole point. Resolving the name returns one A record per ready endpoint, and the client picks.',
      'This is what StatefulSets use. The governing Service gives every pod a stable per-ordinal name, `web-0.web.default.svc.cluster.local`, that resolves to that specific pod. A database replica set needs to address individual members, not a random one, so a VIP would be actively wrong.',
      'It is also how clients that do their own connection pooling or consistent hashing get the member list — gRPC and many database drivers want the endpoints, not a single address to open one connection to.',
    ],
    caveats: [
      'The per-pod DNS names of a StatefulSet\'s pods are not drawn individually; only the aggregate answer path to CoreDNS is.',
    ],
    keywords: ['headless', 'clusterip none', 'statefulset', 'srv', 'a record', 'pod dns'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const svc of s.services) {
        if (svc.type !== 'Headless') continue
        out.push({ label: `${svc.namespace}/${svc.name}`, value: `${readyEndpoints(svc)} A records` })
      }
      return out.length > 0 ? out : [{ label: 'Headless services', value: 'none' }]
    },
  })
  for (const slot of slots) R.bind(slot.cage, eHeadless)

  const eIngress = R.register({
    id: 'net.ingress',
    title: 'Ingress',
    district: 'network',
    kubeName: 'networking.k8s.io/v1 Ingress',
    object: lintel,
    focus: [IX, 70, IZ + 120],
    summary: 'An HTTP routing table: host and path rules naming backend Services. Like a Service, it is a record — the controller does the work.',
    detail: [
      'An Ingress object holds rules of the form host + path → Service + port, plus an optional TLS section. Creating one changes nothing by itself. An ingress controller matching its `ingressClassName` must be running and watching, or the object sits there inert with an empty ADDRESS column.',
      'Each bay on the pad is one rule. Its lamp reads the readiness of the Service it names: green when that Service has ready endpoints, red when it has none, which is the moment users start getting 502s.',
      'The band on the lintel is the 5xx rate. This is the honest consequence of a wedged rollout: when new pods never pass readiness and old ones have already been taken down, the failure is not a red square on a dashboard, it is real requests failing at the edge. Watch it widen when a rollout breaks.',
    ],
    caveats: [
      'Request rates are scaled: one drawn packet stands for about ' + RPS_PER_PACKET + ' requests per second, and only four rules are drawn.',
      'Path types (Exact, Prefix, ImplementationSpecific), rewrite annotations, and the Gateway API successor to Ingress are not modelled.',
    ],
    keywords: ['ingress', 'host', 'path', 'route', '502', '5xx', 'ingressclass'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (const ing of s.ingresses) {
        out.push({ label: `${ing.namespace}/${ing.name}`, value: `${ing.className}, ${ing.rules.length} rules` })
        out.push({ label: 'requests/s', value: ing.rps.toFixed(0) })
        out.push({
          label: '5xx rate',
          value: formatPercent(ratio(ing.errorRate), 1),
          hint: ratio(ing.errorRate) > 0.01 ? 'backends without ready endpoints' : undefined,
        })
      }
      return out
    },
  })
  R.bind(ingressPad, eIngress)
  R.bind(errBand, eIngress)
  R.bind(rpsColumn, eIngress)
  for (const b of bays) {
    R.bind(b.slab, eIngress)
    R.bind(b.lamp, eIngress)
  }
  /* Fallback for the gatehouse's plain structure; children bound above win. */
  R.bind(ingressGroup, eIngress)

  const eIngressController = R.register({
    id: 'net.ingress-controller',
    title: 'The ingress controller',
    district: 'network',
    kubeName: 'ingress-nginx-controller (Deployment)',
    object: controllerGhost,
    summary: 'The pods that actually terminate connections and proxy HTTP. Drawn as a ghost here because they really run on the node blocks.',
    detail: [
      'An ingress controller is an ordinary Deployment — nginx, HAProxy, Envoy, Traefik — exposed by a LoadBalancer or NodePort Service. It watches Ingress objects, rewrites its own configuration, and reloads. Everything at this gatehouse is realised by those pods; the link running north to the node grid is where they physically are.',
      'A detail worth knowing: most controllers do not send traffic through the Service VIP at all. They watch the EndpointSlice themselves and open connections straight to pod IPs, so kube-proxy is out of the data path and the controller can do its own load balancing, retries, sticky sessions and per-endpoint health checks. The rails from each bay to a hologram are therefore a *name reference*, not the path a packet takes.',
      'It follows that the ingress controller is a single point of failure of exactly the ordinary kind: if its own pods are unready, every rule stops working at once, no matter how healthy the backends are.',
    ],
    caveats: [
      'The controller\'s own pods are not individually drawn on a node block in this model; the ghost and its link stand in for them.',
      'Config reload behaviour and its cost under high Ingress churn are not modelled.',
    ],
    keywords: ['ingress-nginx', 'controller', 'envoy', 'traefik', 'haproxy', 'reload'],
  })
  R.bind(ghostLink, eIngressController)

  const eTls = R.register({
    id: 'net.tls-termination',
    title: 'TLS termination',
    district: 'network',
    kubeName: 'spec.tls[].secretName',
    object: tlsShell,
    summary: 'The point where ciphertext becomes plaintext. South of this plane the traffic is encrypted; north of it, inside the cluster, it usually is not.',
    detail: [
      'The Ingress names a Secret of type `kubernetes.io/tls` holding a certificate and key. The controller loads it and completes the TLS handshake itself, selecting the certificate by SNI so one address can serve many hosts. Packets change colour at this plane because they genuinely change form here.',
      'What continues to the pods is plain HTTP over the pod network, unless you deliberately re-encrypt or run a service mesh with mTLS. Anyone who can capture traffic inside the cluster network sees it. This surprises people who believe "we use HTTPS".',
      'The certificate lives in a Secret, which is base64 in etcd, not encrypted, unless encryption-at-rest is configured. cert-manager is the usual way the Secret gets created and renewed; when renewal fails, the padlock here stays lit while browsers start refusing the connection.',
    ],
    caveats: [
      'The handshake itself, SNI selection and certificate expiry are not simulated — the lock only reports whether spec.tls is set.',
    ],
    keywords: ['tls', 'https', 'certificate', 'sni', 'cert-manager', 'secret', 'termination'],
    metrics: (s) => {
      const out: { label: string; value: string }[] = []
      for (const ing of s.ingresses) {
        out.push({ label: `${ing.namespace}/${ing.name}`, value: ing.tls ? 'TLS terminated here' : 'plaintext HTTP' })
      }
      return out
    },
  })
  R.bind(tlsLock, eTls)

  const eCoreDns = R.register({
    id: 'net.coredns',
    title: 'CoreDNS',
    district: 'network',
    kubeName: 'kube-system/coredns (Deployment)',
    object: dnsFloors[0],
    focus: [DX, 60, DZ + 90],
    summary: 'The cluster\'s name server: it turns Service names into ClusterIPs. It is a Deployment, so it fails like any other workload.',
    detail: [
      'CoreDNS watches Services and EndpointSlices through the kubernetes plugin and answers `<service>.<namespace>.svc.cluster.local` with the ClusterIP — or, for a headless Service, with one A record per ready pod. kubelet writes its Service address into every pod\'s /etc/resolv.conf as the nameserver.',
      'The tower is lit by however many CoreDNS pods are Ready, because that is literally what it depends on. Two replicas is the common default for a cluster of any size, which makes DNS one of the least redundant things in a cluster relative to how much traffic it carries. When the floors go dark, name resolution fails cluster-wide and every application starts reporting connection errors that look nothing like a DNS problem.',
      'The tank beside the tower is the cache plugin\'s hit ratio. Note that CoreDNS reaches itself through a Service, like everything else — the resolver address in a pod is a ClusterIP, so DNS depends on kube-proxy\'s rules being programmed, and kube-proxy depends on the API server. NodeLocal DNSCache exists to shorten that chain.',
    ],
    caveats: [
      'Query rate, latency and cache hit ratio are model values, not measurements.',
      'The conntrack races and UDP timeouts that cause the classic intermittent 5-second DNS delays are not modelled.',
    ],
    keywords: ['coredns', 'dns', 'resolv.conf', 'cluster.local', 'cache', 'nameserver', 'kube-dns'],
    metrics: (s) => [
      { label: 'ready replicas', value: `${s.dns.readyReplicas}`, hint: s.dns.readyReplicas === 0 ? 'cluster-wide resolution failure' : undefined },
      { label: 'queries/s', value: s.dns.queriesPerSec.toFixed(0) },
      { label: 'cache hit', value: formatPercent(ratio(s.dns.cacheHitRatio), 0) },
      { label: 'latency', value: formatMs(s.dns.latencyMs) },
      { label: 'NXDOMAIN', value: formatPercent(ratio(s.dns.nxdomainRate), 1) },
    ],
  })
  for (const f of dnsFloors) R.bind(f, eCoreDns)
  R.bind(dnsBeacon, eCoreDns)
  R.bind(dnsCacheFill, eCoreDns)
  /* Fallbacks, so no piece of this district's structure resolves to nothing. */
  R.bind(dnsGroup, eCoreDns)

  const eNdots = R.register({
    id: 'net.ndots',
    title: 'ndots:5 and the search path',
    district: 'network',
    kubeName: '/etc/resolv.conf options ndots:5',
    object: ndotsRungs[0],
    summary: 'Why every external name costs three failed lookups first: the resolver tries the cluster search domains before the name you actually typed.',
    detail: [
      'kubelet writes into each pod: `search <ns>.svc.cluster.local svc.cluster.local cluster.local` and `options ndots:5`. ndots means "if the name has fewer than five dots, treat it as relative and try the search list before trying it as an absolute name".',
      'So `api.stripe.com` — two dots — is first looked up as api.stripe.com.<ns>.svc.cluster.local, then .svc.cluster.local, then .cluster.local, all NXDOMAIN, and only then as typed. Four lookups instead of one, and glibc sends A and AAAA in parallel, so eight queries for one connection. That is the ladder: rungs 0–2 are the tax, rung 3 is the answer.',
      'The value 5 exists so that `web.default.svc` (two dots) still resolves as a relative cluster name. The fix for external-heavy workloads is a trailing dot — `api.stripe.com.` — or a per-pod `dnsConfig` lowering ndots, not disabling the search path.',
    ],
    caveats: [
      'The ladder animates a representative query, not the actual query stream; the fraction of climbs that pay the full tax follows the reported NXDOMAIN rate.',
      'The node\'s own resolv.conf search domains, which kubelet may append, are not drawn.',
    ],
    keywords: ['ndots', 'search path', 'nxdomain', 'resolv.conf', 'dnsconfig', 'trailing dot'],
    metrics: (s) => [
      { label: 'NXDOMAIN rate', value: formatPercent(ratio(s.dns.nxdomainRate), 1) },
      { label: 'lookups per external name', value: `${NDOTS_RUNGS}`, hint: 'doubled again by parallel A + AAAA' },
    ],
  })
  for (const r of ndotsRungs) R.bind(r, eNdots)
  R.bind(ndotsToken, eNdots)

  const ePolicy = R.register({
    id: 'net.networkpolicy',
    title: 'NetworkPolicy: default-deny',
    district: 'network',
    kubeName: 'networking.k8s.io/v1 NetworkPolicy',
    object: gates[0].group,
    focus: [0, 50, GATE_Z + 90],
    summary: 'The rule that catches everyone: a pod with no policy accepts everything, and a pod selected by any policy accepts only what that policy allows.',
    detail: [
      'A cluster with no NetworkPolicy is fully open — every pod can reach every other pod, in every namespace. The moment one policy\'s podSelector matches a pod, that pod switches to default-deny for the directions the policy mentions, and only the listed peers get through. Adding an empty policy to a namespace is how you turn that on deliberately.',
      'The trap is that this is per-pod and additive, not per-namespace and ordered. There is no deny rule and no precedence: policies are unioned, so you cannot write an exception to a broader allow. And a policy with `policyTypes: [Ingress]` says nothing about egress, which stays wide open.',
      'The gates here sit on the path from the ingress controller to the pods, because that is where the first policy someone writes usually breaks production: a default-deny that forgets to allow the ingress-controller namespace takes the site down while every pod stays perfectly Ready. The sparks bouncing back are connections dropped — silently, with no RST, so the client sees a timeout and the pod logs nothing.',
    ],
    caveats: [
      'Enforcement is the CNI plugin\'s job, not Kubernetes\'. A cluster running a CNI without policy support accepts NetworkPolicy objects and ignores them completely.',
      'Egress rules, ipBlock CIDRs, namespaceSelector and port-level rules are not drawn; each gate shows up to four allowed peer lanes.',
    ],
    keywords: ['networkpolicy', 'default deny', 'podselector', 'cni', 'calico', 'cilium', 'egress'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = [
        { label: 'policies', value: `${s.networkPolicies.length}` },
      ]
      for (const p of s.networkPolicies) {
        out.push({
          label: `${p.namespace}/${p.name}`,
          value: `${p.ingressFrom.length} allowed peers, ${p.denied} denied`,
          hint: p.ingressFrom.length === 0 ? 'selects pods but allows nothing: total deny' : undefined,
        })
      }
      return out
    },
  })
  for (const g of gates) R.bind(g.group, ePolicy)

  const eExternal = R.register({
    id: 'net.external-traffic',
    title: 'Traffic from outside',
    district: 'network',
    kubeName: 'status.loadBalancer.ingress',
    object: clientBeacons[0],
    focus: [EX, 60, EZ + 120],
    summary: 'The only path a user\'s request can take into the cluster: external address → load balancer → ingress → pod.',
    detail: [
      'Everything south of the boundary plane is outside Kubernetes and outside its control: DNS for the public hostname, the cloud load balancer, the client. Nothing in the cluster can fix a problem out there, which is worth remembering when a site is down and every pod is Ready.',
      'Inside, the request is terminated by the ingress controller and forwarded to a pod IP over the cluster network. The colour change at the gatehouse is TLS termination; the packets north of it are plain HTTP.',
      'The number of packets in flight is the arriving request rate, and the red ones travelling back south are 5xx responses reaching real users.',
    ],
    caveats: [
      'One packet stands for roughly ' + RPS_PER_PACKET + ' requests per second, and the stream saturates at ' + EXT_PACKETS * RPS_PER_PACKET + ' rps.',
      'Public DNS, TCP handshakes and connection reuse are not modelled; each packet is an independent request.',
    ],
    keywords: ['external', 'traffic', 'client', 'load balancer', 'rps', 'north-south'],
    metrics: (s) => {
      let rps = 0
      let err = 0
      for (const ing of s.ingresses) {
        rps += ing.rps
        err += ing.rps * ratio(ing.errorRate)
      }
      return [
        { label: 'arriving rps', value: rps.toFixed(0) },
        { label: 'failing rps', value: err.toFixed(0), hint: '5xx returned to users' },
      ]
    },
  })
  for (const b of clientBeacons) R.bind(b, eExternal)

  /* Re-skin on a theme flip: setMode() disposes every cached material, so any
   * reference captured at build time is dangling afterwards. */
  const offTheme = ctx.bus.on('theme', () => {
    M = buildMats()
    for (const s of skinned) s.mesh.material = M[s.key]
    extPackets.material = M.crypt
    intPackets.material = M.traffic
    errSparks.material = M.failed
    dnsPackets.material = M.dns
    denySparks.material = M.failed
  })

  /* ------------------------------------------------------------------------
   * Frame loop. Allocates nothing.
   * ----------------------------------------------------------------------*/
  let time = 0
  let ndotsT = 0
  let ndotsExternal = false

  function writeStrand(seg: number, hex: number, k: number): void {
    _c.setHex(hex)
    const r = _c.r * k
    const g = _c.g * k
    const b = _c.b * k
    strandCol[seg] = r
    strandCol[seg + 1] = g
    strandCol[seg + 2] = b
    strandCol[seg + 3] = r
    strandCol[seg + 4] = g
    strandCol[seg + 5] = b
  }

  function updateServices(s: SimState): void {
    const nSvc = Math.min(s.services.length, MAX_SERVICES)
    for (let i = 0; i < MAX_SERVICES; i++) {
      const slot = slots[i]
      if (i >= nSvc) {
        slot.group.visible = false
        for (let n = 0; n < N_NODES; n++) {
          slot.doors[n].visible = false
          slot.ruleRows[n].visible = false
        }
        slot.portLabel.object.visible = false
        for (let p = 0; p < MAX_EP; p++) {
          for (let t = 0; t < TARGETS; t++) {
            writeStrand(((i * MAX_EP + p) * TARGETS + t) * 6, 0x000000, 0)
          }
        }
        const eo = i * 6
        extCol[eo] = 0
        extCol[eo + 1] = 0
        extCol[eo + 2] = 0
        extCol[eo + 3] = 0
        extCol[eo + 4] = 0
        extCol[eo + 5] = 0
        continue
      }

      const svc = s.services[i]
      const headless = svc.type === 'Headless'
      const ready = readyEndpoints(svc)
      const dead = !headless && ready === 0
      slot.group.visible = true

      /* Identity changed: rebuild the two label textures. Never per frame. */
      const np = svc.nodePort ?? -1
      if (
        svc.name !== slot.sName ||
        svc.namespace !== slot.sNs ||
        svc.clusterIp !== slot.sIp ||
        svc.type !== slot.sType ||
        svc.port !== slot.sPort ||
        np !== slot.sNodePort
      ) {
        slot.sName = svc.name
        slot.sNs = svc.namespace
        slot.sIp = svc.clusterIp
        slot.sType = svc.type
        slot.sPort = svc.port
        slot.sNodePort = np
        slot.label.set(
          `${svc.namespace}/${svc.name}`,
          svc.type,
          headless ? 'clusterIP: None' : `${svc.clusterIp}:${svc.port}`,
        )
        slot.portLabel.set(np >= 0 ? `:${np}` : '', '', '')
      }

      /* The address bobs but never lands: it has no matter. */
      slot.core.visible = !headless
      slot.core.position.y = Math.sin(time * 0.7 + i) * 1.6
      slot.core.rotation.y = time * 0.35
      slot.core.material = dead ? M.vipDead : M.vip
      slot.halo.visible = !headless
      slot.halo.rotation.y = -time * 0.5
      slot.cage.visible = headless
      slot.boundary.visible = !headless
      slot.dead.visible = dead
      slot.dead.material = M.failed

      /* EndpointSlice: ready / not-ready / draining / empty. */
      const nEp = svc.endpoints.length
      for (let p = 0; p < MAX_EP; p++) {
        const pip = slot.pips[p]
        if (p >= nEp) {
          pip.visible = false
          continue
        }
        const e = svc.endpoints[p]
        pip.visible = true
        pip.material = !e.serving ? M.term : e.ready ? M.ready : M.pending
      }
      slot.overflow.visible = nEp > MAX_EP

      /* External address: LoadBalancer only, and only once provisioned. */
      const eo = i * 6
      const hasExt = svc.type === 'LoadBalancer' && svc.externalIp !== undefined
      _c.setHex(hasExt ? COLOR.traffic : COLOR.pending)
      const ek = svc.type === 'LoadBalancer' ? (hasExt ? 0.85 : 0.2) : 0
      extCol[eo] = _c.r * ek
      extCol[eo + 1] = _c.g * ek
      extCol[eo + 2] = _c.b * ek
      extCol[eo + 3] = _c.r * ek
      extCol[eo + 4] = _c.g * ek
      extCol[eo + 5] = _c.b * ek

      /* Per-node reality: a door and a rule row on every node. */
      for (let n = 0; n < N_NODES; n++) {
        const door = slot.doors[n]
        door.visible = np >= 0
        door.material = np >= 0 ? (dead ? M.ruleReject : M.doorOn) : M.off

        const row = slot.ruleRows[n]
        const node = n < s.nodes.length ? s.nodes[n] : undefined
        let rule = undefined
        if (node) {
          for (let k = 0; k < node.proxyRules.length; k++) {
            if (node.proxyRules[k].service === svc.name) {
              rule = node.proxyRules[k]
              break
            }
          }
        }
        if (headless) {
          /* Headless services get no rule at all. The absence is the lesson. */
          row.visible = false
        } else {
          row.visible = true
          const backends = rule ? rule.endpoints.length : 0
          row.scale.x = 5 + backends * 1.6
          row.material = !rule ? M.off : rule.syncing ? M.ruleSync : backends === 0 ? M.ruleReject : M.ruleOn
        }

        /* Strand colour. An endpoint's readiness is a single fact, so its
         * strand changes on every node in the same frame. */
        for (let p = 0; p < MAX_EP; p++) {
          const seg = ((i * MAX_EP + p) * TARGETS + n) * 6
          if (headless || p >= nEp) {
            writeStrand(seg, 0x000000, 0)
            continue
          }
          const e = svc.endpoints[p]
          if (!rule) {
            writeStrand(seg, COLOR.pending, 0.08)
          } else if (!e.serving) {
            writeStrand(seg, COLOR.terminating, 0.18)
          } else if (!e.ready) {
            writeStrand(seg, COLOR.network, 0.1)
          } else {
            writeStrand(seg, COLOR.network, 0.55 + 0.25 * Math.sin(time * 2.2 + p * 1.7))
          }
        }
      }

      /* The DNS strand: only a headless Service answers with pod IPs. */
      const dnsUp = s.dns.readyReplicas > 0
      for (let p = 0; p < MAX_EP; p++) {
        const seg = ((i * MAX_EP + p) * TARGETS + N_NODES) * 6
        if (!headless || p >= nEp || !dnsUp) {
          writeStrand(seg, 0x000000, 0)
        } else {
          const e = svc.endpoints[p]
          writeStrand(seg, COLOR.dns, e.ready && e.serving ? 0.6 : 0.1)
        }
      }
      slot.portLabel.object.visible = np >= 0
    }
    strandGeo.attributes.color.needsUpdate = true
    extGeo.attributes.color.needsUpdate = true
  }

  function updateIngress(s: SimState): void {
    const ing: IngressState | undefined = s.ingresses.length > 0 ? s.ingresses[0] : undefined
    const rps = ing ? ing.rps : 0
    const err = ing ? ratio(ing.errorRate) : 0
    const tls = ing ? ing.tls : false

    rpsColumn.scale.y = 4 + Math.min(rps, 400) * 0.11
    rpsColumn.position.y = rpsColumn.scale.y / 2 + 3
    errBand.scale.x = Math.max(0.4, err * 100)
    errBand.visible = err > 0.001
    lintel.material = err > 0.05 ? M.failed : M.ingress
    tlsShell.visible = tls
    tlsLock.material = tls ? M.crypt : M.off

    for (let r = 0; r < MAX_RULES; r++) {
      const bay = bays[r]
      const rule = ing && r < ing.rules.length ? ing.rules[r] : undefined
      const o = r * 6
      if (!rule) {
        bay.slab.visible = false
        bay.lamp.visible = false
        bay.label.object.visible = false
        bay.targetSlot = -1
        railCol[o] = 0
        railCol[o + 1] = 0
        railCol[o + 2] = 0
        railCol[o + 3] = 0
        railCol[o + 4] = 0
        railCol[o + 5] = 0
        continue
      }
      bay.slab.visible = true
      bay.lamp.visible = true
      bay.label.object.visible = true
      if (rule.host !== bay.host || rule.path !== bay.path || rule.service !== bay.service) {
        bay.host = rule.host
        bay.path = rule.path
        bay.service = rule.service
        bay.label.set(rule.host, `${rule.path} -> ${rule.service}:${rule.port}`, '')
      }

      const slotIdx = serviceSlotFor(s, rule.service)
      if (slotIdx !== bay.targetSlot) {
        bay.targetSlot = slotIdx
        railPos[o + 3] = slotIdx >= 0 ? svcSlotX(slotIdx) : railPos[o]
        railPos[o + 4] = slotIdx >= 0 ? SVC_Y + SVC_CARD_Y - 3 : railPos[o + 1]
        railPos[o + 5] = slotIdx >= 0 ? SVC_Z : railPos[o + 2]
        railGeo.attributes.position.needsUpdate = true
      }

      let backends = 0
      if (slotIdx >= 0) backends = readyEndpoints(s.services[slotIdx])
      bay.slab.material = M.deck
      bay.lamp.material = slotIdx < 0 ? M.failed : backends === 0 ? M.ruleReject : M.ready
      _c.setHex(slotIdx < 0 || backends === 0 ? COLOR.failed : COLOR.ingress)
      const k = 0.35
      railCol[o] = _c.r * k
      railCol[o + 1] = _c.g * k
      railCol[o + 2] = _c.b * k
      railCol[o + 3] = _c.r * k
      railCol[o + 4] = _c.g * k
      railCol[o + 5] = _c.b * k
    }
    railGeo.attributes.color.needsUpdate = true

    /* The controller's link home dims when the edge has nothing to do. */
    _c.setHex(COLOR.desired)
    const gk = 0.1 + Math.min(rps, 300) * 0.0006
    ghostCol[0] = _c.r * gk
    ghostCol[1] = _c.g * gk
    ghostCol[2] = _c.b * gk
    ghostCol[3] = _c.r * gk
    ghostCol[4] = _c.g * gk
    ghostCol[5] = _c.b * gk
    ghostGeo.attributes.color.needsUpdate = true

    /* Beacons out in the world: how much of the client population is talking. */
    const lit = clamp(Math.round(rps / 30), 0, clientBeacons.length)
    for (let i = 0; i < clientBeacons.length; i++) {
      clientBeacons[i].material = i < lit ? M.traffic : M.off
    }

    let hasExt = false
    for (const svc of s.services) {
      if (svc.type === 'LoadBalancer' && svc.externalIp !== undefined) hasExt = true
    }
    lbPlate.material = hasExt ? M.traffic : M.off

    /* Packets. Encrypted outside the gate, plaintext inside it. */
    extPackets.material = tls ? M.crypt : M.traffic
    const extActive = clamp(Math.round(rps / RPS_PER_PACKET), 0, EXT_PACKETS)
    driveFlow(extPackets, extCurve, extOffsets, extActive, 0.16, time, 1.5, false)
    const intActive = clamp(Math.round((rps * (1 - err)) / RPS_PER_PACKET), 0, INT_PACKETS)
    driveFlow(intPackets, intCurve, intOffsets, intActive, 0.2, time, 1.5, false)
    const errActive = clamp(Math.round((rps * err) / RPS_PER_PACKET), 0, ERR_SPARKS)
    driveFlow(errSparks, extCurve, errOffsets, errActive, 0.19, time, 1.8, true)
  }

  function updateDns(s: SimState, dt: number): void {
    const up = s.dns.readyReplicas
    for (let f = 0; f < DNS_FLOORS; f++) {
      dnsFloors[f].material = f < up ? M.dns : M.off
    }
    dnsBeacon.material = up > 0 ? M.dns : M.failed
    dnsBeacon.rotation.y = time * 0.8

    const hit = ratio(s.dns.cacheHitRatio)
    dnsCacheFill.scale.y = Math.max(0.4, hit * 19)
    dnsCacheFill.position.y = dnsCacheFill.scale.y / 2 + 0.5
    dnsCacheFill.material = up > 0 ? M.dns : M.off

    /* A representative query climbing the search path. Rungs 0..2 are the tax
     * an external name pays; a cluster-local name is answered on rung 0. */
    const climbRate = 1.4
    ndotsT += dt * climbRate
    const top = ndotsExternal ? NDOTS_RUNGS : 1
    if (ndotsT >= top) {
      ndotsT = 0
      ndotsExternal = rng.next() < clamp(ratio(s.dns.nxdomainRate) * 4, 0, 1)
    }
    const rung = Math.min(Math.floor(ndotsT), NDOTS_RUNGS - 1)
    ndotsToken.visible = up > 0
    ndotsToken.position.y = 8 + rung * 8 + 2.6
    for (let r = 0; r < NDOTS_RUNGS; r++) {
      if (up === 0) {
        ndotsRungs[r].material = M.off
      } else if (r > rung) {
        ndotsRungs[r].material = M.off
      } else if (r === top - 1) {
        ndotsRungs[r].material = M.ready
      } else {
        ndotsRungs[r].material = M.failed
      }
    }

    /* Round trip: out and back, with the reported latency stretching the trip. */
    const qps = s.dns.queriesPerSec
    const active = up > 0 ? clamp(Math.round(qps / 8), 0, DNS_PACKETS) : 0
    dnsPackets.count = active
    const period = 1.2 + clamp(s.dns.latencyMs, 0, 200) / 40
    for (let i = 0; i < active; i++) {
      const ph = ((time / period) + i / DNS_PACKETS) % 1
      const u = ph < 0.5 ? ph * 2 : 2 - ph * 2
      _v.lerpVectors(dnsFrom, dnsTo, u)
      _v.y += Math.sin(u * Math.PI) * 18
      _m4.makeScale(1.2, 1.2, 1.2)
      _m4.setPosition(_v)
      dnsPackets.setMatrixAt(i, _m4)
    }
    dnsPackets.instanceMatrix.needsUpdate = true
  }

  function updatePolicies(s: SimState): void {
    const policies = s.networkPolicies
    const enabled = policies.length > 0
    /* Every checkpoint shows the same policy set: a policy is namespace-scoped
     * and follows the pod, not the node. */
    const pol = enabled ? policies[0] : undefined
    const allowed = pol ? Math.min(pol.ingressFrom.length, POLICY_LANES) : POLICY_LANES

    for (let n = 0; n < N_NODES; n++) {
      const gate = gates[n]
      for (let l = 0; l < POLICY_LANES; l++) {
        const lane = gate.lanes[l]
        if (!enabled) {
          /* No policy selects these pods: everything is allowed, and there is
           * nothing to enforce. Retracted barriers, not open gates. */
          lane.scale.y = 1.2
          lane.position.y = 0.6
          lane.material = M.off
        } else if (l < allowed) {
          lane.scale.y = 1.2
          lane.position.y = 0.6
          lane.material = M.policy
        } else {
          lane.scale.y = 11
          lane.position.y = 6
          lane.material = M.ruleReject
        }
      }
      gate.beacon.material = enabled ? (allowed === 0 ? M.failed : M.policy) : M.off
      gate.beacon.visible = enabled
    }

    /* Sparks: allowed lanes carry a connection through, denied lanes bounce it. */
    denySparks.count = enabled ? DENY_SPARKS : 0
    if (!enabled) {
      denySparks.instanceMatrix.needsUpdate = true
      return
    }
    for (let i = 0; i < DENY_SPARKS; i++) {
      const n = (i / POLICY_LANES) | 0
      const l = i % POLICY_LANES
      const ph = (time * 0.5 + denyPhase[i]) % 1
      nodeAnchor(n, _v2)
      const lx = _v2.x + (l - (POLICY_LANES - 1) / 2) * 7.4
      let z: number
      if (l < allowed) {
        z = GATE_Z + 34 - ph * 60
      } else {
        /* Dropped at the checkpoint and reflected: no RST, just a timeout. */
        const t = ph < 0.5 ? ph * 2 : 2 - ph * 2
        z = GATE_Z + 34 - t * 32
      }
      _v.set(lx, 5.5, z)
      _m4.makeScale(1.1, 1.1, 1.1)
      _m4.setPosition(_v)
      denySparks.setMatrixAt(i, _m4)
    }
    denySparks.instanceMatrix.needsUpdate = true
  }

  return {
    group,
    update(s: SimState, dt: number): void {
      time += dt
      updateServices(s)
      updateIngress(s)
      updateDns(s, dt)
      updatePolicies(s)
    },
    dispose(): void {
      offTheme()
      for (const g of geos) g.dispose()
      for (const l of labels) l.dispose()
      lineMat.dispose()
      extPackets.dispose()
      intPackets.dispose()
      errSparks.dispose()
      dnsPackets.dispose()
      denySparks.dispose()
    },
  }
}
