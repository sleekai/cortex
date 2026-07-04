// The CTS_Skill contract — a reusable, stateless cognitive module. Each skill
// patches one slice of the draft CTSPacket. Skills are composable (spec §8):
// downstream skills read upstream results off the shared draft, so ambiguity
// can see subtasks and routing can see complexity signals.
//
// Skills MUST NOT: call other Cortex layers (planner/scheduler/workers),
// execute tools, fetch context, or call an LLM. Built-ins are deterministic.
//
// Deviation from the spec's literal `execute(input: UCPPacket)`: composability
// requires visibility of upstream stage output, so execute takes a
// TriageContext that carries the UCP (ctx.ucp) *plus* the accumulating draft.
import { type UCP } from '../packet/ucp.js'
import { type CTSPacket } from './packet.js'

// Per-policy enable/disable (spec §13). A disabled skill is skipped by the
// pipeline; its stage's slice keeps the draft default.
export interface TriagePolicy {
  disabledSkills?: string[]
}

export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {}

export interface TriageContext {
  ucp: UCP // the ingress-normalized packet (source of goal + constraints)
  raw: string // original raw content, before any normalization
  draft: CTSPacket // accumulating packet: whatever upstream skills have produced
  policy: TriagePolicy
}

// A skill returns a shallow patch merged into the draft, plus optional notes
// (diagnostics only — never surfaced downstream).
export interface SkillResult {
  patch: Partial<CTSPacket>
  notes?: string[]
}

export interface CTS_Skill {
  name: string
  purpose: string
  // Descriptive JSON for registry introspection / pluggability. Documentation,
  // not runtime-enforced — the draft/patch shapes are typed by CTSPacket.
  input_schema: object
  output_schema: object
  cost_level: 'low' | 'medium'
  deterministic: boolean
  execute(ctx: TriageContext): SkillResult
}
