import * as THREE from 'three'
import { API_STAGES, TIMING } from '../core/types'
import type { AdmissionWebhook, ApiRequest, ApiStage, Kind, SimState, Verb } from '../core/types'
import { COLOR, glass, mat, neon, structural } from '../core/theme'
import { approach, clamp, formatMs } from '../core/util'
import { ANCHOR, API_TOWER_TOP, CITY, apiFloorPos, apiFloorY } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE API SERVER TOWER — kube-apiserver.
 *
 * Nine floors, one per stage of the request handler chain, in request order top
 * to bottom. A write physically sinks: it enters the crown at TLS and leaves the
 * bottom of the building either as a response to the client or, if it is a
 * write, through the storage door on the south face toward etcd.
 *
 * The teaching claim the geometry makes: rejection happens at a *place*. A 403
 * stops on the authz floor beside the rule cell that had no matching rule; a 429
 * bounces off the seat pool on the APF floor; a webhook timeout piles up on the
 * mutating floor with its annex gone dark. If a reader cannot tell those apart
 * by looking, this building is wrong.
 * ==========================================================================*/

const TAU = Math.PI * 2

const W = CITY.api.w
const D = CITY.api.d
const GAP = CITY.api.floorGap
const SLAB = CITY.api.slab
const HW = W / 2
const HD = D / 2
const N_STAGES = API_STAGES.length

/** Carriers drawn at once. Real servers run thousands of concurrent requests. */
const CARRIER_MAX = 24
const SEAT_COLS = 8
const SEAT_ROWS = 4
const SEAT_MAX = SEAT_COLS * SEAT_ROWS
const SEAT_PITCH = 4
/** Shed (429) pucks in flight at once. */
const SHED_MAX = 8
const WATCH_MASTS = 12
/** Webhook annexes drawn per admission floor. */
const WEBHOOK_SLOTS = 2
/** Bars in the watch-cache lag arc; one bar is one revision behind etcd. */
const LAG_BARS = 24
const PILE_MAX = 6

/* The RBAC wall. Columns are verbs, rows are resource groups, and a lit tile is
 * a rule that allows that (verb, resource) pair. Nothing else is permitted:
 * RBAC has no deny rules, so a dark tile simply means no rule matched. */
const VERBS: readonly Verb[] = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
const RBAC_ROWS: readonly string[] = [
  'pods',
  'workloads (deployments, replicasets, ...)',
  'services, endpointslices, ingresses',
  'nodes, leases',
  'secrets, configmaps, serviceaccounts',
  'clusterrolebindings',
]
/* Bit i is VERBS[i]. 0b1111111 = all seven verbs. */
const RBAC_ALLOW: readonly number[] = [
  0b1111111, // pods
  0b1111111, // workloads
  0b1111111, // services
  0b0110111, // nodes: read + update/patch status, never create or delete
  0b0000111, // secrets/configmaps: read only
  0b0000000, // clusterrolebindings: no rule at all — escalation stays denied
]
const RBAC_COL_PITCH = 1.6
const RBAC_ROW_PITCH = 1.15
const RBAC_Z = -14
const RBAC_Y0 = 1.4

const OUTCOME_KEYS = ['ok', 'forbidden', 'unauthorized', 'rejected', 'conflict'] as const

const AUTHN_PLATES: readonly string[] = [
  'x509 client certificate',
  'ServiceAccount bearer token',
  'OIDC id_token',
  'anonymous',
]

/* Scratch. Frame loops allocate nothing, so every vector used per frame lives
 * here and is overwritten in place. */
const _v = new THREE.Vector3()

type Mats = ReturnType<typeof buildMats>
type MatKey = keyof Mats

function buildMats() {
  return {
    shell: glass(COLOR.api, 0.1),
    shellReadOnly: glass(COLOR.failed, 0.13),
    slab: mat(structural('deck'), 0.9),
    plinth: mat(structural('concrete'), 0.95),
    column: mat(COLOR.edge, 0.7),
    dim: mat(COLOR.edge, 0.8),
    dark: mat(structural('deck'), 0.95),
    api: neon(COLOR.api, 1.6),
    apiSoft: neon(COLOR.api, 0.6),
    ready: neon(COLOR.ready, 1.5),
    pending: neon(COLOR.pending, 1.6),
    backoff: neon(COLOR.backoff, 1.6),
    throttled: neon(COLOR.throttled, 1.8),
    failed: neon(COLOR.failed, 1.5),
    failedBright: neon(COLOR.failed, 3.2),
    etcd: neon(COLOR.etcd, 1.4),
    raft: neon(COLOR.raft, 1.2),
  }
}

/** FNV-1a over the request id: a stable lane per request, with no allocation. */
function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function stageIndex(stage: ApiStage): number {
  return API_STAGES.indexOf(stage)
}

/** Which row of the rule wall a Kind belongs to; -1 for kinds not on the wall. */
function rbacRow(kind: Kind): number {
  switch (kind) {
    case 'Pod':
      return 0
    case 'Deployment':
    case 'ReplicaSet':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
    case 'CronJob':
    case 'HorizontalPodAutoscaler':
    case 'PodDisruptionBudget':
      return 1
    case 'Service':
    case 'EndpointSlice':
    case 'Ingress':
      return 2
    case 'Node':
    case 'Lease':
      return 3
    case 'Secret':
    case 'ConfigMap':
    case 'ServiceAccount':
      return 4
    default:
      return -1
  }
}

/** Which authenticator in the chain claims this subject. */
function authnPlate(subject: string): number {
  if (subject.startsWith('system:serviceaccount:')) return 1
  if (subject.startsWith('system:node:')) return 0
  if (subject.startsWith('system:anonymous')) return 3
  if (subject.includes('@')) return 2
  return 0
}

function outcomeMat(m: Mats, r: ApiRequest, t: number): THREE.MeshStandardMaterial {
  switch (r.outcome) {
    case 'inflight':
      return m.api
    case 'ok':
      return m.ready
    case 'conflict':
      return m.backoff
    default:
      /* Rejections flash so the eye lands on the floor that stopped them. */
      return Math.sin(t * 18) > 0 ? m.failedBright : m.failed
  }
}

interface Annex {
  root: THREE.Group
  shellMesh: THREE.Mesh
  beacon: THREE.Mesh
  bead: THREE.Mesh
  webhook: AdmissionWebhook | undefined
}

