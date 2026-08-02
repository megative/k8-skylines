import { describe, expect, it } from 'vitest'
import { createSim } from '../sim/model'
import {
  completeKubectl,
  commonPrefix,
  DEFAULT_NAMESPACE,
  runKubectl,
  type KubectlEnv,
} from './kubectl'

/* The console reads the model and nothing else. These pin that it reports what
 * the simulation actually holds, that its writes map to real knobs, and that it
 * refuses to invent answers the model cannot give. */

function envAt(seconds: number): { env: KubectlEnv; sim: ReturnType<typeof createSim> } {
  const sim = createSim(0x0c0ffee)
  for (let i = 0; i < seconds * 10; i++) sim.tick(0.1)
  const env: KubectlEnv = {
    state: () => sim.state,
    explain: (id) => (id === 'pod' ? { summary: 'A pod is a group of containers.', caveats: ['12 plots, not 110.'] } : undefined),
    catalogue: () => sim.applyCatalogue(),
  }
  return { env, sim }
}

function text(r: { lines: { text: string }[] }): string {
  return r.lines.map((l) => l.text).join('\n')
}

describe('kubectl: reading the model', () => {
  it('lists the demo workload in the default namespace', () => {
    const { env, sim } = envAt(60)
    const r = runKubectl('get pods', env)
    const body = text(r)
    expect(r.lines[0].cls).toBe('head')
    expect(r.lines[0].text).toMatch(/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE$/)
    /* Every shop pod the model holds, and nothing from another namespace. */
    const shop = [...sim.state.pods.values()].filter((p) => p.namespace === DEFAULT_NAMESPACE)
    expect(shop.length).toBeGreaterThan(0)
    for (const p of shop) expect(body).toContain(p.name)
    const other = [...sim.state.pods.values()].find((p) => p.namespace !== DEFAULT_NAMESPACE)
    if (other) expect(body).not.toContain(other.name)
  })

  it('adds a NAMESPACE column and every pod under -A', () => {
    const { env, sim } = envAt(60)
    const r = runKubectl('get pods -A', env)
    expect(r.lines[0].text.startsWith('NAMESPACE')).toBe(true)
    for (const p of sim.state.pods.values()) expect(text(r)).toContain(p.name)
  })

  it('reads a count out of the model rather than a template', () => {
    const { env, sim } = envAt(90)
    const rows = text(runKubectl('get deploy', env)).split('\n')
    const web = sim.state.deployments.find((d) => d.name === 'web')!
    const line = rows.find((l) => l.startsWith('web'))!
    expect(line).toContain(`${web.readyReplicas}/${web.replicas}`)
  })

  it('shows one object as YAML, looked up by name', () => {
    const { env, sim } = envAt(90)
    const name = [...sim.state.pods.values()][0].name
    const y = text(runKubectl(`get pod ${name} -o yaml`, env))
    expect(y).toContain('kind: Pod')
    expect(y).toContain(`name: ${name}`)
  })

  it('describe carries the object’s events and frames it in the city', () => {
    const { env, sim } = envAt(120)
    const some = [...sim.state.pods.values()][0]
    const r = runKubectl(`describe pod ${some.name}`, env)
    expect(text(r)).toContain('Events:')
    expect(r.intents).toContainEqual({ kind: 'focus', id: 'pod' })
  })

  it('describe frames the exact node, not the representative one', () => {
    const { env } = envAt(30)
    /* node-2 is index 1, so its own explainer is node-1. */
    const r = runKubectl('describe node node-2', env)
    expect(r.intents).toContainEqual({ kind: 'focus', id: 'node-1' })
  })

  it('explain pulls the city’s own teaching text', () => {
    const { env } = envAt(10)
    const r = runKubectl('explain pods', env)
    const body = text(r)
    expect(body).toContain('KIND:     Pod')
    expect(body).toContain('A pod is a group of containers.')
    expect(body).toContain('12 plots, not 110.')
  })

  it('top nodes reports usage against allocatable', () => {
    const { env, sim } = envAt(60)
    const rows = text(runKubectl('top nodes', env)).split('\n')
    expect(rows[0]).toContain('CPU%')
    const present = sim.state.nodes.filter((n) => n.present)
    expect(rows.length).toBe(present.length + 1)
  })
})

