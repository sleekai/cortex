// Blueprint runner — executes a Blueprint step by step, threading a shared
// blackboard and artifact list through skills, and delegating `produce` steps
// to a kernel-provided executor (the CUEA loop). The runner owns sequencing
// and policy consultation only: skills reason, evaluators judge, the Router
// escalates, policies decide — nothing here knows what any skill does.
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type UCP } from '../packet/ucp.js'
import { type PolicySet, mergePolicies } from '../policy/policies.js'
import { type Skill, type SkillContext, type SkillDispatch, type SkillOutcome } from '../skill/skill.js'
import { type CompilerRuntime, DEFAULT_COMPILER_RUNTIME } from '../compiler/runtime.js'
import { getSkill } from '../skill/registry.js'
import { type Blueprint, type BlueprintRunView } from './blueprint.js'
import { info, warn } from '../core/logger.js'
import { compressArtifact, makeCompressionArtifact } from '../runtime/compression.js'

// What a `produce` step returns — the kernel wires this to prepareDispatch +
// the CUEA loop so the runner never imports the kernel (no cycle).
export interface ProduceResult {
  artifacts: Artifact[]
  accepted: boolean
  summary: {
    iterations: number
    escalationDepth: number
    cost: number
    terminationReason: string
    status: string
  }
}

export type ProduceExecutor = (view: BlueprintRunView) => Promise<ProduceResult>

export interface BlueprintRunConfig {
  taskId: string
  task: string
  raw: string
  projectRoot: string
  policies: PolicySet
  ucp?: UCP
  dispatch?: SkillDispatch
  produce: ProduceExecutor
  blackboard?: Record<string, unknown>
  artifacts?: Artifact[]
  onStep?: (stepId: string, outcome: SkillOutcome | ProduceResult) => void
  compilerRuntime?: CompilerRuntime
}

export interface ExecutedStep {
  id: string
  kind: 'skill' | 'produce'
  ran: boolean
  reason?: string
}

export type BlueprintOutcome =
  | { kind: 'clarification'; questions: string[]; artifacts: Artifact[]; steps: ExecutedStep[] }
  | { kind: 'completed'; accepted: boolean; artifacts: Artifact[]; steps: ExecutedStep[]; produce?: ProduceResult }

export async function executeBlueprint(blueprint: Blueprint, config: BlueprintRunConfig): Promise<BlueprintOutcome> {
  const policies = mergePolicies(config.policies, blueprint.policies)
  const blackboard: Record<string, unknown> = { ...(config.blackboard ?? {}) }
  const artifacts: Artifact[] = [...(config.artifacts ?? [])]
  const steps: ExecutedStep[] = []
  let lastProduce: ProduceResult | undefined

  const view = (): BlueprintRunView => ({ blackboard, artifacts })

  const runtime = config.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME
  const { makeArtifact: rtMakeArtifact } = runtime

  for (const step of blueprint.steps) {
    if (step.when && !step.when(view())) {
      steps.push({ id: step.id, kind: step.kind, ran: false, reason: 'condition false' })
      continue
    }

    if (step.kind === 'produce') {
      info(`blueprint ${blueprint.name}: step ${step.id} → produce`)
      const result = await config.produce(view())
      artifacts.push(...result.artifacts)
      for (const artifact of result.artifacts.filter(a => a.kind !== 'compression')) {
        artifacts.push(makeCompressionArtifact(config.taskId, artifact.kind, compressArtifact(artifact), rtMakeArtifact))
      }
      blackboard['produce'] = result.summary
      lastProduce = result
      steps.push({ id: step.id, kind: 'produce', ran: true })
      config.onStep?.(step.id, result)
      continue
    }

    const skill = getSkill(step.skill)
    if (!skill) {
      throw new Error(`blueprint ${blueprint.name}: step ${step.id} names unregistered skill "${step.skill}"`)
    }

    const ctx: SkillContext = {
      taskId: config.taskId,
      task: currentTask(blackboard, config.task),
      raw: config.raw,
      projectRoot: config.projectRoot,
      policies,
      blackboard,
      artifacts,
      compilerRuntime: runtime,
      ...(config.ucp ? { ucp: config.ucp } : {}),
      ...(config.dispatch ? { dispatch: config.dispatch } : {}),
    }

    if (!skill.applicable(ctx)) {
      // Distinguish "its work is already on the blackboard" (e.g. the kernel
      // pre-ran triage to select this blueprint) from a plain decline.
      const reason = blackboard[skill.name] !== undefined ? 'already satisfied' : 'not applicable'
      steps.push({ id: step.id, kind: 'skill', ran: false, reason })
      continue
    }

    info(`blueprint ${blueprint.name}: step ${step.id} → skill ${skill.name}`)
    const outcome = await skill.execute(ctx)
    artifacts.push(...outcome.artifacts)
    for (const artifact of outcome.artifacts.filter(a => a.kind !== 'compression')) {
      artifacts.push(makeCompressionArtifact(config.taskId, artifact.kind, compressArtifact(artifact), rtMakeArtifact))
    }
    if (outcome.data) blackboard[skill.name] = outcome.data
    steps.push({ id: step.id, kind: 'skill', ran: true })
    config.onStep?.(step.id, outcome)

    // Clarification halt (MVP §3, §9): only a skill that actually produced
    // questions, under a policy in 'halt' mode, interrupts the run. The skill
    // recommended; the policy decided.
    if (outcome.observations.recommendedAction === 'clarify' && policies.clarification.mode === 'halt') {
      const questions = outcome.artifacts
        .filter(a => isKind(a, 'clarification'))
        .flatMap(a => (a as Artifact<'clarification'>).body.questions)
      if (questions.length > 0) {
        info(`blueprint ${blueprint.name}: halted for clarification after ${step.id}`)
        return { kind: 'clarification', questions, artifacts, steps }
      }
    }
    if (outcome.observations.recommendedAction === 'stop') {
      warn(`blueprint ${blueprint.name}: skill ${skill.name} recommended stop`)
      return { kind: 'completed', accepted: false, artifacts, steps, ...(lastProduce ? { produce: lastProduce } : {}) }
    }
  }

  return {
    kind: 'completed',
    // A produce step's verdict wins; a skill-only blueprint (e.g. pr-review)
    // is accepted iff no step ended in a failure artifact.
    accepted: lastProduce?.accepted ?? !artifacts.some(a => isKind(a, 'failure')),
    artifacts,
    steps,
    ...(lastProduce ? { produce: lastProduce } : {}),
  }
}

// Skills downstream of triage should see the normalized task text.
function currentTask(blackboard: Record<string, unknown>, fallback: string): string {
  const triage = blackboard['triage']
  if (triage && typeof triage === 'object' && typeof (triage as Record<string, unknown>)['normalizedTask'] === 'string') {
    return (triage as Record<string, unknown>)['normalizedTask'] as string
  }
  return fallback
}
