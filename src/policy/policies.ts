// First-class runtime policies (MVP §3). Policies control execution: the
// runtime asks them for decisions instead of embedding those decisions
// directly. Each policy is a plain object — data plus (where a real decision
// exists) a decide function — so any policy is replaceable without touching
// the kernel, the loop engine, or the blueprint runner.
//
// This module deliberately does NOT replace capability/policy.ts (hard
// planner constraints: deny-lists, write access, spend gates). That file
// defines the feasible set for worker selection; this one governs the
// execution lifecycle around it. The two compose: the planner filters
// workers, these policies steer the loop that dispatches them.
import { type RouterBounds, DEFAULT_BOUNDS } from '../loop/router.js'

// How many times a worker may retry at the same tier before the loop stops.
export interface RetryPolicy {
  name: string
  maxIterations: number
}

// How far up the worker ladder the Router may climb.
export interface EscalationPolicy {
  name: string
  maxDepth: number
}

// When ambiguity justifies stopping to ask the human. CTS ambiguity scores
// run 1 (fully clear) → 0 (opaque); a score at or below the threshold
// clarifies. mode 'halt' stops the run and surfaces questions; 'proceed'
// records the questions as an artifact but keeps executing.
export interface ClarificationPolicy {
  name: string
  ambiguityThreshold: number
  mode: 'halt' | 'proceed'
  shouldClarify(ambiguityScore: number): boolean
}

// Context-on-demand (MVP §6): whether mid-loop context fetches are allowed
// and how many a single run may spend.
export interface ContextPolicy {
  name: string
  onDemand: boolean
  maxFetches: number
  shouldFetch(fetchesSoFar: number, needs: string[]): boolean
}

// Spend ceilings across the whole run, in relative cost units / est tokens.
export interface BudgetPolicy {
  name: string
  maxCost: number
  maxInputTokens: number
}

export interface TimeoutPolicy {
  name: string
  workerTimeoutMs: number
}

export interface PolicySet {
  name: string
  retry: RetryPolicy
  escalation: EscalationPolicy
  clarification: ClarificationPolicy
  context: ContextPolicy
  budget: BudgetPolicy
  timeout: TimeoutPolicy
}

function makeClarification(name: string, ambiguityThreshold: number, mode: 'halt' | 'proceed'): ClarificationPolicy {
  return {
    name,
    ambiguityThreshold,
    mode,
    shouldClarify(score: number): boolean {
      return score <= this.ambiguityThreshold
    },
  }
}

function makeContext(name: string, onDemand: boolean, maxFetches: number): ContextPolicy {
  return {
    name,
    onDemand,
    maxFetches,
    shouldFetch(fetchesSoFar: number, needs: string[]): boolean {
      return this.onDemand && needs.length > 0 && fetchesSoFar < this.maxFetches
    },
  }
}

export const DEFAULT_POLICIES: PolicySet = {
  name: 'default',
  retry: { name: 'default-retry', maxIterations: DEFAULT_BOUNDS.maxIterations },
  escalation: { name: 'default-escalation', maxDepth: DEFAULT_BOUNDS.maxEscalationDepth },
  clarification: makeClarification('default-clarification', 0.5, 'halt'),
  context: makeContext('default-context', true, 2),
  budget: { name: 'default-budget', maxCost: Number.POSITIVE_INFINITY, maxInputTokens: 2500 },
  timeout: { name: 'default-timeout', workerTimeoutMs: 180_000 },
}

// The Router's §6 bounds are one *projection* of a policy set — deriving them
// here is what keeps the Router pure and untouched while policies stay the
// single source of truth for execution limits.
export function boundsFromPolicies(policies: PolicySet): RouterBounds {
  return {
    ...DEFAULT_BOUNDS,
    maxIterations: policies.retry.maxIterations,
    maxEscalationDepth: policies.escalation.maxDepth,
    maxCost: policies.budget.maxCost,
  }
}

// Merge per-blueprint (or per-call) overrides over a base set. Shallow per
// policy: an override replaces that policy object wholesale, so a custom
// policy keeps its own decide functions.
export function mergePolicies(base: PolicySet, overrides?: Partial<Omit<PolicySet, 'name'>>): PolicySet {
  if (!overrides) return base
  return { ...base, ...overrides }
}

// ── Named policy-set registry (pluggability seam) ─────────────────────────
// Mirrors the kind-keyed Map + register*/get* pattern used by ingress
// adapters, egress renderers, and triage skills.
const policySets = new Map<string, PolicySet>()

export function registerPolicySet(set: PolicySet): void {
  policySets.set(set.name, set)
}

export function getPolicySet(name: string): PolicySet | undefined {
  return policySets.get(name)
}

export function registeredPolicySets(): PolicySet[] {
  return [...policySets.values()]
}

// Test/isolation hook.
export function clearPolicySets(): void {
  policySets.clear()
  registerBuiltinPolicySets()
}

function registerBuiltinPolicySets(): void {
  registerPolicySet(DEFAULT_POLICIES)
  // Strict: fail fast, never interrupt the human, no context expansion.
  registerPolicySet({
    name: 'strict',
    retry: { name: 'strict-retry', maxIterations: 2 },
    escalation: { name: 'strict-escalation', maxDepth: 1 },
    clarification: makeClarification('strict-clarification', 0.25, 'proceed'),
    context: makeContext('strict-context', false, 0),
    budget: { name: 'strict-budget', maxCost: Number.POSITIVE_INFINITY, maxInputTokens: 1500 },
    timeout: { name: 'strict-timeout', workerTimeoutMs: 60_000 },
  })
  // Generous: let the loop work — more retries, full ladder, eager context.
  registerPolicySet({
    name: 'generous',
    retry: { name: 'generous-retry', maxIterations: 8 },
    escalation: { name: 'generous-escalation', maxDepth: 3 },
    clarification: makeClarification('generous-clarification', 0.6, 'halt'),
    context: makeContext('generous-context', true, 4),
    budget: { name: 'generous-budget', maxCost: Number.POSITIVE_INFINITY, maxInputTokens: 6000 },
    timeout: { name: 'generous-timeout', workerTimeoutMs: 300_000 },
  })
}

registerBuiltinPolicySets()
