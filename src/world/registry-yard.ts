import * as THREE from 'three'
import { N_NODES } from '../core/types'
import type { PodState, SimState } from '../core/types'
import { COLOR, ghost, mat, neon, structural } from '../core/theme'
import { clamp } from '../core/util'
import { ANCHOR, CITY, routeCurve } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE IMAGE REGISTRY — content-addressed layers, and what a pull actually moves.
 *
 * The single idea this district exists to teach: an image is not a file. It is a
 * manifest — a short list of digests — plus a set of layers stored once each and
 * shared by every image that references them. So the yard is built in two halves
 * that must never be confused:
 *
 *   the blob yard   solid matter, one bay per layer digest, sized by bytes
 *   the manifest    ghosts, because a manifest holds no data at all; it only
 *   hall            points at bays, and two images pointing at one bay is the
 *                   whole of layer sharing
 *
 * A pull therefore carries only the bays a node is missing. When the node
 * already has every bay, the convoy never leaves — and that is why the second
 * pod of a Deployment starts in a second and the first took thirty.
 * ==========================================================================*/

/* The layer catalogue. Real digests are sha256 over the layer's tar; here a
 * layer's identity is its bay, and images are assigned layers deterministically
 * from their reference so the same image always lands on the same bays. */
/* Enough to give the depth buffer an unambiguous winner over the ground plane,
 * far too little to read as a step. */
const APRON_LIFT = 0.12

const N_BASE = 4
const N_LIB = 6
const N_APP = 12
const N_LAYERS = N_BASE + N_LIB + N_APP

/** Layer sizes in MiB. Bases are large, application layers are tiny — the real
 * ratio, and the reason a rebuild of your code re-pulls almost nothing. */
const LAYER_MIB = new Float32Array(N_LAYERS)
for (let i = 0; i < N_LAYERS; i++) {
  LAYER_MIB[i] =
    i < N_BASE ? 58 + i * 19 : i < N_BASE + N_LIB ? 11 + (i - N_BASE) * 7 : 1.5 + (i - N_BASE - N_LIB) * 1.6
}

const MAX_IMAGES = 6
const MAX_PULLS = 6
const LAYERS_PER_IMAGE = 4

const BAY_COLS = 11
const BAY_PITCH_X = 12
const BAY_ROW_Z = [-90, -74] as const
const MANIFEST_Z = -34
const MANIFEST_PITCH = 22
const GATE_Z = -8
const BOARD_Z = 52
const BOARD_PITCH = 34
const PIP_PITCH = 2.3

/* Scratch. update() must allocate nothing. */
const _v = new THREE.Vector3()
const _m4 = new THREE.Matrix4()
const _origin = new THREE.Vector3(
  ANCHOR.imageRegistry[0],
  ANCHOR.imageRegistry[1],
  ANCHOR.imageRegistry[2],
)

