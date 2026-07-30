/* ============================================================================
 * sim/kubelet.ts — the node agent and the container lifecycle.
 *
 * The stage order is the lesson:
 *
 *   pull image -> create sandbox -> CNI ADD (the pod gets its IP) -> CSI mount
 *   -> init containers, to completion, in order -> app containers -> probes
 *
 * A pod has no IP until CNI has run; init containers gate everything after
 * them. Then: the startup probe gates both other probes, readiness controls
 * traffic and nothing else, and liveness restarts the container. Restarts back
 * off exponentially from 10 s to 300 s and reset only after 10 minutes of
 * clean running.
 *
 * SIMPLIFICATION worth stating, because it is visible: a real kubelet mounts
 * volumes and creates the sandbox *before* pulling container images, so a pod
 * stuck in ImagePullBackOff already has an IP while one stuck on FailedMount
 * does not. This model pulls first, matching how the sequence is usually
 * taught, so a backing-off pull shows no IP yet. What gates what is unchanged.
 * ==========================================================================*/

import {
  NODE_RESERVED_CPU_MILLICORES,
  NODE_RESERVED_MEM_MIB,
  TIMING,
  type ContainerReason,
  type ContainerState,
  type NodeState,
  type PodState,
} from '../core/types'
import { approach, clamp, formatMem, podIp } from '../core/util'
import { submit } from './controlplane'
import {
  MODEL,
  emit,
  nodeIsDown,
  podIsReady,
  podIsTerminating,
  podRequestCpu,
  podRequestMem,
  podUsedCpu,
  podUsedMem,
  removePod,
  setCondition,
  type ContainerRuntime,
  type PodRuntime,
  type SimCtx,
} from './ctx'
import { admittedRps } from './network'
import { ensurePodVolumes, releasePodVolumes } from './storage'

/* Model seconds the sandbox and CNI steps take. Real: 100 ms to a few seconds. */
const SANDBOX_SECONDS = 1.4
const CNI_SECONDS = 0.9
/** Model seconds a crashLoop-injected container survives before exiting 1. */
const CRASHLOOP_LIFETIME = 6

/* ---------------------------------------------------------------------------
 * Demand. Traffic is what makes a container consume anything at all.
 * -------------------------------------------------------------------------*/

function computeTrafficShares(ctx: SimCtx): void {
  const rps = ctx.store.rpsPerPod
  let web = 0
  let api = 0
  let db = 0
  let dns = 0
  const pods = ctx.store.podList
  for (let i = 0; i < pods.length; i++) {
    const p = pods[i]
    if (!podIsReady(p)) continue
    switch (p.labels['app']) {
      case 'web':
        web += 1
        break
      case 'api':
        api += 1
        break
      case 'db':
        db += 1
        break
      case 'coredns':
        dns += 1
        break
      default:
        break
    }
  }
  /* What the cluster admits, not what the knob asks for: with every door
   * deleted no request reaches a pod, and the CPU must say so. */
  const t = admittedRps(ctx).total
  rps['web'] = t / Math.max(1, web)
  /* A third of front-end requests reach the API tier, and a tenth the store. */
  rps['api'] = (t * 0.35) / Math.max(1, api)
  rps['db'] = (t * 0.1) / Math.max(1, db)
  rps['coredns'] = (t * 1.5) / Math.max(1, dns)
}

function containerDemandCpu(ctx: SimCtx, pod: PodState, cr: ContainerRuntime): number {
  const share = ctx.store.rpsPerPod[pod.labels['app']] ?? 0
  return cr.idleCpuMilli + share * cr.trafficShare
}

/* ---------------------------------------------------------------------------
 * Container start / crash.
 * -------------------------------------------------------------------------*/

