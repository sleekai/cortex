---
name: cortex
description: "Cortex AI dispatch kernel — CLI commands, worker configuration, UCP protocol, and harness integration for AI compute orchestration. Use when dispatching tasks to AI workers, planning dispatch, locating code, managing workers, or inspecting metrics. Also use when configuring or extending cortex workers, harnesses, or policies."
---

# Cortex — AI Compute Operating System

Cortex is an model-agnostic, harness-agnostic dispatch kernel for AI workloads. It decides **what** executes, **where**, with **how much** context, at **what** spend.

## CLI Commands

```
cortex init                   scaffold .cortex/ state directory
cortex dispatch <task>        dispatch a task (alias: cortex run)
cortex plan <task>            print dispatch plan, zero model calls
cortex locate <query>         deterministic code pointers, zero model calls
cortex workers                list registered workers + availability
cortex metrics                per-worker reliability stats
```

Options shared across commands:

| Flag | Description |
|------|-------------|
| `--task, -t` | Task description |
| `--goal, -g` | Goal keywords (derived from task if omitted) |
| `--dir, -d` | Project root (default: cwd) |
| `--state-dir` | State directory override (env: `CORTEX_DIR`) |
| `--budget` | Max input tokens (default: 2500) |
| `--timeout` | Worker timeout in ms (default: 180000) |
| `--dry-run` | Print packet + prompt, no model call, no patch |
| `--help, -h` | Show help |

## Usage from a Harness (openCode, Claude Code, etc.)

### Basic dispatch

```bash
cortex dispatch "add JWT auth middleware to Express app"
```

### Preview the plan before spending tokens

```bash
cortex plan "refactor login controller to use async/await"
```

Returns JSON with `intent`, `entryTier`, `ladder` (ordered workers with utility scores), and `excluded` workers.

### Deterministic code lookup

```bash
cortex locate "budget enforcement"
```

Returns file pointers (`path#L` or `path:symbol`) with zero model calls.

## Architecture (Dispatch Pipeline)

```
Task → Intent Compiler → Capability Planner → Context Compiler
      → UCP v2 Packet → Budget Controller → Harness → Validated Output
```

- **Intent compiler** — deterministic regex-based classifier (zero model calls). Produces `TaskIntent` with `taskType` (patch, question, review, plan), `complexity` (trivial, bounded, open), `capabilities`, and `confidence`.
- **Capability planner** — expected-utility ladder: `EU = quality × reliability / (cost × latency)`. Subject to capability coverage, context-window fit, write-access policy, spend caps.
- **Progressive context compiler** — 5 levels (L0 file names → L4 full source), budget-aware. Starts from `TaskIntent` and escalates one level when budget allows.
- **Budget controller** — hard token budget, degrade cascade, spend estimation with retry probability. Never silently expands.
- **Validation loop** — apply → hooks (`npm test`/`typecheck`/`lint`) → error-only retry, max 3 iterations.

## Worker Registry

Workers are **JSON data**, not plugin code. Default registry at `src/worker/registry.default.json`. Project-local overlay at `.cortex/workers.json` — can add, replace, or retire workers without touching kernel code.

```json
{
  "workers": [{
    "id": "my-worker",
    "capabilities": ["coding", "reasoning"],
    "harness": { "kind": "cli", "bin": "my-tool", ... },
    "cost": { "inPer1k": 3, "outPer1k": 15 },
    "speed": 0.3,
    "contextWindow": 200000,
    "quality": { "coding": 0.8 },
    "reliability": 0.9,
    "tier": 3,
    "writeAccess": "patch"
  }]
}
```

| Field | Description |
|-------|-------------|
| `capabilities` | Which capability dimensions this worker covers |
| `harness` | Execution backend config (`cli` or `http`) |
| `cost` | Relative cost units per 1K tokens in/out |
| `speed` | Relative speed (higher = faster) |
| `contextWindow` | Max tokens the worker accepts |
| `quality` | Prior quality scores per capability (0-1) |
| `reliability` | Prior reliability (0-1), updated by metrics |
| `tier` | Escalation ladder rung (0=deterministic, 3=premium) |
| `writeAccess` | `'none'` or `'patch'` (policy-enforced) |

