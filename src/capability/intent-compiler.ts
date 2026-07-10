// Deterministic request -> structured intent. Rules and keyword signals only,
// zero model calls: the bottom of the escalation ladder classifies the task so
// the planner never has to read raw user text. Low confidence is not hidden —
// it raises the ladder entry point instead.
import { type TaskIntent, type TaskType, type Complexity, type ReasoningDepth, type Capability } from './capabilities.js'
import { type ArtifactKind } from '../artifact/artifacts.js'
import { DEFAULT_BUDGET } from '../core/types.js'
import { OPEN_SIGNALS, TRIVIAL_SIGNALS, extractFileTokens, classifyComplexity } from '../core/signals.js'

const TYPE_SIGNALS: Record<TaskType, RegExp[]> = {
  review: [/\breview\b/i, /\baudit\b/i, /\bjudge\b/i, /\bcritique\b/i],
  plan: [/\bplan\b/i, /\bdesign\b/i, /\barchitect/i, /\broadmap\b/i, /\bspec\b/i],
  question: [/\?\s*$/, /^\s*(?:what|why|how|when|which|where|who|should|can|is|are|does|do)\b/i, /\bexplain\b/i, /\bdecide\b/i],
  locate: [/\bfind\b/i, /\blocate\b/i, /\bwhere is\b/i, /\blist all\b/i, /\bsearch for\b/i],
  patch: [/\bfix\b/i, /\badd\b/i, /\bimplement\b/i, /\brefactor\b/i, /\bupdate\b/i, /\bremove\b/i, /\brename\b/i, /\bchange\b/i, /\bwrite\b/i],
}

// Order matters: a "review the fix" request is a review, not a patch.
const TYPE_PRIORITY: TaskType[] = ['review', 'plan', 'locate', 'question', 'patch']

function detectTaskType(text: string): { taskType: TaskType; matched: boolean } {
  for (const t of TYPE_PRIORITY) {
    if (TYPE_SIGNALS[t].some(rx => rx.test(text))) return { taskType: t, matched: true }
  }
  return { taskType: 'patch', matched: false }
}

function detectComplexity(text: string, fileHints: string[]): Complexity {
  return classifyComplexity(text, fileHints.length)
}

const TYPE_TO_CAPABILITIES: Record<TaskType, Capability[]> = {
  patch: ['coding'],
  question: ['reasoning'],
  review: ['review', 'reasoning'],
  plan: ['planning', 'reasoning'],
  locate: ['locate'],
}

const TYPE_TO_OUTPUT: Record<TaskType, ArtifactKind> = {
  patch: 'patch',
  question: 'decision',
  review: 'review',
  plan: 'plan',
  locate: 'pointer-set',
}

const COMPLEXITY_TO_DEPTH: Record<Complexity, ReasoningDepth> = {
  trivial: 0,
  bounded: 1,
  open: 3,
}

const COMPLEXITY_TO_BUDGET: Record<Complexity, number> = {
  trivial: 800,
  bounded: DEFAULT_BUDGET.maxInputTokens,
  open: DEFAULT_BUDGET.maxInputTokens * 3,
}

export function compileIntent(request: string): TaskIntent {
  const text = request.trim()
  const fileHints = extractFileTokens(text)
  const { taskType, matched } = detectTaskType(text)
  const complexity = detectComplexity(text, fileHints)

  // Confidence drops when nothing matched (defaulted to patch), when the
  // request is very short (ambiguous), or when it is open-ended.
  let confidence = matched ? 0.85 : 0.4
  if (text.split(/\s+/).length < 4) confidence -= 0.2
  if (complexity === 'open') confidence -= 0.15
  if (taskType === 'patch' && fileHints.length > 0) confidence += 0.1
  confidence = Math.max(0.05, Math.min(1, confidence))

  const depth = COMPLEXITY_TO_DEPTH[complexity]

  return {
    taskType,
    complexity,
    capabilities: TYPE_TO_CAPABILITIES[taskType],
    requiredArtifacts: taskType === 'review' ? ['patch'] : [],
    expectedOutput: TYPE_TO_OUTPUT[taskType],
    estTokenBudget: COMPLEXITY_TO_BUDGET[complexity],
    estReasoningDepth: taskType === 'locate' ? 0 : depth,
    confidence,
    fileHints,
  }
}
