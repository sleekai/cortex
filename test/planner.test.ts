import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { planDispatch } from '../src/capability/planner.js'
import { DEFAULT_POLICY, checkPolicy, type Policy } from '../src/capability/policy.js'
import { compileIntent } from '../src/capability/intent-compiler.js'
import { type WorkerSpec, type WorkerRegistry } from '../src/worker/registry.js'
import { type Capability } from '../src/capability/capabilities.js'

function makeWorker(overrides: Partial<WorkerSpec> & { id: string }): WorkerSpec {
  return {
    capabilities: ['coding', 'reasoning'],
    harness: { kind: 'cli', bin: 'true', args: [], stripEnv: [], promptVia: 'stdin', probeArgs: ['--version'] },
    cost: { inPer1k: 1, outPer1k: 2 },
    speed: 1,
    contextWindow: 100_000,
    quality: { coding: 0.7, reasoning: 0.7 },
    reliability: 0.9,
    tier: 2,
    writeAccess: 'patch',
    ...overrides,
  }
}

function makeRegistry(workers: WorkerSpec[]): WorkerRegistry {
  return {
    workers,
    byId: (id) => workers.find(w => w.id === id),
    withCapabilities: (required: Capability[]) =>
      workers.filter(w => required.every(c => w.capabilities.includes(c))),
  }
}

test('locate intents short-circuit to tier 0 — no workers consulted', () => {
  const plan = planDispatch(compileIntent('find where auth happens'), makeRegistry([makeWorker({ id: 'w1' })]))
  assert.equal(plan.tier0, true)
  assert.equal(plan.ladder.length, 0)
})

test('the ladder starts cheap and escalates upward', () => {
  const small = makeWorker({ id: 'small', tier: 1, cost: { inPer1k: 0.1, outPer1k: 0.2 }, quality: { coding: 0.5, reasoning: 0.4 } })
  const mid = makeWorker({ id: 'mid', tier: 2 })
  const premium = makeWorker({ id: 'premium', tier: 3, cost: { inPer1k: 3, outPer1k: 15 }, quality: { coding: 0.95, reasoning: 0.95 } })
  const plan = planDispatch(
    compileIntent('fix null check in src/auth.ts, tests must pass'),
    makeRegistry([premium, small, mid]),
  )
  assert.equal(plan.tier0, false)
  // bounded complexity → entry tier 2: mid first, premium only as escalation
  assert.equal(plan.ladder[0]!.worker.id, 'mid')
  assert.equal(plan.ladder.at(-1)!.worker.id, 'premium')
})

test('open-ended intents enter at the premium tier', () => {
  const small = makeWorker({ id: 'small', tier: 1 })
  const premium = makeWorker({ id: 'premium', tier: 3 })
  const plan = planDispatch(
    compileIntent('redesign the entire persistence layer across all modules'),
    makeRegistry([small, premium]),
  )
  assert.equal(plan.entryTier, 3)
  assert.equal(plan.ladder[0]!.worker.id, 'premium')
})

test('workers missing capabilities are excluded with a reason', () => {
  const noReview = makeWorker({ id: 'coder-only', capabilities: ['coding'] })
  const plan = planDispatch(compileIntent('review the diff against the spec'), makeRegistry([noReview]))
  assert.equal(plan.ladder.length, 0)
  assert.ok(plan.excluded.some(e => e.workerId === 'coder-only' && e.reason.includes('capability')))
})

test('policy: patch intents require patch write access', () => {
  const readOnly = makeWorker({ id: 'reader', writeAccess: 'none' })
  const verdict = checkPolicy(readOnly, compileIntent('fix bug in src/a.ts'), DEFAULT_POLICY)
  assert.equal(verdict.allowed, false)
})

test('policy: deny list and spend cap exclude workers', () => {
  const w = makeWorker({ id: 'expensive', cost: { inPer1k: 1000, outPer1k: 1000 } })
  const denied: Policy = { ...DEFAULT_POLICY, denyWorkers: ['expensive'] }
  assert.equal(checkPolicy(w, compileIntent('fix bug in src/a.ts'), denied).allowed, false)

  const plan = planDispatch(compileIntent('fix bug in src/a.ts'), makeRegistry([w]), DEFAULT_POLICY, undefined, undefined, undefined, 0.01)
  assert.equal(plan.ladder.length, 0)
  assert.ok(plan.excluded.some(e => e.reason.includes('spend')))
})

test('reliability overrides shift utility ordering within a tier', () => {
  const flaky = makeWorker({ id: 'flaky', tier: 2 })
  const solid = makeWorker({ id: 'solid', tier: 2 })
  const overrides = new Map([['flaky', 0.1], ['solid', 0.95]])
  const plan = planDispatch(
    compileIntent('fix bug in src/a.ts, tests must pass'),
    makeRegistry([flaky, solid]),
    DEFAULT_POLICY,
    overrides,
  )
  assert.equal(plan.ladder[0]!.worker.id, 'solid')
})
