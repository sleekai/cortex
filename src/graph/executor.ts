// Superstep executor for state graphs (Pregel-style). Each superstep runs the
// whole frontier concurrently, merges node updates through the channel
// reducers in deterministic (node-id-sorted) order, then computes the next
// frontier from goto overrides, routers, and static edges. Cycles are legal;
// the recursion limit bounds them. A checkpoint is taken before every
// superstep, so failure, cancellation, exhaustion, and interrupts all return
// a resumable snapshot — time travel is replaying from an earlier one.
import { type GraphState, initialState, applyUpdate } from './channels.js'
import {
  START, END, isSend,
  type CompiledGraph, type NodeContext, type NodeOutcome, type Send,
} from './state-graph.js'
import { debug } from '../core/logger.js'

export interface FrontierTask {
  node: string
  // Present only for Send-scheduled tasks: the private map input.
  input?: unknown
}

export interface GraphCheckpoint {
  // Supersteps completed before this snapshot was taken.
  step: number
  state: GraphState
  frontier: FrontierTask[]
  // Frontier nodes that are interrupted re-runs; resumeGraph hands them the
  // resume value via ctx.resume.
  interrupted: string[]
}

export interface Interrupt {
  node: string
  reason: string
  payload?: unknown
}

export type GraphEvent =
  | { kind: 'superstep'; step: number; frontier: string[] }
  | { kind: 'node-start'; step: number; node: string }
  | { kind: 'node-end'; step: number; node: string; interrupted: boolean }

export interface RunOptions {
  // Max supersteps before the run is declared exhausted (bounds cycles).
  recursionLimit?: number
  concurrency?: number
  signal?: AbortSignal
  onEvent?: (ev: GraphEvent) => void
  // Fires with the pre-superstep snapshot — persist it to make any outcome
  // resumable across processes.
  onCheckpoint?: (cp: GraphCheckpoint) => void
}

export type GraphOutcome =
  | { status: 'done'; state: GraphState; steps: number }
  | { status: 'interrupted'; checkpoint: GraphCheckpoint; interrupts: Interrupt[] }
  | { status: 'cancelled'; checkpoint: GraphCheckpoint }
  | { status: 'exhausted'; checkpoint: GraphCheckpoint }
  // The checkpoint predates the failed superstep: resume re-runs its frontier.
  | { status: 'failed'; checkpoint: GraphCheckpoint; node: string; error: string }

export const DEFAULT_RECURSION_LIMIT = 25
export const DEFAULT_CONCURRENCY = 4

export async function runGraph(
  graph: CompiledGraph,
  input: Record<string, unknown> = {},
  options: RunOptions = {},
): Promise<GraphOutcome> {
  // Input flows through the reducers like any node update, so unknown
  // channels fail loud before anything runs.
  const state = applyUpdate(graph.channels, initialState(graph.channels), input)
  const frontier = sortTasks(resolveTargets(routeFrom(graph, START, undefined, state)))
  return runLoop(graph, state, frontier, 0, new Set(), undefined, options)
}

export async function resumeGraph(
  graph: CompiledGraph,
  checkpoint: GraphCheckpoint,
  resumeValue: unknown = undefined,
  options: RunOptions = {},
): Promise<GraphOutcome> {
  const state = structuredClone(checkpoint.state)
  const frontier = structuredClone(checkpoint.frontier)
  return runLoop(graph, state, frontier, checkpoint.step, new Set(checkpoint.interrupted), resumeValue, options)
}

function snapshot(step: number, state: GraphState, frontier: FrontierTask[], interrupted: string[]): GraphCheckpoint {
  return { step, state: structuredClone(state), frontier: structuredClone(frontier), interrupted: [...interrupted] }
}

// Stable node-id order makes update application deterministic; Send tasks to
// the same node keep their scheduling order.
function sortTasks(tasks: FrontierTask[]): FrontierTask[] {
  return tasks
    .map((task, i) => ({ task, i }))
    .sort((a, b) => a.task.node.localeCompare(b.task.node) || a.i - b.i)
    .map(({ task }) => task)
}

function routeFrom(
  graph: CompiledGraph,
  node: string,
  outcome: NodeOutcome | undefined,
  state: GraphState,
): Array<string | Send> {
  if (outcome?.goto) return outcome.goto
  const router = graph.routers.get(node)
  if (router) {
    const routed = router(state)
    return Array.isArray(routed) ? routed : [routed]
  }
  return [...(graph.edges.get(node) ?? [])]
}

function resolveTargets(targets: Array<string | Send>): FrontierTask[] {
  const tasks: FrontierTask[] = []
  for (const t of targets) {
    if (isSend(t)) tasks.push({ node: t.node, input: t.input })
    else if (t !== END) tasks.push({ node: t })
  }
  return tasks
}

