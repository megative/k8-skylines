import type { PodState, SimState } from '../core/types'
import { formatCpu, formatMem } from '../core/util'

/* ============================================================================
 * The manifest behind the building.
 *
 * Every object in this city corresponds to something you would get back from
 * `kubectl get -o yaml`, and seeing that text next to the geometry is what ties
 * the model to the terminal the reader actually works in.
 *
 * The YAML is built from live SimState, never from a stored template: if the
 * city says a pod is CrashLoopBackOff with three restarts, the manifest says so
 * too, because both read the same object. Fields this model does not simulate
 * are omitted rather than invented — a plausible-looking `resourceVersion` we
 * made up would be the first lie in a project that has none.
 * ==========================================================================*/

/* --------------------------------------------------------------------------
 * A very small YAML writer. Manifests are plain trees: maps, lists, scalars.
 * ------------------------------------------------------------------------*/

type Node = string | number | boolean | Node[] | { [k: string]: Node | undefined }

/** Quote only when YAML would otherwise read the scalar as something else. */
function scalar(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === '') return "''"
  if (/^[A-Za-z0-9._\-/:@]+$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v)) {
    /* A bare word that looks like a number must still be quoted. */
    return /^-?\d+(\.\d+)?$/.test(v) ? `'${v}'` : v
  }
  return `'${v.replace(/'/g, "''")}'`
}

function emit(node: Node, indent: number, out: string[]): void {
  const pad = '  '.repeat(indent)
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item !== null && typeof item === 'object') {
        const lines: string[] = []
        emit(item as Node, indent + 1, lines)
        const first = lines[0] ?? ''
        out.push(`${pad}- ${first.trimStart()}`)
        for (let i = 1; i < lines.length; i++) out.push(lines[i])
      } else {
        out.push(`${pad}- ${scalar(item as string)}`)
      }
    }
    return
  }
  for (const key of Object.keys(node as object)) {
    const v = (node as Record<string, Node | undefined>)[key]
    if (v === undefined) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      out.push(`${pad}${key}:`)
      emit(v, indent + 1, out)
    } else if (v !== null && typeof v === 'object') {
      if (Object.keys(v).length === 0) continue
      out.push(`${pad}${key}:`)
      emit(v, indent + 1, out)
    } else {
      out.push(`${pad}${key}: ${scalar(v)}`)
    }
  }
}

export function yaml(root: Node): string {
  const out: string[] = []
  emit(root, 0, out)
  return out.join('\n')
}

/* --------------------------------------------------------------------------
 * Builders. Each returns the object a reader would most want to see: the one
 * that is doing the interesting thing right now.
 * ------------------------------------------------------------------------*/

/** The pod worth showing: something broken first, then anything running. */
function interestingPod(s: SimState): PodState | undefined {
  let running: PodState | undefined
  for (const p of s.pods.values()) {
    for (const c of p.containers) {
      if (c.reason === 'CrashLoopBackOff' || c.reason === 'OOMKilled' || c.reason === 'ImagePullBackOff') {
        return p
      }
    }
    if (p.phase === 'Pending') return p
    if (!running && p.phase === 'Running') running = p
  }
  return running ?? s.pods.values().next().value
}

/** The Pod object as `kubectl get pod NAME -o yaml` prints it, for one pod. */
export function podManifestByRef(p: PodState): string {
  return yaml({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: p.name,
      namespace: p.namespace,
      labels: p.labels,
      ownerReferences: p.owner
        ? [{ kind: p.owner.kind, name: p.owner.name, controller: p.owner.controller }]
        : [],
    },
    spec: {
      nodeName: p.nodeName,
      priorityClassName: p.priorityClassName,
      nodeSelector: p.nodeSelector,
      tolerations: p.tolerations.map((t) => ({ key: t.key, value: t.value, effect: t.effect })),
      containers: p.containers
        .filter((c) => c.role !== 'init')
        .map((c) => ({
          name: c.name,
          image: c.image,
          resources: {
            requests: { cpu: formatCpu(c.requestCpuMilli), memory: formatMem(c.requestMemMib) },
            limits: { cpu: formatCpu(c.limitCpuMilli), memory: formatMem(c.limitMemMib) },
          },
        })),
      initContainers: p.containers
        .filter((c) => c.role === 'init')
        .map((c) => ({ name: c.name, image: c.image })),
    },
    status: {
      phase: p.phase,
      podIP: p.ip,
      qosClass: p.qos,
      conditions: (Object.keys(p.conditions) as (keyof typeof p.conditions)[]).map((k) => ({
        type: k,
        status: p.conditions[k] ? 'True' : 'False',
      })),
      containerStatuses: p.containers.map((c) => ({
        name: c.name,
        ready: c.ready,
        restartCount: c.restartCount,
        state: { [c.state]: { reason: c.reason } },
      })),
    },
  })
}

function podManifest(s: SimState): string | undefined {
  const p = interestingPod(s)
  if (!p) return undefined
  return podManifestByRef(p)
}

