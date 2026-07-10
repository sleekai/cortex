import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { makeArtifact, isKind } from '../src/artifact/artifacts.js'
import { compressArtifact, compressText } from '../src/runtime/compression.js'
import { createTask } from '../src/runtime/task.js'
import { createWorkingMemory, rememberArtifact } from '../src/runtime/working-memory.js'
import { DEFAULT_BUDGET } from '../src/core/types.js'
import { runExecutionLoop, type Producer } from '../src/loop/loop-engine.js'
import { type UCP } from '../src/packet/ucp.js'

test('runtime task is immutable and preserves ingress identity', () => {
  const task = createTask({ content: 'Fix token accounting in src/kernel/kernel.ts', kind: 'cli', taskId: 't-runtime' })
  assert.equal(task.id, 't-runtime')
  assert.equal(task.raw, 'Fix token accounting in src/kernel/kernel.ts')
  assert.equal(task.source, 'cli')
  assert.equal(Object.isFrozen(task), true)
})

test('compression reports measurable token savings', () => {
  const repeated = Array.from({ length: 200 }, (_, i) => `validation error ${i} cannot find module expensive-history`).join('\n')
  const compressed = compressText(repeated, 80)
  assert.ok(compressed.compressedTokens <= 80)
  assert.ok(compressed.savedTokens > 0)
  assert.ok(compressed.ratio < 1)
})

test('working memory tracks typed evaluation and execution artifacts', () => {
  const task = createTask({ content: 'add tests', kind: 'cli', taskId: 't-memory' })
  const memory = createWorkingMemory(task, DEFAULT_BUDGET)
  const evaluation = makeArtifact('evaluation', task.id, 'evaluator', {
    decision: 'RETRY',
    confidence: 0.4,
    issues: ['missing assertion'],
    missingContext: [],
    compressedText: 'missing assertion',
  })
  const execution = makeArtifact('execution', task.id, 'cuea-loop', {
    accepted: false,
    iterations: 1,
    escalationDepth: 0,
    cost: 1,
    terminationReason: 'retry',
  })
  const next = rememberArtifact(rememberArtifact(memory, evaluation), execution)
  assert.equal(next.artifacts.length, 2)
  assert.equal(next.evaluationHistory.length, 1)
  assert.equal(next.executionHistory.length, 1)
})

test('artifact compression preserves source kind metadata', () => {
  const plan = makeArtifact('plan', 't-plan', 'planner', {
    steps: ['inspect', 'patch', 'test'],
    workerLadder: ['cheap', 'premium'],
    entryTier: 1,
    expectedSpend: 2,
  })
  const compressed = compressArtifact(plan, 20)
  assert.ok(compressed.compressedTokens <= 20)
  assert.ok(compressed.text.includes('inspect') || compressed.text.includes('patch'))
})

test('execution loop emits compressed evaluation artifacts', async () => {
  const packet: UCP = {
    v: 2,
    t: 't-loop-eval',
    act: 'work',
    g: 'fix',
    c: [],
    ctx: { f: [], d: [] },
    r: { out: 'patch', format: 'unified diff' },
  }
  const producer: Producer = async () => ({
    artifact: makeArtifact('patch', packet.t, 'cheap-worker', { diff: 'd', reasoning: 'r' }),
    workerId: 'cheap-worker',
    tier: 1,
    cost: 0.1,
    latencyMs: 1,
    promptTokens: 10,
    completionTokens: 5,
  })
  const result = await runExecutionLoop(packet, [], producer, {
    ladderSize: 1,
    evaluator: () => ({ decision: 'ACCEPT', confidence: 1, issues: [] }),
  })
  const evaluation = result.artifacts.find(a => isKind(a, 'evaluation'))
  assert.ok(evaluation)
  assert.equal(evaluation.body.decision, 'ACCEPT')
  assert.equal(result.state.history[0]!.promptTokens, 10)
})

