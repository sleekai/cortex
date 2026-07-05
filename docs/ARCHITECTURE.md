# Cortex — Architecture & Upgrade Plan

Cortex is the orchestration kernel this repository evolves into: it decides
*what* executes, *where*, with *how much* context, at *what* spend — and it is
model-, harness-, provider-, and protocol-agnostic. Claude, GPT, local models,
CLIs, HTTP APIs are plugins. Cortex is the operating system.

This plan follows the audit in `docs/AUDIT.md`. Guiding rule from the audit:
**evolve, don't rewrite** — the budget controller, deterministic retrieval,
validation loop, and stateless one-shot discipline survive intact; everything
implicit becomes explicit and typed.

Status (2026-07): phases 1–6 below are implemented and tested — the
original 5-phase plan plus the CUEA closed-loop execution engine. The kernel
is extracted (`src/kernel/kernel.ts`); the DAG executor supports checkpointing,
resume, and cooperative cancellation. A state-graph layer (`src/graph/`) adds
dynamic control flow above dispatch — reducer channels, conditional routing,
Send fan-out, bounded cycles, interrupt/resume — adopting LangGraph's proven
ideas without its dependencies (see "State graph" below). The CUEA loop
(`src/loop/`) wraps the Producer→Evaluator→Router cycle around the same
prepared dispatch pipeline, handing every continuation decision to the Router
under explicit bounds (see "CUEA execution loop" below). `docs/AUDIT.md` §4
records what is deliberately deferred and why (call/dependency-graph
retrieval, embeddings, additional protocol harnesses, a persistent repository
index).

## Deviations from the vNext specification (deliberate)

The spec invites improvement where a superior design exists. Three deviations:

1. **The kernel stays inside `skills/ucp-toolchain/implementation/`.**
   The install story (`npx skills add` copies skill folders; resolution order
   `$UCP_TOOLCHAIN_DIR` → beside-the-skill → cache clone) depends on the
   implementation shipping with the skill. Moving it to the repo root breaks
   every installed copy. The package is *renamed* `cortex` and exposes a
   `cortex` bin (with `ucp` kept as an alias); the directory stays put.
2. **No daemon, no server, no long-lived scheduler.** The repo's strongest
   property is statelessness by construction. Cortex here is a *library +
   CLI kernel* invoked per task: plan is computed, dispatches run (parallel
   where the plan allows), state is flushed to disk. "Distributed execution"
   is satisfied by the Harness seam (a RemoteHarness is a plugin), not by
   building cluster infrastructure into a skills repo.
3. **Learning is priors-from-metrics, not an ML subsystem.** Every dispatch
   appends a metrics record; the planner reads aggregated per-worker
   success/latency/token statistics as Bayesian-ish priors that shift utility
   scores. No training loops. Deterministic, inspectable, testable.

## Module map

```
cortex   (package: @sleekai/cortex)
  src/
    kernel/
      kernel.ts         the one pipeline: planTask | prepareDispatch | runTask |
                        runLoop; CLI and MCP server are thin surfaces over it
    core/
      types.ts          shared primitives (chunks, budgets) — extended, kept
      logger.ts         kept
      tokens.ts         single token-estimation source (dedup of 2 copies)
    loop/
      execution-state.ts  ExecutionState record + pure reducers (iteration,
                          cost, escalationDepth, history, status)
      evaluator.ts      pure EvaluatorInput → Evaluation (ACCEPT/RETRY/ESCALATE/
                        FINISH); default hook-decision evaluator
      router.ts         pure state+eval → RouterAction; all termination
                        guarantees (bounds, convergence) live here
      loop-engine.ts    bounded Producer→Evaluator→Router while-loop;
                        ladderProducer dispatches one rung per loop body
    artifact/
      artifacts.ts      typed Artifact union + guards + (de)serialization
    packet/
      ucp.ts            UCP v2: versioned, both dialects (work + judgment)
      generator.ts      evolved from ucp/generator.ts
      budget-controller.ts  evolved; adds spend/retry estimation
    capability/
      capabilities.ts   Capability vocabulary + TaskIntent types
      intent-compiler.ts  deterministic request → structured intent
      planner.ts        expected-utility worker selection + escalation ladder
      policy.ts         hard constraints (write-access, spend caps, deny-lists)
    worker/
      registry.ts       WorkerSpec registry: load, validate, query by capability
      registry.default.json   built-in workers (claude CLI as the first entry)
      dispatch.ts       dispatch planner: sequential / parallel / fan-out, retry
    harness/
      harness.ts        Harness interface + registry of harness factories
      cli-harness.ts    generic process harness (claude-adapter generalized)
      http-harness.ts   generic JSON-over-HTTP harness
    graph/
      channels.ts       reducer channels: shared state with declared merge semantics
      state-graph.ts    graph builder: nodes, edges, routers, Send, goto
      executor.ts       superstep executor: cycles, interrupts, checkpoints
      packet-node.ts    bridge: dispatchWithLadder as a graph node
    retrieval/          kept: ast-parser, embedder (TF-IDF), git-priority
      context-compiler.ts  progressive levels over the existing retrieval
    validator/          kept: patch-apply, validation-loop (worker-agnostic now)
    state/
      store.ts          .cortex/ state engine: decisions, artifacts index
      metrics.ts        append-only JSONL metrics + aggregation (learning)
    index.ts            CLI: run | plan | locate | workers | metrics
  test/                 node:test suites per subsystem
```

