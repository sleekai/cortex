// Dispatch planner: executes a DAG of packet dispatches — parallel where
// dependencies allow, sequential where they don't — walking each node's
// escalation ladder on recoverable failure. All execution is async; nothing
// here knows what a worker is beyond its harness.
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

// Walk the escalation ladder for one packet: dispatch rung 0; escalate to the
// next rung only on recoverable failure. Unrecoverable failures (IMPOSSIBLE,
// oracle fail) stop the walk — a smarter model wouldn't fix a broken packet.
export async function dispatchWithLadder(
  packet: UCP,
  chunks: CodeChunk[],
  ladder: ScoredWorker[],
  options: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
): Promise<NodeResult> {
  if (ladder.length === 0) {
    return {
      nodeId: packet.t,
      workerId: 'kernel',
      artifact: makeArtifact('failure', packet.t, 'kernel', {
        reason: 'no feasible worker for this intent',
        recoverable: false,
      }),
      latencyMs: 0,
      attempts: 0,
    }
  }

  const prompt = buildPrompt(packet, chunks)
  const estInputTokens = estimateTokens(prompt)
  let attempts = 0
  let totalLatency = 0
  let lastArtifact: Artifact | null = null
  let lastWorkerId = ladder[0]!.worker.id

  for (const rung of ladder) {
    if (options.signal?.aborted) {
      return {
        nodeId: packet.t,
        workerId: lastWorkerId,
        artifact: makeArtifact('failure', packet.t, 'kernel', { reason: 'cancelled', recoverable: true }),
        latencyMs: totalLatency,
        attempts,
      }
    }
    const worker = rung.worker
    const harness = createHarness(worker.harness)

    if (!harness.available()) {
      warn(`dispatch: worker ${worker.id} unavailable, escalating`)
      continue
    }

    attempts++
    lastWorkerId = worker.id
    info(`dispatch: ${packet.t} → ${worker.id} (tier ${worker.tier}, ${rung.justification})`)

    const result = await harness.invoke({ prompt, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes })
    totalLatency += result.latencyMs

    const artifact: Artifact = result.ok
      ? parseWorkerOutput(result.output, packet, worker.id)
      : makeArtifact('failure', packet.t, worker.id, { reason: result.failReason ?? 'harness failure', recoverable: true })

    const failed = isKind(artifact, 'failure')
    options.onMetric?.({
      at: new Date().toISOString(),
      taskId: packet.t,
      workerId: worker.id,
      tier: worker.tier,
      act: packet.act,
      ok: !failed,
      latencyMs: result.latencyMs,
      estInputTokens,
      estOutputTokens: estimateTokens(result.output),
      iterations: attempts,
      ...(failed ? { failReason: (artifact as Artifact<'failure'>).body.reason } : {}),
    })

    lastArtifact = artifact
    if (!failed) {
      return { nodeId: packet.t, workerId: worker.id, artifact, latencyMs: totalLatency, attempts }
    }
    if (!(artifact as Artifact<'failure'>).body.recoverable) {
      break
    }
    warn(`dispatch: ${worker.id} failed (${(artifact as Artifact<'failure'>).body.reason}), escalating`)
  }

  return {
    nodeId: packet.t,
    workerId: lastWorkerId,
    artifact: lastArtifact ?? makeArtifact('failure', packet.t, 'kernel', {
      reason: 'all ladder workers unavailable',
      recoverable: false,
    }),
    latencyMs: totalLatency,
    attempts,
  }
}

// Execute a DAG: nodes whose dependencies are settled run concurrently up to
// the plan's concurrency bound. A failed node fails its dependents without
// running them (fan-in short-circuit). `options.resumeFrom` seeds settled
// nodes (replay skips them); `options.signal` cancels at node boundaries;
// `options.onNodeComplete` fires per dispatched node for checkpointing.
export async function executePlan(
  plan: DispatchPlan,
  ladderFor: (node: DispatchNode) => ScoredWorker[],
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

      const task = dispatchWithLadder(node.packet, node.chunks, ladderFor(node), options)
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
