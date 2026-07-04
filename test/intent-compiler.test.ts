import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { compileIntent } from '../src/capability/intent-compiler.js'

test('patch requests compile to coding intents with file hints', () => {
  const intent = compileIntent('fix add function in src/math.js, must return sum, tests must pass')
  assert.equal(intent.taskType, 'patch')
  assert.deepEqual(intent.capabilities, ['coding'])
  assert.equal(intent.expectedOutput, 'patch')
  assert.deepEqual(intent.fileHints, ['src/math.js'])
  assert.ok(intent.confidence > 0.5)
})

test('questions compile to reasoning intents', () => {
  const intent = compileIntent('should we use REST or GraphQL for the public API?')
  assert.equal(intent.taskType, 'question')
  assert.ok(intent.capabilities.includes('reasoning'))
  assert.equal(intent.expectedOutput, 'decision')
})

test('review requests compile to review intents requiring a patch artifact', () => {
  const intent = compileIntent('review the diff against the spec')
  assert.equal(intent.taskType, 'review')
  assert.deepEqual(intent.requiredArtifacts, ['patch'])
  assert.equal(intent.expectedOutput, 'review')
})

test('locate requests are tier-0 shaped', () => {
  const intent = compileIntent('find where budget enforcement happens')
  assert.equal(intent.taskType, 'locate')
  assert.equal(intent.estReasoningDepth, 0)
  assert.equal(intent.expectedOutput, 'pointer-set')
})

test('open-ended work is classified open with depth 3', () => {
  const intent = compileIntent('migrate the entire codebase to ESM across all packages')
  assert.equal(intent.complexity, 'open')
  assert.equal(intent.estReasoningDepth, 3)
})

test('typo fixes are trivial', () => {
  const intent = compileIntent('fix typo in README.md')
  assert.equal(intent.complexity, 'trivial')
  assert.ok(intent.estTokenBudget < 2500)
})

test('ambiguous short requests get low confidence', () => {
  const intent = compileIntent('thing broken')
  assert.ok(intent.confidence < 0.5)
})
