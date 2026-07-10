// The kernel: the single orchestration pipeline. Entry points (CLI, MCP
// server, future surfaces) are thin harnesses over these calls — none
// of them may re-implement planning, budgeting, dispatch, or persistence.
//
//   planTask         intent + escalation ladder            (read-only)
//   prepareDispatch  + context + packet + budget verdict   (read-only)
import { DEFAULT_BUDGET, type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { planDispatch, type Plan } from '../capability/planner.js'
import { DEFAULT_CONSTRAINTS, type PlannerConstraints } from '../capability/constraints.js'
import { loadRegistry, type WorkerSpec } from '../worker/registry.js'
import { createHarness } from '../harness/harness.js'
import { readMetrics, aggregateStats } from '../state/metrics.js'
import { type CompiledContext } from '../retrieval/context-compiler.js'
import { generateWorkPacket } from '../packet/generator.js'
import { enforceBudget, type BudgetResult } from '../packet/budget-controller.js'
import { type UCP } from '../packet/ucp.js'
import { loadState } from '../state/store.js'
import { reliabilityOverrides } from '../state/metrics.js'
import { info, warn } from '../core/logger.js'
import { type Artifact } from '../artifact/artifacts.js'
import { compressChunks, makeCompressionArtifact } from '../runtime/compression.js'
import { DEFAULT_COMPILER_RUNTIME, type CompilerRuntime } from '../compiler/runtime.js'

export interface KernelConfig {
  projectRoot: string
  goal?: string
  budget?: BudgetConfig
  constraints?: PlannerConstraints
  timeoutMs?: number
  maxOutputBytes?: number
  // Opt-in CTS seam: when true, the triage pipeline runs once inside the
  // kernel — its normalized task and tier hint feed planning. When false or
  // absent, triage never runs and planning sees the raw task (pre-CTS
  // behaviour).
  triage?: boolean
  // Injected CompilerRuntime (defaults to the global runtime).
  compilerRuntime?: CompilerRuntime
}

export interface PlannedTask {
  intent: TaskIntent
  plan: Plan
}

export function planTask(
  task: string,
  projectRoot: string,
  constraints: PlannerConstraints = DEFAULT_CONSTRAINTS,
  retryProbability: number = DEFAULT_BUDGET.retryProbability,
  tierHint?: string,
  maxSpend: number = DEFAULT_BUDGET.maxSpend,
  runtime?: CompilerRuntime,
): PlannedTask {
  const { compileIntent } = runtime ?? DEFAULT_COMPILER_RUNTIME
  const intent = compileIntent(task)
  const registry = loadRegistry(projectRoot)
  const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
  const overrides = reliabilityOverrides(projectRoot, priors)
  const plan = planDispatch(intent, registry, constraints, overrides, retryProbability, tierHint, maxSpend)
  return { intent, plan }
}

export type PreparedDispatch =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; context: CompiledContext; pointers: string[]; artifacts: Artifact[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; context: CompiledContext; reason: string; artifacts: Artifact[] }
  | { kind: 'packet'; intent: TaskIntent; plan: Plan; context: CompiledContext; ucp: UCP; budgeted: BudgetResult; artifacts: Artifact[] }

export function prepareDispatch(task: string, config: KernelConfig, tierHint?: string): PreparedDispatch {
  const runtime = config.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME
  const { compileContext, makeArtifact } = runtime
  const budget = config.budget ?? DEFAULT_BUDGET
  const constraints = config.constraints ?? DEFAULT_CONSTRAINTS
  const goal = config.goal ?? task

  const { intent, plan } = planTask(task, config.projectRoot, constraints, budget.retryProbability, tierHint, budget.maxSpend, runtime)
  info(`intent: ${intent.taskType}/${intent.complexity} conf=${intent.confidence.toFixed(2)} caps=${intent.capabilities.join('+')}`)

  const context = compileContext(config.projectRoot, goal, intent, budget)
  for (const escalation of context.escalations) {
    info(`context: ${escalation}`)
  }

  if (plan.tier0 || intent.taskType === 'locate') {
    const taskId = `plan-${Buffer.from(task).toString('base64url').slice(0, 8)}`
    const compressed = compressChunks(context.chunks, 300)
    return {
      kind: 'pointers',
      intent,
      plan,
      context,
      pointers: context.pointers,
      artifacts: [
        makeArtifact('context', taskId, 'context-compiler', {
          level: context.level,
          pointers: context.pointers,
          chunkCount: context.chunks.length,
          estimatedTokens: context.estTokens,
          compressedText: compressed.text,
        }),
        makeCompressionArtifact(taskId, 'context', compressed, makeArtifact),
      ],
    }
  }

  if (plan.ladder.length === 0) {
    const reason = plan.excluded.length > 0
      ? plan.excluded[0]!.reason
      : 'no feasible workers for this intent'
    return { kind: 'refused', intent, plan, context, reason, artifacts: [] }
  }

  const previousFacts = loadState(config.projectRoot).distilledFacts
  const ucp = generateWorkPacket(task, context.chunks, previousFacts)
  const contextCompression = compressChunks(context.chunks, 300)
  const planArtifact = makeArtifact('plan', ucp.t, 'capability-planner', {
    steps: plan.ladder.map((w, i) => `${i + 1}. ${w.worker.id} tier=${w.worker.tier} ${w.justification}`),
    workerLadder: plan.ladder.map(w => w.worker.id),
    entryTier: plan.entryTier,
    expectedSpend: plan.ladder.reduce((sum, w) => sum + w.expectedSpend, 0),
  })
  const contextArtifact = makeArtifact('context', ucp.t, 'context-compiler', {
    level: context.level,
    pointers: context.pointers,
    chunkCount: context.chunks.length,
    estimatedTokens: context.estTokens,
    compressedText: contextCompression.text,
  })
  const spendContext = { cost: plan.ladder[0]!.worker.cost }
  const budgeted = enforceBudget(ucp, context.chunks, budget, spendContext)
  const artifacts: Artifact[] = [
    planArtifact,
    contextArtifact,
    makeCompressionArtifact(ucp.t, 'context', contextCompression, makeArtifact),
  ]
  if (budgeted.spend) {
    artifacts.push(makeArtifact('cost', ucp.t, 'cost-engine', {
      promptTokens: budgeted.spend.inputTokens,
      completionTokens: budgeted.spend.outputTokens,
      cumulativeCost: budgeted.spend.expectedSpend,
      compressionSavings: contextCompression.savedTokens,
      escalationCost: 0,
      estimatedRemainingBudget: Number.isFinite(budget.maxSpend)
        ? Math.max(0, budget.maxSpend - budgeted.spend.expectedSpend)
        : Number.POSITIVE_INFINITY,
    }))
  }

  if (budgeted.refused) {
    return { kind: 'refused', intent, plan, context, reason: budgeted.refusedReason ?? 'budget refused dispatch', artifacts }
  }
  if (budgeted.exceeded) {
    warn(`budget exceeded (${budgeted.totalTokens} > ${budget.maxInputTokens}) — reduced context`)
  }
  return { kind: 'packet', intent, plan, context, ucp: budgeted.ucp, budgeted, artifacts }
}

export function runLocate(task: string, projectRoot: string, goal?: string, runtime?: CompilerRuntime): string[] {
  const { compileIntent, compileContext } = runtime ?? DEFAULT_COMPILER_RUNTIME
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