export function createApiServer(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'apiserver'
  group.position.set(CITY.api.x, 0, CITY.api.z)

  let mats = buildMats()
  const geoms: THREE.BufferGeometry[] = []
  /* Static meshes remember which palette slot they took, so a day/night flip —
   * which disposes every cached material — can re-point them at the new one. */
  const statics: { o: THREE.Mesh; k: MatKey }[] = []

  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    geoms.push(g)
    return g
  }
  const box = (w: number, h: number, d: number): THREE.BoxGeometry =>
    geo(new THREE.BoxGeometry(w, h, d))

  function mesh(g: THREE.BufferGeometry, k: MatKey, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(g, mats[k])
    statics.push({ o: m, k })
    parent.add(m)
    return m
  }
  /** A mesh whose material is reassigned every frame; not tracked in `statics`. */
  function dyn(g: THREE.BufferGeometry, k: MatKey, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(g, mats[k])
    parent.add(m)
    return m
  }

  /* ------------------------------------------------------------------ shell */

  const plinthGeo = box(W + 10, CITY.api.baseY - SLAB, D + 10)
  const plinth = mesh(plinthGeo, 'plinth', group)
  plinth.position.y = (CITY.api.baseY - SLAB) / 2

  const colHeight = API_TOWER_TOP + GAP
  const colGeo = box(2.4, colHeight, 2.4)
  for (let i = 0; i < 4; i++) {
    const c = mesh(colGeo, 'column', group)
    c.position.set(
      (i & 1 ? 1 : -1) * (HW - 1.4),
      colHeight / 2,
      (i & 2 ? 1 : -1) * (HD - 1.4),
    )
  }

  const shellGeo = box(W, GAP - 0.3, D)
  const slabGeo = box(W, SLAB, D)

  const floors: THREE.Group[] = []
  const shells: THREE.Mesh[] = []
  for (let i = 0; i < N_STAGES; i++) {
    const fg = new THREE.Group()
    fg.name = `api-floor-${API_STAGES[i]}`
    fg.position.y = apiFloorY(API_STAGES[i])
    group.add(fg)
    floors.push(fg)

    const slab = mesh(slabGeo, 'slab', fg)
    slab.position.y = -SLAB / 2

    const shell = mesh(shellGeo, 'shell', fg)
    shell.position.y = (GAP - SLAB) / 2
    shell.renderOrder = 2
    shells.push(shell)
  }

  /* -------------------------------------------------- floor 0: TLS terminus */

  const tls = floors[0]
  const portalPost = box(1.4, 8, 1.4)
  for (let i = 0; i < 2; i++) {
    const p = mesh(portalPost, 'api', tls)
    p.position.set((i ? 1 : -1) * 7, 4, -HD + 1.6)
  }
  const portalLintel = mesh(box(15.4, 1.2, 1.4), 'api', tls)
  portalLintel.position.set(0, 8.4, -HD + 1.6)

  /* Two certificates, because TLS here is mutual: the server always presents
   * one, the client's is optional and only becomes an *identity* one floor down. */
  const certGeo = box(4.4, 5.6, 0.5)
  const serverCert = mesh(certGeo, 'api', tls)
  serverCert.position.set(-11, 3.4, -HD + 6)
  const clientCert = dyn(certGeo, 'dim', tls)
  clientCert.position.set(11, 3.4, -HD + 6)

  const beadGeo = geo(new THREE.IcosahedronGeometry(0.8, 0))
  const handshake = dyn(beadGeo, 'api', tls)
  handshake.position.set(0, 5.4, -HD + 1.6)

  /* ------------------------------------------------- floor 1: authentication */

  const authn = floors[1]
  const plateGeo = box(5, 6, 0.6)
  const authnPlates: THREE.Mesh[] = []
  for (let i = 0; i < AUTHN_PLATES.length; i++) {
    const p = dyn(plateGeo, 'dim', authn)
    p.position.set((i - (AUTHN_PLATES.length - 1) / 2) * 6.6, 3.6, -8)
    authnPlates.push(p)
  }
  /* The chain's verdict: lit when nothing in the chain claimed the request. */
  const authnDeny = dyn(box(28, 0.9, 0.9), 'failed', authn)
  authnDeny.position.set(0, 7.6, -8)
  authnDeny.visible = false

  /* ------------------------------------------------------ floor 2: RBAC wall */

  const authz = floors[2]
  const rbacRoot = new THREE.Group()
  authz.add(rbacRoot)
  const tileGeo = box(1.25, 0.95, 0.35)
  /* Allowed and denied tiles never change, so they are two static instanced
   * draws; only the cell the current request lands on is animated. */
  let nAllow = 0
  for (let r = 0; r < RBAC_ROWS.length; r++) {
    for (let c = 0; c < VERBS.length; c++) if (RBAC_ALLOW[r] & (1 << c)) nAllow++
  }
  const nDeny = RBAC_ROWS.length * VERBS.length - nAllow
  const allowTiles = new THREE.InstancedMesh(tileGeo, mats.ready, nAllow)
  const denyTiles = new THREE.InstancedMesh(tileGeo, mats.dark, nDeny)
  allowTiles.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  denyTiles.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  {
    const m4 = new THREE.Matrix4()
    let ai = 0
    let di = 0
    for (let r = 0; r < RBAC_ROWS.length; r++) {
      for (let c = 0; c < VERBS.length; c++) {
        m4.makeTranslation(
          (c - (VERBS.length - 1) / 2) * RBAC_COL_PITCH,
          RBAC_Y0 + r * RBAC_ROW_PITCH,
          RBAC_Z,
        )
        if (RBAC_ALLOW[r] & (1 << c)) allowTiles.setMatrixAt(ai++, m4)
        else denyTiles.setMatrixAt(di++, m4)
      }
    }
  }
  rbacRoot.add(allowTiles, denyTiles)
  const rbacHit = dyn(box(1.7, 1.35, 0.7), 'api', rbacRoot)
  rbacHit.position.z = RBAC_Z + 0.4
  rbacHit.visible = false

  /* ---------------------------------------------------- floor 3: APF seating */

  const apf = floors[3]
  const seatGeo = geo(new THREE.CylinderGeometry(1.5, 1.5, 0.7, 12))
  const seats: THREE.Mesh[] = []
  for (let i = 0; i < SEAT_MAX; i++) {
    const s = dyn(seatGeo, 'dim', apf)
    s.position.set(
      ((i % SEAT_COLS) - (SEAT_COLS - 1) / 2) * SEAT_PITCH,
      0.35,
      6 + (Math.floor(i / SEAT_COLS) - (SEAT_ROWS - 1) / 2) * SEAT_PITCH,
    )
    seats.push(s)
  }
  const shedGeo = geo(new THREE.IcosahedronGeometry(1.1, 0))
  const sheds: THREE.Mesh[] = []
  const shedT = new Float32Array(SHED_MAX).fill(-1)
  const shedV = new Float32Array(SHED_MAX * 3)
  for (let i = 0; i < SHED_MAX; i++) {
    const p = dyn(shedGeo, 'throttled', apf)
    p.visible = false
    sheds.push(p)
    shedV[i * 3] = ctx.rng.range(-9, 9)
    shedV[i * 3 + 1] = ctx.rng.range(7, 11)
    shedV[i * 3 + 2] = -ctx.rng.range(10, 17)
  }

  /* ------------------------------- floors 4 and 6: admission webhook annexes */

  const annexGeo = box(15, 8.5, 15)
  const bridgeGeo = box(13, 0.7, 2.4)
  const beaconGeo = geo(new THREE.ConeGeometry(1.4, 3, 6))
  const pileGeo = box(3.2, 1.7, 3.2)

  function buildAnnexes(floor: THREE.Group, side: number): Annex[] {
    const out: Annex[] = []
    for (let k = 0; k < WEBHOOK_SLOTS; k++) {
      const root = new THREE.Group()
      root.position.set(side * 51, 0, (k - (WEBHOOK_SLOTS - 1) / 2) * 22)
      floor.add(root)

      const shellMesh = dyn(annexGeo, 'dim', root)
      shellMesh.position.y = 4.25
      const beacon = dyn(beaconGeo, 'failed', root)
      beacon.position.y = 10.2
      const bead = dyn(beadGeo, 'api', root)
      bead.position.y = 3.4

      const bridge = mesh(bridgeGeo, 'column', root)
      bridge.position.set(-side * 14, 3.2, 0)

      out.push({ root, shellMesh, beacon, bead, webhook: undefined })
    }
    return out
  }

  function buildPile(floor: THREE.Group, side: number): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (let i = 0; i < PILE_MAX; i++) {
      const b = dyn(pileGeo, 'pending', floor)
      b.position.set(side * 26, 0.9 + i * 1.85, 0)
      b.visible = false
      out.push(b)
    }
    return out
  }

  const mutating = floors[4]
  const validating = floors[6]
  const mutAnnexes = buildAnnexes(mutating, -1)
  const valAnnexes = buildAnnexes(validating, 1)
  const mutPile = buildPile(mutating, -1)
  const valPile = buildPile(validating, 1)

  /* -------------------------------------------- floor 5: schema validation */

  const validation = floors[5]
  const stencilBar = box(18, 0.8, 3)
  const stencil: THREE.Mesh[] = []
  for (let i = 0; i < 4; i++) {
    const b = dyn(stencilBar, 'apiSoft', validation)
    const horizontal = i < 2
    b.position.set(horizontal ? 0 : (i === 2 ? -1 : 1) * 7.5, 4.2, horizontal ? (i ? 1 : -1) * 7.5 : 0)
    b.rotation.y = horizontal ? 0 : Math.PI / 2
    stencil.push(b)
  }
  /* Required-field gauges: the object either clears every pin or it is a 400. */
  const pinGeo = box(0.6, 1, 0.6)
  for (let i = 0; i < 5; i++) {
    const p = mesh(pinGeo, 'api', validation)
    const h = 2 + (i % 3) * 1.4
    p.scale.y = h
    p.position.set((i - 2) * 2.6, h / 2, -12)
  }

  /* ------------------------------------ floor 7: the storage door + cacher */

  const storage = floors[7]
  const doorFrame = dyn(box(16, 9, 1.4), 'etcd', storage)
  doorFrame.position.set(0, 4.5, HD)
  const doorLeaf = dyn(box(14, 8, 0.6), 'raft', storage)
  /* Hinged at the top of the opening so a closed door reads as a sealed hatch. */
  doorLeaf.geometry.translate(0, -4, 0)
  doorLeaf.position.set(0, 8.5, HD - 1)
  /* The jetty out to ANCHOR.apiStorageDoor, where the api-to-etcd route starts. */
  const jetty = mesh(box(6, 0.6, ANCHOR.apiStorageDoor[2] - CITY.api.z - HD + 4), 'column', storage)
  jetty.position.set(0, 0, HD + (ANCHOR.apiStorageDoor[2] - CITY.api.z - HD + 4) / 2 - 2)

  const cacheRoot = new THREE.Group()
  cacheRoot.position.set(0, 1.2, -6)
  storage.add(cacheRoot)
  const ringGeo = geo(new THREE.TorusGeometry(14, 0.35, 6, 48))
  const cacheRing = mesh(ringGeo, 'etcd', cacheRoot)
  cacheRing.rotation.x = -Math.PI / 2
  const markerGeo = box(1.2, 2.4, 2.4)
  const etcdMarker = mesh(markerGeo, 'raft', cacheRoot)
  etcdMarker.position.set(14, 1.2, 0)
  const cacheMarker = dyn(markerGeo, 'etcd', cacheRoot)
  const lagGeo = box(0.7, 1.8, 2.6)
  const lagBars: THREE.Mesh[] = []
  for (let i = 0; i < LAG_BARS; i++) {
    const b = dyn(lagGeo, 'etcd', cacheRoot)
    const a = -(i + 0.5) * (TAU / 48)
    b.position.set(Math.cos(a) * 14, 0.9, Math.sin(a) * 14)
    b.rotation.y = -a
    b.visible = false
    lagBars.push(b)
  }

  /* ------------------------------------------------- floor 8: the response */

  const response = floors[8]
  const pillarGeo = box(2.8, 1, 2.8)
  const pillars: THREE.Mesh[] = []
  const PILLAR_MAT: readonly MatKey[] = ['ready', 'failed', 'failed', 'failed', 'backoff']
  for (let i = 0; i < OUTCOME_KEYS.length; i++) {
    const p = mesh(pillarGeo, PILLAR_MAT[i], response)
    p.position.set((i - 2) * 4.4, 0, 12)
    pillars.push(p)
  }
  const exitLintel = mesh(box(18, 1, 1.4), 'apiSoft', response)
  exitLintel.position.set(0, 7.5, -HD + 1.6)

  /* ------------------------------------------------- crown: watch fan-out */

  const crown = new THREE.Group()
  crown.position.y = API_TOWER_TOP + GAP - 0.3
  group.add(crown)
  const crownDeck = mesh(box(W - 6, 1.2, D - 6), 'slab', crown)
  crownDeck.position.y = 0.6
  const mastGeo = geo(new THREE.CylinderGeometry(0.28, 0.28, 9, 6))
  const masts: THREE.Mesh[] = []
  const streamBeads: THREE.Mesh[] = []
  const mastDir = new Float32Array(WATCH_MASTS * 2)
  for (let i = 0; i < WATCH_MASTS; i++) {
    const a = (i / WATCH_MASTS) * TAU
    mastDir[i * 2] = Math.cos(a)
    mastDir[i * 2 + 1] = Math.sin(a)
    const m = dyn(mastGeo, 'dim', crown)
    m.position.set(mastDir[i * 2] * 26, 5.5, mastDir[i * 2 + 1] * 26)
    masts.push(m)
    const b = dyn(beadGeo, 'api', crown)
    b.visible = false
    streamBeads.push(b)
  }

  /* ------------------------------------------------------ read-only banding */

  const readOnly = new THREE.Group()
  readOnly.visible = false
  group.add(readOnly)
  const bandGeo = box(W + 4, 1.4, 1)
  for (let b = 0; b < 3; b++) {
    const y = 30 + b * 33
    for (let f = 0; f < 4; f++) {
      const m = mesh(bandGeo, 'failed', readOnly)
      m.position.set(f < 2 ? 0 : (f === 2 ? -1 : 1) * (HW + 0.4), y, f < 2 ? (f ? 1 : -1) * (HD + 0.4) : 0)
      m.rotation.y = f < 2 ? 0 : Math.PI / 2
    }
  }
  const roBeacon = mesh(geo(new THREE.ConeGeometry(3.4, 9, 6)), 'failed', readOnly)
  roBeacon.position.y = API_TOWER_TOP + GAP + 6

  /* ----------------------------------------------------------- the carriers */

  const carrierGeo = box(2.4, 2.4, 2.4)
  const carriers: THREE.Mesh[] = []
  for (let i = 0; i < CARRIER_MAX; i++) {
    const c = dyn(carrierGeo, 'api', group)
    c.visible = false
    carriers.push(c)
  }

  /* --------------------------------------------------------------- registry */

  const focusOf = (stage: ApiStage): [number, number, number] => {
    apiFloorPos(stage, _v)
    return [_v.x, _v.y + 8, _v.z - 96]
  }

  ctx.registry.register({
    id: 'api.tower',
    title: 'API server tower',
    district: 'apiserver',
    kubeName: 'kube-apiserver',
    summary:
      'The cluster\'s only door: a REST server over etcd that every other component is a client of.',
    detail: [
      'kube-apiserver serves the Kubernetes API on :6443. It is the only component permitted to talk to etcd, so every read and every write in the cluster passes through this building — kubectl, controllers, the scheduler and every kubelet are all just HTTP clients of it.',
      'It is stateless. All durable truth lives in etcd, which is why you can run three of these behind a load balancer and lose any one of them without losing data.',
      'Each floor is one stage of the handler chain, in the order a request meets them: TLS, authentication, authorization, priority and fairness, mutating admission, schema validation, validating admission, storage, response. A request enters at the crown and sinks. Where it stops is what its status code means.',
    ],
    caveats: [
      'One replica is drawn. Real HA control planes run 3+ identical apiservers behind a load balancer, all writing to the same etcd cluster.',
      'The real handler chain has dozens more filters — panic recovery, request timeout, impersonation, audit, WithRequestInfo, CORS. Nine floors are the ones that change a request\'s outcome.',
      `At most ${CARRIER_MAX} in-flight requests are drawn at once; a busy apiserver carries thousands.`,
    ],
    object: group,
    focus: [0, 96, CITY.api.z - 210],
    keywords: ['apiserver', 'api', 'control plane', '6443', 'rest', 'admission'],
    metrics: (s) => [
      { label: 'requests/sec', value: s.api.requestsPerSec.toFixed(1) },
      { label: 'in flight', value: `${s.api.inflight.length}` },
      { label: 'writable', value: s.api.writable ? 'yes' : 'no — etcd has no quorum' },
      { label: '2xx', value: `${s.api.counts.ok}` },
      { label: '401 unauthorized', value: `${s.api.counts.unauthorized}` },
      { label: '403 forbidden', value: `${s.api.counts.forbidden}` },
      { label: '4xx rejected by admission', value: `${s.api.counts.rejected}` },
      { label: '409 conflict', value: `${s.api.counts.conflict}` },
      { label: '429 shed by APF', value: `${s.api.throttled}` },
      { label: 'watch connections', value: `${s.api.watchConnections}` },
    ],
  })

  const floorEntry = (
    stage: ApiStage,
    title: string,
    kubeName: string | undefined,
    summary: string,
    detail: string[],
    caveats: string[],
    keywords: string[],
    metrics?: (s: SimState) => { label: string; value: string; hint?: string }[],
  ): void => {
    const i = stageIndex(stage)
    ctx.registry.register({
      id: `api.stage.${stage}`,
      title,
      district: 'apiserver',
      kubeName,
      summary,
      detail,
      caveats,
      object: floors[i],
      focus: focusOf(stage),
      keywords,
      metrics,
    })
    ctx.registry.bind(shells[i], ctx.registry.get(`api.stage.${stage}`)!)
  }

  floorEntry(
    'tls',
    '1 · TLS',
    'kube-apiserver --tls-cert-file',
    'The connection is terminated here: the server proves who it is, and the client may offer a certificate.',
    [
      'Everything arrives over TLS on :6443. The apiserver presents its serving certificate; the client validates it against the CA bundle in its kubeconfig. That is the only reason a kubeconfig contains certificate-authority-data.',
      'If the client offers a certificate, it is verified against --client-ca-file here — but being cryptographically valid is not the same as being someone. Turning that certificate into a username and a group list happens on the next floor down.',
      'A failure here is not an HTTP status code at all. The handshake fails and the client sees a transport error, which is why "x509: certificate signed by unknown authority" never appears as a 401.',
    ],
    [
      'Real TLS termination happens in Go\'s HTTP server before any Kubernetes handler runs, so it is not strictly a filter in the chain.',
      'SNI certificates, TLS-terminating load balancers in front of the apiserver, and the aggregation layer\'s requestheader auth are not modelled.',
    ],
    ['tls', 'certificate', 'x509', '6443', 'kubeconfig', 'handshake'],
  )

  floorEntry(
    'authn',
    '2 · Authentication',
    'authentication chain',
    'A chain of authenticators turns the credential into a username, UID and groups. First success wins.',
    [
      'The authenticators run in order and stop at the first one that recognises the credential: x509 client certificate (CN becomes the username, each O becomes a group), a bearer token — usually a projected ServiceAccount JWT validated against the issuer\'s public key — an OIDC id_token, or a token webhook.',
      'The output is only an identity: username, UID, groups and extra fields. Authentication never decides what you may do. That is why a perfectly authenticated user still gets a 403 one floor down.',
      'If no authenticator claims the request, it is 401 Unauthorized. If anonymous authentication is enabled, it instead continues as system:anonymous in the group system:unauthenticated — and then almost always fails authorization.',
    ],
    [
      'Four authenticators are drawn; a real chain is configurable and also includes bootstrap tokens and static token files.',
      'User impersonation (--as / the Impersonate-User header), which re-runs this stage, is not modelled.',
    ],
    ['authn', 'authentication', '401', 'serviceaccount', 'jwt', 'oidc', 'bearer token'],
    (s) => {
      const r = s.api.inflight.find((q) => q.stage === 'authn')
      return [
        { label: 'authenticating', value: r ? r.subject : '—' },
        { label: 'matched authenticator', value: r ? AUTHN_PLATES[authnPlate(r.subject)] : '—' },
        { label: '401 unauthorized', value: `${s.api.counts.unauthorized}` },
      ]
    },
  )

  floorEntry(
    'authz',
    '3 · Authorization',
    'RBAC',
    'Authorizers are asked in order whether this identity may perform this verb on this resource.',
    [
      'The authorizer chain is typically Node, then RBAC, then any webhook authorizer. Each returns allow, deny, or no opinion; the first explicit allow wins and the request continues. If every authorizer abstains, the request is denied.',
      'RBAC itself is purely additive: Roles and ClusterRoles grant, RoleBindings and ClusterRoleBindings attach them to subjects, and there is no such thing as a deny rule. If nothing grants a permission, you do not have it.',
      'A rejection here is 403 Forbidden, and the message names the exact tuple that failed — user, verb, resource, namespace. That message is the fastest RBAC debugging tool there is.',
    ],
    [
      'The Node authorizer, which restricts each kubelet to the objects on its own node, is not drawn as a separate stage.',
      'The wall shows one subject\'s effective permissions as a fixed grid. Real evaluation is per-request across every binding that matches the identity.',
    ],
    ['authz', 'authorization', 'rbac', '403', 'forbidden', 'role', 'clusterrolebinding'],
    (s) => {
      const r = s.api.inflight.find((q) => q.stage === 'authz')
      return [
        { label: 'evaluating', value: r ? `${r.verb} ${r.kind.toLowerCase()}` : '—' },
        { label: 'subject', value: r ? r.subject : '—' },
        { label: '403 forbidden', value: `${s.api.counts.forbidden}` },
      ]
    },
  )

  floorEntry(
    'apf',
    '4 · Priority and fairness',
    'APIPriorityAndFairness',
    'Concurrency is rationed into seats per priority level so one noisy client cannot starve the control plane.',
    [
      'Every request is matched by a FlowSchema to a PriorityLevelConfiguration. Each priority level owns a share of the server\'s total concurrency — its seats. A request needs a free seat to proceed.',
      'When a level is saturated, requests queue, sharded by a flow distinguisher (usually the user or namespace) so one busy client fills its own queue and not everyone else\'s. When its queue is full too, the request is shed with 429 Too Many Requests and a Retry-After header, and a well-behaved client backs off.',
      'This is what protects leader election and node heartbeats from a runaway list-everything loop. The exempt priority level exists precisely so that this protection can never lock out the components that keep the cluster alive.',
    ],
    [
      'One flat seat pool is drawn. Real APF has several priority levels, each with its own queues, shuffle sharding, and hand size.',
      'Expensive list and watch requests occupy more than one seat in reality; here every request takes exactly one.',
      `At most ${SEAT_MAX} seats are drawn.`,
    ],
    ['apf', 'priority', 'fairness', '429', 'throttle', 'flowschema', 'concurrency'],
    (s) => [
      { label: 'seats in use', value: `${s.api.apfSeatsUsed} / ${s.api.apfSeatsTotal}` },
      { label: 'shed with 429', value: `${s.api.throttled}` },
      { label: 'requests/sec', value: s.api.requestsPerSec.toFixed(1) },
    ],
  )

  floorEntry(
    'mutating',
    '5 · Mutating admission',
    'MutatingAdmissionWebhook',
    'Built-in plugins and mutating webhooks may rewrite the object before it is validated.',
    [
      'The built-in mutating plugins run first — ServiceAccount injects the token volume, DefaultStorageClass fills in a storageClassName, LimitRanger applies namespace defaults.',
      'Then each matching MutatingWebhookConfiguration is called over HTTPS with an AdmissionReview and may return a JSONPatch. This is where service meshes inject sidecars and where most "why does my pod have a container I did not ask for" questions end.',
      'failurePolicy decides what an unreachable webhook means. Fail turns every matching request into a 500 — including, if the webhook matches too broadly, the requests that would let you fix it. Ignore silently skips the webhook, which is its own kind of outage.',
    ],
    [
      'Webhooks are called serially with one fixed latency per call. Real calls are made with a timeout (default 10s) and mutating webhooks may be reinvoked after other webhooks change the object.',
      'namespaceSelector, objectSelector and matchConditions are not modelled: here every webhook matches every request on this floor.',
    ],
    ['mutating', 'admission', 'webhook', 'sidecar', 'injection', 'failurepolicy'],
    (s) => [
      {
        label: 'mutating webhooks',
        value: `${s.api.webhooks.filter((w) => w.kind === 'mutating').length}`,
      },
      {
        label: 'unreachable',
        value: `${s.api.webhooks.filter((w) => w.kind === 'mutating' && !w.reachable).length}`,
      },
      { label: 'queued on this floor', value: `${s.api.inflight.filter((r) => r.stage === 'mutating').length}` },
    ],
  )

  floorEntry(
    'validation',
    '6 · Schema validation',
    'registry strategy validation',
    'The apiserver decodes the object, applies defaults, and checks it against the resource\'s own schema.',
    [
      'This is the server\'s own validation, not a webhook: required fields, enum values, quantity formats, immutable fields on update, and for custom resources with a structural schema, pruning of unknown fields.',
      'It runs after mutating admission, which is the ordering that surprises people: a webhook can take a valid object and hand back one the apiserver then rejects with 400 Invalid, naming a field path the user never wrote.',
      'Failures here are terminal and cheap — nothing has been written, no revision has been consumed.',
    ],
    [
      'Drawn as one pass. The real path is decode → conversion to the internal version → defaulting → strategy validation, at several points in the storage layer.',
      'Server-side apply\'s field ownership tracking and dry-run are not modelled.',
    ],
    ['validation', 'schema', 'openapi', '400', 'invalid', 'defaulting', 'pruning'],
  )

  floorEntry(
    'validating',
    '7 · Validating admission',
    'ValidatingAdmissionWebhook',
    'The last chance to say no: webhooks and CEL policies that may reject but never modify.',
    [
      'ValidatingWebhookConfigurations and ValidatingAdmissionPolicies (CEL expressions evaluated in-process, no network call) run here. They may only accept or reject, which is why they can safely be called in parallel.',
      'ResourceQuota admission also runs at the end of this stage, and it is the thing that actually enforces a namespace quota — the quota object itself is only bookkeeping.',
      'A rejection here is a 4xx carrying the webhook\'s own message, and it is the message the user will paste into a ticket. Policy engines like Gatekeeper and Kyverno live on this floor.',
    ],
    [
      'Parallel calls are drawn as sequential ones so the callout is legible.',
      'ValidatingAdmissionPolicy bindings and param resources are not modelled.',
    ],
    ['validating', 'admission', 'webhook', 'policy', 'cel', 'resourcequota', 'gatekeeper'],
    (s) => [
      {
        label: 'validating webhooks',
        value: `${s.api.webhooks.filter((w) => w.kind === 'validating').length}`,
      },
      {
        label: 'unreachable',
        value: `${s.api.webhooks.filter((w) => w.kind === 'validating' && !w.reachable).length}`,
      },
      { label: 'rejected by admission', value: `${s.api.counts.rejected}` },
    ],
  )

  floorEntry(
    'storage',
    '8 · Storage',
    'etcd3 storage backend',
    'The only door to etcd. The object is serialized and written under /registry, guarded by its revision.',
    [
      'The object is encoded — protobuf between the apiserver and etcd, not the JSON you typed — and written to a key shaped like /registry/<resource>/<namespace>/<name>.',
      'A write is a transaction with a precondition on the key\'s mod revision. If someone else wrote the object since you read it, the comparison fails and you get 409 Conflict: re-read, re-apply your change, retry. Every controller in Kubernetes is built around losing that race occasionally.',
      'On success etcd\'s new revision becomes the object\'s resourceVersion. resourceVersion is not a version number you may compare or increment — it is etcd\'s logical clock, and it is the same clock every watcher resumes from.',
      'When etcd loses quorum this door is barred: writes fail, while reads may still be served from the watch cache and quietly go stale.',
    ],
    [
      'Encryption-at-rest providers, per-resource etcd overrides and the delete/finalizer path are not drawn.',
      'The raft mechanics of the write live in the vault below, not on this floor.',
    ],
    ['storage', 'etcd', 'registry', 'resourceversion', 'conflict', '409', 'protobuf'],
    (s) => [
      { label: 'etcd revision', value: `${s.etcd.revision}` },
      { label: 'writable', value: s.api.writable ? 'yes' : 'no — no etcd quorum' },
      { label: '409 conflict', value: `${s.api.counts.conflict}` },
      { label: 'etcd read latency', value: formatMs(s.etcd.readLatencyMs) },
    ],
  )

  floorEntry(
    'response',
    '9 · Response',
    'serialization and watch fan-out',
    'The object is serialized back to the client — and for a watch, the connection stays open and streams.',
    [
      'The result is encoded in whatever the client asked for through Accept: JSON for kubectl, protobuf for in-cluster clients, and a Table for the columns kubectl prints. The audit entry is written here too.',
      'For get, create, update and delete the request now ends. For watch it does not: the connection is held open and every subsequent change to the matching objects is streamed down it as ADDED, MODIFIED or DELETED events. That stream is what makes Kubernetes level-triggered instead of a polling loop.',
      'The five pillars count outcomes: 2xx, 403, 401, admission rejections, and 409 conflicts.',
    ],
    [
      'Rolling counters are drawn on a log scale so a rare 403 stays visible next to thousands of successes.',
      'Audit stages, the metrics endpoint and streaming media types are not drawn.',
    ],
    ['response', 'watch', 'serialization', 'audit', 'protobuf', 'stream'],
    (s) => [
      { label: 'requests/sec', value: s.api.requestsPerSec.toFixed(1) },
      { label: '2xx', value: `${s.api.counts.ok}` },
      { label: '403 / 401', value: `${s.api.counts.forbidden} / ${s.api.counts.unauthorized}` },
      { label: 'rejected', value: `${s.api.counts.rejected}` },
      { label: 'conflict', value: `${s.api.counts.conflict}` },
    ],
  )

  const rbacEntry = ctx.registry.register({
    id: 'api.rbac',
    title: 'RBAC rule wall',
    district: 'apiserver',
    kubeName: 'rbac.authorization.k8s.io',
    summary: 'Columns are verbs, rows are resources. A lit tile is a rule that allows; dark means no rule exists.',
    detail: [
      `Columns, left to right: ${VERBS.join(', ')}. Rows, bottom to top: ${RBAC_ROWS.join(' · ')}.`,
      'A request lights the single cell for its (verb, resource) pair. Green means some Role or ClusterRole bound to this identity grants it. Red means nothing does — and because RBAC has no deny rules, "nothing grants it" is the whole reason for the 403.',
      'The dark rows are the interesting ones. Read-only on secrets and configmaps, and no rule at all on clusterrolebindings: that is deliberate, because a subject that can create ClusterRoleBindings can grant itself everything. The apiserver additionally refuses to let you grant permissions you do not already hold, unless you have the escalate verb.',
      'Note that the node row allows update and patch but not create or delete: that is the shape of a kubelet\'s permission on its own Node object, and it is enforced per-node by the Node authorizer.',
    ],
    caveats: [
      'A real rule also carries apiGroups, resourceNames, subresources (pods/exec is a different resource from pods) and non-resource URLs. None of those axes are drawn.',
      'The grid shows one subject\'s effective permissions. Every identity in the cluster has a different wall.',
    ],
    object: allowTiles,
    focus: [0, apiFloorY('authz') + 6, CITY.api.z - 70],
    keywords: ['rbac', 'role', 'clusterrole', 'rolebinding', 'forbidden', '403', 'escalate'],
    metrics: (s) => {
      const r = s.api.inflight.find((q) => q.stage === 'authz')
      return [
        { label: 'cell under evaluation', value: r ? `${r.verb} ${r.kind.toLowerCase()}` : '—' },
        { label: 'subject', value: r ? r.subject : '—' },
        { label: '403 forbidden', value: `${s.api.counts.forbidden}`, hint: 'since start' },
      ]
    },
  })
  ctx.registry.bind(denyTiles, rbacEntry)
  ctx.registry.bind(rbacHit, rbacEntry)

  const apfEntry = ctx.registry.register({
    id: 'api.apf',
    title: 'APF seats',
    district: 'apiserver',
    kubeName: 'flowcontrol.apiserver.k8s.io',
    summary: 'One seat is one unit of concurrency. No free seat and no queue room means 429.',
    detail: [
      'Each lit seat is a request currently occupying concurrency in its priority level. The pool is finite by design: the apiserver would rather refuse work than fall over, because a control plane that has fallen over cannot be repaired through the API.',
      'A shed request bounces off this floor with 429 Too Many Requests and a Retry-After. That is not an error in the cluster — it is backpressure working, and client-go honours it automatically.',
      'The seat pool is why a single controller with a hot loop listing every pod every second degrades everyone: it holds seats for the duration of each list, and lists are expensive.',
    ],
    caveats: [
      'One flat pool stands in for the real per-priority-level seat allocation.',
      'Real APF charges wide requests more than one seat and adds a second dimension for watch initialization.',
    ],
    object: seats[0],
    focus: focusOf('apf'),
    keywords: ['apf', 'seats', 'concurrency', '429', 'backpressure', 'retry-after'],
    metrics: (s) => [
      { label: 'seats in use', value: `${s.api.apfSeatsUsed} / ${s.api.apfSeatsTotal}` },
      { label: 'utilisation', value: `${Math.round((s.api.apfSeatsUsed / Math.max(1, s.api.apfSeatsTotal)) * 100)}%` },
      { label: 'shed with 429', value: `${s.api.throttled}` },
    ],
  })
  for (let i = 1; i < seats.length; i++) ctx.registry.bind(seats[i], apfEntry)
  for (let i = 0; i < sheds.length; i++) ctx.registry.bind(sheds[i], apfEntry)

  function registerWebhookSlot(kind: 'mutating' | 'validating', slot: number, annex: Annex): void {
    const entry = ctx.registry.register({
      id: `api.webhook.${kind}.${slot}`,
      title: `${kind === 'mutating' ? 'Mutating' : 'Validating'} webhook ${slot + 1}`,
      district: 'apiserver',
      kubeName: kind === 'mutating' ? 'MutatingWebhookConfiguration' : 'ValidatingWebhookConfiguration',
      summary:
        kind === 'mutating'
          ? 'An external HTTPS service the apiserver calls mid-request; it may patch the object.'
          : 'An external HTTPS service the apiserver calls mid-request; it may only accept or reject.',
      detail: [
        'The annex is outside the tower because a webhook is outside the apiserver: it is an ordinary Service, usually backed by pods running in this same cluster. The apiserver POSTs an AdmissionReview to it and blocks on the answer.',
        kind === 'mutating'
          ? 'A mutating webhook answers with allowed plus an optional base64 JSONPatch. Every matching request pays its latency, on the write path, every time.'
          : 'A validating webhook answers allowed true or false with a status message. It cannot change the object, which is why several of them can be called at once.',
        'When the annex goes dark its endpoints are gone. With failurePolicy: Fail the apiserver returns 500 and the requests visibly pile up on the floor; with Ignore the call is skipped and the policy silently stops being enforced. A webhook whose own pods are admitted by that same webhook is the classic way to deadlock a cluster.',
      ],
      caveats: [
        'One fixed latency per call; real webhooks have a timeout (10s default) and are retried on transport errors only.',
        'The AdmissionReview payload, sideEffects and dry-run behaviour are not drawn.',
      ],
      object: annex.root,
      focus: [
        (kind === 'mutating' ? -1 : 1) * 120,
        apiFloorY(kind) + 12,
        CITY.api.z - 60,
      ],
      keywords: ['webhook', 'admission', kind, 'failurepolicy', 'annex'],
      metrics: (s) => {
        let n = 0
        let w: AdmissionWebhook | undefined
        for (let i = 0; i < s.api.webhooks.length; i++) {
          const c = s.api.webhooks[i]
          if (c.kind !== kind) continue
          if (n === slot) w = c
          n++
        }
        if (!w) return [{ label: 'configured', value: 'no webhook in this slot' }]
        return [
          { label: 'name', value: w.name },
          { label: 'added latency', value: formatMs(w.latencyMs), hint: 'paid by every matching request' },
          { label: 'failurePolicy', value: w.failurePolicy },
          {
            label: 'endpoints',
            value: w.reachable ? 'reachable' : 'none — service has no ready endpoints',
          },
          {
            label: 'effect if unreachable',
            value: w.failurePolicy === 'Fail' ? '500 to the client' : 'webhook skipped',
          },
        ]
      },
    })
    ctx.registry.bind(annex.shellMesh, entry)
    ctx.registry.bind(annex.beacon, entry)
  }
  for (let k = 0; k < WEBHOOK_SLOTS; k++) registerWebhookSlot('mutating', k, mutAnnexes[k])
  for (let k = 0; k < WEBHOOK_SLOTS; k++) registerWebhookSlot('validating', k, valAnnexes[k])

  const cacheEntry = ctx.registry.register({
    id: 'api.watch-cache',
    title: 'Watch cache',
    district: 'apiserver',
    kubeName: 'storage cacher',
    summary: 'A per-resource in-memory mirror of etcd, fed by one watch, that serves most reads.',
    detail: [
      'The apiserver keeps one etcd watch per resource type and mirrors the objects in memory. A LIST or GET with resourceVersion="0" — which is what every informer does on startup, and what kubectl does by default — is answered from this ring, not from etcd.',
      'The ring holds a rolling window of recent revisions so a watcher that reconnects can resume exactly where it left off. Ask for a revision older than the window and you get "too old resource version", which is why informers relist and resync.',
      'The arc between the two markers is the cache\'s lag behind etcd, in revisions. A lag that grows means reads are answering with a past that is getting older — the mechanism behind a write that succeeds and a read-back that does not show it.',
      `etcd compacts roughly every ${TIMING.etcdCompactionIntervalSeconds}s, which sets the floor under how far back any watcher may resume.`,
    ],
    caveats: [
      'One ring is drawn for the whole server; the real cacher keeps a separate cache and window per resource type.',
      'Lag is drawn one bar per revision up to 24 bars; beyond that the arc saturates.',
      'Consistent reads (resourceVersion unset) still go to etcd and are not distinguished here.',
    ],
    object: cacheRing,
    focus: [0, apiFloorY('storage') + 14, CITY.api.z - 70],
    keywords: ['watch cache', 'cacher', 'informer', 'resourceversion', 'stale read', 'too old'],
    metrics: (s) => [
      { label: 'etcd revision', value: `${s.etcd.revision}` },
      { label: 'cache revision', value: `${s.api.watchCacheRevision}` },
      {
        label: 'lag',
        value: `${Math.max(0, s.etcd.revision - s.api.watchCacheRevision)} revisions`,
        hint: 'reads served from the cache are this far in the past',
      },
      { label: 'etcd watchers', value: `${s.etcd.watchers}` },
    ],
  })
  ctx.registry.bind(cacheMarker, cacheEntry)
  ctx.registry.bind(etcdMarker, cacheEntry)

  const streamEntry = ctx.registry.register({
    id: 'api.watch-streams',
    title: 'Watch fan-out',
    district: 'apiserver',
    kubeName: 'watch connections',
    summary: 'Long-lived streams leaving the crown: every controller, scheduler and kubelet is holding one open.',
    detail: [
      'These are not polls. Each stream is an HTTP/2 connection held open for hours, over which the apiserver pushes ADDED, MODIFIED and DELETED events as objects change. A client sends one LIST to get a starting state and a resourceVersion, then watches from there forever.',
      'This is the mechanism behind level-triggered reconciliation: a controller is not told "scale up", it is told "this object changed" and then re-derives everything from the object it now holds. Missing an event is survivable; the next resync repairs it.',
      'Every watcher of a resource is woken by the same write, which is why a single write to a Deployment can visibly move the whole city at once.',
    ],
    caveats: [
      'Mast count is a coarse scale, not one mast per connection.',
      'Bookmarks, chunked list continuation and per-resource stream multiplexing are not drawn.',
    ],
    object: crown,
    focus: [0, API_TOWER_TOP + 40, CITY.api.z - 130],
    keywords: ['watch', 'informer', 'stream', 'event', 'level-triggered', 'fan-out'],
    metrics: (s) => [
      { label: 'watch connections', value: `${s.api.watchConnections}` },
      { label: 'etcd watchers', value: `${s.etcd.watchers}` },
      { label: 'cache revision', value: `${s.api.watchCacheRevision}` },
    ],
  })
  for (let i = 0; i < masts.length; i++) ctx.registry.bind(masts[i], streamEntry)

  /* ------------------------------------------------------------ theme flips */

  const offTheme = ctx.bus.on('theme', () => {
    /* setMode() disposed every cached material; re-point the static meshes at
     * the rebuilt palette. Dynamic meshes re-read `mats` on the next frame. */
    mats = buildMats()
    for (let i = 0; i < statics.length; i++) statics[i].o.material = mats[statics[i].k]
    allowTiles.material = mats.ready
    denyTiles.material = mats.dark
  })

  /* ----------------------------------------------------------------- update */

  const stageCount = new Int32Array(N_STAGES)
  const stageActive: (ApiRequest | null)[] = new Array(N_STAGES).fill(null)
  let prevThrottled = -1
  let doorOpen = 1

  function update(s: SimState, dt: number): void {
    const api = s.api
    const t = s.t

    stageCount.fill(0)
    for (let i = 0; i < N_STAGES; i++) stageActive[i] = null
    for (let i = 0; i < api.inflight.length; i++) {
      const r = api.inflight[i]
      const si = stageIndex(r.stage)
      if (si < 0) continue
      stageCount[si]++
      if (stageActive[si] === null || r.outcome !== 'inflight') stageActive[si] = r
    }

    /* --- read-only: writes cannot reach etcd, and the building must say so. */
    const ro = !api.writable
    readOnly.visible = ro
    const shellMat = ro ? mats.shellReadOnly : mats.shell
    for (let i = 0; i < shells.length; i++) shells[i].material = shellMat

    /* --- TLS floor. */
    const tlsReq = stageActive[0]
    handshake.visible = tlsReq !== null
    if (tlsReq) {
      handshake.position.x = Math.sin(t * 6) * 6.5
      handshake.material = outcomeMat(mats, tlsReq, t)
      clientCert.material = mats.api
    } else {
      clientCert.material = mats.dim
    }

    /* --- authn floor: the chain lights the authenticator that claimed it. */
    const authnReq = stageActive[1]
    const lit = authnReq ? authnPlate(authnReq.subject) : -1
    for (let i = 0; i < authnPlates.length; i++) {
      authnPlates[i].material = i === lit ? mats.api : mats.dim
    }
    authnDeny.visible = authnReq !== null && authnReq.outcome === 'unauthorized'
    if (authnDeny.visible) authnDeny.material = Math.sin(t * 18) > 0 ? mats.failedBright : mats.failed

    /* --- authz floor: land the highlight on the exact rule cell. */
    const authzReq = stageActive[2]
    let hitRow = -1
    let hitCol = -1
    if (authzReq) {
      hitRow = rbacRow(authzReq.kind)
      hitCol = VERBS.indexOf(authzReq.verb)
    }
    if (hitRow >= 0 && hitCol >= 0) {
      rbacHit.visible = true
      rbacHit.position.x = (hitCol - (VERBS.length - 1) / 2) * RBAC_COL_PITCH
      rbacHit.position.y = RBAC_Y0 + hitRow * RBAC_ROW_PITCH
      const allowed = (RBAC_ALLOW[hitRow] & (1 << hitCol)) !== 0
      rbacHit.material = allowed ? mats.ready : Math.sin(t * 18) > 0 ? mats.failedBright : mats.failed
    } else {
      rbacHit.visible = false
    }

    /* --- APF floor: seats, then the 429 pucks bouncing off. */
    const total = clamp(api.apfSeatsTotal, 0, SEAT_MAX)
    const used = clamp(api.apfSeatsUsed, 0, total)
    for (let i = 0; i < SEAT_MAX; i++) {
      const seat = seats[i]
      const on = i < total
      seat.visible = on
      if (on) seat.material = i < used ? mats.api : mats.dim
    }
    if (prevThrottled < 0) prevThrottled = api.throttled
    let toShed = api.throttled - prevThrottled
    prevThrottled = api.throttled
    for (let i = 0; i < SHED_MAX; i++) {
      if (toShed > 0 && shedT[i] < 0) {
        shedT[i] = 0
        toShed--
      }
      if (shedT[i] < 0) {
        sheds[i].visible = false
        continue
      }
      const st = (shedT[i] += dt)
      const p = sheds[i]
      p.visible = true
      p.position.set(
        shedV[i * 3] * st,
        1 + shedV[i * 3 + 1] * st - 9 * st * st,
        -8 + shedV[i * 3 + 2] * st,
      )
      p.material = mats.throttled
      if (st > 2.2 || p.position.y < -GAP) shedT[i] = -1
    }

    /* --- admission annexes. A dark annex is a service with no endpoints. */
    updateAnnexes(mutAnnexes, 'mutating', s, t)
    updateAnnexes(valAnnexes, 'validating', s, t)
    updatePile(mutPile, stageCount[4])
    updatePile(valPile, stageCount[6])

    /* --- schema validation: the stencil reddens when it is rejecting. */
    const valReq = stageActive[5]
    const stencilMat =
      valReq && valReq.outcome !== 'inflight' && valReq.outcome !== 'ok' ? mats.failed : mats.apiSoft
    for (let i = 0; i < stencil.length; i++) stencil[i].material = stencilMat

    /* --- storage floor: the door, and the cache's lag behind etcd. */
    doorOpen = approach(doorOpen, ro ? 0 : 1, 6, dt)
    doorLeaf.rotation.x = -doorOpen * 1.45
    doorLeaf.material = ro ? mats.failed : mats.raft
    doorFrame.material = ro ? mats.failed : mats.etcd

    const lag = Math.max(0, s.etcd.revision - api.watchCacheRevision)
    const lagMat = lag > 12 ? mats.failed : lag > 3 ? mats.pending : mats.etcd
    const shown = lag < LAG_BARS ? lag : LAG_BARS
    for (let i = 0; i < LAG_BARS; i++) {
      const b = lagBars[i]
      const on = i < shown
      b.visible = on
      if (on) b.material = lagMat
    }
    const ca = -shown * (TAU / 48)
    cacheMarker.position.set(Math.cos(ca) * 14, 1.2, Math.sin(ca) * 14)
    cacheMarker.rotation.y = -ca
    cacheMarker.material = lagMat

    /* --- response floor: outcome pillars, log-scaled. */
    for (let i = 0; i < OUTCOME_KEYS.length; i++) {
      const c = api.counts[OUTCOME_KEYS[i]]
      const h = clamp(Math.log1p(c) * 1.5, 0.2, 8)
      pillars[i].scale.y = h
      pillars[i].position.y = h / 2
    }

    /* --- crown: one mast per slice of the watch connections. */
    const litMasts = clamp(Math.round(api.watchConnections / 5), 0, WATCH_MASTS)
    for (let i = 0; i < WATCH_MASTS; i++) {
      masts[i].material = i < litMasts ? mats.api : mats.dim
      const b = streamBeads[i]
      if (i >= litMasts) {
        b.visible = false
        continue
      }
      b.visible = true
      const f = (t * 0.4 + i / WATCH_MASTS) % 1
      const r = 26 + f * 64
      b.position.set(mastDir[i * 2] * r, 9 - f * 34, mastDir[i * 2 + 1] * r)
      b.material = mats.api
    }

    /* --- the carriers themselves: a request is a thing with a position. */
    const n = api.inflight.length < CARRIER_MAX ? api.inflight.length : CARRIER_MAX
    for (let i = 0; i < CARRIER_MAX; i++) {
      const c = carriers[i]
      if (i >= n) {
        c.visible = false
        continue
      }
      const r = api.inflight[i]
      const si = stageIndex(r.stage)
      if (si < 0) {
        c.visible = false
        continue
      }
      c.visible = true
      const h = hash32(r.id)
      const a = ((h & 7) / 8) * TAU
      const rad = 9 + ((h >>> 3) & 3) * 3
      const floorTop = apiFloorY(r.stage) + 2.4
      const stopped = r.outcome !== 'inflight' && r.outcome !== 'ok'

      let x = Math.cos(a) * rad
      let z = Math.sin(a) * rad
      let y = floorTop

      if (stopped) {
        /* Stop on the floor that rejected it — and at authz, beside the cell. */
        if (si === 2 && hitRow >= 0 && hitCol >= 0 && r === authzReq) {
          x = (hitCol - (VERBS.length - 1) / 2) * RBAC_COL_PITCH
          z = RBAC_Z + 4
          y = floorTop + hitRow * RBAC_ROW_PITCH * 0.5
        }
        const pulse = 1 + 0.3 * Math.sin(t * 14)
        c.scale.setScalar(pulse)
      } else {
        c.scale.setScalar(1)
        if (si === N_STAGES - 1) {
          /* The response leaves northward, back out through the front door. */
          z = -r.progress * 70 + Math.sin(a) * rad * (1 - r.progress)
          x *= 1 - r.progress
        } else {
          y = floorTop - r.progress * GAP
        }
      }
      c.position.set(x, y, z)
      c.material = outcomeMat(mats, r, t)
    }
  }

  function updateAnnexes(list: Annex[], kind: 'mutating' | 'validating', s: SimState, t: number): void {
    let n = 0
    for (let i = 0; i < list.length; i++) list[i].webhook = undefined
    for (let i = 0; i < s.api.webhooks.length; i++) {
      const w = s.api.webhooks[i]
      if (w.kind !== kind) continue
      if (n < list.length) list[n].webhook = w
      n++
    }
    const active = stageActive[stageIndex(kind)]
    const configured = n < list.length ? n : list.length
    for (let k = 0; k < list.length; k++) {
      const an = list[k]
      const w = an.webhook
      an.root.visible = w !== undefined
      if (!w) continue
      an.shellMesh.material = w.reachable ? mats.dim : mats.dark
      an.beacon.visible = !w.reachable
      if (!w.reachable) {
        an.beacon.material = Math.sin(t * 12) > 0 ? mats.failedBright : mats.failed
      }
      /* Webhooks are called in order: slot k owns its share of the stage's
       * progress, so the callout you see is the one currently blocking. */
      let show = false
      if (active && active.outcome === 'inflight' && w.reachable && configured > 0) {
        const local = active.progress * configured - k
        if (local > 0 && local < 1) {
          show = true
          const outAndBack = local < 0.5 ? local * 2 : (1 - local) * 2
          an.bead.position.x = -(1 - outAndBack) * 13
          an.bead.position.y = 3.4 + Math.sin(outAndBack * Math.PI) * 1.6
        }
      }
      an.bead.visible = show
      if (show) an.bead.material = mats.api
    }
  }

  function updatePile(pile: THREE.Mesh[], waiting: number): void {
    /* One block per request parked behind the callout, minus the one in it. */
    const stacked = clamp(waiting - 1, 0, PILE_MAX)
    for (let i = 0; i < pile.length; i++) {
      const on = i < stacked
      pile[i].visible = on
      if (on) pile[i].material = i >= PILE_MAX - 2 ? mats.failed : mats.pending
    }
  }

  function dispose(): void {
    offTheme()
    allowTiles.dispose()
    denyTiles.dispose()
    for (let i = 0; i < geoms.length; i++) geoms[i].dispose()
    geoms.length = 0
    group.removeFromParent()
  }

  return { group, update, dispose }
}