## Subsystem designs

### Artifacts (`artifact/artifacts.ts`)

Everything exchanged is a typed artifact — a discriminated union on `kind`:
`patch`, `plan`, `decision`, `review`, `test-result`, `pointer-set`,
`token-estimate`, `intent`, `metric`, `failure`. Each has `id`, `taskId`,
`createdAt`, `producedBy` (worker id or `kernel`), and a typed `body`.
Raw model output is parsed *once* at the harness boundary into an artifact;
everything downstream is typed. Artifacts serialize to JSON and are the only
things the state engine persists (besides metrics).

### UCP v2 (`packet/ucp.ts`)

One packet grammar, versioned, covering both dialects:

```jsonc
{
  "v": 2,
  "t": "task-slug",
  "act": "work" | "ask" | "review",
  "g": "keyword goal",
  "q": "one-line question (ask only)",
  "c": ["atomic constraints"],
  "ctx": { "f": ["pointers"], "d": ["prefix-keyed facts"] },
  "r": { "out": "patch|analysis|plan|decision|design|review", "format": "..." }
}
```

Single-letter keys, pointers-never-paste, and fact caps are unchanged. `v: 1`
packets (no `v`, no `act`) are read compatibly: absent `act` ⇒ `work`.

### Capability model & intent compiler (`capability/`)

`Capability` is a closed string-literal vocabulary (`coding`, `reasoning`,
`planning`, `review`, `docs`, `search`, `vision`, `audio`, `embeddings`, …) —
extensible in one place. The **intent compiler** is deterministic (rules +
keyword/AST signals, zero model calls) and produces:

```ts
interface TaskIntent {
  taskType: 'patch' | 'question' | 'review' | 'plan'
  complexity: 'trivial' | 'bounded' | 'open'   // drives ladder entry point
  capabilities: Capability[]
  requiredArtifacts: ArtifactKind[]
  expectedOutput: ArtifactKind
  estTokenBudget: number
  estReasoningDepth: 0 | 1 | 2 | 3
  confidence: number        // 0..1, how sure the compiler is of its own parse
  fileHints: string[]
}
```

The planner never sees raw user text — only `TaskIntent`.

### Worker registry (`worker/registry.ts`)

Workers are data, not code:

```ts
interface WorkerSpec {
  id: string
  capabilities: Capability[]
  harness: { kind: 'cli' | 'http', ... }   // harness-specific config
  cost: { inPer1k: number, outPer1k: number }   // relative units
  speed: number            // relative, higher = faster
  contextWindow: number
  quality: Record<Capability, number>       // 0..1 priors
  reliability: number      // 0..1 prior, updated by metrics
  tier: 0 | 1 | 2 | 3      // escalation ladder rung (0 = deterministic)
  writeAccess: 'none' | 'patch'             // policy-enforced
}
```

Registry loads `registry.default.json`, then merges `.cortex/workers.json`
from the target project (hot-swap without touching the kernel). Claude CLI is
*one JSON entry*, not privileged code.

### Harness layer (`harness/`)

