import { type Capability } from './capabilities.js'
import { type WorkerSpec, type WorkerRegistry } from '../worker/registry.js'
import { type PlannerConstraints, checkConstraints } from './constraints.js'
import { type CapabilityProfile } from '../skill/skill.js'
import { type ArtifactKind } from '../artifact/artifacts.js'
import { estimateSpend } from '../packet/budget-controller.js'

export interface ScoreBreakdown {
  capabilityMatch: number
  preferredBonus: number
  reliabilityScore: number
  speedScore: number
  estimatedCost: number
  utility: number
}

export interface ExclusionReason {
  workerId: string
  reason: string
}

export interface ScoredWorker {
  worker: WorkerSpec
  utility: number
  expectedSpend: number
  justification: string
  scoreBreakdown: ScoreBreakdown
}

export interface Resolution {
  ladder: ScoredWorker[]
  excluded: ExclusionReason[]
}

export interface ResolveRequest {
  capabilities: Capability[]
  profile: CapabilityProfile
  expectedOutput?: ArtifactKind
  estTokenBudget: number
  retryProbability: number
  reliabilityOverrides?: Map<string, number>
  maxSpend?: number
}

export interface CapabilityResolver {
  resolve(
    request: ResolveRequest,
    registry: WorkerRegistry,
    constraints: PlannerConstraints,
  ): Resolution
}

export class DefaultResolver implements CapabilityResolver {
  resolve(
    request: ResolveRequest,
    registry: WorkerRegistry,
    constraints: PlannerConstraints,
  ): Resolution {
    const excluded: ExclusionReason[] = []
    const feasible: WorkerSpec[] = []

    for (const worker of registry.workers) {
      if (!this.checkFeasible(worker, request, constraints, excluded)) continue
      feasible.push(worker)
    }

    const scored = feasible.map(w => this.scoreWorker(w, request))

    const maxSpend = request.maxSpend ?? Number.POSITIVE_INFINITY
    const affordable = scored.filter(s => {
      if (s.expectedSpend > maxSpend) {
        excluded.push({
          workerId: s.worker.id,
          reason: `spend ${s.expectedSpend.toFixed(2)} over cap ${maxSpend}`,
        })
        return false
      }
      return true
    })

    const ladder = affordable.sort((a, b) => {
      if (b.utility !== a.utility) return b.utility - a.utility
      return a.worker.id.localeCompare(b.worker.id)
    })

    return { ladder, excluded }
  }

  private checkFeasible(
    worker: WorkerSpec,
    request: ResolveRequest,
    constraints: PlannerConstraints,
    excluded: ExclusionReason[],
  ): boolean {
    const caps = request.capabilities
    if (!caps.every(c => worker.capabilities.includes(c))) {
      excluded.push({
        workerId: worker.id,
        reason: `missing capability (needs ${caps.join('+')})`,
      })
      return false
    }

    if (request.profile.forbidden) {
      const hasForbidden = request.profile.forbidden.some(fc => worker.capabilities.includes(fc))
      if (hasForbidden) {
        excluded.push({ workerId: worker.id, reason: `has forbidden capability` })
        return false
      }
    }

    for (const req of request.profile.minimum) {
      const quality = worker.quality[req.capability] ?? (req.minimum > 0 ? 0 : 0.1)
      if (quality < req.minimum) {
        excluded.push({
          workerId: worker.id,
          reason: `quality ${quality.toFixed(2)} for ${req.capability} below minimum ${req.minimum}`,
        })
        return false
      }
    }

    const verdict = checkConstraints(
      worker,
      { expectedOutput: request.expectedOutput ?? 'plan', estTokenBudget: request.estTokenBudget } as never,
      constraints,
    )
    if (!verdict.allowed) {
      excluded.push({ workerId: worker.id, reason: verdict.reason ?? 'policy' })
      return false
    }

    return true
  }

  private scoreWorker(worker: WorkerSpec, request: ResolveRequest): ScoredWorker {
    let capabilityMatch = 1
    for (const cap of request.capabilities) {
      capabilityMatch *= worker.quality[cap] ?? 0.1
    }

    let preferredBonus = 0
    for (const pref of request.profile.preferred ?? []) {
      const quality = worker.quality[pref.capability] ?? 0
      const weight = pref.weight ?? 0.1
      preferredBonus += quality * weight
    }

    const reliability = request.reliabilityOverrides?.get(worker.id) ?? worker.reliability
    const spend = estimateSpend(request.estTokenBudget, worker.cost, request.retryProbability)

    const baseScore = capabilityMatch + preferredBonus
    const utility = (baseScore * reliability * worker.speed) / Math.max(spend.expectedSpend, 0.001)

    const parts = [`q=${capabilityMatch.toFixed(2)}`]
    if (preferredBonus > 0) parts.push(`pref=${preferredBonus.toFixed(2)}`)
    parts.push(
      `rel=${reliability.toFixed(2)}`,
      `speed=${worker.speed}`,
      `spend≈${spend.expectedSpend.toFixed(2)}`,
      `→ EU=${utility.toFixed(4)}`,
    )

    return {
      worker,
      utility,
      expectedSpend: spend.expectedSpend,
      justification: parts.join(' '),
      scoreBreakdown: {
        capabilityMatch,
        preferredBonus,
        reliabilityScore: reliability,
        speedScore: worker.speed,
        estimatedCost: spend.expectedSpend,
        utility,
      },
    }
  }
}
