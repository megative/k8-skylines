/* ============================================================================
 * Where to read the real thing.
 *
 * This city is a model, and the honest end of every explanation is a pointer to
 * the documentation it was built from. The link is the reader's exit: when they
 * want the API fields, the defaults we scaled, or the parts we left out, they
 * should not have to guess the search term.
 *
 * Ids are matched longest-prefix-first, so a specific mechanism beats the
 * district it belongs to. Only kubernetes.io is linked — no blogs, no vendors.
 *
 * The city's own scenery — the excavation, the roads, the sky — deliberately has
 * no entry. Those are how this model is drawn, not things Kubernetes documents,
 * and inventing a link for them would be the one dishonest thing this file could
 * do.
 * ==========================================================================*/

const K = 'https://kubernetes.io/docs/'

const MAP: readonly (readonly [string, string, string])[] = [
  /* [explainer id prefix, url, link text] */

  /* Workloads. */
  ['pod.probes', `${K}tasks/configure-pod-container/configure-liveness-readiness-startup-probes/`, 'Liveness, readiness and startup probes'],
  ['pod.resources', `${K}concepts/configuration/manage-resources-containers/`, 'Resource management for pods and containers'],
  ['pod.qos', `${K}concepts/workloads/pods/pod-qos/`, 'Pod quality of service classes'],
  ['pod.oom', `${K}concepts/configuration/manage-resources-containers/#how-pods-with-resource-limits-are-run`, 'How pods with resource limits are run'],
  ['pod.throttle', `${K}concepts/configuration/manage-resources-containers/#how-pods-with-resource-limits-are-run`, 'CPU limits and throttling'],
  ['pod.crashloop', `${K}concepts/workloads/pods/pod-lifecycle/#restart-policy`, 'Pod lifecycle: restart policy'],
  ['pod.imagepull', `${K}concepts/containers/images/`, 'Images and pull policy'],
  ['pod.init', `${K}concepts/workloads/pods/init-containers/`, 'Init containers'],
  ['pod.sidecar', `${K}concepts/workloads/pods/sidecar-containers/`, 'Sidecar containers'],
  ['pod.sandbox', `${K}concepts/workloads/pods/#pod-networking`, 'Pod networking and the shared namespace'],
  ['pod.netns', `${K}concepts/workloads/pods/#pod-networking`, 'Pod networking and the shared namespace'],
  ['pod.conditions', `${K}concepts/workloads/pods/pod-lifecycle/#pod-conditions`, 'Pod conditions'],
  ['pod.termination', `${K}concepts/workloads/pods/pod-lifecycle/#pod-termination`, 'Pod termination'],
  ['pod.owner', `${K}concepts/overview/working-with-objects/owners-dependents/`, 'Owners and dependents'],
  ['pod.pending', `${K}concepts/scheduling-eviction/kube-scheduler/`, 'kube-scheduler'],
  ['pod', `${K}concepts/workloads/pods/`, 'Pods'],

  ['deployment', `${K}concepts/workloads/controllers/deployment/`, 'Deployments'],
  ['replicaset', `${K}concepts/workloads/controllers/replicaset/`, 'ReplicaSets'],
  ['statefulset', `${K}concepts/workloads/controllers/statefulset/`, 'StatefulSets'],
  ['daemonset', `${K}concepts/workloads/controllers/daemonset/`, 'DaemonSets'],
  ['cronjob', `${K}concepts/workloads/controllers/cron-jobs/`, 'CronJobs'],
  ['job', `${K}concepts/workloads/controllers/job/`, 'Jobs'],
  ['hpa', `${K}tasks/run-application/horizontal-pod-autoscale/`, 'Horizontal pod autoscaling'],

  /* Scheduling and nodes. */
  ['scheduler', `${K}concepts/scheduling-eviction/kube-scheduler/`, 'kube-scheduler'],
  ['node.taint', `${K}concepts/scheduling-eviction/taint-and-toleration/`, 'Taints and tolerations'],
  ['node.evict', `${K}concepts/scheduling-eviction/node-pressure-eviction/`, 'Node-pressure eviction'],
  ['node.kubelet', `${K}reference/command-line-tools-reference/kubelet/`, 'kubelet'],
  ['node.lease', `${K}concepts/architecture/leases/`, 'Leases'],
  ['node.proxy', `${K}reference/command-line-tools-reference/kube-proxy/`, 'kube-proxy'],
  ['node.runtime', `${K}concepts/architecture/cri/`, 'Container runtime interface'],
  ['node.cni', `${K}concepts/extend-kubernetes/compute-storage-net/network-plugins/`, 'Network plugins'],
  ['node.csi', `${K}concepts/storage/volumes/#csi`, 'CSI volumes'],
  ['node', `${K}concepts/architecture/nodes/`, 'Nodes'],

  /* Control plane. */
  ['etcd', `${K}tasks/administer-cluster/configure-upgrade-etcd/`, 'Operating etcd'],
  ['api.authz', `${K}reference/access-authn-authz/rbac/`, 'RBAC authorization'],
  ['api.authn', `${K}reference/access-authn-authz/authentication/`, 'Authenticating'],
  ['api.apf', `${K}concepts/cluster-administration/flow-control/`, 'API priority and fairness'],
  ['api.mutating', `${K}reference/access-authn-authz/admission-controllers/`, 'Admission controllers'],
  ['api.validating', `${K}reference/access-authn-authz/admission-controllers/`, 'Admission controllers'],
  ['api.webhook', `${K}reference/access-authn-authz/extensible-admission-controllers/`, 'Dynamic admission control'],
  ['api.watch', `${K}reference/using-api/api-concepts/#efficient-detection-of-changes`, 'Watches and efficient change detection'],
  ['api', `${K}concepts/overview/kubernetes-api/`, 'The Kubernetes API'],

  ['controllers.reconcile-loop', `${K}concepts/architecture/controller/`, 'Controllers'],
  ['controllers.leader-election', `${K}concepts/architecture/leases/#leader-election`, 'Leader election'],
  ['controllers', `${K}concepts/architecture/controller/`, 'Controllers'],
  ['endpointslice', `${K}concepts/services-networking/endpoint-slices/`, 'EndpointSlices'],
  ['pv-binder', `${K}concepts/storage/persistent-volumes/#binding`, 'Binding persistent volumes'],
  ['garbage-collector', `${K}concepts/architecture/garbage-collection/`, 'Garbage collection'],
  ['namespace', `${K}concepts/overview/working-with-objects/namespaces/`, 'Namespaces'],
  ['serviceaccount', `${K}concepts/security/service-accounts/`, 'Service accounts'],

  /* Networking. */
  ['net.ingress-controller', `${K}concepts/services-networking/ingress-controllers/`, 'Ingress controllers'],
  ['net.ingress', `${K}concepts/services-networking/ingress/`, 'Ingress'],
  ['net.tls', `${K}concepts/services-networking/ingress/#tls`, 'Ingress TLS'],
  ['net.endpointslice', `${K}concepts/services-networking/endpoint-slices/`, 'EndpointSlices'],
  ['net.kube-proxy', `${K}reference/command-line-tools-reference/kube-proxy/`, 'kube-proxy'],
  ['net.clusterip-rule-table', `${K}concepts/services-networking/service/#virtual-ips-and-service-proxies`, 'Virtual IPs and service proxies'],
  ['net.service.headless', `${K}concepts/services-networking/service/#headless-services`, 'Headless services'],
  ['net.service.nodeport', `${K}concepts/services-networking/service/#type-nodeport`, 'Services of type NodePort'],
  ['net.service.loadbalancer', `${K}concepts/services-networking/service/#loadbalancer`, 'Services of type LoadBalancer'],
  ['net.service', `${K}concepts/services-networking/service/`, 'Services'],
  ['net.coredns', `${K}concepts/services-networking/dns-pod-service/`, 'DNS for services and pods'],
  ['net.ndots', `${K}concepts/services-networking/dns-pod-service/#pod-dns-config`, 'Pod DNS config and ndots'],
  ['net.networkpolicy', `${K}concepts/services-networking/network-policies/`, 'Network policies'],
  ['net', `${K}concepts/services-networking/`, 'Services, load balancing and networking'],

  /* Storage. */
  ['storage.storageclass', `${K}concepts/storage/storage-classes/`, 'Storage classes'],
  ['storage.dynamic-provisioning', `${K}concepts/storage/dynamic-provisioning/`, 'Dynamic volume provisioning'],
  ['storage.wait-for-first-consumer', `${K}concepts/storage/storage-classes/#volume-binding-mode`, 'Volume binding mode'],
  ['storage.access-modes', `${K}concepts/storage/persistent-volumes/#access-modes`, 'Persistent volume access modes'],
  ['storage.reclaim-policy', `${K}concepts/storage/persistent-volumes/#reclaiming`, 'Reclaiming persistent volumes'],
  ['storage.csi', `${K}concepts/storage/volumes/#csi`, 'CSI volumes'],
  ['storage', `${K}concepts/storage/persistent-volumes/`, 'Persistent volumes'],

  /* Images. */
  ['registry', `${K}concepts/containers/images/`, 'Images'],
  ['image', `${K}concepts/containers/images/`, 'Images'],

  /* Disruption. */
  ['pdb', `${K}concepts/workloads/pods/disruptions/`, 'Disruptions'],
] as const

const ORDERED = [...MAP].sort((a, b) => b[0].length - a[0].length)

export interface DocLink {
  url: string
  text: string
}

/** The kubernetes.io page this mechanism is modelled from, if there is one. */
export function docsFor(entryId: string): DocLink | undefined {
  for (let i = 0; i < ORDERED.length; i++) {
    const [prefix, url, text] = ORDERED[i]
    if (entryId === prefix || entryId.startsWith(prefix)) return { url, text }
  }
  return undefined
}
