import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  DEFAULT_POLICIES,
  boundsFromPolicies,
  mergePolicies,
  getPolicySet,
  registerPolicySet,
  registeredPolicySets,
  clearPolicySets,
  type PolicySet,
} from '../src/policy/policies.js'
import { DEFAULT_BOUNDS } from '../src/loop/router.js'

test('built-in policy sets are registered: default, strict, generous', () => {
  assert.ok(getPolicySet('default'))
  assert.ok(getPolicySet('strict'))
  assert.ok(getPolicySet('generous'))
})

test('boundsFromPolicies projects retry/escalation/budget into RouterBounds', () => {
  const bounds = boundsFromPolicies(DEFAULT_POLICIES)
  assert.equal(bounds.maxIterations, DEFAULT_POLICIES.retry.maxIterations)
  assert.equal(bounds.maxEscalationDepth, DEFAULT_POLICIES.escalation.maxDepth)
  assert.equal(bounds.maxCost, DEFAULT_POLICIES.budget.maxCost)
  // Convergence epsilons keep the router defaults.
  assert.equal(bounds.confidenceEpsilon, DEFAULT_BOUNDS.confidenceEpsilon)
})

test('clarification policy decides from ambiguity score against its threshold', () => {
  const c = DEFAULT_POLICIES.clarification
  assert.equal(c.shouldClarify(c.ambiguityThreshold - 0.01), true)
  assert.equal(c.shouldClarify(c.ambiguityThreshold), true) // at-or-below clarifies
  assert.equal(c.shouldClarify(c.ambiguityThreshold + 0.01), false)
  assert.equal(c.shouldClarify(1), false)
})

test('context policy gates on-demand fetches by count and needs', () => {
  const ctx = DEFAULT_POLICIES.context
  assert.equal(ctx.shouldFetch(0, ['auth flow']), true)
  assert.equal(ctx.shouldFetch(ctx.maxFetches, ['auth flow']), false)
  assert.equal(ctx.shouldFetch(0, []), false)

  const strict = getPolicySet('strict')!
  assert.equal(strict.context.shouldFetch(0, ['auth flow']), false)
})

test('mergePolicies overrides whole policy objects, keeps the rest', () => {
  const merged = mergePolicies(DEFAULT_POLICIES, {
    retry: { name: 'custom-retry', maxIterations: 9 },
  })
  assert.equal(merged.retry.maxIterations, 9)
  assert.equal(merged.escalation.maxDepth, DEFAULT_POLICIES.escalation.maxDepth)
  assert.equal(merged.clarification, DEFAULT_POLICIES.clarification)
})

test('custom policy sets register and clearPolicySets restores built-ins', () => {
  const custom: PolicySet = {
    ...DEFAULT_POLICIES,
    name: 'my-custom',
    retry: { name: 'my-retry', maxIterations: 1 },
  }
  registerPolicySet(custom)
  assert.equal(getPolicySet('my-custom')?.retry.maxIterations, 1)

  clearPolicySets()
  assert.equal(getPolicySet('my-custom'), undefined)
  assert.ok(registeredPolicySets().length >= 3)
})
