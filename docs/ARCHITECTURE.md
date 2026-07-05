# Cortex — Architecture & Upgrade Plan

Cortex is the orchestration kernel this repository evolves into: it decides
*what* executes, *where*, with *how much* context, at *what* spend — and it is
model-, harness-, provider-, and protocol-agnostic. Claude, GPT, local models,
CLIs, HTTP APIs are plugins. Cortex is the operating system.

This plan follows the audit in `docs/AUDIT.md`. Guiding rule from the audit:
**evolve, don't rewrite** — the budget controller, deterministic retrieval,
validation loop, and stateless one-shot discipline survive intact; everything
implicit becomes explicit and typed.

Status (2026-07): phases 1–7 below are implemented and tested — the
original 5-phase plan plus the CUEA closed-loop execution engine and the MVP
execution model (skills, blueprints, policy sets). The kernel is extracted
(`src/kernel/`: `kernel.ts`, `dispatch-orchestrator.ts`,
`blueprint-orchestrator.ts`). The CUEA loop (`src/loop/`) wraps the
Producer→Evaluator→Router cycle around the same prepared dispatch pipeline,
handing every continuation decision to the Router under explicit bounds (see
"CUEA execution loop" below). `docs/AUDIT.md` §4 records what is deliberately
deferred and why (call/dependency-graph retrieval, embeddings, additional
protocol harnesses, a persistent repository index).

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
      kernel.ts               planTask, prepareDispatch, runLocate, listWorkers
      dispatch-orchestrator.ts  executeTask, executePrepared, triagedTask
      blueprint-orchestrator.ts runBlueprint
      index.ts                barrel — re-exports from all kernel submodules
    core/
      types.ts          shared primitives (chunks, budgets)
      logger.ts         kept
      tokens.ts         single token-estimation source (dedup of 2 copies)
      signals.ts        shared signal tables (FILE_PATTERN, OPEN/TRIVIAL_SIGNALS,
                        classifyComplexity, extractFileTokens)
    skill/
      skill.ts          generic Skill contract: applicable/execute/observations
      registry.ts       execution-skill registry (pluggability seam)
      builtins.ts       triage, grilling, summarize, review skills
    blueprint/
      blueprint.ts      Blueprint types + registry (workflows as data)
      builtins.ts       debug, feature, pr-review, default blueprints
      runner.ts         step executor: skills conditionally, produce = CUEA loop
    policy/
      policies.ts       PolicySet (retry/escalation/clarification/context/
                        budget/timeout) + named-set registry; Router bounds
                        are a projection of a policy set
    compiler/
      runtime.ts        Intent/Context/Artifact compiler facade, replaceable
    loop/
      execution-state.ts  ExecutionState record + pure reducers
      evaluator.ts      pure EvaluatorInput → Evaluation
      router.ts         pure state+eval → RouterAction; all termination
                        guarantees (bounds, convergence) live here
      loop-engine.ts    bounded Producer→Evaluator→Router while-loop;
                        ladderProducer dispatches one rung per loop body
      context-service.ts ContextService interface + defaultContextService factory
    artifact/
      artifacts.ts      typed Artifact union + guards + (de)serialization
    packet/
      ucp.ts            UCP v2: versioned, both dialects (work + judgment)
      generator.ts      evolved from ucp/generator.ts
      budget-controller.ts  degrade cascade + spend/retry estimation
    capability/
      capabilities.ts   Capability vocabulary + TaskIntent types
      intent-compiler.ts  deterministic request → structured intent
      planner.ts        expected-utility worker selection + escalation ladder
      constraints.ts    hard planner constraints (write-access, deny-lists only)
    worker/
      registry.ts       WorkerSpec registry: load, validate, query by capability
      registry.default.json   built-in workers (claude CLI as the first entry)
      dispatch.ts       dispatch planner: sequential / parallel / fan-out, retry
      output-parser.ts  thin composition over extractors below
      diff-extractor.ts  diff extraction from raw harness output
      json-extractor.ts  JSON extraction from oracle replies
      artifact-builder.ts maps parsed output to typed Artifacts
      prompt.ts         system/user prompt templates per capability
      templates.ts      worker-specific template helpers
    harness/
      harness.ts        Harness interface + registry of harness factories
      cli-harness.ts    generic process harness (claude-adapter generalized)
      http-harness.ts   generic JSON-over-HTTP harness
    retrieval/
      ast-parser.ts     identifier token extraction from source
      embedder.ts       TF-IDF ranker over identifier tokens (zero neural)
      git-priority.ts   git-recency boost for retrieval ordering
      context-compiler.ts  progressive levels L0–L4 over the retrieval engine
    validator/
      patch-apply.ts    apply patches to working tree
    state/
      store.ts          .cortex/ state engine: decisions, artifacts index
      metrics.ts        append-only JSONL metrics + aggregation (learning)
    index.ts            CLI: run | plan | locate | workers | metrics
    mcp-server.ts       MCP stdio server: surfaces kernel as MCP tools
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
spend caps (from `BudgetConfig.maxSpend`, consolidated into `policies.ts` via
`PolicySet.budget.maxCost`), tier ≥ ladder entry point. `PlannerConstraints`
in `capability/constraints.ts` (renamed from `Policy` — "policy" now refers
solely to the execution-lifecycle `PolicySet`) handles only worker deny-lists
and write access enforcement — spend limits moved to `BudgetConfig` in
`core/types.ts` and passed directly to the planner. The **ladder** is: tier 0 deterministic
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

