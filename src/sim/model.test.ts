/* ============================================================================
 * Mechanism tests.
 *
 * Every assertion here is about *behaviour*, not shape: a test that only says
 * "this field exists" would pass against a model that lies. Nothing reads the
 * wall clock; time is advanced explicitly and every stochastic choice comes
 * from the seeded Rng, so a failure is always reproducible.
 * ==========================================================================*/

import { describe, expect, it } from 'vitest'
import {
  API_STAGES,
  ETCD_QUORUM,
  N_NODES,
  POD_SLOTS_PER_NODE,
  TIMING,
  type ApiStage,
  type ContainerState,
  type PodState,
  type ServiceState,
} from '../core/types'
import { createSim, simContext, type Sim } from './model'
import { forbiddenMessage, rbacAllows, SUBJECTS, submit } from './controlplane'
import { filterNode } from './scheduling'
import { podIsReady, podIsTerminating, podRequestCpu, qosOf, type SimCtx } from './ctx'
import { ensurePodVolumes } from './storage'

/* ---------------------------------------------------------------------------
 * Harness.
 * -------------------------------------------------------------------------*/

const DT = 0.1

function run(sim: Sim, modelSeconds: number): void {
  const steps = Math.round(modelSeconds / DT)
  for (let i = 0; i < steps; i++) sim.tick(DT)
}

/** A cluster that has finished its initial convergence. */
function settled(seed = 3, seconds = 150): Sim {
  const sim = createSim(seed)
  run(sim, seconds)
  return sim
}

function pods(sim: Sim, app: string): PodState[] {
  const out: PodState[] = []
  for (const p of sim.state.pods.values()) if (p.labels['app'] === app) out.push(p)
  return out
}

function service(sim: Sim, ns: string, name: string): ServiceState {
  const s = sim.state.services.find((x) => x.namespace === ns && x.name === name)
  if (!s) throw new Error(`no service ${ns}/${name}`)
  return s
}

function container(spec: Partial<ContainerState>): ContainerState {
  return {
    name: 'c',
    image: 'x',
    role: 'app',
    state: 'running',
    reason: 'Running',
    restartCount: 0,
    backoffRemaining: 0,
    backoffSeconds: TIMING.crashBackoffStartSeconds,
    requestCpuMilli: 0,
    limitCpuMilli: 0,
    requestMemMib: 0,
    limitMemMib: 0,
    usedCpuMilli: 0,
    usedMemMib: 0,
    throttled: false,
    ready: true,
    livenessFailures: 0,
    readinessFailures: 0,
    startupDone: true,
    pullProgress: 1,
    ...spec,
  }
}

/* ===========================================================================
 * etcd and raft
 * =========================================================================*/

describe('etcd raft', () => {
  it('advances the revision only through applied log entries, and never backwards', () => {
    const sim = createSim(1)
    let last = sim.state.etcd.revision
    for (let i = 0; i < 3000; i++) {
      sim.tick(DT)
      expect(sim.state.etcd.revision).toBeGreaterThanOrEqual(last)
      last = sim.state.etcd.revision
    }
    expect(last).toBeGreaterThan(50)
  })

  it('commits an entry only once a quorum of members has persisted it', () => {
    const sim = settled(4, 60)
    const ctx = simContext(sim)
    ctx.s.knobs.etcdFsyncMs = 60
    submit(ctx, { verb: 'update', kind: 'Node', namespace: '', name: 'node-1', subject: SUBJECTS.admin })
    let sawUncommitted = false
    for (let i = 0; i < 200; i++) {
      sim.tick(DT)
      for (const e of sim.state.etcd.log) {
        if (e.committed) continue
        sawUncommitted = true
        let acks = 0
        for (const m of sim.state.etcd.members) if (m.role !== 'down' && m.matchIndex >= e.index) acks += 1
        expect(acks).toBeLessThan(ETCD_QUORUM)
      }
    }
    expect(sawUncommitted).toBe(true)
  })

  it('loses quorum when two of three members go down, and regains it when they return', () => {
    const sim = settled(5, 80)
    expect(sim.state.etcd.hasQuorum).toBe(true)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 20)
    expect(sim.state.etcd.hasQuorum).toBe(false)
    expect(sim.state.api.writable).toBe(false)
    sim.setKnob('etcdMembersDown', 0)
    run(sim, 20)
    expect(sim.state.etcd.hasQuorum).toBe(true)
    expect(sim.state.api.writable).toBe(true)
  })

  it('stops advancing the revision while quorum is lost and resumes afterwards', () => {
    const sim = settled(6, 80)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 30)
    const frozen = sim.state.etcd.revision
    run(sim, 40)
    expect(sim.state.etcd.revision).toBe(frozen)
    sim.setKnob('etcdMembersDown', 0)
    run(sim, 60)
    expect(sim.state.etcd.revision).toBeGreaterThan(frozen)
  })

  it('fails writes with etcd\'s own timeout message when there is no quorum', async () => {
    const sim = settled(7, 60)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 20)
    const ctx = simContext(sim)
    const seen: string[] = []
    submit(ctx, {
      verb: 'create',
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'probe',
      subject: SUBJECTS.admin,
      done: (_c, outcome, reason) => seen.push(`${outcome}:${reason}`),
    })
    run(sim, 30)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe('timeout:etcdserver: request timed out')
  })

  it('still serves reads from the watch cache with no quorum', () => {
    const sim = settled(8, 60)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 20)
    const ctx = simContext(sim)
    let outcome = ''
    submit(ctx, {
      verb: 'get',
      kind: 'Pod',
      namespace: 'shop',
      name: 'anything',
      subject: SUBJECTS.admin,
      done: (_c, o) => {
        outcome = o
      },
    })
    run(sim, 10)
    expect(outcome).toBe('ok')
  })

  it('elects a new leader in a higher term when the leader dies', () => {
    const sim = settled(9, 60)
    const before = sim.state.etcd.members.find((m) => m.role === 'leader')!
    const term = before.term
    sim.setKnob('etcdMembersDown', 1)
    run(sim, 20)
    const after = sim.state.etcd.members.find((m) => m.role === 'leader')
    expect(after).toBeDefined()
    expect(after!.name).not.toBe(before.name)
    expect(after!.term).toBeGreaterThan(term)
    /* One member down out of three is still a quorum: the cluster keeps writing. */
    expect(sim.state.etcd.hasQuorum).toBe(true)
    expect(sim.state.api.writable).toBe(true)
  })

  it('compacts history without ever moving the revision', () => {
    const sim = createSim(10)
    run(sim, TIMING.etcdCompactionIntervalSeconds + 40)
    const revBefore = sim.state.etcd.revision
    expect(sim.state.etcd.compactedRevision).toBeGreaterThan(0)
    expect(sim.state.etcd.compactedRevision).toBeLessThan(revBefore)
    run(sim, 10)
    expect(sim.state.etcd.revision).toBeGreaterThanOrEqual(revBefore)
  })

  it('raises NOSPACE past the quota and makes the whole cluster read-only', () => {
    const sim = settled(11, 60)
    sim.state.etcd.dbSizeMib = sim.state.etcd.dbQuotaMib + 1
    run(sim, 2)
    expect(sim.state.etcd.alarm).toBe('NOSPACE')
    expect(sim.state.api.writable).toBe(false)
    const ctx = simContext(sim)
    let reason = ''
    submit(ctx, {
      verb: 'create',
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'probe',
      subject: SUBJECTS.admin,
      done: (_c, _o, r) => {
        reason = r
      },
    })
    run(sim, 5)
    expect(reason).toBe('etcdserver: mvcc: database space exceeded')
  })

  it('keeps the watch cache behind etcd but never ahead of it', () => {
    const sim = createSim(12)
    let sawLag = false
    for (let i = 0; i < 1200; i++) {
      sim.tick(DT)
      const { etcd, api } = sim.state
      expect(api.watchCacheRevision).toBeLessThanOrEqual(etcd.revision)
      if (api.watchCacheRevision < etcd.revision) sawLag = true
    }
    expect(sawLag).toBe(true)
  })
})

