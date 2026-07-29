import type { Knobs } from '../core/types'

/* ============================================================================
 * Which knobs belong to which mechanism.
 *
 * Reading about `requests` and then hunting the rail for the slider that
 * changes them is busywork: the control belongs on the thing it controls. This
 * table is the only place that says so, and the inspector renders the real knob
 * specs from src/ui/controls.ts rather than describing them a second time.
 *
 * Ids are matched longest-prefix-first, so `pod.resources` wins over `pod` and
 * a district can be given a default without every entry restating it.
 * ==========================================================================*/

type Keys = readonly (keyof Knobs)[]

const RESOURCES: Keys = ['requestCpuMilli', 'limitCpuMilli', 'requestMemMib', 'limitMemMib']

const MAP: readonly (readonly [string, Keys])[] = [
  /* Workload shape. */
  ['pod.resources', RESOURCES],
  ['pod.qos', RESOURCES],
  ['pod.oom', ['limitMemMib', 'memoryLeak']],
  ['pod.throttle', ['limitCpuMilli', 'requestCpuMilli']],
  ['pod.probes', ['readinessPeriodSeconds', 'livenessPeriodSeconds', 'probeFailureThreshold']],
  ['pod.crashloop', ['crashLoop']],
  ['pod.imagepull', ['imagePullSeconds', 'imagePullFailure']],
  ['pod.desired', ['replicas']],
  ['pod.pending', ['replicas', 'requestCpuMilli', 'nodeCount']],
  ['pod.revision', ['maxSurge', 'maxUnavailable']],
  ['pod', ['replicas']],

  /* The records that produce pods. */
  ['deployment', ['replicas', 'maxSurge', 'maxUnavailable']],
  ['replicaset', ['replicas']],
  ['hpa', ['hpaEnabled', 'hpaTargetUtilization', 'hpaMinReplicas', 'hpaMaxReplicas']],

  /* Machines. */
  ['node-', ['nodeCount', 'nodeDown']],
  ['node.', ['nodeCount', 'nodeDown']],
  ['node', ['nodeCount', 'nodeDown']],

  /* Control plane. */
  ['etcd', ['etcdMembersDown', 'etcdFsyncMs']],
  ['api.webhook', ['webhookReachable', 'webhookLatencyMs']],
  ['api.mutating', ['webhookReachable', 'webhookLatencyMs']],
  ['api.validating', ['webhookReachable', 'webhookLatencyMs']],
  ['scheduler', ['podAntiAffinity', 'nodeCount']],

  /* Traffic and policy. */
  ['net.ingress', ['trafficRps']],
  ['net.external', ['trafficRps']],
  ['net.networkpolicy', ['networkPolicyEnabled']],
  ['net.service', ['replicas']],

  /* Storage. */
  ['storage', ['replicas']],
] as const

/* Longest prefix first, so the specific entry always beats the district default. */
const ORDERED = [...MAP].sort((a, b) => b[0].length - a[0].length)

/** Knobs the given component owns, most specific match wins. Empty if none. */
export function knobsFor(entryId: string): Keys {
  for (let i = 0; i < ORDERED.length; i++) {
    if (entryId === ORDERED[i][0] || entryId.startsWith(ORDERED[i][0])) return ORDERED[i][1]
  }
  return []
}
