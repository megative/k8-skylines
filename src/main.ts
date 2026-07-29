import * as THREE from 'three'

import './styles/base.css'
import './styles/tokens.css'
import './styles/hud.css'
import './styles/controls.css'
import './styles/panel.css'
import './styles/overlay.css'
import './styles/viewbar.css'

import { bus } from './core/bus'
import { registry } from './core/registry'
import { getMode, setMode } from './core/theme'
import { Rng } from './core/util'
import type { Knobs, SimState } from './core/types'

import { createSim } from './sim/model'

import { createRenderer } from './engine/renderer'
import { createCameraRig } from './engine/camera'
import { createFlows } from './engine/flows'
import { createLabels } from './engine/labels'
import { createPicker } from './engine/picker'

import type { WorldCtx, WorldModule } from './world/module'
import { createGround } from './world/ground'
import { createSky } from './world/sky'
import { createApiServer } from './world/apiserver'
import { createEtcd } from './world/etcd'
import { createScheduler } from './world/scheduler'
import { createControllers } from './world/controllers'
import { createNodes } from './world/nodes'
import { createPods } from './world/pods'
import { createNetwork } from './world/network'
import { createStorage } from './world/storage'
import { createRegistryYard } from './world/registry-yard'

import { createHud } from './ui/hud'
import { createControls } from './ui/controls'
import { createPanel } from './ui/panel'
import { createSearch } from './ui/search'
import { createHelp } from './ui/help'
import { createTour } from './ui/tour'
import { createViewbar } from './ui/viewbar'
import { createScenarioBrowser } from './ui/scenarios'

declare const __K8SKYLINES_VERSION__: string
declare const __K8SKYLINES_GIT_SHA__: string

const boot = document.getElementById('boot')
const bootSub = document.getElementById('boot-sub')

function fail(message: string): void {
  if (bootSub) {
    bootSub.textContent = message
    bootSub.classList.add('error')
  }
  console.error('[k8skylines]', message)
}