function startContainer(ctx: SimCtx, pod: PodState, c: ContainerState, cr: ContainerRuntime): void {
  c.state = 'running'
  c.reason = 'Running'
  c.backoffRemaining = 0
  c.ready = false
  c.startupDone = cr.startupSeconds <= 0
  c.livenessFailures = 0
  c.readinessFailures = 0
  cr.runningSeconds = 0
  cr.startupClock = 0
  cr.readinessClock = 0
  cr.livenessClock = 0
  cr.leakedMib = 0
  cr.exitDisplay = 0
  c.usedCpuMilli = cr.idleCpuMilli
  c.usedMemMib = cr.idleMemMib
  emit(ctx, 'Normal', 'Created', `pod/${pod.name}`, `Created container ${c.name}`)
  emit(ctx, 'Normal', 'Started', `pod/${pod.name}`, `Started container ${c.name}`)
}

/**
 * A container exited. The restart is not immediate: kubelet applies the
 * CrashLoopBackOff delay first, doubling it from 10 s and capping at 300 s.
 */
function crashContainer(
  ctx: SimCtx,
  pod: PodState,
  c: ContainerState,
  cr: ContainerRuntime,
  reason: ContainerReason,
): void {
  c.restartCount += 1
  c.state = 'waiting'
  c.reason = reason
  c.ready = false
  c.throttled = false
  c.usedCpuMilli = 0
  c.usedMemMib = 0
  c.livenessFailures = 0
  c.readinessFailures = 0
  c.startupDone = false
  cr.runningSeconds = 0
  cr.leakedMib = 0
  cr.startupClock = 0
  cr.readinessClock = 0
  cr.livenessClock = 0
  cr.exitDisplay = 3

  c.backoffRemaining = c.backoffSeconds
  c.backoffSeconds = Math.min(c.backoffSeconds * 2, TIMING.crashBackoffMaxSeconds)

  emit(
    ctx,
    'Warning',
    'BackOff',
    `pod/${pod.name}`,
    `Back-off restarting failed container ${c.name} in pod ${pod.namespace}/${pod.name}`,
  )
}

/**
 * A throttled container answers slowly, so it drops out of the load balancer
 * first. A container at its memory ceiling is thrashing its own heap.
 */
function readinessFails(c: ContainerState): boolean {
  if (c.throttled) return true
  if (c.limitMemMib > 0 && c.usedMemMib > c.limitMemMib * 0.95) return true
  return false
}

/**
 * Liveness is a much bigger hammer and needs a much stronger signal: a brief
 * throttle must not restart a healthy process. Only sustained starvation does.
 */
const LIVENESS_THROTTLE_GRACE_SECONDS = 20

function livenessFails(c: ContainerState, cr: ContainerRuntime): boolean {
  if (cr.throttledSeconds > LIVENESS_THROTTLE_GRACE_SECONDS) return true
  if (c.limitMemMib > 0 && c.usedMemMib > c.limitMemMib * 0.985) return true
  return false
}

/* ---------------------------------------------------------------------------
 * The per-pod sync loop.
 * -------------------------------------------------------------------------*/

