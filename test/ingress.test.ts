import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { normalizeInput, registerAdapter, getAdapter, registeredAdapters, type RawInput, type HarnessAdapter } from '../src/ingress/ingress.js'
import { type Artifact } from '../src/artifact/artifacts.js'

test('normalizeInput: wraps content in a UCP packet with source metadata', () => {
  const packet = normalizeInput({ content: 'fix the null check in auth.ts', kind: 'cli' })
  assert.equal(packet.source, 'cli')
  assert.equal(packet.rawContent, 'fix the null check in auth.ts')
  assert.ok(packet.ucp.t.startsWith('in-'))
  assert.equal(packet.ucp.act, 'work')
  assert.ok(packet.ucp.g.includes('null check'))
  assert.equal(packet.preClassified.likelyType, 'work')
})

test('normalizeInput: strips noise from goal via compressGoal', () => {
  const packet = normalizeInput({ content: 'Fix the login form. Must not break existing tests.', kind: 'cli' })
  assert.ok(!packet.ucp.g.includes('the'))
  assert.ok(packet.ucp.c.some(c => c.includes('not break existing tests')))
})

test('normalizeInput: review-like input gets pre-classified as review', () => {
  const packet = normalizeInput({ content: 'Review the auth middleware for security issues', kind: 'cli' })
  assert.equal(packet.preClassified.likelyType, 'review')
  assert.equal(packet.preClassified.confidence, 0.7)
})

test('normalizeInput: question-like input gets pre-classified as ask', () => {
  const packet = normalizeInput({ content: 'How does token validation work?', kind: 'cli' })
  assert.equal(packet.preClassified.likelyType, 'ask')
  assert.equal(packet.preClassified.confidence, 0.6)
})

test('normalizeInput: carries explicit sessionId when provided', () => {
  const packet = normalizeInput({ content: 'fix bug', kind: 'mcp', sessionId: 'sess-001' })
  assert.equal(packet.sessionId, 'sess-001')
})

test('normalizeInput: uses explicit goal when provided', () => {
  const packet = normalizeInput({ content: 'fix the whole thing', kind: 'cli', explicitGoal: 'fix login validation' })
  assert.ok(packet.ucp.g.includes('fix login'))
})

test('normalizeInput: uses provided taskId', () => {
  const packet = normalizeInput({ content: 'fix bug', kind: 'cli', taskId: 'my-custom-id' })
  assert.equal(packet.ucp.t, 'my-custom-id')
})

test('normalizeInput: carries metadata', () => {
  const packet = normalizeInput({ content: 'fix bug', kind: 'ide', metadata: { project: 'cortex', workspace: 'sleekai' } })
  assert.equal(packet.metadata.project, 'cortex')
})

test('registerAdapter / getAdapter round-trips', () => {
  const adapter: HarnessAdapter = {
    kind: 'opencode',
    description: 'OpenCode harness adapter',
    normalize(raw) {
      return normalizeInput(raw)
    },
    renderOutput(_artifact: Artifact) {
      return 'opencode output'
    },
    renderBundle(_artifacts: Artifact[]) {
      return 'opencode bundle'
    },
    supportedFormats() {
      return [{ kind: 'markdown', mimeType: 'text/markdown' }]
    },
  }
  registerAdapter(adapter)
  const retrieved = getAdapter('opencode')
  assert.ok(retrieved)
  assert.equal(retrieved!.kind, 'opencode')
  assert.equal(retrieved!.description, 'OpenCode harness adapter')
})

test('registeredAdapters includes built-in + custom', () => {
  const kinds = registeredAdapters().map(a => a.kind)
  assert.ok(kinds.includes('opencode'))
})

test('normalizeInput: different harness kinds produce correct metadata', () => {
  const sources: Array<{ kind: RawInput['kind']; label: string }> = [
    { kind: 'cli', label: 'cli' },
    { kind: 'mcp', label: 'mcp' },
    { kind: 'opencode', label: 'opencode' },
    { kind: 'ide', label: 'ide' },
    { kind: 'web-browser', label: 'web-browser' },
    { kind: 'http', label: 'http' },
  ]
  for (const s of sources) {
    const packet = normalizeInput({ content: 'test task', kind: s.kind })
    assert.equal(packet.source, s.kind)
  }
})
