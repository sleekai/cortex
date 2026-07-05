// Compiler Runtime (MVP §11) — the three compiler services behind one named,
// replaceable seam:
//
//   Intent Compiler    raw task text     → structured TaskIntent
//   Context Compiler   goal + intent     → minimal relevant CompiledContext
//   Artifact Compiler  raw worker output → typed Artifact (parse-once boundary)
//
// The default runtime binds the existing deterministic implementations; a
// richer implementation (LLM intent classifier, embedding retrieval, schema-
// validated artifact parsing) swaps in via setCompilerRuntime without any
// caller changing. Callers that want the pluggable seam import from here;
// existing direct imports of the underlying modules keep working unchanged.
import { type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { compileIntent } from '../capability/intent-compiler.js'
import { compileContext, type CompiledContext } from '../retrieval/context-compiler.js'
import { parseWorkerOutput } from '../worker/output-parser.js'
import { type Artifact } from '../artifact/artifacts.js'
import { type UCP } from '../packet/ucp.js'

export interface CompilerRuntime {
  intent(task: string): TaskIntent
  context(projectRoot: string, goal: string, intent: TaskIntent, budget: BudgetConfig): CompiledContext
  artifact(raw: string, packet: UCP, workerId: string): Artifact
}

export const defaultCompilerRuntime: CompilerRuntime = {
  intent: (task) => compileIntent(task),
  context: (projectRoot, goal, intent, budget) => compileContext(projectRoot, goal, intent, budget),
  artifact: (raw, packet, workerId) => parseWorkerOutput(raw, packet, workerId),
}

let active: CompilerRuntime = defaultCompilerRuntime

export function compilerRuntime(): CompilerRuntime {
  return active
}

// Replace one or more compiler services. Returns a restore function so tests
// and plugins can scope their override.
export function setCompilerRuntime(override: Partial<CompilerRuntime>): () => void {
  const previous = active
  active = { ...active, ...override }
  return () => { active = previous }
}