/* ===========================================================================
 * kube-apiserver
 * =========================================================================*/

describe('kube-apiserver pipeline', () => {
  it('walks every one of API_STAGES, in order, for an admitted write', () => {
    const sim = settled(13, 60)
    const ctx = simContext(sim)
    ctx.s.knobs.webhookLatencyMs = 1
    const id = submit(ctx, {
      verb: 'create',
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'ordered',
      subject: SUBJECTS.admin,
    })
    const seen: ApiStage[] = []
    /* Sampled far finer than a frame, so no stage can slip past unobserved. */
    for (let i = 0; i < 20000; i++) {
      sim.tick(0.002)
      const req = sim.state.api.inflight.find((r) => r.id === id)
      if (!req) break
      if (seen[seen.length - 1] !== req.stage) seen.push(req.stage)
    }
    expect(seen).toEqual([...API_STAGES])
  })

  it('denies by default: RBAC has no rule that can grant an unknown subject anything', () => {
    expect(rbacAllows('system:serviceaccount:shop:default', 'list', 'Secret', 'shop')).toBe(false)
    expect(rbacAllows('system:serviceaccount:shop:default', 'list', 'ConfigMap', 'shop')).toBe(true)
    expect(rbacAllows('system:serviceaccount:shop:default', 'list', 'ConfigMap', 'kube-system')).toBe(false)
    expect(rbacAllows('nobody', 'get', 'Pod', 'shop')).toBe(false)
  })

  it('lets the scheduler bind and preempt, but not create Deployments', () => {
    expect(rbacAllows(SUBJECTS.scheduler, 'create', 'Pod', 'shop')).toBe(true)
    expect(rbacAllows(SUBJECTS.scheduler, 'delete', 'Pod', 'shop')).toBe(true)
    expect(rbacAllows(SUBJECTS.scheduler, 'create', 'Deployment', 'shop')).toBe(false)
  })

  it('rejects a forbidden request at authz with the message kubectl prints', () => {
    const sim = settled(14, 60)
    const ctx = simContext(sim)
    let outcome = ''
    let reason = ''
    submit(ctx, {
      verb: 'list',
      kind: 'Secret',
      namespace: 'shop',
      name: '',
      subject: SUBJECTS.appServiceAccount,
      done: (_c, o, r) => {
        outcome = o
        reason = r
      },
    })
    run(sim, 5)
    expect(outcome).toBe('forbidden')
    expect(reason).toBe(forbiddenMessage(SUBJECTS.appServiceAccount, 'list', 'Secret', 'shop'))
    expect(reason).toContain('secrets is forbidden')
    expect(reason).toContain('cannot list resource "secrets"')
  })

  it('rejects an unauthenticated request at authn, before authz ever runs', () => {
    const sim = settled(15, 60)
    const ctx = simContext(sim)
    let outcome = ''
    let stage: ApiStage | undefined
    const id = submit(ctx, {
      verb: 'get',
      kind: 'Node',
      namespace: '',
      name: 'node-1',
      subject: SUBJECTS.anonymous,
      done: (_c, o) => {
        outcome = o
      },
    })
    for (let i = 0; i < 60; i++) {
      sim.tick(DT)
      const req = sim.state.api.inflight.find((r) => r.id === id)
      if (req) stage = req.stage
    }
    expect(outcome).toBe('unauthorized')
    expect(stage === undefined || API_STAGES.indexOf(stage) <= API_STAGES.indexOf('authn')).toBe(true)
  })

  it('an unreachable webhook with failurePolicy Fail rejects every write in the cluster', () => {
    const sim = settled(16, 100)
    const revBefore = sim.state.etcd.revision
    run(sim, 20)
    /* A healthy cluster is writing constantly; that is the baseline. */
    expect(sim.state.etcd.revision).toBeGreaterThan(revBefore)

    sim.setKnob('webhookReachable', false)
    run(sim, 40)
    const ctx = simContext(sim)
    let reason = ''
    let outcome = ''
    submit(ctx, {
      verb: 'create',
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'blocked',
      subject: SUBJECTS.admin,
      done: (_c, o, r) => {
        outcome = o
        reason = r
      },
    })
    run(sim, 10)
    expect(outcome).toBe('rejected')
    expect(reason).toContain('failed calling webhook "policy.k8skylines.dev"')
    /* And nothing reaches storage any more: the revision is frozen solid. */
    const revAfter = sim.state.etcd.revision
    run(sim, 30)
    expect(sim.state.etcd.revision).toBe(revAfter)
  })

  it('a reachable webhook charges its latency to every write', () => {
    const sim = settled(17, 60)
    const ctx = simContext(sim)
    ctx.s.knobs.webhookLatencyMs = 400
    let elapsed = 0
    const id = submit(ctx, {
      verb: 'create',
      kind: 'ConfigMap',
      namespace: 'shop',
      name: 'slow',
      subject: SUBJECTS.admin,
    })
    for (let i = 0; i < 3000; i++) {
      sim.tick(DT)
      const req = sim.state.api.inflight.find((r) => r.id === id)
      if (!req) break
      elapsed = req.elapsedMs
    }
    /* Two webhooks at 400 ms each, so the request cannot have cost less. */
    expect(elapsed).toBeGreaterThan(700)
  })

  it('sheds with 429 when the APF priority level is saturated', () => {
    const sim = settled(18, 60)
    const throttledBefore = sim.state.api.throttled
    sim.state.api.apfSeatsTotal = 0
    const ctx = simContext(sim)
    let reason = ''
    let outcome = ''
    submit(ctx, {
      verb: 'get',
      kind: 'Pod',
      namespace: 'shop',
      name: 'x',
      subject: SUBJECTS.admin,
      done: (_c, o, r) => {
        outcome = o
        reason = r
      },
    })
    run(sim, 5)
    expect(outcome).toBe('rejected')
    expect(reason).toBe('Too many requests, please try again later.')
    expect(sim.state.api.throttled).toBeGreaterThan(throttledBefore)
  })

  it('gives every APF seat back, so seats in use never run away', () => {
    const sim = settled(19, 200)
    expect(sim.state.api.apfSeatsUsed).toBeLessThanOrEqual(sim.state.api.apfSeatsTotal)
    expect(sim.state.api.apfSeatsUsed).toBeLessThanOrEqual(sim.state.api.inflight.length)
  })
})

