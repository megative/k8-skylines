import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

/* ============================================================================
 * The renderer: WebGL2, ACES filmic tone mapping, sRGB output, selective bloom.
 *
 * The bloom here is *selective by emissive intensity*, not by screen luminance.
 * That distinction is the whole point. `core/theme.ts` promises that only
 * emissive intensity above 1.0 glows, so glow always carries information; a
 * plain luminance threshold cannot keep that promise, because a violet neon at
 * intensity 1.6 is dimmer than a cyan hologram at 0.9 and would be cut while
 * the hologram bloomed. So an object is admitted to the bloom layer by
 * inspecting its material, and the bloom source is rendered with the camera
 * restricted to that layer.
 *
 * Restricting the camera's layers also drops every Light from the render list,
 * which is exactly what we want: the bloom buffer then contains the emissive
 * term alone, with no lit contribution mixed in.
 *
 * Pipeline, per frame at high quality:
 *   1. emissive-only pass  -> bloomRT        (layer-restricted, no lights)
 *   2. UnrealBloomPass     -> blurred bloom
 *   3. RenderPass          -> HDR buffer     (the full lit scene)
 *   4. combine             -> HDR + bloom, still linear and unclamped
 *   5. OutputPass          -> ACES tone map, then sRGB
 * Adding the bloom *before* tone mapping is what makes a hot sign roll off
 * filmically instead of turning into a flat white blob.
 * ==========================================================================*/

export interface Gfx {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  render(dt: number): void
  resize(): void
  setQuality(q: 'low' | 'high'): void
  /**
   * Bloom costs a full scene-graph traversal, a second render of the whole
   * scene, and a five-level blur chain, every frame. Daylight carries meaning
   * through hue and value and never relies on it, so day switches it off and
   * gets that budget back.
   */
  setBloom(on: boolean): void
  dispose(): void
}

/** Objects whose material is emissive above 1.0 are drawn into the bloom source. */
const BLOOM_LAYER = 1

/*
 * Depth precision, and why this number moved.
 *
 * A depth buffer spends its precision hyperbolically: almost all of it sits in
 * the first slice in front of the near plane. At NEAR = 0.5 with FAR = 4200 —
 * a 1:8400 range — the city, which lives 300 to 1200 units out, was competing
 * for the last few representable values, and coplanar surfaces out there
 * flickered against each other as the camera moved.
 *
 * That 0.5 existed so a walking camera could stand half a metre from a wall.
 * Walk mode is gone and orbit cannot come closer than MIN_DIST, so nothing
 * needs it any more. At NEAR = 4 the range is 1:1050 and the far half of the
 * city gets roughly eight times the depth resolution it had.
 */
const NEAR = 4
const FAR = 4200
const DEFAULT_FOV = 48

const DPR_CAP = { high: 2, low: 1 } as const

const BLOOM_STRENGTH = 0.85
const BLOOM_RADIUS = 0.55
/* Zero, deliberately. The bloom layer has already decided what glows; a second
 * luminance cut here would silently re-introduce the hue bias we just removed. */
const BLOOM_THRESHOLD = 0

const _clearColor = new THREE.Color()
const _size = new THREE.Vector2()

interface MaybeEmissive {
  emissive?: THREE.Color
  emissiveIntensity?: number
}

/*
 * The bar for "this glows".
 *
 * It used to be 1.0, and at that level 949 of the city's 2966 meshes were
 * admitted — nearly a third. A rule that says glow carries information cannot
 * be true when a third of everything glows: district outlines, deck rims and
 * plot borders all crossed it, so the neon read as decoration and the actual
 * signals had nothing left to stand out against.
 *
 * Districts spend intensity in a consistent range: roughly 1.1-1.6 for lit
 * structure and 1.9 and up for state that means something. The bar sits in the
 * gap. Structure keeps its colour; only what is signalling blooms.
 */
const GLOW_THRESHOLD = 1.75

function materialGlows(m: THREE.Material): boolean {
  const e = m as THREE.Material & MaybeEmissive
  const intensity = e.emissiveIntensity
  const color = e.emissive
  if (color === undefined || intensity === undefined || intensity <= GLOW_THRESHOLD) return false
  return color.r > 0 || color.g > 0 || color.b > 0
}

