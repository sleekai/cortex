// Execution-skill registry — the pluggability seam (MVP §12). New skills
// register here without touching the runner or the kernel; blueprints refer
// to skills by name. Mirrors the kind-keyed Map + register*/get* pattern used
// by ingress adapters, egress renderers, and the CTS skill registry.
//
// Phase 2 adds contract validation and introspection:
// - `registerSkill` validates the skill's CapabilityProfile, consumes/produces
//   artifact kinds, and unique name before accepting it.
// - `getSkillContract` / `allContracts` expose the machine-readable
//   SkillContract the Phase 3 capability resolver will consume.
import { namedRegistry } from '../core/registry.js'
import { isCapability } from '../capability/capabilities.js'
import { isArtifactKind } from '../artifact/artifacts.js'
import { type Skill, type SkillContract } from './skill.js'

export interface RegistrationError {
  field: string
  message: string
}

const { register: rawRegister, get, all, clear } = namedRegistry<Skill>()

export function registerSkill(skill: Skill): void {
  const errors = validateContract(skill)
  if (errors.length > 0) {
    const summary = errors.map(e => `${e.field}: ${e.message}`).join('; ')
    throw new Error(`skill "${skill.name}" registration rejected: ${summary}`)
  }
  rawRegister(skill)
}

export function getSkillContract(name: string): SkillContract | undefined {
  const skill = get(name)
  if (!skill) return undefined
  return {
    name: skill.name,
    purpose: skill.purpose,
    profile: skill.meta.profile,
    consumes: skill.meta.consumes,
    produces: skill.meta.produces,
    deterministic: skill.meta.deterministic,
  }
}

export function allContracts(): SkillContract[] {
  return all().map(s => ({
    name: s.name,
    purpose: s.purpose,
    profile: s.meta.profile,
    consumes: s.meta.consumes,
    produces: s.meta.produces,
    deterministic: s.meta.deterministic,
  }))
}

export { get as getSkill, all as registeredSkills, clear as clearSkills }

function validateContract(skill: Skill): RegistrationError[] {
  const errors: RegistrationError[] = []
  const { profile, consumes, produces } = skill.meta

  // Unique name check — prevent silent overwrites
  if (get(skill.name)) {
    errors.push({ field: 'name', message: `a skill named "${skill.name}" is already registered` })
  }

  // Validate minimum requirements
  for (const req of profile.minimum) {
    if (!isCapability(req.capability)) {
      errors.push({ field: 'profile.minimum[]', message: `unknown capability "${String(req.capability)}"` })
    }
    if (typeof req.minimum !== 'number' || req.minimum < 0 || req.minimum > 1) {
      errors.push({ field: 'profile.minimum[]', message: `minimum score for "${String(req.capability)}" must be in [0, 1]` })
    }
    if (req.weight !== undefined && (typeof req.weight !== 'number' || req.weight < 0 || req.weight > 1)) {
      errors.push({ field: 'profile.minimum[]', message: `weight for "${String(req.capability)}" must be in [0, 1] when set` })
    }
  }

  // Validate preferred requirements
  for (const req of profile.preferred ?? []) {
    if (!isCapability(req.capability)) {
      errors.push({ field: 'profile.preferred[]', message: `unknown capability "${String(req.capability)}"` })
    }
    if (typeof req.minimum !== 'number' || req.minimum < 0 || req.minimum > 1) {
      errors.push({ field: 'profile.preferred[]', message: `minimum score for "${String(req.capability)}" must be in [0, 1]` })
    }
    if (req.weight !== undefined && (typeof req.weight !== 'number' || req.weight < 0 || req.weight > 1)) {
      errors.push({ field: 'profile.preferred[]', message: `weight for "${String(req.capability)}" must be in [0, 1] when set` })
    }
  }

  // Validate forbidden capabilities
  for (const cap of profile.forbidden ?? []) {
    if (!isCapability(cap)) {
      errors.push({ field: 'profile.forbidden[]', message: `unknown capability "${String(cap)}"` })
    }
  }

  // Validate cost if set
  if (profile.cost !== undefined && !['free', 'low', 'medium', 'high'].includes(profile.cost)) {
    errors.push({ field: 'profile.cost', message: `invalid cost "${profile.cost}"` })
  }

  // Validate consumes artifact kinds
  for (const kind of consumes) {
    if (!isArtifactKind(kind)) {
      errors.push({ field: 'consumes[]', message: `unknown artifact kind "${String(kind)}"` })
    }
  }

  // Validate produces artifact kinds
  for (const kind of produces) {
    if (!isArtifactKind(kind)) {
      errors.push({ field: 'produces[]', message: `unknown artifact kind "${String(kind)}"` })
    }
  }

  return errors
}
