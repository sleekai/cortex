// CUEA execution state — the single mutable record a task carries through the
// Producer → Evaluator → Router loop. The state is data; every transition is a
// pure reducer that returns a fresh state. Nothing here decides control flow
// (that is the Router's job) or judges output (the Evaluator's) — this module
// only records what happened so the Router can reason over history.
import { type Artifact } from '../artifact/artifacts.js'

// The four decisions an Evaluator may return (spec §4). RETRY re-runs the same
// tier; ESCALATE advances the ladder; ACCEPT/FINISH terminate.
export type EvalDecision = 'ACCEPT' | 'RETRY' | 'ESCALATE' | 'FINISH'

// Spec §5 enumerates running | finished | escalated. `finished` covers any
// clean stop at the entry tier; `escalated` marks a task that climbed the
// ladder before stopping — the two the success criteria (§11) distinguish.
export type LoopStatus = 'running' | 'finished' | 'escalated'

export interface HistoryEntry {
  iteration: number
  workerId: string
  tier: number
  decision: EvalDecision
  confidence: number
  issues: string[]
  // Spend for this attempt in the worker's relative cost units.
  cost: number
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
}

export interface ExecutionState {
  iteration: number
  cost: number
  // How many times the Router has escalated to a higher rung this task.
  escalationDepth: number
  history: HistoryEntry[]
  currentOutput: Artifact | null
  status: LoopStatus
}

export function initialState(): ExecutionState {
  return { iteration: 0, cost: 0, escalationDepth: 0, history: [], currentOutput: null, status: 'running' }
}

// Record one Producer+Evaluator attempt. Bumps iteration and accrues cost;
// escalation depth is bumped separately (only the Router escalates).
export function recordAttempt(
  state: ExecutionState,
  entry: HistoryEntry,
  output: Artifact,
): ExecutionState {
  return {
    ...state,
    iteration: state.iteration + 1,
    cost: state.cost + entry.cost,
    history: [...state.history, entry],
    currentOutput: output,
  }
}

export function escalate(state: ExecutionState): ExecutionState {
  return { ...state, escalationDepth: state.escalationDepth + 1 }
}

export function finish(state: ExecutionState, status: Exclude<LoopStatus, 'running'>): ExecutionState {
  return { ...state, status }
}
