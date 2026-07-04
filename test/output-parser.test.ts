import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseWorkerOutput } from '../src/worker/output-parser.js'
import { isKind } from '../src/artifact/artifacts.js'
import { type UCP } from '../src/packet/ucp.js'

const work: UCP = { v: 2, t: 't1', act: 'work', g: 'g', c: [], ctx: { f: [], d: [] }, r: { out: 'patch', format: 'unified diff' } }
const ask: UCP = { v: 2, t: 't1', act: 'ask', g: 'g', q: 'which db?', c: [], ctx: { f: [], d: [] }, r: { out: 'decision', format: 'json' } }
const review: UCP = { v: 2, t: 't1', act: 'review', g: 'g', c: [], ctx: { f: [], d: ['diff: unstaged'] }, r: { out: 'review', format: 'json' } }

test('work output: fenced diff becomes a patch artifact', () => {
  const raw = 'Some reasoning first.\n```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```'
  const artifact = parseWorkerOutput(raw, work, 'w1')
  assert.ok(isKind(artifact, 'patch'))
  if (isKind(artifact, 'patch')) {
    assert.ok(artifact.body.diff.startsWith('--- a/x.ts'))
    assert.equal(artifact.body.reasoning, 'Some reasoning first.')
  }
})

test('work output: bare diff without fences still parses', () => {
  const raw = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b'
  const artifact = parseWorkerOutput(raw, work, 'w1')
  assert.ok(isKind(artifact, 'patch'))
})

test('work output: IMPOSSIBLE is an unrecoverable failure', () => {
  const artifact = parseWorkerOutput('IMPOSSIBLE: no target file', work, 'w1')
  assert.ok(isKind(artifact, 'failure'))
  if (isKind(artifact, 'failure')) assert.equal(artifact.body.recoverable, false)
})

test('work output: no diff is a recoverable failure', () => {
  const artifact = parseWorkerOutput('I think you should refactor the module.', work, 'w1')
  assert.ok(isKind(artifact, 'failure'))
  if (isKind(artifact, 'failure')) assert.equal(artifact.body.recoverable, true)
})

test('ask output: decision object becomes a decision artifact', () => {
  const artifact = parseWorkerOutput('{"a":"use postgres","why":"relational fits"}', ask, 'oracle')
  assert.ok(isKind(artifact, 'decision'))
  if (isKind(artifact, 'decision')) {
    assert.equal(artifact.body.decision, 'use postgres')
    assert.equal(artifact.body.question, 'which db?')
  }
})

test('ask output: intent question surfaces as an empty decision', () => {
  const artifact = parseWorkerOutput('{"q":"should deletes be soft or hard?"}', ask, 'oracle')
  assert.ok(isKind(artifact, 'decision'))
  if (isKind(artifact, 'decision')) {
    assert.equal(artifact.body.decision, '')
    assert.equal(artifact.body.question, 'should deletes be soft or hard?')
  }
})

test('review output: findings parse with severities', () => {
  const raw = '{"v":"ISSUES","i":[["R","src/a.ts#L12","sql injection"],["Y","src/b.ts#L3","naming"]]}'
  const artifact = parseWorkerOutput(raw, review, 'oracle')
  assert.ok(isKind(artifact, 'review'))
  if (isKind(artifact, 'review')) {
    assert.equal(artifact.body.verdict, 'ISSUES')
    assert.equal(artifact.body.findings.length, 2)
    assert.equal(artifact.body.findings[0]!.severity, 'R')
  }
})

test('judgment output: JSON wrapped in prose still parses', () => {
  const raw = 'Here is my verdict:\n{"v":"PASS"}\nHope that helps.'
  const artifact = parseWorkerOutput(raw, review, 'oracle')
  assert.ok(isKind(artifact, 'review'))
})

test('judgment output: pure prose is a recoverable failure', () => {
  const artifact = parseWorkerOutput('It looks fine to me overall.', review, 'oracle')
  assert.ok(isKind(artifact, 'failure'))
  if (isKind(artifact, 'failure')) assert.equal(artifact.body.recoverable, true)
})

test('oracle fail is unrecoverable', () => {
  const artifact = parseWorkerOutput('{"fail":"spec too thin to judge"}', ask, 'oracle')
  assert.ok(isKind(artifact, 'failure'))
  if (isKind(artifact, 'failure')) assert.equal(artifact.body.recoverable, false)
})
