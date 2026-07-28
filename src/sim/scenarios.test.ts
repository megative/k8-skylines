/* ============================================================================
 * Scenario tests.
 *
 * Each scenario is a failure someone has been paged for. These tests assert
 * that the failure actually propagates through the model in the right order,
 * with the right delay, and that stopping it puts the cluster back — because a
 * scenario that only changes a caption teaches nothing.
 * ==========================================================================*/

import { describe, expect, it } from 'vitest'
import { N_NODES, TIMING, type DeploymentState, type PodState } from '../core/types'
import { createSim, type Sim } from './model'
import { podIsReady, podIsTerminating } from './ctx'

const DT = 0.1

function run(sim: Sim, modelSeconds: number): void {
  const steps = Math.round(modelSeconds / DT)
  for (let i = 0; i < steps; i++) sim.tick(DT)
}

function settled(seed = 2, seconds = 200): Sim {
  const sim = createSim(seed)
  run(sim, seconds)
  return sim
}

function web(sim: Sim): DeploymentState {
  return sim.state.deployments.find((d) => d.namespace === 'shop' && d.name === 'web')!
}

function pods(sim: Sim, app: string): PodState[] {
  const out: PodState[] = []
  for (const p of sim.state.pods.values()) if (p.labels['app'] === app) out.push(p)
  return out
}

function reasons(sim: Sim): Set<string> {
  return new Set(sim.state.events.map((e) => e.reason))
}

const REQUIRED_IDS = [
  'rolling-update',
  'bad-rollout',
  'node-failure',
  'crashloop',
  'oom-kill',
  'image-pull-failure',
  'etcd-quorum-loss',
  'webhook-outage',
  'hpa-traffic-spike',
  'pending-unschedulable',
  'preemption',
  'pdb-blocks-drain',
] as const

/* ===========================================================================
 * The catalogue
 * =========================================================================*/

describe('scenario catalogue', () => {
  it('offers every required scenario with a usable title and blurb', () => {
    const sim = createSim(1)
    const ids = sim.scenarios.map((s) => s.id)
    for (const id of REQUIRED_IDS) expect(ids).toContain(id)
    for (const s of sim.scenarios) {
      expect(s.title.length).toBeGreaterThan(3)
      expect(s.blurb.length).toBeGreaterThan(40)
    }
  })

  it('tracks the active scenario and ignores an unknown id', () => {
    const sim = settled(2, 60)
    expect(sim.activeScenario).toBeNull()
    sim.runScenario('crashloop')
    expect(sim.activeScenario).toBe('crashloop')
    sim.runScenario('not-a-scenario')
    expect(sim.activeScenario).toBe('crashloop')
    sim.stopScenario()
    expect(sim.activeScenario).toBeNull()
    sim.stopScenario()
    expect(sim.activeScenario).toBeNull()
  })

  it('stops the running scenario when another starts', () => {
    const sim = settled(3, 60)
    sim.runScenario('crashloop')
    expect(sim.state.knobs.crashLoop).toBe(true)
    sim.runScenario('oom-kill')
    expect(sim.activeScenario).toBe('oom-kill')
    expect(sim.state.knobs.crashLoop).toBe(false)
    expect(sim.state.knobs.memoryLeak).toBe(true)
  })

  it('restores the knobs it touched, and leaves the transport knobs alone', () => {
    const sim = settled(4, 60)
    sim.setKnob('timeScale', 3)
    const before = { ...sim.state.knobs }
    sim.runScenario('hpa-traffic-spike')
    expect(sim.state.knobs.trafficRps).not.toBe(before.trafficRps)
    run(sim, 20)
    sim.stopScenario()
    expect(sim.state.knobs.trafficRps).toBe(before.trafficRps)
    expect(sim.state.knobs.hpaEnabled).toBe(before.hpaEnabled)
    /* The user owns the transport; a scenario must never rewind it. */
    expect(sim.state.knobs.timeScale).toBe(3)
  })

  it('keeps the etcd revision monotonic across every scenario, start to stop', () => {
    for (const id of REQUIRED_IDS) {
      const sim = settled(5, 120)
      let last = sim.state.etcd.revision
      sim.runScenario(id)
      for (let i = 0; i < 1800; i++) {
        sim.tick(DT)
        expect(sim.state.etcd.revision, `${id} regressed the revision`).toBeGreaterThanOrEqual(last)
        last = sim.state.etcd.revision
      }
      sim.stopScenario()
      for (let i = 0; i < 900; i++) {
        sim.tick(DT)
        expect(sim.state.etcd.revision, `${id} regressed the revision`).toBeGreaterThanOrEqual(last)
        last = sim.state.etcd.revision
      }
    }
  })

  it('returns to a converged cluster after every scenario is stopped', () => {
    for (const id of REQUIRED_IDS) {
      const sim = settled(6, 160)
      sim.runScenario(id)
      run(sim, 200)
      sim.stopScenario()
      run(sim, 400)
      const d = web(sim)
      expect(d.readyReplicas, `${id} did not recover`).toBe(d.replicas)
      expect(sim.state.totals.nodesReady, `${id} left a node down`).toBe(N_NODES)
      expect(sim.state.api.writable, `${id} left the API read-only`).toBe(true)
    }
  })
})

