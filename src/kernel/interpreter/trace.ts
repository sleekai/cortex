import { type TracePrimitive, type TraceStep } from '../primitives/primitives.js'
import { type TaskPrimitive, type BlueprintPrimitive } from '../primitives/primitives.js'
import { type NodeResult } from './types.js'
import { type NodeId, traceId, type TraceId } from '../primitives/ids.js'
import { KERNEL_SCHEMA_VERSION } from '../primitives/schema.js'

export class TraceBuilder {
  private readonly steps: TraceStep[] = []
  private readonly startedAt: string
  private totalCost = 0

  constructor(
    readonly id: TraceId,
    readonly task: TaskPrimitive,
    readonly blueprint: BlueprintPrimitive,
  ) {
    this.startedAt = new Date().toISOString()
  }

  static start(task: TaskPrimitive, blueprint: BlueprintPrimitive): TraceBuilder {
    const id = traceId(`tr-${task.id}-${Date.now()}`)
    return new TraceBuilder(id, task, blueprint)
  }

  recordStep(nodeResult: NodeResult): void {
    this.steps.push({
      node: nodeResult.node.id,
      outcome: nodeResult.outcome,
      iterations: nodeResult.iterations,
      costUnits: nodeResult.costUnits,
    })
    this.totalCost += nodeResult.costUnits
  }

  finish(accepted: boolean): TracePrimitive {
    return {
      kind: 'trace',
      schemaVersion: KERNEL_SCHEMA_VERSION,
      id: this.id,
      task: this.task.id,
      blueprint: this.blueprint.id,
      steps: this.steps,
      accepted,
      totalCostUnits: this.totalCost,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
    }
  }
}
