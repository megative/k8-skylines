import { describe, expect, it } from 'vitest'
import { createSim } from './model'

/*
 * Deletion is a real cluster mutation, not a UI trick. These pin the two things
 * that make it worth having: that a standalone object stays gone with the
 * consequence you would expect, and that a controller-owned object comes back —
 * which is the lesson, not a bug. A delete goes through the API pipeline, so the
 * removal lands a few ticks later, never synchronously.
 */

function run(sim: ReturnType<typeof createSim>, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
}

function names<T extends { name: string }>(xs: T[]): string[] {
  return xs.map((x) => x.name)
}

describe('deleting standalone objects', () => {
  it('removes an Ingress and stops external traffic reaching the backends', () => {
    const sim = createSim(0xde1)
    run(sim, 60)
    const ing = sim.state.ingresses[0]
    expect(ing).toBeDefined()
    expect(ing.rps).toBeGreaterThan(0)

    expect(sim.deleteObject('ingress', ing.namespace, ing.name)).toBe(true)
    run(sim, 20)

    expect(names(sim.state.ingresses)).not.toContain(ing.name)
    /* No Ingress means no external route: nothing is arriving at the edge. */
    for (const i of sim.state.ingresses) expect(i.name).not.toBe(ing.name)
    expect(sim.state.ingresses.reduce((a, i) => a + i.rps, 0)).toBe(0)
  })

  it('goes through the API pipeline: a delete during lost quorum cannot commit', () => {
    const sim = createSim(0xde2)
    run(sim, 60)
    const ing = sim.state.ingresses[0]
    /* Two of three members down: no majority, no commits. */
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 10)
    sim.deleteObject('ingress', ing.namespace, ing.name)
    run(sim, 20)
    /* The write cannot reach storage, so the object is untouched — the delete
     * did not bypass etcd, which is the whole point. */
    expect(names(sim.state.ingresses)).toContain(ing.name)

    /* With quorum back, re-issuing the delete lands normally. */
    sim.setKnob('etcdMembersDown', 0)
    run(sim, 20)
    sim.deleteObject('ingress', ing.namespace, ing.name)
    run(sim, 20)
    expect(names(sim.state.ingresses)).not.toContain(ing.name)
  })

  it('removes a Service and drops its rule tables from every node', () => {
    const sim = createSim(0xde3)
    run(sim, 60)
    const svc = sim.state.services.find((v) => v.type !== 'Headless')!
    expect(svc).toBeDefined()
    const ruleCountFor = (): number => {
      let n = 0
      for (const node of sim.state.nodes) for (const r of node.proxyRules) if (r.service === `${svc.namespace}/${svc.name}`) n++
      return n
    }
    expect(ruleCountFor()).toBeGreaterThan(0)
    const podsBehind = [...sim.state.pods.values()].filter((p) => p.labels.app === svc.selector.app).length

    expect(sim.deleteObject('service', svc.namespace, svc.name)).toBe(true)
    run(sim, 20)

    expect(names(sim.state.services)).not.toContain(svc.name)
    expect(ruleCountFor()).toBe(0)
    /* The pods it pointed at are untouched. */
    const stillThere = [...sim.state.pods.values()].filter((p) => p.labels.app === svc.selector.app).length
    expect(stillThere).toBe(podsBehind)
  })

  it('removes a NetworkPolicy', () => {
    const sim = createSim(0xde4)
    sim.setKnob('networkPolicyEnabled', true)
    run(sim, 40)
    const np = sim.state.networkPolicies[0]
    expect(np).toBeDefined()
    expect(sim.deleteObject('networkpolicy', np.namespace, np.name)).toBe(true)
    run(sim, 15)
    expect(names(sim.state.networkPolicies)).not.toContain(np.name)
  })
})

describe('deleting a Deployment cascades to its pods', () => {
  it('garbage-collects the ReplicaSets and pods it owned', () => {
    const sim = createSim(0xde5)
    run(sim, 90)
    const dep = sim.state.deployments.find((d) => d.name === 'web')!
    const owned = () => [...sim.state.pods.values()].filter((p) => p.labels.app === 'web').length
    expect(owned()).toBeGreaterThan(0)

    expect(sim.deleteObject('deployment', dep.namespace, 'web')).toBe(true)
    run(sim, 90)

    expect(names(sim.state.deployments)).not.toContain('web')
    expect(sim.state.replicaSets.some((r) => r.ownerDeployment === 'web')).toBe(false)
    expect(owned()).toBe(0)
  })
})

describe('deleting a controller-owned object brings it back', () => {
  it('recreates a deleted pod through its ReplicaSet', () => {
    const sim = createSim(0xde6)
    run(sim, 90)
    const before = [...sim.state.pods.values()].find((p) => p.labels.app === 'web')!
    const countWeb = () => [...sim.state.pods.values()].filter((p) => p.labels.app === 'web').length
    const target = countWeb()

    expect(sim.deleteObject('pod', before.namespace, before.name)).toBe(true)
    run(sim, 60)

    /* The exact pod is gone... */
    expect([...sim.state.pods.values()].some((p) => p.name === before.name && p.deletionGraceSeconds === undefined)).toBe(false)
    /* ...but the ReplicaSet restored the count. */
    expect(countWeb()).toBe(target)
  })
})