Single-packet dispatch (`dispatchOne`): build prompt, invoke harness, parse
output once at the harness boundary into a typed artifact, emit a metric
record. Escalation and retry are the CUEA loop's responsibility.

DAG execution (parallel nodes, checkpoint/resume, cooperative cancellation)
is deliberately deferred until a real fan-out consumer exists — see
`docs/adr/0001-defer-dag-execution.md`.

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
- **Context service** (`context-service.ts`) — the context-on-demand seam
  extracted from the kernel: a `ContextService` interface with a `fetch`
  method. `defaultContextService()` wraps `compileContext` and tracks fetch
  count internally, consulting the `ContextPolicy` before each fetch. The
  loop engine accepts a service instance instead of a raw callback, so tests
  inject a mock without touching the kernel.

Kernel entry: `executeTask` (`kernel/dispatch-orchestrator.ts`) and
`runBlueprint` (`kernel/blueprint-orchestrator.ts`) — both share the same
`prepareDispatch` pipeline, budget, persistence path, and context-on-demand
service; the Router drives every continuation decision. `cortex dispatch`
and `cortex loop` are the same `executeTask` call with different bounds
(`runTask`/`runLoop` remain as deprecated aliases). The barrel module
`kernel/index.ts` re-exports everything so callers import from one place.

### State engine & learning (`state/`)

`.cortex/` in the target project:

- `state.json` — current task, changed files (evolves `.ucp-toolchain/state.json`;
  the store reads the old path once and migrates).
- `artifacts/<taskId>/*.json` — persisted decisions, reviews, plans.
- `metrics.jsonl` — one record per dispatch: worker, tier, tokens in/out (est),
  latency, iterations, ok/fail, context level. Append-only.
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
   loop engine + ladderProducer; `executeTask` kernel entry; router-bound
   termination (maxIterations, maxEscalationDepth, maxCost, convergence
   heuristics); deterministic under identical inputs by construction;
   `test/router.test.ts` (12 unit tests), `test/loop-engine.test.ts`
   (integration: accept, retry, escalate, max iterations, ladder exhaustion,
   determinism).

7. **MVP execution model** — generic Skill layer (`skill/`: the primitive
   execution unit; triage and grilling are ordinary skills), Execution
   Blueprints (`blueprint/`: workflows as registered data; debug / feature /
   pr-review / default built-ins; the runtime knows nothing about any of
   them), first-class Policies (`policy/`: retry, escalation, clarification,
   context, budget, timeout — Router bounds are a projection), Compiler
   Runtime facade (`compiler/runtime.ts`: Intent/Context/Artifact services,
   replaceable), context-on-demand in the loop (Evaluations express
   `missingContext`; a policy-gated provider fetches minimal context
   mid-loop), a `clarification` artifact kind, and the `runBlueprint` kernel
   entry surfaced as `cortex exec` and MCP `cortex_exec`. Extension guide:
   `docs/EXTENDING.md`.

Each phase compiles and tests green before the next begins.

## Migration

- `ucp` bin keeps working: same flags, now routed through intent compiler →
  planner with the default registry (which contains exactly one tier-3 worker,
  claude-cli — behavior converges to today's).
- `.ucp-toolchain/state.json` is auto-migrated to `.cortex/state.json` on
  first write; old file left in place, read-only.
- v1 packets accepted on input paths; all emitted packets are v2.
- `$UCP_TOOLCHAIN_DIR` still honored (alias of `$CORTEX_DIR`).

Library-level renames (2026-07, breaking for importers; CLI/MCP unchanged):

- `capability/policy.ts` → `capability/constraints.ts`: `Policy` →
  `PlannerConstraints`, `DEFAULT_POLICY` → `DEFAULT_CONSTRAINTS`,
  `checkPolicy` → `checkConstraints`; `KernelConfig.policy` →
  `KernelConfig.constraints`. "Policy" now refers solely to the
  execution-lifecycle `PolicySet` (`policy/policies.ts`).
- Triage vocabulary: `triage/skill.ts` → `triage/stage.ts`,
  `triage/skills/` → `triage/stages/`; `registerSkill`/`getSkill`/
  `registeredSkills` (triage registry) → `registerStage`/`getStage`/
  `registeredStages`; `TriagePolicy.disabledSkills` → `disabledStages`.
  "Skill" now refers solely to the execution unit (`skill/skill.ts`).
- `runTask`/`runLoop` → `executeTask` (deprecated aliases retained).

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
