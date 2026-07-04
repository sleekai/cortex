// Skill registry — the pluggability seam (spec §13). New skills register here
// without touching the pipeline; policy toggles them on/off per run. Mirrors
// the kind-keyed Map + register*/get* pattern used by ingress adapters
// (ingress/ingress.ts:57) and egress renderers.
import { type CTS_Skill, type TriagePolicy } from './skill.js'

const skills = new Map<string, CTS_Skill>()

export function registerSkill(skill: CTS_Skill): void {
  skills.set(skill.name, skill)
}

export function getSkill(name: string): CTS_Skill | undefined {
  return skills.get(name)
}

export function registeredSkills(): CTS_Skill[] {
  return [...skills.values()]
}

// Skills the given policy leaves enabled. Order is not meaningful here — the
// pipeline imposes stage order; this only filters.
export function enabledSkills(policy: TriagePolicy): CTS_Skill[] {
  const disabled = new Set(policy.disabledSkills ?? [])
  return registeredSkills().filter(s => !disabled.has(s.name))
}

// Test/isolation hook — the pipeline never calls this in production.
export function clearSkills(): void {
  skills.clear()
}
