import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { makeArtifact } from '../src/artifact/artifacts.js'
import {
  renderArtifact,
  renderBundle,
  renderDispatchSummary,
  renderPlanSummary,
  renderPointerList,
  registerRenderer,
  registeredRenderers,
} from '../src/egress/egress.js'

function cliOpts() {
  return { targetKind: 'cli' as const }
}

function mcpOpts() {
  return { targetKind: 'mcp' as const }
}

test('renderArtifact: patch renders diff with reasoning for CLI', () => {
  const art = makeArtifact('patch', 't1', 'w1', { diff: '--- a/x\n+++ b/x\n+new', reasoning: 'added new line' })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('added new line'))
  assert.ok(out.includes('--- a/x'))
})

test('renderArtifact: patch renders JSON for MCP', () => {
  const art = makeArtifact('patch', 't1', 'w1', { diff: '--- a/x\n+++ b/x', reasoning: 'fix' })
  const out = renderArtifact(art, mcpOpts())
  const parsed = JSON.parse(out)
  assert.equal(parsed.diff, '--- a/x\n+++ b/x')
  assert.equal(parsed.reasoning, 'fix')
})

test('renderArtifact: plan renders numbered steps for CLI', () => {
  const art = makeArtifact('plan', 't1', 'w1', { steps: ['add auth', 'test it', 'deploy'] })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('1. add auth'))
  assert.ok(out.includes('2. test it'))
})

test('renderArtifact: plan renders JSON for MCP', () => {
  const art = makeArtifact('plan', 't1', 'w1', { steps: ['add auth', 'test it'] })
  const out = renderArtifact(art, mcpOpts())
  assert.deepEqual(JSON.parse(out), ['add auth', 'test it'])
})

test('renderArtifact: decision shows Q/A/Why for CLI', () => {
  const art = makeArtifact('decision', 't1', 'oracle', { question: 'use REST?', decision: 'yes', why: 'simpler' })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('use REST?'))
  assert.ok(out.includes('Decision: yes'))
  assert.ok(out.includes('simpler'))
})

test('renderArtifact: review shows verdict and findings for CLI', () => {
  const art = makeArtifact('review', 't1', 'oracle', {
    verdict: 'ISSUES',
    findings: [{ severity: 'R', pointer: 'src/auth.ts:10', finding: 'missing null check' }],
  })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('ISSUES'))
  assert.ok(out.includes('[R]'))
  assert.ok(out.includes('missing null check'))
})

test('renderArtifact: review PASS for CLI', () => {
  const art = makeArtifact('review', 't1', 'oracle', { verdict: 'PASS', findings: [] })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('PASS'))
})

test('renderArtifact: pointer-set joins pointers for CLI', () => {
  const art = makeArtifact('pointer-set', 't1', 'kernel', { pointers: ['src/auth.ts:10', 'src/auth.ts:42'] })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('src/auth.ts:10'))
  assert.ok(out.includes('src/auth.ts:42'))
})

test('renderArtifact: empty pointer-set shows fallback message', () => {
  const art = makeArtifact('pointer-set', 't1', 'kernel', { pointers: [] })
  const out = renderArtifact(art, cliOpts())
  assert.equal(out, 'no pointers found')
})

test('renderArtifact: failure shows type and message for CLI', () => {
  const art = makeArtifact('failure', 't1', 'w1', { reason: 'no diff found', recoverable: true })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('RECOVERABLE'))
  assert.ok(out.includes('no diff found'))
})

test('renderArtifact: unrecoverable failure for CLI', () => {
  const art = makeArtifact('failure', 't1', 'w1', { reason: 'IMPOSSIBLE: bad intent', recoverable: false })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('UNRECOVERABLE'))
  assert.ok(out.includes('IMPOSSIBLE'))
})

test('renderArtifact: test-result shows PASS/FAIL for CLI', () => {
  const art = makeArtifact('test-result', 't1', 'kernel', { passed: true, errors: [], output: 'all ok' })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('PASS'))
})

test('renderArtifact: test-result shows errors for CLI', () => {
  const art = makeArtifact('test-result', 't1', 'kernel', { passed: false, errors: ['test 1 failed'], output: '' })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('FAIL'))
  assert.ok(out.includes('test 1 failed'))
})

