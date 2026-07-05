// The generic Skill contract (MVP §1) — the primitive execution unit. Every
// reasoning step Cortex performs (triage, grilling, summarization, review,
// planning, …) is a Skill: it declares applicability, executes against a
// shared context, and emits structured results. Skills are independently
// composable — Blueprints (blueprint/) name them; the runner threads a shared
// blackboard through them so downstream skills see upstream output.
//
// Relationship to CTS skills (triage/skill.ts): a CTS_Skill is a *stage* of
// the deterministic triage pipeline and patches one slice of a CTSPacket.
// This Skill is one level up — the whole triage pipeline is itself one Skill
// here (skill/builtins.ts `triage`). Both stay: CTS composes cognition inside
// triage; this contract composes execution units inside blueprints.
//
// Skills never: escalate, retry, pick workers, or terminate execution. They
// emit observations (confidence, missing context, recommended action); the
// blueprint runner and policies decide what happens next (MVP §5).
import { type Artifact } from '../artifact/artifacts.js'
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk } from '../core/types.js'
import { type PolicySet } from '../policy/policies.js'

export type SkillCostLevel = 'free' | 'low' | 'medium' | 'high'

// What a skill recommends the runtime do next. A recommendation, never a
// command: the runner consults policy before honoring it.
export type RecommendedAction = 'proceed' | 'clarify' | 'escalate' | 'stop'

// Structured observations (MVP §5): needs, not requests. "I require
// authentication flow" is a missingContext entry; the runtime consults the
// Context Compiler, the skill never fetches anything itself.
export interface SkillObservations {
  confidence: number
  missingContext: string[]
  recommendedAction: RecommendedAction
  qualityScore?: number
}

export interface SkillOutcome {
  artifacts: Artifact[]
  observations: SkillObservations
  // Merged into the run blackboard under the skill's name; how downstream
  // skills read this skill's structured output.
  data?: Record<string, unknown>
}

// The LLM seam: dispatch one packet through the planned worker ladder and get
// the parsed artifact back. Injected by the runner so skills stay decoupled
// from the worker/harness layers; absent in deterministic-only runs.
export type SkillDispatch = (packet: UCP, chunks: CodeChunk[]) => Promise<Artifact>

export interface SkillContext {
  taskId: string
  // The current (possibly triage-normalized) task text.
  task: string
  // Original raw input, before any normalization.
  raw: string
  projectRoot: string
  // Ingress-normalized packet when the run came through a harness adapter.
  ucp?: UCP
  policies: PolicySet
  // Shared state keyed by skill name: each skill's outcome.data lands here.
  blackboard: Record<string, unknown>
  // Artifacts accumulated so far this run (read, don't mutate).
  artifacts: readonly Artifact[]
  dispatch?: SkillDispatch
}

export interface SkillMeta {
  // Capability vocabulary the skill exercises (documentation for planners).
  capabilities: string[]
  costLevel: SkillCostLevel
  deterministic: boolean
}

export interface Skill {
  name: string
  purpose: string
  meta: SkillMeta
  // Cheap, side-effect-free check: should this skill run given the context?
  // Blueprints list steps; applicability + step conditions gate them (§8, §9).
  applicable(ctx: SkillContext): boolean
  execute(ctx: SkillContext): Promise<SkillOutcome> | SkillOutcome
}

export function observation(partial?: Partial<SkillObservations>): SkillObservations {
  return { confidence: 1, missingContext: [], recommendedAction: 'proceed', ...partial }
}
