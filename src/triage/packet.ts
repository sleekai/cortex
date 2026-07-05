// The CTS output packet — the strict, compact grammar the Triage Skill System
// hands to the Intent Compiler. It carries pre-execution cognition only:
// a normalized task, ambiguity signals, and a worker-tier *hint*. Every field
// has a downstream reader; stages whose output nothing consumed (decompose,
// strategy, context-filter) were removed and re-enter as execution Skills
// when a real consumer exists (see docs/adr/0001-defer-dag-execution.md).
//
// NOT responsible for: planning, solving, scheduling, execution. Nothing here
// is a plan or a decision — only structured understanding of the request.

// Cost-tier vocabulary. This is a scheduler *hint*, deliberately decoupled from
// the worker registry's WorkerTier (1|2|3): T0 is deterministic/no-LLM, T4 is
// human-in-loop/browser. The scheduler owns the real selection.
export type CtsTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'
export const ALL_TIERS: readonly CtsTier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

export interface CtsAmbiguity {
  score: number // 0..1 — confidence the request is fully specified (1 = clear)
  flags: string[]
  questions: string[]
}

export interface CTSPacket {
  normalized_task: string
  ambiguity: CtsAmbiguity
  worker_recommendation: CtsTier
}

export interface CtsValidation {
  valid: boolean
  errors: string[]
}

function isTier(v: unknown): v is CtsTier {
  return typeof v === 'string' && (ALL_TIERS as readonly string[]).includes(v)
}

// Fail-loud validation in the same shape as validatePacket (packet/ucp.ts):
// the pipeline runs this before returning so a malformed skill can never leak a
// bad packet downstream.
export function validateCtsPacket(p: CTSPacket): CtsValidation {
  const errors: string[] = []
  if (!p.normalized_task) errors.push('missing normalized_task')
  if (p.ambiguity.score < 0 || p.ambiguity.score > 1) {
    errors.push(`ambiguity score out of range (${p.ambiguity.score})`)
  }
  if (!isTier(p.worker_recommendation)) errors.push('invalid worker_recommendation')
  return { valid: errors.length === 0, errors }
}

// An empty draft the pipeline threads through skills, each patching its slice.
export function emptyPacket(): CTSPacket {
  return {
    normalized_task: '',
    ambiguity: { score: 1, flags: [], questions: [] },
    worker_recommendation: 'T2',
  }
}
