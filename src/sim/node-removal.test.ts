import { describe, expect, it } from 'vitest'
import { TIMING } from '../core/types'
import { drainNode } from './controllers'
import { createSim, simContext } from './model'

/*
 * Absent is not down, and the two must never look alike.
 *
 * Removing a machine deletes its Node object. Nothing failed, so there is no
 * NotReady condition to observe and no NoExecute taint to tolerate: the pods
 * bound to it are simply orphaned, and PodGC removes them once it is sure the
 * node is really gone. A machine that stops answering is the opposite story —
 * the Node object is still there, and the cluster waits out the full toleration
 * before it touches anything.
 */

function run(sim: ReturnType<typeof createSim>, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
}

function podsOn(sim: ReturnType<typeof createSim>, nodeName: string): string[] {
  const out: string[] = []
  for (const p of sim.state.pods.values()) if (p.nodeName === nodeName) out.push(p.name)
  return out
}

describe('removing a machine from the cluster', () => {
  it('leaves nothing running on the machine that left', () => {
    const sim = createSim(0x9a11)
    run(sim, 90)
    expect(podsOn(sim, 'node-3').length).toBeGreaterThan(0)

    sim.setKnob('nodeCount', 2)
    /* Long enough for PodGC's quarantine, far short of the 300 s toleration
     * that a genuinely unreachable node would spend before losing a pod. */
    run(sim, 60)

    expect(podsOn(sim, 'node-3')).toEqual([])
    expect(podsOn(sim, 'node-4')).toEqual([])
    expect(sim.state.nodes[2].podUids).toEqual([])
    expect(sim.state.nodes[3].podUids).toEqual([])
  })

  it('is not a failure: no NotReady, no taint, no Warning', () => {
    const sim = createSim(0x9a12)
    run(sim, 90)
    const before = sim.state.events.length
    sim.setKnob('nodeCount', 2)
    run(sim, 120)

    for (const e of sim.state.events.slice(0, sim.state.events.length - before)) {
      if (e.involved === 'node/node-3' || e.involved === 'node/node-4') {
        expect(e.type, `${e.reason} on ${e.involved}`).toBe('Normal')
      }
    }
    for (const i of [2, 3]) {
      const n = sim.state.nodes[i]
      expect(n.taints.filter((t) => t.key.startsWith('node.kubernetes.io/'))).toEqual([])
      for (const c of n.conditions) expect(c.status, `${n.name} ${c.type}`).not.toBe('Unknown')
    }
  })

  it('puts the replicated work back on the machines that remain', () => {
    const sim = createSim(0x9a13)
    run(sim, 90)
    sim.setKnob('nodeCount', 2)
    run(sim, 180)

    /* A Deployment asks for a count, so the count is restored elsewhere. */
    for (const d of sim.state.deployments) {
      expect(d.availableReplicas, `deployment/${d.name}`).toBe(d.replicas)
    }
    /* A DaemonSet asks for one pod per node, so it legitimately shrinks with
     * the cluster. Reading that drop as lost capacity is the mistake this
     * distinction exists to prevent. */
    for (const ds of sim.state.daemonSets) {
      expect(ds.desiredScheduled, `daemonset/${ds.name}`).toBe(2)
      expect(ds.currentScheduled, `daemonset/${ds.name}`).toBe(2)
    }
    for (const p of sim.state.pods.values()) {
      if (!p.nodeName) continue
      expect(['node-1', 'node-2']).toContain(p.nodeName)
    }
  })

  it('counts only the machines that are in the cluster', () => {
    const sim = createSim(0x9a14)
    run(sim, 60)
    sim.setKnob('nodeCount', 2)
    run(sim, 60)

    expect(sim.state.totals.nodesTotal).toBe(2)
    /* Nothing is broken, so every machine in the cluster is Ready. A "2 / 4"
     * readout would report a two-node cluster as half dead. */
    expect(sim.state.totals.nodesReady).toBe(2)
  })

  it('gives a rejoining machine a new Node object, not the old one', () => {
    const sim = createSim(0x9a17)
    run(sim, 60)

    /* Cordon it. `unschedulable` lives on the Node object, and nothing in the
     * control plane ever clears it — an operator does, or the object goes. */
    drainNode(simContext(sim), 3)
    run(sim, 30)
    expect(sim.state.nodes[3].unschedulable).toBe(true)

    /* Take the machine out of the cluster and put it back. A kubelet that
     * registers creates a *new* Node object, and a cordon that survived it
     * would quietly keep the scheduler off a machine nobody cordoned. */
    sim.setKnob('nodeCount', 3)
    run(sim, 60)
    sim.setKnob('nodeCount', 4)
    run(sim, 30)

    expect(sim.state.nodes[3].unschedulable).toBe(false)
  })


  it('lets a machine rejoin without looking broken on arrival', () => {
    const sim = createSim(0x9a16)
    run(sim, 90)
    sim.setKnob('nodeCount', 2)
    run(sim, 120)

    const before = sim.state.events.length
    sim.setKnob('nodeCount', 4)
    run(sim, 30)

    /* A kubelet that registers writes a fresh Lease. Carrying the old clock
     * over would put the machine past nodeMonitorGracePeriod the instant it
     * joined, and it would arrive NotReady for no reason at all. */
    expect(sim.state.totals.nodesReady).toBe(4)
    expect(sim.state.totals.nodesTotal).toBe(4)
    for (const e of sim.state.events.slice(0, sim.state.events.length - before)) {
      expect(e.type, `${e.reason} ${e.involved}`).not.toBe('Warning')
    }

    /* And the DaemonSet fills the new machines back in. */
    run(sim, 120)
    for (const ds of sim.state.daemonSets) {
      expect(ds.currentScheduled, `daemonset/${ds.name}`).toBe(4)
    }
  })

  it('still makes an unreachable machine wait out the full toleration', () => {
    const sim = createSim(0x9a15)
    run(sim, 90)
    const doomed = podsOn(sim, 'node-1')
    expect(doomed.length).toBeGreaterThan(0)

    sim.setKnob('nodeDown', 1)
    run(sim, TIMING.nodeMonitorGraceSeconds + 60)
    /* Past NotReady, nowhere near the 300 s toleration: the pods are still
     * there, and that slowness is the lesson. */
    expect(podsOn(sim, 'node-1').length).toBeGreaterThan(0)
    expect(sim.state.nodes[0].taints.some((t) => t.effect === 'NoExecute')).toBe(true)

    run(sim, TIMING.notReadyTolerationSeconds + 60)
    /* The DaemonSet pod stays: it tolerates the NoExecute taint, which is the
     * whole reason a node agent keeps reporting from a node nobody can reach. */
    const left = [...sim.state.pods.values()].filter((p) => p.nodeName === 'node-1')
    expect(left.map((p) => p.name)).not.toEqual([])
    for (const p of left) expect(p.owner?.kind).toBe('DaemonSet')
  })
})
