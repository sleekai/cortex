import type { ArtifactPrimitive, NodePrimitive, TracePrimitive, TaskPrimitive } from '../primitives/primitives.js'
import type { NodeId } from '../primitives/ids.js'

export interface InterpreterContext {
  task: TaskPrimitive
  artifacts: ArtifactPrimitive[]
  nodeResults: Map<NodeId, NodeResult>
  guardValues: Map<string, boolean>
}

export interface NodeResult {
  node: NodePrimitive
  outcome: 'ok' | 'retried' | 'escalated' | 'skipped' | 'failed'
  produced: ArtifactPrimitive[]
  costUnits: number
  iterations: number
  error?: string
}

export interface NodeExecutor {
  canHandle(node: NodePrimitive): boolean
  execute(node: NodePrimitive, ctx: InterpreterContext, directives: string[]): Promise<NodeResult>
}

export interface BlueprintResult {
  artifacts: ArtifactPrimitive[]
  trace: TracePrimitive
  accepted: boolean
}

export type GuardResolver = (guardName: string, ctx: InterpreterContext) => boolean