## Harness Layer

Harnesses are pluggable execution backends registered by `kind`:

```typescript
interface Harness {
  available(): boolean
  invoke(req: HarnessRequest): Promise<HarnessResult>
}

type HarnessFactory = (config: HarnessConfig) => Harness
```

Built-in:
- **CLI harness** — spawns a binary with args template, env stripping, stdin or arg prompt delivery
- **HTTP harness** — JSON-over-HTTP with body template, output dot-path extraction

To add a new harness type (MCP, A2A, browser, remote cluster), implement `Harness` and register with `registerHarness(kind, factory)`.

## UCP v2 Packet Format

Ultra-Compact Packet — the wire format between cortex and its workers. Single-letter keys for minimum token overhead.

```json
{
  "v": 2,
  "t": "task-slug",
  "act": "work|ask|review",
  "g": "keyword goal",
  "q": "one-line question (ask only)",
  "c": ["atomic constraint"],
  "ctx": {
    "f": ["path#L or path:symbol"],
    "d": ["prefix-keyed fact"]
  },
  "r": { "out": "patch|decision|design|review" }
}
```

Acts: `work` (execute a task), `ask` (oracle question), `review` (oracle judgment).

Output shapes:
- **work**: `{ "a": "<unified diff or IMPOSSIBLE: reason>", "why": "one line" }`
- **ask**: `{ "a": "<decision>", "why": "optional rationale" }`
- **review**: `{ "v": "PASS" }` or `{ "v": "ISSUES", "i": [["R|Y|G", "path#L", "finding"]] }`

## Artifact System

All output from the pipeline is a typed artifact — discriminated union on `kind`:

`patch`, `plan`, `decision`, `review`, `test-result`, `pointer-set`, `token-estimate`, `intent`, `metric`, `failure`

Each has `id`, `taskId`, `createdAt`, `producedBy`, and a typed `body`. Artifacts serialize to JSON and persist in `.cortex/artifacts/<taskId>/*.json`.

## State & Metrics

`.cortex/` directory in the target project:

| File | Purpose |
|------|---------|
| `state.json` | Current task, changed files, distilled facts |
| `workers.json` | Optional project-local worker registry overlay |
| `artifacts/<taskId>/*.json` | Persisted decisions, reviews, plans |
| `metrics.jsonl` | Append-only dispatch records per invocation |

Metrics per worker: success rate, mean latency, mean tokens. Reliability is updated as `(prior×weight + observed×n) / (weight + n)`. Planner reads aggregated stats as Bayesian-ish priors.

## MCP Server

Cortex also exposes its functionality as an MCP server:

```bash
cortex-mcp
```

Tools exposed: `cortex_plan`, `cortex_locate`, `cortex_workers`, `cortex_metrics`, `cortex_dispatch`, `cortex_init`.

Resource: `cortex://registry` — all registered workers with capabilities and metrics.

## Tips for Harness Integration

1. **Use `cortex plan` to inspect routing decisions** before dispatching — inspect the intent classification, ladder, and expected spend.
2. **Use `cortex locate` for fast code pointer lookups** — tier-0 deterministic, no model tokens spent.
3. **Configure project-local workers** via `.cortex/workers.json` — add new workers, override costs/quality, or retire defaults without modifying kernel code.
4. **Set `CORTEX_DIR`** to point the state directory to a non-default location.
5. **Use `--dry-run`** to debug what would be dispatched — prints the full UCP packet and prompt.
6. **Extend with new harness types** — implement the `Harness` interface and register it for custom execution protocols.
7. **Monitor metrics** — `cortex metrics` shows per-worker reliability; declining stats suggest a worker should be reconfigured or retired.