```ts
interface Harness {
  invoke(req: HarnessRequest): Promise<HarnessResult>
}
interface HarnessRequest { prompt: string; timeoutMs: number; maxOutputBytes: number }
interface HarnessResult  { ok: boolean; output: string; latencyMs: number; failReason?: string }
```

The planner and dispatch layer never know how a worker executes. `cli-harness`
generalizes today's claude-adapter: binary, args template, env-strip list,
stdin/arg prompt delivery, availability probe — all from `WorkerSpec.harness`.
`http-harness` covers OpenAI-compatible and arbitrary JSON endpoints via a
request template. MCP / A2A / browser harnesses are additional
`HarnessFactory` registrations — the seam exists; shipping those clients is
out of scope for this repo and documented as such.

### Planner & escalation (`capability/planner.ts`)

Expected-utility selection under policy:

```
EU(worker) = quality(worker, caps) × reliability(worker)
             ────────────────────────────────────────────
             (estCost(worker, budget) × estLatency(worker))
```

subject to: capability coverage, context-window fit, `writeAccess` policy,
spend caps, tier ≥ ladder entry point. The **ladder** is: tier 0 deterministic
(retrieval/AST — answers `locate`-shaped intents with zero model calls) →
tier 1 small/local → tier 2 mid → tier 3 premium reasoning. Entry point comes
from `TaskIntent.complexity`; escalation to the next rung happens only on
failure or explicit low confidence, and every escalation is recorded as a
`decision` artifact with its justification. Metrics-derived reliability
multiplies into EU, closing the learning loop.

### Progressive context compiler (`retrieval/context-compiler.ts`)

Levels, each strictly larger, each escalation justified and logged:

```
L0 file names → L1 symbols → L2 signatures → L3 ranked chunks (≤600ch)
→ L4 full source of top files
```

Level selection starts from `TaskIntent` (a `locate` needs L0–L2; a patch
needs L3) and escalates one level only when the budget controller confirms
headroom. Existing AST parser, TF-IDF ranking, and git-recency boost are the
engine underneath; they are unchanged.

### Budget controller v2 (`packet/budget-controller.ts`)

