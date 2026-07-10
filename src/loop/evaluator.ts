// CUEA Evaluator — validates one Producer output and returns a decision
// (spec §4). The Evaluator judges; it never mutates state, applies patches, or
// picks the next worker. Keeping it a pure function of its inputs is what makes
// the loop deterministic under identical inputs (spec §10): the default
// evaluator reads an artifact and a pre-computed ValidationResult and maps them
// to a decision. Side-effecting judges (running hooks, an LLM-as-judge worker)
// belong in the Producer boundary or a custom Evaluator, not here.
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type ValidationResult } from '../core/types.js'
import { type EvalDecision } from './execution-state.js'

export interface Evaluation {
  decision: EvalDecision
  // Evaluator's certainty in its own verdict, 0..1. The Router watches this
  // for stabilization: a confidence that stops moving means more loops won't.
  confidence: number
  issues: string[]
  // Context-on-demand (MVP §6): needs, not requests. Symbols/files the output
  // failed over; the loop engine consults its context provider (policy-gated)
  // before the next attempt. The Evaluator itself never fetches anything.
  missingContext?: string[]
}

export interface EvaluatorInput {
  output: Artifact
  // Deterministic validation of the output, when the Producer computed one
  // (e.g. applied a patch and ran hooks). Absent for non-patch artifacts.
  validation?: ValidationResult
  attempt: number
}

export type Evaluator = (input: EvaluatorInput) => Evaluation | Promise<Evaluation>

// Default deterministic evaluator. Decision table:
//   failure, recoverable   → ESCALATE  (a stronger worker may succeed)
//   failure, unrecoverable → FINISH    (broken packet; no worker can fix it)
//   patch, validation pass → ACCEPT
//   patch, validation fail → RETRY      (refine at the same tier first)
//   patch, no validation   → ACCEPT     (nothing to check against; trust it)
//   any other artifact     → ACCEPT     (analysis/plan/review are terminal)
export function hookDecisionEvaluator(input: EvaluatorInput): Evaluation {
  const { output, validation } = input

  if (isKind(output, 'failure')) {
    const { reason, recoverable } = output.body
    return recoverable
      ? { decision: 'ESCALATE', confidence: 0.7, issues: [reason] }
      : { decision: 'FINISH', confidence: 0.95, issues: [reason] }
  }

  if (isKind(output, 'patch')) {
    if (!validation) return { decision: 'ACCEPT', confidence: 0.6, issues: [] }
    if (validation.passed) return { decision: 'ACCEPT', confidence: 1, issues: [] }
    // Confidence in a RETRY verdict rises as the error surface shrinks — a
    // single failing hook is a near-miss; a wall of errors is a bad approach.
    const n = validation.errors.length
    const confidence = Math.max(0.2, 1 - Math.min(n, 5) / 5)
    const missing = extractMissingContext(validation.errors)
    return { decision: 'RETRY', confidence, issues: validation.errors, ...(missing.length > 0 ? { missingContext: missing } : {}) }
  }

  return { decision: 'ACCEPT', confidence: 0.8, issues: [] }
}

// Missing-context extraction: validation errors that name an unresolved
// symbol, module, or file are expressed as needs the runtime can act on.
// Deliberately narrow — a wrong guess costs a wasted context fetch, so only
// unambiguous compiler/loader shapes match.
const MISSING_PATTERNS = [
  /cannot find (?:name|module) ['"‘]?([\w./@-]+)/i,
  /['"‘]?([\w./@-]+)['"’]? is not defined/i,
  /no such file or directory[,:]? (?:open )?['"‘]?([\w./@-]+)/i,
  /module not found[^'"]*['"]([\w./@-]+)/i,
]

export function extractMissingContext(errors: string[]): string[] {
  const needs = new Set<string>()
  for (const err of errors) {
    for (const pattern of MISSING_PATTERNS) {
      const m = pattern.exec(err)
      if (m?.[1]) needs.add(m[1])
    }
  }
  return [...needs]
}