describe('deletion reports honestly', () => {
  it('returns false for an object that does not exist', () => {
    const sim = createSim(0xde7)
    run(sim, 30)
    expect(sim.deleteObject('ingress', 'shop', 'no-such-ingress')).toBe(false)
    expect(sim.deleteObject('service', 'shop', 'ghost')).toBe(false)
  })

  it('reset brings a deleted standalone object back', () => {
    const sim = createSim(0xde8)
    run(sim, 60)
    const ing = sim.state.ingresses[0].name
    sim.deleteObject('ingress', 'shop', ing)
    run(sim, 20)
    expect(names(sim.state.ingresses)).not.toContain(ing)

    sim.reset()
    run(sim, 60)
    expect(names(sim.state.ingresses)).toContain(ing)
  })
})

describe('the two doors into the cluster carry their own traffic', () => {
  /* The traffic knob is what users send; what gets in depends on which doors
   * exist. Deleting one must take its share away and leave the other serving. */
  const lbRps = (sim: ReturnType<typeof createSim>): number =>
    sim.state.services.find((v) => v.type === 'LoadBalancer')?.rps ?? 0
  const ingRps = (sim: ReturnType<typeof createSim>): number =>
    sim.state.ingresses.reduce((a, i) => a + i.rps, 0)
  const podCpu = (sim: ReturnType<typeof createSim>): number => {
    let c = 0
    for (const p of sim.state.pods.values()) {
      if (p.labels.app !== 'web') continue
      for (const k of p.containers) c += k.usedCpuMilli
    }
    return c
  }

  it('deleting the LoadBalancer stops the traffic on its address', () => {
    const sim = createSim(0xd0001)
    run(sim, 90)
    expect(lbRps(sim)).toBeGreaterThan(0)
    const ingBefore = ingRps(sim)
    const cpuBefore = podCpu(sim)

    sim.deleteObject('service', 'shop', 'web-lb')
    run(sim, 40)

    /* Its own traffic is gone... */
    expect(lbRps(sim)).toBe(0)
    /* ...the Ingress keeps serving its own share, unchanged... */
    expect(ingRps(sim)).toBeCloseTo(ingBefore, 0)
    /* ...and the pods really do less work, because fewer requests arrive. */
    expect(podCpu(sim)).toBeLessThan(cpuBefore)
  })

  it('deleting the Ingress leaves the LoadBalancer serving', () => {
    const sim = createSim(0xd0002)
    run(sim, 90)
    expect(ingRps(sim)).toBeGreaterThan(0)
    const lbBefore = lbRps(sim)

    sim.deleteObject('ingress', 'shop', 'shop')
    run(sim, 40)

    expect(ingRps(sim)).toBe(0)
    expect(lbRps(sim)).toBeCloseTo(lbBefore, 0)
    /* Traffic still reaches the pods through the other door. */
    expect(podCpu(sim)).toBeGreaterThan(0)
  })

  it('with every door deleted nothing reaches a pod', () => {
    const sim = createSim(0xd0003)
    run(sim, 90)
    sim.deleteObject('ingress', 'shop', 'shop')
    sim.deleteObject('service', 'shop', 'web-lb')
    run(sim, 60)

    expect(ingRps(sim)).toBe(0)
    expect(lbRps(sim)).toBe(0)
    /* The knob still asks for traffic; the cluster simply has no way in. */
    expect(sim.state.knobs.trafficRps).toBeGreaterThan(0)
    for (const p of sim.state.pods.values()) {
      if (p.labels.app !== 'web') continue
      for (const k of p.containers) {
        /* Only the container's idle draw is left. */
        expect(k.usedCpuMilli).toBeLessThan(60)
      }
    }
  })
})

