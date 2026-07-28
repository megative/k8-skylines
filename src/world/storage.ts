import * as THREE from 'three'
import { N_NODES } from '../core/types'
import type { CsiOperation, PvState, PvcState, SimState, StorageClassState } from '../core/types'
import { COLOR, ghost, mat, neon, structural } from '../core/theme'
import { approach, clamp } from '../core/util'
import { ANCHOR, CITY, routeCurve } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * THE STORAGE PLANT and the PV PARK — StorageClasses, PVCs, PVs, CSI.
 *
 * The plant sits in an excavation west of the city because a volume is the one
 * thing in a cluster that outlives the pod using it: it is below grade, and it
 * stays there while buildings above come and go.
 *
 * The teaching claims the geometry makes, in order:
 *   - A PVC is a *record*, so it is a ghost ticket. A PV is bytes on a disk, so
 *     it is solid matter. Binding is a physical coupling rod between them, and a
 *     Pending claim is visibly a ticket with nothing on the other end.
 *   - WaitForFirstConsumer is a barrier that stays down until the scheduler has
 *     picked a node for the pod that mounts the claim. Nothing is provisioned
 *     behind a closed barrier, which is why such a PVC can sit Pending forever
 *     if no pod ever mounts it.
 *   - Attach and mount are different operations done by different components.
 *     The attach station is controller-orange because the attach/detach
 *     controller does it cluster-side; the mount station is kubelet-teal because
 *     kubelet's volume manager does it on the node. Conflating them is why
 *     "Multi-Attach error" reads as nonsense the first time you hit it.
 *   - ReadWriteOnce is one socket. A second node demanding the same volume is
 *     refused at the collar, and that refusal is why a StatefulSet pod cannot
 *     move to another node instantly.
 * ==========================================================================*/

/** Drawn slots. The sim can hold more; these are the ones with a building. */
const MAX_SC = 4
const MAX_PVC = 10
const MAX_PV = 10
const MAX_OPS = 10

const HW = CITY.storage.w / 2
const HD = CITY.storage.d / 2
/** Local y of world y = 0. The plant's own floor is local y = 0. */
const GRADE = -CITY.storage.y

/* Local z of each zone, read against the plant anchor so the park lands exactly
 * on ANCHOR.pvPark rather than on a number that happens to look right. */
const PARK_Z = ANCHOR.pvPark[2] - ANCHOR.storagePlant[2]
const LINE_Z0 = -112
const LINE_PITCH = 26
const LINE_X0 = -76
const LINE_X1 = 76
const CSI_Z = 8
const TICKET_WAIT_Z = PARK_Z - 58
const TICKET_BOUND_Z = PARK_Z - 26
const TICKET_PITCH = 18
const TANK_PITCH = 19
const TANK_R = 7.2
const TANK_BASE_H = 8
/** A tank's barrel grows this many metres per requested GiB. */
const TANK_H_PER_GIB = 1.9
const RECLAIM_Z = PARK_Z + 18

/* Where each op class runs on the storage-to-nodes road. provision and delete
 * never leave the storage system, so they shuttle the plant end of it only. */
const OP_SPAN: Record<CsiOperation['op'], readonly [number, number]> = {
  provision: [0.02, 0.16],
  attach: [0.1, 0.72],
  mount: [0.72, 0.97],
  unmount: [0.97, 0.72],
  detach: [0.72, 0.1],
  delete: [0.16, 0.02],
}

/* Scratch. update() runs every frame and must allocate nothing. */
const _v = new THREE.Vector3()
const _origin = new THREE.Vector3(
  ANCHOR.storagePlant[0],
  ANCHOR.storagePlant[1],
  ANCHOR.storagePlant[2],
)

type Mats = ReturnType<typeof buildMats>
type MatKey = keyof Mats

function buildMats() {
  return {
    concrete: mat(structural('concrete'), 0.95),
    deck: mat(structural('deck'), 0.9),
    steel: mat(COLOR.edge, 0.72),
    dim: mat(COLOR.edge, 0.85),
    /* Storage sea-green: the mechanism colour for everything volume-shaped. */
    storage: neon(COLOR.storage, 1.5),
    storageSoft: neon(COLOR.storage, 0.7),
    /* Attach is the controller manager's job; mount is kubelet's. */
    attach: neon(COLOR.controller, 1.5),
    attachSoft: neon(COLOR.controller, 0.6),
    mount: neon(COLOR.kubelet, 1.5),
    mountSoft: neon(COLOR.kubelet, 0.6),
    ready: neon(COLOR.ready, 1.5),
    pending: neon(COLOR.pending, 1.6),
    failed: neon(COLOR.failed, 1.6),
    failedBright: neon(COLOR.failed, 3.2),
    terminating: neon(COLOR.terminating, 1.4),
    /* A claim is a record, not a disk. Records are ghosts. */
    claim: ghost(COLOR.desired, 0.3),
    claimDim: ghost(COLOR.desired, 0.14),
  }
}

interface Line {
  root: THREE.Group
  head: THREE.Mesh
  beacon: THREE.Mesh
  arm: THREE.Mesh
  armPivot: THREE.Group
  waitLamps: THREE.Mesh[]
  crusher: THREE.Mesh
  siding: THREE.Mesh
  expansion: THREE.Mesh
  shuttle: THREE.Mesh
  rail: THREE.Mesh
}

interface Tank {
  root: THREE.Group
  barrel: THREE.Mesh
  band: THREE.Mesh
  collar: THREE.Mesh
  sockets: THREE.Mesh[]
  lock: THREE.Mesh
  nodePips: THREE.Mesh[]
  refuse: THREE.Mesh
  mast: THREE.Mesh
}

interface Ticket {
  root: THREE.Group
  card: THREE.Mesh
  lamp: THREE.Mesh
  hook: THREE.Mesh
  rod: THREE.Mesh
}

interface Carrier {
  root: THREE.Group
  bed: THREE.Mesh
  flag: THREE.Mesh
  mast: THREE.Mesh
}

