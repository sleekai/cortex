// Context-on-demand (MVP §6): the Evaluator expresses needs, the loop engine
// consults its context provider, and the refreshed chunks reach the next
// attempt as a full packet (not an errors-only retry).
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { runExecutionLoop, type Producer, type ProducerContext } from '../src/loop/loop-engine.js'
import { type Evaluation, type Evaluator, extractMissingContext, hookDecisionEvaluator } from '../src/loop/evaluator.js'
import { makeArtifact } from '../src/artifact/artifacts.js'
import { type UCP } from '../src/packet/ucp.js'
import { type CodeChunk } from '../src/core/types.js'

const packet: UCP = {
  v: 2, t: 'task-ctx', act: 'work', g: 'fix thing', c: [],
  ctx: { f: [], d: [] }, r: { out: 'patch', format: 'unified diff' },
}

function chunk(name: string): CodeChunk {
  return { file: `${name}.ts`, name, kind: 'function', source: `function ${name}() {}`, startLine: 1, endLine: 1, signature: `${name}()`, score: 1 }
}

function scriptedEvaluator(script: Evaluation[]): Evaluator {
  let i = 0
  return () => script[i++] ?? { decision: 'ACCEPT', confidence: 1, issues: [] }
}

function recordingProducer(seen: ProducerContext[]): Producer {
  return async (ctx) => {
    seen.push(ctx)
    return {
      artifact: makeArtifact('patch', packet.t, 'w0', { diff: 'd', reasoning: 'r' }),
      workerId: 'w0',
      tier: 1,
      cost: 1,
      latencyMs: 1,
    }
  }
}

test('missing context triggers the provider; next attempt sees merged chunks', async () => {
  const seen: ProducerContext[] = []
  const asked: string[][] = []
  const r = await runExecutionLoop(packet, [chunk('a')], recordingProducer(seen), {
    evaluator: scriptedEvaluator([
      { decision: 'RETRY', confidence: 0.4, issues: ['cannot find name authFlow'], missingContext: ['authFlow'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 2,
    contextProvider: async (needs, current) => {
      asked.push(needs)
      return [...current, chunk('authFlow')]
    },
  })
  assert.equal(r.accepted, true)
  assert.deepEqual(asked, [['authFlow']])
  assert.equal(seen.length, 2)
  assert.equal(seen[0]!.chunks.length, 1)
  assert.equal(seen[1]!.chunks.length, 2) // merged context reached the retry
  assert.equal(seen[1]!.contextRefreshed, true) // producer told to resend full packet
})

test('provider returning current chunks unchanged is a policy "no"', async () => {
  const seen: ProducerContext[] = []
  const r = await runExecutionLoop(packet, [chunk('a')], recordingProducer(seen), {
    evaluator: scriptedEvaluator([
      { decision: 'RETRY', confidence: 0.4, issues: ['cannot find name x'], missingContext: ['x'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 2,
    contextProvider: async (_needs, current) => current, // policy declined
  })
  assert.equal(r.accepted, true)
  assert.equal(seen[1]!.contextRefreshed ?? false, false)
  assert.equal(seen[1]!.chunks.length, 1)
})

test('no provider means behavior is unchanged', async () => {
  const seen: ProducerContext[] = []
  const r = await runExecutionLoop(packet, [chunk('a')], recordingProducer(seen), {
    evaluator: scriptedEvaluator([
      { decision: 'RETRY', confidence: 0.4, issues: ['bad'], missingContext: ['whatever'] },
      { decision: 'ACCEPT', confidence: 1, issues: [] },
    ]),
    ladderSize: 2,
  })
  assert.equal(r.accepted, true)
  assert.equal(seen[1]!.chunks.length, 1)
})

test('extractMissingContext recognizes unresolved symbol/module/file shapes', () => {
  assert.deepEqual(extractMissingContext(["error TS2304: cannot find name 'authFlow'"]), ['authFlow'])
  assert.deepEqual(extractMissingContext(["Cannot find module './lib/session'"]), ['./lib/session'])
  assert.deepEqual(extractMissingContext(['ReferenceError: validateToken is not defined']), ['validateToken'])
  assert.deepEqual(extractMissingContext(['everything passed except style']), [])
})

test('default evaluator surfaces missing context on failed patch validation', () => {
  const artifact = makeArtifact('patch', packet.t, 'w0', { diff: 'd', reasoning: 'r' })
  const evaluation = hookDecisionEvaluator({
    output: artifact,
    validation: { passed: false, errors: ["src/x.ts(3,5): error TS2304: cannot find name 'sessionStore'"], output: '', iteration: 1 },
    attempt: 0,
  })
  assert.equal(evaluation.decision, 'RETRY')
  assert.deepEqual(evaluation.missingContext, ['sessionStore'])
})
