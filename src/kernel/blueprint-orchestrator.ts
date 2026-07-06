import { DEFAULT_BUDGET, type BudgetConfig } from '../core/types.js'
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type CodeChunk } from '../core/types.js'
import { type CapabilityProfile, type SkillContext, type SkillDispatch } from '../skill/skill.js'
import { DEFAULT_COMPILER_RUNTIME } from '../compiler/runtime.js'
import { triageSkill, type TriageData } from '../skill/builtins.js'
import { getBlueprint } from '../blueprint/blueprint.js'
import { executeBlueprint, type BlueprintOutcome as RunnerOutcome, type ExecutedStep, type ProduceResult } from '../blueprint/runner.js'
import { type PolicySet, DEFAULT_POLICIES, mergePolicies, boundsFromPolicies } from '../policy/policies.js'
import { loadRegistry } from '../worker/registry.js'
import { dispatchOne } from '../worker/dispatch.js'
import { normalizeInput } from '../ingress/ingress.js'
import { appendMetric } from '../state/metrics.js'
import { saveArtifact } from '../state/store.js'
import { info, debug } from '../core/logger.js'
import { planTask, prepareDispatch, type KernelConfig } from './kernel.js'
import { DEFAULT_CONSTRAINTS } from '../capability/constraints.js'
import { DefaultResolver, type CapabilityResolver } from '../capability/resolver.js'
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

  const runtime = config.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME

  const seedCtx: SkillContext = {
    taskId,
    task,
    raw,
    projectRoot: config.projectRoot,
    ucp: ingress.ucp,
    policies: basePolicies,
    blackboard: {},
    artifacts: [],
    compilerRuntime: runtime,
  }
  const triaged = await triageSkill.execute(seedCtx)
  const data = triaged.data as TriageData
  const blueprintName = config.blueprint ?? data.blueprint
  const blueprint = getBlueprint(blueprintName) ?? getBlueprint('default')
  if (!blueprint) throw new Error(`no blueprint registered under "${blueprintName}" and no default fallback`)
  const policies = mergePolicies(basePolicies, blueprint.policies)
  info(`blueprint: ${blueprint.name} (recommended: ${data.blueprint}) policies=${policies.name}`)

  const resolver: CapabilityResolver = new DefaultResolver()

  const dispatch: SkillDispatch = async (packet, chunks, profile?) => {
    const { makeArtifact } = runtime

    if (profile) {
      // Per-skill resolution: resolve workers against the skill's own profile
      // instead of inheriting the task's plan. This lets judgment skills
      // (summarize, review) select workers optimized for their requirements.
      const capabilities = profile.minimum.map(r => r.capability)
      const budget = config.budget ?? DEFAULT_BUDGET
      const constraints = config.constraints ?? DEFAULT_CONSTRAINTS
      const resolution = resolver.resolve({
        capabilities: capabilities.length > 0 ? capabilities : ['reasoning'],
        profile,
        estTokenBudget: budget.maxInputTokens * 10,
        retryProbability: budget.retryProbability,
      }, loadRegistry(config.projectRoot), constraints)
      const worker = resolution.ladder[0]
      if (!worker) {
        debug(`skill dispatch: no feasible worker for profile ${JSON.stringify(profile)} — ${resolution.excluded.map(e => e.reason).join('; ')}`)
        return makeArtifact('failure', packet.t, 'kernel', { reason: 'no feasible worker for this skill profile', recoverable: false })
      }
      const result = await dispatchOne(packet, chunks, worker, {
        timeoutMs: config.timeoutMs ?? policies.timeout.workerTimeoutMs,
        maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
        onMetric: (record) => appendMetric(config.projectRoot, record),
        compilerRuntime: runtime,
      })
      return result.artifact
    }

    const b = config.budget ?? DEFAULT_BUDGET
    const { plan } = planTask(task, config.projectRoot, config.constraints ?? DEFAULT_CONSTRAINTS, b.retryProbability, data.cts.worker_recommendation, b.maxSpend, runtime)
    const worker = plan.ladder[0]
    if (!worker) return makeArtifact('failure', packet.t, 'kernel', { reason: 'no feasible worker for this intent', recoverable: false })
    const result = await dispatchOne(packet, chunks, worker, {
      timeoutMs: config.timeoutMs ?? policies.timeout.workerTimeoutMs,
      maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
      onMetric: (record) => appendMetric(config.projectRoot, record),
      compilerRuntime: runtime,
    })
    return result.artifact
  }

  const produce = async (): Promise<ProduceResult> => {
    const { makeArtifact } = runtime
    const normalizedTask = data.normalizedTask
    const budget: BudgetConfig = { ...(config.budget ?? DEFAULT_BUDGET), maxInputTokens: policies.budget.maxInputTokens }
    const prepared = prepareDispatch(normalizedTask, { ...config, budget, compilerRuntime: runtime }, data.cts.worker_recommendation)

    if (prepared.kind === 'pointers') {
      const artifact = makeArtifact('pointer-set', taskId, 'kernel', { pointers: prepared.pointers })
      return { artifacts: [...prepared.artifacts, artifact], accepted: true, summary: { iterations: 0, escalationDepth: 0, cost: 0, terminationReason: 'tier-0 pointers', status: 'finished' } }
    }
    if (prepared.kind === 'refused') {
      const artifact = makeArtifact('failure', taskId, 'kernel', { reason: prepared.reason, recoverable: false })
      return { artifacts: [...prepared.artifacts, artifact], accepted: false, summary: { iterations: 0, escalationDepth: 0, cost: 0, terminationReason: `budget refused: ${prepared.reason}`, status: 'finished' } }
    }

    const contextService = defaultContextService(config.projectRoot, prepared.intent, budget, policies.context, runtime)

    const { loopResult, artifacts } = await executePrepared(prepared, {
      projectRoot: config.projectRoot,
      timeoutMs: config.timeoutMs ?? policies.timeout.workerTimeoutMs,
      maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
      bounds: boundsFromPolicies(policies),
      contextService,
      compilerRuntime: runtime,
      onMetric: (record) => appendMetric(config.projectRoot, record),
    })

    return {
      artifacts,
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
