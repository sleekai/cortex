// Skill registry — the pluggability seam (spec §13). New skills register here
// without touching the pipeline; policy toggles them on/off per run. Mirrors
// the kind-keyed Map + register*/get* pattern used by ingress adapters
// (ingress/ingress.ts:57) and egress renderers.
import { namedRegistry } from '../core/registry.js'
import { type TriageStage, type TriagePolicy } from './skill.js'

const { register, get, all, clear } = namedRegistry<TriageStage>()

export { register as registerSkill, get as getSkill }

export function registeredSkills(): TriageStage[] {
  return all()
}

// Skills the given policy leaves enabled. Order is not meaningful here — the
// pipeline imposes stage order; this only filters.
export function enabledSkills(policy: TriagePolicy): TriageStage[] {
  const disabled = new Set(policy.disabledSkills ?? [])
  return registeredSkills().filter(s => !disabled.has(s.name))
}

// Test/isolation hook — the pipeline never calls this in production.
export function clearSkills(): void {
  clear()
}
