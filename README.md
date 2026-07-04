# Cortex — AI Compute Operating System

Model-agnostic, harness-agnostic, protocol-agnostic dispatch kernel for AI workloads.

```bash
npm install @sleekai/cortex
npx cortex init            # scaffold .cortex/ state directory
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

- **Intent compiler** — deterministic regex-based classifier (zero model calls)
- **Capability planner** — expected-utility ladder (EU = quality × reliability / cost × latency)
- **Progressive context compiler** — 5 levels (L0 file names → L4 full source), budget-aware
- **UCP v2** — Ultra-Compact Packet grammar, versioned, single-letter keys
- **Worker registry** — JSON data, not privileged code; project overlays
- **Validation loop** — apply → hooks → error-only retry, max 3 iterations

## Commands

| Command | Description |
|---------|-------------|
| `cortex init` | Scaffold `.cortex/` state directory |
| `cortex dispatch <task>` | Dispatch a task to the best worker |
| `cortex plan <task>` | Print dispatch plan, zero model calls |
| `cortex locate <query>` | Deterministic code pointers |
| `cortex workers` | List registered workers |
| `cortex metrics` | Per-worker reliability stats |

`cortex run` is an alias for `cortex dispatch`.

## Configuration

- **`CORTEX_DIR`** env var — override state directory path
- **`--state-dir`** flag — per-invocation override (takes precedence)
- **`.cortex/workers.json`** — project-local worker registry overlay
- **`.cortex/state.json`** — distilled facts, no history
- **`.cortex/metrics.jsonl`** — append-only dispatch records

## UCP v2 Packet Format

See [docs/UCP-SPEC.md](./docs/UCP-SPEC.md) for the canonical wire format spec.

## License

MPL-2.0
