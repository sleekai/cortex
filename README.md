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

The pipeline lives in the **kernel** (`src/kernel/`: `planTask` / `prepareDispatch`
in `kernel.ts`, `executeTask` in `dispatch-orchestrator.ts`,
`runBlueprint` in `blueprint-orchestrator.ts`). The CLI and the MCP server are
thin surfaces over it; every surface persists artifacts, state, and metrics
identically. `cortex dispatch` and `cortex loop` are the same `executeTask`
call with different bounds.

- **Intent compiler** — deterministic regex-based classifier (zero model calls)
- **Capability planner** — expected-utility ladder (EU = quality × reliability / cost × latency)
- **Progressive context compiler** — 5 levels (L0 file names → L4 full source), budget-aware
- **UCP v2** — Ultra-Compact Packet grammar, versioned, single-letter keys
- **Worker registry** — JSON data, not privileged code; project overlays
- **CUEA loop** — Producer → Evaluator → Router cycle: apply → hooks →
  error-only retry or ladder escalation under explicit bounds

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for subsystem designs,
[docs/AUDIT.md](./docs/AUDIT.md) for the repository audit, gap analysis, and
deliberate deferrals, [CONTEXT.md](./CONTEXT.md) for the domain glossary,
and [docs/adr/](./docs/adr/) for architecture decision records.

## Commands

| Command | Description |
|---------|-------------|
| `cortex init` | Scaffold `.cortex/` state directory |
| `cortex dispatch <task>` | Dispatch a task to the best worker |
| `cortex loop <task>` | CUEA closed loop: Producer → Evaluator → Router |
| `cortex exec <task>` | Blueprint execution: triage → skills → closed loop |
| `cortex blueprints` | List registered execution blueprints |
| `cortex skills` | List registered execution skills |
| `cortex plan <task>` | Print dispatch plan, zero model calls |
| `cortex locate <query>` | Deterministic code pointers |
| `cortex workers` | List registered workers |
| `cortex metrics` | Per-worker reliability stats |
| `cortex add-worker [provider]` | Register a worker from a template |

`cortex run` is an alias for `cortex dispatch`.

### Blueprint execution

`cortex exec` runs the full execution model: the triage *skill* classifies
the task and recommends a *blueprint* (`debug`, `feature`, `pr-review`,
`default`); the runner executes its steps — skills conditionally, `produce`
steps through the closed loop — under a named *policy set*. Ambiguous tasks
halt with clarification questions (exit code 2) instead of burning tokens.

```bash
cortex exec "fix the login crash" --blueprint debug --policies generous
cortex exec "add pagination to the users endpoint"   # triage picks 'feature'
```

Skills, blueprints, and policy sets are all registries — see
`docs/EXTENDING.md` for the plugin guide.

### Adding workers

Interactive with no flags, or one-shot:

```bash
cortex add-worker opencode                          # zero-config adapter
cortex add-worker codex                             # zero-config adapter
cortex add-worker cursor                            # zero-config adapter
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
`cortex_exec`, `cortex_init`, plus a `cortex://registry` resource.

```json
{ "mcpServers": { "cortex": { "command": "npx", "args": ["cortex-mcp"] } } }
```

## Configuration

- **`CORTEX_DIR`** env var — override state directory path
- **`--state-dir`** flag — per-invocation override (takes precedence)
- **`.cortex/workers.json`** — project-local worker registry overlay
- **`.cortex/state.json`** — distilled facts, no history
- **`.cortex/metrics.jsonl`** — append-only dispatch records
- **`.cortex/artifacts/<taskId>/`** — persisted typed artifacts per task

## UCP v2 Packet Format

See [docs/UCP-SPEC.md](./docs/UCP-SPEC.md) for the canonical wire format spec.

## License

MPL-2.0