describe('kubectl: changing the model', () => {
  it('scale deployment/web maps to the replicas knob', () => {
    const { env } = envAt(30)
    const r = runKubectl('scale deployment/web --replicas=5', env)
    expect(r.intents).toContainEqual({ kind: 'knob', key: 'replicas', value: 5 })
    expect(r.lines.some((l) => l.text.includes('scaled'))).toBe(true)
  })

  it('refuses to scale a Deployment the model does not make adjustable', () => {
    const { env, sim } = envAt(30)
    const other = sim.state.deployments.find((d) => d.name !== 'web')
    if (!other) return
    const r = runKubectl(`scale deployment/${other.name} --replicas=2`, env)
    expect(r.intents).toEqual([])
    expect(r.lines[0].cls).toBe('err')
  })

  it('really deletes a standalone resource, resolving its namespace', () => {
    const { env, sim } = envAt(60)
    const ing = sim.state.ingresses[0]
    const r = runKubectl(`delete ingress ${ing.name}`, env)
    expect(r.intents).toContainEqual({ kind: 'delete', resource: 'ingress', namespace: ing.namespace, name: ing.name })
    expect(r.lines[0].text).toContain('deleted')
    /* It warns that a standalone object stays gone. */
    expect(r.lines.some((l) => /Reset/.test(l.text))).toBe(true)
  })

  it('deletes a pod and says the controller will bring it back', () => {
    const { env, sim } = envAt(60)
    const name = [...sim.state.pods.values()].find((p) => p.labels.app === 'web')!.name
    const r = runKubectl(`delete pod ${name}`, env)
    expect(r.intents).toContainEqual({ kind: 'delete', resource: 'pod', namespace: 'shop', name })
    expect(r.lines.some((l) => /recreate/.test(l.text))).toBe(true)
  })

  /* A Node is cluster-scoped, so the intent carries no namespace — and the
   * console has to be able to reach the delete path at all, which is the half
   * that is easy to leave unwired. */
  it('deletes a node by name, with no namespace', () => {
    const { env, sim } = envAt(60)
    const name = sim.state.nodes.find((n) => n.present)!.name
    const r = runKubectl(`delete node ${name}`, env)
    expect(r.intents).toContainEqual({ kind: 'delete', resource: 'node', namespace: '', name })
    expect(r.lines[0].cls).not.toBe('err')
  })

  it('errors on a resource with no delete path in the model', () => {
    const { env, sim } = envAt(30)
    const pv = sim.state.pvs[0]
    if (!pv) return
    const r = runKubectl(`delete pv ${pv.name}`, env)
    expect(r.intents).toEqual([])
    expect(r.lines[0].cls).toBe('err')
  })

  it('apply from the catalogue emits an apply intent', () => {
    const { env, sim } = envAt(60)
    const ing = sim.state.ingresses[0].name
    sim.deleteObject('ingress', 'shop', ing)
    for (let i = 0; i < 200; i++) sim.tick(0.1)
    const r = runKubectl(`apply ingress ${ing}`, env)
    expect(r.intents).toContainEqual({ kind: 'apply', resource: 'ingress', name: ing })
    expect(r.lines[0].text).toContain('created')
  })

  it('bare apply lists the catalogue and refuses the unknown', () => {
    const { env } = envAt(30)
    const list = runKubectl('apply', env)
    expect(text(list)).toContain('deployment')
    expect(list.intents).toEqual([])
    const bad = runKubectl('apply deployment not-a-seed', env)
    expect(bad.lines[0].cls).toBe('err')
    expect(bad.intents).toEqual([])
  })

  it('completes apply against the catalogue, not live objects', () => {
    const { sim } = envAt(30)
    const cat = sim.applyCatalogue()
    const c = completeKubectl('apply deployment ', sim.state, cat)
    const depNames = cat.filter((x) => x.kind === 'deployment').map((x) => x.name)
    expect(c.options.sort()).toEqual(depNames.sort())
  })

  /*
   * `delete node` used to refuse any machine but the last and then decrement
   * the Nodes knob instead of deleting anything, because membership was derived
   * from that count. It is a real delete now, through the same API pipeline as
   * every other kind, and any machine in the cluster can be named.
   */
  it('delete node deletes the machine that was named, whichever it is', () => {
    const { env, sim } = envAt(60)
    const present = sim.state.nodes.filter((n) => n.present)
    const notLast = present[0]

    const r = runKubectl(`delete node ${notLast.name}`, env)
    expect(r.lines[0].cls).not.toBe('err')
    expect(r.intents).toContainEqual({ kind: 'delete', resource: 'node', namespace: '', name: notLast.name })
    /* Not a knob change. Scaling the cluster is the other sentence. */
    expect(r.intents.some((i) => i.kind === 'knob')).toBe(false)
  })

  it('refuses a machine that is not in the cluster', () => {
    const { env } = envAt(30)
    const r = runKubectl('delete node node-99', env)
    expect(r.lines[0].cls).toBe('err')
    expect(r.intents).toEqual([])
  })
})

describe('kubectl: honesty at the boundary', () => {
  it('has no logs to stream and says why', () => {
    const { env } = envAt(30)
    const r = runKubectl('logs web-xxxx', env)
    expect(r.lines[0].cls).toBe('err')
    expect(r.lines[0].text).toContain('no logs')
  })

  it('rejects an unknown resource type', () => {
    const { env } = envAt(10)
    const r = runKubectl('get widgets', env)
    expect(r.lines[0].cls).toBe('err')
    expect(r.lines[0].text).toContain('widgets')
  })

  it('rejects an unknown command', () => {
    const { env } = envAt(10)
    expect(runKubectl('frobnicate', env).lines[0].cls).toBe('err')
  })
})

describe('kubectl: completion', () => {
  it('completes a verb from a prefix', () => {
    const { sim } = envAt(10)
    const c = completeKubectl('desc', sim.state)
    expect(c.options).toContain('describe')
  })

  it('completes a resource kind after get', () => {
    const { sim } = envAt(10)
    const c = completeKubectl('get po', sim.state)
    expect(c.options).toContain('pods')
    expect(c.token).toBe('po')
  })

  it('offers live object names once the kind is known', () => {
    const { sim } = envAt(60)
    const c = completeKubectl('get pods ', sim.state)
    const names = [...sim.state.pods.values()].map((p) => p.name)
    /* Every offered name is a real pod, and at least one real pod is offered. */
    expect(c.options.length).toBeGreaterThan(0)
    for (const o of c.options) expect(names).toContain(o)
  })

  it('accepts a kubectl or k prefix', () => {
    const { sim } = envAt(10)
    expect(completeKubectl('kubectl get no', sim.state).options).toContain('nodes')
    expect(completeKubectl('k get no', sim.state).options).toContain('nodes')
  })

  it('common prefix drives inline completion', () => {
    expect(commonPrefix(['nodes', 'namespaces'])).toBe('n')
    expect(commonPrefix(['pods'])).toBe('pods')
  })
})
