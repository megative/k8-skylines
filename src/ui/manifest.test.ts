import { describe, expect, it } from 'vitest'
import { createSim } from '../sim/model'
import { hasManifest, manifestFor } from './manifest'

/* The manifest is the bridge between the city and the terminal, so it has to
 * agree with the model exactly. These tests read the same SimState the geometry
 * reads and check the YAML says the same thing. */

function run(sim: ReturnType<typeof createSim>, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
}

describe('manifestFor', () => {
  it('offers a manifest only for things that are API objects', () => {
    expect(hasManifest('pod')).toBe(true)
    expect(hasManifest('deployment')).toBe(true)
    expect(hasManifest('node')).toBe(true)
    expect(hasManifest('net.service')).toBe(true)
    /* The city's own scenery is not a resource and must not pretend to be. */
    expect(hasManifest('ground.excavation')).toBe(false)
    expect(hasManifest('sky.time-of-day')).toBe(false)
    expect(hasManifest('controllers.workqueue')).toBe(false)
  })

  it('renders a pod as kubectl would, from live state', () => {
    const sim = createSim(7)
    run(sim, 60)
    const y = manifestFor('pod', sim.state)
    expect(y).toBeDefined()
    const text = y as string

    expect(text).toContain('apiVersion: v1')
    expect(text).toContain('kind: Pod')
    /* Requests and limits are the whole lesson; they must be in the spec. */
    expect(text).toContain('resources:')
    expect(text).toContain('requests:')
    expect(text).toContain('limits:')
    expect(text).toContain('qosClass:')
    expect(text).toMatch(/phase: (Pending|Running|Succeeded|Failed|Unknown)/)
  })

  it('reports the same pod phase the simulation holds', () => {
    const sim = createSim(11)
    run(sim, 90)
    const text = manifestFor('pod', sim.state) as string
    const shown = /phase: (\w+)/.exec(text)?.[1]
    const phases = new Set([...sim.state.pods.values()].map((p) => p.phase))
    expect(shown).toBeDefined()
    expect(phases.has(shown as never)).toBe(true)
  })

  it('carries the deployment rollout budget into the manifest', () => {
    const sim = createSim(3)
    sim.setKnob('maxSurge', 2)
    sim.setKnob('maxUnavailable', 1)
    run(sim, 20)
    const text = manifestFor('deployment', sim.state) as string
    expect(text).toContain('maxSurge: 2')
    expect(text).toContain('maxUnavailable: 1')
    expect(text).toContain('kind: Deployment')
  })

  it('follows the replica count the user asked for', () => {
    const sim = createSim(5)
    sim.setKnob('replicas', 7)
    run(sim, 20)
    expect(manifestFor('deployment', sim.state)).toContain('replicas: 7')
  })

  it('shows a headless service as clusterIP None, never as an address', () => {
    const sim = createSim(9)
    run(sim, 20)
    const text = manifestFor('net.service', sim.state) as string
    expect(text).toContain('kind: Service')
    /* A ClusterIP that is an address must be quoted as a string, not a number. */
    expect(text).toMatch(/clusterIP: (None|'?\d+\.\d+\.\d+\.\d+'?)/)
  })

  it('separates node capacity from allocatable', () => {
    const sim = createSim(13)
    run(sim, 20)
    const text = manifestFor('node', sim.state) as string
    expect(text).toContain('capacity:')
    expect(text).toContain('allocatable:')
    /* kube-reserved is real: allocatable is strictly smaller than capacity. */
    const cap = /capacity:\s+cpu: (\S+)/.exec(text)?.[1]
    const alloc = /allocatable:\s+cpu: (\S+)/.exec(text)?.[1]
    expect(cap).toBeDefined()
    expect(alloc).toBeDefined()
    expect(cap).not.toBe(alloc)
  })

  it('omits a node that is not in the cluster', () => {
    const sim = createSim(17)
    sim.setKnob('nodeCount', 2)
    run(sim, 20)
    const text = manifestFor('node', sim.state) as string
    const shown = /name: (\S+)/.exec(text)?.[1]
    const present = sim.state.nodes.filter((n) => n.present).map((n) => n.name)
    expect(present).toContain(shown)
  })

  it('emits nothing rather than inventing an object it does not have', () => {
    const sim = createSim(19)
    expect(manifestFor('ground.roads', sim.state)).toBeUndefined()
    expect(manifestFor('sky.time-of-day', sim.state)).toBeUndefined()
  })
})
