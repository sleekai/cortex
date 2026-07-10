// CUEA Router — the only component that decides whether the loop continues,
// escalates, or stops (spec §4, §10). It is a pure function of the current
// ExecutionState and the latest Evaluation; it never runs a worker or judges
// output. Every termination guarantee lives here, which is what makes "no
// uncontrolled recursion" (§10) a property of one small, testable function.
import { type Evaluation } from './evaluator.js'
import { type ExecutionState } from './execution-state.js'

export interface RouterBounds {
  // Spec §6 — mandatory bounds.
  maxIterations: number
  maxEscalationDepth: number
  // Spend ceiling across the whole loop, in relative cost units.
  maxCost: number
  // Two Evaluations whose confidence differs by less than this are "stable" —
  // continuing to loop is judged unlikely to change the verdict.
  confidenceEpsilon: number
  // A retry that neither raised confidence by more than this nor reduced the
  // issue count is "negligible improvement" — the loop is spinning.
  improvementEpsilon: number
}

export const DEFAULT_BOUNDS: RouterBounds = {
  maxIterations: 5,
  maxEscalationDepth: 3,
  maxCost: Number.POSITIVE_INFINITY,
  confidenceEpsilon: 0.02,
  improvementEpsilon: 0.01,
}

export type RouterAction =
  | { action: 'finish'; reason: string; accepted: boolean }
  | { action: 'loop'; reason: string }
  | { action: 'escalate'; reason: string }

// Decide the next move. Called once per iteration, AFTER the attempt has been
// recorded into `state` (so state.history includes the current attempt and
// state.iteration/cost already reflect it).
//
// Precedence is deliberate: a decisive Evaluator verdict (ACCEPT/FINISH) wins
// immediately, then the hard bounds fire (they can only STOP the loop, never
// extend it), then convergence heuristics, and only then are RETRY/ESCALATE
// honored. Bounds are checked before honoring continuation so a RETRY can
// never push past maxIterations.
export function route(state: ExecutionState, evaluation: Evaluation, bounds: RouterBounds = DEFAULT_BOUNDS): RouterAction {
  if (evaluation.decision === 'ACCEPT') {
    return { action: 'finish', reason: 'evaluator accepted output', accepted: true }
  }
  if (evaluation.decision === 'FINISH') {
    return { action: 'finish', reason: 'evaluator finished (no further value)', accepted: false }
  }

  // ── Hard bounds (§6): these only ever terminate ──────────────────────
  if (state.iteration >= bounds.maxIterations) {
    return { action: 'finish', reason: `max iterations (${bounds.maxIterations}) reached`, accepted: false }
  }
  if (state.cost >= bounds.maxCost) {
    return { action: 'finish', reason: `cost ceiling (${bounds.maxCost}) reached`, accepted: false }
  }

  // ── Convergence heuristics (§6): stop a loop that is not progressing ──
  if (isConfidenceStable(state, bounds) || isImprovementNegligible(state, bounds)) {
    return { action: 'finish', reason: 'convergence: confidence/quality plateaued', accepted: false }
  }

  // ── Honor the Evaluator's continuation request within bounds ──────────
  if (evaluation.decision === 'ESCALATE') {
    if (state.escalationDepth >= bounds.maxEscalationDepth) {
      return { action: 'finish', reason: `max escalation depth (${bounds.maxEscalationDepth}) reached`, accepted: false }
    }
    return { action: 'escalate', reason: evaluation.issues[0] ?? 'evaluator requested escalation' }
  }

  // RETRY (default): loop at the same tier with the reported issues as context.
  return { action: 'loop', reason: evaluation.issues[0] ?? 'evaluator requested retry' }
}

// Two consecutive same-tier attempts whose confidence barely moved: the loop
// has converged on a verdict, so more iterations are wasted spend. Restricted
// to same-tier so a same-confidence escalation is never mistaken for a stall
// and escalation can still reach its depth bound.
function isConfidenceStable(state: ExecutionState, bounds: RouterBounds): boolean {
  const h = state.history
  if (h.length < 2) return false
  const last = h[h.length - 1]!
  const prev = h[h.length - 2]!
  if (last.tier !== prev.tier) return false
  return Math.abs(last.confidence - prev.confidence) < bounds.confidenceEpsilon
}

// A retry that neither raised confidence meaningfully nor shrank the issue
// list is spinning in place. Only compares same-tier attempts — an escalation
// legitimately changes the picture and should not be judged as stalling.
function isImprovementNegligible(state: ExecutionState, bounds: RouterBounds): boolean {
  const h = state.history
  if (h.length < 2) return false
  const last = h[h.length - 1]!
  const prev = h[h.length - 2]!
  if (last.tier !== prev.tier) return false
  const confidenceGain = last.confidence - prev.confidence
  const issuesDropped = prev.issues.length - last.issues.length
  return confidenceGain <= bounds.improvementEpsilon && issuesDropped <= 0
}
