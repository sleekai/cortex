// Strategy Sketching (spec §4.4). Emits up to 3 lightweight approach sketches
// — a name, a one-line description, a cost tier, and a risk level. These are
// hints, NOT plans: no steps, no file lists, no solution content.
import { type TriageStage } from '../skill.js'
import { type CtsStrategy } from '../packet.js'
import { MAX_STRATEGIES } from '../packet.js'
import { complexityOf, extractFileTokens, LOCATE_VERBS, PATCH_VERBS } from '../signals.js'

const HEURISTIC: CtsStrategy = {
  name: 'heuristic',
  description: 'Resolve deterministically via rules or retrieval, no model.',
  cost_tier: 'T0',
  risk: 'low',
}
const TOOL_BASED: CtsStrategy = {
  name: 'tool-based',
  description: 'Cheap model with targeted, tool-scoped edits.',
  cost_tier: 'T2',
  risk: 'medium',
}
const LLM_HEAVY: CtsStrategy = {
  name: 'llm-heavy',
  description: 'Premium reasoning model for open-ended synthesis.',
  cost_tier: 'T3',
  risk: 'high',
}

export const strategySkill: TriageStage = {
  name: 'strategy',
  purpose: 'Sketch up to 3 lightweight approach candidates with cost/risk.',
  input_schema: { normalized_task: 'string', subtasks: 'CtsSubtask[]', ambiguity: 'CtsAmbiguity' },
  output_schema: { strategies: 'CtsStrategy[]' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const text = ctx.draft.normalized_task
    const fileCount = extractFileTokens(text).length
    const complexity = complexityOf(text, fileCount, ctx.draft.subtasks.length)
    const ambiguous = ctx.draft.ambiguity.score < 0.6

    const strategies: CtsStrategy[] = []
    // A pure lookup can often be answered without any model at all.
    if (LOCATE_VERBS.test(text) && !PATCH_VERBS.test(text)) strategies.push(HEURISTIC)

    if (complexity === 'trivial') {
      strategies.push(HEURISTIC, TOOL_BASED)
    } else if (complexity === 'bounded') {
      strategies.push(TOOL_BASED, HEURISTIC)
    } else {
      strategies.push(LLM_HEAVY, TOOL_BASED)
    }
    // Ambiguity raises the ceiling: reasoning may be needed to disambiguate.
    if (ambiguous) strategies.push(LLM_HEAVY)

    // Dedup by name, preserve order, cap at 3.
    const seen = new Set<string>()
    const unique = strategies.filter(s => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    return { patch: { strategies: unique.slice(0, MAX_STRATEGIES) } }
  },
}
