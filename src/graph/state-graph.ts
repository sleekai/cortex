// State graph definition: nodes over reducer channels, static edges,
// conditional routers, and dynamic Send fan-out. This is the LangGraph-shaped
// control-flow layer of the kernel — cycles are legal (the executor bounds
// them with a recursion limit), routing happens at runtime from state, and a
// node may override its outgoing edges per run (Command-style `goto`).
//
// Deliberately not adopted from LangGraph: checkpointer backends (state/store
// owns persistence), thread ids (a checkpoint is a plain value the caller
// stores wherever it likes), and runnable wrappers (a node is a function).
import { type Channels, type GraphState } from './channels.js'

export const START = '__start__'
export const END = '__end__'

// Dynamic fan-out: schedule an instance of `node` with a private input.
// Multiple Sends to the same node run as separate tasks in one superstep —
// the map half of map-reduce; a reducer channel is the reduce half.
export interface Send {
  node: string
  input: unknown
}

export function send(node: string, input: unknown): Send {
  return { node, input }
}

export function isSend(v: string | Send): v is Send {
  return typeof v !== 'string'
}

export interface NodeContext {
  state: GraphState
  // Private payload when this task was scheduled via Send.
  input?: unknown
  // Value injected by resumeGraph after this node interrupted.
  resume?: unknown
  signal?: AbortSignal
  step: number
}

export interface NodeOutcome {
  // Merged into state through the channel reducers.
  update?: Record<string, unknown>
  // Command-style override: replaces this node's static/conditional edges
  // for this superstep. END is legal and terminates that branch.
  goto?: Array<string | Send>
  // Human-in-the-loop pause: the run stops, peers in the same superstep
  // still settle, and resumeGraph re-runs this node with ctx.resume set.
  interrupt?: { reason: string; payload?: unknown }
}

export type NodeFn = (ctx: NodeContext) => Promise<NodeOutcome> | NodeOutcome

// Runtime routing: inspect merged state, return next target(s).
export type EdgeRouter = (state: GraphState) => string | Send | Array<string | Send>

export interface CompiledGraph {
  channels: Channels
  nodes: ReadonlyMap<string, NodeFn>
  edges: ReadonlyMap<string, readonly string[]>
  routers: ReadonlyMap<string, EdgeRouter>
}

export interface StateGraphBuilder {
  addNode(id: string, fn: NodeFn): StateGraphBuilder
  addEdge(from: string, to: string): StateGraphBuilder
  addConditionalEdges(from: string, router: EdgeRouter): StateGraphBuilder
  compile(): CompiledGraph
}

export function stateGraph(channels: Channels): StateGraphBuilder {
  const nodes = new Map<string, NodeFn>()
  const edges = new Map<string, string[]>()
  const routers = new Map<string, EdgeRouter>()

  const builder: StateGraphBuilder = {
    addNode(id, fn) {
      if (id === START || id === END) throw new Error(`graph: "${id}" is reserved`)
      if (nodes.has(id)) throw new Error(`graph: duplicate node "${id}"`)
      nodes.set(id, fn)
      return builder
    },
    addEdge(from, to) {
      if (from === END) throw new Error('graph: END cannot have outgoing edges')
      if (to === START) throw new Error('graph: START cannot be an edge target')
      const list = edges.get(from) ?? []
      list.push(to)
      edges.set(from, list)
      return builder
    },
    addConditionalEdges(from, router) {
      if (from === END) throw new Error('graph: END cannot have outgoing edges')
      if (routers.has(from)) throw new Error(`graph: node "${from}" already has a router`)
      routers.set(from, router)
      return builder
    },
    compile() {
      const known = (id: string) => id === END || nodes.has(id)
      for (const [from, targets] of edges) {
        if (from !== START && !nodes.has(from)) throw new Error(`graph: edge from unknown node "${from}"`)
        for (const to of targets) {
          if (!known(to)) throw new Error(`graph: edge to unknown node "${to}"`)
        }
      }
      for (const from of routers.keys()) {
        if (from !== START && !nodes.has(from)) throw new Error(`graph: router on unknown node "${from}"`)
      }
      if (!edges.has(START) && !routers.has(START)) {
        throw new Error('graph: no entry edge from START')
      }
      return { channels, nodes, edges, routers }
    },
  }
  return builder
}
