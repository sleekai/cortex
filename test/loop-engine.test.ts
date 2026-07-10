import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { runExecutionLoop, type Producer, type ProducerContext } from '../src/loop/loop-engine.js'
import { type Evaluator, type Evaluation } from '../src/loop/evaluator.js'
import { DEFAULT_BOUNDS } from '../src/loop/router.js'
import { makeArtifact } from '../src/artifact/artifacts.js'
import { type UCP } from '../src/packet/ucp.js'

const packet: UCP = {
  v: 2, t: 'task-1', act: 'work', g: 'fix thing', c: [],
  ctx: { f: [], d: [] }, r: { out: 'patch', format: 'unified diff' },
}

// A fake producer that records the rung it was dispatched at and returns a
// synthetic patch — no harness, no disk.
function recordingProducer(seen: number[]): Producer {
  return async (ctx: ProducerContext) => {
    seen.push(ctx.rung)
    return {
      artifact: makeArtifact('patch', packet.t, `w${ctx.rung}`, { diff: 'd', reasoning: 'r' }),
      workerId: `w${ctx.rung}`,
      tier: (ctx.rung + 1),
      cost: 1,
      latencyMs: 1,
    }
  }
}

// An evaluator that plays a fixed script of decisions, then ACCEPTs.
function scriptedEvaluator(script: Evaluation[]): Evaluator {
  let i = 0
  return () => script[i++] ?? { decision: 'ACCEPT', confidence: 1, issues: [] }
}

test('converges in one iteration when the first output is accepted', async () => {
  const seen: number[] = []
  const r = await runExecutionLoop(packet, [], recordingProducer(seen), {
    evaluator: scriptedEvaluator([{ decision: 'ACCEPT', confidence: 1, issues: [] }]),
    ladderSize: 3,
  })
  assert.equal(r.accepted, true)
  assert.equal(r.state.status, 'finished')
  assert.equal(r.state.iteration, 1)
  assert.deepEqual(seen, [0])
})

test('retry then accept runs two iterations at the same rung', async () => {
  const seen: number[] = []
  const r = await runExecutionLoop(packet, [], recordingProducer(seen), {
    evaluator: scriptedEvaluator([
      { decision: 'RETRY', confidence: 0.4, issues: ['bad'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 3,
  })
  assert.equal(r.accepted, true)
  assert.equal(r.state.iteration, 2)
  assert.deepEqual(seen, [0, 0]) // same rung — RETRY does not escalate
})

test('escalation advances the rung and marks status escalated', async () => {
  const seen: number[] = []
  const r = await runExecutionLoop(packet, [], recordingProducer(seen), {
    evaluator: scriptedEvaluator([
      { decision: 'ESCALATE', confidence: 0.6, issues: ['too hard'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 3,
  })
  assert.equal(r.accepted, true)
  assert.equal(r.state.status, 'escalated')
  assert.equal(r.state.escalationDepth, 1)
  assert.deepEqual(seen, [0, 1]) // rung climbed
})

test('halts at max iterations when the loop keeps improving but never accepts', async () => {
  const seen: number[] = []
  // Strictly rising confidence + shrinking issues so convergence never fires;
  // decisions stay RETRY forever → only maxIterations can stop it.
  const script: Evaluation[] = [
    { decision: 'RETRY', confidence: 0.10, issues: ['a', 'b', 'c', 'd', 'e'] },
    { decision: 'RETRY', confidence: 0.30, issues: ['a', 'b', 'c', 'd'] },
    { decision: 'RETRY', confidence: 0.50, issues: ['a', 'b', 'c'] },
    { decision: 'RETRY', confidence: 0.70, issues: ['a', 'b'] },
    { decision: 'RETRY', confidence: 0.90, issues: ['a'] },
    { decision: 'RETRY', confidence: 0.95, issues: [] },
  ]
  const r = await runExecutionLoop(packet, [], recordingProducer(seen), {
    evaluator: scriptedEvaluator(script),
    ladderSize: 3,
  })
  assert.equal(r.accepted, false)
  assert.equal(r.state.iteration, DEFAULT_BOUNDS.maxIterations)
  assert.match(r.terminationReason, /max iterations/)
})

test('exhausting the ladder finishes cleanly', async () => {
  const seen: number[] = []
  const r = await runExecutionLoop(packet, [], recordingProducer(seen), {
    // Always escalate; a single-rung ladder cannot climb.
    evaluator: () => ({ decision: 'ESCALATE', confidence: 0.5, issues: ['harder'] }),
    ladderSize: 1,
  })
  assert.equal(r.accepted, false)
  assert.match(r.terminationReason, /ladder exhausted/)
  assert.deepEqual(seen, [0])
})

test('deterministic under identical inputs', async () => {
  const run = () => runExecutionLoop(packet, [], recordingProducer([]), {
    evaluator: scriptedEvaluator([
      { decision: 'RETRY', confidence: 0.4, issues: ['x'] },
      { decision: 'ESCALATE', confidence: 0.6, issues: ['y'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 3,
  })
  const [a, b] = await Promise.all([run(), run()])
  assert.deepEqual(a.state.history, b.state.history)
  assert.equal(a.terminationReason, b.terminationReason)
  assert.equal(a.state.status, b.state.status)
})
