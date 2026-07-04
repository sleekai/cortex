// Decomposition (spec §4.2). Splits the normalized task into 1–7 ordered
// subtasks with dependency edges and required/optional tags. Deterministic —
// this is shallow structuring, NOT planning: no solutions, no steps invented
// that the request didn't state.
import { type CTS_Skill } from '../skill.js'
import { type CtsSubtask } from '../packet.js'
import { MAX_SUBTASKS } from '../packet.js'
import { splitClauses, isOptionalClause, isSequentialClause } from '../signals.js'

export const decomposeSkill: CTS_Skill = {
  name: 'decompose',
  purpose: 'Break the task into ordered subtasks with dependencies and optionality.',
  input_schema: { normalized_task: 'string' },
  output_schema: { subtasks: 'CtsSubtask[]' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const text = ctx.draft.normalized_task
    let clauses = splitClauses(text)
    if (clauses.length === 0) clauses = [text.trim() || 'unspecified task']
    // Cap at MAX_SUBTASKS: fold the overflow into the last subtask rather than
    // dropping intent.
    if (clauses.length > MAX_SUBTASKS) {
      const head = clauses.slice(0, MAX_SUBTASKS - 1)
      const tail = clauses.slice(MAX_SUBTASKS - 1).join('; ')
      clauses = [...head, tail]
    }

    const subtasks: CtsSubtask[] = clauses.map((clause, i) => {
      const id = `st${i + 1}`
      // A sequencing cue ("then"/"after"/"once") links this subtask to the
      // previous one; otherwise it's independent.
      const dependencies = i > 0 && isSequentialClause(clause) ? [`st${i}`] : []
      return {
        id,
        description: clause.replace(isSequentialClause(clause) ? /^(?:then|after(?:wards)?|once|next|finally|also)\b[\s,]*/i : /^$/, '').trim() || clause,
        dependencies,
        type: isOptionalClause(clause) ? 'optional' : 'required',
      }
    })
    return { patch: { subtasks } }
  },
}
