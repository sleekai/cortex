import { type ArtifactKind } from '../artifact/artifacts.js'

// Closed vocabulary — the planner matches workers to intents through these,
// never through model names. Extend here, in one place.
export type Capability =
  | 'coding'
  | 'reasoning'
  | 'planning'
  | 'review'
  | 'docs'
  | 'translation'
  | 'vision'
  | 'audio'
  | 'embeddings'
  | 'search'
  | 'locate' // deterministic retrieval — tier-0 territory

export const ALL_CAPABILITIES: readonly Capability[] = [
  'coding', 'reasoning', 'planning', 'review', 'docs', 'translation',
  'vision', 'audio', 'embeddings', 'search', 'locate',
]

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (ALL_CAPABILITIES as readonly string[]).includes(v)
}

export type TaskType = 'patch' | 'question' | 'review' | 'plan' | 'locate'
export type Complexity = 'trivial' | 'bounded' | 'open'
export type ReasoningDepth = 0 | 1 | 2 | 3

// What the planner operates on. Never raw user text.
export interface TaskIntent {
  taskType: TaskType
  complexity: Complexity
  capabilities: Capability[]
  requiredArtifacts: ArtifactKind[]
  expectedOutput: ArtifactKind
  estTokenBudget: number
  estReasoningDepth: ReasoningDepth
  confidence: number // 0..1 — the compiler's certainty about its own parse
  fileHints: string[]
}
