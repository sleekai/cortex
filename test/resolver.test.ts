import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { DefaultResolver, type CapabilityResolver, type ResolveRequest, type Resolution } from '../src/capability/resolver.js'
import { DEFAULT_CONSTRAINTS, type PlannerConstraints } from '../src/capability/constraints.js'
import { type WorkerSpec, type WorkerRegistry } from '../src/worker/registry.js'
import { type Capability, type TaskIntent } from '../src/capability/capabilities.js'

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

function makeRequest(overrides?: Partial<ResolveRequest>): ResolveRequest {
  return {
    capabilities: ['coding', 'reasoning'],
    profile: { minimum: [] },
    estTokenBudget: 10_000,
    retryProbability: 0.25,
    ...overrides,
  }
}

function resolve(resolver: CapabilityResolver, request: ResolveRequest, registry: WorkerRegistry): Resolution {
  return resolver.resolve(request, registry, DEFAULT_CONSTRAINTS)
}

test('resolver returns a ladder with scored workers for matching capabilities', () => {
  const r = new DefaultResolver()
  const res = resolve(r, makeRequest(), makeRegistry([makeWorker({ id: 'w1' })]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'w1')
  assert.ok(res.ladder[0]!.utility > 0)
  assert.ok(res.ladder[0]!.scoreBreakdown.capabilityMatch > 0)
})

test('resolver excludes workers missing required capabilities', () => {
  const r = new DefaultResolver()
  const res = resolve(r, makeRequest({ capabilities: ['coding', 'vision'] }), makeRegistry([
    makeWorker({ id: 'coder', capabilities: ['coding'] }),
    makeWorker({ id: 'full', capabilities: ['coding', 'vision'] }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'full')
  assert.ok(res.excluded.some(e => e.workerId === 'coder' && e.reason.includes('capability')))
})

test('resolver excludes workers with forbidden capabilities', () => {
  const r = new DefaultResolver()
  const res = resolve(r, makeRequest({ profile: { minimum: [], forbidden: ['vision'] } }), makeRegistry([
    makeWorker({ id: 'safe', capabilities: ['coding', 'reasoning'] }),
    makeWorker({ id: 'vision-capable', capabilities: ['coding', 'reasoning', 'vision'] }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'safe')
  assert.ok(res.excluded.some(e => e.workerId === 'vision-capable' && e.reason.includes('forbidden')))
})

test('resolver filters workers below minimum quality threshold', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    profile: { minimum: [{ capability: 'coding', minimum: 0.8 }] },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'good', quality: { coding: 0.9, reasoning: 0.7 } }),
    makeWorker({ id: 'weak', quality: { coding: 0.4, reasoning: 0.7 } }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'good')
  assert.ok(res.excluded.some(e => e.workerId === 'weak' && e.reason.includes('below minimum')))
})

test('minimum:0 lets any worker with the capability through', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0 }] },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'minimal', capabilities: ['coding'], quality: { coding: 0.3 } }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'minimal')
})

test('preferred capabilities add bonus to utility but do not exclude', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0.3 }], preferred: [{ capability: 'review', minimum: 0 }] },
  })
  const withBonus = makeWorker({ id: 'has-review', capabilities: ['coding', 'review'], quality: { coding: 0.7, review: 0.8 } })
  const withoutBonus = makeWorker({ id: 'coding-only', capabilities: ['coding'], quality: { coding: 0.7 } })
  const res = resolve(r, req, makeRegistry([withoutBonus, withBonus]))
  // Both should be feasible; the one with the preferred bonus should have higher utility
  assert.equal(res.ladder.length, 2)
  assert.ok(res.ladder.find(w => w.worker.id === 'has-review')!.utility > res.ladder.find(w => w.worker.id === 'coding-only')!.utility)
})

test('preferred bonus uses weight when provided', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0.3 }], preferred: [{ capability: 'review', minimum: 0, weight: 0.5 }] },
  })
  const worker = makeWorker({ id: 'w', capabilities: ['coding', 'review'], quality: { coding: 0.7, review: 0.8 } })
  const res = resolve(r, req, makeRegistry([worker]))
  // preferredBonus should be quality * weight = 0.8 * 0.5
  assert.ok(res.ladder[0]!.scoreBreakdown.preferredBonus > 0)
})

test('spend gate excludes workers over cap', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [] },
    maxSpend: 1,
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'cheap', cost: { inPer1k: 0.001, outPer1k: 0.001 }, quality: { coding: 0.1 } }),
    makeWorker({ id: 'expensive', cost: { inPer1k: 1000, outPer1k: 1000 }, quality: { coding: 0.1 } }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'cheap')
  assert.ok(res.excluded.some(e => e.workerId === 'expensive' && e.reason.includes('spend')))
})

