import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ambiguitySkill } from '../src/triage/skills/ambiguity.js'
import { emptyPacket } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/skill.js'

function ctx(normalized: string): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: normalized, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  const draft = emptyPacket()
  draft.normalized_task = normalized
  return { ucp, raw: normalized, draft, policy: DEFAULT_TRIAGE_POLICY }
}

test('clear, targeted task scores near 1 with no flags', () => {
  const { patch } = ambiguitySkill.execute(ctx('fix the null check in src/auth.ts and update the tests'))
  assert.equal(patch.ambiguity!.score, 1)
  assert.deepEqual(patch.ambiguity!.flags, [])
})

test('edit verb with no target flags missing-target', () => {
  const { patch } = ambiguitySkill.execute(ctx('please refactor everything to be better'))
  assert.ok(patch.ambiguity!.flags.includes('missing-target'))
  assert.ok(patch.ambiguity!.score < 1)
  assert.equal(patch.ambiguity!.questions.length, patch.ambiguity!.flags.length)
})

test('very short task flags underspecified-goal', () => {
  const { patch } = ambiguitySkill.execute(ctx('fix it'))
  assert.ok(patch.ambiguity!.flags.includes('underspecified-goal'))
})

test('vague quantifier is flagged', () => {
  const { patch } = ambiguitySkill.execute(ctx('update the config and some other stuff in server.ts'))
  assert.ok(patch.ambiguity!.flags.includes('vague-quantifier'))
})

test('score is clamped to [0,1] and deterministic', () => {
  const { patch } = ambiguitySkill.execute(ctx('fix it but somehow add and remove stuff'))
  assert.ok(patch.ambiguity!.score >= 0 && patch.ambiguity!.score <= 1)
  const again = ambiguitySkill.execute(ctx('fix it but somehow add and remove stuff'))
  assert.deepEqual(patch.ambiguity, again.patch.ambiguity)
})
