import { type BlueprintPrimitive, type DirectivePrimitive, type NodePrimitive } from '../primitives/primitives.js'
import { type NodeId } from '../primitives/ids.js'

export interface DirectiveResolver {
  forRun(blueprint: BlueprintPrimitive): DirectivePrimitive[]
  forNode(blueprint: BlueprintPrimitive, nodeId: NodeId): DirectivePrimitive[]
  allForNode(blueprint: BlueprintPrimitive, nodeId: NodeId): DirectivePrimitive[]
}

export class DefaultDirectiveResolver implements DirectiveResolver {
  forRun(blueprint: BlueprintPrimitive): DirectivePrimitive[] {
    return blueprint.directives
      .filter(d => d.scope.kind === 'run')
      .sort((a, b) => a.weight - b.weight)
  }

  forNode(blueprint: BlueprintPrimitive, nodeId: NodeId): DirectivePrimitive[] {
    return blueprint.directives
      .filter(d => d.scope.kind === 'node' && d.scope.node === nodeId)
      .sort((a, b) => a.weight - b.weight)
  }

  allForNode(blueprint: BlueprintPrimitive, nodeId: NodeId): DirectivePrimitive[] {
    const runDirectives = this.forRun(blueprint)
    const nodeDirectives = this.forNode(blueprint, nodeId)
    return [...runDirectives, ...nodeDirectives].sort((a, b) => a.weight - b.weight)
  }
}

export function collectInstructions(directives: DirectivePrimitive[]): string[] {
  return directives.map(d => d.instruction)
}
