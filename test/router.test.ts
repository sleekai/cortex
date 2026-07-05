import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { route, DEFAULT_BOUNDS, type RouterBounds } from '../src/loop/router.js'
import {
  initialState,
  recordAttempt,
  type ExecutionState,
  type EvalDecision,
} from '../src/loop/execution-state.js'
import { type Evaluation } from '../src/loop/evaluator.js'
import { makeArtifact } from '../src/artifact/artifacts.js'

const art = makeArtifact('patch', 't', 'w', { diff: 'd', reasoning: 'r' })

// Build a realistic state by replaying attempts through the reducer.
function build(
  attempts: { tier: number; confidence: number; issues: string[]; decision?: EvalDecision; cost?: number }[],
  escalationDepth = 0,
): ExecutionState {
  let s = initialState()
  for (const a of attempts) {
    s = recordAttempt(s, {
      iteration: s.iteration + 1,
      workerId: 'w',
      tier: a.tier,
      decision: a.decision ?? 'RETRY',
      confidence: a.confidence,
      issues: a.issues,
      cost: a.cost ?? 0,
      latencyMs: 1,
    }, art)
  }
  return { ...s, escalationDepth }
}

function ev(decision: EvalDecision, confidence = 0.5, issues: string[] = ['x']): Evaluation {
  return { decision, confidence, issues }
}

test('ACCEPT finishes as accepted', () => {
  const a = route(build([{ tier: 1, confidence: 1, issues: [] }]), ev('ACCEPT', 1, []))
  assert.deepEqual(a, { action: 'finish', reason: 'evaluator accepted output', accepted: true })
})

test('FINISH finishes as not accepted', () => {
  const a = route(build([{ tier: 1, confidence: 0.9, issues: ['broken'] }]), ev('FINISH', 0.9, ['broken']))
  assert.equal(a.action, 'finish')
  assert.equal(a.action === 'finish' && a.accepted, false)
})

test('RETRY loops when progressing and within bounds', () => {
  // Two same-tier attempts with rising confidence and shrinking issues.
  const s = build([
    { tier: 1, confidence: 0.4, issues: ['a', 'b'] },
    { tier: 1, confidence: 0.7, issues: ['a'] },
  ])
  assert.equal(route(s, ev('RETRY', 0.7, ['a'])).action, 'loop')
})

test('ESCALATE advances when under depth bound', () => {
  const s = build([{ tier: 1, confidence: 0.6, issues: ['nope'] }], 0)
  assert.equal(route(s, ev('ESCALATE', 0.6, ['nope'])).action, 'escalate')
})

test('ESCALATE at max depth finishes', () => {
  const s = build([{ tier: 3, confidence: 0.6, issues: ['nope'] }], DEFAULT_BOUNDS.maxEscalationDepth)
  const a = route(s, ev('ESCALATE', 0.6, ['nope']))
  assert.equal(a.action, 'finish')
  assert.match(a.action === 'finish' ? a.reason : '', /escalation depth/)
})

test('max iterations halts even on a RETRY verdict', () => {
  // 5 attempts, each distinct confidence so convergence never fires.
  const s = build([
    { tier: 1, confidence: 0.1, issues: ['a', 'b', 'c', 'd'] },
    { tier: 1, confidence: 0.3, issues: ['a', 'b', 'c'] },
    { tier: 1, confidence: 0.5, issues: ['a', 'b'] },
    { tier: 1, confidence: 0.7, issues: ['a'] },
    { tier: 1, confidence: 0.85, issues: ['a'] },
  ])
  const a = route(s, ev('RETRY', 0.85, ['a']))
  assert.equal(a.action, 'finish')
  assert.match(a.action === 'finish' ? a.reason : '', /max iterations/)
})

test('cost ceiling halts', () => {
  const bounds: RouterBounds = { ...DEFAULT_BOUNDS, maxCost: 5 }
  const s = build([{ tier: 1, confidence: 0.4, issues: ['a'], cost: 6 }])
  const a = route(s, ev('RETRY', 0.4, ['a']), bounds)
  assert.equal(a.action, 'finish')
  assert.match(a.action === 'finish' ? a.reason : '', /cost ceiling/)
})

test('confidence stabilization halts a same-tier loop', () => {
  const s = build([
    { tier: 1, confidence: 0.50, issues: ['a'] },
    { tier: 1, confidence: 0.51, issues: ['a'] }, // Δ 0.01 < epsilon 0.02
  ])
  const a = route(s, ev('RETRY', 0.51, ['a']))
  assert.equal(a.action, 'finish')
  assert.match(a.action === 'finish' ? a.reason : '', /convergence/)
})

test('negligible improvement halts a same-tier loop', () => {
  const s = build([
    { tier: 1, confidence: 0.40, issues: ['a', 'b'] },
    { tier: 1, confidence: 0.404, issues: ['a', 'b'] }, // no gain, no fewer issues
  ])
  const a = route(s, ev('RETRY', 0.404, ['a', 'b']))
  assert.equal(a.action, 'finish')
  assert.match(a.action === 'finish' ? a.reason : '', /convergence/)
})

test('cross-tier confidence coincidence does NOT stall escalation', () => {
  // Same confidence but different tiers: an escalation, not a stall.
  const s = build([
    { tier: 1, confidence: 0.7, issues: ['nope'] },
    { tier: 2, confidence: 0.7, issues: ['nope'] },
  ], 1)
  assert.equal(route(s, ev('ESCALATE', 0.7, ['nope'])).action, 'escalate')
})
