/* ============================================================================
 * The mark.
 *
 * "Kubernetes" is Greek κυβερνήτης — the helmsman, the one at the wheel. So the
 * mark is a ship's helm with the recognizable seven spokes of the project's
 * symbol. A helm is a generic object, not a trademark; only the Foundation's
 * specific logo rendering is, and this is our own drawing in our own palette —
 * evoking the symbol, not cloning the mark. To make it unmistakably ours, the
 * hub holds the city's thesis in miniature: a skyline whose tallest tower is
 * still a ghost (desired state), standing over the strata of the etcd vault.
 * The disclaimer on the boot screen states the lack of affiliation plainly.
 *
 * One SVG, `currentColor` for the wheel so it takes the theme, explicit accents
 * for the two things that are always semantic: the cyan ghost and the violet
 * vault. Readable as a wheel at 16px and as a city at 160px.
 * ==========================================================================*/

const SPOKE = (deg: number): string =>
  `<g transform="rotate(${deg} 50 50)">` +
  `<line x1="50" y1="37.5" x2="50" y2="9"/>` +
  `<circle cx="50" cy="8" r="2.6" fill="currentColor" stroke="none"/>` +
  `</g>`

/* Seven spokes, ~51.43° apart, so it reads as the Kubernetes helm. */
const SPOKES = [0, 1, 2, 3, 4, 5, 6].map((i) => SPOKE((i * 360) / 7)).join('')

export const HELM_SVG =
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">` +
  /* the wheel: rim, then eight spoke-and-handle arms crossing it */
  `<g stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="50" cy="50" r="34"/>` +
  SPOKES +
  `</g>` +
  /* the hub: a dark disc so the little city reads against the wheel */
  `<circle cx="50" cy="50" r="13.5" fill="var(--k8-mark-hub, #0b1018)" stroke="currentColor" stroke-width="2"/>` +
  /* the city in the hub — actual towers in matter, the tallest still a ghost */
  `<g>` +
  `<rect x="43.4" y="52" width="3.1" height="6.4" rx="0.6" fill="currentColor"/>` +
  `<rect x="47.7" y="49" width="3.1" height="9.4" rx="0.6" fill="currentColor"/>` +
  `<rect x="52" y="46.4" width="3.1" height="12" rx="0.6" fill="none" stroke="#38e8ff" stroke-width="1.5" stroke-dasharray="2 1.6"/>` +
  `<rect x="43" y="59.2" width="12.1" height="1.9" rx="0.7" fill="#9d6cff"/>` +
  `</g>` +
  `</svg>`
