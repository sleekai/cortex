// Context Filter (spec §4.6). Marks which context matters and which to ignore.
// Defines BOUNDARIES only — it never fetches, reads, or expands context.
import { type TriageStage } from '../skill.js'
import { GREETING, POLITENESS, FILLER, extractFileTokens, extractIdentifiers } from '../signals.js'

export const contextFilterSkill: TriageStage = {
  name: 'context-filter',
  purpose: 'Mark required vs ignorable context boundaries (no fetching).',
  input_schema: { raw: 'string', normalized_task: 'string' },
  output_schema: { context_hints: 'CtsContextHints' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const text = ctx.draft.normalized_task
    // Required: concrete anchors the request names — files and identifiers.
    const required = [...new Set([...extractFileTokens(text), ...extractIdentifiers(text)])]

    // Ignore: categories of noise detected in the *raw* input. Labels, not
    // content — the boundary the downstream context compiler should not cross.
    const ignore: string[] = []
    const raw = ctx.raw || ''
    if (GREETING.test(raw)) ignore.push('greeting preamble')
    POLITENESS.lastIndex = 0
    if (POLITENESS.test(raw)) ignore.push('politeness phrasing')
    FILLER.lastIndex = 0
    if (FILLER.test(raw)) ignore.push('conversational filler')

    return { patch: { context_hints: { required, ignore } } }
  },
}
