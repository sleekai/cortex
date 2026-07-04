// Bridge between the state graph and the dispatch layer: a packet node wraps
// dispatchWithLadder (escalation, metrics, artifacts) as a graph NodeFn, so
// dynamic graphs reuse the exact same worker path as static DispatchPlans —
// no second dispatch implementation.
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk } from '../core/types.js'
import { isKind } from '../artifact/artifacts.js'
import { type ScoredWorker } from '../capability/planner.js'
import {
  dispatchWithLadder, DEFAULT_DISPATCH_OPTIONS,
  type DispatchOptions, type NodeResult,
} from '../worker/dispatch.js'
import { appendList, mapMerge, type Channels } from './channels.js'
import { type NodeFn, type NodeContext } from './state-graph.js'

// The channel pair every packet graph shares: artifacts accumulate in
// dispatch order, results index full NodeResults by graph node id. Spread
// into stateGraph(...) alongside any caller-defined channels.
export function packetChannels(): Channels {
  return {
    artifacts: appendList(),
    results: mapMerge<NodeResult>(),
  }
}

export interface PacketNodeConfig {
  id: string
  packet: UCP
  chunks: CodeChunk[]
  ladder: ScoredWorker[]
  dispatch?: Partial<DispatchOptions>
}

export function packetNode(config: PacketNodeConfig): NodeFn {
  return async (ctx: NodeContext) => {
    const result = await dispatchWithLadder(config.packet, config.chunks, config.ladder, {
      ...DEFAULT_DISPATCH_OPTIONS,
      ...config.dispatch,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    return {
      update: {
        artifacts: [result.artifact],
        results: { [config.id]: result },
      },
    }
  }
}

export function isFailedResult(result: NodeResult | undefined): boolean {
  return result === undefined || isKind(result.artifact, 'failure')
}
