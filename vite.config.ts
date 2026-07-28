import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const pkg = JSON.parse(readFileSync(entry('./package.json'), 'utf8')) as { version: string }

function shortGitSha(): string {
  const supplied = process.env.K8SKYLINES_GIT_SHA ?? process.env.GITHUB_SHA
  if (supplied && /^[0-9a-f]{7,40}$/i.test(supplied)) return supplied.slice(0, 7).toLowerCase()
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: entry('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  base: './',
  define: {
    __K8SKYLINES_VERSION__: JSON.stringify(pkg.version),
    __K8SKYLINES_GIT_SHA__: JSON.stringify(shortGitSha()),
  },
  server: { host: true, port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    modulePreload: { polyfill: false },
    rollupOptions: { input: { city: entry('./index.html') } },
  },
  /* Agent worktrees land under .claude/worktrees/, inside the repo. Without this
   * exclude, vitest globs into them and runs another agent's in-progress red
   * tests as though they belonged to this tree. dist/ is built output. */
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
})
