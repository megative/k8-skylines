import * as THREE from 'three'
import type { SimState } from '../core/types'
import { COLOR, setMode } from '../core/theme'
import type { ThemeMode } from '../core/theme'
import { ANCHOR, CITY } from './layout'
import type { WorldCtx, WorldModule } from './module'

/* ============================================================================
 * SKY — atmosphere, light, and the only object in the city that means nothing.
 *
 * Two themes, two different jobs. At night the sky is nearly black and the key
 * light is weak, so structure reads as silhouette and the only bright things
 * are the neon marks that carry meaning. In day mode there is no bloom to lean
 * on, so hue and value have to do the work: a bright key, a strong hemisphere
 * fill, and a pale horizon that the fog matches exactly.
 *
 * Everything here is static. A moving sun would force the shadow map to be
 * re-rendered every frame for no teaching value, so `update` does nothing.
 * ==========================================================================*/

/** Beyond the fog's far plane, so the dome is always seen through full fog. */
const DOME_RADIUS = 2400
const SUN_DISTANCE = 2000

/**
 * The key light direction, shared by both themes so the shadow camera and every
 * building's read stay put across a theme flip.
 */
const SUN_DIR = new THREE.Vector3(0.48, 0.74, 0.47).normalize()

/** The shadow volume has to cover the whole city, apron to load balancer. */
const SHADOW_HALF = 820
const SHADOW_CENTER = new THREE.Vector3(0, 0, 30)

interface Palette {
  /** Straight up. */
  zenith: THREE.Color
  /** The band the fog colour must match, or the horizon shows a seam. */
  horizon: THREE.Color
  /** Below the horizon line, where the ground plane meets the dome. */
  nadir: THREE.Color
  key: THREE.Color
  keyIntensity: number
  fill: THREE.Color
  fillIntensity: number
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiIntensity: number
  /** Sun or moon disc. */
  disc: THREE.Color
  discRadius: number
}

/* Palette values are the structural colours from theme.ts scaled in value only.
 * The sky carries no mechanism, so it must not introduce a hue that does. */
function palette(mode: ThemeMode): Palette {
  if (mode === 'day') {
    return {
      /* The horizon sits a step below the palest structural tone: fog matches
       * it, and distant decks have to stay lighter than the haze to read. */
      zenith: new THREE.Color(COLOR.groundDay).multiplyScalar(0.72),
      horizon: new THREE.Color(COLOR.concreteDay).multiplyScalar(0.8),
      nadir: new THREE.Color(COLOR.groundDay).multiplyScalar(0.88),
      key: new THREE.Color(0xffffff),
      keyIntensity: 3.1,
      fill: new THREE.Color(COLOR.concreteDay),
      fillIntensity: 0.55,
      hemiSky: new THREE.Color(COLOR.concreteDay),
      hemiGround: new THREE.Color(COLOR.groundDay),
      hemiIntensity: 1.3,
      disc: new THREE.Color(COLOR.text),
      discRadius: 46,
    }
  }
  /* The structural palette is already nearly black at night. Light *colours*
   * therefore stay neutral — the darkness has to come from the materials, or
   * unlit faces multiply out to zero and whole walls disappear. */
  return {
    zenith: new THREE.Color(COLOR.ground).multiplyScalar(0.34),
    horizon: new THREE.Color(COLOR.deck).multiplyScalar(0.72),
    nadir: new THREE.Color(COLOR.ground).multiplyScalar(0.7),
    key: new THREE.Color(COLOR.text),
    keyIntensity: 2.2,
    fill: new THREE.Color(COLOR.edge),
    fillIntensity: 1.8,
    hemiSky: new THREE.Color(COLOR.text).multiplyScalar(0.6),
    hemiGround: new THREE.Color(COLOR.edge),
    hemiIntensity: 1.2,
    disc: new THREE.Color(COLOR.text).multiplyScalar(0.82),
    discRadius: 30,
  }
}

/* Scratch, reused by the one-off theme rebuild. */
const _c = new THREE.Color()