/* ===========================================================================
 * Rollouts
 * =========================================================================*/

describe('rolling-update', () => {
  it('creates a second ReplicaSet and trades the counts over without dropping below the budget', () => {
    const sim = settled(7, 200)
    const d = web(sim)
    const firstRs = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web')
    expect(firstRs).toHaveLength(1)

    sim.runScenario('rolling-update')
    run(sim, 320)

    const rss = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web')
    expect(rss).toHaveLength(2)
    const active = rss.find((r) => r.replicas > 0)!
    const retired = rss.find((r) => r.replicas === 0)!
    expect(active.image).not.toBe(retired.image)
    expect(active.revision).toBeGreaterThan(retired.revision)
    expect(d.updatedReplicas).toBe(d.replicas)
    expect(d.rollingOut).toBe(false)
    /* Every live pod carries the new revision. */
    for (const p of pods(sim, 'web')) {
      if (podIsTerminating(p)) continue
      expect(p.revision).toBe(active.revision)
    }
  })
})

describe('bad-rollout', () => {
  it('wedges rather than taking the service down, and reports progressDeadlineExceeded', () => {
    const sim = settled(8, 200)
    const d = web(sim)
    expect(d.maxUnavailable).toBe(0)
    const healthy = d.readyReplicas

    sim.runScenario('bad-rollout')
    for (let i = 0; i < 2600; i++) {
      sim.tick(DT)
      /* The whole point of maxUnavailable: 0 is that the old pods stay up. */
      expect(d.availableReplicas).toBeGreaterThanOrEqual(healthy)
    }
    expect(d.updatedReplicas).toBeLessThan(d.replicas)
    expect(d.rollingOut).toBe(true)
    expect(d.progressDeadlineExceeded).toBe(true)
    expect(reasons(sim).has('ProgressDeadlineExceeded')).toBe(true)
    expect(reasons(sim).has('Unhealthy')).toBe(true)

    /* The new pods run; they simply never pass readiness. */
    const newest = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web').sort((a, b) => b.revision - a.revision)[0]
    const wedged = pods(sim, 'web').filter((p) => p.revision === newest.revision)
    expect(wedged.length).toBeGreaterThan(0)
    for (const p of wedged) {
      expect(p.phase).toBe('Running')
      expect(p.conditions.Ready).toBe(false)
    }
  })

  it('rolls back instantly, because the old ReplicaSet was never destroyed', () => {
    const sim = settled(9, 200)
    const d = web(sim)
    sim.runScenario('bad-rollout')
    run(sim, 200)
    expect(d.rollingOut).toBe(true)

    const oldRs = sim.state.replicaSets
      .filter((r) => r.ownerDeployment === 'web')
      .sort((a, b) => a.revision - b.revision)[0]
    const oldImage = oldRs.image

    sim.stopScenario()
    run(sim, 30)
    /* Thirty seconds: no image pull, no build — the pods were already there. */
    expect(d.rollingOut).toBe(false)
    expect(d.readyReplicas).toBe(d.replicas)
    expect(d.progressDeadlineExceeded).toBe(false)
    const live = sim.state.replicaSets.find((r) => r.ownerDeployment === 'web' && r.replicas > 0)!
    expect(live.image).toBe(oldImage)
    expect(reasons(sim).has('DeploymentRollback')).toBe(true)
  })
})

/* ===========================================================================
 * Node and container failures
 * =========================================================================*/

