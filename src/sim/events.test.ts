import { describe, expect, it } from 'vitest'
import { createSim } from './model'

/* Events outlive the objects they describe. That is the whole reason the
 * namespace is stamped when the event is born rather than looked up later. */

function run(sim: ReturnType<typeof createSim>, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
}

describe('cluster events', () => {
  it('stamps the namespace of the object the event is about', () => {
    const sim = createSim(21)
    run(sim, 60)
    const podEvents = sim.state.events.filter((e) => e.involved.startsWith('pod/'))
    expect(podEvents.length).toBeGreaterThan(0)
    for (const e of podEvents) {
      expect(e.namespace, `${e.reason} ${e.involved}`).not.toBe('')
    }
  })

  it('keeps the namespace after the object is gone', () => {
    const sim = createSim(23)
    /* Churn the workload so pods are replaced and their events are orphaned. */
    run(sim, 40)
    sim.setKnob('replicas', 1)
    run(sim, 60)
    sim.setKnob('replicas', 6)
    run(sim, 60)

    const live = new Set([...sim.state.pods.values()].map((p) => p.name))
    const orphaned = sim.state.events.filter(
      (e) => e.involved.startsWith('pod/') && !live.has(e.involved.slice(4)),
    )
    /* The scenario is only meaningful if pods really did come and go. */
    expect(orphaned.length).toBeGreaterThan(0)
    for (const e of orphaned) {
      expect(e.namespace, `orphaned ${e.reason} ${e.involved}`).not.toBe('')
    }
  })

  it('leaves cluster-scoped objects without a namespace', () => {
    const sim = createSim(29)
    sim.setKnob('nodeDown', 1)
    run(sim, 120)
    const nodeEvents = sim.state.events.filter((e) => e.involved.startsWith('node/'))
    expect(nodeEvents.length).toBeGreaterThan(0)
    for (const e of nodeEvents) expect(e.namespace).toBe('')
  })

  it('aggregates a repeated reason on one object instead of repeating it', () => {
    const sim = createSim(31)
    sim.setKnob('crashLoop', true)
    run(sim, 200)
    const backoff = sim.state.events.filter((e) => e.reason === 'BackOff')
    expect(backoff.length).toBeGreaterThan(0)
    /* Aggregation is what keeps the stream readable; at least one must have
     * been seen more than once for the count column to mean anything. */
    expect(Math.max(...backoff.map((e) => e.count))).toBeGreaterThan(1)
  })

  it('only ever uses the two event types Kubernetes defines', () => {
    const sim = createSim(37)
    sim.setKnob('crashLoop', true)
    run(sim, 150)
    const types = new Set(sim.state.events.map((e) => e.type))
    for (const t of types) expect(['Normal', 'Warning']).toContain(t)
    expect(types.size).toBe(2)
  })
})