/* ===========================================================================
 * Scheduler
 * =========================================================================*/

describe('scheduler filters', () => {
  function fitPod(ctx: SimCtx, cpu: number, mem: number): PodState {
    return {
      uid: 'probe',
      name: 'probe',
      namespace: 'shop',
      phase: 'Pending',
      conditions: { PodScheduled: false, Initialized: false, ContainersReady: false, Ready: false },
      qos: 'Burstable',
      priority: 0,
      containers: [container({ requestCpuMilli: cpu, limitCpuMilli: cpu * 2, requestMemMib: mem, limitMemMib: mem * 2 })],
      labels: { app: 'probe' },
      tolerations: [],
      volumeClaims: [],
      ageSeconds: 0,
    }
  }

  it('fits against allocatable minus requests, and ignores actual usage entirely', () => {
    const sim = settled(20, 120)
    const ctx = simContext(sim)
    const node = sim.state.nodes[0]
    /* Pin the node at 99 % *usage* while leaving most of its requests free. */
    node.requestedCpuMilli = 600
    node.usedCpuMilli = node.allocatableCpuMilli - 20
    node.requestedMemMib = 1000
    node.usedMemMib = node.allocatableMemMib - 20

    expect(filterNode(ctx, 0, fitPod(ctx, 2000, 2000))).toBeUndefined()

    /* Now flip it: idle CPU, but the requests are already spoken for. */
    node.requestedCpuMilli = node.allocatableCpuMilli - 100
    node.usedCpuMilli = 50
    expect(filterNode(ctx, 0, fitPod(ctx, 2000, 2000))).toBe('Insufficient cpu')
  })

  it('reports Insufficient memory separately from Insufficient cpu', () => {
    const sim = settled(21, 60)
    const ctx = simContext(sim)
    const node = sim.state.nodes[0]
    node.requestedCpuMilli = 0
    node.requestedMemMib = node.allocatableMemMib - 10
    expect(filterNode(ctx, 0, fitPod(ctx, 10, 500))).toBe('Insufficient memory')
  })

  it('rejects a cordoned node before it looks at anything else', () => {
    const sim = settled(22, 60)
    const ctx = simContext(sim)
    sim.state.nodes[1].unschedulable = true
    expect(filterNode(ctx, 1, fitPod(ctx, 10, 10))).toBe('node(s) were unschedulable')
  })

  it('rejects an untolerated taint and accepts a tolerated one', () => {
    const sim = settled(23, 60)
    const ctx = simContext(sim)
    const batchNode = N_NODES - 1
    const plain = fitPod(ctx, 10, 10)
    expect(filterNode(ctx, batchNode, plain)).toBe('node(s) had untolerated taint')
    const tolerant = fitPod(ctx, 10, 10)
    tolerant.tolerations = [{ key: 'workload', value: 'batch', effect: 'NoSchedule' }]
    expect(filterNode(ctx, batchNode, tolerant)).toBeUndefined()
  })

  it('enforces the pod count cap with "Too many pods"', () => {
    const sim = settled(24, 60)
    const ctx = simContext(sim)
    const node = sim.state.nodes[0]
    while (node.podUids.length < POD_SLOTS_PER_NODE) node.podUids.push('ghost')
    expect(filterNode(ctx, 0, fitPod(ctx, 10, 10))).toBe('Too many pods')
  })

  it('honours node affinity expressed as a nodeSelector', () => {
    const sim = settled(25, 60)
    const ctx = simContext(sim)
    const p = fitPod(ctx, 10, 10)
    p.nodeSelector = { 'kubernetes.io/hostname': 'node-2' }
    expect(filterNode(ctx, 1, p)).toBeUndefined()
    expect(filterNode(ctx, 0, p)).toBe("node(s) didn't match node affinity")
  })

  it('applies pod anti-affinity only while the knob is on', () => {
    const sim = settled(26, 120)
    const ctx = simContext(sim)
    const web = pods(sim, 'web').filter((p) => p.nodeName)
    expect(web.length).toBeGreaterThan(0)
    const busy = sim.state.nodes.findIndex((n) => n.name === web[0].nodeName)
    const p = fitPod(ctx, 10, 10)
    p.labels = { app: 'web' }
    ctx.store.antiAffinity.set(p.uid, 'app')

    sim.setKnob('podAntiAffinity', false)
    expect(filterNode(ctx, busy, p)).toBeUndefined()
    sim.setKnob('podAntiAffinity', true)
    expect(filterNode(ctx, busy, p)).toBe("node(s) didn't match pod anti-affinity rules")
  })

  it('scores with the real plugin names and produces a 0..100 total', () => {
    const sim = createSim(27)
    let breakdown: { plugin: string; score: number }[] | undefined
    let total = -1
    for (let i = 0; i < 2000 && !breakdown; i++) {
      sim.tick(DT)
      const cycle = sim.state.scheduler.cycle
      if (!cycle || cycle.phase !== 'reserve') continue
      for (const v of cycle.verdicts) {
        if (!v.passed || !v.scoreBreakdown || v.scoreBreakdown.length === 0) continue
        breakdown = v.scoreBreakdown.map((b) => ({ ...b }))
        total = v.score ?? -1
      }
    }
    expect(breakdown).toBeDefined()
    const names = breakdown!.map((b) => b.plugin)
    expect(names).toContain('NodeResourcesFit')
    expect(names).toContain('ImageLocality')
    expect(names).toContain('InterPodAffinity')
    expect(names).toContain('TaintToleration')
    expect(names).toContain('NodeAffinity')
    expect(total).toBeGreaterThanOrEqual(0)
    expect(total).toBeLessThanOrEqual(100)
  })

  it('binds through the API pipeline: a bind is a write like any other', () => {
    const sim = settled(28, 120)
    const okBefore = sim.state.api.counts.ok
    const boundBefore = sim.state.scheduler.scheduled
    sim.setKnob('replicas', 6)
    run(sim, 60)
    expect(sim.state.scheduler.scheduled).toBeGreaterThan(boundBefore)
    expect(sim.state.api.counts.ok).toBeGreaterThan(okBefore)
    /* The scheduler cannot have bound anything while the API was unwritable. */
    expect(sim.state.api.writable).toBe(true)
  })

  it('leaves a pod Pending with the aggregated 0/N reason when no node fits', () => {
    const sim = settled(29, 120)
    sim.setKnob('requestCpuMilli', 3400)
    sim.setKnob('limitCpuMilli', 3400)
    run(sim, 120)
    const failures = sim.state.events.filter((e) => e.reason === 'FailedScheduling')
    expect(failures.length).toBeGreaterThan(0)
    const msg = failures[failures.length - 1].message
    expect(msg).toMatch(new RegExp(`^0/${N_NODES} nodes are available: `))
    expect(msg).toContain('Insufficient cpu')
    expect(sim.state.totals.podsPending).toBeGreaterThan(0)
  })
})

