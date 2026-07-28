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

  /* The UI never mutates the model. It emits intents; the simulation decides. */
  bus.on('knob', ({ key, value }) => {
    sim.setKnob(key as keyof Knobs, value as Knobs[keyof Knobs])
  })
  bus.on('scenario', ({ id, running }) => {
    if (running) sim.runScenario(id)
    else sim.stopScenario()
  })
  bus.on('theme', ({ mode }) => {
    setMode(mode)
    document.documentElement.dataset.theme = mode
  })
  bus.on('transport', ({ paused, timeScale }) => {
    sim.setKnob('paused', paused)
    sim.setKnob('timeScale', timeScale)
  })
  bus.on('event', (e) => {
    if (e.type === 'Warning') console.debug('[cluster]', e.reason, e.involved, e.message)
  })

  window.addEventListener('resize', () => gfx.resize(), { passive: true })

  /* Fixed maximum step: a backgrounded tab must not resume with a multi-second
   * delta and fast-forward the cluster through events nobody saw. */
  const MAX_DT = 1 / 15
  let last = performance.now()
  let firstFrame = true

  const frame = (now: number): void => {
    requestAnimationFrame(frame)
    const dt = Math.min((now - last) / 1000, MAX_DT)
    last = now

    sim.tick(dt)
    const s: SimState = sim.state

    for (let i = 0; i < districts.length; i++) districts[i]!.update(s, dt)

    rig.update(dt)
    picker.update(dt)
    labels.update(s, dt)
    hud.update(s, dt)
    controls.update(s)
    panel.update(s)
    tour.update(dt)

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
      THREE,
      version: typeof __K8SKYLINES_VERSION__ === 'string' ? __K8SKYLINES_VERSION__ : 'dev',
      sha: typeof __K8SKYLINES_GIT_SHA__ === 'string' ? __K8SKYLINES_GIT_SHA__ : 'unknown',
    },
    writable: false,
  })
}

main()
