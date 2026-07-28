/* ============================================================================
 * sim/images.ts — the image names the demo cluster runs.
 *
 * Real registry shapes, real tag shapes. A pod named `web` running
 * `myapp:latest` reads as a cartoon; `ghcr.io/…/web:v1.4.2` reads as a
 * cluster, and image locality scoring only makes sense if the strings are
 * distinct per revision.
 * ==========================================================================*/

export const IMAGES = {
  pause: 'registry.k8s.io/pause:3.9',
  webV1: 'ghcr.io/k8skylines/web:v1.4.2',
  webV2: 'ghcr.io/k8skylines/web:v1.5.0',
  /** The revision whose readiness probe never passes. */
  webBroken: 'ghcr.io/k8skylines/web:v1.5.1-rc1',
  /** A tag that does not exist in the registry. */
  webMissing: 'ghcr.io/k8skylines/web:v9.9.9',
  api: 'ghcr.io/k8skylines/api:v3.1.0',
  busybox: 'busybox:1.36.1',
  fluentbit: 'cr.fluentbit.io/fluent/fluent-bit:3.0.7',
  coredns: 'registry.k8s.io/coredns/coredns:v1.11.1',
  postgres: 'postgres:16.2-alpine',
  nodeExporter: 'quay.io/prometheus/node-exporter:v1.8.1',
  migrate: 'ghcr.io/k8skylines/migrate:v2.0.1',
  report: 'ghcr.io/k8skylines/report:v1.0.3',
  checkout: 'ghcr.io/k8skylines/checkout:v2.2.0',
} as const