/** FNV-1a over a substring, without building the substring. */
function hashRange(s: string, from: number, to: number): number {
  let h = 2166136261
  for (let i = from; i < to; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Which bays an image reference occupies, as a bitmask.
 * Images sharing a repository share their base and runtime layers and differ
 * only in the two application layers — the shape of a real tag bump.
 */
function layerMask(image: string): number {
  const n = image.length
  if (n === 0) return 0
  let slash = -1
  let colon = -1
  for (let i = 0; i < n; i++) {
    const c = image.charCodeAt(i)
    if (c === 47) slash = i
    else if (c === 58) colon = i
  }
  const repoEnd = colon > slash ? colon : n
  const hRepo = hashRange(image, 0, repoEnd)
  const hFull = hashRange(image, 0, n)
  const base = hRepo % N_BASE
  const lib = N_BASE + ((hRepo >>> 8) % N_LIB)
  const a1 = N_BASE + N_LIB + (hFull % N_APP)
  let a2 = N_BASE + N_LIB + ((hFull >>> 11) % N_APP)
  if (a2 === a1) a2 = N_BASE + N_LIB + ((a1 - N_BASE - N_LIB + 1) % N_APP)
  return (1 << base) | (1 << lib) | (1 << a1) | (1 << a2)
}

function popcount(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (Math.imul(x, 0x01010101) >>> 24) & 0x3f
}

function maskBytesMib(mask: number): number {
  let mib = 0
  for (let i = 0; i < N_LAYERS; i++) if (mask & (1 << i)) mib += LAYER_MIB[i]
  return mib
}

function bayX(i: number): number {
  return ((i % BAY_COLS) - (BAY_COLS - 1) / 2) * BAY_PITCH_X
}
function bayZ(i: number): number {
  return BAY_ROW_Z[i < BAY_COLS ? 0 : 1]
}
function bayHeight(i: number): number {
  return 2 + LAYER_MIB[i] * 0.1
}

type Mats = ReturnType<typeof buildMats>
type MatKey = keyof Mats

function buildMats() {
  return {
    concrete: mat(structural('concrete'), 0.95),
    deck: mat(structural('deck'), 0.9),
    dim: mat(COLOR.edge, 0.85),
    dark: mat(structural('deck'), 0.96),
    /* Image grey is the district's mechanism colour: bytes on their way. */
    blob: neon(COLOR.image, 1.4),
    blobIdle: mat(COLOR.image, 0.8),
    ready: neon(COLOR.ready, 1.5),
    pending: neon(COLOR.pending, 1.5),
    backoff: neon(COLOR.backoff, 1.8),
    failed: neon(COLOR.failed, 1.6),
    failedBright: neon(COLOR.failed, 3.2),
    /* A manifest is a record, and records are ghosts. */
    manifest: ghost(COLOR.desired, 0.3),
    manifestDim: ghost(COLOR.desired, 0.12),
  }
}

interface Pylon {
  root: THREE.Group
  mast: THREE.Mesh
  chits: THREE.Mesh[]
  beams: THREE.Mesh[]
}

interface Convoy {
  root: THREE.Group
  bed: THREE.Mesh
  crates: THREE.Mesh[]
  lamp: THREE.Mesh
}

interface Board {
  root: THREE.Group
  panel: THREE.Mesh
  lamp: THREE.Mesh
}

export function createRegistryYard(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'registry-yard'
  group.position.copy(_origin)

  let mats = buildMats()
  const geoms: THREE.BufferGeometry[] = []
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
  function dyn(g: THREE.BufferGeometry, k: MatKey, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(g, mats[k])
    parent.add(m)
    return m
  }

  /* --------------------------------------------------------------- the yard */

  const apron = mesh(box(CITY.registry.w, 1, CITY.registry.d), 'concrete', group)
  /*
   * Sit a finger above grade, not exactly on it.
   *
   * At -0.5 the slab's top face landed on y = 0 — the same plane as the ground
   * — and two coplanar opaque surfaces have no depth order at all: the card
   * picks a winner per pixel and picks differently as the camera moves, which
   * is the flicker across this yard. A real yard is poured above the dirt
   * anyway, so the lift is honest as well as necessary.
   */
  apron.position.y = -0.5 + APRON_LIFT

  /* ------------------------------------------------------------ blob bays */

  /* One bay per layer digest. Height is the layer's size, so the eye reads
   * immediately that a base layer is the expensive one and the app layer on top
   * of it is nothing. */
  const bayGeo = box(8, 1, 8)
  bayGeo.translate(0, 0.5, 0)
  const bays: THREE.Mesh[] = []
  const plinthGeo = box(9.4, 0.8, 9.4)
  for (let i = 0; i < N_LAYERS; i++) {
    const p = mesh(plinthGeo, 'deck', group)
    p.position.set(bayX(i), 0.4, bayZ(i))
    const b = dyn(bayGeo, 'blobIdle', group)
    b.position.set(bayX(i), 0.8, bayZ(i))
    b.scale.y = bayHeight(i)
    b.name = `blob-bay-${i}`
    bays.push(b)
  }

  /* -------------------------------------------------------- manifest hall */

  const hallDeck = mesh(box(CITY.registry.w - 16, 1, 22), 'deck', group)
  hallDeck.position.set(0, 0.5, MANIFEST_Z)

  const mastGeo = box(1.6, 17, 1.6)
  const chitGeo = box(7, 1.6, 5)
  const beamGeo = box(0.35, 0.35, 1)
  const CHIT_Y = [3.4, 6.8, 10.2, 13.6] as const

  const pylons: Pylon[] = []
  for (let i = 0; i < MAX_IMAGES; i++) {
    const root = new THREE.Group()
    root.position.set((i - (MAX_IMAGES - 1) / 2) * MANIFEST_PITCH, 1, MANIFEST_Z)
    root.visible = false
    group.add(root)

    const mast = dyn(mastGeo, 'manifestDim', root)
    mast.position.y = 8.5

    const chits: THREE.Mesh[] = []
    const beams: THREE.Mesh[] = []
    for (let k = 0; k < LAYERS_PER_IMAGE; k++) {
      const c = dyn(chitGeo, 'manifest', root)
      c.position.y = CHIT_Y[k]
      chits.push(c)
      /* The reference from a manifest entry to the bay holding those bytes.
       * The manifest is a ghost; only the far end of this beam is matter. */
      const b = dyn(beamGeo, 'manifestDim', group)
      b.visible = false
      beams.push(b)
    }
    /* Names are the handle tests and the console use to reach one slot. */
    root.name = `image-manifest-${i}`
    pylons.push({ root, mast, chits, beams })
  }

  /* ------------------------------------------------------- registry gate */

  const gate = new THREE.Group()
  gate.position.set(0, 0, GATE_Z)
  group.add(gate)
  const gateHall = mesh(box(44, 16, 18), 'deck', gate)
  gateHall.position.y = 8
  /* Two doors, because a pull is two kinds of request: GET the manifest, then
   * GET each blob the node does not already have. */
  const manifestDoor = dyn(box(9, 11, 1.6), 'manifestDim', gate)
  manifestDoor.position.set(-12, 5.5, -9.6)
  const blobDoor = dyn(box(9, 11, 1.6), 'blobIdle', gate)
  blobDoor.position.set(12, 5.5, -9.6)
  const gateMast = dyn(box(2, 14, 2), 'blobIdle', gate)
  gateMast.position.set(0, 23, 0)

  /* --------------------------------------------- node content-store boards */

  const boardPanelGeo = box(28, 15, 1.6)
  const boardLampGeo = geo(new THREE.IcosahedronGeometry(1.5, 0))
  const boards: Board[] = []
  /* Pip positions live in group space so the instanced pip meshes can be one
   * draw call for the whole yard rather than one per board. */
  const PIP_TOTAL = N_NODES * N_LAYERS
  const pipPos = new Float32Array(PIP_TOTAL * 3)
  for (let n = 0; n < N_NODES; n++) {
    const root = new THREE.Group()
    const bx = (n - (N_NODES - 1) / 2) * BOARD_PITCH
    root.position.set(bx, 0, BOARD_Z)
    group.add(root)
    const panel = mesh(boardPanelGeo, 'deck', root)
    panel.position.y = 7.5
    const lamp = dyn(boardLampGeo, 'dim', root)
    lamp.position.set(0, 17, 0)
    boards.push({ root, panel, lamp })

    for (let i = 0; i < N_LAYERS; i++) {
      const col = i % BAY_COLS
      const row = i < BAY_COLS ? 0 : 1
      const p = (n * N_LAYERS + i) * 3
      pipPos[p] = bx + (col - (BAY_COLS - 1) / 2) * PIP_PITCH
      pipPos[p + 1] = 10.4 - row * 3.2
      pipPos[p + 2] = BOARD_Z - 1.3
    }
  }

  const pipGeo = box(1.7, 1.7, 0.9)
  const pipsResident = new THREE.InstancedMesh(pipGeo, mats.blob, PIP_TOTAL)
  const pipsTransit = new THREE.InstancedMesh(pipGeo, mats.pending, PIP_TOTAL)
  const pipsAbsent = new THREE.InstancedMesh(pipGeo, mats.dim, PIP_TOTAL)
  pipsResident.count = 0
  pipsTransit.count = 0
  pipsAbsent.count = 0
  /* Instance matrices change every frame, so the bounding sphere three computed
   * at construction would cull the boards away. */
  pipsResident.frustumCulled = false
  pipsTransit.frustumCulled = false
  pipsAbsent.frustumCulled = false
  group.add(pipsResident, pipsTransit, pipsAbsent)

  /* ------------------------------------------------------- pull convoys */

  const road = routeCurve('registry-to-nodes')
  /* Prime the arc-length table once: getPointAt() must not build it per frame. */
  road.getLengths(200)

  const bedGeo = box(7, 2, 11)
  const crateGeo = box(4.4, 1, 4.4)
  crateGeo.translate(0, 0.5, 0)
  const lampGeo = geo(new THREE.IcosahedronGeometry(1.2, 0))
  const convoys: Convoy[] = []
  for (let i = 0; i < MAX_PULLS; i++) {
    const root = new THREE.Group()
    root.visible = false
    group.add(root)
    const bed = dyn(bedGeo, 'blob', root)
    const crates: THREE.Mesh[] = []
    for (let k = 0; k < LAYERS_PER_IMAGE; k++) {
      const c = dyn(crateGeo, 'blob', root)
      c.position.set(0, 1, (k - (LAYERS_PER_IMAGE - 1) / 2) * 2.6)
      c.visible = false
      crates.push(c)
    }
    const lamp = dyn(lampGeo, 'blob', root)
    lamp.position.y = 5
    root.name = `pull-convoy-${i}`
    for (let k = 0; k < LAYERS_PER_IMAGE; k++) crates[k].name = `pull-crate-${i}-${k}`
    convoys.push({ root, bed, crates, lamp })
  }

  /* --------------------------------------------------------------- registry */

  const F_YARD: [number, number, number] = [CITY.registry.x + 210, 90, CITY.registry.z - 60]

  ctx.registry.register({
    id: 'registry.yard',
    title: 'Image registry',
    district: 'registry',
    kubeName: 'OCI registry (registry.k8s.io, ghcr.io, ECR, …)',
    summary:
      'Not part of Kubernetes at all: an HTTP content store that nodes pull from, and the first thing to break a pod.',
    detail: [
      'No Kubernetes component owns this building. A registry is an ordinary HTTPS service implementing the OCI distribution spec, and the only thing that ever talks to it is the container runtime on each node — never the API server, never the scheduler.',
      'A pull is two kinds of request through the two doors. First GET the manifest for the tag, which is a short JSON document listing the config and the layer digests. Then, for each digest the node does not already have, GET that blob. Nothing else is transferred.',
      'That split is why the manifest hall is made of ghosts and the blob yard is made of matter. The manifest is a list of pointers; the bytes live in the bays, once each, no matter how many images reference them.',
      'Pull credentials come from an imagePullSecret on the pod or its ServiceAccount. A private registry with no matching secret fails with ErrImagePull and a 401 in the message — which looks identical to a typo in the image name until you read it.',
    ],
    caveats: [
      'The registry is drawn inside the city for legibility. It is almost always outside the cluster entirely, across the internet or in a separate VPC.',
      'Manifest lists (multi-architecture images), image config blobs, and registry authentication token exchange are not drawn.',
      'Real registries also serve as the storage for Helm charts and other OCI artifacts; only container images are modelled.',
    ],
    object: group,
    focus: F_YARD,
    keywords: ['registry', 'image', 'oci', 'docker', 'pull', 'manifest', 'imagepullsecret'],
    metrics: (s) => {
      let pulling = 0
      let cached = 0
      for (let i = 0; i < s.nodes.length; i++) cached += s.nodes[i].imageCache.length
      s.pods.forEach((p) => {
        for (let i = 0; i < p.containers.length; i++) {
          const c = p.containers[i]
          if (c.state === 'waiting' && c.pullProgress > 0 && c.pullProgress < 1) pulling++
        }
      })
      return [
        { label: 'layers stored', value: `${N_LAYERS}` },
        { label: 'pulls in flight', value: `${pulling}` },
        { label: 'images cached across nodes', value: `${cached}` },
        { label: 'pull failure injected', value: s.knobs.imagePullFailure ? 'yes' : 'no' },
      ]
    },
  })

  const blobEntry = ctx.registry.register({
    id: 'registry.layers',
    title: 'Content-addressed layers',
    district: 'registry',
    kubeName: 'OCI image layers',
    summary:
      'One bay per layer digest. A layer is stored once and shared by every image that references it.',
    detail: [
      'Each bay is one layer: a gzipped tar of filesystem changes, named by the sha256 of its own content. The name is derived from the bytes, so two builds that produce identical bytes produce the same digest and the same bay — and a changed byte produces a different bay, always.',
      'Because the address is the content, deduplication is free and needs no coordination. The registry stores a layer once. A node stores it once. Neither has to ask the other what it already has.',
      'The tall bays at the back are base layers — a distro or runtime image — and the short ones are application layers. That ratio is why ordering a Dockerfile so that dependencies are installed before your code is copied turns a 300 MiB pull into a 3 MiB one.',
      'Layers stack by union filesystem: an upper layer can add, replace or mark deleted a file from a lower one, and the container sees the merged result with a thin writable layer on top. Writes to that top layer die with the container, which is the whole reason the storage plant exists.',
    ],
    caveats: [
      `The catalogue is fixed at ${N_LAYERS} layers, and each image is assigned ${LAYERS_PER_IMAGE} of them deterministically from its reference: the base and runtime layers follow the repository, the two application layers follow the full tag. Real images have anywhere from one to dozens of layers, and sharing follows the Dockerfile's FROM, not the name.`,
      'Layer sizes are model values on a compressed scale, not real image sizes.',
      'Compression, chunked uploads, and containerd\'s snapshotter unpacking layers into filesystem snapshots are not drawn.',
    ],
    object: bays[0],
    focus: [CITY.registry.x + 150, 60, CITY.registry.z - 130],
    keywords: ['layer', 'digest', 'sha256', 'blob', 'content-addressed', 'dedup', 'overlayfs'],
    metrics: () => {
      let mib = 0
      for (let i = 0; i < N_LAYERS; i++) mib += LAYER_MIB[i]
      return [
        { label: 'layers in the yard', value: `${N_LAYERS}` },
        { label: 'base layers', value: `${N_BASE}`, hint: 'shared by every image built on them' },
        { label: 'total stored', value: `${Math.round(mib)}Mi` },
      ]
    },
  })
  for (let i = 1; i < bays.length; i++) ctx.registry.bind(bays[i], blobEntry)
  ctx.registry.bind(blobDoor, blobEntry)

  const imageEntry = ctx.registry.register({
    id: 'registry.image',
    title: 'Image manifests',
    district: 'registry',
    kubeName: 'image reference',
    summary:
      'An image is a ghost: a manifest listing layer digests. Two manifests pointing at one bay is layer sharing.',
    detail: [
      'A pylon is one image reference in use by a pod in this cluster, and its four chits are the layer digests its manifest names. The beams show which bays those digests resolve to. Where two pylons beam into the same bay, that layer is downloaded and stored once.',
      'The manifest itself is a few hundred bytes and holds no filesystem content, which is why it is drawn as a hologram. Deleting an image from a node deletes its manifest and any layers no longer referenced; layers still used by another image stay.',
      'A tag such as :1.27 is a mutable pointer to a manifest digest. It can be moved to different content at any time, which is why two nodes pulling "the same" tag a week apart can legitimately run different code — and why imagePullPolicy and pinning by @sha256: exist.',
      'imagePullPolicy decides whether the node checks the registry at all: IfNotPresent uses the local copy if the reference is already resolved, Always re-checks the manifest every start, and a tag of :latest defaults to Always.',
    ],
    caveats: [
      'Up to ' + MAX_IMAGES + ' distinct images are drawn, taken from the containers of running pods.',
      'The image config blob — entrypoint, env, working directory — is part of a real manifest and is not drawn.',
      'Digest pinning and multi-architecture manifest lists are described but not modelled.',
    ],
    object: pylons[0].root,
    focus: [CITY.registry.x + 140, 46, CITY.registry.z - 70],
    keywords: ['image', 'manifest', 'tag', 'latest', 'imagepullpolicy', 'digest'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < MAX_IMAGES; i++) {
        const img = imageRefs[i]
        if (!img) continue
        const m = layerMask(img)
        out.push({
          label: img,
          value: `${popcount(m)} layers · ${Math.round(maskBytesMib(m))}Mi`,
        })
      }
      if (out.length === 0) out.push({ label: 'images', value: 'none referenced by a running pod' })
      out.push({ label: 'nodes', value: `${s.nodes.length}` })
      return out
    },
  })
  for (let i = 1; i < pylons.length; i++) ctx.registry.bind(pylons[i].root, imageEntry)
  ctx.registry.bind(manifestDoor, imageEntry)

  const pullEntry = ctx.registry.register({
    id: 'registry.pull',
    title: 'Image pull',
    district: 'registry',
    kubeName: 'kubelet · CRI ImageService.PullImage',
    summary:
      'A convoy carries only the layers the destination node is missing. If it is missing none, no convoy leaves.',
    detail: [
      'kubelet asks the container runtime to pull, the runtime resolves the manifest, and then it fetches exactly the blobs its content store does not already have. Layers arrive in parallel and are unpacked as they land; the progress on the convoy is bytes, not steps.',
      'This is the slowest step in starting a pod and the only one that depends on a system outside the cluster. It is also serialised per node by default (--serialize-image-pulls), so ten pods landing on one node with ten different images queue behind each other.',
      'A cached image produces no convoy at all. That asymmetry is worth watching for: scale a Deployment up and the first pod on a fresh node waits for the full pull, while every later pod on that node starts immediately.',
      'While this is happening the pod is not Pending — it was scheduled long ago. It sits in ContainerCreating with the reason on its container, which is why "why is my pod not starting" is answered by `kubectl describe pod`, not by the scheduler.',
    ],
    caveats: [
      'Pull duration is set by the imagePullSeconds knob rather than by layer bytes; the convoy shows which layers move, not how long each takes.',
      `At most ${MAX_PULLS} concurrent pulls are drawn.`,
      'Registry authentication, rate limiting (the classic Docker Hub 429), and pull-through caches are not modelled.',
    ],
    object: convoys[0].root,
    focus: [CITY.registry.x - 60, 60, CITY.registry.z + 40],
    keywords: ['pull', 'pullimage', 'cri', 'containercreating', 'cache', 'serialize-image-pulls'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < pullCount; i++) {
        const img = pullImage[i]
        const resident = nodeMask[pullNode[i]]
        const need = layerMask(img) & ~resident
        out.push({
          label: `${s.nodes[pullNode[i]]?.name ?? '—'} ← ${img}`,
          value: `${Math.round(pullProgress[i] * 100)}%`,
          hint: `${popcount(need)} layers to fetch (${Math.round(maskBytesMib(need))}Mi), ${popcount(layerMask(img) & resident)} already in the content store`,
        })
      }
      if (out.length === 0) out.push({ label: 'pulls', value: 'none in flight' })
      return out
    },
  })
  for (let i = 1; i < convoys.length; i++) ctx.registry.bind(convoys[i].root, pullEntry)
  ctx.registry.bind(gateMast, pullEntry)

  const cacheEntry = ctx.registry.register({
    id: 'registry.content-store',
    title: 'Node content stores',
    district: 'registry',
    kubeName: 'containerd content store · node.status.images',
    summary:
      'One board per node: which layer bays that node already holds, and therefore what a pull would skip.',
    detail: [
      'Every node keeps its own content store of layers, addressed by the same digests as the registry. A lit pip is a layer already on disk there. A pull fetches exactly the dark pips and nothing else.',
      'kubelet reports the images it holds in node.status.images, and the scheduler even scores nodes slightly higher for already having an image (the ImageLocality plugin). That is a tiebreaker, not a rule: it will happily place a pod on a node that must pull.',
      'The store is garbage collected on disk pressure, oldest unused first, and the thresholds are kubelet flags (--image-gc-high-threshold, default 85% of the filesystem). A node that has just been GC-ed pulls everything again, which is one honest cause of a mysteriously slow pod start.',
      'The green lamp above a board is a start that needed no pull at all: every layer was already there.',
    ],
    caveats: [
      'The registry cannot see any of this. These boards are drawn beside it for comparison; in reality the layers live in containerd\'s content store on each node and the registry only ever observes which blobs get requested.',
      'Residency is derived from the node\'s image cache: an image counts as present when every layer of it is, which is exactly how the runtime decides, but the model has no partial-layer state.',
      'Image garbage collection is described but not simulated.',
    ],
    object: pipsResident,
    focus: [CITY.registry.x + 140, 50, CITY.registry.z + 130],
    keywords: ['cache', 'content store', 'containerd', 'imagelocality', 'image gc', 'node.status.images'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.nodes.length && i < N_NODES; i++) {
        const n = s.nodes[i]
        out.push({
          label: n.name,
          value: `${popcount(nodeMask[i])} of ${N_LAYERS} layers`,
          hint: `${n.imageCache.length} images cached`,
        })
      }
      return out
    },
  })
  ctx.registry.bind(pipsTransit, cacheEntry)
  ctx.registry.bind(pipsAbsent, cacheEntry)
  for (let i = 0; i < boards.length; i++) ctx.registry.bind(boards[i].panel, cacheEntry)

  const backoffEntry = ctx.registry.register({
    id: 'registry.image-pull-backoff',
    title: 'ImagePullBackOff',
    district: 'registry',
    kubeName: 'reason: ErrImagePull / ImagePullBackOff',
    summary:
      'The pull failed, so kubelet is waiting before trying again — and the wait doubles each time.',
    detail: [
      'The first failure is ErrImagePull, carrying the runtime\'s own message: manifest unknown for a typo, 401 unauthorized for a missing imagePullSecret, or a connection error for an unreachable registry. kubelet then backs off and the reason becomes ImagePullBackOff.',
      'The backoff doubles from 10 seconds to a cap of 5 minutes, the same rate limiter that produces CrashLoopBackOff. Both are kubelet refusing to hammer something that is not working, and neither is an error state in itself — the pod is still trying.',
      'The pod stays in Pending phase with its container waiting. Nothing is wrong with the node, the scheduler or the API server, which is why the fix is almost never in Kubernetes: correct the reference, add the pull secret, or make the registry reachable.',
      'A stopped convoy on the road is a pull in backoff. It has not been abandoned; it will move again when the timer expires.',
    ],
    caveats: [
      'The remaining backoff for an image pull is not carried in the model\'s state, so the halted convoy shows that a retry is pending but not how long is left. The container\'s crash backoff timer, which is a different timer, is shown on the pod itself.',
      'The distinction between ErrImagePull (this attempt failed) and ImagePullBackOff (waiting to retry) is shown by colour: red for the failure, amber for the wait.',
    ],
    object: convoys[0].lamp,
    focus: [CITY.registry.x - 80, 50, CITY.registry.z + 20],
    keywords: ['imagepullbackoff', 'errimagepull', 'backoff', 'pull secret', '401', 'manifest unknown'],
    metrics: (s) => {
      let err = 0
      let backoff = 0
      s.pods.forEach((p) => {
        for (let i = 0; i < p.containers.length; i++) {
          const r = p.containers[i].reason
          if (r === 'ErrImagePull') err++
          else if (r === 'ImagePullBackOff') backoff++
        }
      })
      return [
        { label: 'containers in ErrImagePull', value: `${err}` },
        { label: 'containers in ImagePullBackOff', value: `${backoff}` },
        { label: 'pull failure injected', value: s.knobs.imagePullFailure ? 'yes' : 'no' },
      ]
    },
  })
  for (let i = 1; i < convoys.length; i++) ctx.registry.bind(convoys[i].lamp, backoffEntry)

  /* ------------------------------------------------------------ theme flip */

  const offTheme = ctx.bus.on('theme', () => {
    mats = buildMats()
    for (let i = 0; i < statics.length; i++) statics[i].o.material = mats[statics[i].k]
    pipsResident.material = mats.blob
    pipsTransit.material = mats.pending
    pipsAbsent.material = mats.dim
  })

  /* ----------------------------------------------------------------- update */

  /* Frame scratch. Every array here is allocated once and refilled in place. */
  const imageRefs: (string | undefined)[] = new Array(MAX_IMAGES).fill(undefined)
  let imageCount = 0
  const pullImage: string[] = new Array(MAX_PULLS).fill('')
  const pullNode = new Int32Array(MAX_PULLS)
  const pullProgress = new Float32Array(MAX_PULLS)
  /** 0 running, 1 waiting out a backoff, 2 the attempt itself failed. */
  const pullState = new Int8Array(MAX_PULLS)
  let pullCount = 0
  /** Layers resident in each node's content store. */
  const nodeMask = new Int32Array(N_NODES)
  /** Layers moving somewhere right now, and layers any live image references. */
  let transitMask = 0
  let referencedMask = 0
  /** Per node: a container started with every layer already present. */
  const cacheHit = new Int8Array(N_NODES)
  const nodeIndexOf = new Map<string, number>()
  let scanState: SimState | null = null

  function scanPod(p: PodState): void {
    const s = scanState
    if (!s) return
    const ni = p.nodeName === undefined ? -1 : (nodeIndexOf.get(p.nodeName) ?? -1)
    for (let i = 0; i < p.containers.length; i++) {
      const c = p.containers[i]
      const img = c.image
      if (img.length === 0) continue

      /* Distinct images in use, in first-seen order. */
      let known = false
      for (let k = 0; k < imageCount; k++) {
        if (imageRefs[k] === img) {
          known = true
          break
        }
      }
      if (!known && imageCount < MAX_IMAGES) {
        imageRefs[imageCount++] = img
        referencedMask |= layerMask(img)
      }

      if (c.state !== 'waiting' || ni < 0) continue
      const failed = c.reason === 'ErrImagePull'
      const backoff = c.reason === 'ImagePullBackOff'
      const pulling = failed || backoff || (c.reason === 'ContainerCreating' && c.pullProgress < 1)
      if (pulling) {
        if (pullCount < MAX_PULLS) {
          const k = pullCount++
          pullImage[k] = img
          pullNode[k] = ni
          pullProgress[k] = clamp(c.pullProgress, 0, 1)
          pullState[k] = failed ? 2 : backoff ? 1 : 0
          transitMask |= layerMask(img) & ~nodeMask[ni]
        }
      } else if ((layerMask(img) & ~nodeMask[ni]) === 0) {
        /* Nothing left to fetch: this container started with no pull at all. */
        cacheHit[ni] = 1
      }
    }
  }

  function update(s: SimState, _dt: number): void {
    const t = s.t

    imageCount = 0
    pullCount = 0
    transitMask = 0
    referencedMask = 0
    cacheHit.fill(0)
    nodeMask.fill(0)

    /* Node content stores, and the name -> index map the pod scan needs. */
    const nNodes = s.nodes.length < N_NODES ? s.nodes.length : N_NODES
    for (let i = 0; i < nNodes; i++) {
      const n = s.nodes[i]
      if (nodeIndexOf.get(n.name) !== i) nodeIndexOf.set(n.name, i)
      let m = 0
      for (let k = 0; k < n.imageCache.length; k++) m |= layerMask(n.imageCache[k])
      nodeMask[i] = m
    }

    /* Map.forEach with a hoisted callback iterates without building an iterator. */
    scanState = s
    s.pods.forEach(scanPod)
    scanState = null

    /* --- blob bays. A bay glows only while its bytes are actually moving. */
    for (let i = 0; i < N_LAYERS; i++) {
      const bit = 1 << i
      const b = bays[i]
      if (transitMask & bit) {
        b.material = Math.sin(t * 9 + i) > -0.2 ? mats.blob : mats.blobIdle
      } else {
        b.material = referencedMask & bit ? mats.blobIdle : mats.dark
      }
    }

    /* --- manifest pylons and their references into the yard. */
    for (let i = 0; i < MAX_IMAGES; i++) {
      const py = pylons[i]
      const img = i < imageCount ? imageRefs[i] : undefined
      py.root.visible = img !== undefined
      if (!img) {
        for (let k = 0; k < LAYERS_PER_IMAGE; k++) py.beams[k].visible = false
        continue
      }
      const m = layerMask(img)
      py.mast.material = mats.manifestDim
      let k = 0
      for (let li = 0; li < N_LAYERS && k < LAYERS_PER_IMAGE; li++) {
        if ((m & (1 << li)) === 0) continue
        const chit = py.chits[k]
        chit.visible = true
        chit.material = transitMask & (1 << li) ? mats.manifest : mats.manifestDim

        /* Beam from this chit to the bay holding the layer. Both ends are in
         * group space, so the beam is placed with plain trigonometry. */
        const beam = py.beams[k]
        const x0 = py.root.position.x
        const z0 = MANIFEST_Z
        const y0 = CHIT_Y[k] + 1
        const x1 = bayX(li)
        const z1 = bayZ(li)
        const y1 = bayHeight(li) + 1
        const dx = x1 - x0
        const dz = z1 - z0
        const dy = y1 - y0
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
        beam.visible = true
        beam.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        beam.rotation.set(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), Math.atan2(dx, dz), 0)
        beam.scale.z = len
        beam.material = transitMask & (1 << li) ? mats.manifest : mats.manifestDim
        k++
      }
      for (; k < LAYERS_PER_IMAGE; k++) {
        py.chits[k].visible = false
        py.beams[k].visible = false
      }
    }

    /* --- the gate: lit while anything is being fetched through it. */
    const active = pullCount > 0
    manifestDoor.material = active ? mats.manifest : mats.manifestDim
    blobDoor.material = active ? mats.blob : mats.blobIdle
    gateMast.material = active ? mats.blob : mats.dim

    /* --- node boards. Three instanced draws for the whole yard. */
    let nRes = 0
    let nTra = 0
    let nAbs = 0
    for (let n = 0; n < N_NODES; n++) {
      const known = n < nNodes
      boards[n].root.visible = known
      if (!known) continue
      const resident = nodeMask[n]
      let inTransit = 0
      for (let k = 0; k < pullCount; k++) {
        if (pullNode[k] === n) inTransit |= layerMask(pullImage[k]) & ~resident
      }
      for (let i = 0; i < N_LAYERS; i++) {
        const p = (n * N_LAYERS + i) * 3
        _m4.makeTranslation(pipPos[p], pipPos[p + 1], pipPos[p + 2])
        const bit = 1 << i
        if (resident & bit) pipsResident.setMatrixAt(nRes++, _m4)
        else if (inTransit & bit) pipsTransit.setMatrixAt(nTra++, _m4)
        else pipsAbsent.setMatrixAt(nAbs++, _m4)
      }
      boards[n].lamp.material = inTransit
        ? mats.pending
        : cacheHit[n]
          ? mats.ready
          : mats.dim
    }
    pipsResident.count = nRes
    pipsTransit.count = nTra
    pipsAbsent.count = nAbs
    pipsResident.instanceMatrix.needsUpdate = true
    pipsTransit.instanceMatrix.needsUpdate = true
    pipsAbsent.instanceMatrix.needsUpdate = true

    /* --- convoys on the registry-to-nodes road. */
    for (let i = 0; i < MAX_PULLS; i++) {
      const cv = convoys[i]
      if (i >= pullCount) {
        cv.root.visible = false
        continue
      }
      cv.root.visible = true
      const ni = pullNode[i]
      const resident = nodeMask[ni]
      const need = layerMask(pullImage[i]) & ~resident
      /* A pull that has nothing to fetch never leaves the yard. */
      const u = need === 0 ? 0 : clamp(pullProgress[i], 0, 1)
      road.getPointAt(u, _v)
      cv.root.position.set(
        _v.x - _origin.x,
        _v.y - _origin.y + 4,
        _v.z - _origin.z + (ni - (N_NODES - 1) / 2) * 7,
      )

      const failed = pullState[i] === 2
      const backingOff = pullState[i] === 1
      const bedMat = failed
        ? Math.sin(t * 16) > 0
          ? mats.failedBright
          : mats.failed
        : backingOff
          ? mats.backoff
          : mats.blob
      cv.bed.material = bedMat
      cv.lamp.material = bedMat
      cv.lamp.position.y = 5 + (failed || backingOff ? 0 : Math.sin(t * 4) * 0.4)

      /* Crates are the layers this node is actually missing — the honest
       * payload. A convoy with one crate is a tag bump; four is a cold node. */
      let c = 0
      for (let li = 0; li < N_LAYERS && c < LAYERS_PER_IMAGE; li++) {
        if ((need & (1 << li)) === 0) continue
        const crate = cv.crates[c]
        crate.visible = true
        crate.scale.y = 0.6 + LAYER_MIB[li] * 0.035
        crate.material = bedMat
        c++
      }
      for (; c < LAYERS_PER_IMAGE; c++) cv.crates[c].visible = false
    }
  }

  function dispose(): void {
    offTheme()
    pipsResident.dispose()
    pipsTransit.dispose()
    pipsAbsent.dispose()
    for (let i = 0; i < geoms.length; i++) geoms[i].dispose()
    geoms.length = 0
    group.removeFromParent()
  }

  return { group, update, dispose }
}
