// Built-in execution skills (MVP §1, §8, §9). Side-effect module: importing
// it registers the four built-ins, mirroring triage/stages/builtins.ts (stage registry) and
// the harness factory imports at src/index.ts:9-10.
//
//   triage     classify task, estimate complexity, recommend blueprint + tier
//   grilling   detect ambiguity, surface clarification questions
//   summarize  LLM-backed one-shot summary (judgment channel)
//   review     LLM-backed code/PR review (judgment channel)
//
// Triage and grilling are deterministic (zero model calls). Summarize and
// review use the injected SkillDispatch seam and are inapplicable without it.
import { makeArtifact, isKind } from '../artifact/artifacts.js'
import { type UCP, type PacketOut } from '../packet/ucp.js'
import { generateJudgmentPacket } from '../packet/generator.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { normalizeInput } from '../ingress/ingress.js'
import { runTriage } from '../triage/pipeline.js'
import { type CTSPacket } from '../triage/packet.js'
import '../triage/stages/builtins.js'
import { registerSkill } from './registry.js'
import { type Skill, type SkillContext, observation } from './skill.js'
import { getCompilerRuntime } from '../compiler/runtime.js'

// The blackboard slice the triage skill publishes — downstream skills and the
// kernel's blueprint selection read this shape from blackboard['triage'].
export interface TriageData extends Record<string, unknown> {
  cts: CTSPacket
  intent: TaskIntent
  normalizedTask: string
  blueprint: string
  entryTier: string
}

export function triageData(ctx: SkillContext): TriageData | undefined {
  const data = ctx.blackboard['triage']
  return data && typeof data === 'object' ? data as TriageData : undefined
}

// Deterministic blueprint recommendation from what triage learned. Data-first
// mapping — the runtime knows nothing about debugging or reviewing (MVP §2);
// it just runs whatever blueprint name comes back.
export function recommendBlueprint(intent: TaskIntent, raw: string): string {
  if (intent.taskType === 'review' || /\b(review|audit|critique)\b/i.test(raw)) return 'pr-review'
  if (/\b(bug|fix|error|crash|broken|regression|fail(s|ing|ure)?)\b/i.test(raw)) return 'debug'
  if (intent.taskType === 'patch' || intent.taskType === 'plan') return 'feature'
  return 'default'
}

function contextUcp(ctx: SkillContext): UCP {
  return ctx.ucp ?? normalizeInput({ content: ctx.raw || ctx.task, kind: 'unknown', taskId: ctx.taskId }).ucp
}

export const triageSkill: Skill = {
  name: 'triage',
  purpose: 'Classify the task, estimate complexity, recommend an execution blueprint and initial worker tier.',
  meta: { capabilities: ['planning'], costLevel: 'free', deterministic: true },
  // Runs once per task: the kernel may pre-run it to pick the blueprint, in
  // which case the blueprint's own triage step finds the data and skips.
  applicable(ctx) {
    return triageData(ctx) === undefined
  },
  execute(ctx) {
    const { compileIntent } = getCompilerRuntime()
    const cts = runTriage({ ucp: contextUcp(ctx), raw: ctx.raw || ctx.task })
    const intent = compileIntent(cts.normalized_task)
    const data: TriageData = {
      cts,
      intent,
      normalizedTask: cts.normalized_task,
      blueprint: recommendBlueprint(intent, ctx.raw || ctx.task),
      entryTier: cts.worker_recommendation,
    }
    const artifact = makeArtifact('intent', ctx.taskId, 'skill:triage', {
      taskType: intent.taskType,
      complexity: intent.complexity,
      capabilities: intent.capabilities,
      confidence: intent.confidence,
      blueprint: data.blueprint,
      entryTier: data.entryTier,
      ambiguity: cts.ambiguity.score,
    })
    const triageArtifact = makeArtifact('triage', ctx.taskId, 'skill:triage', {
      normalizedTask: cts.normalized_task,
      blueprint: data.blueprint,
      entryTier: data.entryTier,
      ambiguityScore: cts.ambiguity.score,
      capabilities: intent.capabilities,
      confidence: intent.confidence,
    })
    return {
      artifacts: [artifact, triageArtifact],
      observations: observation({
        confidence: intent.confidence,
        recommendedAction: ctx.policies.clarification.shouldClarify(cts.ambiguity.score) ? 'clarify' : 'proceed',
      }),
      data,
    }
  },
}

