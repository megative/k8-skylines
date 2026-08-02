import type { RouteId } from './layout'

/* ============================================================================
 * NAMED PATHS — the end-to-end journeys worth following.
 *
 * The city shows every mechanism at once, which is honest but unreadable: a
 * first-time reader cannot tell what goes where. A path is one causal chain,
 * written down as an ordered list of hops, so it can be isolated in the scene
 * and stepped through one hop at a time.
 *
 * A hop names the route travelled to reach it (geography stays owned by
 * layout.ts) and the Explainer it lands on, so nothing here duplicates a
 * position or a lesson that already exists elsewhere.
 * ==========================================================================*/

export interface PathHop {
  /** The route travelled to arrive here. Absent when the hop is stationary —
   *  work happening in one place, like a raft commit or a container start. */
  route?: RouteId
  /** Explainer framed and opened while this hop is current. */
  focus: string
  /** Short label for the step list. */
  title: string
  /** One sentence: what actually happens at this hop. */
  detail: string
}

export interface FlowPath {
  id: string
  title: string
  /** One line for the picker: what question this path answers. */
  blurb: string
  hops: readonly PathHop[]
}

export const PATHS: readonly FlowPath[] = [
  {
    id: 'create-pod',
    title: 'How a Pod gets created',
    blurb: 'One `kubectl apply`, followed from the front door to a running container.',
    hops: [
      {
        route: 'client-to-api',
        focus: 'ground.cluster-boundary',
        title: 'kubectl reaches the one door',
        detail:
          'The request arrives at the kube-apiserver HTTPS endpoint. Nothing else in the cluster is addressable from outside.',
      },
      {
        focus: 'api.stage.authn',
        title: 'Authenticated, then authorised',
        detail:
          'TLS terminates, an authenticator gives the request an identity, and only then does RBAC decide whether that identity may create a Deployment.',
      },
      {
        focus: 'api.stage.mutating',
        title: 'Admission may rewrite or refuse it',
        detail:
          'Mutating webhooks run first and can edit the object; validating webhooks then get a veto. Every matching write pays this latency.',
      },
      {
        route: 'api-to-etcd',
        focus: 'etcd-raft-log',
        title: 'The write goes to raft',
        detail:
          'The API server does not own storage. The object becomes a raft entry that a majority of etcd members must acknowledge.',
      },
      {
        focus: 'etcd-quorum',
        title: 'A majority commits it',
        detail:
          'Only once floor(n/2)+1 members have the entry is it committed and applied. Lose quorum and every write stops here.',
      },
      {
        route: 'etcd-to-api',
        focus: 'api.watch-cache',
        title: 'The watch cache learns about it',
        detail:
          'The API server serves watches from its own cache of committed revisions — controllers never read etcd directly.',
      },
      {
        route: 'api-to-controllers',
        focus: 'controllers.deployment',
        title: 'The Deployment controller notices',
        detail:
          'A watch event wakes the controller. It compares desired against actual and finds no ReplicaSet for this revision.',
      },
      {
        route: 'controllers-to-api',
        focus: 'controllers.replicaset',
        title: 'It writes a ReplicaSet, which writes Pods',
        detail:
          'The controller creates an object, not a container. The ReplicaSet controller then creates Pod objects with no nodeName — still only records.',
      },
      {
        route: 'api-to-scheduler',
        focus: 'pod.pending',
        title: 'An unscheduled Pod is Pending',
        detail:
          'Pending is a scheduler verdict, never a queue. The pod exists in the API and nothing is running yet.',
      },
      {
        focus: 'scheduler-filter',
        title: 'Filter, then score',
        detail:
          'Nodes that cannot fit are filtered out — requests against allocatable, taints, affinity — and the survivors are scored.',
      },
      {
        route: 'scheduler-to-api',
        focus: 'scheduler-bind',
        title: 'The scheduler binds by writing',
        detail:
          'Binding is a POST that sets spec.nodeName. The scheduler never contacts the node; it only writes to the API server.',
      },
      {
        route: 'api-to-nodes',
        focus: 'node-kubelet',
        title: 'The kubelet pulls the work down',
        detail:
          'Each kubelet watches for pods with its own nodeName. Nothing in the control plane ever pushes to a node.',
      },
      {
        focus: 'node-cri',
        title: 'The runtime makes it real',
        detail:
          'kubelet asks containerd over CRI to pull the image, create a sandbox, and start the containers. Only now does matter exist.',
      },
    ],
  },
  {
    id: 'user-request',
    title: 'How a user request reaches a Pod',
    blurb: 'From the outside world, through a door, to a container that answers.',
    hops: [
      {
        route: 'external-to-ingress',
        focus: 'net.external-clients',
        title: 'A user outside the cluster',
        detail:
          'Traffic arrives at one of two independent doors: the Ingress on its hostname, or a LoadBalancer Service on its own external IP.',
      },
      {
        focus: 'net.ingress',
        title: 'The Ingress matches host and path',
        detail:
          'An Ingress is a rule table read by a controller. The controller — an ordinary pod — is what actually terminates the connection.',
      },
      {
        route: 'ingress-to-svc-web',
        focus: 'net.service',
        title: 'The rule names a Service, and the traffic goes there',
        detail:
          'A Service is not a process. It is a stable virtual IP whose EndpointSlice lists only the pods that pass their readiness probe.',
      },
      {
        route: 'svc-web-to-node-0',
        focus: 'net.clusterip-rule-table',
        title: 'Rule tables on every node do the work',
        detail:
          'kube-proxy programmes the same rules on every node, so the hop from virtual IP to pod IP happens locally, with no central proxy.',
      },
      {
        focus: 'pod',
        title: 'The container answers',
        detail:
          'The request lands on a container that is Ready. Readiness controls traffic; it never restarts anything.',
      },
    ],
  },
  {
    id: 'node-heartbeat',
    title: 'How the control plane knows a node is alive',
    blurb: 'The Lease that decides when a machine is declared NotReady.',
    hops: [
      {
        focus: 'node-kubelet-lease',
        title: 'The kubelet renews a Lease',
        detail:
          'Every 10 seconds the kubelet writes a Lease object. That write is the only evidence the control plane has that the machine exists.',
      },
      {
        route: 'nodes-to-api',
        focus: 'api.tower',
        title: 'It is an ordinary API write',
        detail:
          'The heartbeat goes through the same pipeline as everything else, so a broken API server makes every node look unreachable.',
      },
      {
        focus: 'controllers.reconcile-loop',
        title: 'The node controller watches the clock',
        detail:
          'After 40 seconds without a renewal the node is marked NotReady and tainted. Its pods are only evicted 300 seconds later.',
      },
    ],
  },
  {
    id: 'image-pull',
    title: 'Where the image comes from',
    blurb: 'Why the second pod on a node starts faster than the first.',
    hops: [
      {
        focus: 'registry.image',
        title: 'An image is layers in a registry',
        detail:
          'The reference in the pod spec names a manifest, which names layers. Nothing is fetched until a kubelet asks for it.',
      },
      {
        route: 'registry-to-nodes',
        focus: 'registry.pull',
        title: 'The node pulls what it lacks',
        detail:
          'The pull happens node by node, not cluster-wide, and only for layers that node does not already have.',
      },
      {
        focus: 'node-image-cache',
        title: 'The cache is per node',
        detail:
          'Once pulled, the layers stay on that machine, so the next pod using the same image skips the pull entirely.',
      },
    ],
  },
  {
    id: 'volume-attach',
    title: 'How a volume reaches a Pod',
    blurb: 'A claim, a volume, and the two-step CSI dance that binds them.',
    hops: [
      {
        focus: 'storage.pvc',
        title: 'A PersistentVolumeClaim asks',
        detail:
          'The claim is a request for storage, not the storage itself. A pod that mounts an unbound claim cannot start.',
      },
      {
        focus: 'storage.dynamic-provisioning',
        title: 'A StorageClass provisions one',
        detail:
          'The provisioner creates a PersistentVolume to satisfy the claim, and the binder marks the pair Bound.',
      },
      {
        route: 'storage-to-nodes',
        focus: 'storage.csi.attach',
        title: 'Attach, then mount',
        detail:
          'CSI attaches the volume to the node, and only then mounts it into the pod. Both steps must finish before a container starts.',
      },
    ],
  },
]

const PATH_BY_ID = new Map<string, FlowPath>(PATHS.map((p) => [p.id, p]))

export function flowPath(id: string): FlowPath | undefined {
  return PATH_BY_ID.get(id)
}