/* Runs over every object every frame: districts raise and lower emissive
 * intensity to signal state, so bloom membership cannot be cached. */
function tagBloom(o: THREE.Object3D): void {
  const material = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  let glows = false
  if (material !== undefined) {
    if (Array.isArray(material)) {
      for (let i = 0; i < material.length; i++) {
        if (materialGlows(material[i]!)) {
          glows = true
          break
        }
      }
    } else {
      glows = materialGlows(material)
    }
  }
  if (glows) o.layers.enable(BLOOM_LAYER)
  else o.layers.disable(BLOOM_LAYER)
}

/* Toggling renderer.shadowMap.enabled changes the shader defines, so every
 * material has to be recompiled. This is a quality change, never a frame. */
function markForRecompile(o: THREE.Object3D): void {
  const material = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  if (material === undefined) return
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) material[i]!.needsUpdate = true
  } else {
    material.needsUpdate = true
  }
}

const CombineShader = {
  name: 'K8SkylinesBloomCombine',
  uniforms: {
    baseTexture: { value: null as THREE.Texture | null },
    bloomTexture: { value: null as THREE.Texture | null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D baseTexture;
    uniform sampler2D bloomTexture;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D( baseTexture, vUv );
      vec4 glow = texture2D( bloomTexture, vUv );
      gl_FragColor = vec4( base.rgb + glow.rgb, base.a );
    }
  `,
}

/**
 * WebGL2 or nothing. The message is written for the person staring at a blank
 * page: `main.ts` catches it and prints it into `#boot`, so it must say what
 * failed and what to try, not just that something went wrong.
 */
function acquireContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const attributes: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  }

  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null
  } catch {
    gl = null
  }
  if (gl) return gl

  let legacy = false
  try {
    legacy = canvas.getContext('webgl') !== null
  } catch {
    legacy = false
  }

  throw new Error(
    legacy
      ? 'This browser offers WebGL 1 but not WebGL 2. Update the browser, or enable hardware acceleration in its settings.'
      : "canvas.getContext('webgl2') returned no context. Hardware acceleration may be switched off, the GPU may be blocklisted, or too many WebGL contexts may already be open in other tabs.",
  )
}

