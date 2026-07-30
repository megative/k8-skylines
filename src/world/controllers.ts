import * as THREE from 'three'
import type { ControllerId, NodeState, ReconcilePhase, SimState } from '../core/types'
import { COLOR, ghost, glass, mat, neon, structural } from '../core/theme'
import { ANCHOR, CITY, CONTROLLER_ORDER, controllerPos, route } from './layout'
import { buildHall } from './hall'
import type { WorldCtx, WorldModule } from './module'
import { clamp, smoothstep } from '../core/util'

/* ============================================================================
 * THE CONTROLLER YARD — kube-controller-manager.
 *
 * Every machine here is a closed circuit, not a pipe: an informer intake, a
 * rate-limited workqueue, a reconcile hall where DESIRED (ghost) is set against
 * ACTUAL (matter), a write port back to the API server, and a delay line that
 * returns the key to the queue. The arm goes all the way round and starts
 * again, whether or not it found anything — level-triggered, not edge-triggered.
 *
 * The machines are drawn separately so each loop's queue, cache, diff and
 * writes are legible; in reality all of them are goroutines inside one process
 * sharing one informer factory and one leader-election Lease.
 * ==========================================================================*/

const TAU = Math.PI * 2

/** Working deck of a machine: one metre proud of the control-plane mesa. */
const WORK_Y = CITY.mesa.top + 1
const PODIUM_W = 36
const PODIUM_D = 30
const RAIL_R = 10.5
/** Stations stand just outside the rail the arm rides. */
const STATION_R = 12.6
const CONDUIT_R = 14.2
const ARM_Y = WORK_Y + 11
const RAIL_Y = WORK_Y + 6.4

const MAX_QUEUE = 12
const MAX_RACK = 8
const MAX_TOKENS = 4
const MAX_ERR = 6

/* Station positions around the loop, as turn fractions. 0 is north (-Z) and
 * the arm travels clockwise seen from above. */
const F_INTAKE = 0
const F_QUEUE = 0.25
const F_DIFF = 0.5
const F_WRITE = 0.75
const F_LIMIT = 0.875

/** Laps per model second the arm idles at — the informer resync, scaled down. */
const IDLE_LAPS = 0.075
/** Ceiling on how fast the arm may travel to catch its phase's station. */
const CHASE_LAPS = 1.1
/** Backoff seconds that fill the cool-down bar completely. */
const BACKOFF_FULL = 30
/** Model seconds a write token takes to reach the yard's north gate. */
const TOKEN_FLIGHT = 1.1

const N_MACHINES = CONTROLLER_ORDER.length

/* Frame-loop scratch. Nothing in update() may allocate. */
const _dummy = new THREE.Object3D()
const _cGap = new THREE.Color(1, 1, 1)
const _cMet = new THREE.Color(0.38, 0.38, 0.38)

/* --------------------------------------------------------------------------
 * Text plates. No remote fonts: a 2D canvas and the platform's own mono face.
 * Redrawn only when the string it shows changes, never per frame.
 * ------------------------------------------------------------------------*/

class Plate {
  readonly sprite: THREE.Sprite
  private readonly c2d: CanvasRenderingContext2D | null
  private readonly tex: THREE.CanvasTexture | null
  private readonly material: THREE.SpriteMaterial
  private readonly lines: number
  private readonly color: string
  private last = '\0'

  constructor(worldWidth: number, lines: number, color = '#e8eef6') {
    this.lines = lines
    this.color = color
    const w = 256
    const h = 34 * lines + 10
    /* Headless (test) environments have no canvas; the plate degrades to an
     * invisible sprite so the object graph stays identical. */
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
    if (canvas) {
      canvas.width = w
      canvas.height = h
    }
    this.c2d = canvas ? canvas.getContext('2d') : null
    this.tex = canvas && this.c2d ? new THREE.CanvasTexture(canvas) : null
    if (this.tex) this.tex.anisotropy = 4
    this.material = new THREE.SpriteMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      opacity: 0.95,
    })
    this.material.visible = this.tex !== null
    this.sprite = new THREE.Sprite(this.material)
    this.sprite.scale.set(worldWidth, (worldWidth * h) / w, 1)
  }

  set(text: string): void {
    if (text === this.last) return
    this.last = text
    const c = this.c2d
    if (!c || !this.tex) return
    const w = c.canvas.width
    const h = c.canvas.height
    c.clearRect(0, 0, w, h)
    c.fillStyle = 'rgba(6,9,15,0.66)'
    c.fillRect(0, 0, w, h)
    c.font = 'bold 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = this.color
    const rows = text.split('\n')
    for (let i = 0; i < rows.length && i < this.lines; i++) {
      c.fillText(rows[i], w / 2, 22 + i * 34, w - 12)
    }
    this.tex.needsUpdate = true
  }

  setVisible(v: boolean): void {
    this.sprite.visible = v && this.material.visible
  }

  dispose(): void {
    this.tex?.dispose()
    this.material.dispose()
  }
}

/* --------------------------------------------------------------------------
 * What each loop diffs. `writes` is the number of API writes that difference
 * costs — one per object the controller actually PUTs, which is not the same
 * as the size of the gap. The Deployment controller closes a gap of four with
 * a single scale patch; the ReplicaSet controller spends one create per Pod.
 * ------------------------------------------------------------------------*/

interface Diff {
  desired: number
  actual: number
  writes: number
}

const _diff: Diff = { desired: 0, actual: 0, writes: 0 }

type DiffFn = (s: SimState, out: Diff) => void

function nodeReady(n: NodeState): boolean {
  for (let i = 0; i < n.conditions.length; i++) {
    const c = n.conditions[i]
    if (c.type === 'Ready') return c.status === 'True'
  }
  return false
}

function idleDiff(_s: SimState, out: Diff): void {
  out.desired = 0
  out.actual = 0
  out.writes = 0
}

const DIFFS: Record<ControllerId, DiffFn> = {
  deployment(s, out) {
    let d = 0
    let a = 0
    let w = 0
    for (let i = 0; i < s.deployments.length; i++) {
      const dep = s.deployments[i]
      d += dep.replicas
      a += dep.statusReplicas
      /* One sync writes one ReplicaSet scale (plus the Deployment's status). */
      if (dep.replicas !== dep.statusReplicas || dep.rollingOut) w += 1
    }
    out.desired = d
    out.actual = a
    out.writes = w
  },

  replicaset(s, out) {
    let d = 0
    let a = 0
    for (let i = 0; i < s.replicaSets.length; i++) {
      const rs = s.replicaSets[i]
      d += rs.replicas
      a += rs.statusReplicas
    }
    out.desired = d
    out.actual = a
    /* Every missing or surplus Pod is its own create or delete. */
    out.writes = Math.abs(d - a)
  },

  statefulset(s, out) {
    let d = 0
    let a = 0
    let w = 0
    for (let i = 0; i < s.statefulSets.length; i++) {
      const st = s.statefulSets[i]
      d += st.replicas
      a += st.readyReplicas
      /* Ordered: at most one ordinal moves per set per sync. */
      if (st.replicas !== st.readyReplicas) w += 1
    }
    out.desired = d
    out.actual = a
    out.writes = w
  },

  daemonset(s, out) {
    let d = 0
    let a = 0
    for (let i = 0; i < s.daemonSets.length; i++) {
      const ds = s.daemonSets[i]
      d += ds.desiredScheduled
      a += ds.currentScheduled
    }
    out.desired = d
    out.actual = a
    out.writes = Math.abs(d - a)
  },

  job(s, out) {
    let d = 0
    let a = 0
    let w = 0
    for (let i = 0; i < s.jobs.length; i++) {
      const j = s.jobs[i]
      d += j.completions
      a += j.succeeded
      const need = j.completions - j.succeeded - j.active
      const room = j.parallelism - j.active
      w += clamp(Math.min(need, room), 0, j.parallelism)
    }
    out.desired = d
    out.actual = a
    out.writes = w
  },

  /* No CronJob objects exist in the model; the loop is drawn running anyway. */
  cronjob: idleDiff,

  node(s, out) {
    let ready = 0
    for (let i = 0; i < s.nodes.length; i++) if (nodeReady(s.nodes[i])) ready += 1
    out.desired = s.nodes.length
    out.actual = ready
    /* One condition patch and one taint per node that stopped renewing. */
    out.writes = s.nodes.length - ready
  },

  endpointslice(s, out) {
    let serving = 0
    let listed = 0
    let w = 0
    for (let i = 0; i < s.services.length; i++) {
      const svc = s.services[i]
      let sv = 0
      let ld = 0
      for (let k = 0; k < svc.endpoints.length; k++) {
        const e = svc.endpoints[k]
        if (e.serving) sv += 1
        if (e.ready) ld += 1
      }
      serving += sv
      listed += ld
      /* The whole slice is rewritten at once, however many entries moved. */
      if (sv !== ld) w += 1
    }
    out.desired = serving
    out.actual = listed
    out.writes = w
  },

  'pv-binder': function pvBinder(s, out) {
    let want = 0
    let bound = 0
    for (let i = 0; i < s.pvcs.length; i++) {
      const c = s.pvcs[i]
      if (c.waitingForConsumer) continue
      want += 1
      if (c.phase === 'Bound') bound += 1
    }
    out.desired = want
    out.actual = bound
    out.writes = want - bound
  },

  hpa(s, out) {
    let d = 0
    let a = 0
    let w = 0
    for (let i = 0; i < s.hpas.length; i++) {
      const h = s.hpas[i]
      const cur = scaleTargetReplicas(s, h.targetRef)
      d += h.desiredReplicas
      a += cur
      if (h.desiredReplicas !== cur && !h.unknownMetrics) w += 1
    }
    out.desired = d
    out.actual = a
    out.writes = w
  },

  'garbage-collector': function gc(s, out) {
    let orphans = 0
    for (let i = 0; i < s.replicaSets.length; i++) {
      const rs = s.replicaSets[i]
      let owner = false
      for (let k = 0; k < s.deployments.length; k++) {
        if (s.deployments[k].name === rs.ownerDeployment) {
          owner = true
          break
        }
      }
      if (!owner) orphans += 1
    }
    /* Nothing should be owned by something that no longer exists. */
    out.desired = 0
    out.actual = orphans
    out.writes = orphans
  },

  namespace: idleDiff,
  serviceaccount: idleDiff,
}

