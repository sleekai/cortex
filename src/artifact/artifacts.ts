// Typed artifacts are the only currency inside Cortex. Raw model output is
// parsed exactly once at the harness boundary (worker/artifact-builder.ts) into
// an Artifact; everything downstream — planner, state engine, skills — deals
// in these shapes, never in prose or chat history.
import * as crypto from 'node:crypto'

export type ArtifactKind =
  | 'patch'
  | 'plan'
  | 'decision'
  | 'review'
  | 'test-result'
  | 'pointer-set'
  | 'token-estimate'
  | 'intent'
  | 'metric'
  | 'failure'
  | 'clarification'

export type ReviewSeverity = 'R' | 'Y' | 'G'

export interface ReviewFinding {
  severity: ReviewSeverity
  pointer: string
  finding: string
}

export interface ArtifactBodies {
  'patch': { diff: string; reasoning: string }
  'plan': { steps: string[] }
  'decision': { question: string; decision: string; why: string }
  'review': { verdict: 'PASS' | 'ISSUES'; findings: ReviewFinding[] }
  'test-result': { passed: boolean; errors: string[]; output: string }
  'pointer-set': { pointers: string[] }
  'token-estimate': { inputTokens: number; outputTokens: number; expectedSpend: number }
  'intent': Record<string, unknown>
  'metric': Record<string, unknown>
  'failure': { reason: string; recoverable: boolean }
  'clarification': { questions: string[]; reason: string }
}

export interface Artifact<K extends ArtifactKind = ArtifactKind> {
  id: string
  kind: K
  taskId: string
  createdAt: string
  producedBy: string
  body: ArtifactBodies[K]
}

export function makeArtifact<K extends ArtifactKind>(
  kind: K,
  taskId: string,
  producedBy: string,
  body: ArtifactBodies[K],
): Artifact<K> {
  return {
    id: `${kind}-${crypto.randomBytes(4).toString('hex')}`,
    kind,
    taskId,
    createdAt: new Date().toISOString(),
    producedBy,
    body,
  }
}

export function isArtifact(value: unknown): value is Artifact {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Record<string, unknown>
  return (
    typeof a.id === 'string' &&
    typeof a.kind === 'string' &&
    typeof a.taskId === 'string' &&
    typeof a.createdAt === 'string' &&
    typeof a.producedBy === 'string' &&
    typeof a.body === 'object' && a.body !== null
  )
}

export function isKind<K extends ArtifactKind>(artifact: Artifact, kind: K): artifact is Artifact<K> {
  return artifact.kind === kind
}
