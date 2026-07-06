import { type TaskIntent } from '../capability/capabilities.js'
import { type BudgetConfig } from '../core/types.js'
import { type CompiledContext, compileContext as defaultCompileContext } from '../retrieval/context-compiler.js'
import { type Artifact, type ArtifactKind, type ArtifactBodies, makeArtifact } from '../artifact/artifacts.js'
import { compileIntent as defaultCompileIntent } from '../capability/intent-compiler.js'

export interface IntentCompiler {
  (request: string): TaskIntent
}

export interface ContextCompiler {
  (projectRoot: string, goal: string, intent: TaskIntent, budget: BudgetConfig): CompiledContext
}

export interface ArtifactFactory {
  <K extends ArtifactKind>(kind: K, taskId: string, producedBy: string, body: ArtifactBodies[K]): Artifact<K>
}

export interface CompilerRuntime {
  compileIntent: IntentCompiler
  compileContext: ContextCompiler
  makeArtifact: ArtifactFactory
}

const defaultRuntime: CompilerRuntime = {
  compileIntent: defaultCompileIntent,
  compileContext: defaultCompileContext,
  makeArtifact,
}

let currentRuntime: CompilerRuntime = defaultRuntime

export function getCompilerRuntime(): CompilerRuntime {
  return currentRuntime
}

export function setCompilerRuntime(runtime: Partial<CompilerRuntime>): () => void {
  const previous = currentRuntime
  currentRuntime = { ...previous, ...runtime }
  return () => { currentRuntime = previous }
}

export function resetCompilerRuntime(): void {
  currentRuntime = defaultRuntime
}
