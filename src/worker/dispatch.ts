// Dispatch planner: executes a DAG of packet dispatches — parallel where
// dependencies allow, sequential where they don't. Escalation is handled by
// the CUEA loop; dispatchOne is single-rung only. All execution is async;
// nothing here knows what a worker is beyond its harness.
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk } from '../core/types.js'
import { type Artifact, makeArtifact, isKind } from '../artifact/artifacts.js'
import { type ScoredWorker } from '../capability/planner.js'
import { createHarness } from '../harness/harness.js'
import { buildPrompt } from './prompt.js'
import { parseWorkerOutput } from './output-parser.js'
import { type MetricRecord } from '../state/metrics.js'
import { estimateTokens } from '../core/tokens.js'
import { info, warn } from '../core/logger.js'

export interface DispatchNode {
  id: string
  packet: UCP
  chunks: CodeChunk[]
  dependsOn: string[]
}

export interface DispatchPlan {
  nodes: DispatchNode[]
  concurrency: number
}

export interface NodeResult {
  nodeId: string
  workerId: string
  artifact: Artifact
  latencyMs: number
  attempts: number
}

export interface DispatchOptions {
  timeoutMs: number
  maxOutputBytes: number
  onMetric?: (record: MetricRecord) => void
  // Fires once per node this run actually dispatched (not for synthetic
  // dependency-failure or cancellation results) — the checkpointing seam.
  onNodeComplete?: (result: NodeResult) => void
  // Cancellation is cooperative and settles at node/rung boundaries: nothing
  // new is launched after abort, but an in-flight harness call runs to
  // completion (true mid-call abort needs harness support; deferred).
  signal?: AbortSignal
  // Resume/replay: nodes whose ids appear here are treated as already
  // settled and are not re-executed (partial recomputation).
  resumeFrom?: ReadonlyMap<string, NodeResult>
}

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  timeoutMs: 180_000,
  maxOutputBytes: 10 * 1024 * 1024,
}

// Dispatch a single packet to one worker. Escalation is the CUEA loop's
// responsibility — this function owns one-shot dispatch only.
export async function dispatchOne(
  packet: UCP,
  chunks: CodeChunk[],
  worker: ScoredWorker,
  options: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
): Promise<NodeResult> {
  const prompt = buildPrompt(packet, chunks)
  const estInputTokens = estimateTokens(prompt)
  const harness = createHarness(worker.worker.harness)

  if (!harness.available()) {
    return {
      nodeId: packet.t,
      workerId: worker.worker.id,
      artifact: makeArtifact('failure', packet.t, 'kernel', {
        reason: `worker ${worker.worker.id} unavailable`,
        recoverable: true,
      }),
      latencyMs: 0,
      attempts: 0,
    }
  }

  if (options.signal?.aborted) {
    return {
      nodeId: packet.t,
      workerId: worker.worker.id,
      artifact: makeArtifact('failure', packet.t, 'kernel', { reason: 'cancelled', recoverable: true }),
      latencyMs: 0,
      attempts: 0,
    }
  }

  info(`dispatch: ${packet.t} → ${worker.worker.id} (tier ${worker.worker.tier}, ${worker.justification})`)

  const result = await harness.invoke({ prompt, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes })
  const artifact: Artifact = result.ok
    ? parseWorkerOutput(result.output, packet, worker.worker.id)
    : makeArtifact('failure', packet.t, worker.worker.id, { reason: result.failReason ?? 'harness failure', recoverable: true })

  const failed = isKind(artifact, 'failure')
  options.onMetric?.({
    at: new Date().toISOString(),
    taskId: packet.t,
    workerId: worker.worker.id,
    tier: worker.worker.tier,
    act: packet.act,
    ok: !failed,
    latencyMs: result.latencyMs,
    estInputTokens,
    estOutputTokens: estimateTokens(result.output),
    iterations: 1,
    ...(failed ? { failReason: (artifact as Artifact<'failure'>).body.reason } : {}),
  })

  return { nodeId: packet.t, workerId: worker.worker.id, artifact, latencyMs: result.latencyMs, attempts: 1 }
}

// Execute a DAG: nodes whose dependencies are settled run concurrently up to
// the plan's concurrency bound. A failed node fails its dependents without
// running them (fan-in short-circuit). `options.resumeFrom` seeds settled
// nodes (replay skips them); `options.signal` cancels at node boundaries;
// `options.onNodeComplete` fires per dispatched node for checkpointing.
export async function executePlan(
  plan: DispatchPlan,
  workerFor: (node: DispatchNode) => ScoredWorker,
  options: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
): Promise<Map<string, NodeResult>> {
  const results = new Map<string, NodeResult>()
  const pending = new Map(plan.nodes.map(n => [n.id, n]))
  const running = new Map<string, Promise<void>>()
  const concurrency = Math.max(1, plan.concurrency)

  if (options.resumeFrom) {
    for (const [id, prior] of options.resumeFrom) {
      if (pending.has(id)) {
        results.set(id, prior)
        pending.delete(id)
        info(`dispatch: node ${id} restored from checkpoint, skipping`)
      }
    }
  }

  const isFailure = (r: NodeResult) => isKind(r.artifact, 'failure')

  while (pending.size > 0 || running.size > 0) {
    if (options.signal?.aborted && pending.size > 0) {
      for (const [id, node] of pending) {
        results.set(id, {
          nodeId: id,
          workerId: 'kernel',
          artifact: makeArtifact('failure', node.packet.t, 'kernel', {
            reason: 'cancelled',
            recoverable: true,
          }),
          latencyMs: 0,
          attempts: 0,
        })
      }
      pending.clear()
      warn(`dispatch: cancelled — ${running.size} in-flight node(s) draining`)
    }

    for (const [id, node] of pending) {
      if (running.size >= concurrency) break
      const deps = node.dependsOn.map(d => results.get(d))
      if (node.dependsOn.some(d => !results.has(d) && pending.has(d))) continue
      if (node.dependsOn.some(d => !results.has(d) && running.has(d))) continue

      pending.delete(id)

      const failedDep = deps.find(d => d && isFailure(d))
      if (failedDep || node.dependsOn.some(d => !results.has(d))) {
        results.set(id, {
          nodeId: id,
          workerId: 'kernel',
          artifact: makeArtifact('failure', node.packet.t, 'kernel', {
            reason: `dependency ${failedDep?.nodeId ?? 'missing'} failed`,
            recoverable: false,
          }),
          latencyMs: 0,
          attempts: 0,
        })
        continue
      }

      const task = dispatchOne(node.packet, node.chunks, workerFor(node), options)
        .then(r => {
          const settled = { ...r, nodeId: id }
          results.set(id, settled)
          options.onNodeComplete?.(settled)
        })
        .finally(() => { running.delete(id) })
      running.set(id, task)
    }

    if (running.size > 0) {
      await Promise.race(running.values())
    } else if (pending.size > 0) {
      // Remaining nodes have unsatisfiable dependencies (cycle or bad id).
      for (const [id, node] of pending) {
        results.set(id, {
          nodeId: id,
          workerId: 'kernel',
          artifact: makeArtifact('failure', node.packet.t, 'kernel', {
            reason: 'unsatisfiable dependencies (cycle or unknown node id)',
            recoverable: false,
          }),
          latencyMs: 0,
          attempts: 0,
        })
      }
      pending.clear()
    }
  }

  return results
}
