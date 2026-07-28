# CLAUDE.md — K8Skylines

## Project

K8Skylines is an explorable 3D city that teaches how Kubernetes works. The
buildings and motion represent real mechanisms; the numbers are deliberately
scaled so people can see those mechanisms operate. The city is a model, not an
emulator, and no Kubernetes source code runs here.

Use **K8Skylines** in prose and headings and `k8skylines` for package-style
names. The seed brief the project answers is [`PROMPT.md`](PROMPT.md); read it
before making a design decision, because most arguments about scope are already
settled there.

The intended reader is technically capable but may have never operated a
cluster. Explain Kubernetes precisely without assuming operator vocabulary, and
disclose every simplification that could change the lesson.

## Architecture

The application is a static browser bundle with five layers:

```text
src/
  core/      shared contracts, event bus, registry, theme, utilities
  sim/       pure TypeScript Kubernetes model
  world/     three.js city geometry, one module per district
  engine/    renderer, camera, flows, labels, picking
  ui/        HUD, controls, inspector, search, help, guided tour
```

- `src/core/types.ts` defines `SimState`, the contract between simulation and
  presentation.
- `src/sim` never imports three.js. It owns and mutates simulation state.
- `src/world` may read `SimState` but never mutates it. To change the cluster,
  a district emits an intent on the bus and the simulation decides.
- `src/world/layout.ts` is the single source of truth for geography. Shared
  anchors, district bounds, node grid helpers, and routes belong there.
- `src/world/module.ts` defines `WorldModule` / `WorldCtx`, the shape every
  district has. `main.ts` composes them and owns the frame order.
- `src/engine` turns state and world geometry into an interactive scene.
- `src/ui` explains and exposes state; it does not become a second simulation.

The browser debugging surface is `window.K8SKYLINES`: `sim`, `registry`, `bus`,
`rig`, `gfx`, `flows`.

## Stack

- TypeScript in strict mode, targeting ES2022
- three.js r185 for 3D and WebGL2
- Vite for development and the static production bundle
- Vitest for deterministic unit tests
- Node.js 20 or newer

three.js is the only bundled runtime dependency. Modules from
`three/examples/jsm` ship with three and are not a new dependency. No framework,
CDN resource, remote font, telemetry service, or analytics provider may be
added. The shipped application is a static site with no application server and
makes no network calls.

## Style rules

### TypeScript and comments

- Keep TypeScript strict and make state ownership visible in types.
- Preserve the `sim` / `world` boundary. Convenience is not a reason to import
  three.js into the model or to mutate the model from a building.
- Per-frame paths must allocate nothing. Reuse vectors, colours, arrays, scratch
  objects, and materials rather than creating garbage in animation loops.
  Prefer `InstancedMesh` above roughly forty copies of one shape.
- Materials come from `src/core/theme.ts` and are shared. A district must never
  dispose one.
- Comments state what the code cannot: a constraint, a non-obvious invariant, or
  a performance hazard. Do not narrate the next line. One to three lines.

### Kubernetes language and units

- Use the API's own vocabulary exactly. A `phase` is a Pod phase; `conditions`
  are the real condition set; reason strings are the ones `kubectl` prints
  (`CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`, `FailedScheduling`).
- Binary units, spelled the way Kubernetes spells them: `250m`, `512Mi`, `2Gi`.
  Never `MB` for `Mi`.
- **Requests schedule, limits kill.** Never let a control, a gauge, or a caption
  blur requested, allocatable, capacity, and used. Conflating them is the most
  common misunderstanding this project exists to fix.
- `Pending` is a scheduler verdict with a reason, never "queued".
- A Service is a replicated rule table, not a process. A Deployment does not run
  anything. Say so wherever the geometry could imply otherwise.
- Kubernetes claims in geometry, animation, metrics, and prose require the same
  technical review. A caption cannot correct a misleading building.
- Write docs for a reader arriving today. Historical narration belongs in
  `CHANGELOG.md`.

### Visual language

- At night, structure is matte through `mat()` and meaning is neon through
  `neon()`.
- Only emissive intensity above 1.0 crosses the bloom threshold. Glow therefore
  carries information and is never decoration.
- Day mode is intentionally different: saturated hue and value carry meaning
  without relying on bloom.
- **Desired state is `ghost()`, actual state is matter.** This is the project's
  central visual claim and no district may invert it.
- Colour is semantic across districts. Do not reuse a mechanism's colour merely
  because it looks good. If a new building needs a colour, it needs a meaning
  first.
- Judge visible work at the scale and camera angle a user will encounter.
  Review screenshots, not only source coordinates.

## Key design rules

1. **The architecture boundary is hard.** `sim` owns state, `world` presents it,
   and both meet at `SimState`.
2. **Geography has one owner.** Cross-district positions and routes live in
   `src/world/layout.ts`.
3. **The model must be honest.** Preserve real algorithms and defaults, scale
   only what is necessary for observation, and state material simplifications
   in the Explainer's `caveats`.
4. **Meaning controls appearance.** Decorative bloom is forbidden.
5. **Frame loops allocate nothing.**
6. **Code must be wired.** An unimported subsystem is not delivered.
7. **Geometry must be reviewed as content.** A building can teach a falsehood
   more persuasively than nearby text teaches the truth.
8. **Everything visible is registered.** A mechanism with no `Explainer` is
   decoration, and decoration is a bug.

## Testing

Tests assert behaviour and properties, not existence. A test that merely finds a
symbol cannot prove it is wired or correct. Use the seeded `Rng` from
`src/core/util.ts`; never depend on wall-clock timing, unseeded randomness, a
browser, or a GPU when the underlying claim is pure.

Pin the formulas that must not drift: the CrashLoopBackOff doubling sequence and
its 300 s cap, QoS classification from requests and limits, scheduling fit
against allocatable minus requests, `maxUnavailable` during a rolling update,
HPA utilisation computed against requests, quorum as `floor(n/2)+1`, and the
monotonicity of the etcd revision.

Every bug fix starts with the smallest deterministic test that reproduces it.
Run it, confirm it fails for the expected reason, then fix it. Do not weaken an
assertion to accommodate a bug.

## Before handing off

Run all three:

```bash
npm test
npm run typecheck
npm run build
```

Then exercise visible changes in a browser and read the resulting screenshots. A
successful render command is not visual verification. Verify that new code is
imported, constructed, and called — presence is not delivery.

## Copyright

Apache-2.0. Keep `NOTICE` with distributions.

Kubernetes is a registered trademark of The Linux Foundation. Never imply that
K8Skylines is affiliated with, sponsored by, or endorsed by The Linux
Foundation, the Cloud Native Computing Foundation, or the Kubernetes project.
Preserve third-party copyright and licence notices.