export function createStorage(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'storage'
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
  /** A mesh whose material is reassigned every frame; not tracked in statics. */
  function dyn(g: THREE.BufferGeometry, k: MatKey, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(g, mats[k])
    parent.add(m)
    return m
  }

  /* ------------------------------------------------------------ the basin */

  const floor = mesh(box(CITY.storage.w, 1.6, CITY.storage.d), 'concrete', group)
  floor.position.y = -0.8

  /* Retaining walls rise from the plant floor to just above grade, so the rim
   * reads as a cut in the ground rather than a wall standing on it. */
  const wallLong = box(CITY.storage.w + 4, GRADE + 2, 3)
  const wallSide = box(3, GRADE + 2, CITY.storage.d + 4)
  for (let i = 0; i < 2; i++) {
    const w = mesh(wallLong, 'concrete', group)
    w.position.set(0, (GRADE + 2) / 2 - 1, (i ? 1 : -1) * (HD + 1.5))
    const s = mesh(wallSide, 'concrete', group)
    s.position.set((i ? 1 : -1) * (HW + 1.5), (GRADE + 2) / 2 - 1, 0)
  }
  /* Grade line: a lip at world y = 0 so you can read how deep the plant sits. */
  const lipGeo = box(CITY.storage.w + 10, 0.8, CITY.storage.d + 10)
  const lip = mesh(lipGeo, 'deck', group)
  lip.position.y = GRADE

  /* The working level stands at grade; only the plant's plumbing — the volume
   * road out to the nodes, which layout puts at y = -34 — stays buried. */
  const plaza = new THREE.Group()
  plaza.position.y = GRADE
  group.add(plaza)

  /* ------------------------------------------------ StorageClass lines */

  const railGeo = box(LINE_X1 - LINE_X0, 0.9, 3.2)
  const headGeo = box(13, 11, 13)
  const beaconGeo = geo(new THREE.ConeGeometry(1.8, 4, 6))
  /* Hinged at one end: the shared geometry is offset once here, never per line. */
  const armGeo = box(1.1, 1.1, 13)
  armGeo.translate(0, 0, 6.5)
  const lampGeo = geo(new THREE.IcosahedronGeometry(1.05, 0))
  const crusherGeo = box(11, 9, 11)
  const sidingGeo = box(11, 3.2, 11)
  const expansionGeo = geo(new THREE.CylinderGeometry(0.9, 1.3, 9, 8))
  const shuttleGeo = box(4.4, 3.2, 5.2)

  const lines: Line[] = []
  for (let i = 0; i < MAX_SC; i++) {
    const root = new THREE.Group()
    root.position.set(0, 0, LINE_Z0 + i * LINE_PITCH)
    plaza.add(root)

    const rail = mesh(railGeo, 'steel', root)
    rail.position.set((LINE_X0 + LINE_X1) / 2, 1.2, 0)

    /* The provisioner: the CSI driver's controller plugin, which is what
     * actually creates the volume in the backing storage system. */
    const head = dyn(headGeo, 'dim', root)
    head.position.set(LINE_X0 + 6, 5.5, 0)
    const beacon = dyn(beaconGeo, 'storage', root)
    beacon.position.set(LINE_X0 + 6, 13, 0)
    beacon.visible = false

    /* The binding-mode barrier. Down means nothing may be provisioned yet. */
    const armPivot = new THREE.Group()
    armPivot.position.set(LINE_X0 + 26, 4.4, 0)
    root.add(armPivot)
    const arm = dyn(armGeo, 'pending', armPivot)

    const waitLamps: THREE.Mesh[] = []
    for (let k = 0; k < 4; k++) {
      const l = dyn(lampGeo, 'pending', root)
      l.position.set(LINE_X0 + 34 + k * 3.2, 2.6, -5.5)
      l.visible = false
      waitLamps.push(l)
    }

    const expansion = dyn(expansionGeo, 'storageSoft', root)
    expansion.position.set(LINE_X0 + 16, 5, -7.5)

    const shuttle = dyn(shuttleGeo, 'storage', root)
    shuttle.position.set(LINE_X0 + 6, 3.4, 0)
    shuttle.visible = false

    /* Reclaim tail: exactly one of these is the class's policy, and the two are
     * different machines because Delete destroys the volume and Retain does not. */
    const crusher = dyn(crusherGeo, 'terminating', root)
    crusher.position.set(LINE_X1 - 6, 4.5, 0)
    const siding = dyn(sidingGeo, 'storageSoft', root)
    siding.position.set(LINE_X1 - 6, 1.6, 0)

    /* Names are the handle tests and the console use to reach one slot. */
    root.name = `sc-line-${i}`
    armPivot.name = `sc-barrier-${i}`
    shuttle.name = `sc-shuttle-${i}`
    crusher.name = `sc-crusher-${i}`
    siding.name = `sc-siding-${i}`
    lines.push({ root, head, beacon, arm, armPivot, waitLamps, crusher, siding, expansion, shuttle, rail })
  }

  /* ------------------------------------------------------- the CSI plant */

  const csiHouse = new THREE.Group()
  csiHouse.position.set(0, 0, CSI_Z)
  plaza.add(csiHouse)

  const attachStation = new THREE.Group()
  attachStation.position.set(-34, 0, 0)
  csiHouse.add(attachStation)
  const attachShed = mesh(box(26, 13, 20), 'deck', attachStation)
  attachShed.position.y = 6.5
  const attachMast = dyn(box(2.2, 12, 2.2), 'attach', attachStation)
  attachMast.position.set(0, 19, 0)
  /* One rack slot per VolumeAttachment the cluster could hold: the attach
   * station's inventory is an API object list, not a device list. */
  const vaGeo = box(3.4, 1.4, 7)
  const vaSlots: THREE.Mesh[] = []
  for (let i = 0; i < MAX_PV; i++) {
    const m = dyn(vaGeo, 'dim', attachStation)
    m.position.set(-11 + (i % 5) * 5.5, 14.6 + Math.floor(i / 5) * 2, 0)
    m.visible = false
    vaSlots.push(m)
  }

  const mountStation = new THREE.Group()
  mountStation.position.set(34, 0, 0)
  csiHouse.add(mountStation)
  const mountShed = mesh(box(26, 13, 20), 'deck', mountStation)
  mountShed.position.y = 6.5
  const mountMast = dyn(box(2.2, 12, 2.2), 'mount', mountStation)
  mountMast.position.set(0, 19, 0)
  /* Two stages, because the node plugin has two calls: NodeStageVolume once per
   * node (the global mount) and NodePublishVolume once per pod (the bind mount). */
  const stageGeo = geo(new THREE.CylinderGeometry(2.2, 2.2, 6, 10))
  const stageMount = dyn(stageGeo, 'mountSoft', mountStation)
  stageMount.position.set(-6, 16, 0)
  const publishMount = dyn(stageGeo, 'mountSoft', mountStation)
  publishMount.position.set(6, 16, 0)

  /* The road out. Dispatch stands on the first point of storage-to-nodes, which
   * layout places below grade — volumes reach the nodes underground. The riser
   * is the only thing tying that buried road to the plant above it. */
  const dispatch = mesh(box(9, 4, 9), 'steel', group)
  dispatch.position.set(0, 2, 0)
  const riser = mesh(box(5, GRADE, 5), 'steel', group)
  riser.position.set(0, GRADE / 2, 0)

  /* ---------------------------------------------------- the claim office */

  const office = new THREE.Group()
  plaza.add(office)
  const officeDeck = mesh(box(CITY.storage.w - 20, 1, 20), 'deck', office)
  officeDeck.position.set(0, 0.5, TICKET_WAIT_Z)

  const cardGeo = box(9, 12, 0.7)
  const hookGeo = box(2.2, 2.2, 2.2)
  const rodGeo = box(1.4, 1.4, 1)
  const tickets: Ticket[] = []
  /* Ticket positions are animated, so their current x/z live here rather than
   * being re-derived from the scene graph. */
  const ticketPos = new Float32Array(MAX_PVC * 2)
  for (let i = 0; i < MAX_PVC; i++) {
    const root = new THREE.Group()
    const x = (i - (MAX_PVC - 1) / 2) * TICKET_PITCH
    root.position.set(x, 1, TICKET_WAIT_Z)
    ticketPos[i * 2] = x
    ticketPos[i * 2 + 1] = TICKET_WAIT_Z
    office.add(root)

    const card = dyn(cardGeo, 'claim', root)
    card.position.y = 7
    const lamp = dyn(lampGeo, 'pending', root)
    lamp.position.set(0, 14.4, 0)
    /* The coupling half that belongs to the claim. It is empty until a PV is
     * bound to it, and that emptiness is the whole of "Pending". */
    const hook = dyn(hookGeo, 'claimDim', root)
    hook.position.set(0, 4, 4)
    const rod = dyn(rodGeo, 'ready', root)
    rod.position.set(0, 4, 8)
    rod.visible = false

    root.name = `pvc-ticket-${i}`
    rod.name = `pvc-coupling-${i}`
    hook.name = `pvc-hook-${i}`
    tickets.push({ root, card, lamp, hook, rod })
  }

  /* --------------------------------------------------------- the PV park */

  const parkDeck = mesh(box(CITY.storage.w - 8, 1.2, 34), 'deck', plaza)
  parkDeck.position.set(0, 0.6, PARK_Z)

  const barrelGeo = geo(new THREE.CylinderGeometry(TANK_R, TANK_R, 1, 14))
  /* Unit height, anchored at its base, so scale.y is capacity in metres. */
  barrelGeo.translate(0, 0.5, 0)
  const bandGeo = geo(new THREE.TorusGeometry(TANK_R + 0.5, 0.5, 6, 18))
  const collarGeo = geo(new THREE.CylinderGeometry(TANK_R + 1.4, TANK_R + 1.4, 1.8, 14))
  const socketGeo = box(2.2, 2.2, 3.4)
  const lockGeo = geo(new THREE.TorusGeometry(2.6, 0.42, 6, 14))
  const pipGeo = box(1.5, 1.5, 1.5)
  const refuseGeo = geo(new THREE.TorusGeometry(TANK_R + 3.4, 0.7, 6, 20))
  const mastGeo = box(0.9, 10, 0.9)

  const tanks: Tank[] = []
  for (let i = 0; i < MAX_PV; i++) {
    const root = new THREE.Group()
    root.position.set((i - (MAX_PV - 1) / 2) * TANK_PITCH, 1.2, PARK_Z)
    plaza.add(root)

    const barrel = dyn(barrelGeo, 'steel', root)
    barrel.scale.y = TANK_BASE_H
    const band = dyn(bandGeo, 'storage', root)
    band.rotation.x = Math.PI / 2
    const collar = dyn(collarGeo, 'dim', root)
    collar.position.y = 0.9

    /* Sockets are access modes made physical: one for ReadWriteOnce, three for
     * ReadWriteMany. A socket is a node that may hold this volume at once. */
    const sockets: THREE.Mesh[] = []
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k - 1) * 0.7
      const s = dyn(socketGeo, 'dim', root)
      s.position.set(Math.cos(a) * (TANK_R + 1.6), 1, Math.sin(a) * (TANK_R + 1.6))
      s.rotation.y = -a
      sockets.push(s)
    }
    const lock = dyn(lockGeo, 'storageSoft', root)
    lock.position.set(0, 1, -(TANK_R + 3))
    lock.rotation.x = Math.PI / 2

    const mast = dyn(mastGeo, 'dim', root)
    mast.position.set(0, 5, -(TANK_R + 3))
    /* One pip per node: the lit pip is the node currently holding the
     * attachment, which for ReadWriteOnce is at most one, forever. */
    const nodePips: THREE.Mesh[] = []
    for (let n = 0; n < N_NODES; n++) {
      const p = dyn(pipGeo, 'dim', root)
      p.position.set((n - (N_NODES - 1) / 2) * 2.4, 10.4, -(TANK_R + 3))
      nodePips.push(p)
    }

    const refuse = dyn(refuseGeo, 'failed', root)
    refuse.rotation.x = Math.PI / 2
    refuse.position.y = 3
    refuse.visible = false

    root.name = `pv-tank-${i}`
    refuse.name = `pv-refused-${i}`
    for (let k = 0; k < 3; k++) sockets[k].name = `pv-socket-${i}-${k}`
    tanks.push({ root, barrel, band, collar, sockets, lock, nodePips, refuse, mast })
  }

  /* ----------------------------------------------------- reclaim tail */

  const crusherHouse = dyn(box(20, 14, 16), 'terminating', plaza)
  crusherHouse.position.set(58, 7, RECLAIM_Z)
  const sidingPad = dyn(box(30, 1.6, 14), 'storageSoft', plaza)
  sidingPad.position.set(-58, 0.8, RECLAIM_Z)
  const sidingBumper = mesh(box(3, 5, 14), 'steel', plaza)
  sidingBumper.position.set(-74, 3, RECLAIM_Z)

  /* --------------------------------------------------- the CSI carriers */

  const road = routeCurve('storage-to-nodes')
  /* Prime the arc-length table once; getPointAt() must not build it per frame. */
  road.getLengths(200)

  const bedGeo = box(6.4, 2.2, 9)
  const flagGeo = geo(new THREE.ConeGeometry(1.6, 4.2, 5))
  /* Unit mast, anchored at its base: an operation running under the ground
   * still has to be findable from the surface. */
  const carrierMastGeo = box(0.8, 1, 0.8)
  carrierMastGeo.translate(0, 0.5, 0)
  const carriers: Carrier[] = []
  for (let i = 0; i < MAX_OPS; i++) {
    const root = new THREE.Group()
    root.visible = false
    group.add(root)
    const bed = dyn(bedGeo, 'storage', root)
    const flag = dyn(flagGeo, 'storage', root)
    flag.position.y = 3.2
    const mast = dyn(carrierMastGeo, 'storageSoft', root)
    mast.visible = false
    root.name = `csi-carrier-${i}`
    carriers.push({ root, bed, flag, mast })
  }

  /* ------------------------------------------------------------ registry */

  const F_PLANT: [number, number, number] = [CITY.storage.x + 210, 90, CITY.storage.z - 40]
  const F_PARK: [number, number, number] = [
    CITY.storage.x + 150,
    50,
    ANCHOR.pvPark[2] - 60,
  ]

  const pvcOf = (s: SimState, i: number): PvcState | undefined => s.pvcs[i]
  const classOf = (s: SimState, name: string): StorageClassState | undefined => {
    for (let i = 0; i < s.storageClasses.length; i++) {
      if (s.storageClasses[i].name === name) return s.storageClasses[i]
    }
    return undefined
  }

  ctx.registry.register({
    id: 'storage.plant',
    title: 'Storage plant',
    district: 'storage',
    kubeName: 'CSI · PersistentVolume subsystem',
    summary:
      'Where volumes are created, bound, attached and mounted — below grade, because a volume outlives the pod that uses it.',
    detail: [
      'Nothing in this plant runs on the pods it serves. A StorageClass is a template, a PersistentVolumeClaim is a request record, a PersistentVolume is the actual storage, and CSI drivers are the machinery that turns one into the other.',
      'The plant is west of the city and below grade because storage is the only part of a cluster with real state. A pod is disposable and its filesystem dies with it; a PV survives the pod, the node, and usually the cluster that created it.',
      'Reading order from north to south: the provisioning lines (one per StorageClass), the CSI plant with its separate attach and mount stations, the claim office where PVCs wait, and the PV park where the volumes themselves stand.',
    ],
    caveats: [
      `${MAX_SC} StorageClasses, ${MAX_PVC} claims, ${MAX_PV} volumes and ${MAX_OPS} in-flight CSI operations are drawn; the model may hold more.`,
      'Static provisioning by an administrator, volume snapshots, volume cloning, ephemeral CSI volumes and generic ephemeral volumes are not modelled.',
      'Real CSI drivers run as pods in the cluster — a controller Deployment and a node DaemonSet. Here they are drawn as fixed plant, so the fact that a CSI driver is itself a workload is lost.',
    ],
    object: group,
    focus: F_PLANT,
    keywords: ['storage', 'csi', 'volume', 'pv', 'pvc', 'persistent'],
    metrics: (s) => [
      { label: 'StorageClasses', value: `${s.storageClasses.length}` },
      {
        label: 'PVCs',
        value: `${s.pvcs.filter((c) => c.phase === 'Bound').length} Bound / ${s.pvcs.length}`,
      },
      { label: 'PVs', value: `${s.pvs.length}` },
      { label: 'CSI operations in flight', value: `${s.csiOps.length}` },
    ],
  })

  const scEntry = ctx.registry.register({
    id: 'storage.storageclass',
    title: 'StorageClass provisioning lines',
    district: 'storage',
    kubeName: 'StorageClass',
    summary:
      'One line per StorageClass: its provisioner, its binding mode barrier, and the reclaim machine at the tail.',
    detail: [
      'A StorageClass is not storage. It is a named recipe: which provisioner to call, what parameters to pass it, when to bind, and what to do with the volume when the claim goes away. Pick a class by name in a PVC and you have chosen all four.',
      'The head of each line is the provisioner — a CSI driver name such as ebs.csi.aws.com or pd.csi.storage.gke.io. When a claim of this class needs a volume, the external-provisioner sidecar watching that claim calls CreateVolume on that driver, and a new tank appears in the park.',
      'The barrier partway down the line is the binding mode. Immediate provisions as soon as the claim exists. WaitForFirstConsumer keeps the barrier down until the scheduler has chosen a node for the first pod that mounts the claim.',
      'The machine at the tail is the reclaim policy, and the two machines are different on purpose: Delete destroys the volume with the claim, Retain keeps it and requires a human to clean it up.',
      'The class marked with a telescoping post has allowVolumeExpansion: true, so editing the claim to ask for more capacity actually grows the volume. Without it, that edit is rejected.',
    ],
    caveats: [
      'Class parameters (volume type, IOPS, filesystem, encryption) and mountOptions are not drawn; they are the bulk of a real StorageClass.',
      'The default class annotation (storageclass.kubernetes.io/is-default-class), which fills in an empty storageClassName at admission time, is not shown.',
      'allowedTopologies, which restricts where a volume may be created, is not modelled.',
    ],
    object: lines[0].root,
    focus: [CITY.storage.x + 130, 60, CITY.storage.z - 90],
    keywords: ['storageclass', 'provisioner', 'sc', 'default class', 'expansion'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.storageClasses.length; i++) {
        const c = s.storageClasses[i]
        out.push({
          label: c.name,
          value: `${c.provisioner}`,
          hint: `${c.bindingMode} · reclaim ${c.reclaimPolicy}${c.allowExpansion ? ' · expandable' : ''}`,
        })
      }
      if (out.length === 0) out.push({ label: 'classes', value: 'none defined' })
      return out
    },
  })
  for (let i = 0; i < lines.length; i++) {
    ctx.registry.bind(lines[i].root, scEntry)
    ctx.registry.bind(lines[i].rail, scEntry)
    ctx.registry.bind(lines[i].head, scEntry)
  }

  const provEntry = ctx.registry.register({
    id: 'storage.dynamic-provisioning',
    title: 'Dynamic provisioning',
    district: 'storage',
    kubeName: 'external-provisioner · CreateVolume',
    summary:
      'A claim with a StorageClass causes a volume to be created on demand. Nobody has to pre-build PVs.',
    detail: [
      'Before dynamic provisioning, an administrator created PersistentVolume objects by hand and users hoped one of them matched. A StorageClass replaces that with a promise: ask for 10Gi of this class and one will exist.',
      'The mechanics are a controller loop, not magic. The external-provisioner sidecar watches PVCs whose storageClassName names its driver, calls CreateVolume over the CSI gRPC socket, and then creates a PersistentVolume object describing what the backend produced. The pv-binder controller then binds the claim to it.',
      'The provisioned PV carries the claim in spec.claimRef before anyone else can take it, which is why dynamic provisioning never produces a volume that some other claim steals.',
      'A failure here is loud: the claim stays Pending and its events read ProvisioningFailed with the driver\'s own message — out of capacity, quota exceeded, bad parameters, or no such zone.',
    ],
    caveats: [
      'CreateVolume is drawn as one shuttle over a few seconds. Real cloud provisioning takes tens of seconds and is retried with exponential backoff.',
      'The provisioner is drawn as fixed plant. It really runs as a sidecar container next to the CSI controller, watching the API server like any other controller.',
    ],
    object: lines[0].head,
    focus: [CITY.storage.x - 40, 46, CITY.storage.z - 90],
    keywords: ['provision', 'dynamic', 'createvolume', 'external-provisioner', 'provisioningfailed'],
    metrics: (s) => {
      let n = 0
      for (let i = 0; i < s.csiOps.length; i++) if (s.csiOps[i].op === 'provision') n++
      return [
        { label: 'provisioning now', value: `${n}` },
        { label: 'claims Pending', value: `${s.pvcs.filter((c) => c.phase === 'Pending').length}` },
        { label: 'volumes in the park', value: `${s.pvs.length}` },
      ]
    },
  })
  for (let i = 0; i < lines.length; i++) ctx.registry.bind(lines[i].shuttle, provEntry)

  const wffcEntry = ctx.registry.register({
    id: 'storage.wait-for-first-consumer',
    title: 'WaitForFirstConsumer',
    district: 'storage',
    kubeName: 'volumeBindingMode: WaitForFirstConsumer',
    summary:
      'The barrier that keeps a claim Pending on purpose until a pod using it has been scheduled.',
    detail: [
      'With volumeBindingMode: Immediate, a PVC is provisioned and bound the moment it is created — in whatever zone the provisioner feels like. If the pod that mounts it later cannot be scheduled in that zone, the pod is stuck forever with "node(s) had volume node affinity conflict".',
      'WaitForFirstConsumer inverts the order. The claim sits Pending, the barrier stays down, and nothing is provisioned. The scheduler picks a node for the pod first, writes the annotation volume.kubernetes.io/selected-node onto the claim, and only then does the provisioner create a volume in the right topology.',
      'This is the single most confusing Pending in Kubernetes, because the claim is Pending for a reason that has nothing to do with storage. Its event says "waiting for first consumer to be created before binding". If no pod ever mounts the claim, it stays Pending forever, and that is correct behaviour.',
      'It also means the dependency runs both ways: the pod waits for the volume, and the volume waits for the pod\'s node. The scheduler\'s VolumeBinding plugin is what breaks the cycle.',
    ],
    caveats: [
      'The selected-node annotation is modelled as a state flag on the claim rather than as a visible API write.',
      'Topology-aware provisioning across zones is implied by the barrier but no zones are drawn — every node here is in one topology domain.',
    ],
    object: lines[0].armPivot,
    focus: [CITY.storage.x - 15, 44, CITY.storage.z - 90],
    keywords: [
      'waitforfirstconsumer',
      'wffc',
      'binding mode',
      'pending',
      'selected-node',
      'topology',
    ],
    metrics: (s) => {
      let waiting = 0
      for (let i = 0; i < s.pvcs.length; i++) if (s.pvcs[i].waitingForConsumer) waiting++
      return [
        { label: 'claims held at the barrier', value: `${waiting}` },
        {
          label: 'classes with WaitForFirstConsumer',
          value: `${s.storageClasses.filter((c) => c.bindingMode === 'WaitForFirstConsumer').length} of ${s.storageClasses.length}`,
        },
      ]
    },
  })
  for (let i = 0; i < lines.length; i++) {
    ctx.registry.bind(lines[i].arm, wffcEntry)
    for (let k = 0; k < lines[i].waitLamps.length; k++) {
      ctx.registry.bind(lines[i].waitLamps[k], wffcEntry)
    }
  }

  const reclaimEntry = ctx.registry.register({
    id: 'storage.reclaim-policy',
    title: 'Reclaim policy: Delete vs Retain',
    district: 'storage',
    kubeName: 'persistentVolumeReclaimPolicy',
    summary: 'What happens to the bytes when the claim is deleted. Delete destroys them; Retain does not.',
    detail: [
      'Deleting a PVC does not immediately delete anything: the kubernetes.io/pvc-protection finalizer holds the claim in Terminating for as long as a pod still mounts it. Only once no pod uses it does the claim actually go away.',
      'Then the reclaim policy decides. With Delete, the PV object is removed and the driver\'s DeleteVolume destroys the backing disk — the crusher at the end of the line. Dynamically provisioned volumes default to Delete, so a stray `kubectl delete pvc` is a data-loss command.',
      'With Retain, the PV moves to phase Released and stays exactly where it is, holding its data and its stale claimRef. It is not Available and no new claim can bind to it until an administrator clears that claimRef or recreates the PV. The siding is deliberately a dead end.',
      'The third policy, Recycle, is deprecated and does not exist for CSI volumes.',
    ],
    caveats: [
      'Deletion is animated as a tank sinking into the crusher over a few seconds. A real DeleteVolume is an API call to the storage backend and may fail and retry indefinitely, leaving the PV in Failed.',
      'Finalizer mechanics (pvc-protection, pv-protection) are described here but not drawn as objects.',
    ],
    object: crusherHouse,
    focus: [CITY.storage.x + 90, 46, ANCHOR.pvPark[2] + 40],
    keywords: ['reclaim', 'delete', 'retain', 'released', 'finalizer', 'data loss'],
    metrics: (s) => [
      { label: 'Released volumes', value: `${s.pvs.filter((v) => v.phase === 'Released').length}` },
      { label: 'Failed volumes', value: `${s.pvs.filter((v) => v.phase === 'Failed').length}` },
      {
        label: 'classes reclaiming with Delete',
        value: `${s.storageClasses.filter((c) => c.reclaimPolicy === 'Delete').length} of ${s.storageClasses.length}`,
      },
    ],
  })
  ctx.registry.bind(sidingPad, reclaimEntry)
  ctx.registry.bind(sidingBumper, reclaimEntry)
  for (let i = 0; i < lines.length; i++) {
    ctx.registry.bind(lines[i].crusher, reclaimEntry)
    ctx.registry.bind(lines[i].siding, reclaimEntry)
  }

  const pvcEntry = ctx.registry.register({
    id: 'storage.pvc',
    title: 'PersistentVolumeClaim tickets',
    district: 'storage',
    kubeName: 'PersistentVolumeClaim',
    summary:
      'A claim is a request record, not storage — so it is drawn as a ghost ticket with an empty coupling.',
    detail: [
      'A PVC says what a pod needs: a size, an access mode, and usually a StorageClass. It holds no data and occupies no disk. That is why it is a hologram here and the tank is solid.',
      'A pod referencing a PVC cannot start until that claim is Bound. kubelet will not create the sandbox, so the pod sits in Pending with the event "pod has unbound immediate PersistentVolumeClaims". The pod is not broken; it is waiting on this ticket.',
      'The claim is namespaced and the volume is not. A PVC in namespace shop can never be bound by a pod in namespace default, even to the same underlying disk — that boundary is the entire access control story for volumes.',
      'Editing a bound claim to ask for more capacity works only if the StorageClass has allowVolumeExpansion; the request field is otherwise immutable, and every other field always is.',
    ],
    caveats: [
      'One ticket per claim is drawn up to ' + MAX_PVC + '. Requested capacity is shown in the inspector rather than in the ticket\'s size.',
      'Claims that select a volume by label selector instead of by class are not modelled.',
    ],
    object: tickets[0].card,
    focus: [CITY.storage.x + 130, 40, ANCHOR.storagePlant[2] + TICKET_WAIT_Z - 60],
    keywords: ['pvc', 'claim', 'persistentvolumeclaim', 'pending', 'unbound'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.pvcs.length; i++) {
        const c = s.pvcs[i]
        out.push({
          label: `${c.namespace}/${c.name}`,
          value: `${c.phase} · ${c.requestGib}Gi · ${c.storageClass}`,
          hint: c.waitingForConsumer
            ? 'waiting for first consumer to be created before binding'
            : c.boundPv
              ? `bound to ${c.boundPv}`
              : undefined,
        })
      }
      if (out.length === 0) out.push({ label: 'claims', value: 'none' })
      return out
    },
  })
  for (let i = 0; i < tickets.length; i++) {
    ctx.registry.bind(tickets[i].root, pvcEntry)
    ctx.registry.bind(tickets[i].lamp, pvcEntry)
  }

  const pvEntry = ctx.registry.register({
    id: 'storage.pv',
    title: 'PersistentVolume park',
    district: 'storage',
    kubeName: 'PersistentVolume',
    summary: 'The actual storage: cluster-scoped tanks that outlive pods, nodes and namespaces.',
    detail: [
      'A PV is a cluster-scoped object describing a real piece of storage — a cloud disk, a LUN, an NFS export — plus the CSI driver and volume handle needed to reach it. It is the only object in this district that corresponds to bytes.',
      'Its phase is about ownership, not health: Available means nothing claims it, Bound means exactly one claim does, Released means the claim is gone but the data is not, and Failed means automatic reclamation broke.',
      'A tank grows with its capacity, and the band around it carries its phase. The collar at the base is where nodes attach, and the mast above it shows which node currently holds the attachment.',
      'PVs are not namespaced. That is why a Released volume from one team\'s namespace is visible to every namespace and must be cleaned up by an administrator, not by the team.',
    ],
    caveats: [
      `${MAX_PV} tanks are drawn.`,
      'Every volume here is dynamically provisioned block storage. Statically provisioned PVs, hostPath, local volumes and NFS-style shared filesystems have different attach and mount semantics.',
      'Capacity is drawn as barrel height on a compressed scale so a 1Gi and a 100Gi volume both fit on screen.',
    ],
    object: tanks[0].barrel,
    focus: F_PARK,
    keywords: ['pv', 'persistentvolume', 'volume', 'available', 'released', 'capacity'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.pvs.length; i++) {
        const v = s.pvs[i]
        out.push({
          label: v.name,
          value: `${v.phase} · ${v.capacityGib}Gi · ${v.accessMode}`,
          hint: v.attachedNode ? `attached to ${v.attachedNode}` : 'not attached to any node',
        })
      }
      if (out.length === 0) out.push({ label: 'volumes', value: 'none' })
      return out
    },
  })
  for (let i = 0; i < tanks.length; i++) {
    ctx.registry.bind(tanks[i].root, pvEntry)
    ctx.registry.bind(tanks[i].band, pvEntry)
  }

  const bindEntry = ctx.registry.register({
    id: 'storage.binding',
    title: 'Binding: the coupling rod',
    district: 'storage',
    kubeName: 'pv-binder controller',
    summary: 'Binding is a two-way pointer written by a controller, and it is exclusive and permanent.',
    detail: [
      'The PersistentVolume binder inside kube-controller-manager watches claims and volumes, matches a Pending claim against an Available volume of the right class, size and access mode, and writes both halves of the link: claim.spec.volumeName and volume.spec.claimRef.',
      'The coupling rod is drawn as one piece because the binding is one fact stored twice. Both writes go through the API server, and until both exist the claim is not Bound.',
      'A binding is exclusive and it is for life. One PVC binds to exactly one PV and never re-binds; you cannot swap the volume under a claim, and deleting the claim does not free the volume for reuse unless the reclaim policy says so.',
      'A ticket with no rod is Pending, and the reason matters: no volume matched, provisioning has not finished, or the binding mode is waiting for a consumer. All three look identical in `kubectl get pvc`, which is why the events are the only useful diagnostic.',
    ],
    caveats: [
      'The matching rule is drawn as instantaneous. The real binder runs on a resync loop and may take a moment to notice a newly Available volume.',
      'Pre-binding — a PV created with claimRef already filled in to reserve it for a specific claim — is not modelled.',
    ],
    object: tickets[0].rod,
    focus: [CITY.storage.x + 120, 40, ANCHOR.pvPark[2] - 70],
    keywords: ['bind', 'binding', 'bound', 'claimref', 'volumename', 'pv-binder'],
    metrics: (s) => {
      let bound = 0
      let pending = 0
      let waiting = 0
      for (let i = 0; i < s.pvcs.length; i++) {
        const c = s.pvcs[i]
        if (c.phase === 'Bound') bound++
        else if (c.phase === 'Pending') {
          pending++
          if (c.waitingForConsumer) waiting++
        }
      }
      return [
        { label: 'Bound', value: `${bound}` },
        { label: 'Pending', value: `${pending}` },
        { label: '…of which waiting for a consumer', value: `${waiting}` },
        { label: 'Available volumes', value: `${s.pvs.filter((v) => v.phase === 'Available').length}` },
      ]
    },
  })
  for (let i = 0; i < tickets.length; i++) ctx.registry.bind(tickets[i].hook, bindEntry)

  const accessEntry = ctx.registry.register({
    id: 'storage.access-modes',
    title: 'Access modes and the exclusive socket',
    district: 'storage',
    kubeName: 'accessModes: ReadWriteOnce',
    summary:
      'ReadWriteOnce is one socket: one node holds the volume, and a second node demanding it is refused.',
    detail: [
      'ReadWriteOnce means one *node*, not one pod. Several pods on the same node can share an RWO volume happily; a pod on a second node cannot, because the disk can only be attached in one place at a time. ReadWriteOncePod, added later, is the mode that actually means one pod.',
      'ReadWriteMany requires a filesystem that supports it — NFS, CephFS, EFS. Ordinary block storage cannot do it, and asking for RWX from a block driver fails at provisioning, not at mount.',
      'The red ring is a refused attach: "Multi-Attach error for volume — volume is already exclusively attached to one node and cannot be attached to another". You see it whenever a pod with an RWO volume is rescheduled onto a different node while the old node still holds the attachment.',
      'This is why a StatefulSet pod cannot move instantly. The new pod cannot start until the old attachment is gone, and if the old node is unreachable rather than cleanly shut down, the controller cannot know whether the old process is still writing. It waits, and it is right to wait — force-deleting the pod risks two writers on one disk and a corrupted filesystem.',
    ],
    caveats: [
      'ReadWriteOncePod is described but not drawn as a fourth socket configuration.',
      'The out-of-service taint (node.kubernetes.io/out-of-service), which lets an operator declare a dead node safe to detach from, is not modelled.',
      'Filesystem-level sharing semantics for ReadWriteMany are not simulated; the extra sockets only show that more than one node may attach.',
    ],
    object: tanks[0].collar,
    focus: F_PARK,
    keywords: [
      'accessmodes',
      'readwriteonce',
      'rwo',
      'rwx',
      'multi-attach',
      'statefulset',
      'exclusive',
    ],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      let refused = 0
      for (let i = 0; i < s.csiOps.length; i++) {
        const o = s.csiOps[i]
        if (o.op === 'attach' && o.failed) refused++
      }
      out.push({ label: 'attachments refused', value: `${refused}` })
      for (let i = 0; i < s.pvs.length; i++) {
        const v = s.pvs[i]
        out.push({
          label: v.name,
          value: v.accessMode,
          hint: v.attachedNode ? `held by ${v.attachedNode}` : 'free',
        })
      }
      return out
    },
  })
  for (let i = 0; i < tanks.length; i++) {
    for (let k = 0; k < 3; k++) ctx.registry.bind(tanks[i].sockets[k], accessEntry)
    ctx.registry.bind(tanks[i].lock, accessEntry)
    ctx.registry.bind(tanks[i].refuse, accessEntry)
  }

  const csiEntry = ctx.registry.register({
    id: 'storage.csi',
    title: 'CSI driver',
    district: 'storage',
    kubeName: 'Container Storage Interface',
    summary:
      'A gRPC contract between Kubernetes and a storage vendor, with a controller half and a node half.',
    detail: [
      'CSI exists so that storage vendors stop shipping code inside the Kubernetes binary. A driver is an ordinary workload implementing three gRPC services — Identity, Controller and Node — and Kubernetes calls them through sidecars it maintains itself.',
      'The controller half runs once in the cluster: CreateVolume, DeleteVolume, ControllerPublishVolume (attach) and ControllerUnpublishVolume (detach). The node half runs on every node as a DaemonSet: NodeStageVolume, NodePublishVolume and their unstage/unpublish counterparts.',
      'The five carriers on the road are the operation sequence for a volume\'s life: provision, attach, mount, then unmount, detach and finally delete. They are drawn in the colour of whoever performs them — orange for the controller manager, teal for kubelet, green for the storage backend itself.',
      'An operation that fails is retried, not abandoned. A volume stuck between two of these states is the usual cause of a pod stuck in ContainerCreating with a FailedAttachVolume or FailedMount event.',
    ],
    caveats: [
      'Provision and delete never reach a node in reality, so their carriers only shuttle the plant end of the road.',
      'The driver\'s sidecars (external-provisioner, external-attacher, external-resizer, node-driver-registrar) are collapsed into two stations.',
      'gRPC idempotency, operation retries and the volume_id/volume_context plumbing are not drawn.',
    ],
    object: csiHouse,
    focus: [CITY.storage.x + 150, 60, ANCHOR.storagePlant[2] - 30],
    keywords: ['csi', 'driver', 'grpc', 'sidecar', 'volumeattachment', 'nodeplugin'],
    metrics: (s) => {
      const out: { label: string; value: string; hint?: string }[] = []
      for (let i = 0; i < s.csiOps.length && i < MAX_OPS; i++) {
        const o = s.csiOps[i]
        out.push({
          label: `${o.op} ${o.pv}`,
          value: o.failed ? 'failed' : `${Math.round(o.progress * 100)}%`,
          hint: o.failed ? o.reason : o.nodeName,
        })
      }
      if (out.length === 0) out.push({ label: 'operations', value: 'idle' })
      return out
    },
  })

  const attachEntry = ctx.registry.register({
    id: 'storage.csi.attach',
    title: 'Attach station',
    district: 'storage',
    kubeName: 'VolumeAttachment · attachdetach-controller',
    summary:
      'Attaching is cluster-side: a controller writes a VolumeAttachment and the driver plugs the disk into a node.',
    detail: [
      'The attach/detach controller in kube-controller-manager notices that a pod on node X needs volume V and creates a VolumeAttachment object naming both. The external-attacher watches those objects and calls ControllerPublishVolume on the driver, which asks the cloud to attach the disk to that node\'s instance.',
      'Nothing on the node does this, which is the point of the station being here and orange rather than out at the node blocks. A node that is unreachable cannot detach its own volumes — that is why a dead node holds its attachments hostage until the controller force-detaches after a timeout.',
      'The rack inside is the list of live VolumeAttachment objects. `kubectl get volumeattachment` is the fastest way to answer "which node is actually holding this disk", and it is one of the few places where a cluster-scoped object explains a namespaced problem.',
      'A failed attach surfaces on the pod as FailedAttachVolume and leaves it in ContainerCreating, not in Pending — the pod was scheduled successfully; it is the volume that will not come.',
    ],
    caveats: [
      'CSIDriver.spec.attachRequired is not modelled: drivers for NFS-style volumes skip attach entirely and go straight to mount.',
      'The six-minute force-detach timeout for unreachable nodes is described but not simulated.',
    ],
    object: attachStation,
    focus: [CITY.storage.x - 60, 40, ANCHOR.storagePlant[2] - 40],
    keywords: ['attach', 'detach', 'volumeattachment', 'controllerpublishvolume', 'failedattachvolume'],
    metrics: (s) => {
      let attached = 0
      for (let i = 0; i < s.pvs.length; i++) if (s.pvs[i].attachedNode) attached++
      let inflight = 0
      for (let i = 0; i < s.csiOps.length; i++) {
        const o = s.csiOps[i].op
        if (o === 'attach' || o === 'detach') inflight++
      }
      return [
        { label: 'VolumeAttachments', value: `${attached}` },
        { label: 'attach/detach in flight', value: `${inflight}` },
      ]
    },
  })
  ctx.registry.bind(attachMast, attachEntry)
  for (let i = 0; i < vaSlots.length; i++) ctx.registry.bind(vaSlots[i], attachEntry)

  const mountEntry = ctx.registry.register({
    id: 'storage.csi.mount',
    title: 'Mount station',
    district: 'storage',
    kubeName: 'kubelet volume manager · NodePublishVolume',
    summary:
      'Mounting is node-side and happens twice: once per node to stage the volume, once per pod to bind-mount it in.',
    detail: [
      'Attaching a disk to a node does not make it usable. kubelet\'s volume manager calls the node plugin twice: NodeStageVolume formats the device if needed and mounts it at a global path on the node — once, no matter how many pods use it — and NodePublishVolume then bind-mounts that path into each pod\'s directory.',
      'The two-call split is why several pods on one node can share a ReadWriteOnce volume: they share the staged mount and each get their own publish.',
      'kubelet blocks pod startup on this. A pod whose volume will not mount stays in ContainerCreating with FailedMount and a message naming the timeout — most often a filesystem type mismatch, a missing subPath, or a volume attached to the wrong node.',
      'Unmounting runs in reverse and must complete before the volume can be detached, which is the ordering that makes a stuck unmount hold a terminating pod open indefinitely.',
    ],
    caveats: [
      'Both node-plugin calls are drawn at the plant. In reality the node plugin runs as a DaemonSet pod on the node itself, and the mount is a kernel mount in that node\'s namespace.',
      'fsGroup ownership changes, SELinux relabelling and subPath handling are not modelled, though they are common causes of a slow or failed mount.',
    ],
    object: mountStation,
    focus: [CITY.storage.x + 40, 40, ANCHOR.storagePlant[2] - 40],
    keywords: ['mount', 'nodestagevolume', 'nodepublishvolume', 'failedmount', 'kubelet', 'unmount'],
    metrics: (s) => {
      let inflight = 0
      for (let i = 0; i < s.csiOps.length; i++) {
        const o = s.csiOps[i].op
        if (o === 'mount' || o === 'unmount') inflight++
      }
      return [
        { label: 'mount/unmount in flight', value: `${inflight}` },
        { label: 'Bound claims a pod could mount', value: `${s.pvcs.filter((c) => c.phase === 'Bound').length}` },
      ]
    },
  })
  ctx.registry.bind(mountMast, mountEntry)
  ctx.registry.bind(stageMount, mountEntry)
  ctx.registry.bind(publishMount, mountEntry)
  for (let i = 0; i < carriers.length; i++) ctx.registry.bind(carriers[i].root, csiEntry)

  /* ------------------------------------------------------------ theme flip */

  const offTheme = ctx.bus.on('theme', () => {
    mats = buildMats()
    for (let i = 0; i < statics.length; i++) statics[i].o.material = mats[statics[i].k]
  })

  /* ----------------------------------------------------------------- update */

  /* Per-frame scratch, hoisted: the loop below must not allocate. */
  const barrierOpen = new Float32Array(MAX_SC).fill(1)
  const tankScale = new Float32Array(MAX_PV).fill(TANK_BASE_H)
  /** Provision progress per PV slot, -1 when no provision op targets it. */
  const provisionOf = new Float32Array(MAX_PV).fill(-1)
  const deleteOf = new Float32Array(MAX_PV).fill(-1)
  /** Node index demanding an attach that the volume refuses, -1 when none. */
  const refusedBy = new Int32Array(MAX_PV).fill(-1)
  const classWaiting = new Int32Array(MAX_SC)
  const classProvisioning = new Int32Array(MAX_SC)

  function pvIndex(s: SimState, name: string | undefined): number {
    if (!name) return -1
    for (let i = 0; i < s.pvs.length && i < MAX_PV; i++) if (s.pvs[i].name === name) return i
    return -1
  }

  function nodeIndex(s: SimState, name: string | undefined): number {
    if (!name) return -1
    for (let i = 0; i < s.nodes.length; i++) if (s.nodes[i].name === name) return i
    return -1
  }

  function classIndex(s: SimState, name: string): number {
    for (let i = 0; i < s.storageClasses.length && i < MAX_SC; i++) {
      if (s.storageClasses[i].name === name) return i
    }
    return -1
  }

  function opMat(op: CsiOperation): MatKey {
    switch (op.op) {
      case 'provision':
        return 'storage'
      case 'delete':
        return 'terminating'
      case 'attach':
      case 'detach':
        return 'attach'
      default:
        return 'mount'
    }
  }

  function update(s: SimState, dt: number): void {
    const t = s.t

    /* --- pass 1: fold the CSI operation list into per-slot scratch. */
    provisionOf.fill(-1)
    deleteOf.fill(-1)
    refusedBy.fill(-1)
    classProvisioning.fill(0)
    for (let i = 0; i < s.csiOps.length; i++) {
      const o = s.csiOps[i]
      const pi = pvIndex(s, o.pv)
      if (o.op === 'provision') {
        if (pi >= 0) provisionOf[pi] = o.progress
        const pv = pi >= 0 ? s.pvs[pi] : undefined
        const ci = pv ? classIndex(s, pv.storageClass) : -1
        if (ci >= 0) classProvisioning[ci] = 1
      } else if (o.op === 'delete') {
        if (pi >= 0) deleteOf[pi] = o.progress
      } else if (o.op === 'attach' && pi >= 0) {
        const pv = s.pvs[pi]
        /* An attach aimed at a node other than the one already holding an
         * exclusive volume is the Multi-Attach refusal, whether or not the
         * model has already marked the operation failed. */
        const exclusive = pv.accessMode === 'ReadWriteOnce'
        const elsewhere = pv.attachedNode !== undefined && pv.attachedNode !== o.nodeName
        if (o.failed || (exclusive && elsewhere)) {
          const ni = nodeIndex(s, o.nodeName)
          refusedBy[pi] = ni >= 0 ? ni : 0
        }
      }
    }

    /* --- pass 2: claims held at each class's binding barrier. */
    classWaiting.fill(0)
    for (let i = 0; i < s.pvcs.length; i++) {
      const c = s.pvcs[i]
      if (!c.waitingForConsumer) continue
      const ci = classIndex(s, c.storageClass)
      if (ci >= 0) classWaiting[ci]++
    }

    /* --- StorageClass lines. */
    for (let i = 0; i < MAX_SC; i++) {
      const ln = lines[i]
      const sc: StorageClassState | undefined = s.storageClasses[i]
      ln.root.visible = sc !== undefined
      if (!sc) continue

      const wffc = sc.bindingMode === 'WaitForFirstConsumer'
      const held = classWaiting[i]
      /* The barrier is down exactly while a WaitForFirstConsumer claim of this
       * class has no scheduled consumer. Immediate never lowers it at all. */
      const wantOpen = wffc && held > 0 ? 0 : 1
      barrierOpen[i] = approach(barrierOpen[i], wantOpen, 5, dt)
      ln.armPivot.rotation.x = -barrierOpen[i] * 1.35
      ln.arm.material = wantOpen < 0.5 ? mats.pending : mats.storageSoft

      for (let k = 0; k < ln.waitLamps.length; k++) {
        const on = k < held
        ln.waitLamps[k].visible = on
        if (on) ln.waitLamps[k].material = Math.sin(t * 3 + k) > 0 ? mats.pending : mats.dim
      }

      const provisioning = classProvisioning[i] === 1
      ln.head.material = provisioning ? mats.storageSoft : mats.dim
      ln.beacon.visible = provisioning
      if (provisioning) ln.beacon.material = mats.storage

      /* The shuttle runs the line only while a volume of this class is being
       * created — the visible difference between a class and a volume. */
      ln.shuttle.visible = provisioning
      if (provisioning) {
        const f = (t * 0.5) % 1
        ln.shuttle.position.x = LINE_X0 + 6 + f * (LINE_X1 - LINE_X0 - 12)
        ln.shuttle.material = mats.storage
      }

      const del = sc.reclaimPolicy === 'Delete'
      ln.crusher.visible = del
      ln.siding.visible = !del
      ln.expansion.visible = sc.allowExpansion
      if (sc.allowExpansion) ln.expansion.material = mats.storageSoft
    }

    /* --- PV tanks. */
    for (let i = 0; i < MAX_PV; i++) {
      const tk = tanks[i]
      const pv: PvState | undefined = s.pvs[i]
      tk.root.visible = pv !== undefined
      if (!pv) continue

      const full = TANK_BASE_H + pv.capacityGib * TANK_H_PER_GIB
      /* A volume being created grows out of the ground; one being deleted sinks
       * back into it. Both are the same barrel, because it is the same bytes. */
      let target = full
      if (provisionOf[i] >= 0) target = full * clamp(provisionOf[i], 0.08, 1)
      else if (deleteOf[i] >= 0) target = full * clamp(1 - deleteOf[i], 0.05, 1)
      tankScale[i] = approach(tankScale[i], target, 6, dt)
      tk.barrel.scale.y = tankScale[i]
      tk.band.position.y = tankScale[i] - 1.4

      const phase = pv.phase
      tk.band.material =
        phase === 'Bound'
          ? mats.ready
          : phase === 'Available'
            ? mats.storage
            : phase === 'Released'
              ? mats.terminating
              : mats.failed
      tk.barrel.material = provisionOf[i] >= 0 ? mats.storageSoft : mats.steel

      /* Access mode is the socket count: one node at a time, or many. */
      const rwo = pv.accessMode === 'ReadWriteOnce'
      const attachedIdx = nodeIndex(s, pv.attachedNode)
      for (let k = 0; k < 3; k++) {
        const shown = rwo ? k === 1 : true
        tk.sockets[k].visible = shown
        if (!shown) continue
        const filled = attachedIdx >= 0 && (rwo || k === 0)
        tk.sockets[k].material = filled ? mats.mount : mats.dim
      }
      tk.lock.visible = rwo
      if (rwo) tk.lock.material = attachedIdx >= 0 ? mats.mount : mats.storageSoft

      const refused = refusedBy[i]
      for (let n = 0; n < N_NODES; n++) {
        const pip = tk.nodePips[n]
        if (n === refused) pip.material = Math.sin(t * 16) > 0 ? mats.failedBright : mats.failed
        else pip.material = n === attachedIdx ? mats.mount : mats.dim
      }
      tk.mast.material = attachedIdx >= 0 ? mats.mountSoft : mats.dim

      tk.refuse.visible = refused >= 0
      if (refused >= 0) {
        tk.refuse.position.y = tankScale[i] * 0.5
        tk.refuse.material = Math.sin(t * 16) > 0 ? mats.failedBright : mats.failed
      }

      /* Reclaim: a Released volume is consigned to the crusher or the siding. */
      const sc = pv.storageClass ? classOf(s, pv.storageClass) : undefined
      const released = phase === 'Released' || deleteOf[i] >= 0
      const toCrusher = released && sc !== undefined && sc.reclaimPolicy === 'Delete'
      const toSiding = released && !toCrusher
      const homeX = (i - (MAX_PV - 1) / 2) * TANK_PITCH
      const targetX = toCrusher ? 44 : toSiding ? -44 : homeX
      const targetZ = released ? RECLAIM_Z : PARK_Z
      tk.root.position.x = approach(tk.root.position.x, targetX, 1.6, dt)
      tk.root.position.z = approach(tk.root.position.z, targetZ, 1.6, dt)
    }

    /* --- PVC tickets. A bound ticket travels to its volume and couples to it. */
    for (let i = 0; i < MAX_PVC; i++) {
      const tc = tickets[i]
      const pvc: PvcState | undefined = pvcOf(s, i)
      tc.root.visible = pvc !== undefined
      if (!pvc) continue

      const bi = pvc.phase === 'Bound' ? pvIndex(s, pvc.boundPv) : -1
      const homeX = (i - (MAX_PVC - 1) / 2) * TICKET_PITCH
      const wantX = bi >= 0 ? tanks[bi].root.position.x : homeX
      const wantZ = bi >= 0 ? tanks[bi].root.position.z - 30 : TICKET_WAIT_Z
      ticketPos[i * 2] = approach(ticketPos[i * 2], wantX, 2.2, dt)
      ticketPos[i * 2 + 1] = approach(ticketPos[i * 2 + 1], wantZ, 2.2, dt)
      tc.root.position.set(ticketPos[i * 2], 1, ticketPos[i * 2 + 1])

      tc.card.material = pvc.phase === 'Bound' ? mats.claim : mats.claimDim
      tc.lamp.material =
        pvc.phase === 'Bound'
          ? mats.ready
          : pvc.phase === 'Lost'
            ? mats.failed
            : Math.sin(t * 4) > 0
              ? mats.pending
              : mats.dim

      /* The coupling. Its length is the real gap to the tank, so an unbound
       * claim cannot be mistaken for a bound one at any camera angle. */
      const coupled = bi >= 0
      tc.rod.visible = coupled
      tc.hook.material = coupled ? mats.ready : mats.claimDim
      if (coupled) {
        const gap = tanks[bi].root.position.z - TANK_R - tc.root.position.z - 5
        const len = gap > 1 ? gap : 1
        tc.rod.scale.z = len
        tc.rod.position.z = 5 + len / 2
        tc.rod.material = mats.ready
      }
    }

    /* --- the attach rack: one slot per live VolumeAttachment. */
    let va = 0
    for (let i = 0; i < s.pvs.length && va < MAX_PV; i++) {
      if (!s.pvs[i].attachedNode) continue
      const slot = vaSlots[va++]
      slot.visible = true
      slot.material = mats.attachSoft
    }
    for (let i = va; i < MAX_PV; i++) vaSlots[i].visible = false
    attachMast.material = va > 0 ? mats.attach : mats.attachSoft

    /* --- the node plugin's two calls, lit while a mount is running. */
    let mounting = false
    for (let i = 0; i < s.csiOps.length; i++) {
      const o = s.csiOps[i].op
      if (o === 'mount' || o === 'unmount') mounting = true
    }
    stageMount.material = mounting ? mats.mount : mats.mountSoft
    publishMount.material = mounting ? mats.mount : mats.mountSoft
    mountMast.material = mounting ? mats.mount : mats.mountSoft

    /* --- CSI carriers on the storage-to-nodes road. */
    const nOps = s.csiOps.length < MAX_OPS ? s.csiOps.length : MAX_OPS
    for (let i = 0; i < MAX_OPS; i++) {
      const car = carriers[i]
      if (i >= nOps) {
        car.root.visible = false
        continue
      }
      const op = s.csiOps[i]
      car.root.visible = true
      const span = OP_SPAN[op.op]
      const p = clamp(op.progress, 0, 1)
      const u = clamp(span[0] + (span[1] - span[0]) * p, 0, 1)
      road.getPointAt(u, _v)
      car.root.position.set(_v.x - _origin.x, _v.y - _origin.y + 3, _v.z - _origin.z)
      /* A failed operation stops where it failed and flashes; it is not gone,
       * it is being retried, and the pod above is stuck until it succeeds. */
      const m = op.failed
        ? Math.sin(t * 16) > 0
          ? mats.failedBright
          : mats.failed
        : mats[opMat(op)]
      car.bed.material = m
      car.flag.material = m
      car.flag.rotation.y = t * (op.failed ? 0 : 2)

      /* Below grade the carrier itself is hidden under the ground plane, so it
       * raises a mast to the surface rather than disappearing. */
      const rise = 4 - (_v.y + 3)
      car.mast.visible = rise > 1
      if (rise > 1) {
        car.mast.scale.y = rise
        car.mast.material = m
      }
    }
  }

  function dispose(): void {
    offTheme()
    for (let i = 0; i < geoms.length; i++) geoms[i].dispose()
    geoms.length = 0
    group.removeFromParent()
  }

  return { group, update, dispose }
}
