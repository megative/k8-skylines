# Roadmap

What is being worked on, what is known to be wrong, and what is deliberately not
being done. K8Skylines is **0.x**: early and moving.

## The accuracy boundary

K8Skylines is a *model*, not an emulator. No Kubernetes source code runs here.
Counts are scaled so a human can watch a mechanism operate — four nodes, twelve
pod plots per node, three etcd members — where a real cluster has thousands.
Real algorithms and real defaults are preserved wherever the lesson depends on
them; `TIMING` in `src/core/types.ts` holds the upstream defaults verbatim.

Every simplification that could change the lesson belongs in the `caveats` of
the relevant `Explainer`, where the reader meets it, not in a footnote here.

## Now

- Land the first complete city: control plane, node grid, pods, network edge,
  storage, registry, and the guided tour.
- Get the desired-versus-actual ghost animation right. It is the project's
  central claim and everything else is subordinate to it.
- Screenshot review of every district at the establishing shot, at orbit
  distance, and on foot. Geometry is reviewed as content, not as source.

## Next

- **Failure curriculum.** Broaden the scenario set until every pathology an
  on-call engineer actually meets has a button: disk pressure eviction,
  certificate expiry, a stuck finalizer, DNS `ndots` pathology, a wedged
  StatefulSet ordinal, and cascading eviction.
- **Read a real cluster.** An opt-in mode that reads an actual cluster's objects
  and drives the city from them, clearly labelled so modelled behaviour and
  observed behaviour are never confused. Read-only, and never in the critical
  path of the modelled city.
- **Scale honesty.** A visual treatment for "this is a sample" so the four-node
  grid does not imply that clusters are small.
- **Accessibility.** Keyboard-only traversal of every mechanism, and a text
  surface that carries the same lesson without the 3D scene.
- **Mobile.** Touch controls exist but are under-tested on real hardware.

## Known limitations

- The node grid is four blocks. Topology spread, zones, and rack awareness have
  no room to be shown honestly at that size.
- The scheduler models one profile and one queue sort. Real scheduling
  frameworks are pluggable at far more extension points than are drawn.
- Networking is modelled at the level of Services, EndpointSlices, and rule
  tables. Actual packet paths, conntrack, and MTU issues are out of scope.
- The container runtime is modelled through CRI's observable states. Snapshotter
  internals, cgroup hierarchies, and OCI runtime details are not drawn.
- Multi-cluster, federation, and operators/CRDs are absent. The reconcile-loop
  district is the right home for CRDs and controller-runtime when they land.

## Deliberately not doing

- **Not an emulator.** Running real Kubernetes in the browser would replace a
  teachable model with an opaque one.
- **No framework.** three.js stays the only bundled runtime dependency.
- **No analytics, no telemetry, no cookies, no network calls.** The bundle is
  static and works offline.
- **No vendor-specific distributions.** The city models upstream Kubernetes. A
  managed provider's control plane is exactly the part it hides.
- **No benchmark claims.** The numbers are scaled for observation and must never
  be read as performance data.

## Corrections

Corrections from people who operate clusters are exactly what this needs. A
building that teaches something false is a bug of the highest severity — file it
as one.
