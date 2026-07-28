#!/usr/bin/env node
/*
 * Repo hygiene: source files must be plain UTF-8 text.
 *
 * This exists because a literal NUL byte reached two district files. The intent
 * was a sentinel string the simulation can never produce, so a dirty-check
 * always repaints on the first call — a good idea written as a raw 0x00 byte
 * instead of the escape `\0`.
 *
 * A NUL byte in a tracked file is not cosmetic: git classifies the file as
 * binary and stops producing diffs for it, which silently removes the file from
 * code review. grep and file(1) skip it too.
 *
 * Usage:
 *   node tools/check-text.mjs          report offenders, exit 1 if any
 *   node tools/check-text.mjs --fix    rewrite NUL bytes as the escape \0
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCAN_DIRS = ['src', 'tools']
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json', '.md'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage'])

const fix = process.argv.includes('--fix')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) out.push(full)
  }
  return out
}

const files = []
for (const d of SCAN_DIRS) {
  try {
    walk(join(ROOT, d), files)
  } catch {
    /* A scan directory that does not exist yet is not an error. */
  }
}

let offenders = 0
let repaired = 0

for (const file of files) {
  const buf = readFileSync(file)
  const rel = relative(ROOT, file)

  const nulCount = buf.reduce((n, b) => (b === 0 ? n + 1 : n), 0)

  /* Round-trip through UTF-8 to catch invalid sequences the decoder replaces. */
  const text = buf.toString('utf8')
  const invalidUtf8 = Buffer.from(text, 'utf8').length !== buf.length

  if (nulCount === 0 && !invalidUtf8) continue

  offenders++
  const lines = buf.toString('latin1').split('\n')
  const hits = []
  lines.forEach((ln, i) => {
    if (ln.includes('\u0000')) hits.push(i + 1)
  })
  console.error(
    `${rel}: ${nulCount} NUL byte(s)${invalidUtf8 ? ', invalid UTF-8' : ''}` +
      (hits.length ? ` on line(s) ${hits.join(', ')}` : ''),
  )

  if (fix && nulCount > 0) {
    /* Replace the raw byte with the two-character escape. Inside a string
     * literal this is the identical runtime value; outside one it would not
     * compile, which is the correct outcome for a byte that should not exist. */
    writeFileSync(file, text.split('\u0000').join('\\0'), 'utf8')
    repaired++
    console.error(`  fixed: rewrote ${nulCount} NUL byte(s) as \\0`)
  }
}

if (offenders === 0) {
  console.log(`check-text: ${files.length} files clean`)
  process.exit(0)
}

if (fix) {
  console.log(`check-text: repaired ${repaired}/${offenders} file(s)`)
  process.exit(0)
}

console.error(`check-text: ${offenders} file(s) are not plain UTF-8 text. Run with --fix.`)
process.exit(1)
