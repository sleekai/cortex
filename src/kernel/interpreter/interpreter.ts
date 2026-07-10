import { type BlueprintPrimitive, type TaskPrimitive, type ArtifactPrimitive } from '../primitives/primitives.js'
import { type BlueprintLoader, DefaultBlueprintLoader } from './loader.js'
import { type NodeScheduler, type ScheduledNode, SequentialNodeScheduler } from './scheduler.js'
import { type DirectiveResolver, DefaultDirectiveResolver, collectInstructions } from './directives.js'
import { type ArtifactStore, InMemoryArtifactStore } from './artifact-store.js'
import { type NodeExecutor, type InterpreterContext, type BlueprintResult, type NodeResult } from './types.js'
import { TraceBuilder } from './trace.js'
import { ok } from '../primitives/errors.js'

export interface InterpreterServices {
  loader?: BlueprintLoader
  scheduler?: NodeScheduler
  directives?: DirectiveResolver
  store?: ArtifactStore
  executors: NodeExecutor[]
}

export class BlueprintInterpreter {
  private readonly loader: BlueprintLoader
  private readonly scheduler: NodeScheduler
  private readonly directives: DirectiveResolver
  private readonly store: ArtifactStore
  private readonly executors: NodeExecutor[]

  constructor(services: InterpreterServices) {
    this.loader = services.loader ?? new DefaultBlueprintLoader()
    this.scheduler = services.scheduler ?? new SequentialNodeScheduler()
    this.directives = services.directives ?? new DefaultDirectiveResolver()
    this.store = services.store ?? new InMemoryArtifactStore()
    this.executors = services.executors
  }

  async executeTask(task: TaskPrimitive, blueprint: BlueprintPrimitive): Promise<BlueprintResult> {
    const ctx: InterpreterContext = {
      task,
      artifacts: [],
      nodeResults: new Map(),
      guardValues: new Map(),
    }

    const trace = TraceBuilder.start(task, blueprint)
    const schedule = this.scheduler.schedule(blueprint, ctx)
    const allArtifacts: ArtifactPrimitive[] = []

    for (const scheduled of schedule) {
      const result = await this.executeNode(scheduled, blueprint, ctx)
      ctx.nodeResults.set(scheduled.node.id, result)
      allArtifacts.push(...result.produced)

      for (const artifact of result.produced) {
        await this.store.save(artifact)
      }

      trace.recordStep(result)

      if (result.outcome === 'failed' && blueprint.policy.clarificationMode === 'halt') {
        break
      }
    }

    const accepted = !Array.from(ctx.nodeResults.values()).some(r => r.outcome === 'failed')
    const finalTrace = trace.finish(accepted)

    return {
      artifacts: allArtifacts,
      trace: finalTrace,
      accepted,
    }
  }

  private async executeNode(
    scheduled: ScheduledNode,
    blueprint: BlueprintPrimitive,
    ctx: InterpreterContext,
  ): Promise<NodeResult> {
    if (!scheduled.shouldRun) {
      return {
        node: scheduled.node,
        outcome: 'skipped',
        produced: [],
        costUnits: 0,
        iterations: 0,
      }
    }

    const applicableDirectives = this.directives.allForNode(blueprint, scheduled.node.id)
    const instructions = collectInstructions(applicableDirectives)

    for (const executor of this.executors) {
      if (executor.canHandle(scheduled.node)) {
        try {
          return await executor.execute(scheduled.node, ctx, instructions)
        } catch (e) {
          return {
            node: scheduled.node,
            outcome: 'failed',
            produced: [],
            costUnits: 0,
            iterations: 1,
            error: (e as Error).message,
          }
        }
      }
    }

    return {
      node: scheduled.node,
      outcome: 'failed',
      produced: [],
      costUnits: 0,
      iterations: 0,
      error: `no executor found for node step "${scheduled.node.step}"`,
    }
  }
}
