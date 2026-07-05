import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  renderDispatchSummary,
  renderPlanSummary,
  renderPointerList,
} from '../src/egress/egress.js'

function cliOpts() {
  return { targetKind: 'cli' as const }
}

function mcpOpts() {
  return { targetKind: 'mcp' as const }
}

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
