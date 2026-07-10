import { type BlueprintPrimitive, type NodePrimitive } from '../primitives/primitives.js'
import { type InterpreterContext, type GuardResolver } from './types.js'

export interface NodeScheduler {
  schedule(blueprint: BlueprintPrimitive, ctx: InterpreterContext): ScheduledNode[]
}

export interface ScheduledNode {
  node: NodePrimitive
  shouldRun: boolean
  reason: string
}

export const ALWAYS_RUN_GUARD: GuardResolver = (_guardName: string, _ctx: InterpreterContext) => true

export class SequentialNodeScheduler implements NodeScheduler {
  constructor(private readonly resolveGuard: GuardResolver = ALWAYS_RUN_GUARD) {}

  schedule(blueprint: BlueprintPrimitive, ctx: InterpreterContext): ScheduledNode[] {
    return blueprint.nodes.map(node => {
      if (!node.when) {
        return { node, shouldRun: true, reason: 'no guard' }
      }
      const guardPasses = this.resolveGuard(node.when, ctx)
      return {
        node,
        shouldRun: guardPasses,
        reason: guardPasses ? `guard "${node.when}" passed` : `guard "${node.when}" blocked`,
      }
    })
  }
}