describe('node-failure', () => {
  it('takes 40 s to notice, drops the endpoints at once, and only evicts 5 minutes later', () => {
    const sim = settled(10, 200)
    const node = sim.state.nodes[0]
    const svc = sim.state.services.find((s) => s.name === 'web')!
    const podsThere = node.podUids.slice()
    expect(podsThere.length).toBeGreaterThan(0)

    sim.runScenario('node-failure')
    run(sim, TIMING.nodeMonitorGraceSeconds - 15)
    expect(node.conditions.find((c) => c.type === 'Ready')!.status).toBe('True')
    expect(sim.state.totals.nodesReady).toBe(N_NODES)

    run(sim, 45)
    expect(node.conditions.find((c) => c.type === 'Ready')!.status).toBe('Unknown')
    expect(sim.state.totals.nodesReady).toBe(N_NODES - 1)
    expect(reasons(sim).has('NodeNotReady')).toBe(true)
    /* Endpoints go the moment the node is declared unreachable. */
    for (const uid of podsThere) {
      expect(svc.endpoints.some((e) => e.podUid === uid && e.ready)).toBe(false)
    }
    /* But nothing has been deleted: the pods are still there, untouched. */
    expect(node.podUids.length).toBe(podsThere.length)

    run(sim, TIMING.notReadyTolerationSeconds + 100)
    expect(node.podUids.length).toBeLessThan(podsThere.length)
    sim.stopScenario()
    run(sim, 200)
    expect(node.conditions.find((c) => c.type === 'Ready')!.status).toBe('True')
    expect(web(sim).readyReplicas).toBe(web(sim).replicas)
  })
})

describe('crashloop', () => {
  it('restarts with a growing backoff and empties the Service while it does', () => {
    const sim = settled(11, 200)
    const svc = sim.state.services.find((s) => s.name === 'web')!
    expect(svc.endpoints.filter((e) => e.ready).length).toBeGreaterThan(0)

    sim.runScenario('crashloop')
    run(sim, 180)

    const restarts = sim.state.totals.restarts
    expect(restarts).toBeGreaterThan(0)
    expect(reasons(sim).has('BackOff')).toBe(true)
    expect(svc.endpoints.filter((e) => e.ready).length).toBe(0)
    /* kube-proxy has no backend left, on every node, at the same time. */
    for (const node of sim.state.nodes) {
      expect(node.proxyRules.find((r) => r.service === 'shop/web')!.endpoints).toHaveLength(0)
    }
    expect(sim.state.ingresses[0].errorRate).toBeGreaterThan(0.5)

    /* A pod in CrashLoopBackOff is still Running: the phase does not change. */
    const looping = pods(sim, 'web').find((p) => p.containers.some((c) => c.reason === 'CrashLoopBackOff'))
    expect(looping).toBeDefined()
    expect(looping!.phase).toBe('Running')
    const c = looping!.containers.find((x) => x.reason === 'CrashLoopBackOff')!
    expect(c.backoffSeconds).toBeGreaterThanOrEqual(TIMING.crashBackoffStartSeconds)
    expect(c.backoffSeconds).toBeLessThanOrEqual(TIMING.crashBackoffMaxSeconds)

    sim.stopScenario()
    run(sim, 400)
    expect(web(sim).readyReplicas).toBe(web(sim).replicas)
    /* Restart counts are history; they do not get erased by recovery. */
    expect(sim.state.totals.restarts).toBeGreaterThanOrEqual(restarts)
  })
})

describe('oom-kill', () => {
  it('kills at the memory limit with no warning and no throttling', () => {
    const sim = settled(12, 200)
    sim.runScenario('oom-kill')

    let sawOom = false
    let peak = 0
    for (let i = 0; i < 2400 && !sawOom; i++) {
      sim.tick(DT)
      for (const p of pods(sim, 'web')) {
        for (const c of p.containers) {
          if (c.role !== 'app') continue
          peak = Math.max(peak, c.usedMemMib)
          if (c.reason === 'OOMKilled') sawOom = true
        }
      }
    }
    expect(sawOom).toBe(true)
    expect(reasons(sim).has('OOMKilling')).toBe(true)
    const app = pods(sim, 'web')[0].containers.find((c) => c.role === 'app')!
    expect(peak).toBeGreaterThan(app.limitMemMib * 0.9)

    sim.stopScenario()
    run(sim, 500)
    expect(web(sim).readyReplicas).toBe(web(sim).replicas)
  })
})

describe('image-pull-failure', () => {
  it('schedules the pod perfectly and then cannot start it', () => {
    const sim = settled(13, 200)
    sim.runScenario('image-pull-failure')
    run(sim, 200)

    const newest = sim.state.replicaSets
      .filter((r) => r.ownerDeployment === 'web')
      .sort((a, b) => b.revision - a.revision)[0]
    const stuck = pods(sim, 'web').filter((p) => p.revision === newest.revision)
    expect(stuck.length).toBeGreaterThan(0)
    for (const p of stuck) {
      /* The scheduler did its job: the pod has a node. The kubelet cannot. */
      expect(p.nodeName).toBeDefined()
      expect(p.phase).toBe('Pending')
      const app = p.containers.find((c) => c.role === 'app')!
      expect(['ErrImagePull', 'ImagePullBackOff']).toContain(app.reason)
    }
    expect(reasons(sim).has('BackOff')).toBe(true)
    expect(reasons(sim).has('Failed')).toBe(true)
    /* The old revision is still serving every request. */
    expect(web(sim).availableReplicas).toBe(web(sim).replicas)
  })
})

