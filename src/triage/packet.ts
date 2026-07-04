// The CTS output packet — the strict, compact grammar the Triage Skill System
// hands to the Intent Compiler. It carries pre-execution cognition only:
// a normalized task, a shallow decomposition, ambiguity signals, lightweight
// strategy sketches, a worker-tier *hint*, and context boundaries.
//
// NOT responsible for: planning, solving, scheduling, execution. Nothing here
// is a plan or a decision — only structured understanding of the request.

// Cost-tier vocabulary. This is a scheduler *hint*, deliberately decoupled from
// the worker registry's WorkerTier (1|2|3): T0 is deterministic/no-LLM, T4 is
// human-in-loop/browser. The scheduler owns the real selection.
export type CtsTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'
export const ALL_TIERS: readonly CtsTier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

export type SubtaskType = 'required' | 'optional'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface CtsSubtask {
  id: string
  description: string
  dependencies: string[]
  type: SubtaskType
}

export interface CtsAmbiguity {
  score: number // 0..1 — confidence the request is fully specified (1 = clear)
  flags: string[]
  questions: string[]
}

export interface CtsStrategy {
  name: string
  description: string // one line — never an expanded plan
  cost_tier: CtsTier
  risk: RiskLevel
}

export interface CtsContextHints {
  required: string[]
  ignore: string[]
}

export interface CTSPacket {
  normalized_task: string
  subtasks: CtsSubtask[] // 3–7 when the task decomposes; 1 for atomic tasks
  ambiguity: CtsAmbiguity
  strategies: CtsStrategy[] // ≤3
  worker_recommendation: CtsTier
  context_hints: CtsContextHints
}

// Bounds mirror the spec so validation stays a single source of truth. The
// lower subtask bound is 1 (atomic requests are legal); the 3–7 "decomposition"
// range in the spec is the *upper* structuring guidance the decomposer honors.
export const MIN_SUBTASKS = 1
export const MAX_SUBTASKS = 7
export const MAX_STRATEGIES = 3

export interface CtsValidation {
  valid: boolean
  errors: string[]
}

function isTier(v: unknown): v is CtsTier {
  return typeof v === 'string' && (ALL_TIERS as readonly string[]).includes(v)
}

// Fail-loud validation in the same shape as validatePacket (packet/ucp.ts:34):
// the pipeline runs this before returning so a malformed skill can never leak a
// bad packet downstream.
export function validateCtsPacket(p: CTSPacket): CtsValidation {
  const errors: string[] = []
  if (!p.normalized_task) errors.push('missing normalized_task')
  if (p.subtasks.length < MIN_SUBTASKS || p.subtasks.length > MAX_SUBTASKS) {
    errors.push(`subtasks out of range (${p.subtasks.length}, want ${MIN_SUBTASKS}–${MAX_SUBTASKS})`)
  }
  const ids = new Set(p.subtasks.map(s => s.id))
  for (const s of p.subtasks) {
    for (const dep of s.dependencies) {
      if (!ids.has(dep)) errors.push(`subtask ${s.id} depends on unknown ${dep}`)
      if (dep === s.id) errors.push(`subtask ${s.id} depends on itself`)
    }
  }
  if (p.ambiguity.score < 0 || p.ambiguity.score > 1) {
    errors.push(`ambiguity score out of range (${p.ambiguity.score})`)
  }
  if (p.strategies.length > MAX_STRATEGIES) {
    errors.push(`strategies exceed cap (${p.strategies.length} > ${MAX_STRATEGIES})`)
  }
  for (const st of p.strategies) {
    if (!isTier(st.cost_tier)) errors.push(`strategy "${st.name}" has invalid cost_tier`)
  }
  if (!isTier(p.worker_recommendation)) errors.push('invalid worker_recommendation')
  return { valid: errors.length === 0, errors }
}

// An empty draft the pipeline threads through skills, each patching its slice.
export function emptyPacket(): CTSPacket {
  return {
    normalized_task: '',
    subtasks: [],
    ambiguity: { score: 1, flags: [], questions: [] },
    strategies: [],
    worker_recommendation: 'T2',
    context_hints: { required: [], ignore: [] },
  }
}
