import { type UCP } from '../packet/ucp.js'
import { type Plan } from '../capability/planner.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { type BudgetResult } from '../packet/budget-controller.js'
import { type RouterBounds } from '../loop/router.js'
import { type MetricRecord } from '../state/metrics.js'
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type CompilerRuntime, DEFAULT_COMPILER_RUNTIME } from '../compiler/runtime.js'
import { type ContextService, defaultContextService } from '../loop/context-service.js'
import { type ContextPolicy, DEFAULT_POLICIES } from '../policy/policies.js'
import { runExecutionLoop, ladderProducer, type LoopEngineResult } from '../loop/loop-engine.js'
import { saveArtifact, updateState } from '../state/store.js'
import { appendMetric } from '../state/metrics.js'
import { DEFAULT_BUDGET } from '../core/types.js'
import { info } from '../core/logger.js'
import { prepareDispatch, type PreparedDispatch, type KernelConfig } from './kernel.js'
import { normalizeInput } from '../ingress/ingress.js'
import { runTriage } from '../triage/pipeline.js'

export interface ExecuteConfig extends KernelConfig {
  // Router bounds for the CUEA loop. Absent means the loop engine's
  // DEFAULT_BOUNDS — `cortex dispatch` and `cortex loop` are the same call
  // with different defaults.
  bounds?: RouterBounds
  // Governs mid-loop context-on-demand fetches. Defaults to the default
  // policy set's context policy.
  contextPolicy?: ContextPolicy
}

export type TaskOutcome =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; reason: string }
  | { kind: 'completed'; intent: TaskIntent; plan: Plan; ucp: UCP; result: LoopEngineResult; artifacts: Artifact[] }

interface ExecutePreparedOptions {
  projectRoot: string
  timeoutMs: number
  maxOutputBytes: number
  bounds?: RouterBounds
  contextService?: ContextService
  onMetric?: (record: MetricRecord) => void
  compilerRuntime?: CompilerRuntime
}

async function executePrepared(
  prepared: PreparedDispatch & { kind: 'packet'; ucp: UCP; budgeted: BudgetResult },
  opts: ExecutePreparedOptions,
): Promise<{ loopResult: LoopEngineResult; patch: string; artifacts: Artifact[] }> {
  const runtime = opts.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME
  const { makeArtifact } = runtime
  const producer = ladderProducer(prepared.plan.ladder, opts.projectRoot, {
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    onMetric: opts.onMetric,
    compilerRuntime: runtime,
  })
  const loopResult = await runExecutionLoop(prepared.ucp, prepared.budgeted.chunks, producer, {
    ...(opts.bounds ? { bounds: opts.bounds } : {}),
    ladderSize: prepared.plan.ladder.length,
    ...(opts.contextService ? { contextService: opts.contextService } : {}),
    compilerRuntime: runtime,
  })

  const historyTokens = loopResult.state.history.reduce((sum, h) => ({
    prompt: sum.prompt + (h.promptTokens ?? 0),
    completion: sum.completion + (h.completionTokens ?? 0),
  }), { prompt: 0, completion: 0 })
  const executionArtifact = makeArtifact('execution', prepared.ucp.t, 'cuea-loop', {
    accepted: loopResult.accepted,
    iterations: loopResult.state.iteration,
    escalationDepth: loopResult.state.escalationDepth,
    cost: loopResult.state.cost,
    terminationReason: loopResult.terminationReason,
    ...(loopResult.finalOutput ? { finalArtifactId: loopResult.finalOutput.id } : {}),
  })
  const finalArtifact = makeArtifact('final', prepared.ucp.t, 'kernel', {
    accepted: loopResult.accepted,
    ...(loopResult.finalOutput ? { artifactId: loopResult.finalOutput.id } : {}),
    summary: loopResult.terminationReason,
    cost: loopResult.state.cost,
    tokenUsage: { promptTokens: historyTokens.prompt, completionTokens: historyTokens.completion },
  })
  const artifacts = [
    ...prepared.artifacts,
    ...loopResult.artifacts,
    executionArtifact,
    finalArtifact,
    ...(loopResult.finalOutput ? [loopResult.finalOutput] : []),
  ]
  for (const artifact of artifacts) {
    saveArtifact(opts.projectRoot, artifact)
  }
  const patch = loopResult.finalOutput && isKind(loopResult.finalOutput, 'patch') ? loopResult.finalOutput.body.diff : ''
  updateState(opts.projectRoot, prepared.ucp.t, patch, prepared.budgeted.chunks, loopResult.state.iteration)

  return { loopResult, patch, artifacts }
}

export { executePrepared }

// Opt-in CTS seam: triage runs at most once, here. When config.triage is
// off, planning sees the raw task and no tier hint — pre-CTS behaviour.
// Exported so read-only previews (CLI --dry-run, MCP plan) show exactly what
// a real run would dispatch.
export function triagedTask(task: string, config: KernelConfig): { task: string; tierHint?: string } {
  if (!config.triage) return { task }
  const goal = config.goal ?? task
  const ingress = normalizeInput({ content: task, kind: 'unknown', explicitGoal: goal })
  const cts = runTriage({ ucp: ingress.ucp, raw: task })
  info(`triage: recommend ${cts.worker_recommendation}, ambiguity ${cts.ambiguity.score.toFixed(2)}`)
  for (const q of cts.ambiguity.questions) info(`triage clarify: ${q}`)
  return { task: cts.normalized_task, tierHint: cts.worker_recommendation }
}

// The single execution entry: triage (opt-in) → plan → context → packet →
// budget → CUEA loop with context-on-demand → persistence. `cortex dispatch`
// and `cortex loop` are this call with different bounds.
export async function executeTask(task: string, config: ExecuteConfig): Promise<TaskOutcome> {
  const triaged = triagedTask(task, config)
  const prepared = prepareDispatch(triaged.task, config, triaged.tierHint)
  if (prepared.kind === 'pointers') {
    return { kind: 'pointers', intent: prepared.intent, plan: prepared.plan, pointers: prepared.pointers }
  }
  if (prepared.kind === 'refused') {
    return { kind: 'refused', intent: prepared.intent, plan: prepared.plan, reason: prepared.reason }
  }

  const runtime = config.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME
  const budget = config.budget ?? DEFAULT_BUDGET
  const contextService = defaultContextService(
    config.projectRoot,
    prepared.intent,
    budget,
    config.contextPolicy ?? DEFAULT_POLICIES.context,
    runtime,
  )

  info('starting CUEA execution loop...')
  const { loopResult, artifacts } = await executePrepared(prepared, {
    projectRoot: config.projectRoot,
    timeoutMs: config.timeoutMs ?? 180_000,
    maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
    bounds: config.bounds,
    contextService,
    compilerRuntime: runtime,
    onMetric: (record) => appendMetric(config.projectRoot, record),
  })
  return { kind: 'completed', intent: prepared.intent, plan: prepared.plan, ucp: prepared.ucp, result: loopResult, artifacts }
}

// Deprecated aliases, kept for callers of the pre-collapse API. runTask and
// runLoop were byte-for-byte twins differing only in bounds and outcome tag;
// both are executeTask now.
export const runTask = executeTask
export const runLoop = executeTask
export type LoopConfig = ExecuteConfig
export type LoopOutcome = TaskOutcome
