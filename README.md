# Cortex — AI Compute Operating System

Model-agnostic, harness-agnostic, protocol-agnostic dispatch kernel for AI workloads.

```bash
npm install @sleekai/cortex
npx cortex init            # scaffold .cortex/ state directory
npx cortex add-worker      # register a worker (interactive; or --provider)
npx cortex dispatch "task" # dispatch to best available worker
npx cortex plan "task"     # preview dispatch plan, zero model calls
npx cortex locate "query"  # deterministic code pointers, zero model calls
```

## What is Cortex?

Cortex is the OS for AI compute. It manages **dispatch** — deciding which AI worker (model, provider, or local process) gets each task, how much context to give it, and whether the result passes validation.

**Key properties:**

- **Capability-planned** — intent compiler classifies tasks into 11 capability dimensions; expected-utility planner selects the optimal worker from a registry.
- **Budget-capped** — hard token budget (default 2500), degrade-cascade that drops lowest-ranked context before expanding.
- **Harness-agnostic** — CLI subprocess and HTTP/JSON are built-in; the harness registry is extensible (MCP, A2A, browser).
- **Stateful metrics, stateless dispatch** — per-worker reliability is learned from an append-only JSONL log; every dispatch is a fresh invocation.
- **Zero neural dependencies** — retrieval uses TF-IDF over identifier tokens, not embeddings.

## Architecture

```
Task → Intent Compiler → Capability Planner → Context Compiler
      → UCP v2 Packet → Budget Controller → Harness → Validated Output
```

The pipeline lives in one place — the **kernel** (`src/kernel/kernel.ts`:
`planTask` / `prepareDispatch` / `runTask`). The CLI and the MCP server are
thin surfaces over it; every surface persists artifacts, state, and metrics
identically.

- **Intent compiler** — deterministic regex-based classifier (zero model calls)
- **Capability planner** — expected-utility ladder (EU = quality × reliability / cost × latency)
- **Progressive context compiler** — 5 levels (L0 file names → L4 full source), budget-aware
- **UCP v2** — Ultra-Compact Packet grammar, versioned, single-letter keys
- **Worker registry** — JSON data, not privileged code; project overlays
- **Validation loop** — apply → hooks → error-only retry, max 3 iterations
- **DAG executor** — dependency-ordered parallel dispatch with checkpointing,
  resume (settled nodes never re-run), and cooperative cancellation
- **State graph** — dynamic control flow above dispatch: reducer channels,
  conditional edges, Send fan-out (map-reduce), bounded cycles, and
  interrupt/resume for human-in-the-loop — checkpointed every superstep

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for subsystem designs and
[docs/AUDIT.md](./docs/AUDIT.md) for the repository audit, gap analysis, and
deliberate deferrals.

## Commands

| Command | Description |
|---------|-------------|
| `cortex init` | Scaffold `.cortex/` state directory |
| `cortex dispatch <task>` | Dispatch a task to the best worker |
| `cortex plan <task>` | Print dispatch plan, zero model calls |
| `cortex locate <query>` | Deterministic code pointers |
| `cortex workers` | List registered workers |
| `cortex metrics` | Per-worker reliability stats |
| `cortex add-worker [provider]` | Register a worker from a template |

`cortex run` is an alias for `cortex dispatch`.

### Adding workers

Interactive with no flags, or one-shot:

```bash
cortex add-worker opencode                          # zero-config adapter
cortex add-worker claude-cli                        # zero-config adapter
cortex add-worker openai --model gpt-4o-mini --id openai-cheap
cortex add-worker anthropic --model claude-sonnet-4-20250514
cortex add-worker ollama --model llama3.2 --base-url http://localhost:11434
cortex add-worker cli --id my-llamafile --bin ./llamafile
```

Workers land in `.cortex/workers.json` — data, hot-swappable, no kernel code.

## MCP Server

`cortex-mcp` (stdio) exposes the kernel to any MCP client: `cortex_plan`,
`cortex_locate`, `cortex_workers`, `cortex_metrics`, `cortex_dispatch`,
`cortex_init`, plus a `cortex://registry` resource.

```json
{ "mcpServers": { "cortex": { "command": "npx", "args": ["cortex-mcp"] } } }
```

## State Graphs

For work that a static DAG can't express — runtime routing, retry loops,
dynamic fan-out, human approval gates — build a state graph (`src/graph/`).
Nodes share state through reducer channels, so parallel branches merge
deterministically; every superstep is checkpointed, so any outcome
(interrupt, failure, cancellation, recursion limit) resumes from a snapshot.

```ts
import { stateGraph, send, START, END } from '@sleekai/cortex/dist/graph/state-graph.js'
import { runGraph, resumeGraph } from '@sleekai/cortex/dist/graph/executor.js'
import { lastValue, appendList } from '@sleekai/cortex/dist/graph/channels.js'

const graph = stateGraph({ items: lastValue<string[]>([]), findings: appendList<string>() })
  .addNode('plan', ctx => ({ goto: (ctx.state.items as string[]).map(f => send('scan', f)) }))
  .addNode('scan', ctx => ({ update: { findings: [`scanned ${ctx.input}`] } }))
  .addNode('gate', ctx => ctx.resume === undefined
    ? { interrupt: { reason: 'approve findings?' } }        // pause for a human
    : { update: {} })
  .addEdge(START, 'plan')
  .addEdge('scan', 'gate')   // Send instances fan back into one gate run
  .addEdge('gate', END)
  .compile()

const paused = await runGraph(graph, { items: ['a.ts', 'b.ts'] })
if (paused.status === 'interrupted') {
  const done = await resumeGraph(graph, paused.checkpoint, 'approved')
}
```

`packetNode()` (`graph/packet-node.ts`) wraps the standard dispatch path
(escalation ladder, metrics, artifacts) as a graph node, so model-backed
steps and plain-function steps compose in one graph. Cycles are legal and
bounded by a recursion limit (default 25 supersteps).

## Configuration

- **`CORTEX_DIR`** env var — override state directory path
- **`--state-dir`** flag — per-invocation override (takes precedence)
- **`.cortex/workers.json`** — project-local worker registry overlay
- **`.cortex/state.json`** — distilled facts, no history
- **`.cortex/metrics.jsonl`** — append-only dispatch records
- **`.cortex/artifacts/<taskId>/`** — persisted typed artifacts per task
- **`.cortex/runs/<runId>.json`** — execution-graph checkpoints (non-failure
  node results; failed or cancelled nodes re-run on resume)

## UCP v2 Packet Format

See [docs/UCP-SPEC.md](./docs/UCP-SPEC.md) for the canonical wire format spec.

## License

MPL-2.0