/* ===========================================================================
 * Control-plane failures
 * =========================================================================*/

describe('etcd-quorum-loss', () => {
  it('freezes every write, stops every controller, and still answers reads', () => {
    const sim = settled(14, 200)
    expect(sim.state.etcd.hasQuorum).toBe(true)

    sim.runScenario('etcd-quorum-loss')
    run(sim, 60)

    expect(sim.state.etcd.hasQuorum).toBe(false)
    expect(sim.state.api.writable).toBe(false)
    const frozen = sim.state.etcd.revision
    run(sim, 60)
    expect(sim.state.etcd.revision).toBe(frozen)

    /* Losing the lease is what actually stops the reconcile loops. */
    expect(sim.state.scheduler.leading).toBe(false)
    for (const id of Object.keys(sim.state.controllers) as (keyof typeof sim.state.controllers)[]) {
      expect(sim.state.controllers[id].leading).toBe(false)
    }
    /* The workloads themselves never noticed. */
    expect(sim.state.totals.podsRunning).toBeGreaterThan(0)
    expect(sim.state.api.counts.rejected).toBeGreaterThan(0)

    sim.stopScenario()
    run(sim, 120)
    expect(sim.state.etcd.hasQuorum).toBe(true)
    expect(sim.state.api.writable).toBe(true)
    expect(sim.state.etcd.revision).toBeGreaterThan(frozen)
    expect(sim.state.controllers.deployment.leading).toBe(true)
  })

  it('elects a new leader in a new term once the survivors regroup', () => {
    const sim = settled(15, 160)
    const startTerm = Math.max(...sim.state.etcd.members.map((m) => m.term))
    sim.runScenario('etcd-quorum-loss')
    run(sim, 60)
    sim.stopScenario()
    run(sim, 60)
    const leader = sim.state.etcd.members.find((m) => m.role === 'leader')
    expect(leader).toBeDefined()
    expect(leader!.term).toBeGreaterThan(startTerm)
  })
})

describe('webhook-outage', () => {
  it('turns a policy webhook into a cluster-wide write outage', () => {
    const sim = settled(16, 200)
    const rejectedBefore = sim.state.api.counts.rejected
    sim.runScenario('webhook-outage')
    run(sim, 60)

    const frozen = sim.state.etcd.revision
    run(sim, 60)
    expect(sim.state.etcd.revision).toBe(frozen)
    expect(sim.state.api.counts.rejected).toBeGreaterThan(rejectedBefore)
    /* etcd is perfectly healthy. Nothing can reach it. */
    expect(sim.state.etcd.hasQuorum).toBe(true)
    expect(sim.state.api.writable).toBe(true)

    sim.stopScenario()
    run(sim, 120)
    expect(sim.state.etcd.revision).toBeGreaterThan(frozen)
    expect(web(sim).readyReplicas).toBe(web(sim).replicas)
  })
})

/* ===========================================================================
 * Scheduling
 * =========================================================================*/

describe('hpa-traffic-spike', () => {
  it('scales on utilisation of requests and then refuses to shrink for five minutes', () => {
    const sim = settled(17, 200)
    const d = web(sim)
    const startReplicas = d.replicas
    const hpa = sim.state.hpas[0]

    sim.runScenario('hpa-traffic-spike')
    run(sim, 260)

    expect(hpa.unknownMetrics).toBe(false)
    expect(d.replicas).toBeGreaterThan(startReplicas)
    expect(d.replicas).toBeLessThanOrEqual(hpa.maxReplicas)
    expect(reasons(sim).has('SuccessfulRescale')).toBe(true)
    expect(hpa.stabilizationRemaining).toBeGreaterThan(0)

    const grown = d.replicas
    sim.setKnob('trafficRps', 10)
    run(sim, 60)
    expect(hpa.desiredReplicas).toBeLessThan(grown)
    /* It wants to shrink and is not allowed to. */
    expect(d.replicas).toBe(grown)
    expect(hpa.stabilizationRemaining).toBeGreaterThan(0)

    /* Now watch until it finally does, and pin the rule that let it: a shrink
     * may only land on a tick where the window had already run out. */
    let shrinks = 0
    for (let i = 0; i < 8000; i++) {
      const windowBefore = hpa.stabilizationRemaining
      const replicasBefore = d.replicas
      sim.tick(DT)
      if (d.replicas < replicasBefore) {
        shrinks += 1
        expect(windowBefore).toBe(0)
      }
    }
    expect(shrinks).toBeGreaterThan(0)
    expect(d.replicas).toBeLessThan(grown)

    sim.stopScenario()
    run(sim, 300)
    expect(d.readyReplicas).toBe(d.replicas)
  })
})