export const grillingSkill: Skill = {
  name: 'grilling',
  purpose: 'Detect ambiguity and missing requirements; generate clarification questions.',
  meta: { capabilities: ['reasoning'], costLevel: 'free', deterministic: true },
  // Only when policy says the ambiguity justifies interrupting (MVP §9) —
  // a clear task skips the grill entirely.
  applicable(ctx) {
    const data = triageData(ctx)
    if (!data) return false
    return ctx.policies.clarification.shouldClarify(data.cts.ambiguity.score)
  },
  execute(ctx) {
    const data = triageData(ctx)
    const questions = data && data.cts.ambiguity.questions.length > 0
      ? data.cts.ambiguity.questions
      : ['Can you describe the task in more detail?']
    const flags = data?.cts.ambiguity.flags ?? []
    const artifact = makeArtifact('clarification', ctx.taskId, 'skill:grilling', {
      questions,
      reason: flags.length > 0 ? `ambiguity flags: ${flags.join(', ')}` : 'task is underspecified',
    })
    const grillArtifact = makeArtifact('grill', ctx.taskId, 'skill:grilling', {
      questions,
      reason: flags.length > 0 ? `ambiguity flags: ${flags.join(', ')}` : 'task is underspecified',
      ambiguityScore: data?.cts.ambiguity.score ?? 0.5,
    })
    return {
      artifacts: [artifact, grillArtifact],
      observations: observation({
        confidence: data?.cts.ambiguity.score ?? 0.5,
        recommendedAction: ctx.policies.clarification.mode === 'halt' ? 'clarify' : 'proceed',
      }),
    }
  },
}

// One judgment-channel dispatch: build an ask/review packet from the current
// task and hand it to the injected dispatch seam. The output parser turns the
// reply into a decision/review artifact at the harness boundary as always.
function judgmentPacket(ctx: SkillContext, act: 'ask' | 'review', question: string, out: PacketOut): UCP {
  return generateJudgmentPacket(contextUcp(ctx), act, question, out)
}

export const summarizeSkill: Skill = {
  name: 'summarize',
  purpose: 'Produce a compact summary of the task/change under review.',
  meta: { capabilities: ['docs', 'reasoning'], costLevel: 'low', deterministic: false },
  applicable(ctx) {
    return ctx.dispatch !== undefined
  },
  async execute(ctx) {
    const packet = judgmentPacket(ctx, 'ask', `Summarize in ≤5 bullet points: ${ctx.task}`, 'analysis')
    const artifact = await ctx.dispatch!(packet, [])
    const failed = artifact.kind === 'failure'
    return {
      artifacts: [artifact],
      observations: observation({
        confidence: failed ? 0.2 : 0.7,
        recommendedAction: failed ? 'escalate' : 'proceed',
      }),
    }
  },
}

export const reviewSkill: Skill = {
  name: 'review',
  purpose: 'Review code or a change set and report a verdict with findings.',
  meta: { capabilities: ['review'], costLevel: 'medium', deterministic: false },
  applicable(ctx) {
    return ctx.dispatch !== undefined
  },
  async execute(ctx) {
    const packet = judgmentPacket(ctx, 'review', `Review: ${ctx.task}`, 'review')
    // act:review packets carry the material under review as a diff fact —
    // taken from a produced patch when one exists, else the task text itself.
    const produced = [...ctx.artifacts].reverse().find(a => isKind(a, 'patch'))
    const material = produced && isKind(produced, 'patch') ? produced.body.diff : ctx.task
    packet.ctx.d = [`diff:${material.slice(0, 600)}`]
    const artifact = await ctx.dispatch!(packet, [])
    const failed = artifact.kind === 'failure'
    const passed = artifact.kind === 'review' && (artifact.body as { verdict?: string }).verdict === 'PASS'
    return {
      artifacts: [artifact],
      observations: observation({
        confidence: failed ? 0.2 : 0.8,
        qualityScore: failed ? 0 : passed ? 1 : 0.5,
        recommendedAction: failed ? 'escalate' : 'proceed',
      }),
    }
  },
}

registerSkill(triageSkill)
registerSkill(grillingSkill)
registerSkill(summarizeSkill)
registerSkill(reviewSkill)
