// The kernel: the single orchestration pipeline. Entry points (CLI, MCP
// server, future surfaces) are thin harnesses over these three calls — none
// of them may re-implement planning, budgeting, dispatch, or persistence.
//
//   planTask         intent + escalation ladder            (read-only)
//   prepareDispatch  + context + packet + budget verdict   (read-only)
//   runTask          + validation loop + persisted state   (side effects)
import { DEFAULT_BUDGET, type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { compileIntent } from '../capability/intent-compiler.js'
import { planDispatch, type Plan } from '../capability/planner.js'
import { DEFAULT_POLICY, type Policy } from '../capability/policy.js'
import { loadRegistry } from '../worker/registry.js'
import { compileContext, type CompiledContext } from '../retrieval/context-compiler.js'
import { generateWorkPacket } from '../packet/generator.js'
import { enforceBudget, type BudgetResult } from '../packet/budget-controller.js'
import { type UCP } from '../packet/ucp.js'
import { runValidationLoop, type LoopResult } from '../validator/validation-loop.js'
import { runExecutionLoop, ladderProducer, type LoopEngineResult } from '../loop/loop-engine.js'
import { type RouterBounds } from '../loop/router.js'
import { isKind } from '../artifact/artifacts.js'
import { loadState, saveArtifact, updateState } from '../state/store.js'
import { appendMetric, reliabilityOverrides } from '../state/metrics.js'
import { info, warn } from '../core/logger.js'

export interface KernelConfig {
  projectRoot: string
  // Goal keywords for retrieval ranking; derived from the task when omitted.
  goal?: string
  budget?: BudgetConfig
  policy?: Policy
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface PlannedTask {
  intent: TaskIntent
  plan: Plan
}

export function planTask(
  task: string,
  projectRoot: string,
  policy: Policy = DEFAULT_POLICY,
  retryProbability: number = DEFAULT_BUDGET.retryProbability,
): PlannedTask {
  const intent = compileIntent(task)
  const registry = loadRegistry(projectRoot)
  const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
  const overrides = reliabilityOverrides(projectRoot, priors)
  const plan = planDispatch(intent, registry, policy, overrides, retryProbability)
  return { intent, plan }
}

// A prepared dispatch is one of three shapes: the kernel answered it itself
// (tier 0 pointers), the budget refused it, or a budgeted packet is ready.
export type PreparedDispatch =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; context: CompiledContext; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; context: CompiledContext; reason: string }
  | { kind: 'packet'; intent: TaskIntent; plan: Plan; context: CompiledContext; ucp: UCP; budgeted: BudgetResult }

export function prepareDispatch(task: string, config: KernelConfig): PreparedDispatch {
  const budget = config.budget ?? DEFAULT_BUDGET
  const policy = config.policy ?? DEFAULT_POLICY
  const goal = config.goal ?? task

  const { intent, plan } = planTask(task, config.projectRoot, policy, budget.retryProbability)
  info(`intent: ${intent.taskType}/${intent.complexity} conf=${intent.confidence.toFixed(2)} caps=${intent.capabilities.join('+')}`)

  const context = compileContext(config.projectRoot, goal, intent, budget)
  for (const escalation of context.escalations) {
    info(`context: ${escalation}`)
  }

  // plan.tier0 ⇔ locate intent today, but check both so a future planner may
  // short-circuit other intents deterministically without touching callers.
  if (plan.tier0 || intent.taskType === 'locate') {
    return { kind: 'pointers', intent, plan, context, pointers: context.pointers }
  }

  const previousFacts = loadState(config.projectRoot).distilledFacts
  const ucp = generateWorkPacket(task, context.chunks, previousFacts)
  const spendContext = plan.ladder[0] ? { cost: plan.ladder[0].worker.cost } : undefined
  const budgeted = enforceBudget(ucp, context.chunks, budget, spendContext)

  if (budgeted.refused) {
    return { kind: 'refused', intent, plan, context, reason: budgeted.refusedReason ?? 'budget refused dispatch' }
  }
  if (budgeted.exceeded) {
    warn(`budget exceeded (${budgeted.totalTokens} > ${budget.maxInputTokens}) — reduced context`)
  }
  return { kind: 'packet', intent, plan, context, ucp: budgeted.ucp, budgeted }
}

export type TaskOutcome =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; reason: string }
  | { kind: 'completed'; intent: TaskIntent; plan: Plan; ucp: UCP; result: LoopResult }