function syncPod(ctx: SimCtx, node: NodeState, nodeIndex: number, pod: PodState, rt: PodRuntime, dt: number): void {
  const knobs = ctx.s.knobs

  if (podIsTerminating(pod)) {
    /* SIGTERM was sent and endpoints already dropped this pod, but the
     * containers keep serving in-flight work until the grace period is up. */
    releasePodVolumes(ctx, pod, rt)
    pod.deletionGraceSeconds = Math.max(0, (pod.deletionGraceSeconds ?? 0) - dt)
    if (pod.deletionGraceSeconds <= 0) {
      removePod(ctx, pod.uid)
      return
    }
    for (let i = 0; i < pod.containers.length; i++) {
      const c = pod.containers[i]
      if (c.state !== 'running') continue
      updateUsage(ctx, pod, c, rt.containers[i], dt)
    }
    return
  }

  if (pod.phase === 'Failed' || pod.phase === 'Succeeded') return

  switch (rt.stage) {
    case 'unscheduled':
      return

    case 'pulling': {
      let pending = 0
      for (let i = 0; i < pod.containers.length; i++) {
        const c = pod.containers[i]
        const cr = rt.containers[i]
        if (cr.imageReady) continue
        if (node.imageCache.indexOf(c.image) >= 0) {
          cr.imageReady = true
          c.pullProgress = 1
          continue
        }
        pending += 1
        if (cr.pullBackoffRemaining > 0) {
          cr.pullBackoffRemaining -= dt
          c.reason = 'ImagePullBackOff'
          continue
        }
        if (c.pullProgress === 0) {
          emit(ctx, 'Normal', 'Pulling', `pod/${pod.name}`, `Pulling image "${c.image}"`)
        }
        c.pullProgress += dt / Math.max(0.2, knobs.imagePullSeconds)
        if (c.pullProgress < 1) continue
        if (knobs.imagePullFailure) {
          c.pullProgress = 0
          c.reason = 'ErrImagePull'
          emit(
            ctx,
            'Warning',
            'Failed',
            `pod/${pod.name}`,
            `Failed to pull image "${c.image}": rpc error: code = NotFound desc = failed to pull and unpack image: not found`,
          )
          cr.pullBackoffRemaining = cr.pullBackoff
          cr.pullBackoff = Math.min(cr.pullBackoff * 2, TIMING.crashBackoffMaxSeconds)
          c.reason = 'ImagePullBackOff'
          emit(ctx, 'Warning', 'BackOff', `pod/${pod.name}`, `Back-off pulling image "${c.image}"`)
        } else {
          c.pullProgress = 1
          cr.imageReady = true
          if (node.imageCache.indexOf(c.image) < 0) node.imageCache.push(c.image)
          emit(
            ctx,
            'Normal',
            'Pulled',
            `pod/${pod.name}`,
            `Successfully pulled image "${c.image}" in ${knobs.imagePullSeconds.toFixed(1)}s`,
          )
        }
      }
      if (pending === 0) {
        rt.stage = 'sandbox'
        rt.stageProgress = 0
      }
      return
    }

    case 'sandbox':
      /* The sandbox — the `pause` container — *is* the pod: it owns the network
       * namespace, the IPC namespace and the volume mounts the containers join. */
      rt.stageProgress += dt / SANDBOX_SECONDS
      if (rt.stageProgress >= 1) {
        rt.stage = 'cni'
        rt.stageProgress = 0
      }
      return

    case 'cni':
      rt.stageProgress += dt / CNI_SECONDS
      if (rt.stageProgress >= 1) {
        ctx.store.ipNext[nodeIndex] += 1
        rt.ipHost = 4 + (ctx.store.ipNext[nodeIndex] % 240)
        pod.ip = podIp(nodeIndex, rt.ipHost)
        rt.stage = 'csi'
        rt.stageProgress = 0
      }
      return

    case 'csi': {
      if (pod.volumeClaims.length === 0) {
        rt.stage = 'init'
        rt.stageProgress = 0
        return
      }
      const result = ensurePodVolumes(ctx, pod, rt, node.name)
      if (result === 'ready') {
        rt.stage = 'init'
        rt.stageProgress = 0
      }
      return
    }

    case 'init': {
      let index = -1
      for (let i = 0; i < pod.containers.length; i++) {
        if (pod.containers[i].role !== 'init') continue
        if (pod.containers[i].state === 'terminated') continue
        index = i
        break
      }
      if (index < 0) {
        pod.conditions.Initialized = true
        rt.stage = 'app'
        return
      }
      const c = pod.containers[index]
      const cr = rt.containers[index]
      if (c.state !== 'running') {
        c.state = 'running'
        c.reason = 'Running'
        c.usedCpuMilli = cr.idleCpuMilli
        c.usedMemMib = cr.idleMemMib
        emit(ctx, 'Normal', 'Created', `pod/${pod.name}`, `Created container ${c.name}`)
        emit(ctx, 'Normal', 'Started', `pod/${pod.name}`, `Started container ${c.name}`)
      }
      for (const other of pod.containers) {
        if (other.role !== 'init' && other.state === 'waiting') other.reason = 'PodInitializing'
      }
      cr.workRemaining -= dt
      if (cr.workRemaining <= 0) {
        c.state = 'terminated'
        c.reason = 'Completed'
        c.usedCpuMilli = 0
        c.usedMemMib = 0
        rt.initIndex += 1
      }
      return
    }

    case 'app':
      for (let i = 0; i < pod.containers.length; i++) {
        const c = pod.containers[i]
        if (c.role === 'init') continue
        startContainer(ctx, pod, c, rt.containers[i])
      }
      pod.phase = 'Running'
      rt.stage = 'running'
      return

    case 'running':
      runContainers(ctx, pod, rt, dt)
      return

    default:
      return
  }
}

