// Execution Blueprints (MVP §2) — reusable workflow descriptions. A blueprint
// names *what* runs in *what order*; the runner (runner.ts) executes it. The
// runtime knows nothing about debugging, reviewing, or planning — those are
// just blueprint names resolved through this registry.
//
// A step is either a named Skill (skill/registry.ts) or `produce` — the CUEA
// Producer→Evaluator→Router closed loop (loop/loop-engine.ts), which already
// embodies retry / escalate / finish under policy bounds. Conditions gate
// steps at runtime; a skill's own applicable() gates it further.
import { type Artifact } from '../artifact/artifacts.js'
import { type PolicySet } from '../policy/policies.js'

export interface BlueprintRunView {
  blackboard: Record<string, unknown>
  artifacts: readonly Artifact[]
}

export type StepCondition = (view: BlueprintRunView) => boolean

export type BlueprintStep =
  | { id: string; kind: 'skill'; skill: string; when?: StepCondition }
  | { id: string; kind: 'produce'; when?: StepCondition }

export interface Blueprint {
  name: string
  description: string
  steps: BlueprintStep[]
  // Per-blueprint policy overrides, merged over the run's base PolicySet —
  // how a debug flow gets a deeper ladder than a review flow without either
  // touching the runner.
  policies?: Partial<Omit<PolicySet, 'name'>>
}

// ── Registry (pluggability seam, MVP §12) ─────────────────────────────────
const blueprints = new Map<string, Blueprint>()

export function registerBlueprint(blueprint: Blueprint): void {
  blueprints.set(blueprint.name, blueprint)
}

export function getBlueprint(name: string): Blueprint | undefined {
  return blueprints.get(name)
}

export function registeredBlueprints(): Blueprint[] {
  return [...blueprints.values()]
}

// Test/isolation hook.
export function clearBlueprints(): void {
  blueprints.clear()
}
