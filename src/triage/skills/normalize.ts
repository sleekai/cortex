// Task Normalizer (spec §4.1). Strips conversational noise, collapses
// whitespace, and dedups repeated intent so downstream stages see one clean
// task statement. Deterministic; no model calls.
import { type TriageStage } from '../skill.js'
import { GREETING, POLITENESS, FILLER, splitClauses } from '../signals.js'

function stripNoise(text: string): string {
  let t = text.trim()
  t = t.replace(GREETING, '')
  t = t.replace(POLITENESS, ' ')
  t = t.replace(FILLER, ' ')
  // Collapse whitespace and clean up punctuation left behind by the removals.
  return t
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/^[\s,;:.!?-]+/, '') // leading punctuation orphaned by a stripped prefix
    .trim()
}

// Drop clauses that repeat an earlier one (case-insensitive) — deduplicated
// intent (spec §4.1) — while preserving order.
function dedupClauses(text: string): string {
  const clauses = splitClauses(text)
  if (clauses.length <= 1) return text
  const seen = new Set<string>()
  const kept: string[] = []
  for (const c of clauses) {
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(c)
  }
  return kept.join('. ')
}

export const normalizeSkill: TriageStage = {
  name: 'normalize',
  purpose: 'Strip conversational noise and deduplicate intent into one clean task statement.',
  input_schema: { raw: 'string' },
  output_schema: { normalized_task: 'string' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const source = ctx.raw || ctx.ucp.g || ''
    const cleaned = dedupClauses(stripNoise(source))
    const normalized_task = cleaned || source.trim()
    return { patch: { normalized_task } }
  },
}