function runContainers(ctx: SimCtx, pod: PodState, rt: PodRuntime, dt: number): void {
  const knobs = ctx.s.knobs
  for (let i = 0; i < pod.containers.length; i++) {
    const c = pod.containers[i]
    if (c.role === 'init') continue
    const cr = rt.containers[i]

    if (c.state === 'waiting') {
      c.backoffRemaining -= dt
      if (cr.exitDisplay > 0) {
        cr.exitDisplay -= dt
        if (cr.exitDisplay <= 0 && c.reason !== 'ImagePullBackOff') c.reason = 'CrashLoopBackOff'
      }
      if (c.backoffRemaining <= 0) startContainer(ctx, pod, c, cr)
      continue
    }
    if (c.state !== 'running') continue

    cr.runningSeconds += dt
    /* Ten clean minutes and the backoff is forgiven. */
    if (cr.runningSeconds >= TIMING.crashBackoffResetSeconds) {
      c.backoffSeconds = TIMING.crashBackoffStartSeconds
    }

    updateUsage(ctx, pod, c, cr, dt)

    /* A batch container has work to finish and then exits 0. This is what
     * makes a Job pod Succeeded rather than restarted. */
    if (cr.runSeconds > 0) {
      cr.workRemaining -= dt
      if (cr.workRemaining <= 0) {
        c.state = 'terminated'
        c.reason = 'Completed'
        c.ready = false
        c.usedCpuMilli = 0
        c.usedMemMib = 0
        continue
      }
    }

    /* The cgroup memory limit is a hard wall: over it, the kernel OOM killer
     * takes the process. There is no throttling for memory. */
    if (c.limitMemMib > 0 && c.usedMemMib > c.limitMemMib) {
      emit(
        ctx,
        'Warning',
        'OOMKilling',
        `pod/${pod.name}`,
        `Memory cgroup out of memory: Killed process in container ${c.name} (${formatMem(c.usedMemMib)} > limit ${formatMem(c.limitMemMib)})`,
      )
      crashContainer(ctx, pod, c, cr, 'OOMKilled')
      continue
    }

    if (knobs.crashLoop && c.role === 'app' && pod.labels['app'] === 'web' && cr.runningSeconds >= CRASHLOOP_LIFETIME) {
      emit(ctx, 'Warning', 'Failed', `pod/${pod.name}`, `Container ${c.name} exited with code 1`)
      crashContainer(ctx, pod, c, cr, 'Error')
      continue
    }

    /* Startup probe gates both other probes; a slow starter is not unhealthy. */
    if (!c.startupDone) {
      cr.startupClock += dt
      if (cr.startupClock >= cr.startupSeconds) c.startupDone = true
      else {
        c.ready = false
        continue
      }
    }

    if (cr.hasReadinessProbe) {
      cr.readinessClock += dt
      if (cr.readinessClock >= Math.max(1, knobs.readinessPeriodSeconds)) {
        cr.readinessClock = 0
        const ok = !rt.neverReady && !readinessFails(c)
        if (ok) {
          c.readinessFailures = 0
          c.ready = true
        } else {
          c.readinessFailures += 1
          emit(
            ctx,
            'Warning',
            'Unhealthy',
            `pod/${pod.name}`,
            `Readiness probe failed: HTTP probe failed with statuscode: 503`,
          )
          if (c.readinessFailures >= knobs.probeFailureThreshold) c.ready = false
        }
      }
    } else {
      c.ready = true
    }

    if (cr.hasLivenessProbe) {
      cr.livenessClock += dt
      if (cr.livenessClock >= Math.max(1, knobs.livenessPeriodSeconds)) {
        cr.livenessClock = 0
        if (!livenessFails(c, cr)) {
          c.livenessFailures = 0
        } else {
          c.livenessFailures += 1
          emit(
            ctx,
            'Warning',
            'Unhealthy',
            `pod/${pod.name}`,
            `Liveness probe failed: Get "http://${pod.ip ?? '0.0.0.0'}:8080/healthz": context deadline exceeded`,
          )
          if (c.livenessFailures >= knobs.probeFailureThreshold) {
            emit(
              ctx,
              'Normal',
              'Killing',
              `pod/${pod.name}`,
              `Container ${c.name} failed liveness probe, will be restarted`,
            )
            crashContainer(ctx, pod, c, cr, 'Error')
          }
        }
      }
    }
  }

  /* Pod conditions are derived, never set directly. */
  let allReady = true
  let any = false
  let allCompleted = true
  for (const c of pod.containers) {
    if (c.role === 'init') continue
    any = true
    if (!c.ready) allReady = false
    if (!(c.state === 'terminated' && c.reason === 'Completed')) allCompleted = false
  }
  pod.conditions.ContainersReady = any && allReady
  pod.conditions.Ready = any && allReady
  if (any && allCompleted) {
    pod.phase = 'Succeeded'
    pod.conditions.Ready = false
    pod.conditions.ContainersReady = false
  }
}

