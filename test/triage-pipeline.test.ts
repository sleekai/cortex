import { test } from 'node:test'
import * as assert from 'node:assert/strict'
// Side-effect: register the built-in skills.
import '../src/triage/stages/builtins.js'
import { runTriage, STAGE_ORDER } from '../src/triage/pipeline.js'
import { registeredStages } from '../src/triage/registry.js'
import { validateCtsPacket } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'

function input(content: string): { ucp: UCP; raw: string } {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: content, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  return { ucp, raw: content }
}

test('all built-in skills are registered', () => {
  const names = registeredStages().map(s => s.name).sort()
  assert.deepEqual(names, [...STAGE_ORDER].sort())
})

test('runTriage produces a valid, fully-populated packet', () => {
  const p = runTriage(input('add JWT auth to the Express server in src/server.ts'))
  assert.ok(validateCtsPacket(p).valid)
  assert.ok(p.normalized_task.length > 0)
})

test('runTriage is deterministic across runs', () => {
  const a = runTriage(input('refactor the parser and then update the docs'))
  const b = runTriage(input('refactor the parser and then update the docs'))
  assert.deepEqual(a, b)
})

test('policy can disable a skill (ambiguity)', () => {
  const p = runTriage(input('fix it'), { disabledStages: ['ambiguity'] })
  // ambiguity stage skipped → draft keeps the clean default (score 1, no flags)
  assert.equal(p.ambiguity.score, 1)
  assert.deepEqual(p.ambiguity.flags, [])
})

test('normalizes noise and routes a multi-clause task (end-to-end)', () => {
  const p = runTriage(input('please, could you fix the null check and then also update the tests in src/auth.ts'))
  assert.ok(!/please|could you/i.test(p.normalized_task))
  assert.ok(!p.ambiguity.flags.includes('missing-target')) // src/auth.ts is a target
  assert.equal(p.worker_recommendation, 'T1')
})
