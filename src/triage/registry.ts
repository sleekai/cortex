// Stage registry — the pluggability seam (spec §13). New triage stages
// register here without touching the pipeline; policy toggles them on/off
// per run. Distinct from the execution-Skill registry (skill/registry.ts):
// a TriageStage is a stage inside the triage pipeline, not an execution unit.
import { namedRegistry } from '../core/registry.js'
import { type TriageStage, type TriagePolicy } from './stage.js'

const { register, get, all, clear } = namedRegistry<TriageStage>()

export { register as registerStage, get as getStage }

export function registeredStages(): TriageStage[] {
  return all()
}

// Stages the given policy leaves enabled. Order is not meaningful here — the
// pipeline imposes stage order; this only filters.
export function enabledStages(policy: TriagePolicy): TriageStage[] {
  const disabled = new Set(policy.disabledStages ?? [])
  return registeredStages().filter(s => !disabled.has(s.name))
}

// Test/isolation hook — the pipeline never calls this in production.
export function clearStages(): void {
  clear()
}
