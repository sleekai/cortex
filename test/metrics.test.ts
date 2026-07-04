import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendMetric, readMetrics, aggregateStats, blendedReliability, reliabilityOverrides, type MetricRecord } from '../src/state/metrics.js'

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-metrics-'))
}

function record(workerId: string, ok: boolean, iterations = 1): MetricRecord {
  return {
    at: new Date().toISOString(),
    taskId: 't1',
    workerId,
    tier: 2,
    act: 'work',
    ok,
    latencyMs: 100,
    estInputTokens: 500,
    estOutputTokens: 200,
    iterations,
  }
}

test('append + read round-trips and skips malformed lines', () => {
  const root = tmpProject()
  appendMetric(root, record('w1', true))
  appendMetric(root, record('w1', false))
  fs.appendFileSync(path.join(root, '.cortex', 'metrics.jsonl'), 'garbage line\n')
  const records = readMetrics(root)
  assert.equal(records.length, 2)
})

test('aggregateStats computes success and retry rates', () => {
  const stats = aggregateStats([
    record('w1', true), record('w1', true), record('w1', false, 2),
    record('w2', false),
  ])
  const w1 = stats.get('w1')!
  assert.equal(w1.dispatches, 3)
  assert.ok(Math.abs(w1.successRate - 2 / 3) < 0.001)
  assert.ok(Math.abs(w1.retryRate - 1 / 3) < 0.001)
  assert.equal(stats.get('w2')!.successRate, 0)
})

test('blended reliability moves from prior toward observations with volume', () => {
  const fewObservations = blendedReliability(0.9, {
    workerId: 'w', dispatches: 2, successes: 0, successRate: 0,
    meanLatencyMs: 0, meanInputTokens: 0, retryRate: 0,
  })
  const manyObservations = blendedReliability(0.9, {
    workerId: 'w', dispatches: 200, successes: 0, successRate: 0,
    meanLatencyMs: 0, meanInputTokens: 0, retryRate: 0,
  })
  assert.ok(fewObservations > 0.7) // prior dominates
  assert.ok(manyObservations < 0.1) // evidence dominates
  assert.equal(blendedReliability(0.9, undefined), 0.9)
})

test('reliabilityOverrides blends priors with recorded metrics', () => {
  const root = tmpProject()
  for (let i = 0; i < 20; i++) appendMetric(root, record('w1', false))
  const overrides = reliabilityOverrides(root, new Map([['w1', 0.9], ['w2', 0.8]]))
  assert.ok(overrides.get('w1')! < 0.5)
  assert.equal(overrides.get('w2'), 0.8)
})
