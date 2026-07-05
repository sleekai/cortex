// Routing Advisor (spec §4.5). Recommends a worker tier T0–T4. This is a HINT
// for the scheduler, not a selection — CTS never picks a worker or dispatches.
import { type TriageStage } from '../skill.js'
import { type CtsTier } from '../packet.js'
import { complexityOf, extractFileTokens, splitClauses, HUMAN_SIGNALS, LOCATE_VERBS, PATCH_VERBS } from '../signals.js'

const ORDER: CtsTier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

function bump(tier: CtsTier, by: number): CtsTier {
  const idx = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(tier) + by))
  return ORDER[idx]!
}

export const routingSkill: TriageStage = {
  name: 'routing',
  purpose: 'Recommend a worker tier hint (T0–T4) for the scheduler.',
  input_schema: { normalized_task: 'string', ambiguity: 'CtsAmbiguity' },
  output_schema: { worker_recommendation: 'CtsTier' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const text = ctx.draft.normalized_task
    const fileCount = extractFileTokens(text).length
    // Clause count stands in for task breadth (the decompose stage that once
    // supplied a subtask count was removed — output had no reader).
    const clauseCount = Math.max(1, splitClauses(text).length)
    const complexity = complexityOf(text, fileCount, clauseCount)
    const score = ctx.draft.ambiguity.score

    // Human-in-loop / browser work overrides everything.
    if (HUMAN_SIGNALS.some(rx => rx.test(text))) {
      return { patch: { worker_recommendation: 'T4' } }
    }

    // A pure lookup with no edit is deterministic retrieval — no model needed.
    // Deterministic retrieval degrades gracefully, so the tier hint holds even
    // when the search is broad; only ambiguity (below) can raise it.
    let tier: CtsTier
    if (LOCATE_VERBS.test(text) && !PATCH_VERBS.test(text)) {
      tier = 'T0'
    } else if (complexity === 'trivial') {
      tier = 'T1'
    } else if (complexity === 'open') {
      tier = 'T3'
    } else {
      // bounded: a small, clear, few-file task is cheap (T1); otherwise mid (T2).
      tier = score >= 0.7 && fileCount <= 2 && clauseCount <= 3 ? 'T1' : 'T2'
    }

    // High ambiguity needs stronger reasoning to resolve — raise one tier.
    if (score < 0.5) tier = bump(tier, 1)
    return { patch: { worker_recommendation: tier } }
  },
}
