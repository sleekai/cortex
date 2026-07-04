// Hard constraints the planner may never trade away. Utility optimization
// happens inside the feasible set this file defines — a cheaper worker that
// violates policy is not a candidate, it is excluded.
import { type WorkerSpec } from '../worker/registry.js'
import { type TaskIntent } from './capabilities.js'

export interface Policy {
  // Workers that must never be selected, by id.
  denyWorkers: string[]
  // Spend ceiling per dispatch (relative cost units); Infinity = uncapped.
  maxSpendPerDispatch: number
  // When true, only workers with writeAccess 'patch' may produce patches.
  enforceWriteAccess: boolean
}

export const DEFAULT_POLICY: Policy = {
  denyWorkers: [],
  maxSpendPerDispatch: Number.POSITIVE_INFINITY,
  enforceWriteAccess: true,
}

export interface PolicyVerdict {
  allowed: boolean
  reason?: string
}

export function checkPolicy(worker: WorkerSpec, intent: TaskIntent, policy: Policy): PolicyVerdict {
  if (policy.denyWorkers.includes(worker.id)) {
    return { allowed: false, reason: `worker ${worker.id} is deny-listed` }
  }
  if (policy.enforceWriteAccess && intent.expectedOutput === 'patch' && worker.writeAccess !== 'patch') {
    return { allowed: false, reason: `worker ${worker.id} has no patch write access` }
  }
  if (worker.contextWindow < intent.estTokenBudget) {
    return { allowed: false, reason: `worker ${worker.id} context window ${worker.contextWindow} < budget ${intent.estTokenBudget}` }
  }
  return { allowed: true }
}
