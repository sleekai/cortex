// Single-packet dispatch. Escalation is handled by the CUEA loop;
// dispatchOne is single-rung only. All execution is async; nothing here
// knows what a worker is beyond its harness. (DAG execution deliberately
// deferred — see docs/adr/0001-defer-dag-execution.md.)
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk } from '../core/types.js'
import { type Artifact, makeArtifact, isKind } from '../artifact/artifacts.js'
import { type ScoredWorker } from '../capability/planner.js'
import { createHarness } from '../harness/harness.js'
import { buildPrompt } from './prompt.js'
import { parseWorkerOutput } from './artifact-builder.js'
import { type MetricRecord } from '../state/metrics.js'
import { estimateTokens } from '../core/tokens.js'
import { info } from '../core/logger.js'

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