export function createRenderer(canvas: HTMLCanvasElement): Gfx {
  const context = acquireContext(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false })
  renderer.autoClear = true
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  /* PCFSoftShadowMap is deprecated in r185 and silently downgrades to this. */
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x05070c, 1)

  const scene = new THREE.Scene()
  /* Lighting, sky and fog belong to `world/sky.ts`. The renderer owns the
   * scene object and nothing that is in it. */

  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, NEAR, FAR)
  camera.position.set(0, 300, 500)

  let quality: 'low' | 'high' = 'high'
  /* Two independent gates: the theme decides whether bloom means anything, the
   * quality tier decides whether the machine can afford it. */
  let bloomAllowed = true
  let bloomCapable = true
  let bloomEnabled = true

  const dprFor = (q: 'low' | 'high'): number =>
    Math.min(window.devicePixelRatio || 1, DPR_CAP[q])

  renderer.setPixelRatio(dprFor(quality))
  renderer.getDrawingBufferSize(_size)

  const makeHdrTarget = (q: 'low' | 'high'): THREE.WebGLRenderTarget => {
    renderer.getDrawingBufferSize(_size)
    const rt = new THREE.WebGLRenderTarget(Math.max(1, _size.x), Math.max(1, _size.y), {
      type: THREE.HalfFloatType,
      /* MSAA on the HDR buffer, because post-processing bypasses the default
       * framebuffer's antialiasing entirely. */
      samples: q === 'high' ? 4 : 0,
    })
    rt.texture.name = 'k8skylines.hdr'
    return rt
  }

  const composer = new EffectComposer(renderer, makeHdrTarget(quality))
  const renderPass = new RenderPass(scene, camera)
  const combinePass = new ShaderPass(CombineShader, 'baseTexture')
  /* The sum is already the final colour. Blending it would multiply it by the
   * scene's alpha and quietly darken everything the bloom touches. */
  combinePass.material.blending = THREE.NoBlending
  const outputPass = new OutputPass()
  composer.addPass(renderPass)
  composer.addPass(combinePass)
  composer.addPass(outputPass)

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(Math.max(1, _size.x), Math.max(1, _size.y)),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD,
  )

  /* The emissive-only source. No MSAA: it is about to be blurred anyway. */
  const bloomRT = new THREE.WebGLRenderTarget(Math.max(1, _size.x), Math.max(1, _size.y), {
    type: THREE.HalfFloatType,
  })
  bloomRT.texture.name = 'k8skylines.bloomSource'

  function resize(): void {
    const w = Math.max(1, canvas.clientWidth || window.innerWidth)
    const h = Math.max(1, canvas.clientHeight || window.innerHeight)
    const dpr = dprFor(quality)

    renderer.setPixelRatio(dpr)
    /* `false`: CSS owns the canvas box, the renderer owns only the buffer. */
    renderer.setSize(w, h, false)

    camera.aspect = w / h
    camera.updateProjectionMatrix()

    composer.setPixelRatio(dpr)
    composer.setSize(w, h)

    const bw = Math.max(1, Math.round(w * dpr))
    const bh = Math.max(1, Math.round(h * dpr))
    bloomRT.setSize(bw, bh)
    bloomPass.setSize(bw, bh)
  }

  function renderBloomSource(dt: number): void {
    const background = scene.background
    const environment = scene.environment
    const mask = camera.layers.mask
    renderer.getClearColor(_clearColor)
    const clearAlpha = renderer.getClearAlpha()

    /* The sky and any environment map would light and tint the source buffer;
     * both must be gone so the buffer holds emissive and nothing else. */
    scene.background = null
    scene.environment = null
    camera.layers.set(BLOOM_LAYER)
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(bloomRT)
    renderer.render(scene, camera)

    camera.layers.mask = mask
    scene.background = background
    scene.environment = environment
    renderer.setClearColor(_clearColor, clearAlpha)

    /* Blurs bloomRT into bloomPass.renderTargetsHorizontal[0]; the additive
     * blend it then performs back into bloomRT is discarded, because the base
     * pass already contains those emissive pixels once. */
    bloomPass.render(renderer, bloomRT, bloomRT, dt, false)
    renderer.setRenderTarget(null)
  }

  function render(dt: number): void {
    if (bloomEnabled) {
      scene.traverse(tagBloom)
      renderBloomSource(dt)
      combinePass.uniforms['bloomTexture'].value = bloomPass.renderTargetsHorizontal[0]!.texture
    }
    composer.render(dt)
  }

  function setQuality(q: 'low' | 'high'): void {
    if (q === quality) return
    quality = q
    bloomCapable = q === 'high'
    bloomEnabled = bloomAllowed && bloomCapable
    combinePass.enabled = bloomEnabled

    const shadows = q === 'high'
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows
      scene.traverse(markForRecompile)
    }

    renderer.setPixelRatio(dprFor(q))
    composer.reset(makeHdrTarget(q))
    resize()
  }

  /* A lost context is not a crash: report it and let the browser restore. */
  const onContextLost = (e: Event): void => {
    e.preventDefault()
    console.warn('[k8skylines] WebGL context lost; waiting for the browser to restore it')
  }
  const onContextRestored = (): void => {
    console.info('[k8skylines] WebGL context restored')
    resize()
  }
  canvas.addEventListener('webglcontextlost', onContextLost, false)
  canvas.addEventListener('webglcontextrestored', onContextRestored, false)

  resize()

  function setBloom(on: boolean): void {
    if (on === bloomAllowed) return
    bloomAllowed = on
    bloomEnabled = bloomAllowed && bloomCapable
    combinePass.enabled = bloomEnabled
  }

  return {
    renderer,
    scene,
    camera,
    render,
    resize,
    setQuality,
    setBloom,
    dispose(): void {
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      bloomRT.dispose()
      bloomPass.dispose()
      combinePass.dispose()
      outputPass.dispose()
      renderPass.dispose()
      composer.dispose()
      renderer.dispose()
    },
  }
}