function deploymentManifest(s: SimState): string | undefined {
  const d = s.deployments[0]
  if (!d) return undefined
  const rs = s.replicaSets.find((r) => r.ownerDeployment === d.name)
  return yaml({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: d.name, namespace: d.namespace, generation: d.revision },
    spec: {
      replicas: d.replicas,
      selector: { matchLabels: d.selector },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: d.maxSurge, maxUnavailable: d.maxUnavailable },
      },
      paused: d.paused,
      template: {
        metadata: { labels: rs ? rs.podTemplateLabels : d.selector },
        spec: { containers: rs ? [{ name: 'app', image: rs.image }] : [] },
      },
    },
    status: {
      replicas: d.statusReplicas,
      readyReplicas: d.readyReplicas,
      availableReplicas: d.availableReplicas,
      updatedReplicas: d.updatedReplicas,
      conditions: [
        {
          type: 'Progressing',
          status: d.progressDeadlineExceeded ? 'False' : 'True',
          reason: d.progressDeadlineExceeded
            ? 'ProgressDeadlineExceeded'
            : d.rollingOut
              ? 'ReplicaSetUpdated'
              : 'NewReplicaSetAvailable',
        },
      ],
    },
  })
}

function serviceManifest(s: SimState): string | undefined {
  const v = s.services.find((x) => x.type !== 'Headless') ?? s.services[0]
  if (!v) return undefined
  return yaml({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: v.name, namespace: v.namespace },
    spec: {
      type: v.type === 'Headless' ? 'ClusterIP' : v.type,
      clusterIP: v.type === 'Headless' ? 'None' : v.clusterIp,
      selector: v.selector,
      ports: [{ port: v.port, targetPort: v.targetPort, nodePort: v.nodePort }],
    },
    status: v.externalIp
      ? { loadBalancer: { ingress: [{ ip: v.externalIp }] } }
      : { loadBalancer: {} },
  })
}

function nodeManifest(s: SimState): string | undefined {
  const n = s.nodes.find((x) => x.present)
  if (!n) return undefined
  return yaml({
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: n.name },
    spec: {
      podCIDR: n.podCidr,
      unschedulable: n.unschedulable ? true : undefined,
      taints: n.taints.map((t) => ({ key: t.key, value: t.value, effect: t.effect })),
    },
    status: {
      capacity: {
        cpu: formatCpu(n.capacityCpuMilli),
        memory: formatMem(n.capacityMemMib),
        pods: n.capacityPods,
      },
      allocatable: {
        cpu: formatCpu(n.allocatableCpuMilli),
        memory: formatMem(n.allocatableMemMib),
        pods: n.capacityPods,
      },
      conditions: n.conditions.map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
    },
  })
}

function hpaManifest(s: SimState): string | undefined {
  const h = s.hpas[0]
  if (!h) return undefined
  return yaml({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: h.name, namespace: h.namespace },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: h.targetRef },
      minReplicas: h.minReplicas,
      maxReplicas: h.maxReplicas,
      metrics: [
        {
          type: 'Resource',
          resource: {
            name: h.metric,
            target: { type: 'Utilization', averageUtilization: h.targetUtilization },
          },
        },
      ],
    },
    status: {
      desiredReplicas: h.desiredReplicas,
      currentMetrics: h.unknownMetrics
        ? []
        : [{ type: 'Resource', resource: { name: h.metric, current: { averageUtilization: Math.round(h.currentUtilization) } } }],
    },
  })
}

function ingressManifest(s: SimState): string | undefined {
  const i = s.ingresses[0]
  if (!i) return undefined
  return yaml({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: { name: i.name, namespace: i.namespace },
    spec: {
      ingressClassName: i.className,
      tls: i.tls ? [{ hosts: i.rules.map((r) => r.host) }] : [],
      rules: i.rules.map((r) => ({
        host: r.host,
        http: {
          paths: [
            {
              path: r.path,
              pathType: 'Prefix',
              backend: { service: { name: r.service, port: { number: r.port } } },
            },
          ],
        },
      })),
    },
  })
}

function pvcManifest(s: SimState): string | undefined {
  const c = s.pvcs[0]
  if (!c) return undefined
  return yaml({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: c.name, namespace: c.namespace },
    spec: {
      storageClassName: c.storageClass,
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: `${c.requestGib}Gi` } },
      volumeName: c.boundPv,
    },
    status: { phase: c.phase },
  })
}

/* --------------------------------------------------------------------------
 * Which manifest belongs to which mechanism. Longest prefix wins.
 * ------------------------------------------------------------------------*/

type Builder = (s: SimState) => string | undefined

const MAP: readonly (readonly [string, Builder])[] = [
  ['deployment', deploymentManifest],
  ['replicaset', deploymentManifest],
  ['hpa', hpaManifest],
  ['net.ingress', ingressManifest],
  ['net.service', serviceManifest],
  ['net.clusterip', serviceManifest],
  ['net.endpointslice', serviceManifest],
  ['storage.pvc', pvcManifest],
  ['storage.pv', pvcManifest],
  ['storage', pvcManifest],
  ['node', nodeManifest],
  ['pod', podManifest],
] as const

const ORDERED = [...MAP].sort((a, b) => b[0].length - a[0].length)

/**
 * The manifest for the object this mechanism is about, as `kubectl get -o yaml`
 * would print it. Undefined when the mechanism is not an API object — the
 * excavation and the roads have no manifest, and pretending otherwise would
 * teach that everything in Kubernetes is a resource.
 */
export function hasManifest(entryId: string): boolean {
  for (let i = 0; i < ORDERED.length; i++) {
    const p = ORDERED[i][0]
    if (entryId === p || entryId.startsWith(p)) return true
  }
  return false
}

export function manifestFor(entryId: string, s: SimState): string | undefined {
  for (let i = 0; i < ORDERED.length; i++) {
    const [prefix, build] = ORDERED[i]
    if (entryId === prefix || entryId.startsWith(prefix)) {
      try {
        return build(s)
      } catch {
        return undefined
      }
    }
  }
  return undefined
}
