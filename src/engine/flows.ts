import * as THREE from 'three'
import type { SimState } from '../core/types'
import { COLOR, getMode, neon } from '../core/theme'
import type { ThemeMode } from '../core/theme'
import { formatMs, formatPercent } from '../core/util'
import { ROUTES, routeCurve } from '../world/layout'
import type { RouteDef, RouteId } from '../world/layout'
import type { WorldCtx, WorldModule } from '../world/module'

/* ============================================================================
 * FLOWS — what actually travels between districts.
 *
 * Every glyph on these roads is a claim about a mechanism, so nothing here is
 * ambient. A road is busy because the simulation says that traffic exists:
 * request roads carry the API server's measured request rate, split by the mix
 * of subjects currently in the pipeline; the raft road emits one glyph per etcd
 * revision bump; the image road runs only while a kubelet is pulling.
 *
 * The watch fan-out is causal rather than rate-matched, because that causality
 * *is* the lesson. A committed write in etcd produces one watch event back to
 * the API server, and the arrival of that event lights every informer road at
 * the same instant. Lose quorum and the proposals still arrive at the vault —
 * they simply never commit, so nothing ever comes back and the city goes quiet.
 * That silence is the correct picture of a control plane with no quorum.
 * ==========================================================================*/

export interface Flows extends WorldModule {
  setVisible(v: boolean): void
}

type FlowKind = RouteDef['kind']

/* Sampling resolution of a route. Sampled by arc length, so a particle moving
 * at constant du/dt moves at constant metres per second. */
const SEG = 96

/* Model scaling. Disclosed in every Explainer's caveats. */
const REQ_PER_GLYPH = 4
const RPS_PER_GLYPH = 12
const PULL_GLYPHS_PER_SEC = 3
const CSI_GLYPHS_PER_SEC = 2
/** A write attempted while the cluster has no quorum: it leaves and never commits. */
const STALLED_WRITE_RATE = 0.7
/** No road may exceed this, whatever the cluster is doing. Readability is a feature. */
const MAX_RATE = 22
/** Spawn backlog ceilings, so a pause or a tab switch cannot burst on resume. */
const MAX_PENDING = 8
const MAX_SPAWN_PER_FRAME = 6

/* Per-kind constants. Colour is the mechanism's colour from the palette; watch
 * is cyan because a watch stream carries desired state, the same thing the
 * ghosts elsewhere in the city are made of. */
interface KindSpec {
  color: number
  glow: number
  cap: number
  /** Metres per second along the route. */
  speed: number
}

const KINDS: readonly FlowKind[] = [
  'request',
  'watch',
  'raft',
  'bind',
  'image',
  'volume',
  'traffic',
] as const

const KIND_SPEC: Record<FlowKind, KindSpec> = {
  request: { color: COLOR.api, glow: 1.7, cap: 128, speed: 240 },
  watch: { color: COLOR.desired, glow: 2.1, cap: 224, speed: 330 },
  raft: { color: COLOR.raft, glow: 1.9, cap: 48, speed: 190 },
  bind: { color: COLOR.scheduler, glow: 2.2, cap: 24, speed: 300 },
  image: { color: COLOR.image, glow: 1.4, cap: 96, speed: 130 },
  volume: { color: COLOR.storage, glow: 1.5, cap: 48, speed: 120 },
  traffic: { color: COLOR.traffic, glow: 1.6, cap: 224, speed: 260 },
}

/* One glyph per kind, built once. Each is authored pointing down +Z so a single
 * quaternion from the route tangent orients it. */
function makeGlyph(kind: FlowKind): THREE.BufferGeometry {
  switch (kind) {
    case 'request':
      return new THREE.OctahedronGeometry(2.3, 0)
    case 'watch':
      /* A ring, normal along travel: a wavefront leaving the tower. */
      return new THREE.TorusGeometry(2.4, 0.55, 3, 12)
    case 'raft':
      /* A log entry is a record: a flat slab, not a spark. */
      return new THREE.BoxGeometry(4.4, 1.3, 2.4)
    case 'bind': {
      const g = new THREE.ConeGeometry(2.2, 6.2, 4)
      g.rotateX(Math.PI / 2)
      return g
    }
    case 'image':
      /* An image layer: a wide, thin plate. */
      return new THREE.BoxGeometry(5.4, 1.1, 4.2)
    case 'volume': {
      const g = new THREE.CylinderGeometry(1.5, 1.5, 4.8, 6)
      g.rotateX(Math.PI / 2)
      return g
    }
    case 'traffic':
      return new THREE.BoxGeometry(1.7, 1.3, 5.0)
  }
}

/* --------------------------------------------------------------------------
 * Frame-loop scratch. Hoisted: update() must allocate nothing.
 * ------------------------------------------------------------------------*/
