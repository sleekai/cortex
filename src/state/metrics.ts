// The learning system: an append-only JSONL log of every dispatch attempt,
// plus aggregation into per-worker reliability that shifts the planner's
// priors. Deterministic and inspectable — no training loops.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { debug, warn } from '../core/logger.js'

export interface MetricRecord {
  at: string
  taskId: string
  workerId: string
  tier: number
  act: string
  ok: boolean
  latencyMs: number
  estInputTokens: number
  estOutputTokens: number
  iterations: number
  contextLevel?: number
  failReason?: string
}

export interface WorkerStats {
  workerId: string
  dispatches: number
  successes: number
  successRate: number
  meanLatencyMs: number
  meanInputTokens: number
  retryRate: number
}

function cortexDir(projectRoot: string): string {
  return process.env['CORTEX_DIR'] ?? path.join(projectRoot, '.cortex')
}

export function metricsPath(projectRoot: string): string {
  return path.join(cortexDir(projectRoot), 'metrics.jsonl')
}

export function appendMetric(projectRoot: string, record: MetricRecord): void {
  const file = metricsPath(projectRoot)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
  } catch (e: unknown) {
    warn(`metrics: append failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function readMetrics(projectRoot: string): MetricRecord[] {
  try {
    const raw = fs.readFileSync(metricsPath(projectRoot), 'utf-8')
    const records: MetricRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as MetricRecord)
      } catch {
        debug('metrics: skipping malformed line')
      }
    }
    return records
  } catch {
    return []
  }
}

export function aggregateStats(records: MetricRecord[]): Map<string, WorkerStats> {
  const byWorker = new Map<string, MetricRecord[]>()
  for (const r of records) {
    const list = byWorker.get(r.workerId) ?? []
    list.push(r)
    byWorker.set(r.workerId, list)
  }

  const stats = new Map<string, WorkerStats>()
  for (const [workerId, list] of byWorker) {
    const successes = list.filter(r => r.ok).length
    const retries = list.filter(r => r.iterations > 1).length
    stats.set(workerId, {
      workerId,
      dispatches: list.length,
      successes,
      successRate: successes / list.length,
      meanLatencyMs: list.reduce((s, r) => s + r.latencyMs, 0) / list.length,
      meanInputTokens: list.reduce((s, r) => s + r.estInputTokens, 0) / list.length,
      retryRate: retries / list.length,
    })
  }
  return stats
}

// Blend a registry prior with observed success rate. The prior acts as `w`
// pseudo-observations, so a worker is neither condemned nor crowned by its
// first few dispatches.
export function blendedReliability(prior: number, stats: WorkerStats | undefined, priorWeight = 10): number {
  if (!stats || stats.dispatches === 0) return prior
  return (prior * priorWeight + stats.successRate * stats.dispatches) / (priorWeight + stats.dispatches)
}

export function reliabilityOverrides(
  projectRoot: string,
  priors: Map<string, number>,
): Map<string, number> {
  const stats = aggregateStats(readMetrics(projectRoot))
  const overrides = new Map<string, number>()
  for (const [workerId, prior] of priors) {
    overrides.set(workerId, blendedReliability(prior, stats.get(workerId)))
  }
  return overrides
}
