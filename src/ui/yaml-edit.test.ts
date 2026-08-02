import { describe, expect, it } from 'vitest'
import { diffManifest, scalar } from './yaml-edit'

/*
 * The manifest a reader edits differs from the one the model printed only where
 * they typed. These pin that a changed value becomes exactly one field path, and
 * that edits this model cannot express as a field are reported rather than
 * silently mismatched onto the wrong line.
 */

const DOC = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 4
  paused: false
`

describe('reading back an edited manifest', () => {
  it('turns a changed value into one field path', () => {
    const r = diffManifest(DOC, DOC.replace('replicas: 4', 'replicas: 9'))
    expect(r.problems).toEqual([])
    expect(r.changes).toEqual([{ path: 'spec.replicas', before: '4', after: '9' }])
  })

  it('builds the path from indentation, not from the key alone', () => {
    const r = diffManifest(DOC, DOC.replace('name: web', 'name: other'))
    expect(r.changes[0].path).toBe('metadata.name')
  })

  it('reports added or removed lines instead of guessing', () => {
    const r = diffManifest(DOC, DOC + '  extra: 1\n')
    expect(r.changes).toEqual([])
    expect(r.problems[0]).toContain('gained or lost lines')
  })

  it('refuses a renamed field rather than treating it as a value change', () => {
    const r = diffManifest(DOC, DOC.replace('replicas: 4', 'replicaz: 4'))
    expect(r.changes).toEqual([])
    expect(r.problems[0]).toContain('rename is not an edit')
  })

  it('finds every change when several lines are edited', () => {
    const edited = DOC.replace('replicas: 4', 'replicas: 6').replace('paused: false', 'paused: true')
    const r = diffManifest(DOC, edited)
    expect(r.changes.map((c) => c.path).sort()).toEqual(['spec.paused', 'spec.replicas'])
  })

  it('coerces scalars, and leaves quantities as strings for the field to judge', () => {
    expect(scalar('4')).toBe(4)
    expect(scalar('true')).toBe(true)
    expect(scalar('false')).toBe(false)
    expect(scalar('"web"')).toBe('web')
    /* 2Gi and 250m must not become 2 and 250. */
    expect(scalar('2Gi')).toBe('2Gi')
    expect(scalar('250m')).toBe('250m')
  })
})
