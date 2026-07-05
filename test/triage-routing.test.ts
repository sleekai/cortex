import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { routingStage } from '../src/triage/stages/routing.js'
import { emptyPacket, ALL_TIERS } from '../src/triage/packet.js'
import { type UCP } from '../src/packet/ucp.js'
import { DEFAULT_TRIAGE_POLICY, type TriageContext } from '../src/triage/stage.js'

function ctx(normalized: string, score = 1): TriageContext {
  const ucp: UCP = { v: 2, t: 't1', act: 'work', g: normalized, c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'text' } }
  const draft = emptyPacket()
  draft.normalized_task = normalized
  draft.ambiguity = { score, flags: [], questions: [] }
  return { ucp, raw: normalized, draft, policy: DEFAULT_TRIAGE_POLICY }
}

function rec(...args: Parameters<typeof ctx>): string {
  return routingStage.execute(ctx(...args)).patch.worker_recommendation!
}

test('recommendation is always a valid tier', () => {
  assert.ok((ALL_TIERS as readonly string[]).includes(rec('fix the bug in a.ts')))
})

test('browser / human work routes to T4', () => {
  assert.equal(rec('log in to the dashboard in a browser and take a screenshot'), 'T4')
})

test('open-ended work routes to T3', () => {
  assert.equal(rec('migrate the entire codebase across all packages'), 'T3')
})

test('small clear single-file task routes to a low tier', () => {
  assert.equal(rec('fix the null check and update the tests in src/auth.ts'), 'T1')
})

test('pure lookup routes to T0', () => {
  assert.equal(rec('find where budget enforcement happens'), 'T0')
})

test('high ambiguity raises the tier', () => {
  const clear = rec('update the config in server.ts', 1)
  const murky = rec('update the config in server.ts', 0.3)
  assert.notEqual(clear, murky)
})
