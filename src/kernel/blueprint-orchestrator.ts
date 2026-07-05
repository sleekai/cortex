import { DEFAULT_BUDGET, type BudgetConfig } from '../core/types.js'
import { type Artifact, isKind, makeArtifact } from '../artifact/artifacts.js'
import { type CodeChunk } from '../core/types.js'
import { type SkillContext, type SkillDispatch } from '../skill/skill.js'
import { triageSkill, type TriageData } from '../skill/builtins.js'
import { getBlueprint } from '../blueprint/blueprint.js'
import { executeBlueprint, type BlueprintOutcome as RunnerOutcome, type ExecutedStep, type ProduceResult } from '../blueprint/runner.js'
import { type PolicySet, DEFAULT_POLICIES, mergePolicies, boundsFromPolicies } from '../policy/policies.js'
import { dispatchOne } from '../worker/dispatch.js'
import { normalizeInput } from '../ingress/ingress.js'
import { appendMetric } from '../state/metrics.js'
import { saveArtifact } from '../state/store.js'
import { info } from '../core/logger.js'
import { planTask, prepareDispatch, type KernelConfig } from './kernel.js'
import { DEFAULT_POLICY } from '../capability/policy.js'
import { defaultContextService } from '../loop/context-service.js'
import { executePrepared } from './dispatch-orchestrator.js'
// Side-effect imports: register built-in execution skills and blueprints.
import '../skill/builtins.js'
import '../blueprint/builtins.js'

export interface BlueprintConfig extends KernelConfig {
  blueprint?: string
  policies?: PolicySet
  raw?: string
}

export type BlueprintTaskOutcome =
  | { kind: 'clarification'; blueprint: string; questions: string[]; artifacts: Artifact[]; steps: ExecutedStep[] }
  | { kind: 'completed'; blueprint: string; accepted: boolean; artifacts: Artifact[]; steps: ExecutedStep[]; produce?: ProduceResult }

export async function runBlueprint(task: string, config: BlueprintConfig): Promise<BlueprintTaskOutcome> {
  const basePolicies = config.policies ?? DEFAULT_POLICIES
  const raw = config.raw ?? task
  const ingress = normalizeInput({ content: raw, kind: 'unknown', explicitGoal: config.goal })
  const taskId = ingress.ucp.t

  const seedCtx: SkillContext = {
    taskId,
    task,
    raw,
    projectRoot: config.projectRoot,
    ucp: ingress.ucp,
    policies: basePolicies,
    blackboard: {},
    artifacts: [],
  }
  const triaged = await triageSkill.execute(seedCtx)
  const data = triaged.data as TriageData
  const blueprintName = config.blueprint ?? data.blueprint
  const blueprint = getBlueprint(blueprintName) ?? getBlueprint('default')
  if (!blueprint) throw new Error(`no blueprint registered under "${blueprintName}" and no default fallback`)
  const policies = mergePolicies(basePolicies, blueprint.policies)
  info(`blueprint: ${blueprint.name} (recommended: ${data.blueprint}) policies=${policies.name}`)

  const dispatch: SkillDispatch = async (packet, chunks) => {
    const budget = config.budget ?? DEFAULT_BUDGET
    const { plan } = planTask(task, config.projectRoot, config.policy ?? DEFAULT_POLICY, budget.retryProbability, data.cts.worker_recommendation, budget.maxSpend)
    const worker = plan.ladder[0]
    if (!worker) return makeArtifact('failure', packet.t, 'kernel', { reason: 'no feasible worker for this intent', recoverable: false })
    const result = await dispatchOne(packet, chunks, worker, {
      timeoutMs: config.timeoutMs ?? policies.timeout.workerTimeoutMs,
      maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
      onMetric: (record) => appendMetric(config.projectRoot, record),
    })
    return result.artifact
  }

  const produce = async (): Promise<ProduceResult> => {
    const normalizedTask = data.normalizedTask
    const budget: BudgetConfig = { ...(config.budget ?? DEFAULT_BUDGET), maxInputTokens: policies.budget.maxInputTokens }
    const prepared = prepareDispatch(normalizedTask, { ...config, budget }, data.cts.worker_recommendation)

    if (prepared.kind === 'pointers') {
      const artifact = makeArtifact('pointer-set', taskId, 'kernel', { pointers: prepared.pointers })
      return { artifacts: [artifact], accepted: true, summary: { iterations: 0, escalationDepth: 0, cost: 0, terminationReason: 'tier-0 pointers', status: 'finished' } }
    }
    if (prepared.kind === 'refused') {
      const artifact = makeArtifact('failure', taskId, 'kernel', { reason: prepared.reason, recoverable: false })
      return { artifacts: [artifact], accepted: false, summary: { iterations: 0, escalationDepth: 0, cost: 0, terminationReason: `budget refused: ${prepared.reason}`, status: 'finished' } }
    }

    const contextService = defaultContextService(config.projectRoot, prepared.intent, budget, policies.context)

    const { loopResult } = await executePrepared(prepared, {
      projectRoot: config.projectRoot,
      timeoutMs: config.timeoutMs ?? policies.timeout.workerTimeoutMs,
      maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
      bounds: boundsFromPolicies(policies),
      contextService,
      onMetric: (record) => appendMetric(config.projectRoot, record),
    })

    return {
      artifacts: loopResult.finalOutput ? [loopResult.finalOutput] : [],
      accepted: loopResult.accepted,
      summary: {
        iterations: loopResult.state.iteration,
        escalationDepth: loopResult.state.escalationDepth,
        cost: loopResult.state.cost,
        terminationReason: loopResult.terminationReason,
        status: loopResult.state.status,
      },
    }
  }

  const outcome: RunnerOutcome = await executeBlueprint(blueprint, {
    taskId,
    task,
    raw,
    projectRoot: config.projectRoot,
    policies: basePolicies,
    ucp: ingress.ucp,
    dispatch,
    produce,
    blackboard: { triage: data },
    artifacts: [...triaged.artifacts],
  })

  for (const artifact of outcome.artifacts) {
    saveArtifact(config.projectRoot, artifact)
  }

  if (outcome.kind === 'clarification') {
    return { kind: 'clarification', blueprint: blueprint.name, questions: outcome.questions, artifacts: outcome.artifacts, steps: outcome.steps }
  }
  return {
    kind: 'completed',
    blueprint: blueprint.name,
    accepted: outcome.accepted,
    artifacts: outcome.artifacts,
    steps: outcome.steps,
    ...(outcome.produce ? { produce: outcome.produce } : {}),
  }
}
