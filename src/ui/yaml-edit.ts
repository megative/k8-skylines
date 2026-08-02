/* ============================================================================
 * READING BACK AN EDITED MANIFEST
 *
 * The reader edits the YAML the model printed, so the two texts differ only
 * where they typed. That makes a full parser unnecessary and, worse, dishonest:
 * a real YAML parser would happily accept structures this model has no field
 * for, and we would have to invent a refusal anyway.
 *
 * Instead the edited text is walked line by line against the original. A line
 * whose value changed becomes one field path — built from indentation, exactly
 * as the manifest was written — and the caller sends it through the same edit
 * path a form field uses. Nothing here writes to the cluster; it only says what
 * the reader appears to have changed.
 * ==========================================================================*/

export interface FieldChange {
  /** Dotted path, e.g. `spec.replicas`. */
  path: string
  before: string
  after: string
}

export interface DiffResult {
  changes: FieldChange[]
  /** Structural edits this reader-facing diff cannot express as a field. */
  problems: string[]
}

const INDENT = 2

interface Line {
  indent: number
  key: string
  value: string
  /** A list item or a line with no `key: value` shape. */
  structural: boolean
  raw: string
}

function parseLine(raw: string): Line | null {
  if (raw.trim() === '' || raw.trim().startsWith('#')) return null
  const indent = raw.length - raw.trimStart().length
  const body = raw.trim()
  if (body.startsWith('-')) return { indent, key: '', value: body, structural: true, raw }
  const colon = body.indexOf(':')
  if (colon < 0) return { indent, key: '', value: body, structural: true, raw }
  return {
    indent,
    key: body.slice(0, colon).trim(),
    value: body.slice(colon + 1).trim(),
    structural: false,
    raw,
  }
}

/** Dotted path of a line, from the stack of keys above it at lower indents. */
function pathOf(lines: (Line | null)[], i: number): string {
  const line = lines[i]
  if (!line || line.structural) return ''
  const parts = [line.key]
  let want = line.indent - INDENT
  for (let j = i - 1; j >= 0 && want >= 0; j--) {
    const l = lines[j]
    if (!l || l.structural) continue
    if (l.indent === want) {
      parts.unshift(l.key)
      want -= INDENT
    }
  }
  return parts.join('.')
}

/**
 * What the reader changed, as field paths. Both texts must be the same manifest;
 * `edited` is the one they typed into.
 */
export function diffManifest(original: string, edited: string): DiffResult {
  const a = original.split('\n')
  const b = edited.split('\n')
  const changes: FieldChange[] = []
  const problems: string[] = []

  if (a.length !== b.length) {
    /*
     * Adding or removing lines is a structural edit — a new container, a
     * deleted block. Saying so is better than silently matching the wrong lines
     * and reporting a change the reader never made.
     */
    problems.push(
      `the manifest gained or lost lines (${a.length} → ${b.length}). This model can apply changed values, not added or removed fields`,
    )
    return { changes, problems }
  }

  const parsedA = a.map(parseLine)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    const la = parsedA[i]
    const lb = parseLine(b[i])
    if (!la || !lb) {
      problems.push(`line ${i + 1} is not a field this model can read back`)
      continue
    }
    if (la.structural || lb.structural) {
      problems.push(`line ${i + 1}: list items and block structure cannot be edited here`)
      continue
    }
    if (la.key !== lb.key) {
      problems.push(`line ${i + 1}: the field name changed (${la.key} → ${lb.key}); rename is not an edit`)
      continue
    }
    changes.push({ path: pathOf(parsedA, i), before: la.value, after: lb.value })
  }

  return { changes, problems }
}

/** Coerce a YAML scalar to the shape the edit path expects. */
export function scalar(v: string): string | number | boolean {
  const t = v.trim().replace(/^["']|["']$/g, '')
  if (t === 'true') return true
  if (t === 'false') return false
  /* `2Gi` and `250m` stay strings here; the field's own validator owns units. */
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}