/** Replicas the HPA's scale target currently asks for. */
function scaleTargetReplicas(s: SimState, targetRef: string): number {
  for (let i = 0; i < s.deployments.length; i++) {
    const d = s.deployments[i]
    if (targetRef === d.name) return d.replicas
    if (targetRef.length > d.name.length && targetRef.endsWith(d.name)) return d.replicas
  }
  return 0
}

/* --------------------------------------------------------------------------
 * One entry per machine: what it watches, what it diffs, what it writes.
 * ------------------------------------------------------------------------*/

interface Spec {
  id: ControllerId
  /** Short plate text. */
  plate: string
  title: string
  kubeName: string
  summary: string
  detail: string[]
  caveats: string[]
  keywords: string[]
}

const SPECS: readonly Spec[] = [
  {
    id: 'deployment',
    plate: 'deployment',
    title: 'Deployment controller',
    kubeName: 'deployment-controller',
    summary:
      'Watches Deployments and the ReplicaSets they own, and writes ReplicaSet replica counts. It never creates a Pod.',
    detail: [
      'The diff: Deployment.spec — replicas, and the hash of the current pod template — against the set of ReplicaSets it owns. If no ReplicaSet carries the current pod-template-hash it creates one, then decides how many replicas each old and new ReplicaSet should have.',
      'A rolling update is entirely that arithmetic. maxSurge allows the total to go above spec.replicas; maxUnavailable allows available pods to fall below it. Each sync it scales the new ReplicaSet up by whatever surge allows and scales an old one down by whatever availability allows, then waits — for the ReplicaSet controller to make Pods and for kubelets to make them Ready.',
      'Rollback is not an undo log. The superseded ReplicaSet is still there with replicas: 0, keeping its own pod template; a rollback rewrites the Deployment template and scales that ReplicaSet back up. That is why it is instant and why revisionHistoryLimit is the thing that decides how far back you can go.',
      'It also writes its own status — replicas / updatedReplicas / readyReplicas / availableReplicas, the numbers kubectl get deploy prints — and sets Progressing=False with reason ProgressDeadlineExceeded when a rollout has not moved for progressDeadlineSeconds (default 600).',
    ],
    caveats: [
      'The rack shows spec.replicas against status.replicas summed over every Deployment in the model; a real sync reconciles one Deployment.',
      'One token leaves per sync because the controller writes one object — a ReplicaSet scale — not one write per replica. The Pods come from the machine next door.',
    ],
    keywords: ['deployment', 'rollout', 'rolling update', 'maxSurge', 'rollback', 'revision'],
  },
  {
    id: 'replicaset',
    plate: 'replicaset',
    title: 'ReplicaSet controller',
    kubeName: 'replicaset-controller',
    summary:
      'Counts Pods matching its selector and creates or deletes Pods until that count equals spec.replicas. This is the loop that actually makes Pods.',
    detail: [
      'The diff: spec.replicas against the number of live Pods matching the selector and carrying this ReplicaSet in ownerReferences. Too few, it creates; too many, it deletes. There is nothing else in it.',
      'Creates are batched with slow start — 1, then 2, 4, 8 per sync — so a Pod template that fails admission or crashes on boot costs one Pod, not five hundred.',
      'It cannot see its own creations immediately: the informer cache lags its own write. It keeps in-memory expectations ("I created 2, wake me when I have observed them") and skips the sync until they are satisfied or a timeout expires. Without that it would create the same Pods over and over — the classic hazard of reconciling against a stale cache.',
      'When it must delete, it ranks victims deliberately: unscheduled before scheduled, Pending before Running, unready before ready, the ones on nodes already carrying more of this set, then newest before oldest.',
    ],
    caveats: [
      'Pods are aggregated across every ReplicaSet in the model; a real sync sees one ReplicaSet.',
      'Selector matching here is exact-label equality; real selectors also carry set-based requirements (In, NotIn, Exists).',
    ],
    keywords: ['replicaset', 'replicas', 'expectations', 'slow start', 'ownerReferences'],
  },
  {
    id: 'statefulset',
    plate: 'statefulset',
    title: 'StatefulSet controller',
    kubeName: 'statefulset-controller',
    summary:
      'Keeps N Pods with stable identities — web-0, web-1 — creating and deleting them strictly one ordinal at a time.',
    detail: [
      'The diff is per ordinal, not per count. Ordinal i is not created until ordinal i-1 is Ready, and scale-down removes the highest ordinal first. One ordinal that never becomes Ready blocks the whole set: that is the deliberate price of ordering guarantees, and it is why a StatefulSet rollout can wedge where a Deployment would not.',
      'Identity is the whole point. The Pod name, its DNS name through the headless governing Service (web-0.web.shop.svc.cluster.local) and its PersistentVolumeClaim (data-web-0) all follow the ordinal, so a Pod rescheduled onto a different node comes back with the same name and the same volume.',
      'The PVCs come from volumeClaimTemplates and are created by this controller. By default they are not deleted when the set is scaled down or deleted — losing a StatefulSet does not lose its data, which is also why a shrunken set that grows again reattaches its old volumes.',
    ],
    caveats: [
      'The rack shows aggregate replicas against ready replicas rather than the individual ordinal in flight.',
      'podManagementPolicy: Parallel, which drops the ordering entirely, is not modelled.',
    ],
    keywords: ['statefulset', 'ordinal', 'headless service', 'volumeClaimTemplates', 'identity'],
  },
  {
    id: 'daemonset',
    plate: 'daemonset',
    title: 'DaemonSet controller',
    kubeName: 'daemonset-controller',
    summary:
      'One Pod per eligible node, by definition. It has no replica count — its desired state is the node list.',
    detail: [
      'The diff: the set of nodes whose labels and taints the DaemonSet tolerates, against the set of nodes that already carry one of its Pods. It creates a Pod for each missing node and deletes Pods on nodes that stopped qualifying. Add a node to the cluster and this loop is what puts the log agent on it.',
      'Its Pods carry a nodeAffinity pinned to one node name, so the scheduler still does the binding. Before 1.12 this controller set spec.nodeName itself and bypassed the scheduler; it no longer does, which is why DaemonSet Pods now respect priority, preemption and scheduler plugins like everything else.',
      'It tolerates almost everything by default — node.kubernetes.io/not-ready, unreachable, disk-pressure, memory-pressure, pid-pressure and unschedulable — because a CNI plugin or log shipper has to keep running on a node that is already in trouble.',
    ],
    caveats: [
      'Node eligibility here is the whole node list; per-node taint and affinity filtering is drawn in the scheduler district.',
    ],
    keywords: ['daemonset', 'per node', 'tolerations', 'node affinity', 'agent'],
  },
  {
    id: 'job',
    plate: 'job',
    title: 'Job controller',
    kubeName: 'job-controller',
    summary:
      'Runs Pods until `completions` of them have exited successfully, keeping at most `parallelism` alive, and gives up after `backoffLimit` failures.',
    detail: [
      'The diff: completions against status.succeeded, bounded by parallelism minus the Pods already active. That bound is why the write count per sync is capped — a Job needing 100 completions with parallelism 4 never launches 100 Pods.',
      'A Job Pod has restartPolicy Never or OnFailure. A failed Pod is replaced by a new Pod (a new name, a new uid); each failure counts against backoffLimit, default 6, after which the Job gets condition Failed with reason BackoffLimitExceeded and stops creating anything.',
      'Finished Pods are kept on purpose so their logs survive. What actually removes a finished Job is ttlSecondsAfterFinished, handled by a separate TTL-after-finished controller — which is why clusters accumulate completed Jobs when nobody sets it.',
    ],
    caveats: [
      'Indexed completion mode, podFailurePolicy and activeDeadlineSeconds are not modelled.',
    ],
    keywords: ['job', 'completions', 'parallelism', 'backoffLimit', 'batch'],
  },
  {
    id: 'cronjob',
    plate: 'cronjob',
    title: 'CronJob controller',
    kubeName: 'cronjob-controller',
    summary:
      'Wakes on a timer, compares the schedule against the Jobs it has already created, and creates a Job when a scheduled time has passed unfulfilled.',
    detail: [
      'It is the clearest case of a loop with nothing to do. It resyncs every 10 seconds, computes the most recent schedule time it has not yet acted on, and almost always concludes it has already handled it. The machine still dequeues, still diffs, still comes round again.',
      'If it falls more than startingDeadlineSeconds behind (default 100s) it abandons the missed run instead of firing a burst, so a control plane that was down for an hour does not produce a thundering herd of catch-up Jobs when it returns.',
      'concurrencyPolicy decides what happens when the previous Job is still running: Allow, Forbid (skip this run entirely) or Replace (delete the running Job and start a new one). History is bounded by successfulJobsHistoryLimit and failedJobsHistoryLimit.',
    ],
    caveats: [
      'The model carries no CronJob objects, so this machine’s diff is always empty. It is drawn running deliberately: a loop with nothing to do still runs, and that is the lesson.',
    ],
    keywords: ['cronjob', 'schedule', 'concurrencyPolicy', 'startingDeadlineSeconds'],
  },
  {
    id: 'node',
    plate: 'nodelifecycle',
    title: 'Node lifecycle controller',
    kubeName: 'node-lifecycle-controller',
    summary:
      'Watches node Leases, marks a node that stops renewing as Ready=Unknown, taints it, and lets the taint evict its Pods.',
    detail: [
      'The diff: the Lease each kubelet renews in kube-node-lease every 10 seconds, against the clock. No renewal for --node-monitor-grace-period (40s) and this controller writes Ready=Unknown with reason NodeStatusUnknown onto the Node. The node is silent by definition, so somebody else has to write that condition, and this is who.',
      'It then applies node.kubernetes.io/unreachable:NoExecute. Eviction is not this controller’s timer: the NoExecute taint plus each Pod’s default tolerationSeconds of 300 is what deletes the Pods five minutes later, through the taint manager. That is why the delay is per-Pod and tunable per-Pod.',
      'It rate-limits itself. If more than --unhealthy-zone-threshold (55%) of a zone goes unready at once it slows evictions, and in a small cluster it stops them entirely, because an entire zone going NotReady is far more likely to be a network partition than forty dead machines.',
      'Pods on an unreachable node are deleted in the API while their containers may still be running on the far side of the partition. This is exactly why a StatefulSet will not recreate an ordinal until the Pod object is truly gone — the guarantee is at most one web-0, and only the API can promise that.',
    ],
    caveats: [
      'Zone-aware rate limiting is not drawn, and the separate node-ipam loop that hands each Node its podCIDR is folded into this machine.',
    ],
    keywords: ['node', 'NotReady', 'lease', 'unreachable', 'eviction', 'taint manager'],
  },
  {
    id: 'endpointslice',
    plate: 'endpointslice',
    title: 'EndpointSlice controller',
    kubeName: 'endpointslice-controller',
    summary:
      'Turns "which Pods match this Service selector and are Ready" into EndpointSlice objects — the data every kube-proxy reads.',
    detail: [
      'The diff: Pods matching the Service selector with their current readiness, against the entries already recorded in that Service’s EndpointSlices. It writes whole slices, not individual endpoints, which is why the design caps a slice at 100 endpoints and adds another slice rather than growing one object without bound.',
      'A Pod whose Ready condition goes false leaves the ready set on the next sync. A Pod being deleted is marked serving=false and ready=false immediately, at the moment the deletionTimestamp is set and before its grace period even begins — that early flip is the entire mechanism behind draining connections cleanly.',
      'This object is the seam between control plane and data plane. Nothing here programs a rule: kube-proxy on every node watches these slices and rewrites its own iptables or IPVS tables from them. The lag you can see during a rollout mostly lives in that second hop, not in this machine.',
    ],
    caveats: [
      'The model diffs the serving flag against the ready flag on entries that already exist. Slice splitting, topology-aware hints and the legacy Endpoints object are not modelled.',
    ],
    keywords: ['endpointslice', 'endpoints', 'service', 'readiness', 'kube-proxy'],
  },
  {
    id: 'pv-binder',
    plate: 'pv-binder',
    title: 'PersistentVolume binder',
    kubeName: 'persistentvolume-binder',
    summary:
      'Matches Pending PVCs to Available PVs — or waits for a provisioner to make one — and writes the two-way binding.',
    detail: [
      'The diff: PVCs in phase Pending against PVs that are Available and satisfy the claim’s storageClassName, size and access mode. A bind is two writes, PVC.spec.volumeName and PV.spec.claimRef, so a half-finished bind is simply repaired on the next pass instead of leaking a volume — level-triggered reconciliation standing in for a transaction.',
      'volumeBindingMode: WaitForFirstConsumer is why a PVC can sit Pending with plenty of storage free: the binder deliberately refuses to choose until the scheduler has picked a node, so a zonal or local volume is created in the zone the Pod will actually run in. The scheduler and this loop are making one decision together.',
      'Dynamic provisioning hands the request to an external CSI provisioner and waits for a PV to appear; this controller does not create storage. On delete, the PV’s reclaimPolicy decides whether the volume is deleted or left Released with its data intact.',
    ],
    caveats: [
      'Attach and detach are a separate controller, drawn in the storage district. A bind is shown as one operation although it is two writes.',
    ],
    keywords: ['pv', 'pvc', 'binder', 'WaitForFirstConsumer', 'storageclass', 'provisioning'],
  },
  {
    id: 'hpa',
    plate: 'hpa',
    title: 'HorizontalPodAutoscaler controller',
    kubeName: 'horizontal-pod-autoscaler',
    summary:
      'Reads metrics every 15 seconds and writes a new replica count on the target’s scale subresource. This is the loop that closes the whole city’s circle.',
    detail: [
      'The arithmetic is one line: desired = ceil(currentReplicas × currentMetric / targetMetric), averaged over ready Pods. Utilisation is a percentage of the Pod’s requests — not its limits and not the node’s capacity — so a container with no CPU request cannot be autoscaled on CPU utilisation at all, and the HPA will report it instead of guessing.',
      'It writes to /scale on the Deployment. That write is desired state for the Deployment controller, which writes a ReplicaSet, which becomes Pods, which produce metrics, which arrive back here. The tour’s last step returning to its first is not a diagram convention; it is this one write.',
      'Scaling up is immediate. Scaling down waits out a 300-second stabilization window and then uses the highest recommendation seen inside it, so a brief dip cannot flap the fleet. A 10% tolerance suppresses changes near the target so it does not oscillate by one replica forever.',
      'When the metrics pipeline cannot answer it does not guess: ScalingActive=False with reason FailedGetResourceMetric, and the replica count is left exactly where it is. An autoscaler that cannot see is required to do nothing.',
    ],
    caveats: [
      'The metric here is derived from the modelled CPU use of the pods; there is no metrics-server, no custom.metrics.k8s.io and no external metrics adapter in the city.',
    ],
    keywords: ['hpa', 'autoscaling', 'scale subresource', 'utilization', 'stabilization'],
  },
  {
    id: 'garbage-collector',
    plate: 'gc',
    title: 'Garbage collector',
    kubeName: 'garbage-collector-controller',
    summary:
      'Walks an ownership graph of every object in the cluster and deletes anything whose owners are all gone.',
    detail: [
      'Its input is not a kind, it is metadata.ownerReferences. Using discovery it watches every resource the API server serves, keeps a graph of who owns whom, and deletes a node in that graph once every owner it names has been deleted. Delete a Deployment and it is this loop — not the Deployment controller — that removes the ReplicaSets and then the Pods.',
      'Background deletion (the default) removes the owner immediately and cleans dependents up afterwards. Foreground deletion adds the finalizer foregroundDeletion, so the owner stays visible with a deletionTimestamp until its dependents are gone. Orphan deletion strips the references and leaves the children running.',
      'An ownerReference is namespace-local: it cannot cross namespaces, and a namespaced object cannot own a cluster-scoped one. A reference pointing at the wrong namespace or a recreated uid makes an object either immortal or instantly collectable, and both failures look like magic until you read the references.',
    ],
    caveats: [
      'The model tracks only ReplicaSets whose owning Deployment no longer exists, so this machine is usually idle and its DESIRED row is deliberately empty: for the collector, desired is always zero.',
    ],
    keywords: ['garbage collection', 'ownerReferences', 'finalizer', 'cascading delete', 'orphan'],
  },
  {
    id: 'namespace',
    plate: 'namespace',
    title: 'Namespace controller',
    kubeName: 'namespace-controller',
    summary:
      'When a Namespace is deleted it deletes everything inside it, then removes the kubernetes finalizer that was keeping the Namespace alive.',
    detail: [
      'A Namespace with a deletionTimestamp is in phase Terminating and is very much still there. This controller asks discovery for every namespaced resource the API server serves, deletes all of them in that namespace, verifies the namespace is empty, and only then clears the finalizer that lets the object actually disappear.',
      'That is the whole explanation for a namespace stuck Terminating forever: some object inside it carries a finalizer of its own that nothing is removing, so the "is it empty" check never succeeds. The loop is not hung and it has not failed — it is doing exactly what it should, and it will keep checking until the object is released.',
    ],
    caveats: [
      'The model carries no Namespace objects; the machine is drawn running with an empty diff.',
    ],
    keywords: ['namespace', 'terminating', 'finalizer', 'discovery'],
  },
  {
    id: 'serviceaccount',
    plate: 'serviceaccount',
    title: 'ServiceAccount controller',
    kubeName: 'serviceaccount-controller',
    summary:
      'Ensures every Namespace has a ServiceAccount named default, so a Pod that names no identity still has one.',
    detail: [
      'The diff is trivial and almost never interesting: for each Namespace, does a ServiceAccount named default exist? If not, create it. Admission then writes spec.serviceAccountName: default onto every Pod that did not ask for an identity, which is why every Pod in the cluster has one whether its author thought about it or not.',
      'Since 1.24 it no longer mints a permanent Secret token per account. Tokens are short-lived, audience-bound and projected into the Pod by the kubelet through the TokenRequest API, refreshed before expiry — which is why kubectl get secrets in a fresh namespace now comes back empty and why a token copied out of a Pod stops working.',
    ],
    caveats: [
      'The model carries no Namespace or ServiceAccount objects; the machine is drawn running with an empty diff.',
    ],
    keywords: ['serviceaccount', 'default', 'token', 'TokenRequest', 'projected volume'],
  },
]

