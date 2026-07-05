// Execution-skill registry — the pluggability seam (MVP §12). New skills
// register here without touching the runner or the kernel; blueprints refer
// to skills by name. Mirrors the kind-keyed Map + register*/get* pattern used
// by ingress adapters, egress renderers, and the CTS skill registry.
import { type Skill } from './skill.js'

const skills = new Map<string, Skill>()

export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill)
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name)
}

export function registeredSkills(): Skill[] {
  return [...skills.values()]
}

// Test/isolation hook — production code never calls this.
export function clearSkills(): void {
  skills.clear()
}