test('renderArtifact: token-estimate renders summary for CLI', () => {
  const art = makeArtifact('token-estimate', 't1', 'kernel', { inputTokens: 500, outputTokens: 200, expectedSpend: 0.03 })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('500'))
  assert.ok(out.includes('200'))
  assert.ok(out.includes('0.03'))
})

test('renderArtifact: fallback to JSON for unregistered kind', () => {
  const art = makeArtifact('metric', 't1', 'kernel', { count: 42 })
  const out = renderArtifact(art, cliOpts())
  assert.ok(out.includes('"count"'))
})

test('renderBundle: joins artifacts with separator', () => {
  const a1 = makeArtifact('patch', 't1', 'w1', { diff: 'diff1', reasoning: '' })
  const a2 = makeArtifact('decision', 't1', 'w1', { question: '', decision: 'yes', why: '' })
  const out = renderBundle([a1, a2], cliOpts())
  assert.ok(out.includes('diff1'))
  assert.ok(out.includes('Decision: yes'))
  assert.ok(out.includes('---'))
})

test('renderDispatchSummary: PASS format for CLI', () => {
  const out = renderDispatchSummary({
    kind: 'completed',
    taskId: 't123',
    goal: 'fix login',
    success: true,
    iterations: 2,
    patchLength: 150,
    reasoning: 'fixed null check',
    validationPassed: true,
    validationErrors: [],
  }, cliOpts())
  assert.ok(out.includes('PASS'))
  assert.ok(out.includes('t123'))
  assert.ok(out.includes('fix login'))
  assert.ok(out.includes('150 chars'))
  assert.ok(out.includes('passed'))
  assert.ok(out.includes('═════'))
})

test('renderDispatchSummary: FAIL format with errors for CLI', () => {
  const out = renderDispatchSummary({
    kind: 'completed',
    taskId: 't456',
    goal: 'fix bug',
    success: false,
    iterations: 1,
    patchLength: 0,
    reasoning: '',
    validationPassed: false,
    validationErrors: ['patch apply failed'],
  }, cliOpts())
  assert.ok(out.includes('FAIL'))
  assert.ok(out.includes('patch apply failed'))
  assert.ok(out.includes('none'))
})

test('renderDispatchSummary: includes metadata when requested', () => {
  const out = renderDispatchSummary({
    kind: 'completed',
    taskId: 't1',
    goal: 'fix',
    success: true,
    iterations: 1,
    patchLength: 10,
    reasoning: 'ok',
    validationPassed: true,
    validationErrors: [],
  }, { targetKind: 'cli', includeMetadata: true, metadata: { taskId: 't1', workerId: 'w1', tier: 2, latencyMs: 500 } })
  assert.ok(out.includes('w1'))
  assert.ok(out.includes('tier 2'))
  assert.ok(out.includes('500ms'))
})

test('renderPlanSummary: JSON output for CLI', () => {
  const out = renderPlanSummary({ intent: { taskType: 'patch' }, plan: { tier0: false } }, cliOpts())
  const parsed = JSON.parse(out)
  assert.equal(parsed.intent.taskType, 'patch')
  assert.equal(parsed.plan.tier0, false)
})

test('renderPlanSummary: JSON output for MCP', () => {
  const out = renderPlanSummary({ intent: { taskType: 'patch' }, plan: { tier0: false } }, mcpOpts())
  const parsed = JSON.parse(out)
  assert.equal(parsed.intent.taskType, 'patch')
})

test('renderPointerList: non-empty pointers', () => {
  const out = renderPointerList(['src/auth.ts:10', 'src/auth.ts:42'], cliOpts())
  assert.equal(out, 'src/auth.ts:10\nsrc/auth.ts:42')
})

test('renderPointerList: empty pointers', () => {
  const out = renderPointerList([], cliOpts())
  assert.equal(out, 'no pointers found')
})

test('registerRenderer / registeredRenderers round-trips', () => {
  registerRenderer('test-result', (a, _o) => `custom: ${JSON.stringify(a.body)}`)
  assert.ok(registeredRenderers().includes('test-result'))
})
