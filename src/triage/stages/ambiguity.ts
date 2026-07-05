// Ambiguity Analyzer (spec §4.3). Flags missing/unclear/underspecified/
// conflicting signals before expensive execution and emits one clarification
// question per flag. Deterministic; score is 1 (fully clear) minus penalties.
import { type TriageStage } from '../stage.js'
import {
  PATCH_VERBS, VAGUE_SIGNALS, CONFLICT_SIGNALS, extractFileTokens, extractIdentifiers, wordCount,
} from '../signals.js'

interface Signal {
  flag: string
  question: string
  penalty: number
}

export const ambiguityStage: TriageStage = {
  name: 'ambiguity',
  purpose: 'Detect missing requirements, vague terms, underspecification, and conflicts.',
  input_schema: { normalized_task: 'string' },
  output_schema: { ambiguity: 'CtsAmbiguity' },
  cost_level: 'low',
  deterministic: true,
  execute(ctx) {
    const text = ctx.draft.normalized_task
    const signals: Signal[] = []

    // Missing target: an edit was requested but nothing names what to edit.
    const hasTarget = extractFileTokens(text).length > 0 || extractIdentifiers(text).length > 0
    if (PATCH_VERBS.test(text) && !hasTarget) {
      signals.push({
        flag: 'missing-target',
        question: 'Which file(s) or component should this change target?',
        penalty: 0.25,
      })
    }

    // Underspecified: too few words to act on.
    if (wordCount(text) < 4) {
      signals.push({
        flag: 'underspecified-goal',
        question: 'Can you describe the task in more detail?',
        penalty: 0.25,
      })
    }

    // Vague quantifiers / placeholders.
    const vague = VAGUE_SIGNALS.find(rx => rx.test(text))
    if (vague) {
      const word = (text.match(vague)?.[0] ?? 'that').trim()
      signals.push({
        flag: 'vague-quantifier',
        question: `Can you specify what "${word}" refers to?`,
        penalty: 0.2,
      })
    }

    // Conflicting instructions.
    if (CONFLICT_SIGNALS.some(rx => rx.test(text)) || (/\badd\b/i.test(text) && /\bremove\b/i.test(text))) {
      signals.push({
        flag: 'conflicting-instructions',
        question: 'The request appears to contain conflicting instructions — which takes priority?',
        penalty: 0.2,
      })
    }

    const totalPenalty = signals.reduce((sum, s) => sum + s.penalty, 0)
    const score = Math.max(0, Math.min(1, 1 - totalPenalty))
    return {
      patch: {
        ambiguity: {
          score,
          flags: signals.map(s => s.flag),
          questions: signals.map(s => s.question),
        },
      },
    }
  },
}