function updateUsage(ctx: SimCtx, pod: PodState, c: ContainerState, cr: ContainerRuntime, dt: number): void {
  const demandCpu = containerDemandCpu(ctx, pod, cr)
  /* A CPU limit throttles; it never kills. The process simply gets fewer
   * slices per cfs period and everything it does takes longer. */
  c.throttled = c.limitCpuMilli > 0 && demandCpu > c.limitCpuMilli
  cr.throttledSeconds = c.throttled ? cr.throttledSeconds + dt : 0
  const servedCpu = c.limitCpuMilli > 0 ? Math.min(demandCpu, c.limitCpuMilli) : demandCpu
  c.usedCpuMilli = approach(c.usedCpuMilli, servedCpu, 3, dt)

  if (ctx.s.knobs.memoryLeak && c.role === 'app' && pod.labels['app'] === 'web') {
    cr.leakedMib += MODEL.memLeakMibPerSecond * dt
  }
  /* Working-set growth tracks the same traffic the CPU does, in proportion to
   * how much of the request path this particular container is on. */
  const share = ctx.store.rpsPerPod[pod.labels['app']] ?? 0
  const targetMem = cr.idleMemMib + share * cr.trafficShare * 0.07 + cr.leakedMib
  c.usedMemMib = approach(c.usedMemMib, targetMem, 1.6, dt)
}

/* ---------------------------------------------------------------------------
 * Node-pressure eviction. The ranking is the real one, and it is the reason
 * QoS class exists at all.
 * -------------------------------------------------------------------------*/