export function createSky(ctx: WorldCtx): WorldModule {
  const group = new THREE.Group()
  group.name = 'sky'

  /* ------------------------------------------------------------- the dome */

  const domeGeo = new THREE.SphereGeometry(DOME_RADIUS, 32, 20)
  const vertexCount = domeGeo.getAttribute('position').count
  domeGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3))
  const domeMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.renderOrder = -1000
  dome.frustumCulled = false
  group.add(dome)

  /* ---------------------------------------------------------- sun or moon */

  const discGeo = new THREE.SphereGeometry(1, 20, 14)
  const discMat = new THREE.MeshBasicMaterial({ fog: false, depthWrite: false })
  const disc = new THREE.Mesh(discGeo, discMat)
  disc.renderOrder = -999
  disc.position.copy(SUN_DIR).multiplyScalar(SUN_DISTANCE)
  group.add(disc)

  /* ------------------------------------------------------------- the light */

  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1)
  group.add(hemi)

  const key = new THREE.DirectionalLight(0xffffff, 1)
  key.position.copy(SUN_DIR).multiplyScalar(1400).add(SHADOW_CENTER)
  key.target.position.copy(SHADOW_CENTER)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  const sc = key.shadow.camera
  sc.left = -SHADOW_HALF
  sc.right = SHADOW_HALF
  sc.top = SHADOW_HALF
  sc.bottom = -SHADOW_HALF
  sc.near = 1
  /* Far has to reach past the excavation floor, which is 62 m below grade. */
  sc.far = 1400 + SHADOW_HALF + Math.abs(CITY.pit.floorY) * 2
  sc.updateProjectionMatrix()
  /* A 2048 map over a 1640 m square is ~0.8 m per texel; without normalBias the
   * node decks and the mesa acne badly at that ratio. */
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 1.1
  group.add(key, key.target)

  /* Fill from the opposite side so north faces are readable rather than black.
   * It casts no shadow: a second shadow map would double the cost for nothing. */
  const fill = new THREE.DirectionalLight(0xffffff, 0.3)
  fill.position.set(-SUN_DIR.x * 900, 420, -SUN_DIR.z * 900)
  group.add(fill)

  /* ---------------------------------------------------------------- fog */

  const fog = new THREE.Fog(0x000000, CITY.fog.near, CITY.fog.far)
  ctx.scene.fog = fog

  /* --------------------------------------------------------------- apply */

  function apply(mode: ThemeMode): void {
    const p = palette(mode)

    const pos = domeGeo.getAttribute('position') as THREE.BufferAttribute
    const col = domeGeo.getAttribute('color') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / DOME_RADIUS
      if (t <= 0) {
        /* Below the horizon the dome is only ever seen past the ground plane's
         * edge, so it holds the haze colour rather than a second gradient. */
        _c.copy(p.horizon).lerp(p.nadir, Math.min(1, -t * 3))
      } else {
        _c.copy(p.horizon).lerp(p.zenith, Math.pow(Math.min(1, t / 0.75), 0.7))
      }
      col.setXYZ(i, _c.r, _c.g, _c.b)
    }
    col.needsUpdate = true

    /* Fog must equal the horizon band exactly or distant ground shows a seam. */
    fog.color.copy(p.horizon)
    ctx.scene.background = p.horizon.clone()

    hemi.color.copy(p.hemiSky)
    hemi.groundColor.copy(p.hemiGround)
    hemi.intensity = p.hemiIntensity
    key.color.copy(p.key)
    key.intensity = p.keyIntensity
    fill.color.copy(p.fill)
    fill.intensity = p.fillIntensity
    discMat.color.copy(p.disc)
    disc.scale.setScalar(p.discRadius)
  }

  const offTheme = ctx.bus.on('theme', ({ mode }) => {
    /* Districts are built before main.ts installs its own theme handler, so this
     * may run first; setMode is idempotent and makes handler order irrelevant. */
    setMode(mode)
    apply(mode)
  })
  apply('night')

  /* The sky is the one thing here with no Kubernetes meaning, and saying so is
   * worth an entry: a reader should never hunt for a mechanism that is absent. */
  const timeOfDay = ctx.registry.register({
    id: 'sky.time-of-day',
    title: 'Sun and sky',
    district: 'client',
    summary: 'The only thing in the city that carries no meaning. Time of day is a rendering mode, not cluster state.',
    detail: [
      'Everything else you can click on stands for a real mechanism, and every colour names one. The sky does not. It exists so that the city is legible twice: at night, where matte structure recedes and only emissive marks glow, and in daylight, where hue and value have to carry the same information without any glow at all.',
      'Nothing about the cluster changes when you flip the theme. No timer runs, no controller reacts, and the sun does not move as the model advances.',
    ],
    caveats: [
      'Kubernetes has no notion of time of day. Nothing in a cluster is scheduled by wall clock except CronJobs, which use their own schedule and time zone.',
    ],
    object: disc,
    focus: [ANCHOR.cityCenter[0], 260, ANCHOR.cityCenter[2] + 400],
    keywords: ['sky', 'theme', 'day', 'night', 'lighting'],
  })
  ctx.registry.bind(dome, timeOfDay)

  /* Static by design: nothing here reads SimState, and the shadow map is
   * therefore valid for the life of the page. */
  function update(_s: SimState, _dt: number): void {}

  function dispose(): void {
    offTheme()
    if (ctx.scene.fog === fog) ctx.scene.fog = null
    ctx.scene.background = null
    domeGeo.dispose()
    domeMat.dispose()
    discGeo.dispose()
    discMat.dispose()
    group.removeFromParent()
  }

  return { group, update, dispose }
}