/* --------------------------------------------------------------------------
 * Per-machine mutable state. Preallocated: update() never creates one.
 * ------------------------------------------------------------------------*/

interface Machine {
  spec: Spec
  group: THREE.Group
  base: THREE.Vector3
  /** Position of the arm on the loop, in turns. Only ever moves forward. */
  angle01: number
  cacheMax: number
  lastErrors: number
  flash: number
  /** Write tokens already emitted during the current act phase. */
  spawned: number
  wasActing: boolean
  tokT: Float32Array
  tokOn: Uint8Array
  namePlate: Plate
  statusPlate: Plate
  backoffPlate: Plate
}

/** World x of a point `f` turns around a machine's loop, radius r. */
function ringX(base: number, f: number, r: number): number {
  return base + Math.sin(TAU * f) * r
}
function ringZ(base: number, f: number, r: number): number {
  return base - Math.cos(TAU * f) * r
}
/** Yaw that puts a station's local +X on the outward radial. */
function ringYaw(f: number): number {
  return Math.PI / 2 - TAU * f
}

export function createControllers(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'controllers'

  const geos: THREE.BufferGeometry[] = []
  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g)
    return g
  }
  const plates: Plate[] = []

  /* ---- geometry, built once and shared by all thirteen machines ---- */
  const gPodium = own(new THREE.BoxGeometry(PODIUM_W, WORK_Y, PODIUM_D))
  const gLip = own(new THREE.BoxGeometry(PODIUM_W + 1.4, 0.5, PODIUM_D + 1.4))
  const gHall = own(new THREE.CylinderGeometry(7.6, 7.9, 0.7, 24))
  const gSeam = own(new THREE.BoxGeometry(13.6, 0.16, 0.34))
  const gRail = own(new THREE.TorusGeometry(RAIL_R, 0.33, 6, 48).rotateX(-Math.PI / 2))
  const gRailPost = own(new THREE.CylinderGeometry(0.24, 0.24, RAIL_Y - WORK_Y, 6))
  const gMast = own(new THREE.CylinderGeometry(0.55, 0.75, ARM_Y - WORK_Y, 8))
  const gHub = own(new THREE.CylinderGeometry(1.5, 1.2, 1.3, 10))
  const gDrum = own(new THREE.CylinderGeometry(2.6, 2.6, 6, 16, 1, true))
  const gDrumCap = own(new THREE.CylinderGeometry(2.85, 2.85, 0.4, 16))
  const gFill = own(new THREE.CylinderGeometry(2.15, 2.15, 1, 16).translate(0, 0.5, 0))
  const gDish = own(new THREE.ConeGeometry(1.6, 1.7, 12, 1, true).rotateX(Math.PI))
  const gChute = own(new THREE.BoxGeometry(3.6, 0.7, 11.8))
  const gItem = own(new THREE.BoxGeometry(2.6, 1.0, 0.72))
  const gScanPost = own(new THREE.BoxGeometry(0.7, 6.2, 0.7))
  const gScanHead = own(new THREE.BoxGeometry(5.0, 1.1, 1.0))
  const gPort = own(new THREE.BoxGeometry(2.4, 4.6, 6.2))
  const gMouth = own(new THREE.BoxGeometry(0.5, 2.6, 4.2))
  const gGatePost = own(new THREE.CylinderGeometry(0.3, 0.3, 5, 6))
  const gBarrier = own(new THREE.BoxGeometry(0.5, 0.45, 4.2))
  const gBar = own(new THREE.BoxGeometry(0.62, 1, 0.62).translate(0, 0.5, 0))
  const gConduit = own(
    new THREE.TorusGeometry(CONDUIT_R, 0.22, 5, 40, 0.75 * Math.PI).rotateX(-Math.PI / 2),
  )
  const gSlot = own(new THREE.BoxGeometry(1.15, 2.4, 1.15).translate(0, 1.2, 0))
  const gErr = own(new THREE.BoxGeometry(1.6, 0.75, 1.6))
  const gBoom = own(new THREE.BoxGeometry(RAIL_R + 3.8, 0.45, 0.7))
  const gCarriage = own(new THREE.BoxGeometry(2.2, 1.7, 2.6))
  const gKey = own(new THREE.BoxGeometry(1.0, 0.3, 1.7))
  const gLamp = own(new THREE.SphereGeometry(0.55, 10, 8))
  const gFault = own(new THREE.SphereGeometry(0.72, 12, 10))
  const gToken = own(new THREE.BoxGeometry(0.95, 0.95, 0.95))
  const gRequeue = own(new THREE.BoxGeometry(1.1, 0.7, 1.1))

  /* ---- materials. All come from core/theme and are never disposed here. A
   * theme flip clears theme's cache, so every reference is re-fetched. ---- */
  type Role =
    | 'concrete' | 'deck' | 'lip' | 'rail' | 'steel' | 'shell' | 'cache' | 'queue'
    | 'ghost' | 'solid' | 'write' | 'err' | 'key' | 'lampOn' | 'lampOff'
    | 'backoff' | 'scan' | 'trunk' | 'leaseOn' | 'leaseOff'
  const M = {} as Record<Role, THREE.MeshStandardMaterial>
  function refreshMats(): void {
    M.concrete = mat(structural('concrete'))
    M.deck = mat(structural('deck'), 0.7)
    M.lip = neon(COLOR.controller, 0.55)
    M.rail = neon(COLOR.controller, 0.85)
    M.steel = mat(COLOR.edge, 0.55)
    M.shell = glass(COLOR.api, 0.16)
    M.cache = neon(COLOR.api, 1.25)
    M.queue = neon(COLOR.controller, 1.05)
    M.ghost = ghost(COLOR.desired, 0.34)
    M.solid = mat(COLOR.actual, 0.55)
    M.write = neon(COLOR.api, 2.0)
    M.err = neon(COLOR.failed, 1.8)
    M.key = neon(COLOR.api, 1.5)
    M.lampOn = neon(COLOR.controller, 2.2)
    M.lampOff = neon(COLOR.controller, 0.2)
    M.backoff = neon(COLOR.backoff, 1.9)
    M.scan = neon(COLOR.controller, 1.1)
    M.trunk = mat(COLOR.edge, 0.7)
    M.leaseOn = neon(COLOR.scheduler, 2.0)
    M.leaseOff = neon(COLOR.failed, 1.5)
  }
  refreshMats()

  /* Objects whose material must survive a theme flip. Parts that swap material
   * per frame (lamps) re-read M every update and heal themselves. */
  const themed: { o: THREE.Mesh | THREE.InstancedMesh; role: Role }[] = []

  function inst(
    g: THREE.BufferGeometry, role: Role, count: number, dynamic: boolean,
  ): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(g, M[role], count)
    im.instanceMatrix.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage)
    im.frustumCulled = false
    themed.push({ o: im, role })
    group.add(im)
    return im
  }

  function place(
    im: THREE.InstancedMesh, i: number,
    x: number, y: number, z: number, ry: number,
    sx = 1, sy = 1, sz = 1,
  ): void {
    _dummy.position.set(x, y, z)
    _dummy.rotation.set(0, ry, 0)
    _dummy.scale.set(sx, sy, sz)
    _dummy.updateMatrix()
    im.setMatrixAt(i, _dummy.matrix)
  }

  /** Park an instance out of sight without touching its draw order. */
  function hide(im: THREE.InstancedMesh, i: number): void {
    place(im, i, 0, -10000, 0, 0, 0, 0, 0)
  }

  const N = N_MACHINES
  /* Static structure: one InstancedMesh per repeated part. */
  const imLip = inst(gLip, 'lip', N, false)
  const imHall = inst(gHall, 'deck', N, false)
  const imSeam = inst(gSeam, 'lip', N, false)
  const imRail = inst(gRail, 'rail', N, false)
  const imRailPost = inst(gRailPost, 'steel', N * 4, false)
  const imMast = inst(gMast, 'steel', N, false)
  const imHub = inst(gHub, 'steel', N, false)
  const imDrum = inst(gDrum, 'shell', N, false)
  const imDrumCap = inst(gDrumCap, 'steel', N, false)
  const imDish = inst(gDish, 'shell', N, false)
  const imChute = inst(gChute, 'deck', N, false)
  const imScanPost = inst(gScanPost, 'steel', N, false)
  const imScanHead = inst(gScanHead, 'scan', N, false)
  const imPort = inst(gPort, 'steel', N, false)
  const imMouth = inst(gMouth, 'write', N, false)
  const imGatePost = inst(gGatePost, 'steel', N * 2, false)
  const imConduit = inst(gConduit, 'trunk', N, false)
  /* Moving parts. */
  const imBoom = inst(gBoom, 'steel', N, true)
  const imCarriage = inst(gCarriage, 'steel', N, true)
  const imKey = inst(gKey, 'key', N, true)
  const imLamp = inst(gLamp, 'lampOn', N, true)
  const imFault = inst(gFault, 'err', N, true)
  const imFill = inst(gFill, 'cache', N, true)
  const imItem = inst(gItem, 'queue', N * MAX_QUEUE, true)
  const imGhost = inst(gSlot, 'ghost', N * MAX_RACK, true)
  const imSolid = inst(gSlot, 'solid', N * MAX_RACK, true)
  const imToken = inst(gToken, 'write', N * MAX_TOKENS, true)
  const imErr = inst(gErr, 'err', N * MAX_ERR, true)
  const imBarrier = inst(gBarrier, 'backoff', N, true)
  const imBar = inst(gBar, 'backoff', N, true)
  const imRequeue = inst(gRequeue, 'queue', N, true)

  /* Ghost slots carry a per-instance tint: full brightness where desired has no
   * matter under it, dim where the loop has nothing left to do. */
  imGhost.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(N * MAX_RACK * 3), 3,
  )
  for (let i = 0; i < N * MAX_RACK; i++) imGhost.setColorAt(i, _cMet)

  /* ---- the machines ---- */
  const machines: Machine[] = []
  const pos = new THREE.Vector3()
  for (let i = 0; i < N; i++) {
    const id = CONTROLLER_ORDER[i]
    let spec: Spec | undefined
    for (let k = 0; k < SPECS.length; k++) if (SPECS[k].id === id) spec = SPECS[k]
    if (!spec) throw new Error(`controllers: no spec for "${id}"`)
    controllerPos(id, pos)

    const g = new THREE.Group()
    g.position.set(pos.x, 0, pos.z)
    group.add(g)

    const podium = new THREE.Mesh(gPodium, M.concrete)
    podium.position.y = WORK_Y / 2
    podium.receiveShadow = true
    themed.push({ o: podium, role: 'concrete' })
    g.add(podium)

    const namePlate = new Plate(16, 1, '#ffd9a8')
    namePlate.set(spec.plate)
    namePlate.sprite.position.set(0, WORK_Y + 15.5, 0)
    g.add(namePlate.sprite)

    const statusPlate = new Plate(16, 3)
    statusPlate.sprite.position.set(0, WORK_Y + 10.4, STATION_R + 1.6)
    g.add(statusPlate.sprite)

    const backoffPlate = new Plate(11, 1, '#ffc98a')
    backoffPlate.sprite.position.set(
      ringX(0, F_LIMIT, STATION_R), WORK_Y + 7.6, ringZ(0, F_LIMIT, STATION_R),
    )
    g.add(backoffPlate.sprite)
    plates.push(namePlate, statusPlate, backoffPlate)

    const bx = pos.x
    const bz = pos.z
    place(imLip, i, bx, WORK_Y - 0.2, bz, 0)
    place(imHall, i, bx, WORK_Y + 0.35, bz, 0)
    place(imSeam, i, bx, WORK_Y + 0.78, bz, 0)
    place(imRail, i, bx, RAIL_Y, bz, 0)
    for (let k = 0; k < 4; k++) {
      const f = k * 0.25
      place(
        imRailPost, i * 4 + k,
        ringX(bx, f, RAIL_R), WORK_Y + (RAIL_Y - WORK_Y) / 2, ringZ(bz, f, RAIL_R), 0,
      )
    }
    place(imMast, i, bx, WORK_Y + (ARM_Y - WORK_Y) / 2, bz, 0)
    place(imHub, i, bx, ARM_Y, bz, 0)
    /* Intake, north: this loop's window onto the shared informer cache. */
    place(imDrum, i, ringX(bx, F_INTAKE, STATION_R), WORK_Y + 3, ringZ(bz, F_INTAKE, STATION_R), 0)
    place(imDrumCap, i, ringX(bx, F_INTAKE, STATION_R), WORK_Y + 6.2, ringZ(bz, F_INTAKE, STATION_R), 0)
    place(imDish, i, ringX(bx, F_INTAKE, STATION_R), WORK_Y + 7.3, ringZ(bz, F_INTAKE, STATION_R), 0)
    /* Workqueue, east: a FIFO line whose head sits on the arm's path. */
    place(
      imChute, i,
      ringX(bx, F_QUEUE, STATION_R), WORK_Y + 0.35, ringZ(bz, F_QUEUE, STATION_R) - 4.95, 0,
    )
    /* Diff scanner, south: it looks inward, at the reconcile hall. */
    place(imScanPost, i, ringX(bx, F_DIFF, STATION_R), WORK_Y + 3.1, ringZ(bz, F_DIFF, STATION_R), 0)
    place(imScanHead, i, ringX(bx, F_DIFF, STATION_R), WORK_Y + 6.4, ringZ(bz, F_DIFF, STATION_R), 0)
    /* Write port, west: it faces the API server tower at x = 0. */
    place(imPort, i, ringX(bx, F_WRITE, STATION_R), WORK_Y + 2.3, ringZ(bz, F_WRITE, STATION_R), 0)
    place(imMouth, i, ringX(bx, F_WRITE, STATION_R) - 1.3, WORK_Y + 2.6, ringZ(bz, F_WRITE, STATION_R), 0)
    /* Rate limiter, north-west, astride the delay line back to the queue. */
    const lyaw = ringYaw(F_LIMIT)
    for (let k = 0; k < 2; k++) {
      const off = k === 0 ? 2.1 : -2.1
      place(
        imGatePost, i * 2 + k,
        ringX(bx, F_LIMIT, STATION_R) + Math.sin(lyaw) * off, WORK_Y + 2.5,
        ringZ(bz, F_LIMIT, STATION_R) + Math.cos(lyaw) * off, lyaw,
      )
    }
    place(imConduit, i, bx, WORK_Y + 3.2, bz, -0.625 * TAU)

    machines.push({
      spec,
      group: g,
      base: new THREE.Vector3(pos.x, 0, pos.z),
      angle01: F_INTAKE,
      cacheMax: 16,
      lastErrors: 0,
      flash: 0,
      spawned: 0,
      wasActing: false,
      tokT: new Float32Array(MAX_TOKENS),
      tokOn: new Uint8Array(MAX_TOKENS),
      namePlate,
      statusPlate,
      backoffPlate,
    })
  }
  const STATIC_IMS = [
    imLip, imHall, imSeam, imRail, imRailPost, imMast, imHub, imDrum, imDrumCap,
    imDish, imChute, imScanPost, imScanHead, imPort, imMouth, imGatePost, imConduit,
  ]
  for (let i = 0; i < STATIC_IMS.length; i++) STATIC_IMS[i].instanceMatrix.needsUpdate = true

  /* ---- yard furniture: one watch trunk, one shared cache, one Lease ---- */
  const yx = ANCHOR.controllerYard[0]
  const yz = ANCHOR.controllerYard[2]
  /* The write gate is the first point of the controllers-to-api route, so the
   * tokens leave exactly where the flow engine picks them up. */
  const gateP = route('controllers-to-api').points[0]
  const GX = gateP[0]
  const GY = gateP[1]
  const GZ = gateP[2]

  const gTrunk = own(new THREE.BoxGeometry(3.2, 1.1, 196))
  const trunk = new THREE.Mesh(gTrunk, M.trunk)
  trunk.position.set(yx, 30.6, yz)
  themed.push({ o: trunk, role: 'trunk' })
  group.add(trunk)

  const gSharedShell = own(new THREE.CylinderGeometry(6, 6, 7.4, 20, 1, true))
  const sharedShell = new THREE.Mesh(gSharedShell, M.shell)
  sharedShell.position.set(yx, 34.5, yz)
  themed.push({ o: sharedShell, role: 'shell' })
  group.add(sharedShell)

  const gSharedFill = own(new THREE.CylinderGeometry(5.2, 5.2, 1, 20).translate(0, 0.5, 0))
  const sharedFill = new THREE.Mesh(gSharedFill, M.cache)
  sharedFill.position.set(yx, 31, yz)
  themed.push({ o: sharedFill, role: 'cache' })
  group.add(sharedFill)

  /* One drop per machine: thirteen loops, one watch. */
  const linePts = new Float32Array(N * 6)
  for (let i = 0; i < N; i++) {
    const b = machines[i].base
    linePts[i * 6 + 0] = yx
    linePts[i * 6 + 1] = 30.2
    linePts[i * 6 + 2] = b.z
    linePts[i * 6 + 3] = b.x
    linePts[i * 6 + 4] = WORK_Y + 8.1
    linePts[i * 6 + 5] = b.z - STATION_R
  }
  const gWatch = own(new THREE.BufferGeometry())
  gWatch.setAttribute('position', new THREE.BufferAttribute(linePts, 3))
  const watchMat = new THREE.LineBasicMaterial({
    color: COLOR.api,
    transparent: true,
    opacity: 0.5,
  })
  const watchLines = new THREE.LineSegments(gWatch, watchMat)
  group.add(watchLines)

  /* Leader election: the Lease that decides whether any of this runs. */
  const gPylon = own(new THREE.CylinderGeometry(1.1, 1.6, 26, 8))
  const pylon = new THREE.Mesh(gPylon, M.steel)
  pylon.position.set(yx - 78, 13, yz)
  themed.push({ o: pylon, role: 'steel' })
  group.add(pylon)

  const gLease = own(new THREE.BoxGeometry(3.4, 3.4, 3.4))
  const lease = new THREE.Mesh(gLease, M.leaseOn)
  lease.position.set(yx - 78, 28, yz)
  group.add(lease)

  const gGateRing = own(new THREE.TorusGeometry(3.6, 0.4, 6, 24))
  const gateRing = new THREE.Mesh(gGateRing, M.write)
  gateRing.position.set(GX, GY, GZ)
  themed.push({ o: gateRing, role: 'write' })
  group.add(gateRing)

  const yardPlate = new Plate(46, 1, '#ffd9a8')
  yardPlate.set('kube-controller-manager')
  yardPlate.sprite.position.set(yx, 17, yz + 96)
  group.add(yardPlate.sprite)
  plates.push(yardPlate)

  /* ---- explainers ---- */
  const reg = ctx.registry
  /*
   * The process boundary. kube-controller-manager is one binary running many
   * loops; a yard of separate podiums read as separate services.
   */
  const processHall = buildHall({
    center: ANCHOR.controllerYard,
    hx: 106,
    hz: 104,
    baseY: CITY.mesa.top,
    height: 76,
    bays: 2,
  })
  group.add(processHall.group)
  reg.register({
    id: 'controllers.process',
    title: 'One controller-manager process',
    district: 'controllers',
    kubeName: 'kube-controller-manager',
    object: processHall.group,
    summary: 'The frame is the process boundary: every loop inside it runs in one binary, sharing one informer cache.',
    detail: [
      'kube-controller-manager is a single process that runs dozens of controllers as goroutines. The Deployment, ReplicaSet, node, endpoint and garbage collection loops drawn inside this frame are not separate deployments; they start and stop together.',
      'They share one set of informers, which is why a controller reacts to a watch event rather than polling, and why a slow apiserver slows all of them at once.',
      'Each loop is level-triggered: it compares desired against actual and acts on the difference, so a missed event costs latency rather than correctness.',
      'Replicas run for availability, and a Lease elects exactly one active manager.',
    ],
    caveats: [
      'The frame is drawn structure with no counterpart in the API: no object describes a process boundary. It is here because separate podiums implied separate services where there is one binary.',
      'Only a few of the real controllers are drawn, and the cloud-controller-manager, which runs the cloud-specific loops in its own process, is not.',
    ],
  })

  const eLoop = reg.register({
    id: 'controllers.reconcile-loop',
    title: 'Reconciliation',
    district: 'controllers',
    kubeName: 'controller reconcile loop',
    summary:
      'The one idea the rest of Kubernetes falls out of: read desired state, read actual state, take one step toward closing the gap, then run again — forever, whether or not anything changed.',
    detail: [
      'A controller is not a pipeline stage and it is not an event handler with side effects. It is a function reconcile(key) error wrapped in an infinite loop. Given a key like shop/web it reads the current desired state and the current actual state, performs whatever writes reduce the difference, and returns. It is never told what changed, and it does not care.',
      'That is what level-triggered means. An edge-triggered system reacts to the event "replicas went from 2 to 4" and is permanently wrong if it ever misses one. A level-triggered system reads the level — spec says 4, I count 2 — and is correct on the very next pass no matter how many events it dropped, how long it was dead, or whether its cache was cold. It is the reason a control plane can be killed mid-operation and recover by doing nothing but running its loops again.',
      'Watches are therefore only an optimisation: they tell the loop when it is worth looking, never what to do. Every informer also resyncs on a timer (typically 10 to 30 minutes), so a missed event costs latency, not correctness. Most passes find nothing and write nothing — the arm still dequeues, still diffs, still comes round. That is the loop working, not idling.',
      'Reconcile must be idempotent and it makes progress in steps, not transactions. There is no rollback: if it creates two Pods and dies, the next pass counts what exists and creates the rest. Its only output is an API write, and that write comes back to it through its own watch — the loop closes because the controller is its own next input.',
    ],
    caveats: [
      'A real loop runs as fast as its queue delivers keys, often thousands of reconciles a second finishing in microseconds. Here one pass takes seconds so each phase is watchable.',
      'These thirteen machines are goroutines in one process sharing one informer factory, not thirteen separate plants.',
      'Each machine shows one aggregate diff; a real reconcile compares one object against one object.',
    ],
    keywords: ['reconcile', 'level triggered', 'edge triggered', 'control loop', 'idempotent', 'resync'],
    object: group,
    focus: [yx - 60, 40, yz + 40],
    metrics: (s) => {
      let q = 0
      let r = 0
      let e = 0
      for (let i = 0; i < N; i++) {
        const c = s.controllers[machines[i].spec.id]
        q += c.queueDepth
        r += c.reconciles
        e += c.errors
      }
      return [
        { label: 'loops drawn', value: String(N), hint: 'a real manager runs about forty' },
        { label: 'queued keys', value: String(q) },
        { label: 'reconciles', value: String(r) },
        { label: 'errors', value: String(e) },
      ]
    },
  })

  const eDiff = reg.register({
    id: 'controllers.desired-vs-actual',
    title: 'Desired against actual',
    district: 'controllers',
    summary:
      'Desired state is a record someone wrote. Actual state is what exists. The gap between them is the only thing a controller ever acts on.',
    detail: [
      'In the reconcile hall the back row is DESIRED, translucent, because it is a record in etcd and nothing more. The front row is ACTUAL, solid, because it is a thing that exists. A pass reads both rows; the ghosts with no matter under them are the entire work list, and the machine acts on those and on nothing else.',
      'Desired state does not only come from a human. A Deployment spec is desired state for the Deployment controller; the ReplicaSet it writes is desired state for the ReplicaSet controller; the Pod that controller writes is desired state for the scheduler, and once bound, spec.nodeName is desired state for one kubelet. Almost every controller output is another controller input, and the chain ends at the only components that touch reality.',
      'Actual state is never read from the thing itself. The controller reads the API server copy, which was reported there by whoever owns the real resource — a kubelet reporting pod status, a node reporting conditions. A controller trusts a record, and a record can be stale; being briefly wrong is safe precisely because the loop runs again.',
      'When actual exceeds desired the difference is still the work list, and the write is a delete. Scaling down, evicting, and garbage collection are the same arithmetic with the sign reversed.',
    ],
    caveats: [
      'Counts are aggregated over every object of the relevant kind in the model, capped at eight blocks per row; the plate carries the exact numbers.',
    ],
    keywords: ['desired state', 'actual state', 'spec', 'status', 'diff', 'ghost'],
    object: imGhost,
  })

  const eInformer = reg.register({
    id: 'controllers.informer',
    title: 'Informer and watch cache',
    district: 'controllers',
    kubeName: 'SharedInformerFactory',
    summary:
      'One watch per resource type, shared by every loop in the process, backed by an in-memory cache the controllers read instead of calling the API server.',
    detail: [
      'A controller never polls and almost never issues a GET. On start the informer does one LIST, remembers the resourceVersion that list was taken at, opens a WATCH from that revision, and applies every add, update and delete into a local store. Reads inside reconcile go to that store through a lister and cost nothing but a map lookup.',
      'The factory is shared. Thirteen loops do not open thirteen watches on Pods: one informer per group-version-resource fans its events out to every registered handler, which is why a single trunk feeds this whole yard. It is also why an apiserver sees a handful of watch connections from a controller-manager rather than dozens.',
      'The handler does not reconcile. It does exactly one thing: turn the changed object into a key — namespace/name, or the key of its controlling owner — and add it to that loop workqueue. All the actual work happens on the far side of the queue, which is what decouples watch delivery rate from reconcile rate.',
      'The cache is eventually consistent and reconcile logic has to survive that. A controller can create a Pod and then not see it in its own cache. They defend with expectations, with resourceVersion checks on write, and with the fact that being wrong once is harmless — the next pass corrects it.',
    ],
    caveats: [
      'The tank fill is the model cached count scaled to a readable height. A real store also holds indices and the previous object version used to compute deltas.',
      'A watch stream carries whole objects; here it is drawn as an undifferentiated feed.',
    ],
    keywords: ['informer', 'watch', 'lister', 'cache', 'resourceVersion', 'relist', 'DeltaFIFO'],
    object: sharedShell,
  })

  const eQueue = reg.register({
    id: 'controllers.workqueue',
    title: 'Workqueue',
    district: 'controllers',
    kubeName: 'workqueue.RateLimitingInterface',
    summary:
      'A deduplicating queue of keys — not of events and not of objects — sitting between the informer handlers and the reconcile function.',
    detail: [
      'Items are strings. Adding shop/web five times while a worker is busy collapses to one item, so a burst of a hundred updates causes one reconcile rather than a hundred. This is the single mechanism that lets a controller survive a stampede without any rate logic of its own.',
      'The queue guarantees a key is processed by at most one worker at a time, and holds any further add for that key until the worker calls Done. That guarantee is what removes the need for locking inside reconcile, and why --concurrent-deployment-syncs can be raised safely.',
      'Because the item carries no payload, by the time a worker reaches it the object may have changed again or been deleted. Reconcile always re-reads current state from the cache, and handles "the object is gone" as an ordinary outcome rather than an error.',
    ],
    caveats: [
      'Depth is drawn as physical items capped at twelve in the chute; the exact number is on the plate.',
    ],
    keywords: ['workqueue', 'dedup', 'key', 'namespace/name', 'worker', 'concurrency'],
    object: imItem,
  })

  const eLimit = reg.register({
    id: 'controllers.rate-limiter',
    title: 'Rate limiter, backoff and errors',
    district: 'controllers',
    kubeName: 'DefaultControllerRateLimiter',
    summary:
      'A failed reconcile puts the key back on the queue, but not immediately: a per-item exponential backoff plus a process-wide token bucket decides when it may be tried again.',
    detail: [
      'The default is two limiters taking whichever delay is longer: per item, 5ms doubling to 1000s; overall, a bucket of 100 refilling at 10 per second. A key that keeps failing is retried at a widening interval. A key that succeeds calls Forget and its counter resets to zero, which is why one bad object cannot poison a healthy one.',
      'This is what stops a broken object from spinning a loop at full speed against the API server. The loop that fails on a missing PVC is the same loop that would otherwise generate thousands of requests a second and take the control plane down with it.',
      'An error is not exceptional here. HTTP 409 Conflict is routine: two writers touched the same object, the resourceVersion no longer matches, the write is rejected, and the correct response is to requeue and reconcile again against the newer state. Optimistic concurrency plus a retry loop is how Kubernetes gets consistency without distributed locks.',
      'Errors are also published as Events on the object, which is why kubectl describe explains far more than a controller log ever does.',
    ],
    caveats: [
      'The visible cool-down is the model backoffSeconds on a human scale; real per-item backoff starts at five milliseconds. The tally blocks are capped at six.',
    ],
    keywords: ['backoff', 'rate limit', 'requeue', 'conflict', '409', 'retry', 'errors'],
    object: imBarrier,
  })

  const eLease = reg.register({
    id: 'controllers.leader-election',
    title: 'Leader election',
    district: 'controllers',
    kubeName: 'lease/kube-controller-manager',
    summary:
      'Every replica of kube-controller-manager runs; only the one holding the Lease runs any loops at all. The rest do nothing but try to take it.',
    detail: [
      'The lock is an ordinary API object: a Lease in kube-system named kube-controller-manager, holding a holder identity and a renew timestamp. The holder renews every 2s (retryPeriod) and must succeed within 10s (renewDeadline); a challenger may claim it after 15s (leaseDuration) without a renewal. It is stored in etcd like everything else, so the election is only as available as the API server.',
      'A standby does not warm up. Informers start after the election is won, so a failover pays a full LIST and a cold cache before its first reconcile — seconds, not milliseconds. That gap is invisible in a healthy cluster and very visible during a control-plane rolling restart.',
      'Correctness does not depend on the lease being perfect. If two managers briefly believed they held it, both would reconcile toward the same desired state, and conflicts plus the next pass would sort it out. The lease exists to prevent duplicate writes and wasted work, not to make the loops safe — the loops are safe because they are level-triggered.',
      'When this beacon is dark, nothing in this yard is running: no watches, no queues, no writes. That is what standby means.',
    ],
    caveats: [
      'One manager is modelled. The scheduler runs a separate election with its own Lease, which is why one can be leading while the other is not.',
    ],
    keywords: ['leader election', 'lease', 'standby', 'HA', 'renewDeadline', 'failover'],
    object: lease,
  })

  const eWrite = reg.register({
    id: 'controllers.write-back',
    title: 'Writing back to the API',
    district: 'controllers',
    summary:
      'A controller output is an API write and nothing else. It never talks to etcd, never talks to a kubelet, and never touches a container.',
    detail: [
      'Everything a controller does is a create, update, patch or delete against kube-apiserver, riding the same authentication, RBAC, admission and validation pipeline as kubectl. The Deployment controller creates a ReplicaSet in exactly the way you would, and can be denied in exactly the same ways.',
      'It writes as its own ServiceAccount, and the bindings are narrow: most loops may write only the objects they own plus their own status subresource. A controller that starts failing after an RBAC change is not broken, it is forbidden, and the Events say so.',
      'The write returns a new resourceVersion and then arrives back through this loop own watch, one revision later. That is why the circuit here closes at the write port and not at some external orchestrator: the controller output is its own next input.',
      'Writes use optimistic concurrency. A patch on a stale object is rejected with 409, requeued, and retried against the newer state rather than overwriting a change somebody else made.',
    ],
    caveats: [
      'One token is one API write. Tokens leave along a single route rather than opening individual connections, and the count is capped at four per pass.',
    ],
    keywords: ['api write', 'patch', 'status subresource', 'rbac', 'serviceaccount', 'conflict'],
    object: gateRing,
  })

  const eYard = reg.register({
    id: 'controllers.manager',
    title: 'kube-controller-manager',
    district: 'controllers',
    kubeName: 'kube-controller-manager',
    summary:
      'One process: one leader election, one shared informer factory, and roughly forty independent reconcile loops running as goroutines inside it.',
    detail: [
      'It is a single binary. --controllers enables or disables loops by name; each gets its own workqueue and its own worker goroutines (--concurrent-deployment-syncs and friends) while sharing the informer cache with all the others. Its client is rate-limited as a whole (--kube-api-qps, --kube-api-burst), so a storm in one loop does slow the rest.',
      'Cloud-specific loops — node addresses, route programming, LoadBalancer provisioning — were split out into cloud-controller-manager so that the core binary carries no provider code. That split is why a bare-metal cluster leaves Service type LoadBalancer pending forever with nothing to blame.',
      'Nothing in this yard schedules a Pod and nothing here starts a container. Every machine turns records into other records; only the scheduler assigns a node, and only a kubelet makes anything run.',
    ],
    caveats: [
      'Thirteen loops are drawn, each as its own machine. A real manager runs about forty inside one process on one node.',
    ],
    keywords: ['controller manager', 'control plane', 'goroutine', 'cloud controller manager'],
    object: trunk,
    focus: [yx + 130, 90, yz + 150],
  })

  reg.bind(imRail, eLoop)
  reg.bind(imBoom, eLoop)
  reg.bind(imCarriage, eLoop)
  reg.bind(imRailPost, eLoop)
  reg.bind(imMast, eLoop)
  reg.bind(imHub, eLoop)
  reg.bind(imLamp, eLoop)
  reg.bind(imHall, eDiff)
  reg.bind(imSeam, eDiff)
  reg.bind(imSolid, eDiff)
  reg.bind(imScanPost, eDiff)
  reg.bind(imScanHead, eDiff)
  reg.bind(imDrum, eInformer)
  reg.bind(imDrumCap, eInformer)
  reg.bind(imDish, eInformer)
  reg.bind(imFill, eInformer)
  reg.bind(sharedFill, eInformer)
  reg.bind(watchLines, eInformer)
  reg.bind(imChute, eQueue)
  reg.bind(imRequeue, eQueue)
  reg.bind(imGatePost, eLimit)
  reg.bind(imBar, eLimit)
  reg.bind(imConduit, eLimit)
  reg.bind(imErr, eLimit)
  reg.bind(imFault, eLimit)
  reg.bind(pylon, eLease)
  reg.bind(imPort, eWrite)
  reg.bind(imMouth, eWrite)
  reg.bind(imToken, eWrite)
  reg.bind(imLip, eYard)
  reg.bind(yardPlate.sprite, eYard)

  for (let i = 0; i < N; i++) {
    const m = machines[i]
    const sp = m.spec
    const id = sp.id
    reg.register({
      id: `controllers.${id}`,
      title: sp.title,
      district: 'controllers',
      kubeName: sp.kubeName,
      summary: sp.summary,
      detail: sp.detail,
      caveats: sp.caveats,
      keywords: sp.keywords,
      object: m.group,
      metrics: (s) => {
        const c = s.controllers[id]
        DIFFS[id](s, _diff)
        return [
          { label: 'phase', value: c.leading ? c.phase : 'standby' },
          { label: 'key', value: c.currentKey ?? '(none)' },
          { label: 'queue depth', value: String(c.queueDepth) },
          { label: 'cached objects', value: String(c.cached) },
          { label: 'desired', value: String(_diff.desired) },
          { label: 'actual', value: String(_diff.actual) },
          { label: 'writes this pass', value: String(_diff.writes) },
          { label: 'reconciles', value: String(c.reconciles) },
          {
            label: 'errors',
            value: String(c.errors),
            hint: c.backoffSeconds > 0 ? 'backing off' : undefined,
          },
        ]
      },
    })
  }

  /* A theme flip disposes and rebuilds theme's material cache, so every
   * reference taken above becomes stale. Re-fetch and re-assign. */
  function applyTheme(): void {
    refreshMats()
    for (let i = 0; i < themed.length; i++) themed[i].o.material = M[themed[i].role]
  }
  const offTheme = ctx.bus.on('theme', applyTheme)

  const ghostColors = imGhost.instanceColor as THREE.InstancedBufferAttribute
  const DYNAMIC_IMS = [
    imBoom, imCarriage, imKey, imLamp, imFault, imFill, imItem, imGhost, imSolid,
    imToken, imErr, imBarrier, imBar, imRequeue,
  ]
  /* Boom centre offset: it runs from the counterweight at -3 to just past the
   * rail, so its midpoint sits inside the ring, not on it. */
  const BOOM_R = (RAIL_R + 0.8 - 3) / 2
  const LIMIT_YAW = ringYaw(F_LIMIT)
  const LIMIT_SIN = Math.sin(LIMIT_YAW)
  const LIMIT_COS = Math.cos(LIMIT_YAW)
  let sharedMax = 32
  let plateTimer = 0

  function update(s: SimState, dt: number): void {
    plateTimer += dt
    const doPlates = plateTimer >= 0.2
    if (doPlates) plateTimer = 0

    let leadingCount = 0
    let totalCached = 0

    for (let i = 0; i < N; i++) {
      const m = machines[i]
      const id = m.spec.id
      const c = s.controllers[id]
      const bx = m.base.x
      const bz = m.base.z
      const leading = c.leading
      if (leading) leadingCount += 1
      totalCached += c.cached

      /* ---- the arm. It only ever moves forward: a loop does not rewind. ---- */
      if (leading) {
        if (c.phase === 'idle') {
          /* Nothing to do is not a reason to stop: this is the resync sweep. */
          m.angle01 = wrap01(m.angle01 + IDLE_LAPS * dt)
        } else {
          const target = phaseF(c.phase, c.progress)
          let d = target - m.angle01
          if (d < 0) d += 1
          const step = CHASE_LAPS * dt
          m.angle01 = d <= step ? target : wrap01(m.angle01 + step)
        }
      }
      const f = m.angle01
      const sf = Math.sin(TAU * f)
      const cf = -Math.cos(TAU * f)
      const yaw = Math.PI / 2 - TAU * f

      place(imBoom, i, bx + sf * BOOM_R, ARM_Y, bz + cf * BOOM_R, yaw)
      place(imCarriage, i, bx + sf * RAIL_R, ARM_Y - 4, bz + cf * RAIL_R, yaw)
      const lampS = leading ? (c.phase === 'idle' ? 0.45 : 1) : 0
      place(imLamp, i, bx + sf * 4.6, ARM_Y - 0.8, bz + cf * 4.6, yaw, lampS, lampS, lampS)

      /* The key is carried from the queue, over the hall, to the write port. */
      const carrying =
        leading && (c.phase === 'dequeue' || c.phase === 'diff' || c.phase === 'act')
      if (carrying) place(imKey, i, bx + sf * RAIL_R, ARM_Y - 5.6, bz + cf * RAIL_R, yaw)
      else hide(imKey, i)

      /* ---- informer cache fill ---- */
      if (c.cached > m.cacheMax) m.cacheMax = c.cached
      const fill = leading ? clamp(c.cached / m.cacheMax, 0, 1) : 0
      if (fill > 0.002) {
        place(
          imFill, i,
          ringX(bx, F_INTAKE, STATION_R), WORK_Y + 0.4, ringZ(bz, F_INTAKE, STATION_R),
          0, 1, fill * 5.4, 1,
        )
      } else hide(imFill, i)

      /* ---- workqueue: depth as items, head on the arm's path ---- */
      const qx = ringX(bx, F_QUEUE, STATION_R)
      const qz = ringZ(bz, F_QUEUE, STATION_R)
      const shown = leading ? Math.min(c.queueDepth, MAX_QUEUE) : 0
      for (let k = 0; k < MAX_QUEUE; k++) {
        const idx = i * MAX_QUEUE + k
        if (k < shown) place(imItem, idx, qx, WORK_Y + 1.2, qz - k * 0.9, 0)
        else hide(imItem, idx)
      }

      /* ---- the diff: ghosts against matter ---- */
      DIFFS[id](s, _diff)
      const nD = leading ? Math.min(_diff.desired, MAX_RACK) : 0
      const nA = leading ? Math.min(_diff.actual, MAX_RACK) : 0
      for (let k = 0; k < MAX_RACK; k++) {
        const idx = i * MAX_RACK + k
        const sx = bx + (k - (MAX_RACK - 1) / 2) * 1.5
        if (k < nD) {
          place(imGhost, idx, sx, WORK_Y + 0.7, bz - 2.7, 0)
          /* Bright where desired has no matter under it: that is the work list. */
          imGhost.setColorAt(idx, k >= nA ? _cGap : _cMet)
        } else hide(imGhost, idx)
        if (k < nA) place(imSolid, idx, sx, WORK_Y + 0.7, bz + 2.7, 0)
        else hide(imSolid, idx)
      }

      /* ---- writes: one token per API write this pass ---- */
      const acting = leading && c.phase === 'act'
      if (acting && !m.wasActing) m.spawned = 0
      m.wasActing = acting
      if (acting) {
        const want = Math.min(_diff.writes, MAX_TOKENS)
        const due = Math.min(Math.floor(c.progress * want) + 1, want)
        while (m.spawned < due) {
          let slot = -1
          for (let k = 0; k < MAX_TOKENS; k++) {
            if (m.tokOn[k] === 0) {
              slot = k
              break
            }
          }
          if (slot < 0) break
          m.tokOn[slot] = 1
          m.tokT[slot] = 0
          m.spawned += 1
        }
      }
      const wx = ringX(bx, F_WRITE, STATION_R) - 2.2
      const wz = ringZ(bz, F_WRITE, STATION_R)
      for (let k = 0; k < MAX_TOKENS; k++) {
        const idx = i * MAX_TOKENS + k
        if (m.tokOn[k] === 0) {
          hide(imToken, idx)
          continue
        }
        const t = m.tokT[k] + dt / TOKEN_FLIGHT
        m.tokT[k] = t
        if (t >= 1) {
          m.tokOn[k] = 0
          hide(imToken, idx)
          continue
        }
        place(
          imToken, idx,
          wx + (GX - wx) * t,
          WORK_Y + 2.6 + (GY - WORK_Y - 2.6) * t + Math.sin(Math.PI * t) * 5,
          wz + (GZ - wz) * t,
          t * 6,
        )
      }

      /* ---- rate limiter: the gate is down for as long as the backoff runs ---- */
      const bo = c.backoffSeconds
      const closed = bo > 0
      const lx = ringX(bx, F_LIMIT, STATION_R)
      const lz = ringZ(bz, F_LIMIT, STATION_R)
      place(imBarrier, i, lx, WORK_Y + (closed ? 1.4 : 4.7), lz, LIMIT_YAW)
      const boF = clamp(bo / BACKOFF_FULL, 0, 1)
      if (boF > 0.002) {
        place(
          imBar, i,
          lx + LIMIT_SIN * 2.9, WORK_Y + 0.4, lz + LIMIT_COS * 2.9,
          0, 1, boF * 5, 1,
        )
      } else hide(imBar, i)

      /* The requeued key waits at the gate, then rides the delay line back. */
      if (leading && (closed || c.phase === 'requeue')) {
        const rf = closed ? F_LIMIT : F_LIMIT + 0.375 * clamp(c.progress, 0, 1)
        place(imRequeue, i, ringX(bx, rf, CONDUIT_R), WORK_Y + 3.9, ringZ(bz, rf, CONDUIT_R), 0)
      } else hide(imRequeue, i)

      /* ---- errors, as objects rather than a counter ---- */
      if (c.errors > m.lastErrors) m.flash = 1
      m.lastErrors = c.errors
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 0.7)
      const nErr = Math.min(c.errors, MAX_ERR)
      for (let k = 0; k < MAX_ERR; k++) {
        const idx = i * MAX_ERR + k
        if (k < nErr) place(imErr, idx, bx - 13.4, WORK_Y + 0.5 + k * 0.95, bz + 11.2, 0)
        else hide(imErr, idx)
      }
      if (closed || m.flash > 0) {
        const p = 1 + 0.3 * Math.sin(s.t * 8) + m.flash * 0.6
        place(imFault, i, bx, ARM_Y + 1.7, bz, 0, p, p, p)
      } else hide(imFault, i)

      /* ---- plates. Rebuilt at 5 Hz, redrawn only when the text changes. ---- */
      if (doPlates) {
        if (!leading) {
          m.statusPlate.set('standby\nno informers\nno queue')
        } else {
          m.statusPlate.set(
            (c.currentKey ?? 'idle') +
              '\ndesired ' + _diff.desired + '  actual ' + _diff.actual +
              '\nsync ' + c.reconciles + '  err ' + c.errors,
          )
        }
        if (closed) {
          m.backoffPlate.set('backoff ' + bo.toFixed(1) + 's')
          m.backoffPlate.setVisible(true)
        } else {
          m.backoffPlate.setVisible(false)
        }
      }
    }

    /* ---- the yard: one Lease decides whether any of this runs ---- */
    const yardLeading = leadingCount > 0
    lease.material = yardLeading ? M.leaseOn : M.leaseOff
    const renew = yardLeading ? 1 + 0.28 * Math.exp(-3 * (s.t % 2)) : 0.72
    lease.scale.set(renew, renew, renew)
    imLamp.material = yardLeading ? M.lampOn : M.lampOff
    watchLines.visible = yardLeading
    if (totalCached > sharedMax) sharedMax = totalCached
    const sf2 = yardLeading ? clamp(totalCached / sharedMax, 0, 1) : 0
    sharedFill.visible = sf2 > 0.002
    sharedFill.scale.set(1, sf2 * 6.8, 1)
    gateRing.rotation.z = s.t * 0.6

    for (let i = 0; i < DYNAMIC_IMS.length; i++) DYNAMIC_IMS[i].instanceMatrix.needsUpdate = true
    ghostColors.needsUpdate = true
  }

  function dispose(): void {
    offTheme()
    processHall.dispose()
    for (let i = 0; i < geos.length; i++) geos[i].dispose()
    for (let i = 0; i < plates.length; i++) plates[i].dispose()
    watchMat.dispose()
  }

  return { group, update, dispose }
}

/* --------------------------------------------------------------------------
 * Loop position. Phases map onto stations; `progress` carries the arm from the
 * station it is working at toward the next one, dwelling before it travels.
 * ------------------------------------------------------------------------*/

function wrap01(v: number): number {
  return v - Math.floor(v)
}

function phaseF(phase: ReconcilePhase, progress: number): number {
  const p = smoothstep(0.3, 1, clamp(progress, 0, 1))
  switch (phase) {
    case 'dequeue':
      return wrap01(F_QUEUE + 0.25 * p)
    case 'diff':
      return wrap01(F_DIFF + 0.25 * p)
    case 'act':
      return wrap01(F_WRITE + 0.125 * p)
    case 'requeue':
      return wrap01(F_LIMIT + 0.375 * p)
    default:
      return F_INTAKE
  }
}
