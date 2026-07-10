// Typed artifacts are the only currency inside Cortex. Raw model output is
// parsed exactly once at the harness boundary (worker/artifact-builder.ts) into
// an Artifact; everything downstream — planner, state engine, skills — deals
// in these shapes, never in prose or chat history.
import * as crypto from 'node:crypto'

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

export type ReviewSeverity = 'R' | 'Y' | 'G'

export interface ReviewFinding {
  severity: ReviewSeverity
  pointer: string
  finding: string
}

export interface ArtifactBodies {
  'triage': {
    normalizedTask: string
    blueprint: string
    entryTier: string
    ambiguityScore: number
    capabilities: string[]
    confidence: number
  }
  'grill': { questions: string[]; reason: string; ambiguityScore: number }
  'context': {
    level: number
    pointers: string[]
    chunkCount: number
    estimatedTokens: number
    compressedText: string
  }
  'patch': { diff: string; reasoning: string }
  'plan': { steps: string[]; workerLadder?: string[]; entryTier?: number; expectedSpend?: number }
  'execution': {
    accepted: boolean
    iterations: number
    escalationDepth: number
    cost: number
    terminationReason: string
    finalArtifactId?: string
  }
  'evaluation': {
    decision: string
    confidence: number
    issues: string[]
    missingContext: string[]
    compressedText: string
  }
  'final': {
    accepted: boolean
    artifactId?: string
    summary: string
    cost: number
    tokenUsage: { promptTokens: number; completionTokens: number }
  }
  'decision': { question: string; decision: string; why: string }
  'review': { verdict: 'PASS' | 'ISSUES'; findings: ReviewFinding[] }
  'test-result': { passed: boolean; errors: string[]; output: string }
  'pointer-set': { pointers: string[] }
  'token-estimate': { inputTokens: number; outputTokens: number; expectedSpend: number }
  'compression': {
    sourceKind: ArtifactKind | 'context' | 'history' | 'text'
    originalTokens: number
    compressedTokens: number
    savedTokens: number
    ratio: number
    text: string
  }
  'cost': {
    promptTokens: number
    completionTokens: number
    cumulativeCost: number
    compressionSavings: number
    escalationCost: number
    estimatedRemainingBudget: number
  }
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
