# AGENTS.md

Read and follow [`CLAUDE.md`](CLAUDE.md) before changing this repository. It is
the source of truth for architecture, style, testing, visual accuracy, and
delivery rules. [`PROMPT.md`](PROMPT.md) is the design brief the project answers.

## Workflow

- Do not commit or push. Leave the working tree for the project owner.
- Preserve unrelated changes. Several agents may be working in this tree at
  once, on different files.
- Install with `npm install`. Run the development server with `npm run dev` at
  `http://localhost:5173/`; reuse an existing server rather than starting a
  competing process. Vite preview uses port 4173.
- Run `npm test`, `npm run typecheck`, and `npm run build` before handoff.
  During TDD, `npm run test:watch` is the fast loop.

## File ownership

These files are contracts that everything else depends on. Do not edit them as a
side effect of feature work; changing one is its own focused change:

```text
src/core/types.ts      SimState — the simulation contract
src/core/theme.ts      the semantic palette and the shared material cache
src/core/bus.ts        the typed event bus
src/core/registry.ts   the Explainer registry
src/world/layout.ts    the city plan: every shared coordinate and route
src/world/module.ts    WorldModule / WorldCtx
src/main.ts            composition and frame order
```

When a district needs a coordinate another district also needs, it goes in
`layout.ts` — never duplicated locally.

## Visual verification

For anything visible, take a screenshot and **look at it**. Software WebGL runs
at roughly 1–3 fps, so allow 30–60 seconds for a scene this size to settle. A
successful render command is not verification; creating an image file is not
verification. Inspect the image, and read the console and exception output
alongside it.

### At most three browsers at once

Each headless browser rasterises WebGL through SwiftShader on the CPU and spikes
to 1–2 GiB while a frame is in flight. Queue your screenshots rather than
launching a browser per agent: ten at once will put the machine into swap and
then into the OOM killer, losing the in-flight work of every agent running at
the time. Queuing is slower per screenshot and it finishes.

## Driving the city from the console

`window.K8SKYLINES` exposes `sim`, `bus`, `registry`, `rig`, `gfx`, and `flows`.
Use them to stage a view before a screenshot:

```js
K8SKYLINES.sim.setKnob('replicas', 8)
K8SKYLINES.sim.runScenario('node-failure')
K8SKYLINES.bus.emit('focus', { id: 'etcd.raft-log' })
```