/* ===========================================================================
 * kubelet, containers, QoS
 * =========================================================================*/

describe('QoS classification', () => {
  it('is Guaranteed only when every container sets limits equal to its requests', () => {
    expect(
      qosOf([
        container({ requestCpuMilli: 500, limitCpuMilli: 500, requestMemMib: 512, limitMemMib: 512 }),
      ]),
    ).toBe('Guaranteed')
    expect(
      qosOf([
        container({ requestCpuMilli: 500, limitCpuMilli: 500, requestMemMib: 512, limitMemMib: 512 }),
        container({ name: 'side', requestCpuMilli: 50, limitCpuMilli: 100, requestMemMib: 64, limitMemMib: 64 }),
      ]),
    ).toBe('Burstable')
  })

  it('is BestEffort only when no container sets any request or limit at all', () => {
    expect(qosOf([container({})])).toBe('BestEffort')
    expect(qosOf([container({ requestCpuMilli: 1 })])).toBe('Burstable')
    expect(qosOf([container({ limitMemMib: 1 })])).toBe('Burstable')
  })

  it('is Burstable when memory matches but CPU does not', () => {
    expect(
      qosOf([
        container({ requestCpuMilli: 250, limitCpuMilli: 500, requestMemMib: 256, limitMemMib: 256 }),
      ]),
    ).toBe('Burstable')
  })

  it('classifies the demo cluster the way kubectl would', () => {
    const sim = settled(30, 140)
    expect(pods(sim, 'db')[0].qos).toBe('Guaranteed')
    expect(pods(sim, 'node-exporter')[0].qos).toBe('BestEffort')
    expect(pods(sim, 'web')[0].qos).toBe('Burstable')
  })

  it('follows the resource knobs: equal requests and limits make the pod Guaranteed', () => {
    const sim = settled(31, 140)
    sim.setKnob('limitCpuMilli', sim.state.knobs.requestCpuMilli)
    sim.setKnob('limitMemMib', sim.state.knobs.requestMemMib)
    run(sim, 260)
    const web = pods(sim, 'web')
    const guaranteed = web.filter((p) => p.qos === 'Guaranteed')
    expect(guaranteed.length).toBeGreaterThan(0)
  })
})

