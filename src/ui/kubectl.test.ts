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
  it('scale patches spec.replicas through the edit path, not the knob', () => {
    const { env } = envAt(30)
    const r = runKubectl('scale deployment/web --replicas=5', env)
    /* The knob had no API pipeline behind it. Going through `edit` is what
     * makes a scale a real write — refusable, and impossible without quorum. */
    expect(r.intents).toContainEqual({
      kind: 'edit',
      resource: 'deployment',
      namespace: 'shop',
      name: 'web',
      path: 'spec.replicas',
      value: 5,
    })
    expect(r.lines.some((l) => l.text.includes('scaled'))).toBe(true)
  })

  it('scales any Deployment that exists, not only the demo one', () => {
    const { env, sim } = envAt(30)
    const other = sim.state.deployments.find((d) => d.name !== 'web')
    if (!other) return
    const r = runKubectl(`scale deployment/${other.name} --replicas=2`, env)
    /* The old restriction to deployment/web was an artefact of routing scale
     * through a single knob; nothing about the cluster required it. */
    expect(r.intents.some((i) => i.kind === 'edit' && i.name === other.name)).toBe(true)
    expect(r.lines[0].cls).not.toBe('err')
  })

  it('cordon and uncordon patch spec.unschedulable on a real node', () => {
    const { env, sim } = envAt(30)
    const node = sim.state.nodes.find((n) => n.present)!
    const on = runKubectl(`cordon ${node.name}`, env)
    expect(on.intents).toContainEqual({
      kind: 'edit',
      resource: 'node',
      namespace: '',
      name: node.name,
      path: 'spec.unschedulable',
      value: true,
    })
    /* The distinction that makes cordon worth a command of its own. */
    expect(on.lines.some((l) => l.text.includes('not drain'))).toBe(true)

    const off = runKubectl(`uncordon ${node.name}`, env)
    expect(off.intents.some((i) => i.kind === 'edit' && i.value === false)).toBe(true)
    expect(runKubectl('cordon no-such-node', env).lines[0].cls).toBe('err')
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

  it('delete node removes the last machine, and only the last', () => {
    const { env, sim } = envAt(60)
    const present = sim.state.nodes.filter((n) => n.present)
    const last = present[present.length - 1]
    const notLast = present[0]

    const bad = runKubectl(`delete node ${notLast.name}`, env)
    expect(bad.lines[0].cls).toBe('err')
    expect(bad.intents).toEqual([])

    const good = runKubectl(`delete node ${last.name}`, env)
    expect(good.intents).toContainEqual({ kind: 'knob', key: 'nodeCount', value: present.length - 1 })
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
