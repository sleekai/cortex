import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { makeArtifact, isArtifact, isKind } from '../src/artifact/artifacts.js'

test('makeArtifact produces a well-formed artifact', () => {
  const a = makeArtifact('patch', 't123', 'claude-cli', { diff: '--- a/x\n+++ b/x', reasoning: 'small fix' })
  assert.equal(a.kind, 'patch')
  assert.equal(a.taskId, 't123')
  assert.equal(a.producedBy, 'claude-cli')
  assert.ok(a.id.startsWith('patch-'))
  assert.ok(isArtifact(a))
})

test('isKind narrows the union', () => {
  const a = makeArtifact('review', 't1', 'oracle', { verdict: 'PASS', findings: [] })
  assert.ok(isKind(a, 'review'))
  assert.ok(!isKind(a, 'patch'))
  if (isKind(a, 'review')) {
    assert.equal(a.body.verdict, 'PASS')
  }
})

test('isArtifact rejects malformed input', () => {
  assert.equal(isArtifact(null), false)
  assert.equal(isArtifact({ id: 'x' }), false)
  assert.equal(isArtifact(42), false)
})