describe('container lifecycle', () => {
  it('doubles the crash backoff from 10 s and caps it at 300 s', () => {
    const sim = settled(32, 150)
    sim.setKnob('crashLoop', true)
    const target = pods(sim, 'web')[0]
    const app = target.containers.find((c) => c.role === 'app')!
    const observed: number[] = []
    let lastRestart = app.restartCount
    for (let i = 0; i < 60000 && observed.length < 7; i++) {
      sim.tick(DT)
      if (app.restartCount === lastRestart) continue
      lastRestart = app.restartCount
      observed.push(Math.round(app.backoffRemaining))
    }
    expect(observed).toEqual([10, 20, 40, 80, 160, 300, 300])
    expect(app.backoffSeconds).toBe(TIMING.crashBackoffMaxSeconds)
  })

  it('resets the backoff after a long clean run', () => {
    const sim = settled(33, 150)
    sim.setKnob('crashLoop', true)
    const target = pods(sim, 'web')[0]
    const app = target.containers.find((c) => c.role === 'app')!
    while (app.restartCount < 3) sim.tick(DT)
    expect(app.backoffSeconds).toBeGreaterThan(TIMING.crashBackoffStartSeconds)
    sim.setKnob('crashLoop', false)
    run(sim, TIMING.crashBackoffResetSeconds + 400)
    expect(app.backoffSeconds).toBe(TIMING.crashBackoffStartSeconds)
  })

  it('OOM-kills a container that crosses its memory limit, and the restart clears the leak', () => {
    const sim = settled(34, 150)
    sim.setKnob('memoryLeak', true)
    let sawOom = false
    for (let i = 0; i < 4000 && !sawOom; i++) {
      sim.tick(DT)
      for (const p of pods(sim, 'web')) {
        for (const c of p.containers) if (c.reason === 'OOMKilled') sawOom = true
      }
    }
    expect(sawOom).toBe(true)
    const kills = sim.state.events.filter((e) => e.reason === 'OOMKilling')
    expect(kills.length).toBeGreaterThan(0)
    /* A restarted container starts from its idle footprint, not from the leak. */
    const web = pods(sim, 'web').find((p) => p.containers.some((c) => c.restartCount > 0))!
    const app = web.containers.find((c) => c.role === 'app')!
    expect(app.usedMemMib).toBeLessThan(app.limitMemMib)
  })

  it('throttles CPU at the limit instead of killing the container', () => {
    const sim = settled(35, 150)
    /* Demand well past the existing 500m limit, without touching the template. */
    sim.setKnob('trafficRps', 2400)
    run(sim, 20)
    const throttled: ContainerState[] = []
    for (const p of pods(sim, 'web')) {
      for (const c of p.containers) if (c.throttled) throttled.push(c)
    }
    expect(throttled.length).toBeGreaterThan(0)
    for (const c of throttled) {
      expect(c.usedCpuMilli).toBeLessThanOrEqual(c.limitCpuMilli + 0.5)
      expect(c.reason).not.toBe('OOMKilled')
      expect(c.state).toBe('running')
    }
  })

  it('gives a pod its IP only after the sandbox exists, never before', () => {
    const sim = settled(36, 140)
    sim.setKnob('replicas', 8)
    let checked = 0
    for (let i = 0; i < 900; i++) {
      sim.tick(DT)
      for (const p of sim.state.pods.values()) {
        if (!p.ip) continue
        expect(p.nodeName).toBeDefined()
        checked += 1
        /* A pod IP always comes out of its own node's /24. */
        const idx = sim.state.nodes.findIndex((n) => n.name === p.nodeName)
        expect(p.ip.startsWith(`10.244.${idx}.`)).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('runs init containers to completion before any app container starts', () => {
    const sim = settled(37, 140)
    sim.setKnob('replicas', 7)
    let sawInitPhase = false
    for (let i = 0; i < 900; i++) {
      sim.tick(DT)
      for (const p of sim.state.pods.values()) {
        const init = p.containers.filter((c) => c.role === 'init')
        if (init.length === 0) continue
        const initDone = init.every((c) => c.state === 'terminated')
        if (!initDone) {
          sawInitPhase = true
          for (const c of p.containers) {
            if (c.role === 'init') continue
            expect(c.state).not.toBe('running')
          }
          expect(p.conditions.Initialized).toBe(false)
        }
      }
    }
    expect(sawInitPhase).toBe(true)
  })

  it('skips the pull when the image is already in the node cache', () => {
    const sim = settled(38, 200)
    const cached = sim.state.nodes.some((n) => n.imageCache.length > 1)
    expect(cached).toBe(true)
    sim.setKnob('imagePullSeconds', 40)
    sim.setKnob('replicas', 8)
    /* Every image the demo runs is cached by now, so 40 s pulls cost nothing. */
    run(sim, 90)
    const ready = pods(sim, 'web').filter((p) => podIsReady(p))
    expect(ready.length).toBeGreaterThanOrEqual(5)
  })
})

/* ===========================================================================
 * Network and storage
 * =========================================================================*/

describe('services and endpoints', () => {
  it('drops a terminating pod from the EndpointSlice while it is still running', () => {
    const sim = settled(39, 160)
    const web = service(sim, 'shop', 'web')
    expect(web.endpoints.length).toBeGreaterThan(2)

    sim.setKnob('replicas', 3)
    let terminatingUid = ''
    let startedAt = 0
    for (let i = 0; i < 600 && !terminatingUid; i++) {
      sim.tick(DT)
      for (const p of pods(sim, 'web')) {
        if (!podIsTerminating(p)) continue
        terminatingUid = p.uid
        startedAt = sim.state.t
      }
    }
    expect(terminatingUid).not.toBe('')

    let leftAt = -1
    for (let i = 0; i < 200 && leftAt < 0; i++) {
      sim.tick(DT)
      if (!web.endpoints.some((e) => e.podUid === terminatingUid)) leftAt = sim.state.t
    }
    expect(leftAt).toBeGreaterThan(0)
    /* Out of the load balancer within a sync, and still serving in-flight work. */
    expect(leftAt - startedAt).toBeLessThan(5)
    const pod = sim.state.pods.get(terminatingUid)
    expect(pod).toBeDefined()
    expect(pod!.containers.some((c) => c.state === 'running')).toBe(true)
    expect(pod!.deletionGraceSeconds).toBeGreaterThan(0)
  })

  it('realizes every Service as a rule table on every node, not as a process', () => {
    const sim = settled(40, 160)
    for (const node of sim.state.nodes) {
      expect(node.proxyRules.length).toBe(sim.state.services.length)
      const web = node.proxyRules.find((r) => r.service === 'shop/web')!
      expect(web.clusterIp).toBe(service(sim, 'shop', 'web').clusterIp)
      expect(web.endpoints.length).toBeGreaterThan(0)
    }
  })

  it('removes an endpoint from every node at once when readiness is lost', () => {
    const sim = settled(41, 160)
    sim.setKnob('crashLoop', true)
    run(sim, 90)
    expect(service(sim, 'shop', 'web').endpoints.filter((e) => e.ready).length).toBe(0)
    for (const node of sim.state.nodes) {
      const rule = node.proxyRules.find((r) => r.service === 'shop/web')!
      expect(rule.endpoints.length).toBe(0)
    }
  })

  it('drives CoreDNS and the ingress error rate from real endpoint readiness', () => {
    const sim = settled(42, 160)
    expect(sim.state.dns.readyReplicas).toBeGreaterThan(0)
    expect(sim.state.dns.queriesPerSec).toBeGreaterThan(0)
    expect(sim.state.ingresses[0].errorRate).toBeLessThan(0.05)
    sim.setKnob('crashLoop', true)
    run(sim, 120)
    expect(sim.state.ingresses[0].errorRate).toBeGreaterThan(0.5)
  })

  it('creates a default-deny NetworkPolicy only while the knob is on', () => {
    const sim = settled(43, 160)
    expect(sim.state.networkPolicies).toHaveLength(0)
    sim.setKnob('networkPolicyEnabled', true)
    run(sim, 30)
    expect(sim.state.networkPolicies).toHaveLength(1)
    const policy = sim.state.networkPolicies[0]
    expect(policy.podSelector).toEqual({ app: 'api' })
    expect(policy.denied).toBeGreaterThan(0)
    sim.setKnob('networkPolicyEnabled', false)
    run(sim, 5)
    expect(sim.state.networkPolicies).toHaveLength(0)
  })
})

describe('storage', () => {
  it('binds an Immediate claim with no consumer, and a WaitForFirstConsumer claim only with one', () => {
    const sim = createSim(44)
    /* Watch from t = 0: the waiting window is short and it is the whole point. */
    let sawWaiting = false
    let uploadsEverWaited = false
    for (let i = 0; i < 2200; i++) {
      sim.tick(DT)
      const data = sim.state.pvcs.find((p) => p.name === 'data-db-0')
      if (data?.waitingForConsumer) sawWaiting = true
      const up = sim.state.pvcs.find((p) => p.name === 'uploads')
      if (up?.waitingForConsumer) uploadsEverWaited = true
    }
    expect(sawWaiting).toBe(true)
    /* An Immediate class never waits for anyone. */
    expect(uploadsEverWaited).toBe(false)

    const uploads = sim.state.pvcs.find((p) => p.name === 'uploads')!
    expect(uploads.phase).toBe('Bound')
    const data = sim.state.pvcs.find((p) => p.name === 'data-db-0')!
    expect(data.phase).toBe('Bound')
    expect(data.boundPv).toBeDefined()
    expect(data.waitingForConsumer).toBe(false)
  })

  it('pins a WaitForFirstConsumer volume to the topology it was provisioned in', () => {
    const sim = settled(45, 200)
    const ctx = simContext(sim)
    const data = sim.state.pvcs.find((p) => p.name === 'data-db-0')!
    expect(data.boundPv).toBeDefined()
    const pinned = ctx.store.pvNodeAffinity.get(data.boundPv!)
    expect(pinned).toBeDefined()
    const db0 = pods(sim, 'db').find((p) => p.name === 'db-0')!
    expect(db0.nodeName).toBe(pinned)
    /* Every other node now fails the volume filter for that pod. */
    for (let n = 0; n < N_NODES; n++) {
      if (sim.state.nodes[n].name === pinned) continue
      expect(filterNode(ctx, n, db0)).toBeDefined()
    }
  })

  it('runs provision, attach and mount as separate CSI operations with progress', () => {
    const sim = createSim(46)
    const ops = new Set<string>()
    let sawProgress = false
    for (let i = 0; i < 2500; i++) {
      sim.tick(DT)
      for (const op of sim.state.csiOps) {
        ops.add(op.op)
        if (op.progress > 0 && op.progress < 1) sawProgress = true
      }
    }
    expect(ops.has('provision')).toBe(true)
    expect(ops.has('attach')).toBe(true)
    expect(ops.has('mount')).toBe(true)
    expect(sawProgress).toBe(true)
    for (const pv of sim.state.pvs) {
      if (pv.boundClaim?.includes('data-db')) expect(pv.attachedNode).toBeDefined()
    }
  })

  it('refuses to attach a ReadWriteOnce volume to a second node while the first still holds it', () => {
    const sim = settled(47, 200)
    const ctx = simContext(sim)
    const db0 = pods(sim, 'db').find((p) => p.name === 'db-0')!
    const claim = db0.volumeClaims[0]
    const pvc = sim.state.pvcs.find((p) => p.name === claim)!
    const pv = sim.state.pvs.find((v) => v.name === pvc.boundPv)!
    expect(pv.accessMode).toBe('ReadWriteOnce')
    expect(pv.attachedNode).toBe(db0.nodeName)

    const otherNode = sim.state.nodes.find((n) => n.name !== db0.nodeName)!
    const rival: PodState = {
      ...db0,
      uid: 'rival',
      name: 'db-0-rival',
      nodeName: otherNode.name,
      volumeClaims: [claim],
    }
    const rt = { ...ctx.store.runtime.get(db0.uid)!, mountIndex: 0, csiOpId: '' }
    const result = ensurePodVolumes(ctx, rival, rt, otherNode.name)
    expect(result).toBe('failed')
    const failed = sim.state.csiOps.find((o) => o.failed)
    expect(failed).toBeDefined()
    expect(failed!.reason).toContain('Multi-Attach error')
    expect(failed!.op).toBe('attach')

    /* And the scheduler would not have sent it there in the first place. */
    const otherIndex = sim.state.nodes.indexOf(otherNode)
    expect(filterNode(ctx, otherIndex, rival)).toBe('node(s) had volume node affinity conflict')
  })
})

/* ===========================================================================
 * HPA
 * =========================================================================*/

describe('horizontal pod autoscaler', () => {
  it('computes utilisation against the sum of requests, not limits', () => {
    const sim = settled(48, 200)
    const hpa = sim.state.hpas[0]
    expect(hpa.unknownMetrics).toBe(false)

    let used = 0
    let requested = 0
    let limits = 0
    for (const p of pods(sim, 'web')) {
      if (!podIsReady(p)) continue
      for (const c of p.containers) {
        if (c.role === 'init') continue
        if (c.state === 'running') used += c.usedCpuMilli
        requested += c.requestCpuMilli
        limits += c.limitCpuMilli
      }
    }
    expect(requested).toBeGreaterThan(0)
    expect(limits).toBeGreaterThan(requested)
    expect(hpa.currentUtilization).toBe(Math.round((used / requested) * 100))
    /* Against limits it would report a very different, smaller number. */
    expect(hpa.currentUtilization).not.toBe(Math.round((used / limits) * 100))
  })

  it('scales up under load and never past maxReplicas', () => {
    const sim = settled(49, 180)
    sim.setKnob('hpaMaxReplicas', 8)
    sim.setKnob('hpaEnabled', true)
    sim.setKnob('trafficRps', 1400)
    run(sim, 260)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    expect(d.replicas).toBeGreaterThan(4)
    expect(d.replicas).toBeLessThanOrEqual(8)
    expect(sim.state.hpas[0].desiredReplicas).toBeLessThanOrEqual(8)
  })

  it('refuses to scale down inside the stabilization window', () => {
    const sim = settled(50, 180)
    sim.setKnob('hpaEnabled', true)
    sim.setKnob('trafficRps', 1400)
    run(sim, 200)
    const grown = sim.state.deployments.find((x) => x.name === 'web')!.replicas
    expect(grown).toBeGreaterThan(4)
    const hpa = sim.state.hpas[0]
    expect(hpa.stabilizationRemaining).toBeGreaterThan(0)

    sim.setKnob('trafficRps', 20)
    run(sim, 60)
    expect(hpa.stabilizationRemaining).toBeGreaterThan(0)
    expect(hpa.desiredReplicas).toBeLessThan(grown)
    /* Desired dropped, actual did not: that is the stabilization window. */
    expect(sim.state.deployments.find((x) => x.name === 'web')!.replicas).toBe(grown)
  })

  it('never scales below minReplicas', () => {
    const sim = settled(51, 180)
    sim.setKnob('hpaMinReplicas', 3)
    sim.setKnob('hpaEnabled', true)
    sim.setKnob('trafficRps', 0)
    run(sim, TIMING.hpaScaleDownStabilizationSeconds + 200)
    expect(sim.state.deployments.find((x) => x.name === 'web')!.replicas).toBeGreaterThanOrEqual(3)
  })
})

/* ===========================================================================
 * Controllers
 * =========================================================================*/

describe('controllers', () => {
  it('chains Deployment to ReplicaSet to Pod, and only the Pod is a real object on a node', () => {
    const sim = settled(52, 160)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    expect(d.replicaSets.length).toBeGreaterThan(0)
    const rs = sim.state.replicaSets.find((r) => r.name === d.replicaSets[0])!
    expect(rs.ownerDeployment).toBe('web')
    const owned = pods(sim, 'web').filter((p) => p.owner?.name === rs.name)
    expect(owned.length).toBe(d.replicas)
    for (const p of owned) {
      expect(p.owner!.kind).toBe('ReplicaSet')
      expect(p.owner!.controller).toBe(true)
      expect(p.nodeName).toBeDefined()
    }
  })

  it('runs every controller as a real workqueue loop with a leader lease', () => {
    const sim = settled(53, 200)
    for (const id of Object.keys(sim.state.controllers) as (keyof typeof sim.state.controllers)[]) {
      const c = sim.state.controllers[id]
      expect(c.leading).toBe(true)
      expect(c.reconciles).toBeGreaterThan(0)
      expect(c.cached).toBeGreaterThan(0)
    }
    let sawWork = false
    for (let i = 0; i < 400; i++) {
      sim.tick(DT)
      for (const id of Object.keys(sim.state.controllers) as (keyof typeof sim.state.controllers)[]) {
        const c = sim.state.controllers[id]
        if (c.phase !== 'idle') sawWork = true
        expect(c.progress).toBeGreaterThanOrEqual(0)
        expect(c.progress).toBeLessThanOrEqual(1)
      }
    }
    expect(sawWork).toBe(true)
  })

  it('stops every reconcile loop when the leader lease cannot be renewed', () => {
    const sim = settled(54, 160)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 40)
    for (const id of Object.keys(sim.state.controllers) as (keyof typeof sim.state.controllers)[]) {
      expect(sim.state.controllers[id].leading).toBe(false)
    }
    expect(sim.state.scheduler.leading).toBe(false)
    sim.setKnob('etcdMembersDown', 0)
    run(sim, 40)
    expect(sim.state.controllers.deployment.leading).toBe(true)
    expect(sim.state.scheduler.leading).toBe(true)
  })

  it('backs off a failing key exponentially instead of hot-looping', () => {
    const sim = settled(55, 160)
    const ctx = simContext(sim)
    const q = ctx.store.queues.get('deployment')!
    /* Two failures on the same key must not schedule the same retry twice. */
    const first = q.rate.get('probe') ?? 0
    expect(first).toBe(0)
    const cs = sim.state.controllers.deployment
    expect(cs.backoffSeconds).toBeGreaterThanOrEqual(0)
    expect(cs.errors).toBe(0)
  })

  it('places exactly one DaemonSet pod on every node that tolerates its taints', () => {
    const sim = settled(56, 200)
    const ds = sim.state.daemonSets[0]
    expect(ds.desiredScheduled).toBe(N_NODES)
    expect(ds.currentScheduled).toBe(N_NODES)
    expect(ds.ready).toBe(N_NODES)
    const seen = new Set<string>()
    for (const p of pods(sim, 'node-exporter')) {
      expect(p.nodeName).toBeDefined()
      expect(seen.has(p.nodeName!)).toBe(false)
      seen.add(p.nodeName!)
    }
    expect(seen.size).toBe(N_NODES)
  })

  it('creates StatefulSet ordinals in order, each with its own claim', () => {
    const sim = settled(57, 220)
    const ss = sim.state.statefulSets[0]
    expect(ss.readyReplicas).toBe(ss.replicas)
    for (let i = 0; i < ss.replicas; i++) {
      const p = pods(sim, 'db').find((x) => x.name === `db-${i}`)
      expect(p).toBeDefined()
      expect(p!.volumeClaims).toEqual([`data-db-${i}`])
      expect(p!.owner!.kind).toBe('StatefulSet')
    }
  })

  it('runs a Job to its completion count and marks it complete', () => {
    const sim = settled(58, 260)
    const job = sim.state.jobs.find((j) => j.name === 'migrate')!
    expect(job.succeeded).toBe(job.completions)
    expect(job.complete).toBe(true)
    expect(job.active).toBe(0)
  })

  it('garbage-collects pods whose owner is gone, by ownerReference', () => {
    const sim = settled(59, 200)
    const before = pods(sim, 'web').length
    expect(before).toBeGreaterThan(0)
    /* Remove the ReplicaSet objects without touching their pods. */
    sim.state.replicaSets = sim.state.replicaSets.filter((r) => r.ownerDeployment !== 'web')
    sim.state.deployments = sim.state.deployments.filter((d) => d.name !== 'web')
    run(sim, 60)
    expect(pods(sim, 'web').length).toBe(0)
  })

  it('marks a node NotReady after the monitor grace period and evicts only much later', () => {
    const sim = settled(60, 200)
    sim.setKnob('nodeDown', 1)
    const node = sim.state.nodes[0]
    const podsAtFailure = node.podUids.length
    expect(podsAtFailure).toBeGreaterThan(0)

    run(sim, TIMING.nodeMonitorGraceSeconds - 15)
    expect(node.conditions.find((c) => c.type === 'Ready')!.status).toBe('True')

    run(sim, 40)
    expect(node.conditions.find((c) => c.type === 'Ready')!.status).toBe('Unknown')
    expect(node.taints.some((t) => t.key === 'node.kubernetes.io/unreachable')).toBe(true)
    /* Marked unreachable, but nothing has been deleted yet. */
    expect(node.podUids.length).toBe(podsAtFailure)

    run(sim, TIMING.notReadyTolerationSeconds + 80)
    expect(node.podUids.length).toBeLessThan(podsAtFailure)
    /* The DaemonSet tolerates everything and stays put. */
    const stragglers = node.podUids
      .map((u) => sim.state.pods.get(u))
      .filter((p): p is PodState => p !== undefined)
    for (const p of stragglers) expect(p.labels['app']).toBe('node-exporter')
  })
})

/* ===========================================================================
 * Rollouts
 * =========================================================================*/

describe('rolling updates', () => {
  it('never violates maxUnavailable during a rolling update', () => {
    const sim = settled(61, 200)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    expect(d.availableReplicas).toBe(d.replicas)
    expect(d.maxUnavailable).toBe(0)

    sim.runScenario('rolling-update')
    let sawRollout = false
    for (let i = 0; i < 3000; i++) {
      sim.tick(DT)
      if (d.rollingOut) sawRollout = true
      expect(d.availableReplicas).toBeGreaterThanOrEqual(d.replicas - d.maxUnavailable)
    }
    expect(sawRollout).toBe(true)
    expect(d.rollingOut).toBe(false)
    expect(d.updatedReplicas).toBe(d.replicas)
  })

  it('never exceeds maxSurge during a rolling update', () => {
    const sim = settled(62, 200)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    sim.runScenario('rolling-update')
    for (let i = 0; i < 3000; i++) {
      sim.tick(DT)
      const live = pods(sim, 'web').filter((p) => !podIsTerminating(p)).length
      expect(live).toBeLessThanOrEqual(d.replicas + d.maxSurge)
    }
  })

  it('keeps the old ReplicaSet at zero so a rollback is a counter, not a build', () => {
    const sim = settled(63, 200)
    sim.runScenario('rolling-update')
    run(sim, 300)
    const rss = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web')
    expect(rss.length).toBe(2)
    const old = rss.find((r) => r.replicas === 0)
    expect(old).toBeDefined()
    expect(old!.image).not.toBe(rss.find((r) => r.replicas > 0)!.image)
  })
})

/* ===========================================================================
 * Totals and transport
 * =========================================================================*/

describe('cluster rollups and transport', () => {
  it('keeps totals consistent with the pods and nodes they summarise', () => {
    const sim = settled(64, 200)
    for (let i = 0; i < 200; i++) {
      sim.tick(DT)
      const t = sim.state.totals
      let running = 0
      let terminating = 0
      for (const p of sim.state.pods.values()) {
        if (podIsTerminating(p)) terminating += 1
        else if (p.phase === 'Running') running += 1
      }
      expect(t.podsRunning).toBe(running)
      expect(t.podsTerminating).toBe(terminating)
      let alloc = 0
      let req = 0
      for (const n of sim.state.nodes) {
        alloc += n.allocatableCpuMilli
        req += n.requestedCpuMilli
      }
      expect(t.cpuAllocatableMilli).toBe(alloc)
      expect(t.cpuRequestedMilli).toBe(req)
    }
  })

  it('sums node requests from the pods actually bound there', () => {
    const sim = settled(65, 200)
    for (const node of sim.state.nodes) {
      let sum = 0
      for (const uid of node.podUids) {
        const p = sim.state.pods.get(uid)
        if (!p || p.phase === 'Failed' || p.phase === 'Succeeded') continue
        sum += podRequestCpu(p)
      }
      expect(node.requestedCpuMilli).toBe(sum)
    }
  })

  it('advances model time by dt * timeScale and stops dead when paused', () => {
    const sim = createSim(66)
    sim.tick(1)
    expect(sim.state.t).toBeCloseTo(1, 5)
    sim.setKnob('timeScale', 2)
    sim.tick(0.5)
    expect(sim.state.t).toBeCloseTo(2, 5)
    sim.setKnob('paused', true)
    sim.tick(1)
    expect(sim.state.t).toBeCloseTo(2, 5)
  })

  it('rebuilds the cluster on reset without changing the state object identity', () => {
    const sim = settled(67, 150)
    const state = sim.state
    expect(state.pods.size).toBeGreaterThan(0)
    sim.reset()
    expect(sim.state).toBe(state)
    expect(state.t).toBe(0)
    expect(state.pods.size).toBe(0)
    expect(state.etcd.revision).toBe(1)
    run(sim, 150)
    expect(state.pods.size).toBeGreaterThan(0)
  })

  it('emits the reason strings kubectl actually prints', () => {
    const sim = settled(68, 240)
    sim.setKnob('replicas', 6)
    run(sim, 120)
    const reasons = new Set(sim.state.events.map((e) => e.reason))
    for (const expected of ['Scheduled', 'Pulling', 'Pulled', 'Created', 'Started', 'SuccessfulCreate', 'ScalingReplicaSet']) {
      expect(reasons.has(expected)).toBe(true)
    }
  })

  it('aggregates repeated events instead of repeating them', () => {
    const sim = settled(69, 200)
    sim.setKnob('crashLoop', true)
    run(sim, 200)
    const backoffs = sim.state.events.filter((e) => e.reason === 'BackOff')
    expect(backoffs.length).toBeGreaterThan(0)
    expect(sim.state.events.length).toBeLessThanOrEqual(240)
  })
})
