import { describe, expect, it } from 'vitest'
import { createSim } from './model'

/*
 * Editing is only worth having if it refuses. These pin both halves: a mutable
 * field changes the cluster and the change is visible in what the cluster then
 * does, and an immutable one comes back with the reason the API server gives
 * rather than silently doing nothing.
 */

function run(sim: ReturnType<typeof createSim>, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
}

describe('editing a mutable field changes the cluster', () => {
  it('scales a Deployment, and the ReplicaSet follows', () => {
    const sim = createSim(0xed01)
    run(sim, 60)
    const webPods = () => [...sim.state.pods.values()].filter((p) => p.labels.app === 'web').length
    const before = webPods()

    const r = sim.editObject('deployment', 'shop', 'web', 'spec.replicas', before + 2)
    expect(r.outcome).toBe('applied')
    run(sim, 60)

    expect(sim.state.deployments.find((d) => d.name === 'web')!.replicas).toBe(before + 2)
    expect(webPods()).toBe(before + 2)
    /* The knob names the same field; letting them drift would make the rail
     * lie about the object it controls. */
    expect(sim.state.knobs.replicas).toBe(before + 2)
  })

  it('cordons a node: no new pods land, the ones already there stay', () => {
    const sim = createSim(0xed02)
    run(sim, 90)
    const node = sim.state.nodes.find((n) => n.present)!
    const uidsOn = (): Set<string> => {
      const out = new Set<string>()
      for (const [uid, p] of sim.state.pods) if (p.nodeName === node.name) out.add(uid)
      return out
    }
    const before = uidsOn()
    expect(before.size).toBeGreaterThan(0)

    expect(sim.editObject('node', '', node.name, 'spec.unschedulable', true).outcome).toBe('applied')
    run(sim, 30)
    expect(node.unschedulable).toBe(true)

    /*
     * Cordon promises one thing: nothing *new* is bound here. It does not pin
     * the pods already running — they can still finish, crash, or be replaced
     * elsewhere by their controller, which is exactly the difference between
     * cordon and drain. So the claim is "no additions", not "same count".
     */
    for (const uid of uidsOn()) expect(before.has(uid)).toBe(true)
  })

  it('is a no-op when the value already matches', () => {
    const sim = createSim(0xed03)
    run(sim, 60)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    expect(sim.editObject('deployment', 'shop', 'web', 'spec.replicas', d.replicas).outcome).toBe('unchanged')
  })
})

describe('the mutable half of the lesson', () => {
  it('changes a running Pod\'s image in place: the container restarts, the pod does not', () => {
    const sim = createSim(0xed0b)
    run(sim, 90)
    const pod = [...sim.state.pods.values()].find((p) => p.labels.app === 'web' && p.nodeName)!
    const name = pod.name
    const node = pod.nodeName
    const restarts = pod.containers.reduce((a, c) => a + c.restartCount, 0)

    const r = sim.editObject('pod', pod.namespace, name, 'spec.containers.image', 'shop/web:9.9.9')
    expect(r.outcome).toBe('applied')
    run(sim, 30)

    /* Same object: same name, same node, same uid. Only the container went. */
    const after = [...sim.state.pods.values()].find((p) => p.name === name)
    expect(after).toBeDefined()
    expect(after!.nodeName).toBe(node)
    expect(after!.containers.some((c) => c.image === 'shop/web:9.9.9')).toBe(true)
    expect(after!.containers.reduce((a, c) => a + c.restartCount, 0)).toBeGreaterThan(restarts)
  })

  it('changing a Deployment template image rolls out a new ReplicaSet', () => {
    const sim = createSim(0xed0c)
    run(sim, 90)
    const rsBefore = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web').length

    expect(sim.editObject('deployment', 'shop', 'web', 'spec.template.spec.containers.image', 'shop/web:2.0.0').outcome).toBe('applied')
    run(sim, 120)

    /* The controller made the new revision; the edit only wrote the template. */
    const rsAfter = sim.state.replicaSets.filter((r) => r.ownerDeployment === 'web')
    expect(rsAfter.length).toBeGreaterThan(rsBefore)
    expect(rsAfter.some((r) => r.image === 'shop/web:2.0.0')).toBe(true)
  })
})

