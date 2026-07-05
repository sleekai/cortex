// Execution-skill registry — the pluggability seam (MVP §12). New skills
// register here without touching the runner or the kernel; blueprints refer
// to skills by name. Mirrors the kind-keyed Map + register*/get* pattern used
// by ingress adapters, egress renderers, and the CTS skill registry.
import { namedRegistry } from '../core/registry.js'
import { type Skill } from './skill.js'

export const { register: registerSkill, get: getSkill, all: registeredSkills, clear: clearSkills } = namedRegistry<Skill>()