// Plain (input-less) activations of the same node collapse into one task —
// classic fan-in. Send tasks are never deduplicated: each is a map instance.
function dedupe(tasks: FrontierTask[]): FrontierTask[] {
  const seen = new Set<string>()
  const out: FrontierTask[] = []
  for (const task of tasks) {
    if ('input' in task) {
      out.push(task)
      continue
    }
    if (seen.has(task.node)) continue
    seen.add(task.node)
    out.push(task)
  }
  return out
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function runLoop(
  graph: CompiledGraph,
  state: GraphState,
  frontier: FrontierTask[],
  step: number,
  resumable: Set<string>,
  resumeValue: unknown,
  options: RunOptions,
): Promise<GraphOutcome> {
  const limit = options.recursionLimit ?? DEFAULT_RECURSION_LIMIT
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  while (frontier.length > 0) {
    const cp = snapshot(step, state, frontier, [...resumable])
    if (options.signal?.aborted) {
      return { status: 'cancelled', checkpoint: cp }
    }
    if (step >= limit) {
      return { status: 'exhausted', checkpoint: cp }
    }
    options.onCheckpoint?.(cp)
    options.onEvent?.({ kind: 'superstep', step, frontier: frontier.map(t => t.node) })
    debug(`graph: superstep ${step} frontier=[${frontier.map(t => t.node).join(', ')}]`)

    type Settled = { task: FrontierTask; outcome: NodeOutcome } | { task: FrontierTask; error: string }
    const settled = await mapBounded<FrontierTask, Settled>(frontier, concurrency, async (task) => {
      const fn = graph.nodes.get(task.node)
      if (!fn) return { task, error: `unknown node "${task.node}"` }
      options.onEvent?.({ kind: 'node-start', step, node: task.node })
      const ctx: NodeContext = {
        state,
        step,
        ...('input' in task ? { input: task.input } : {}),
        ...(resumable.has(task.node) ? { resume: resumeValue } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }
      try {
        const outcome = await fn(ctx)
        options.onEvent?.({ kind: 'node-end', step, node: task.node, interrupted: Boolean(outcome.interrupt) })
        return { task, outcome }
      } catch (e: unknown) {
        return { task, error: e instanceof Error ? e.message : String(e) }
      }
    })

    // Resume values are one-shot: consumed by the superstep that re-ran the
    // interrupted node.
    resumable = new Set()
    step++

    const failed = settled.find((s): s is { task: FrontierTask; error: string } => 'error' in s)
    if (failed) {
      return { status: 'failed', checkpoint: cp, node: failed.task.node, error: failed.error }
    }

    const completed = settled as Array<{ task: FrontierTask; outcome: NodeOutcome }>
    const interrupts: Interrupt[] = []
    const interruptedTasks: FrontierTask[] = []
    const nextTargets: FrontierTask[] = []

    for (const { task, outcome } of completed) {
      if (outcome.interrupt) {
        // An interrupted node contributes nothing: its update and goto are
        // dropped and it re-runs (with ctx.resume) after resumeGraph.
        interrupts.push({ node: task.node, reason: outcome.interrupt.reason, ...(outcome.interrupt.payload !== undefined ? { payload: outcome.interrupt.payload } : {}) })
        interruptedTasks.push(task)
        continue
      }
      if (outcome.update) {
        state = applyUpdate(graph.channels, state, outcome.update)
      }
    }

    for (const { task, outcome } of completed) {
      if (outcome.interrupt) continue
      const targets = routeFrom(graph, task.node, outcome, state)
      for (const target of targets) {
        if (!isSend(target) && target !== END && !graph.nodes.has(target)) {
          return { status: 'failed', checkpoint: cp, node: task.node, error: `route to unknown node "${target}"` }
        }
        if (isSend(target) && !graph.nodes.has(target.node)) {
          return { status: 'failed', checkpoint: cp, node: task.node, error: `send to unknown node "${target.node}"` }
        }
      }
      nextTargets.push(...resolveTargets(targets))
    }

    if (interrupts.length > 0) {
      // Peers' updates are already merged and their successors preserved in
      // the resume frontier alongside the interrupted tasks.
      const resumeFrontier = sortTasks([...interruptedTasks, ...dedupe(nextTargets)])
      const checkpoint = snapshot(step, state, resumeFrontier, interruptedTasks.map(t => t.node))
      options.onCheckpoint?.(checkpoint)
      return { status: 'interrupted', checkpoint, interrupts }
    }

    frontier = sortTasks(dedupe(nextTargets))
  }

  return { status: 'done', state, steps: step }
}