describe('pending-unschedulable', () => {
  it('reports the aggregated filter reason while the cluster sits mostly idle', () => {
    const sim = settled(18, 200)
    sim.runScenario('pending-unschedulable')
    run(sim, 200)

    expect(sim.state.totals.podsPending).toBeGreaterThan(0)
    const failures = sim.state.events.filter((e) => e.reason === 'FailedScheduling')
    expect(failures.length).toBeGreaterThan(0)
    const msg = failures[failures.length - 1].message
    expect(msg).toContain(`0/${N_NODES} nodes are available`)
    expect(msg).toContain('Insufficient cpu')
    expect(msg).toContain('node(s) had untolerated taint')

    /* The lesson: requests, not usage. There is idle CPU everywhere. */
    let used = 0
    let allocatable = 0
    for (const n of sim.state.nodes) {
      used += n.usedCpuMilli
      allocatable += n.allocatableCpuMilli
    }
    expect(used / allocatable).toBeLessThan(0.5)

    const pending = pods(sim, 'web').filter((p) => !p.nodeName)
    expect(pending.length).toBeGreaterThan(0)
    for (const p of pending) expect(p.conditions.PodScheduled).toBe(false)
  })
})

describe('preemption', () => {
  it('evicts the cheapest set of lower-priority pods to make room', () => {
    const sim = settled(19, 200)
    sim.runScenario('preemption')
    run(sim, 320)

    const preempted = sim.state.events.filter((e) => e.reason === 'Preempted')
    expect(preempted.length).toBeGreaterThan(0)

    const checkout = pods(sim, 'checkout')
    expect(checkout.length).toBeGreaterThan(0)
    const landed = checkout.filter((p) => p.nodeName)
    expect(landed.length).toBeGreaterThan(0)
    for (const p of landed) expect(p.priority).toBe(1000)

    /* Only strictly lower-priority pods may ever be victims. */
    for (const e of preempted) {
      const name = e.involved.replace('pod/', '')
      expect(name.startsWith('filler-')).toBe(true)
    }
    /* And the displaced work is Pending, not lost. */
    const fillerPending = pods(sim, 'filler').filter((p) => !p.nodeName)
    expect(fillerPending.length).toBeGreaterThan(0)

    sim.stopScenario()
    run(sim, 300)
    expect(pods(sim, 'checkout')).toHaveLength(0)
    expect(pods(sim, 'filler')).toHaveLength(0)
  })
})

describe('pdb-blocks-drain', () => {
  it('cordons the node and then cannot evict a single pod', () => {
    const sim = settled(20, 200)
    const node = sim.state.nodes[0]
    const pdb = sim.state.pdbs[0]
    const before = pods(sim, 'web').filter((p) => p.nodeName === node.name).length
    expect(before).toBeGreaterThan(0)

    sim.runScenario('pdb-blocks-drain')
    run(sim, 120)

    expect(node.unschedulable).toBe(true)
    expect(pdb.minAvailable).toBe(web(sim).replicas)
    expect(pdb.disruptionsAllowed).toBe(0)
    expect(reasons(sim).has('EvictionBlocked')).toBe(true)
    /* The web pods on the cordoned node are exactly where they were. */
    const stillThere = pods(sim, 'web').filter((p) => p.nodeName === node.name && !podIsTerminating(p))
    expect(stillThere.length).toBe(before)

    sim.stopScenario()
    run(sim, 120)
    expect(node.unschedulable).toBe(false)
    expect(pdb.disruptionsAllowed).toBeGreaterThan(0)
  })

  it('keeps the budget honest: disruptionsAllowed is healthy minus minAvailable', () => {
    const sim = settled(21, 200)
    const pdb = sim.state.pdbs[0]
    for (let i = 0; i < 400; i++) {
      sim.tick(DT)
      let healthy = 0
      for (const p of pods(sim, 'web')) if (podIsReady(p)) healthy += 1
      expect(pdb.currentHealthy).toBe(healthy)
      expect(pdb.disruptionsAllowed).toBe(Math.max(0, healthy - pdb.minAvailable))
    }
  })
})