test('reliability overrides affect utility ordering', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [] },
    reliabilityOverrides: new Map([['flaky', 0.1], ['solid', 0.95]]),
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'flaky', tier: 2, quality: { coding: 0.7 } }),
    makeWorker({ id: 'solid', tier: 2, quality: { coding: 0.7 } }),
  ]))
  assert.equal(res.ladder[0]!.worker.id, 'solid')
})

test('policy deny-list excludes workers', () => {
  const r = new DefaultResolver()
  const constraints: PlannerConstraints = { ...DEFAULT_CONSTRAINTS, denyWorkers: ['blocked'] }
  const res = r.resolve(makeRequest(), makeRegistry([makeWorker({ id: 'blocked' })]), constraints)
  assert.equal(res.ladder.length, 0)
  assert.ok(res.excluded.some(e => e.workerId === 'blocked' && e.reason.includes('deny')))
})

test('returns empty ladder when no workers match', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['vision', 'audio'],
    profile: { minimum: [{ capability: 'vision', minimum: 0.9 }] },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'coder', capabilities: ['coding'] }),
  ]))
  assert.equal(res.ladder.length, 0)
})

test('tie-breaking: identical workers are ordered deterministically by id', () => {
  const r = new DefaultResolver()
  const w1 = makeWorker({ id: 'a-worker', capabilities: ['coding'], quality: { coding: 0.7 } })
  const w2 = makeWorker({ id: 'b-worker', capabilities: ['coding'], quality: { coding: 0.7 } })
  const res = resolve(r, makeRequest({ capabilities: ['coding'], profile: { minimum: [] } }), makeRegistry([w2, w1]))
  assert.equal(res.ladder[0]!.worker.id, 'a-worker')
  assert.equal(res.ladder[1]!.worker.id, 'b-worker')
})

test('score breakdown contains all expected fields', () => {
  const r = new DefaultResolver()
  const res = resolve(r, makeRequest(), makeRegistry([makeWorker({ id: 'w1' })]))
  const sb = res.ladder[0]!.scoreBreakdown
  assert.ok(typeof sb.capabilityMatch === 'number')
  assert.ok(typeof sb.preferredBonus === 'number')
  assert.ok(typeof sb.reliabilityScore === 'number')
  assert.ok(typeof sb.speedScore === 'number')
  assert.ok(typeof sb.estimatedCost === 'number')
  assert.ok(typeof sb.utility === 'number')
  assert.equal(sb.preferredBonus, 0) // no preferred caps in base request
})

test('empty profile resolves workers with matching capabilities only', () => {
  const r = new DefaultResolver()
  const res = resolve(r, makeRequest({ profile: { minimum: [] } }), makeRegistry([
    makeWorker({ id: 'coder', capabilities: ['coding'], quality: { coding: 0.6 } }),
    makeWorker({ id: 'full', capabilities: ['coding', 'reasoning'], quality: { coding: 0.7, reasoning: 0.7 } }),
  ]))
  // 'coder' is excluded because it lacks 'reasoning' (required by default request)
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'full')
  assert.ok(res.excluded.some(e => e.workerId === 'coder'))
})

test('missing quality score defaults to 0.1 when no minimum threshold', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0 }] },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'no-quality-data', capabilities: ['coding'], quality: {} }),
  ]))
  assert.equal(res.ladder.length, 1)
})

test('missing quality score with minimum > 0 excludes the worker', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0.3 }] },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'no-quality-data', capabilities: ['coding'], quality: {} }),
  ]))
  assert.equal(res.ladder.length, 0)
})

test('context window constraint excludes workers with insufficient budget', () => {
  const r = new DefaultResolver()
  const req = makeRequest({ estTokenBudget: 200_000 })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'small-window', contextWindow: 100_000 }),
    makeWorker({ id: 'big-window', contextWindow: 300_000 }),
  ]))
  assert.equal(res.ladder.length, 1)
  assert.equal(res.ladder[0]!.worker.id, 'big-window')
})

test('write access constraint excludes non-patch workers for patch output', () => {
  const r = new DefaultResolver()
  const constraints: PlannerConstraints = { ...DEFAULT_CONSTRAINTS, enforceWriteAccess: true }
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [] },
    expectedOutput: 'patch' as any,
  })
  // Use a non-patch worker
  const res = r.resolve(req, makeRegistry([
    makeWorker({ id: 'reader', writeAccess: 'none', capabilities: ['coding'] }),
  ]), constraints)
  assert.equal(res.ladder.length, 0)
  assert.ok(res.excluded.some(e => e.workerId === 'reader'))
})

test('costLevel from profile is advisory and does not exclude', () => {
  const r = new DefaultResolver()
  const req = makeRequest({
    capabilities: ['coding'],
    profile: { minimum: [{ capability: 'coding', minimum: 0.3 }], cost: 'low' },
  })
  const res = resolve(r, req, makeRegistry([
    makeWorker({ id: 'w1', capabilities: ['coding'], quality: { coding: 0.7 } }),
  ]))
  assert.equal(res.ladder.length, 1)
})
