import { type UCP } from '../packet/ucp.js'
import { type Plan } from '../capability/planner.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { type BudgetResult } from '../packet/budget-controller.js'
import { type RouterBounds } from '../loop/router.js'
import { type MetricRecord } from '../state/metrics.js'
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type ContextService } from '../loop/context-service.js'
import { runExecutionLoop, ladderProducer, type LoopEngineResult } from '../loop/loop-engine.js'
import { saveArtifact, updateState } from '../state/store.js'
import { appendMetric } from '../state/metrics.js'
import { info } from '../core/logger.js'
import { prepareDispatch, type PreparedDispatch, type KernelConfig } from './kernel.js'
import { normalizeInput } from '../ingress/ingress.js'
import { runTriage } from '../triage/pipeline.js'

export type TaskOutcome =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; reason: string }
  | { kind: 'completed'; intent: TaskIntent; plan: Plan; ucp: UCP; result: LoopEngineResult }

interface ExecutePreparedOptions {
  projectRoot: string
  timeoutMs: number
  maxOutputBytes: number
  bounds?: RouterBounds
  contextService?: ContextService
  onMetric?: (record: MetricRecord) => void
}

async function executePrepared(
  prepared: PreparedDispatch & { kind: 'packet'; ucp: UCP; budgeted: BudgetResult },
  opts: ExecutePreparedOptions,
): Promise<{ loopResult: LoopEngineResult; patch: string }> {
  const producer = ladderProducer(prepared.plan.ladder, opts.projectRoot, {
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
    onMetric: opts.onMetric,
  })
  const loopResult = await runExecutionLoop(prepared.ucp, prepared.budgeted.chunks, producer, {
    ...(opts.bounds ? { bounds: opts.bounds } : {}),
    ladderSize: prepared.plan.ladder.length,
    ...(opts.contextService ? { contextService: opts.contextService } : {}),
  })

  if (loopResult.finalOutput) {
    saveArtifact(opts.projectRoot, loopResult.finalOutput)
  }
  const patch = loopResult.finalOutput && isKind(loopResult.finalOutput, 'patch') ? loopResult.finalOutput.body.diff : ''
  updateState(opts.projectRoot, prepared.ucp.t, patch, prepared.budgeted.chunks, loopResult.state.iteration)

  return { loopResult, patch }
}

export { executePrepared }

export async function runTask(task: string, config: KernelConfig): Promise<TaskOutcome> {
  const goal = config.goal ?? task
  const ingress = normalizeInput({ content: task, kind: 'unknown', explicitGoal: goal })
  const triage = runTriage({ ucp: ingress.ucp, raw: task })
  const prepared = prepareDispatch(task, config, triage.worker_recommendation)
  if (prepared.kind === 'pointers') {
    return { kind: 'pointers', intent: prepared.intent, plan: prepared.plan, pointers: prepared.pointers }
  }
  if (prepared.kind === 'refused') {
    return { kind: 'refused', intent: prepared.intent, plan: prepared.plan, reason: prepared.reason }
  }

  info('starting CUEA execution loop...')
  const { loopResult } = await executePrepared(prepared, {
    projectRoot: config.projectRoot,
    timeoutMs: config.timeoutMs ?? 180_000,
    maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
    onMetric: (record) => appendMetric(config.projectRoot, record),
  })
  return { kind: 'completed', intent: prepared.intent, plan: prepared.plan, ucp: prepared.ucp, result: loopResult }
}

export interface LoopConfig extends KernelConfig {
  bounds?: RouterBounds
}

export type LoopOutcome =
  | { kind: 'pointers'; intent: TaskIntent; plan: Plan; pointers: string[] }
  | { kind: 'refused'; intent: TaskIntent; plan: Plan; reason: string }
  | { kind: 'looped'; intent: TaskIntent; plan: Plan; ucp: UCP; result: LoopEngineResult }

export async function runLoop(task: string, config: LoopConfig): Promise<LoopOutcome> {
  const goal = config.goal ?? task
  const ingress = normalizeInput({ content: task, kind: 'unknown', explicitGoal: goal })
  const triage = runTriage({ ucp: ingress.ucp, raw: task })
  const prepared = prepareDispatch(task, config, triage.worker_recommendation)
  if (prepared.kind === 'pointers') {
    return { kind: 'pointers', intent: prepared.intent, plan: prepared.plan, pointers: prepared.pointers }
  }
  if (prepared.kind === 'refused') {
    return { kind: 'refused', intent: prepared.intent, plan: prepared.plan, reason: prepared.reason }
  }

  info('starting CUEA execution loop...')
  const { loopResult } = await executePrepared(prepared, {
    projectRoot: config.projectRoot,
    timeoutMs: config.timeoutMs ?? 180_000,
    maxOutputBytes: config.maxOutputBytes ?? 10 * 1024 * 1024,
    bounds: config.bounds,
    onMetric: (record) => appendMetric(config.projectRoot, record),
  })
  return { kind: 'looped', intent: prepared.intent, plan: prepared.plan, ucp: prepared.ucp, result: loopResult }
}
