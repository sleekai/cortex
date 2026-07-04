import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { registerHarness, type Harness, type HarnessConfig } from '../src/harness/harness.js'
import { dispatchWithLadder, executePlan, type DispatchNode } from '../src/worker/dispatch.js'
import { type ScoredWorker } from '../src/capability/planner.js'
import { type WorkerSpec } from '../src/worker/registry.js'
import { type UCP } from '../src/packet/ucp.js'
import { isKind } from '../src/artifact/artifacts.js'

// A scriptable fake harness keyed by worker bin name.
const scripts = new Map<string, () => { ok: boolean; output: string; failReason?: string }>()
let invocations: string[] = []

registerHarness('fake', (config) => {
  const key = (config as unknown as { bin: string }).bin
  const harness: Harness = {
    available: () => key !== 'unavailable',
    invoke: async () => {
      invocations.push(key)
      const script = scripts.get(key) ?? (() => ({ ok: true, output: 'ok' }))
      const r = script()
      return { ...r, latencyMs: 1 }
    },
  }
  return harness
})

function fakeWorker(id: string, tier: 1 | 2 | 3, bin = id): ScoredWorker {
  const worker: WorkerSpec = {
    id,
    capabilities: ['coding'],
    harness: { kind: 'fake', bin } as unknown as HarnessConfig,
    cost: { inPer1k: 1, outPer1k: 1 },
    speed: 1,
    contextWindow: 100_000,
    quality: { coding: 0.8 },
    reliability: 0.9,
    tier,
    writeAccess: 'patch',
  }
  return { worker, utility: 1, expectedSpend: 1, justification: 'test' }
}

function workPacket(t: string): UCP {
  return {
    v: 2, t, act: 'work', g: 'fix thing', c: [],
    ctx: { f: [], d: [] }, r: { out: 'patch', format: 'unified diff' },
  }
}

const GOOD_DIFF = '```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n```'

test('successful dispatch returns a patch artifact from the first rung', async () => {
  invocations = []
  scripts.set('cheap', () => ({ ok: true, output: GOOD_DIFF }))
  const result = await dispatchWithLadder(workPacket('t1'), [], [fakeWorker('cheap', 1), fakeWorker('premium', 3)])
  assert.equal(result.workerId, 'cheap')
  assert.ok(isKind(result.artifact, 'patch'))
  assert.deepEqual(invocations, ['cheap'])
})

test('recoverable failure escalates to the next rung', async () => {
  invocations = []
  scripts.set('flaky', () => ({ ok: false, output: '', failReason: 'timeout' }))
  scripts.set('premium', () => ({ ok: true, output: GOOD_DIFF }))
  const result = await dispatchWithLadder(workPacket('t2'), [], [fakeWorker('flaky', 1), fakeWorker('premium', 3)])
  assert.equal(result.workerId, 'premium')
  assert.equal(result.attempts, 2)
  assert.ok(isKind(result.artifact, 'patch'))
})

test('IMPOSSIBLE is unrecoverable — no escalation past it', async () => {
  invocations = []
  scripts.set('honest', () => ({ ok: true, output: 'IMPOSSIBLE: packet lacks the target file' }))
  scripts.set('premium', () => ({ ok: true, output: GOOD_DIFF }))
  const result = await dispatchWithLadder(workPacket('t3'), [], [fakeWorker('honest', 1), fakeWorker('premium', 3)])
  assert.ok(isKind(result.artifact, 'failure'))
  assert.deepEqual(invocations, ['honest'])
})

test('unavailable workers are skipped without counting as attempts', async () => {
  invocations = []
  scripts.set('backup', () => ({ ok: true, output: GOOD_DIFF }))
  const result = await dispatchWithLadder(workPacket('t4'), [], [fakeWorker('down', 1, 'unavailable'), fakeWorker('backup', 2)])
  assert.equal(result.workerId, 'backup')
  assert.equal(result.attempts, 1)
})

test('empty ladder fails cleanly', async () => {
  const result = await dispatchWithLadder(workPacket('t5'), [], [])
  assert.ok(isKind(result.artifact, 'failure'))
  assert.equal(result.attempts, 0)
})

test('metrics fire once per attempt', async () => {
  scripts.set('flaky', () => ({ ok: false, output: '', failReason: 'timeout' }))
  scripts.set('premium', () => ({ ok: true, output: GOOD_DIFF }))
  const metrics: { workerId: string; ok: boolean }[] = []
  await dispatchWithLadder(workPacket('t6'), [], [fakeWorker('flaky', 1), fakeWorker('premium', 3)], {
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    onMetric: (r) => metrics.push({ workerId: r.workerId, ok: r.ok }),
  })
  assert.deepEqual(metrics, [{ workerId: 'flaky', ok: false }, { workerId: 'premium', ok: true }])
})

test('executePlan runs independent nodes and fails dependents of failures', async () => {
  scripts.set('good', () => ({ ok: true, output: GOOD_DIFF }))
  scripts.set('bad', () => ({ ok: true, output: 'IMPOSSIBLE: nope' }))

  const nodes: DispatchNode[] = [
    { id: 'a', packet: workPacket('a'), chunks: [], dependsOn: [] },
    { id: 'b', packet: workPacket('b'), chunks: [], dependsOn: [] },
    { id: 'c', packet: workPacket('c'), chunks: [], dependsOn: ['b'] },
  ]
  const ladders: Record<string, ScoredWorker[]> = {
    a: [fakeWorker('good-a', 1, 'good')],
    b: [fakeWorker('bad-b', 1, 'bad')],
    c: [fakeWorker('good-c', 1, 'good')],
  }
  const results = await executePlan({ nodes, concurrency: 2 }, (n) => ladders[n.id]!)
  assert.ok(isKind(results.get('a')!.artifact, 'patch'))
  assert.ok(isKind(results.get('b')!.artifact, 'failure'))
  const c = results.get('c')!
  assert.ok(isKind(c.artifact, 'failure'))
  assert.equal(c.attempts, 0) // never dispatched — dependency failed
})

test('executePlan detects unsatisfiable dependencies', async () => {
  const nodes: DispatchNode[] = [
    { id: 'x', packet: workPacket('x'), chunks: [], dependsOn: ['ghost'] },
  ]
  const results = await executePlan({ nodes, concurrency: 1 }, () => [])
  assert.ok(isKind(results.get('x')!.artifact, 'failure'))
})
