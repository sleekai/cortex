// The TriageStage contract — a reusable, stateless cognitive module. Each
// stage patches one slice of the draft CTSPacket. Stages are composable
// (spec §8): downstream stages read upstream results off the shared draft,
// so routing can see the normalized task and ambiguity score.
//
// Stages MUST NOT: call other Cortex layers (planner/scheduler/workers),
// execute tools, fetch context, or call an LLM. Built-ins are deterministic.
//
// Deviation from the spec's literal `execute(input: UCPPacket)`: composability
// requires visibility of upstream stage output, so execute takes a
// TriageContext that carries the UCP (ctx.ucp) *plus* the accumulating draft.
import { type UCP } from '../packet/ucp.js'
import { type CTSPacket } from './packet.js'

// Per-policy enable/disable (spec §13). A disabled stage is skipped by the
// pipeline; its slice keeps the draft default.
export interface TriagePolicy {
  disabledStages?: string[]
}

export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {}

export interface TriageContext {
  ucp: UCP // the ingress-normalized packet (source of goal + constraints)
  raw: string // original raw content, before any normalization
  draft: CTSPacket // accumulating packet: whatever upstream stages have produced
  policy: TriagePolicy
}

// A stage returns a shallow patch merged into the draft, plus optional notes
// (diagnostics only — never surfaced downstream).
export interface StageResult {
  patch: Partial<CTSPacket>
  notes?: string[]
}

export interface TriageStage {
  name: string
  purpose: string
  // Descriptive JSON for registry introspection / pluggability. Documentation,
  // not runtime-enforced — the draft/patch shapes are typed by CTSPacket.
  input_schema: object
  output_schema: object
  cost_level: 'low' | 'medium'
  deterministic: boolean
  execute(ctx: TriageContext): StageResult
}
