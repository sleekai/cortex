import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { contextFilterSkill } from '../src/triage/skills/context-filter.js'
import { emptyPacket } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/skill.js'

function ctx(raw: string, normalized: string): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: normalized, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  const draft = emptyPacket()
  draft.normalized_task = normalized
  return { ucp, raw, draft, policy: DEFAULT_TRIAGE_POLICY }
}

test('required includes file tokens and identifiers', () => {
  const { patch } = contextFilterSkill.execute(ctx('fix validateToken in src/auth.ts', 'fix validateToken in src/auth.ts'))
  assert.ok(patch.context_hints!.required.includes('src/auth.ts'))
  assert.ok(patch.context_hints!.required.includes('validateToken'))
})

test('ignore lists noise categories detected in raw input', () => {
  const { patch } = contextFilterSkill.execute(ctx('Hi, please just fix the bug in a.ts', 'fix the bug in a.ts'))
  assert.ok(patch.context_hints!.ignore.includes('greeting preamble'))
  assert.ok(patch.context_hints!.ignore.includes('politeness phrasing'))
  assert.ok(patch.context_hints!.ignore.includes('conversational filler'))
})

test('clean input produces no ignore boundaries', () => {
  const { patch } = contextFilterSkill.execute(ctx('fix the bug in a.ts', 'fix the bug in a.ts'))
  assert.deepEqual(patch.context_hints!.ignore, [])
})

test('context-filter is deterministic', () => {
  const a = contextFilterSkill.execute(ctx('update handleClick in ui.ts', 'update handleClick in ui.ts')).patch.context_hints
  const b = contextFilterSkill.execute(ctx('update handleClick in ui.ts', 'update handleClick in ui.ts')).patch.context_hints
  assert.deepEqual(a, b)
})