function evictOne(ctx: SimCtx, node: NodeState): void {
  let victim: PodState | null = null
  let victimRank = -1
  let victimScore = -1

  for (const uid of node.podUids) {
    const p = ctx.s.pods.get(uid)
    if (!p || podIsTerminating(p) || p.phase !== 'Running') continue
    /* Rank 2: BestEffort first. Rank 1: Burstable over its requests, worst
     * overage first. Rank 0: Guaranteed, only when nothing else is left. */
    let rank: number
    let score: number
    const used = podUsedMem(p)
    if (p.qos === 'BestEffort') {
      rank = 2
      score = used
    } else if (p.qos === 'Burstable') {
      const over = used - podRequestMem(p)
      if (over <= 0) continue
      rank = 1
      score = over
    } else {
      rank = 0
      score = used
    }
    if (rank > victimRank || (rank === victimRank && score > victimScore)) {
      victim = p
      victimRank = rank
      victimScore = score
    }
  }
  if (!victim) return

  victim.phase = 'Failed'
  victim.conditions.Ready = false
  victim.conditions.ContainersReady = false
  for (const c of victim.containers) {
    if (c.state === 'running') {
      c.state = 'terminated'
      c.reason = 'Error'
    }
    c.ready = false
    c.usedCpuMilli = 0
    c.usedMemMib = 0
  }
  emit(
    ctx,
    'Warning',
    'Evicted',
    `pod/${victim.name}`,
    `The node was low on resource: memory. Container ${victim.containers[victim.containers.length - 1]?.name ?? 'app'} was using ${formatMem(podUsedMem(victim))}, which exceeds its request of ${formatMem(podRequestMem(victim))}.`,
  )
}

/* ---------------------------------------------------------------------------
 * Node accounting. Recomputed from scratch every tick so no incremental
 * bookkeeping error can silently corrupt what the scheduler sees.
 * -------------------------------------------------------------------------*/

export function recomputeNodeAllocation(ctx: SimCtx): void {
  for (let n = 0; n < ctx.s.nodes.length; n++) {
    const node = ctx.s.nodes[n]
    let reqCpu = 0
    let reqMem = 0
    let useCpu = 0
    let useMem = 0
    for (let i = node.podUids.length - 1; i >= 0; i--) {
      const p = ctx.s.pods.get(node.podUids[i])
      if (!p) {
        node.podUids.splice(i, 1)
        continue
      }
      /* Terminal pods have released their cgroups; the scheduler ignores them. */
      if (p.phase === 'Failed' || p.phase === 'Succeeded') continue
      reqCpu += podRequestCpu(p)
      reqMem += podRequestMem(p)
      useCpu += podUsedCpu(p)
      useMem += podUsedMem(p)
    }
    node.requestedCpuMilli = reqCpu
    node.requestedMemMib = reqMem
    if (nodeIsDown(ctx, n)) {
      node.usedCpuMilli = 0
      node.usedMemMib = 0
      continue
    }
    /* kube-reserved is consumed by the kubelet and runtime themselves. */
    node.usedCpuMilli = useCpu + NODE_RESERVED_CPU_MILLICORES * 0.45
    node.usedMemMib = useMem + NODE_RESERVED_MEM_MIB * 0.6
  }
}

/* ---------------------------------------------------------------------------
 * The node loop.
 * -------------------------------------------------------------------------*/