Keeps the existing degrade cascade. Adds: output-token estimate, retry
probability (from metrics, default prior 0.25), expected total spend
(`(in + out×est) × (1 + pRetry)` in the worker's cost units), and a hard
`maxSpend` policy gate. Never silently expands context — an over-budget
packet is compressed, split (fan-out via dispatch planner), or refused with a
`failure` artifact naming the smallest sufficient budget.

### Dispatch planner (`worker/dispatch.ts`)

Executes a `DispatchPlan` of nodes `{ packet, workerId, dependsOn[] }`:
independent nodes run in parallel (`Promise.all` over async harness calls,
bounded concurrency), dependents sequence, failures trigger per-node retry
policy (error-only retry packet, unchanged semantics) then ladder escalation.

Checkpointing and replay: `executePlan` accepts `resumeFrom` (settled nodes
are restored without re-dispatch — partial recomputation), `onNodeComplete`
(fires per dispatched node; wire it to `saveRunCheckpoint`), and an
`AbortSignal` for cooperative cancellation — nothing launches after abort,
in-flight harness calls drain, and cancelled nodes settle as *recoverable*
failures so a resume re-runs them. True mid-call abort would need harness
support and is deferred until a harness can honor it.

### State graph (`graph/`)

Dynamic control flow above the dispatch planner, adopted from LangGraph's
good parts and rebuilt Cortex-idiomatic (deterministic, zero dependencies,
artifact-first):

- **Reducer channels** (`channels.ts`) — shared state as declared channels,
  each with a merge reducer (`lastValue`, `appendList`, `mapMerge`, custom).
  Parallel nodes never race: the executor applies their updates through the
  reducers in node-id-sorted order, so runs are reproducible regardless of
  completion timing. Channel values must stay JSON-serializable.
- **State graph builder** (`state-graph.ts`) — `stateGraph(channels)
  .addNode().addEdge().addConditionalEdges().compile()`. Conditional routers
  inspect merged state at runtime; a node may override its outgoing edges per
  run (Command-style `goto`); `send(node, input)` schedules dynamic fan-out —
  one task per payload, map-reduce with a reducer channel as the join. Cycles
  are legal.
- **Superstep executor** (`executor.ts`) — Pregel-style: run the frontier
  concurrently (bounded), merge updates, route the next frontier. A
  checkpoint (`{ step, state, frontier, interrupted }`) is snapshotted before
  every superstep, so `failed`, `cancelled`, `exhausted` (recursion limit,
  default 25 supersteps), and `interrupted` outcomes all carry a resumable
  snapshot — time travel is resuming from an earlier one. `interrupt` is the
  human-in-the-loop seam: the node pauses the run (peers still settle),
  `resumeGraph(graph, checkpoint, value)` re-runs it with `ctx.resume` set.
  `onEvent` streams superstep/node lifecycle; `onCheckpoint` is the
  persistence seam (wire to `state/store`).
- **Packet bridge** (`packet-node.ts`) — `packetNode()` wraps
  `dispatchWithLadder` as a graph node (escalation, metrics, and artifact
  parsing unchanged); `packetChannels()` provides the `artifacts` append
  channel and `results` map channel. One dispatch implementation, two
  frontends: static `DispatchPlan`s keep using `executePlan`; graphs that
  need runtime routing, loops, fan-out, or human gates use the state graph.

Deliberately not adopted from LangGraph: checkpointer backends (the state
engine owns persistence), thread ids (a checkpoint is a plain JSON value),
and runnable/message abstractions (a node is a function; artifacts are the
currency).

### CUEA execution loop (`loop/`)

A closed-loop execution engine (Cortex Unified Execution Architecture): a
**Producer → Evaluator → Router** cycle that iteratively refines, escalates, or
terminates on evaluation feedback (spec §3–§5). Where the validation loop
(`validator/validation-loop.ts`) delegates escalation to `dispatchWithLadder`'s
internal walk inside a fixed 3-iteration cap, the CUEA loop hands **every**
continuation decision to the Router under explicit bounds (§6).

- **Execution state** (`execution-state.ts`) — the mandated record
  `{ iteration, cost, escalationDepth, history, currentOutput, status }`.
  Data only; every transition is a pure reducer (`recordAttempt` -> bumps
  iteration and accrues cost; `escalate` -> bumps depth; `finish` -> sets
  status). `status` is `'running' | 'finished' | 'escalated'` — the last marks a
  task that climbed the ladder before stopping (distinguished by §11 success
  criteria).
- **Evaluator** (`evaluator.ts`) — a pure `EvaluatorInput → Evaluation`
  `({ decision: 'ACCEPT'|'RETRY'|'ESCALATE'|'FINISH', confidence, issues })`.
  Purity is what keeps the loop deterministic under identical inputs: the
  default `hookDecisionEvaluator` maps an artifact plus a pre-computed
  `ValidationResult` to a decision (patch+pass → ACCEPT, patch+fail → RETRY,
  recoverable failure → ESCALATE, unrecoverable → FINISH, non-patch artifacts
  → ACCEPT). An LLM-as-judge is a drop-in `Evaluator` at the cost of that
  determinism. Confidence in RETRY verdicts scales inversely with error count
  (fewer errors → higher confidence it's a near-miss, not a bad approach).
- **Router** (`router.ts`) — the *only* component that continues the loop.
  A pure `(state, evaluation) → RouterAction` function with deliberate
  precedence: a decisive Evaluator verdict (ACCEPT/FINISH) wins immediately,
  then hard bounds (§6) fire (they can only STOP the loop, never extend it),
  then convergence heuristics check for stability (same-tier confidence Δ <
  2% → stable) or negligible improvement (Δ confidence ≤ 1% and no fewer
  issues → spinning), and only then are RETRY/ESCALATE honored within their
  bounds (max 3 escalation depth, configurable). Bounds are always checked
  before honoring a RETRY, so iteration can never push past maxIterations.
  Cross-tier confidence plateaus never stall escalation — stability is gated
  on same-tier comparisons only. RouterBounds are all configurable:

```ts
interface RouterBounds {
  maxIterations: number       // default 5
  maxEscalationDepth: number  // default 3
  maxCost: number             // relative cost units, default ∞
  confidenceEpsilon: number   // default 0.02
  improvementEpsilon: number  // default 0.01
}
```

- **Loop engine** (`loop-engine.ts`) — wires the three seams in a single
  bounded `while`; advances the ladder rung only on `escalate`, stops only on
  `finish`. Contains a hard iteration guard as backstop (mirrors
  `maxIterations` so a malformed custom Router can never spin forever). The
  default `ladderProducer` dispatches exactly **one** rung per loop body (never
  walking the ladder itself — escalation is the Router's job), applies a patch
  artifact and runs the project's hooks so the Evaluator gets a deterministic
  verdict, and swaps in an error-only packet on same-tier retries. Constraints
  hold structurally: every output is evaluated before the Router runs, no
  recursion, and no worker invokes another worker.

Kernel entry: `runLoop` (`kernel/kernel.ts`) — same `prepareDispatch` pipeline,
budget, and persistence path as `runTask`, but with the Router driving instead
of the fixed validation loop. Exposed programmatically (not yet wired to the
CLI — add via `cortex run --loop`).

### State engine & learning (`state/`)

`.cortex/` in the target project:

- `state.json` — current task, changed files (evolves `.ucp-toolchain/state.json`;
  the store reads the old path once and migrates).
- `artifacts/<taskId>/*.json` — persisted decisions, reviews, plans.
- `metrics.jsonl` — one record per dispatch: worker, tier, tokens in/out (est),
  latency, iterations, ok/fail, context level. Append-only.
- `runs/<runId>.json` — execution-graph checkpoints: the non-failure node
  results of a run (failures and cancellations are never persisted — they
  must re-run on resume).
- `workers.json` — optional project-local worker registry overlay.

`metrics.ts` aggregates per-worker success rate / mean latency / mean tokens
and exposes them to the planner as reliability updates:
`reliability = (prior×w + observed×n) / (w + n)`.

No conversational transcripts are persisted (debug prompt/output dumps stay in
`$TMPDIR` as today).

### Skills layer

SKILL.md files stay the human/agent-facing contract. Changes: `ucp-toolchain`
documents the `cortex` CLI and the registry; skills gain a machine-readable
`meta` block (capabilities required, artifacts consumed/produced, preferred
tier, token budget) so future planners can compose skills into execution
graphs. `mother-escalate`'s judgment packet becomes UCP v2 `act: ask|review` —
same fields it already documents, now typed and validated by the kernel.

## Phases

1. **Kernel types** — artifacts, UCP v2, capability vocabulary, tokens dedup.
2. **Plugins** — harness interface + CLI/HTTP harnesses, worker registry
   (+ default registry with claude-cli entry), policy.
3. **Planning** — intent compiler, capability planner + ladder, dispatch
   planner (async), budget v2.
4. **Memory** — context compiler levels, state engine, metrics + learning.
5. **Surface** — CLI (`run|plan|locate|workers|metrics`), validation-loop
   rewire, tests green, SKILL.md + README updates, migration notes.

6. **Closed-loop execution** — CUEA loop: execution state, evaluator, router,
   loop engine + ladderProducer; `runLoop` kernel entry; router-bound
   termination (maxIterations, maxEscalationDepth, maxCost, convergence
   heuristics); deterministic under identical inputs by construction;
   `test/router.test.ts` (12 unit tests), `test/loop-engine.test.ts`
   (integration: accept, retry, escalate, max iterations, ladder exhaustion,
   determinism).

Each phase compiles and tests green before the next begins.

## Migration

- `ucp` bin keeps working: same flags, now routed through intent compiler →
  planner with the default registry (which contains exactly one tier-3 worker,
  claude-cli — behavior converges to today's).
- `.ucp-toolchain/state.json` is auto-migrated to `.cortex/state.json` on
  first write; old file left in place, read-only.
- v1 packets accepted on input paths; all emitted packets are v2.
- `$UCP_TOOLCHAIN_DIR` still honored (alias of `$CORTEX_DIR`).

## Tradeoffs accepted

- **JSON registry over code plugins**: less expressive than a plugin API, but
  hot-swappable, diffable, and testable; a `HarnessFactory` map is the code
  seam when JSON runs out.
- **Heuristic intent compiler**: cheaper and more deterministic than an LLM
  classifier; its `confidence` field is the escape hatch (low confidence ⇒
  ladder entry at a reasoning tier).
- **Estimated tokens, not provider-reported**: providers disagree and CLI
  workers report nothing; a single estimator with metrics correction beats
  per-provider accounting for the planner's purposes.
- **No cluster runtime**: distribution rides the harness seam; this repo stays
  a kernel you can read in an afternoon.
