import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { registerHarness, type Harness, type HarnessConfig } from '../src/harness/harness.js'
import { dispatchOne } from '../src/worker/dispatch.js'
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

test('dispatchOne returns a patch artifact from a successful worker', async () => {
  invocations = []
  scripts.set('cheap', () => ({ ok: true, output: GOOD_DIFF }))
  const worker = fakeWorker('cheap', 1)
  const result = await dispatchOne(workPacket('t1'), [], worker)
  assert.equal(result.workerId, 'cheap')
  assert.ok(isKind(result.artifact, 'patch'))
  assert.equal(result.attempts, 1)
  assert.deepEqual(invocations, ['cheap'])
})

test('dispatchOne returns a failure when the harness is unavailable', async () => {
  invocations = []
  const worker = fakeWorker('down', 1, 'unavailable')
  const result = await dispatchOne(workPacket('t2'), [], worker)
  assert.ok(isKind(result.artifact, 'failure'))
  assert.equal(result.attempts, 0)
  assert.deepEqual(invocations, [])
})

test('dispatchOne fires a metric callback', async () => {
  const metrics: { workerId: string; ok: boolean }[] = []
  scripts.set('good', () => ({ ok: true, output: GOOD_DIFF }))
  const worker = fakeWorker('good-w', 1, 'good')
  await dispatchOne(workPacket('t-metric'), [], worker, {
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    onMetric: (r) => metrics.push({ workerId: r.workerId, ok: r.ok }),
  })
  assert.deepEqual(metrics, [{ workerId: 'good-w', ok: true }])
})