export function tickKubelet(ctx: SimCtx, dt: number): void {
  computeTrafficShares(ctx)

  for (let n = 0; n < ctx.s.nodes.length; n++) {
    const node = ctx.s.nodes[n]
    const kl = node.kubelet

    for (const cond of node.conditions) cond.sinceSeconds += dt

    if (nodeIsDown(ctx, n)) {
      /* Nothing renews the Lease, and nothing reports status. The API server
       * still believes every pod here is Running until the node controller
       * notices the missing lease — which is exactly what makes node failure
       * feel so slow in a real cluster. */
      kl.phase = 'idle'
      kl.progress = 0
      kl.plegHealthy = false
      kl.evicting = false
      kl.currentPodUid = undefined
      kl.sinceLeaseSeconds += dt
      continue
    }

    kl.plegHealthy = true
    kl.sinceLeaseSeconds += dt
    /* A kubelet renews on a fixed interval and does not hammer a broken API
     * server between intervals: the retry cadence is the renew cadence. */
    if (
      kl.sinceLeaseSeconds >= TIMING.kubeletLeaseSeconds &&
      !ctx.store.leaseInflight[n] &&
      ctx.s.t >= ctx.store.leaseAttemptAt[n]
    ) {
      ctx.store.leaseInflight[n] = true
      ctx.store.leaseAttemptAt[n] = ctx.s.t + TIMING.kubeletLeaseSeconds
      const idx = n
      submit(ctx, {
        verb: 'update',
        kind: 'Lease',
        namespace: 'kube-node-lease',
        name: node.name,
        subject: `system:node:${node.name}`,
        commit: (c) => {
          c.s.nodes[idx].kubelet.sinceLeaseSeconds = 0
        },
        done: (c) => {
          c.store.leaseInflight[idx] = false
        },
      })
    }

    let phase: NodeState['kubelet']['phase'] = 'idle'
    let current: string | undefined
    let progress = 0

    for (let i = node.podUids.length - 1; i >= 0; i--) {
      const uid = node.podUids[i]
      const pod = ctx.s.pods.get(uid)
      const rt = ctx.store.runtime.get(uid)
      if (!pod || !rt) continue
      syncPod(ctx, node, n, pod, rt, dt)
      if (phase === 'idle' && ctx.s.pods.has(uid)) {
        const p = stagePhase(rt, pod)
        if (p) {
          phase = p
          current = uid
          progress = rt.stageProgress
        }
      }
      reportReadiness(ctx, pod)
    }

    kl.phase = phase
    kl.currentPodUid = current
    kl.progress = clamp(progress, 0, 1)

    /* The kubelet is the only reporter of node conditions, so it reasserts
     * every one of them each sync — including the ones the node controller
     * flipped to Unknown while it could not be reached. */
    setCondition(node, 'NetworkUnavailable', node.podCidr ? 'False' : 'True', node.podCidr ? 'RouteCreated' : 'NoRouteCreated')
    const diskFull = node.imageCache.length > 12
    setCondition(
      node,
      'DiskPressure',
      diskFull ? 'True' : 'False',
      diskFull ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure',
    )
    const pidFull = node.podUids.length >= node.capacityPods
    setCondition(
      node,
      'PIDPressure',
      pidFull ? 'True' : 'False',
      pidFull ? 'KubeletHasInsufficientPID' : 'KubeletHasSufficientPID',
    )

    /* Node-pressure eviction. */
    const memFrac = node.usedMemMib / Math.max(1, node.allocatableMemMib)
    if (memFrac > 0.92) {
      setCondition(node, 'MemoryPressure', 'True', 'KubeletHasInsufficientMemory')
      kl.evicting = true
      ctx.store.evictClock[n] += dt
      if (ctx.store.evictClock[n] >= 2) {
        ctx.store.evictClock[n] = 0
        evictOne(ctx, node)
      }
    } else {
      setCondition(node, 'MemoryPressure', 'False', 'KubeletHasSufficientMemory')
      kl.evicting = false
      ctx.store.evictClock[n] = 0
    }
  }
}

function stagePhase(rt: PodRuntime, pod: PodState): NodeState['kubelet']['phase'] | null {
  if (podIsTerminating(pod)) return 'terminating'
  switch (rt.stage) {
    case 'pulling':
      return 'pulling'
    case 'sandbox':
      return 'sandbox'
    case 'cni':
      return 'cni'
    case 'csi':
      return 'csi'
    case 'init':
    case 'app':
      return 'starting'
    case 'running':
      return null
    default:
      return null
  }
}

/**
 * kubelet PATCHes pod status when readiness flips. That write is what wakes
 * the endpoint controller — readiness does not reach kube-proxy by magic.
 */
function reportReadiness(ctx: SimCtx, pod: PodState): void {
  const ready = podIsReady(pod)
  const last = ctx.store.reportedReady.get(pod.uid)
  if (last === ready) return
  ctx.store.reportedReady.set(pod.uid, ready)
  submit(ctx, {
    verb: 'patch',
    kind: 'Pod',
    namespace: pod.namespace,
    name: pod.name,
    subject: `system:node:${pod.nodeName ?? 'unknown'}`,
  })
}