const _pos = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _m4 = new THREE.Matrix4()
const FORWARD = new THREE.Vector3(0, 0, 1)

interface RouteRun {
  id: RouteId
  kind: FlowKind
  bucket: number
  /** Arc-length-uniform samples, (SEG + 1) * 3 floats. */
  pts: Float32Array
  len: number
  accum: number
  rate: number
}

interface Bucket {
  kind: FlowKind
  mesh: THREE.InstancedMesh
  geo: THREE.BufferGeometry
  cap: number
  count: number
  route: Int32Array
  u: Float32Array
  speed: Float32Array
}

function sampleAt(r: RouteRun, u: number, pos: THREE.Vector3, dir: THREE.Vector3): void {
  const f = u * SEG
  let i = Math.floor(f)
  if (i < 0) i = 0
  if (i > SEG - 1) i = SEG - 1
  const t = f - i
  const p = r.pts
  const a = i * 3
  const b = a + 3
  const ax = p[a]
  const ay = p[a + 1]
  const az = p[a + 2]
  const dx = p[b] - ax
  const dy = p[b + 1] - ay
  const dz = p[b + 2] - az
  pos.set(ax + dx * t, ay + dy * t, az + dz * t)
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (l > 1e-6) dir.set(dx / l, dy / l, dz / l)
  else dir.set(0, 0, 1)
}