describe('apply recreates predefined objects', () => {
  it('round-trips a deleted Ingress: delete then apply brings it back', () => {
    const sim = createSim(0xa01)
    run(sim, 60)
    const ing = sim.state.ingresses[0].name
    sim.deleteObject('ingress', 'shop', ing)
    run(sim, 20)
    expect(names(sim.state.ingresses)).not.toContain(ing)

    expect(sim.applyObject('ingress', ing)).toBe('created')
    run(sim, 20)
    expect(names(sim.state.ingresses)).toContain(ing)
    /* And external traffic is flowing again. */
    expect(sim.state.ingresses.reduce((a, i) => a + i.rps, 0)).toBeGreaterThan(0)
  })

  it('brings a deleted Deployment back, with its pods', () => {
    const sim = createSim(0xa02)
    run(sim, 90)
    sim.deleteObject('deployment', 'shop', 'web')
    run(sim, 60)
    expect(names(sim.state.deployments)).not.toContain('web')

    expect(sim.applyObject('deployment', 'web')).toBe('created')
    run(sim, 120)
    expect(names(sim.state.deployments)).toContain('web')
    expect([...sim.state.pods.values()].filter((p) => p.labels.app === 'web').length).toBeGreaterThan(0)
  })

  it('is idempotent: applying an object that exists is unchanged', () => {
    const sim = createSim(0xa03)
    run(sim, 60)
    expect(sim.applyObject('ingress', sim.state.ingresses[0].name)).toBe('unchanged')
    expect(sim.applyObject('deployment', 'web')).toBe('unchanged')
  })

  it('will not apply anything outside the catalogue', () => {
    const sim = createSim(0xa04)
    run(sim, 30)
    expect(sim.applyObject('deployment', 'not-a-seed')).toBe('unknown')
    const kinds = new Set(sim.applyCatalogue().map((c) => c.kind))
    expect(kinds.has('ingress')).toBe(true)
    expect(kinds.has('deployment')).toBe(true)
  })

  it('goes through the API pipeline: apply during lost quorum cannot commit', () => {
    const sim = createSim(0xa05)
    run(sim, 60)
    const ing = sim.state.ingresses[0].name
    sim.deleteObject('ingress', 'shop', ing)
    run(sim, 20)
    sim.setKnob('etcdMembersDown', 2)
    run(sim, 10)
    sim.applyObject('ingress', ing)
    run(sim, 20)
    /* No quorum, so the create cannot land. */
    expect(names(sim.state.ingresses)).not.toContain(ing)

    sim.setKnob('etcdMembersDown', 0)
    run(sim, 20)
    sim.applyObject('ingress', ing)
    run(sim, 20)
    expect(names(sim.state.ingresses)).toContain(ing)
  })
})

describe('a Service with no ready endpoints carries no traffic', () => {
  /*
   * kube-proxy programmes one rule per *ready* EndpointSlice entry. With an
   * empty set there is no backend to rewrite the destination to, so the kernel
   * refuses the connection: nothing flows, and nothing queues waiting for a pod
   * to become ready. The model used to send full traffic into a Service whose
   * pods were all gone, which drew glyphs flying at nodes running nothing.
   */
  const svc = (sim: ReturnType<typeof createSim>, name: string) =>
    sim.state.services.find((v) => v.name === name)!

  const readyOf = (sim: ReturnType<typeof createSim>, name: string): number =>
    svc(sim, name).endpoints.filter((e) => e.ready).length

  it('drops the web Service to zero rps once its pods are gone', () => {
    const sim = createSim(0xe0f1)
    run(sim, 90)
    expect(readyOf(sim, 'web')).toBeGreaterThan(0)
    expect(svc(sim, 'web').rps).toBeGreaterThan(0)

    /* Delete the Deployment so the ReplicaSet cannot put the pods back. */
    sim.deleteObject('deployment', 'shop', 'web')
    run(sim, 120)

    expect(readyOf(sim, 'web')).toBe(0)
    /* approach() decays exponentially and never lands on exactly zero, so the
     * claim is "no traffic", not "the float is 0". Anything under a hundredth of
     * a request per second is nothing by any reading. */
    expect(svc(sim, 'web').rps).toBeLessThan(0.01)
    /* The LoadBalancer selects the same pods, so it is empty at the same time. */
    expect(svc(sim, 'web-lb').rps).toBeLessThan(0.01)
    /* The knob is still asking for traffic; there is simply nowhere to put it. */
    expect(sim.state.knobs.trafficRps).toBeGreaterThan(0)
  })

  it('keeps serving while at least one endpoint is ready', () => {
    const sim = createSim(0xe0f2)
    sim.setKnob('replicas', 1)
    run(sim, 120)
    expect(readyOf(sim, 'web')).toBe(1)
    expect(svc(sim, 'web').rps).toBeGreaterThan(0)
  })
})

describe('the database is reached from the api tier, not from a door', () => {
  /*
   * Nothing external addresses the database: no Ingress rule names it, it has no
   * LoadBalancer, and it is Headless, so there is not even a virtual IP. Its load
   * can only come from the tier in front of it, which is why killing that tier
   * has to silence it.
   */
  const rpsOf = (sim: ReturnType<typeof createSim>, name: string): number =>
    sim.state.services.find((v) => v.name === name)!.rps

  it('goes quiet when the api pods are gone, even with the doors wide open', () => {
    const sim = createSim(0xdb01)
    run(sim, 90)
    expect(rpsOf(sim, 'api')).toBeGreaterThan(0)
    expect(rpsOf(sim, 'db')).toBeGreaterThan(0)

    sim.deleteObject('deployment', 'shop', 'api')
    run(sim, 150)

    /* Both doors are untouched and still admitting traffic... */
    expect(sim.state.ingresses.reduce((a, i) => a + i.rps, 0)).toBeGreaterThan(0)
    /* ...but nothing can reach the database any more. */
    expect(rpsOf(sim, 'api')).toBeLessThan(0.01)
    expect(rpsOf(sim, 'db')).toBeLessThan(0.01)
  })
})
