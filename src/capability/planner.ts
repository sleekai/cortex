// Capability planning, not model routing. Input: a TaskIntent (never raw
// text). Output: an escalation ladder of workers ordered by tier then
// expected utility, with a recorded justification per rung. The dispatcher
// walks the ladder; it never jumps to a premium tier unless every cheaper
// rung is exhausted or the intent itself demands deep reasoning.
import { type TaskIntent, type Complexity } from './capabilities.js'
import { type WorkerSpec, type WorkerRegistry, type WorkerTier } from '../worker/registry.js'
import { type PlannerConstraints, DEFAULT_CONSTRAINTS, checkConstraints } from './constraints.js'
import { estimateSpend } from '../packet/budget-controller.js'
import { DefaultResolver } from './resolver.js'

export interface ScoredWorker {
  worker: WorkerSpec
  utility: number
  expectedSpend: number
  justification: string
}

export interface Plan {
  // True when the intent is answerable deterministically (tier 0) — the
  // kernel's own retrieval answers it and no worker is consulted.
  tier0: boolean
  entryTier: WorkerTier
  // Escalation ladder: dispatch rung 0 first; escalate only on failure.
  ladder: ScoredWorker[]
  excluded: { workerId: string; reason: string }[]
}

// Reliability overrides let the learning system (state/metrics.ts) shift
// priors without mutating the registry.
export type ReliabilityOverrides = Map<string, number>

const COMPLEXITY_TO_ENTRY_TIER: Record<Complexity, WorkerTier> = {
  trivial: 1,
  bounded: 2,
  open: 3,
}

// Confidence below this raises the entry tier by one: when the intent
// compiler is unsure what the task even is, cheap workers waste retries.
const LOW_CONFIDENCE = 0.5

function capabilityQuality(worker: WorkerSpec, intent: TaskIntent): number {
  let product = 1
  for (const cap of intent.capabilities) {
    product *= worker.quality[cap] ?? 0.1
  }
  return product
}

export function scoreWorker(
  worker: WorkerSpec,
  intent: TaskIntent,
  retryProbability: number,
  reliabilityOverride?: number,
): ScoredWorker {
  const quality = capabilityQuality(worker, intent)
  const reliability = reliabilityOverride ?? worker.reliability
  const spend = estimateSpend(intent.estTokenBudget, worker.cost, retryProbability)
  // EU = quality × reliability / (cost × latency); latency ∝ 1/speed.
  const utility = (quality * reliability * worker.speed) / Math.max(spend.expectedSpend, 0.001)
  return {
    worker,
    utility,
    expectedSpend: spend.expectedSpend,
    justification:
      `q=${quality.toFixed(2)} rel=${reliability.toFixed(2)} speed=${worker.speed} ` +
      `spend≈${spend.expectedSpend.toFixed(2)} → EU=${utility.toFixed(4)}`,
  }
}

export function planDispatch(
  intent: TaskIntent,
  registry: WorkerRegistry,
  constraints: PlannerConstraints = DEFAULT_CONSTRAINTS,
  reliabilityOverrides: ReliabilityOverrides = new Map(),
  retryProbability = 0.25,
  tierHint?: string,
  maxSpend = Number.POSITIVE_INFINITY,
): Plan {
  if (intent.taskType === 'locate') {
    return { tier0: true, entryTier: 1, ladder: [], excluded: [] }
  }

  let entryTier = COMPLEXITY_TO_ENTRY_TIER[intent.complexity]
  if (intent.confidence < LOW_CONFIDENCE && entryTier < 3) {
    entryTier = (entryTier + 1) as WorkerTier
  }
  if (intent.estReasoningDepth >= 3) {
    entryTier = 3
  }

  // Triage routing hint overrides the entry tier when present — it has richer
  // signal analysis (file count, ambiguity, verb patterns) than the intent
  // compiler's complexity heuristic.
  if (tierHint) {
    const mapped: Record<string, WorkerTier> = { T0: 1, T1: 1, T2: 2, T3: 3, T4: 3 }
    entryTier = mapped[tierHint] ?? entryTier
  }

  // Delegate worker feasibility, scoring, and ladder construction to the
  // DefaultResolver. planDispatch adds entry-tier ordering on top.
  const resolver = new DefaultResolver()
  const resolution = resolver.resolve(
    {
      capabilities: intent.capabilities,
      profile: { minimum: [] },
      expectedOutput: intent.expectedOutput,
      estTokenBudget: intent.estTokenBudget,
      retryProbability,
      reliabilityOverrides,
      maxSpend,
    },
    registry,
    constraints,
  )

  // Entry-tier ordering: workers at/below entry tier come first (cheapest
  // viable start), then higher tiers as escalation.
  const ladder = resolution.ladder.sort((a, b) => {
    const aEsc = a.worker.tier > entryTier ? 1 : 0
    const bEsc = b.worker.tier > entryTier ? 1 : 0
    if (aEsc !== bEsc) return aEsc - bEsc
    if (a.worker.tier !== b.worker.tier) {
      return aEsc === 0 ? b.worker.tier - a.worker.tier : a.worker.tier - b.worker.tier
    }
    return b.utility - a.utility
  })

  return {
    tier0: false,
    entryTier,
    ladder: ladder.map(w => ({
      worker: w.worker,
      utility: w.utility,
      expectedSpend: w.expectedSpend,
      justification: w.justification,
    })),
    excluded: resolution.excluded.map(e => ({ workerId: e.workerId, reason: e.reason })),
  }
}