function main(): void {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null
  if (!canvas) return fail('canvas #stage is missing from the document')

  let gfx
  try {
    gfx = createRenderer(canvas)
  } catch (err) {
    return fail(
      `This browser could not start WebGL2, which K8Skylines needs. ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  /* index.html hard-codes the same value to avoid a flash; this keeps the DOM
   * honest if the default in core/theme.ts ever changes and the markup lags. */
  document.documentElement.dataset.theme = getMode()
  gfx.setBloom(getMode() === 'night')

  const sim = createSim()
  /* One fixed seed for the whole city, so scatter is identical across reloads
   * and a screenshot taken today matches one taken tomorrow. */
  const ctx: WorldCtx = { scene: gfx.scene, registry, bus, rng: new Rng(0x85c171e5) }

  /* Districts are built independently and a broken one must not blank the whole
   * city: a partially built city still teaches, a black screen teaches nothing.
   * Failures are loud in the console and counted in the boot line. */
  const districts: WorldModule[] = []
  const failures: string[] = []
  const add = (name: string, build: (c: WorldCtx) => WorldModule): void => {
    try {
      const m = build(ctx)
      gfx.scene.add(m.group)
      districts.push(m)
    } catch (err) {
      failures.push(name)
      console.error(`[k8skylines] district "${name}" failed to build`, err)
    }
  }

  add('sky', createSky)
  add('ground', createGround)
  add('etcd', createEtcd)
  add('apiserver', createApiServer)
  add('scheduler', createScheduler)
  add('controllers', createControllers)
  add('nodes', createNodes)
  add('pods', createPods)
  add('network', createNetwork)
  add('storage', createStorage)
  add('registry-yard', createRegistryYard)

  /* Flows are a world module too, but they are built last so their routes can
   * sit above whatever geometry the districts placed under them. */
  const flows = createFlows(ctx)
  gfx.scene.add(flows.group)
  districts.push(flows)

  const rig = createCameraRig(gfx, canvas, bus)
  const labels = createLabels(gfx, registry, document.getElementById('labels')!)
  const picker = createPicker(gfx, registry, bus, canvas)

  const hud = createHud(bus)
  const controls = createControls(bus, sim.state.knobs)
  const panel = createPanel(bus, registry)
  createSearch(bus, registry)
  createHelp(bus)
  const tour = createTour(bus, registry)
  createViewbar(bus, rig)
  const scenarios = createScenarioBrowser(bus)

  /* The UI never mutates the model. It emits intents; the simulation decides. */
  /*
   * 'knob', 'transport' and 'scenario' are all both commands and notifications:
   * the simulation re-emits them once a change has actually landed. Feeding an
   * echo back in is a loop, and only setKnob's own no-op guard was breaking it —
   * where it did not, the stack overflowed and the bus swallowed the error.
   * Every handler below applies a change only when it would change something.
   */
  bus.on('knob', ({ key, value }) => {
    const k = key as keyof Knobs
    if (sim.state.knobs[k] === value) return
    sim.setKnob(k, value as Knobs[keyof Knobs])
  })
  /* The simulation uses 'scenario' as both a command and a notification: it
   * emits the same event once a run actually starts. Feeding that echo straight
   * back in made runScenario see a run already in progress and stop it, so every
   * scenario died the instant it began. Act only when the state would change. */
  bus.on('scenario', ({ id, running }) => {
    if (running) {
      if (sim.activeScenario !== id) sim.runScenario(id)
    } else if (sim.activeScenario) {
      sim.stopScenario()
    }
  })
  bus.on('theme', ({ mode }) => {
    setMode(mode)
    document.documentElement.dataset.theme = mode
    /* Daylight never leans on bloom, and bloom is the single most expensive
     * thing in the frame: a whole-graph traversal plus a second scene render
     * plus a blur chain. Day gets that budget back. */
    gfx.setBloom(mode === 'night')
  })
  bus.on('transport', ({ paused, timeScale }) => {
    if (sim.state.knobs.paused !== paused) sim.setKnob('paused', paused)
    if (sim.state.knobs.timeScale !== timeScale) sim.setKnob('timeScale', timeScale)
  })
  /*
   * Stepping the model itself. `runUntil` is checked after every tick: 'event'
   * releases the cluster until it emits its next event, 'second' until one model
   * second has passed. Either way it parks itself again immediately, so cause
   * and effect stay next to each other instead of scrolling past.
   */
  /*
   * An event names its object as `kind/name`. The controller yard registers one
   * explainer per controller under exactly those kind names, so the mapping is
   * almost an identity — the few that are not are listed here rather than
   * guessed. Anything unmapped simply does not move the camera.
   */
  const EVENT_SUBJECT: Record<string, string> = {
    pod: 'pod',
    node: 'node',
    replicaset: 'replicaset',
    deployment: 'deployment',
    statefulset: 'statefulset',
    daemonset: 'daemonset',
    job: 'job',
    cronjob: 'cronjob',
    namespace: 'namespace',
    serviceaccount: 'serviceaccount',
    endpointslice: 'net.endpointslice',
    service: 'net.service',
    hpa: 'hpa',
    pvc: 'storage.pvc',
    pv: 'storage.pv',
  }

  let runUntil: 'event' | 'second' | null = null
  let stepFromEvents = 0
  let stepFromT = 0
  bus.on('step', ({ kind }) => {
    runUntil = kind
    stepFromEvents = sim.state.events.length
    stepFromT = sim.state.t
    if (sim.state.knobs.paused) sim.setKnob('paused', false)
  })

  bus.on('event', (e) => {
    if (e.type === 'Warning') console.debug('[cluster]', e.reason, e.involved, e.message)
  })

  window.addEventListener('resize', () => gfx.resize(), { passive: true })

  /* Give the page the keyboard immediately. Without this the first keypress
   * after load went nowhere and the city felt dead until you clicked it once. */
  canvas.tabIndex = 0
  canvas.focus({ preventScroll: true })
  /* Clicking anywhere that is not an overlay hands the keyboard back, so the
   * camera keeps working after a panel has taken focus and been dismissed. */
  window.addEventListener('pointerdown', (ev) => {
    const t = ev.target
    if (t instanceof HTMLElement && t.closest('.overlay, .hud, #viewbar, #scenarios')) return
    canvas.focus({ preventScroll: true })
  })

  /* Fixed maximum step: a backgrounded tab must not resume with a multi-second
   * delta and fast-forward the cluster through events nobody saw. */
  const MAX_DT = 1 / 15
  let last = performance.now()
  let firstFrame = true

  /*
   * Adaptive quality. `setQuality` existed but nothing ever called it, so the
   * renderer always paid for high: bloom re-renders the whole scene into its
   * own target and then blurs it across five mip levels, and DPR 2 on a retina
   * display means four times the pixels for every one of those passes. On a
   * laptop GPU that is the difference between a city you can fly through and
   * one that lurches.
   *
   * Drop on sustained slowness, restore on sustained speed, and never switch
   * more than once every few seconds so the picture cannot flap.
   */
  const FRAME_WINDOW = 45
  const DROP_MS = 26 /* ~38 fps */
  const RAISE_MS = 15 /* ~66 fps */
  const SWITCH_COOLDOWN_MS = 4000
  const frameTimes: number[] = []
  let frameCursor = 0
  let quality: 'low' | 'high' = 'high'
  let lastSwitch = 0

  const considerQuality = (dtMs: number, now: number): void => {
    frameTimes[frameCursor++ % FRAME_WINDOW] = dtMs
    if (frameTimes.length < FRAME_WINDOW) return
    if (now - lastSwitch < SWITCH_COOLDOWN_MS) return

    let sum = 0
    for (let i = 0; i < FRAME_WINDOW; i++) sum += frameTimes[i]!
    const avg = sum / FRAME_WINDOW

    if (quality === 'high' && avg > DROP_MS) {
      quality = 'low'
      gfx.setQuality('low')
      lastSwitch = now
      console.info(`[k8skylines] ${avg.toFixed(1)}ms/frame — dropping to low quality`)
    } else if (quality === 'low' && avg < RAISE_MS) {
      quality = 'high'
      gfx.setQuality('high')
      lastSwitch = now
      console.info(`[k8skylines] ${avg.toFixed(1)}ms/frame — restoring high quality`)
    }
  }

  const frame = (now: number): void => {
    requestAnimationFrame(frame)
    const rawMs = now - last
    const dt = Math.min(rawMs / 1000, MAX_DT)
    last = now
    considerQuality(rawMs, now)

    sim.tick(dt)
    const s: SimState = sim.state

    if (runUntil !== null) {
      const arrived =
        runUntil === 'event' ? s.events.length > stepFromEvents : s.t - stepFromT >= 1
      if (arrived) {
        runUntil = null
        sim.setKnob('paused', true)

        /* Stopping is only half of a step. Say what happened and go look at it,
         * or the reader is left hunting a changed pixel in a frozen city. */
        const ev = s.events[s.events.length - 1]
        if (ev && s.events.length > stepFromEvents) {
          bus.emit('toast', {
            text: `${ev.reason} · ${ev.involved} — ${ev.message}`,
            kind: ev.type === 'Warning' ? 'warn' : 'info',
          })
          const kind = ev.involved.slice(0, ev.involved.indexOf('/'))
          const subject = EVENT_SUBJECT[kind]
          if (subject && registry.get(subject)) {
            bus.emit('focus', { id: subject, source: 'menu' })
          }
        }
      }
    }

    for (let i = 0; i < districts.length; i++) districts[i]!.update(s, dt)

    rig.update(dt)
    picker.update(dt)
    labels.update(s, dt)
    hud.update(s, dt)
    controls.update(s)
    panel.update(s)
    tour.update(dt)
    scenarios.update(s, dt)

    gfx.render(dt)

    if (firstFrame) {
      firstFrame = false
      if (boot) {
        if (failures.length > 0) {
          fail(`built with ${failures.length} district(s) missing: ${failures.join(', ')}`)
        } else {
          boot.classList.add('gone')
          window.setTimeout(() => boot.remove(), 700)
        }
      }
    }
  }
  requestAnimationFrame(frame)

  /* The console surface. Documented in AGENTS.md; used to stage screenshots. */
  Object.defineProperty(window, 'K8SKYLINES', {
    value: {
      sim,
      bus,
      registry,
      rig,
      gfx,
      flows,
      /* The UI surfaces, so a console session can drive and inspect them the
       * same way AGENTS.md already documents for the camera and the model. */
      hud,
      panel,
      controls,
      scenarios,
      THREE,
      version: typeof __K8SKYLINES_VERSION__ === 'string' ? __K8SKYLINES_VERSION__ : 'dev',
      sha: typeof __K8SKYLINES_GIT_SHA__ === 'string' ? __K8SKYLINES_GIT_SHA__ : 'unknown',
    },
    writable: false,
  })
}

main()