describe('editing an immutable field is refused, with the reason', () => {
  it('refuses spec.nodeName on a bound pod', () => {
    const sim = createSim(0xed04)
    run(sim, 90)
    const pod = [...sim.state.pods.values()].find((p) => p.nodeName)!
    const was = pod.nodeName

    const r = sim.editObject('pod', pod.namespace, pod.name, 'spec.nodeName', 'node-4')
    expect(r.outcome).toBe('immutable')
    expect(r.message).toContain('immutable')
    run(sim, 10)
    expect(pod.nodeName).toBe(was)
  })

  it('refuses spec.clusterIP on a Service', () => {
    const sim = createSim(0xed05)
    run(sim, 60)
    const svc = sim.state.services.find((v) => v.name === 'web')!
    const was = svc.clusterIp

    const r = sim.editObject('net.service', 'shop', 'web', 'spec.clusterIP', '10.96.9.9')
    expect(r.outcome).toBe('immutable')
    run(sim, 10)
    expect(svc.clusterIp).toBe(was)
  })

  it('refuses a Deployment selector change, naming the orphaning', () => {
    const sim = createSim(0xed06)
    run(sim, 60)
    const r = sim.editObject('deployment', 'shop', 'web', 'spec.selector', '{"app":"other"}')
    expect(r.outcome).toBe('immutable')
    expect(r.message).toContain('field is immutable')
    expect(r.message).toContain('orphan')
  })

  it('refuses to rename anything, on every kind', () => {
    const sim = createSim(0xed0a)
    run(sim, 60)
    /* There is no rename in the API: a name is the key the object is stored
     * under and what every reference points at. */
    for (const [kind, ns, name] of [
      ['net.service', 'shop', 'web'],
      ['deployment', 'shop', 'web'],
      ['node', '', 'node-1'],
    ] as const) {
      const r = sim.editObject(kind, ns, name, 'metadata.name', 'renamed')
      expect(r.outcome, kind).toBe('immutable')
      /* kubectl's own words, refused on the client before anything is sent —
       * a different refusal from the API server's "field is immutable". */
      expect(r.message, kind).toContain('At least one of apiVersion, kind and name was changed')
    }
    expect(sim.state.services.some((v) => v.name === 'web')).toBe(true)
    expect(sim.state.services.some((v) => v.name === 'renamed')).toBe(false)

    /* Namespace, uid, apiVersion and kind are the same claim about identity. */
    expect(sim.editObject('net.service', 'shop', 'web', 'metadata.namespace', 'other').outcome).toBe('immutable')
    expect(sim.editObject('net.service', 'shop', 'web', 'kind', 'Ingress').outcome).toBe('immutable')
  })

  it('refuses to shrink a PersistentVolumeClaim', () => {
    const sim = createSim(0xed07)
    run(sim, 90)
    const claim = sim.state.pvcs[0]
    expect(claim).toBeDefined()
    const r = sim.editObject('storage.pvc', claim.namespace, claim.name, 'spec.resources.requests.storage', claim.requestGib - 1)
    /*
     * `invalid`, not `immutable`, and the distinction is the point: the field
     * *is* mutable — a claim can grow. Shrinking is a rejected value, which is
     * why the apiserver answers "field can not be less than previous value"
     * rather than "field is immutable".
     */
    expect(r.outcome).toBe('invalid')
    expect(r.message).toContain('may not be shrunk')
  })
})

describe('an edit is a real write, not a shortcut', () => {
  it('cannot commit while etcd has lost quorum', () => {
    const sim = createSim(0xed08)
    run(sim, 60)
    const d = sim.state.deployments.find((x) => x.name === 'web')!
    const was = d.replicas

    sim.setKnob('etcdMembersDown', 2)
    run(sim, 10)
    /* The request is accepted at the door and then cannot reach storage. */
    expect(sim.editObject('deployment', 'shop', 'web', 'spec.replicas', was + 3).outcome).toBe('applied')
    run(sim, 20)
    expect(d.replicas).toBe(was)

    sim.setKnob('etcdMembersDown', 0)
    run(sim, 20)
    sim.editObject('deployment', 'shop', 'web', 'spec.replicas', was + 3)
    run(sim, 20)
    expect(d.replicas).toBe(was + 3)
  })

  it('reports honestly for objects and fields it does not have', () => {
    const sim = createSim(0xed09)
    run(sim, 30)
    expect(sim.editObject('deployment', 'shop', 'nope', 'spec.replicas', 3).outcome).toBe('notfound')
    expect(sim.editObject('deployment', 'shop', 'web', 'spec.nonsense', 3).outcome).toBe('unsupported')
    expect(sim.editObject('deployment', 'shop', 'web', 'spec.replicas', 'abc').outcome).toBe('invalid')
  })
})