// Full pipeline with side effects: dispatch through the validation loop, then
// persist artifacts, task state, and metrics under .cortex/. Every surface
// that executes a task must go through here so persistence never drifts.
export async function runTask(task: string, config: KernelConfig): Promise<TaskOutcome> {
  const prepared = prepareDispatch(task, config)
  if (prepared.kind === 'pointers') {
    return { kind: 'pointers', intent: prepared.intent, plan: prepared.plan, pointers: prepared.pointers }
  }
  if (prepared.kind === 'refused') {
    return { kind: 'refused', intent: prepared.intent, plan: prepared.plan, reason: prepared.reason }
  }

  info('starting validation loop...')
  const result = await runValidationLoop(prepared.ucp, prepared.budgeted.chunks, prepared.plan.ladder, config.projectRoot, {
    timeoutMs: config.timeoutMs ?? 180_000,
    maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
    onMetric: (record) => appendMetric(config.projectRoot, record),
  })

  for (const artifact of result.artifacts) {
    saveArtifact(config.projectRoot, artifact)
  }
  updateState(config.projectRoot, prepared.ucp.t, result.patch, prepared.budgeted.chunks, result.iterations)

  return { kind: 'completed', intent: prepared.intent, plan: prepared.plan, ucp: prepared.ucp, result }
}

// ── CUEA closed-loop entry ────────────────────────────────────────────────
// The Producer → Evaluator → Router loop over the same prepared dispatch that
// runTask uses. Unlike runTask (which delegates escalation to the ladder walk
// inside a fixed 3-iteration validation loop), runLoop lets the Router own
// every continuation decision under the §6 bounds. Persistence is identical:
// the final artifact and task state land under .cortex/ exactly as runTask.
export interface LoopConfig extends KernelConfig {
  bounds?: RouterBounds
}

export type LoopOutcome =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; reason: string }
  | { kind: 'looped'; intent: TaskIntent; plan: Plan; ucp: UCP; result: LoopEngineResult }

export async function runLoop(task: string, config: LoopConfig): Promise<LoopOutcome> {
  const prepared = prepareDispatch(task, config)
  if (prepared.kind === 'pointers') {
    return { kind: 'pointers', intent: prepared.intent, plan: prepared.plan, pointers: prepared.pointers }
  }
  if (prepared.kind === 'refused') {
    return { kind: 'refused', intent: prepared.intent, plan: prepared.plan, reason: prepared.reason }
  }

  info('starting CUEA execution loop...')
  const producer = ladderProducer(prepared.plan.ladder, config.projectRoot, {
    timeoutMs: config.timeoutMs ?? 180_000,
    maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
    onMetric: (record) => appendMetric(config.projectRoot, record),
  })

  const result = await runExecutionLoop(prepared.ucp, prepared.budgeted.chunks, producer, {
    ...(config.bounds ? { bounds: config.bounds } : {}),
    ladderSize: prepared.plan.ladder.length,
  })

  if (result.finalOutput) {
    saveArtifact(config.projectRoot, result.finalOutput)
  }
  const patch = result.finalOutput && isKind(result.finalOutput, 'patch') ? result.finalOutput.body.diff : ''
  updateState(config.projectRoot, prepared.ucp.t, patch, prepared.budgeted.chunks, result.state.iteration)

  return { kind: 'looped', intent: prepared.intent, plan: prepared.plan, ucp: prepared.ucp, result }
}