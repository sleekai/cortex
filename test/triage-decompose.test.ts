import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { decomposeSkill } from '../src/triage/skills/decompose.js'
import { emptyPacket, MAX_SUBTASKS } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/skill.js'

function ctx(normalized: string): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: normalized, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  const draft = emptyPacket()
  draft.normalized_task = normalized
  return { ucp, raw: normalized, draft, policy: DEFAULT_TRIAGE_POLICY }
}

test('atomic task yields a single subtask', () => {
  const { patch } = decomposeSkill.execute(ctx('fix the null check in auth.ts'))
  assert.equal(patch.subtasks!.length, 1)
  assert.equal(patch.subtasks![0]!.id, 'st1')
  assert.deepEqual(patch.subtasks![0]!.dependencies, [])
})

test('sequential cue creates a dependency edge', () => {
  const { patch } = decomposeSkill.execute(ctx('fix the null check. then update the tests'))
  assert.equal(patch.subtasks!.length, 2)
  assert.deepEqual(patch.subtasks![1]!.dependencies, ['st1'])
})

test('optional cue tags a subtask optional', () => {
  const { patch } = decomposeSkill.execute(ctx('add the endpoint. optionally add a rate limit'))
  const optional = patch.subtasks!.find(s => s.type === 'optional')
  assert.ok(optional, 'expected one optional subtask')
})

test('subtasks are capped at MAX_SUBTASKS', () => {
  const many = Array.from({ length: 12 }, (_, i) => `step number ${i}`).join('. ')
  const { patch } = decomposeSkill.execute(ctx(many))
  assert.ok(patch.subtasks!.length <= MAX_SUBTASKS)
})

test('decompose is deterministic', () => {
  const a = decomposeSkill.execute(ctx('do a. then do b. then do c')).patch.subtasks
  const b = decomposeSkill.execute(ctx('do a. then do b. then do c')).patch.subtasks
  assert.deepEqual(a, b)
})
