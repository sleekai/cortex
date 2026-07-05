// The kernel: the single orchestration pipeline. Entry points (CLI, MCP
// server, future surfaces) are thin harnesses over these calls — none
// of them may re-implement planning, budgeting, dispatch, or persistence.
//
//   planTask         intent + escalation ladder            (read-only)
//   prepareDispatch  + context + packet + budget verdict   (read-only)
import { DEFAULT_BUDGET, type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { compileIntent } from '../capability/intent-compiler.js'
import { planDispatch, type Plan } from '../capability/planner.js'
import { DEFAULT_POLICY, type Policy } from '../capability/policy.js'
import { loadRegistry, type WorkerSpec } from '../worker/registry.js'
import { createHarness } from '../harness/harness.js'
import { readMetrics, aggregateStats } from '../state/metrics.js'
import { compileContext, type CompiledContext } from '../retrieval/context-compiler.js'
import { generateWorkPacket } from '../packet/generator.js'
import { enforceBudget, type BudgetResult } from '../packet/budget-controller.js'
import { type UCP } from '../packet/ucp.js'
import { loadState } from '../state/store.js'
import { reliabilityOverrides } from '../state/metrics.js'
import { info, warn } from '../core/logger.js'

export interface KernelConfig {
  projectRoot: string
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
  tierHint?: string,
  maxSpend: number = DEFAULT_BUDGET.maxSpend,
): PlannedTask {
  const intent = compileIntent(task)
  const registry = loadRegistry(projectRoot)
  const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
  const overrides = reliabilityOverrides(projectRoot, priors)
  const plan = planDispatch(intent, registry, policy, overrides, retryProbability, tierHint, maxSpend)
  return { intent, plan }
}

export type PreparedDispatch =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; context: CompiledContext; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; context: CompiledContext; reason: string }
  | { kind: 'packet'; intent: TaskIntent; plan: Plan; context: CompiledContext; ucp: UCP; budgeted: BudgetResult }

export function prepareDispatch(task: string, config: KernelConfig, tierHint?: string): PreparedDispatch {
  const budget = config.budget ?? DEFAULT_BUDGET
  const policy = config.policy ?? DEFAULT_POLICY
  const goal = config.goal ?? task

  const { intent, plan } = planTask(task, config.projectRoot, policy, budget.retryProbability, tierHint, budget.maxSpend)
  info(`intent: ${intent.taskType}/${intent.complexity} conf=${intent.confidence.toFixed(2)} caps=${intent.capabilities.join('+')}`)

  const context = compileContext(config.projectRoot, goal, intent, budget)
  for (const escalation of context.escalations) {
    info(`context: ${escalation}`)
  }

  if (plan.tier0 || intent.taskType === 'locate') {
    return { kind: 'pointers', intent, plan, context, pointers: context.pointers }
  }

  if (plan.ladder.length === 0) {
    const reason = plan.excluded.length > 0
      ? plan.excluded[0]!.reason
      : 'no feasible workers for this intent'
    return { kind: 'refused', intent, plan, context, reason }
  }

  const previousFacts = loadState(config.projectRoot).distilledFacts
  const ucp = generateWorkPacket(task, context.chunks, previousFacts)
  const spendContext = { cost: plan.ladder[0]!.worker.cost }
  const budgeted = enforceBudget(ucp, context.chunks, budget, spendContext)

  if (budgeted.refused) {
    return { kind: 'refused', intent, plan, context, reason: budgeted.refusedReason ?? 'budget refused dispatch' }
  }
  if (budgeted.exceeded) {
    warn(`budget exceeded (${budgeted.totalTokens} > ${budget.maxInputTokens}) — reduced context`)
  }
  return { kind: 'packet', intent, plan, context, ucp: budgeted.ucp, budgeted }
}

export function runLocate(task: string, projectRoot: string, goal?: string): string[] {
  const intent = { ...compileIntent(task), taskType: 'locate' as const }
  const context = compileContext(projectRoot, goal ?? task, intent, DEFAULT_BUDGET)
  return context.pointers
}

export interface WorkerInfo {
  id: string
  tier: number
  capabilities: string[]
  harnessKind: string
  available: boolean
  availableError?: string
  successRate?: number
  dispatches?: number
}

export function listWorkers(projectRoot: string): WorkerInfo[] {
  const registry = loadRegistry(projectRoot)
  const stats = aggregateStats(readMetrics(projectRoot))
  return registry.workers.map((w: WorkerSpec) => {
    let available = false
    let availableError: string | undefined
    try {
      available = createHarness(w.harness).available()
    } catch (e: unknown) {
      availableError = e instanceof Error ? e.message : String(e)
    }
    const s = stats.get(w.id)
    return {
      id: w.id,
      tier: w.tier,
      capabilities: [...w.capabilities],
      harnessKind: w.harness.kind,
      available,
      availableError,
      ...(s ? { successRate: s.successRate, dispatches: s.dispatches } : {}),
    }
  })
}
