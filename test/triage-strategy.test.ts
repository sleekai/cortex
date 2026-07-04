import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { strategySkill } from '../src/triage/skills/strategy.js'
import { emptyPacket, MAX_STRATEGIES, ALL_TIERS } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/skill.js'

function ctx(normalized: string, score = 1, subtaskCount = 1): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: normalized, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  const draft = emptyPacket()
  draft.normalized_task = normalized
  draft.ambiguity = { score, flags: [], questions: [] }
  draft.subtasks = Array.from({ length: subtaskCount }, (_, i) => ({ id: `st${i + 1}`, description: 'x', dependencies: [], type: 'required' as const }))
  return { ucp, raw: normalized, draft, policy: DEFAULT_TRIAGE_POLICY }
}

test('emits at least one and at most MAX_STRATEGIES', () => {
  const { patch } = strategySkill.execute(ctx('rename a variable', 1, 1))
  assert.ok(patch.strategies!.length >= 1)
  assert.ok(patch.strategies!.length <= MAX_STRATEGIES)
})

test('open-ended work leans on the reasoning strategy', () => {
  const { patch } = strategySkill.execute(ctx('migrate the entire codebase across all packages', 1, 6))
  assert.ok(patch.strategies!.some(s => s.name === 'llm-heavy'))
})

test('trivial work includes a no-model heuristic strategy', () => {
  const { patch } = strategySkill.execute(ctx('fix a typo in the comment', 1, 1))
  assert.ok(patch.strategies!.some(s => s.name === 'heuristic'))
})

test('strategy names are unique and tiers are valid', () => {
  const { patch } = strategySkill.execute(ctx('update the config in server.ts', 0.4, 2))
  const names = patch.strategies!.map(s => s.name)
  assert.equal(names.length, new Set(names).size)
  for (const s of patch.strategies!) assert.ok((ALL_TIERS as readonly string[]).includes(s.cost_tier))
})

test('descriptions are one line (no plan expansion)', () => {
  const { patch } = strategySkill.execute(ctx('add JWT auth to the server', 1, 2))
  for (const s of patch.strategies!) assert.ok(!s.description.includes('\n') && s.description.length < 120)
})