export function createFlows(ctx: WorldCtx): Flows {
  const group = new THREE.Group()
  group.name = 'flows'

  /* ------------------------------------------------------------------------
   * Routes, sampled once. routeCurve() builds a CatmullRom through the polyline
   * in layout.ts; getPointAt() is arc-length parameterised, so uniform u here
   * means uniform metres later.
   * ----------------------------------------------------------------------*/
  const routes: RouteRun[] = []
  const byId = new Map<RouteId, number>()

  for (let i = 0; i < ROUTES.length; i++) {
    const def = ROUTES[i]
    const curve = routeCurve(def.id)
    const pts = new Float32Array((SEG + 1) * 3)
    const tmp = new THREE.Vector3()
    for (let k = 0; k <= SEG; k++) {
      curve.getPointAt(k / SEG, tmp)
      pts[k * 3] = tmp.x
      pts[k * 3 + 1] = tmp.y
      pts[k * 3 + 2] = tmp.z
    }
    routes.push({
      id: def.id,
      kind: def.kind,
      bucket: KINDS.indexOf(def.kind),
      pts,
      len: Math.max(1, curve.getLength()),
      accum: 0,
      rate: 0,
    })
    byId.set(def.id, i)
  }

  /* Route indices captured once: the frame loop must not do map lookups. */
  const R_CLIENT = byId.get('client-to-api')!
  const R_NODES_API = byId.get('nodes-to-api')!
  const R_CTRL_API = byId.get('controllers-to-api')!
  const R_SCHED_API = byId.get('scheduler-to-api')!
  const R_API_ETCD = byId.get('api-to-etcd')!
  const R_ETCD_API = byId.get('etcd-to-api')!
  const R_API_SCHED = byId.get('api-to-scheduler')!
  const R_API_CTRL = byId.get('api-to-controllers')!
  const R_API_NODES = byId.get('api-to-nodes')!
  const R_REGISTRY = byId.get('registry-to-nodes')!
  const R_STORAGE = byId.get('storage-to-nodes')!
  const R_INGRESS = byId.get('ingress-to-nodes')!
  const R_EXTERNAL = byId.get('external-to-ingress')!

  /* ------------------------------------------------------------------------
   * One InstancedMesh per kind: one geometry, one material, one draw call.
   * ----------------------------------------------------------------------*/
  const buckets: Bucket[] = []
  for (let k = 0; k < KINDS.length; k++) {
    const kind = KINDS[k]
    const spec = KIND_SPEC[kind]
    const geo = makeGlyph(kind)
    const mesh = new THREE.InstancedMesh(geo, neon(spec.color, spec.glow), spec.cap)
    mesh.name = `flows:${kind}`
    mesh.count = 0
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    /* Instances cover the whole city; the mesh's own bounds are meaningless. */
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = false
    group.add(mesh)
    buckets.push({
      kind,
      mesh,
      geo,
      cap: spec.cap,
      count: 0,
      route: new Int32Array(spec.cap),
      u: new Float32Array(spec.cap),
      speed: new Float32Array(spec.cap),
    })
  }

  /* A marker at each kind's midpoint gives the inspector and the labels an
   * anchor: an InstancedMesh sits at the origin however far its instances fly. */
  const markers: THREE.Object3D[] = []
  for (let k = 0; k < KINDS.length; k++) {
    const kind = KINDS[k]
    let ri = -1
    for (let i = 0; i < routes.length; i++) {
      if (routes[i].kind === kind) {
        ri = i
        break
      }
    }
    const m = new THREE.Object3D()
    if (ri >= 0) {
      sampleAt(routes[ri], 0.5, _pos, _dir)
      m.position.copy(_pos)
    }
    m.name = `flows:${kind}:anchor`
    group.add(m)
    markers.push(m)
  }

  /* ------------------------------------------------------------------------
   * Particle pool. Spawning is O(1) and death is a swap-remove, so no index in
   * the live range is ever a hole and the instance range stays contiguous.
   * ----------------------------------------------------------------------*/
  let etcdSpeedFactor = 1

  function spawn(routeIdx: number): void {
    const r = routes[routeIdx]
    const b = buckets[r.bucket]
    if (b.count >= b.cap) return
    const i = b.count++
    b.route[i] = routeIdx
    b.u[i] = 0
    b.speed[i] = r.kind === 'raft' ? KIND_SPEC.raft.speed * etcdSpeedFactor : KIND_SPEC[r.kind].speed
  }

  function drain(routeIdx: number, dt: number): void {
    const r = routes[routeIdx]
    if (r.rate <= 0) {
      /* Never carry a backlog across an idle period. */
      if (r.accum > 1) r.accum = 1
      return
    }
    r.accum += r.rate * dt
    let n = 0
    while (r.accum >= 1 && n < MAX_SPAWN_PER_FRAME) {
      r.accum -= 1
      spawn(routeIdx)
      n++
    }
    if (r.accum > MAX_PENDING) r.accum = MAX_PENDING
  }

  /* ------------------------------------------------------------------------
   * Rates. Every one of these reads SimState; none is a constant hum.
   * ----------------------------------------------------------------------*/
  let prevRevision = -1
  let prevScheduled = -1
  let pendingCommit = 0
  let pendingFanout = 0
  let pendingBind = 0
  let pendingRaft = 0

  /* Subject mix of the requests currently inside the pipeline. It decides how
   * the API server's single requests-per-second figure is split between the
   * four roads that arrive at the tower. */
  function computeRates(s: SimState): void {
    let mixClient = 0
    let mixNode = 0
    let mixCtrl = 0
    let mixSched = 0
    const inflight = s.api?.inflight
    if (inflight) {
      for (let i = 0; i < inflight.length; i++) {
        const subject = inflight[i].subject
        if (subject.startsWith('system:node:') || subject.startsWith('system:serviceaccount:')) mixNode++
        else if (subject === 'system:kube-controller-manager') mixCtrl++
        else if (subject === 'system:kube-scheduler') mixSched++
        else mixClient++
      }
    }
    let total = mixClient + mixNode + mixCtrl + mixSched
    if (total === 0) {
      /* Nothing in the pipeline this instant: fall back to the steady-state mix
       * of a quiet cluster, which is dominated by kubelet status and Leases. */
      mixClient = 1
      mixNode = 5
      mixCtrl = 3
      mixSched = 1
      total = 10
    }

    const rps = s.api?.requestsPerSec ?? 0
    const perGlyph = rps / (REQ_PER_GLYPH * total)
    routes[R_CLIENT].rate = Math.min(MAX_RATE, perGlyph * mixClient)
    routes[R_NODES_API].rate = Math.min(MAX_RATE, perGlyph * mixNode)
    routes[R_CTRL_API].rate = Math.min(MAX_RATE, perGlyph * mixCtrl)

    /* The bind road carries bindings, not the scheduler's reads: one arrowhead
     * is one successful binding, counted from the scheduler's own total. */
    routes[R_SCHED_API].rate = 0
    const scheduled = s.scheduler?.scheduled ?? 0
    if (prevScheduled < 0) prevScheduled = scheduled
    if (scheduled > prevScheduled) {
      pendingBind = Math.min(MAX_PENDING, pendingBind + (scheduled - prevScheduled))
      prevScheduled = scheduled
    } else if (scheduled < prevScheduled) {
      prevScheduled = scheduled
    }

    /* One raft glyph per revision bump: the revision is bumped once per
     * committed write and never resets, so this is an exact count. */
    routes[R_API_ETCD].rate = 0
    const etcd = s.etcd
    const revision = etcd?.revision ?? 0
    if (prevRevision < 0) prevRevision = revision
    const hasQuorum = etcd ? etcd.hasQuorum : true
    if (revision > prevRevision) {
      pendingRaft = Math.min(MAX_PENDING, pendingRaft + (revision - prevRevision))
      prevRevision = revision
    } else if (revision < prevRevision) {
      prevRevision = revision
    }
    if (!hasQuorum) {
      /* Writes are still attempted with no quorum. They arrive and hang. */
      routes[R_API_ETCD].rate = STALLED_WRITE_RATE
    }

    /* The fan-out is causal, not rated. */
    routes[R_ETCD_API].rate = 0
    routes[R_API_SCHED].rate = 0
    routes[R_API_CTRL].rate = 0
    routes[R_API_NODES].rate = 0

    /* Image layers move only while a kubelet's sync loop is in the pull phase,
     * and they never touch the API server. */
    let pulling = 0
    const nodes = s.nodes
    if (nodes) {
      for (let i = 0; i < nodes.length; i++) if (nodes[i].kubelet?.phase === 'pulling') pulling++
    }
    routes[R_REGISTRY].rate = Math.min(MAX_RATE, pulling * PULL_GLYPHS_PER_SEC)

    let csi = 0
    const ops = s.csiOps
    if (ops) {
      for (let i = 0; i < ops.length; i++) if (!ops[i].failed && ops[i].progress < 1) csi++
    }
    routes[R_STORAGE].rate = Math.min(MAX_RATE, csi * CSI_GLYPHS_PER_SEC)

    let extRps = 0
    let servedRps = 0
    const ing = s.ingresses
    if (ing) {
      for (let i = 0; i < ing.length; i++) {
        extRps += ing[i].rps
        servedRps += ing[i].rps * (1 - Math.min(1, Math.max(0, ing[i].errorRate)))
      }
    }
    routes[R_EXTERNAL].rate = Math.min(MAX_RATE, extRps / RPS_PER_GLYPH)
    routes[R_INGRESS].rate = Math.min(MAX_RATE, servedRps / RPS_PER_GLYPH)

    /* Disk latency is what etcd's health actually is: a proposal cannot commit
     * faster than the slowest member of the quorum can fsync it. */
    const fsync = s.knobs?.etcdFsyncMs ?? 3
    etcdSpeedFactor = Math.min(1, 3 / Math.max(3, fsync))
  }

  /** A glyph reaching the end of its road is an event, not a disappearance. */
  function onArrive(routeIdx: number, hasQuorum: boolean): void {
    if (routeIdx === R_API_ETCD) {
      /* The proposal reached the leader. With no quorum it never commits, so
       * no watch event is ever produced and the city stays silent. */
      if (hasQuorum && pendingCommit < MAX_PENDING) pendingCommit++
    } else if (routeIdx === R_ETCD_API) {
      if (pendingFanout < MAX_PENDING) pendingFanout++
    }
  }

  /* ------------------------------------------------------------------------
   * Explainers. A road with no entry would be decoration.
   * ----------------------------------------------------------------------*/
  const Rg = ctx.registry

  function focusOf(k: number, dy: number, dz: number): [number, number, number] {
    const p = markers[k].position
    return [p.x + 90, p.y + dy, p.z + dz]
  }

  const iRequest = KINDS.indexOf('request')
  Rg.bind(
    buckets[iRequest].mesh,
    Rg.register({
      id: 'flow.request',
      title: 'API request',
      district: 'apiserver',
      kubeName: 'kube-apiserver (HTTPS :6443)',
      object: markers[iRequest],
      focus: focusOf(iRequest, 70, 90),
      summary:
        'Every arrow anyone draws between Kubernetes components is one of these: an HTTPS request to the API server. Components never talk to each other directly.',
      detail: [
        'kubectl, every controller, every scheduler and every kubelet speaks to the same endpoint over TLS. There is no message bus, no peer-to-peer RPC and no back channel, and the pipeline behind the door — authentication, authorization, API Priority and Fairness, mutating admission, schema validation, validating admission, storage — runs identically whoever is asking.',
        'The glyph rate on each approach road is the API server\'s measured requests per second, split by the subject mix of the requests currently in the pipeline: `kubernetes-admin` from the client terminal, `system:kube-controller-manager` from the yard, `system:node:<name>` and `system:serviceaccount:<ns>:<sa>` from the node blocks.',
        'Most of that traffic is not writes. A controller in steady state holds a watch stream open and occasionally PATCHes a status; a kubelet renews its Lease every 10 seconds and PATCHes pod status when something changes. Reads that can be served from the watch cache never reach etcd at all.',
      ],
      caveats: [
        'One glyph stands for about four requests, so the roads stay readable at a few hundred requests per second.',
        'Travel time is a visual delay, not a measurement. A real in-cluster API call completes in single-digit milliseconds.',
        'The split between roads comes from the mix of requests in flight this instant, not from a per-subject rate counter.',
      ],
      keywords: ['api', 'request', 'https', '6443', 'kubectl', 'client', 'rest'],
      metrics: (s) => [
        { label: 'requests/s', value: (s.api?.requestsPerSec ?? 0).toFixed(1) },
        { label: 'in flight', value: String(s.api?.inflight?.length ?? 0) },
        {
          label: 'APF seats',
          value: `${s.api?.apfSeatsUsed ?? 0} / ${s.api?.apfSeatsTotal ?? 0}`,
          hint: 'API Priority and Fairness: concurrency shares in use',
        },
        { label: 'throttled (429)', value: String(s.api?.throttled ?? 0) },
        { label: 'writable', value: s.api?.writable ? 'yes' : 'no — etcd has no quorum' },
      ],
    }),
  )

  const iWatch = KINDS.indexOf('watch')
  Rg.bind(
    buckets[iWatch].mesh,
    Rg.register({
      id: 'flow.watch',
      title: 'The watch fan-out',
      district: 'apiserver',
      kubeName: 'GET /api/v1/pods?watch=true',
      object: markers[iWatch],
      focus: focusOf(iWatch, 110, 140),
      summary:
        'One committed write, and every informer that cares wakes at the same instant. This single mechanism is what the rest of Kubernetes is built out of.',
      detail: [
        'A controller does not poll and it is not called. It opens one long-lived request — `GET /api/v1/pods?watch=true&resourceVersion=…` — and the API server pushes ADDED, MODIFIED and DELETED events down it forever. An informer consumes that stream, keeps a local cache of the objects, and puts the changed key into a rate-limited workqueue.',
        'Because the cache holds the objects and the queue holds only keys, a controller never asks "what happened?". It asks "what does this key look like now, and what should it look like?" — that is what level-triggered means, and it is why a controller that misses an event still converges: the informer periodically re-lists, and the diff is recomputed from scratch.',
        'What you are watching is one etcd commit becoming a cyan pulse on every road out of the tower at once: to the scheduler, to the controller yard, to the kubelets. They are not queued behind one another. The API server serves watches from an in-memory watch cache, so a thousand watchers cost one read of etcd rather than a thousand.',
      ],
      caveats: [
        'Watch glyphs are cyan — the colour this city uses for desired state — because that is what the stream carries: the record, not the thing.',
        'A kubelet watches with `spec.nodeName=<its own node>`, so it does not in fact wake for every write. The single road to the node grid stands in for one filtered stream per node.',
        'The API server\'s watch cache trails etcd by a little; the model advances `watchCacheRevision` toward the etcd revision instead of delivering at the instant of commit.',
      ],
      keywords: ['watch', 'informer', 'fan-out', 'event', 'level-triggered', 'workqueue', 'resourceVersion'],
      metrics: (s) => [
        { label: 'watch connections', value: String(s.api?.watchConnections ?? 0) },
        { label: 'watch cache rev', value: String(s.api?.watchCacheRevision ?? 0) },
        { label: 'etcd revision', value: String(s.etcd?.revision ?? 0) },
        {
          label: 'cache lag',
          value: String(Math.max(0, (s.etcd?.revision ?? 0) - (s.api?.watchCacheRevision ?? 0))),
          hint: 'revisions the watch cache is behind etcd',
        },
        { label: 'etcd watchers', value: String(s.etcd?.watchers ?? 0) },
      ],
    }),
  )

  const iRaft = KINDS.indexOf('raft')
  Rg.bind(
    buckets[iRaft].mesh,
    Rg.register({
      id: 'flow.raft',
      title: 'Raft proposal',
      district: 'etcd',
      kubeName: 'etcd (the API server\'s only backend)',
      object: markers[iRaft],
      focus: focusOf(iRaft, 90, -40),
      summary:
        'A write that survived admission becomes a raft proposal: appended to the leader\'s log, replicated, and committed only once a quorum has it on disk.',
      detail: [
        'The API server is the only client etcd has, and this is the only road into the vault. An admitted write becomes one etcd transaction; the raft leader appends it to its log, ships it to the followers, and waits for floor(n/2)+1 members — two of three here — to fsync it. Only then does it commit, assign the next revision, and answer.',
        'That fsync is why etcd\'s health is a disk question rather than a CPU one. These glyphs slow down as `etcdFsyncMs` rises, because no write can commit faster than the slowest member of the quorum can persist it, and every API write inherits that latency.',
        'Lose the quorum and the proposals still leave the tower and still arrive — they simply never commit. No revision is assigned, nothing comes back, the watch fan-out stops, and every write hangs and then times out. Controllers keep serving reads from caches they already hold, which is why a cluster with no etcd quorum looks alive and is not.',
      ],
      caveats: [
        'One glyph is one committed write, emitted when the etcd revision advances — so it is drawn leaving the tower just after the commit rather than just before it.',
        'Travel time stands in for latency and is not a measurement; a healthy etcd commits in a few milliseconds.',
        'Replication between the members themselves is drawn inside the vault, not on this road.',
      ],
      keywords: ['etcd', 'raft', 'proposal', 'quorum', 'fsync', 'revision', 'wal', 'commit'],
      metrics: (s) => [
        { label: 'revision', value: String(s.etcd?.revision ?? 0) },
        { label: 'writes/s', value: (s.etcd?.writesPerSec ?? 0).toFixed(1) },
        { label: 'quorum', value: s.etcd?.hasQuorum ? 'yes' : 'LOST — cluster is read-only' },
        { label: 'fsync', value: formatMs(s.knobs?.etcdFsyncMs ?? 0), hint: 'disk latency per raft append' },
        {
          label: 'db size',
          value: `${(s.etcd?.dbSizeMib ?? 0).toFixed(0)} / ${s.etcd?.dbQuotaMib ?? 0} MiB`,
        },
        { label: 'alarm', value: s.etcd?.alarm ?? 'none' },
      ],
    }),
  )

  const iBind = KINDS.indexOf('bind')
  Rg.bind(
    buckets[iBind].mesh,
    Rg.register({
      id: 'flow.bind',
      title: 'Binding',
      district: 'scheduler',
      kubeName: 'POST pods/<name>/binding',
      object: markers[iBind],
      focus: focusOf(iBind, 80, -60),
      summary:
        'The scheduler\'s only output. Binding a Pod to a Node is not a command sent to that node — it is a write of `spec.nodeName` back to the API server.',
      detail: [
        'After the filter and score phases pick a node, the scheduler POSTs a Binding subresource to `/api/v1/namespaces/<ns>/pods/<name>/binding`, which sets `spec.nodeName` on the Pod. Nothing is sent to the chosen node, no connection is opened to it, and the scheduler never speaks to a kubelet at any point.',
        'The node finds out the way everything else finds out anything: its kubelet\'s watch, filtered to its own name, produces a MODIFIED event for a pod that now names it. One arrowhead on this road becomes a cyan pulse on the road to the node grid a moment later.',
        'So a scheduling decision is a durable record before it is an action. If the chosen kubelet is down, the pod stays bound to that node and waits — the scheduler will not reconsider, because `spec.nodeName` is immutable once set. Getting the pod somewhere else requires deleting it, which is what the node controller\'s eviction eventually does.',
      ],
      caveats: [
        'One arrowhead is one successful binding. A failed attempt produces no write at all: it stays in the scheduler district as a Pending pod with a FailedScheduling reason.',
        'Preemption is modelled in the scheduler district; the deletion writes it issues are not drawn separately on this road.',
      ],
      keywords: ['bind', 'binding', 'nodeName', 'scheduler', 'schedule', 'pending'],
      metrics: (s) => [
        { label: 'scheduled', value: String(s.scheduler?.scheduled ?? 0) },
        { label: 'failed attempts', value: String(s.scheduler?.failed ?? 0) },
        { label: 'active queue', value: String(s.scheduler?.activeQueue?.length ?? 0) },
        {
          label: 'unschedulable',
          value: String(s.scheduler?.unschedulableQueue?.length ?? 0),
          hint: 'parked until a cluster event could make them fit',
        },
        { label: 'latency', value: formatMs(s.scheduler?.latencyMs ?? 0) },
      ],
    }),
  )

  const iImage = KINDS.indexOf('image')
  Rg.bind(
    buckets[iImage].mesh,
    Rg.register({
      id: 'flow.image',
      title: 'Image layer pull',
      district: 'registry',
      kubeName: 'CRI ImageService.PullImage',
      object: markers[iImage],
      focus: focusOf(iImage, 70, 90),
      summary:
        'Container image layers moving from a registry onto a node\'s disk. This is usually the slowest step in starting a pod, and it does not involve the control plane at all.',
      detail: [
        'When a kubelet needs an image the node does not already have, it asks the CRI runtime to pull it. The runtime fetches the manifest, then downloads each missing layer as a content-addressed blob and unpacks it into the snapshotter. Layers are shared: two images built on the same base download that base once per node, not once per pod.',
        'None of this traffic passes through the API server. It goes from the node straight to the registry, authenticated with an imagePullSecret if the registry needs one — which is why a broken pull appears as `ErrImagePull` and then `ImagePullBackOff` on the pod, and as nothing whatsoever in the control plane.',
        '`imagePullPolicy` decides whether a pull is attempted at all: `IfNotPresent` skips it when the image is already on the node, `Always` re-checks the manifest digest every time, and an image tagged `:latest` defaults to `Always`. A node that has an image cached starts a pod in a fraction of the time.',
      ],
      caveats: [
        'The glyph rate follows the number of kubelets whose sync loop is in the `pulling` phase. Layer sizes, digests and per-layer progress are not modelled.',
        'The registry is drawn inside the city for readability. A real registry is outside the cluster and is a separate availability dependency: if it is down, running pods keep running and new ones cannot start.',
      ],
      keywords: ['image', 'registry', 'pull', 'layer', 'blob', 'ImagePullBackOff', 'cri', 'containerd'],
      metrics: (s) => {
        const out: { label: string; value: string }[] = []
        const nodes = s.nodes ?? []
        let pulling = 0
        for (let i = 0; i < nodes.length; i++) if (nodes[i].kubelet?.phase === 'pulling') pulling++
        out.push({ label: 'nodes pulling', value: `${pulling} / ${nodes.length}` })
        for (let i = 0; i < nodes.length; i++) {
          out.push({ label: `${nodes[i].name} cache`, value: `${nodes[i].imageCache?.length ?? 0} images` })
        }
        return out
      },
    }),
  )

  const iVolume = KINDS.indexOf('volume')
  Rg.bind(
    buckets[iVolume].mesh,
    Rg.register({
      id: 'flow.volume',
      title: 'CSI volume operation',
      district: 'storage',
      kubeName: 'CSI: CreateVolume / ControllerPublish / NodePublish',
      object: markers[iVolume],
      focus: focusOf(iVolume, 70, 90),
      summary:
        'The steps between a PersistentVolumeClaim and a directory inside a container: provision, attach, mount — each one a separate operation by a different component.',
      detail: [
        'Storage is not one action. The external-provisioner sidecar sees an unbound PVC and calls CreateVolume, then writes a PersistentVolume object. The attach/detach controller, through external-attacher, calls ControllerPublishVolume to attach that volume to the node the pod was scheduled onto. Finally the CSI node plugin, driven by the kubelet, runs NodeStageVolume and NodePublishVolume to format and bind-mount it into the pod.',
        'Every step is a write followed by a wait. A pod whose volume is not attached yet is not failing — it sits in `ContainerCreating`, and the only place the reason appears is the event stream: `FailedAttachVolume`, `FailedMount`, `Multi-Attach error`.',
        'A StorageClass with `volumeBindingMode: WaitForFirstConsumer` deliberately leaves the PVC Pending until a pod using it is scheduled, so the volume is created in the same zone as the node. That is why a Pending PVC is often correct rather than broken.',
        'A ReadWriteOnce volume can be attached to exactly one node at a time, which is why a rescheduled StatefulSet pod waits for the old node to detach before the new node can attach.',
      ],
      caveats: [
        'Only the direction from the storage plant to the nodes is drawn. Unmount and detach travel the same road in reverse and are not shown.',
        'The glyph rate follows the number of CSI operations in flight, not byte throughput. This road carries control-plane operations; file I/O to a mounted volume never appears on the map.',
      ],
      keywords: ['csi', 'volume', 'pvc', 'pv', 'attach', 'mount', 'storageclass', 'provision'],
      metrics: (s) => {
        const ops = s.csiOps ?? []
        let inflight = 0
        let failed = 0
        for (let i = 0; i < ops.length; i++) {
          if (ops[i].failed) failed++
          else if (ops[i].progress < 1) inflight++
        }
        const pvcs = s.pvcs ?? []
        let bound = 0
        let pending = 0
        for (let i = 0; i < pvcs.length; i++) {
          if (pvcs[i].phase === 'Bound') bound++
          else if (pvcs[i].phase === 'Pending') pending++
        }
        return [
          { label: 'operations in flight', value: String(inflight) },
          { label: 'failed operations', value: String(failed) },
          { label: 'PVCs bound', value: `${bound} / ${pvcs.length}` },
          { label: 'PVCs pending', value: String(pending), hint: 'often WaitForFirstConsumer, not a fault' },
          { label: 'PVs', value: String((s.pvs ?? []).length) },
        ]
      },
    }),
  )

  const iTraffic = KINDS.indexOf('traffic')
  Rg.bind(
    buckets[iTraffic].mesh,
    Rg.register({
      id: 'flow.traffic',
      title: 'User traffic',
      district: 'network',
      kubeName: 'Ingress → EndpointSlice → pod IP',
      object: markers[iTraffic],
      focus: focusOf(iTraffic, 70, 120),
      summary:
        'Requests arriving from outside the cluster and being proxied to pod IPs. This is the only traffic on the map a customer would ever notice.',
      detail: [
        'An Ingress object is a routing table, not a server. The ingress controller — itself a pod, usually behind a Service of type LoadBalancer — watches Ingress objects and EndpointSlices and rewrites its own configuration. TLS terminates at that pod, and the request is then sent onward inside the cluster.',
        'Most ingress controllers do not send traffic to the ClusterIP. They read the EndpointSlice and connect straight to a ready pod IP, which is why kube-proxy\'s rule tables and the Service VIP play no part in this leg at all. The Service still matters — it is what defines the selector the EndpointSlice is built from.',
        'Only pods that are Ready receive any of it. Readiness is the switch that adds a pod to, and removes it from, the EndpointSlice; it is why a rolling update behind a readiness probe that never passes stalls instead of serving errors, and why deleting a pod stops traffic to it before the container is signalled.',
      ],
      caveats: [
        'One glyph is roughly twelve requests per second, so the road reads as flow rather than as individual connections.',
        'The load balancer in front of the ingress is one hop here. A real cloud load balancer is external to the cluster and its own health checks are not modelled.',
        'The share of traffic that fails is expressed as a 5xx rate in the edge district rather than as red glyphs, so this road never double-counts an error.',
      ],
      keywords: ['ingress', 'traffic', 'rps', 'load balancer', 'endpointslice', 'readiness', '5xx'],
      metrics: (s) => {
        const ing = s.ingresses ?? []
        let rps = 0
        let err = 0
        for (let i = 0; i < ing.length; i++) {
          rps += ing[i].rps
          err += ing[i].rps * ing[i].errorRate
        }
        const svc = s.services ?? []
        let svcRps = 0
        for (let i = 0; i < svc.length; i++) svcRps += svc[i].rps
        return [
          { label: 'ingress rps', value: rps.toFixed(0) },
          { label: '5xx rate', value: formatPercent(rps > 0 ? err / rps : 0, 1) },
          { label: 'service rps', value: svcRps.toFixed(0) },
          { label: 'DNS queries/s', value: (s.dns?.queriesPerSec ?? 0).toFixed(0) },
        ]
      },
    }),
  )

  /* ------------------------------------------------------------------------
   * Frame loop. Allocates nothing.
   * ----------------------------------------------------------------------*/
  let themeMode: ThemeMode = getMode()
  let visible = true

  function refreshTheme(): void {
    for (let k = 0; k < buckets.length; k++) {
      const spec = KIND_SPEC[buckets[k].kind]
      buckets[k].mesh.material = neon(spec.color, spec.glow)
    }
  }

  function update(s: SimState, dt: number): void {
    /* A theme flip disposes the shared cache, so any material captured earlier
     * is dangling. Polled rather than bus-driven: handler order is not ours. */
    const nowMode = getMode()
    if (nowMode !== themeMode) {
      themeMode = nowMode
      refreshTheme()
    }

    if (!visible) {
      for (let k = 0; k < buckets.length; k++) {
        buckets[k].count = 0
        buckets[k].mesh.count = 0
      }
      return
    }

    computeRates(s)
    const hasQuorum = s.etcd ? s.etcd.hasQuorum : true

    /* Discrete, counted events first: these are exact, not sampled. */
    while (pendingRaft > 0) {
      pendingRaft--
      spawn(R_API_ETCD)
    }
    while (pendingBind > 0) {
      pendingBind--
      spawn(R_SCHED_API)
    }
    for (let i = 0; i < routes.length; i++) drain(i, dt)

    for (let k = 0; k < buckets.length; k++) {
      const b = buckets[k]
      const growRing = b.kind === 'watch'
      let i = 0
      while (i < b.count) {
        const ri = b.route[i]
        const r = routes[ri]
        const u = b.u[i] + (b.speed[i] * dt) / r.len
        if (u >= 1) {
          onArrive(ri, hasQuorum)
          const last = --b.count
          if (i !== last) {
            b.route[i] = b.route[last]
            b.u[i] = b.u[last]
            b.speed[i] = b.speed[last]
          }
          continue
        }
        b.u[i] = u
        sampleAt(r, u, _pos, _dir)
        _quat.setFromUnitVectors(FORWARD, _dir)
        /* Scale ramps in and out so a glyph never pops into existence, and a
         * watch ring widens as it travels: the fan-out is spreading. */
        let f = u * 16
        const g = (1 - u) * 16
        if (g < f) f = g
        if (f > 1) f = 1
        const sc = growRing ? f * (1 + 1.1 * u) : f
        _scale.set(sc, sc, sc)
        _m4.compose(_pos, _quat, _scale)
        b.mesh.setMatrixAt(i, _m4)
        i++
      }
      b.mesh.count = b.count
      b.mesh.instanceMatrix.needsUpdate = true
    }

    /* Deferred so a spawn never lands inside the loop that is compacting the
     * same bucket. One commit → one watch event → every informer at once. */
    while (pendingCommit > 0) {
      pendingCommit--
      spawn(R_ETCD_API)
    }
    while (pendingFanout > 0) {
      pendingFanout--
      spawn(R_API_SCHED)
      spawn(R_API_CTRL)
      spawn(R_API_NODES)
    }
  }

  function setVisible(v: boolean): void {
    visible = v
    group.visible = v
  }

  function dispose(): void {
    /* Geometries are ours. Materials come from the theme cache and are shared. */
    for (let k = 0; k < buckets.length; k++) {
      buckets[k].mesh.dispose()
      buckets[k].geo.dispose()
    }
  }

  return { group, update, setVisible, dispose }
}
