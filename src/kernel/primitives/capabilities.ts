// Closed capability vocabulary for the kernel domain model. This intentionally
// mirrors src/capability/capabilities.ts but is defined here, standalone, so
// the kernel primitives compile with zero dependency on any agent provider,
// planner, or runtime module (Acceptance Criterion 1). The kernel is the
// future source of truth; the runtime copy stays in sync via adapters (a
// later milestone), not via a compile-time import in this direction.

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
  | 'locate'

export const ALL_CAPABILITIES: readonly Capability[] = [
  'coding', 'reasoning', 'planning', 'review', 'docs', 'translation',
  'vision', 'audio', 'embeddings', 'search', 'locate',
]

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (ALL_CAPABILITIES as readonly string[]).includes(v)
}

// Typed artifact kinds a task may produce or require. Mirrors
// src/artifact/artifacts.ts ArtifactKind for the same standalone reason.
export type ArtifactKind =
  | 'triage'
  | 'grill'
  | 'context'
  | 'patch'
  | 'plan'
  | 'execution'
  | 'evaluation'
  | 'final'
  | 'decision'
  | 'review'
  | 'test-result'
  | 'pointer-set'
  | 'token-estimate'
  | 'compression'
  | 'cost'
  | 'intent'
  | 'metric'
  | 'failure'
  | 'clarification'

export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'triage', 'grill', 'context', 'patch', 'plan', 'execution',
  'evaluation', 'final', 'decision', 'review', 'test-result',
  'pointer-set', 'token-estimate', 'compression', 'cost',
  'intent', 'metric', 'failure', 'clarification',
]

export function isArtifactKind(v: unknown): v is ArtifactKind {
  return typeof v === 'string' && (ALL_ARTIFACT_KINDS as readonly string[]).includes(v)
}
