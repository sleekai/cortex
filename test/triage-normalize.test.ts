import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { normalizeSkill } from '../src/triage/skills/normalize.js'
import { emptyPacket } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/skill.js'

function ctx(raw: string): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: raw, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  return { ucp, raw, draft: emptyPacket(), policy: DEFAULT_TRIAGE_POLICY }
}

test('normalize strips greeting, politeness, and filler', () => {
  const { patch } = normalizeSkill.execute(ctx('Hi, please could you just fix the null check'))
  assert.equal(patch.normalized_task, 'fix the null check')
})

test('normalize collapses whitespace', () => {
  const { patch } = normalizeSkill.execute(ctx('fix    the\n\n  null   check'))
  assert.equal(patch.normalized_task, 'fix the null check')
})

test('normalize deduplicates repeated clauses', () => {
  const { patch } = normalizeSkill.execute(ctx('add a logout button. add a logout button.'))
  assert.equal(patch.normalized_task, 'add a logout button')
})

test('normalize is deterministic', () => {
  const a = normalizeSkill.execute(ctx('please fix the bug in auth.ts')).patch.normalized_task
  const b = normalizeSkill.execute(ctx('please fix the bug in auth.ts')).patch.normalized_task
  assert.equal(a, b)
})

test('normalize never yields empty when input is non-empty', () => {
  const { patch } = normalizeSkill.execute(ctx('please'))
  assert.ok((patch.normalized_task ?? '').length > 0)
})
