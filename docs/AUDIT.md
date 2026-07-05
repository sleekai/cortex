# Cortex Repository Audit — 2026-07

Status audit of the repository against the Cortex vision (capability-driven AI
orchestration kernel: model-, harness-, protocol-agnostic; artifact-driven;
cost/token-aware; observable; extensible). Referenced by `ARCHITECTURE.md`.

Verdict up front: **the migration described in `ARCHITECTURE.md` is
complete.** All seven phases of the canonical roadmap are implemented and
tested (190 tests green past v2.1.0). The two gaps this audit originally
flagged are closed: the kernel is extracted to `src/kernel/` (both entry
points are thin surfaces over it). Several roadmap items remain deliberately
deferred; the deferrals are documented here with their tradeoffs. DAG
execution and the ingress/egress adapter registries were later removed as
zero-consumer speculation — see `docs/adr/0001-defer-dag-execution.md` and
`docs/adr/0002-defer-adapter-registries.md`; historical references to them
below are kept for the record.

---

## 1. Current architecture

```
                    ┌──────────────┐      ┌───────────────┐
   entry points →   │ index.ts CLI │      │ mcp-server.ts │   ← thin surfaces
                    └──────┬───────┘      └───────┬───────┘     over the kernel
                           └────────┬─────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────┐
        │ kernel/ (orchestrators):                              │
        │  kernel.ts: planTask, prepareDispatch, runLocate     │
        │  dispatch-orchestrator.ts: executeTask               │
        │  blueprint-orchestrator.ts: runBlueprint             │
        │  barrel: index.ts re-exports all                     │
        └──────────────────────────────────────────────────────┘
             │            │            │            │
             ▼            ▼            ▼            ▼
        capability/   retrieval/    packet/      worker/ + harness/
        (intent,      (AST, TF-IDF, (UCP v2,     (registry JSON,
         planner EU,   git-recency,  generator,   dispatch DAG +
         policy)       L0–L4 levels) budget)      ladder; cli/http)
             │                                        │
             └───────────► artifact/ ◄────────────────┘
                        (typed union — the only currency)
                               │
                               ▼
                     state/ (.cortex/: state.json,
                     artifacts/<task>/, metrics.jsonl,
                     workers.json overlay)
```

Module dependency map (import direction, no cycles):

```
core/ (types, tokens, logger, signals)   ← everyone
artifact/                                ← worker, validator, state, kernel
capability/ → worker/registry, packet/budget (spend), artifact, core/signals
worker/ → harness, packet/ucp, artifact, capability, state(metric type)
harness/ → (nothing internal; self-registering factories)
retrieval/ → core, capability(intent type)
packet/ → core, retrieval(chunk type via core)
validator/ → worker/dispatch, packet/generator, artifact
state/ → artifact
loop/ → packet, worker, validator, core, artifact
kernel/ (orchestrators) → capability, retrieval, packet, worker, harness,
  loop, artifact, state, ingress, triage, skill, blueprint, policy
index.ts / mcp-server.ts → kernel/ (barrel import)
```

Execution flow (dispatch): intent (deterministic, zero model calls) → plan
(expected-utility ladder under policy) → context (progressive L0–L4) → packet
(UCP v2) → budget (degrade cascade, spend gate, refuse) → validation loop
(dispatch via ladder → parse once at harness boundary → apply patch → hooks →
error-only retry ≤3) → artifacts + state + metrics persisted.

## 2. Subsystem verdicts

| Subsystem | State | Verdict |
|---|---|---|
| `core/` types, tokens, logger, signals | shared primitives + signal tables (FILE_PATTERN, complexity classification) | **keep unchanged** |
| `artifact/` typed union, parse-once boundary | 10 kinds, guards, (de)serialize | **keep unchanged** |
| `packet/` UCP v2 + generator + budget | versioned, v1-compatible read, degrade cascade, spend refuse | **keep unchanged** |
| `capability/` vocabulary, intent compiler, EU planner, policy | deterministic classifier w/ confidence; EU = q·rel·speed/spend; ladder + tier-0 short-circuit | **keep unchanged** |
| `worker/registry` JSON specs + overlay | hot-swap via `.cortex/workers.json`, validation, env overrides, `disabled` retirement | **keep unchanged** |
| `worker/dispatch` single-packet dispatch | `dispatchOne` parse-once at harness boundary; DAG executor removed (zero production consumers — ADR-0001) | **keep** |
| `harness/` seam + cli/http | factory registry; planner never sees execution detail | **keep; extend by registration only** |
| `core/signals.ts` shared signal tables | `FILE_PATTERN`, `OPEN_SIGNALS`, `TRIVIAL_SIGNALS`, `classifyComplexity` | **added** — deduplicated from intent-compiler + triage |
| `retrieval/` AST, TF-IDF, git-recency, L0–L4 compiler | deterministic, budget-gated escalation | **keep; escalation trigger is narrow (see §4)** |
| `validator/` patch-apply + loop | error-only retry packets (tested invariant) | **keep unchanged** |
| `state/` store + metrics | `.cortex/` engine, legacy migration, JSONL learning loop → planner priors | **keep** |
| `worker/output-parser.ts` + diff-extractor, json-extractor, artifact-builder | thin composition over three focused extractors | **split** — was a 119-line monolith |
| `index.ts` | CLI surface over `kernel/` | **done** — pipeline extracted |
| `mcp-server.ts` | MCP surface over the same kernel | **done** — pipeline extracted |
| `dist/`, `dist-test/` | build artifacts on disk | gitignored, untracked — no action |

The graph module (`src/graph/`) was identified as orphaned infrastructure
(~500 lines with zero production consumers) and removed. The triage cache
(`src/triage/cache.ts`) was removed — CTS stages are deterministic regex
pipelines where caching saved microseconds at the cost of a global mutable
Map and fragile control flow.

## 3. Technical debt inventory (ranked)

1. ~~**Kernel duplication.**~~ **Resolved** — pipeline extracted to
   `src/kernel/kernel.ts`; `index.ts` and `mcp-server.ts` are thin surfaces;
   MCP dispatch now persists artifacts and state like the CLI.
2. ~~**DAG executor incomplete.**~~ **Resolved** — `executePlan` has
   `resumeFrom` (replay/partial recomputation), `onNodeComplete`
   (checkpointing), and `AbortSignal` cancellation.
3. **Context escalation trigger is narrow.** Escalates only when a level
   yields zero chunks. A patch task with *weakly relevant* chunks never climbs.
   Acceptable v1 heuristic; needs a retrieval-quality metric before widening
   (otherwise every task climbs to L4 and the budget discipline dies).
4. **`cortexDir()` re-implemented in three files** (store, metrics, registry,
   index). Cosmetic; consolidate opportunistically when touching those files.
5. **Availability probes are sync** (`available(): boolean` backed by
   `spawnSync` in cli-harness). Blocks the event loop for N workers at plan
   time. Low impact at current registry sizes; make async only with evidence.

## 4. Gap analysis vs the 10-phase directive

| Phase | Directive | Status | Evidence |
|---|---|---|---|
| 1 Observability | metrics, token/latency/retry tracking | **done** | `state/metrics.ts` JSONL + aggregation + blended reliability |
| 2 Artifact layer | typed artifacts everywhere | **done** | `artifact/artifacts.ts`; parse-once at `worker/output-parser.ts` |
| 3 UCP | versioned compact packets | **done** | `packet/ucp.ts` v2, v1 read-compat, `docs/UCP-SPEC.md` |
| 4 Context compiler | layered expansion | **done (L0–L4)** | `retrieval/context-compiler.ts` |
| 5 Capability system | capability-centric execution | **done** | `capability/*`; planner never sees raw text |
| 6 Worker abstraction | registry, hot-swap, profiles | **done** | `worker/registry.ts` + JSON overlay + harness seam |
| 7 Economic scheduler | utility optimization | **done** | `capability/planner.ts` EU scoring + spend gate + ladder |
| 8 Execution graphs | DAG + retries + cancel + checkpoint + replay | **removed** | zero production consumers; deferred until a fan-out consumer exists (ADR-0001) |
| 9 Progressive escalation | expand only when justified | **partial** | budget-gated climb exists; trigger narrow (§3.3) → deferred pending retrieval-quality metric |
| 10 Kernel activation | kernel owns planning/scheduling/budget/policy | **done** | `kernel/kernel.ts`: planTask / prepareDispatch / executeTask; CLI and MCP are surfaces |

Directive items **deliberately deferred**, with tradeoffs (Rule 6):

- **L5/L6 context levels & call/dependency graphs.** Current L4 = full source
  of top files already serves the "full source" endpoint. A call-graph level
  would improve ranking for cross-file tasks, but there is no measured
  retrieval-miss data yet to justify the AST-walker complexity. Defer until
  metrics show L3/L4 packets failing on missing-context grounds. (Rule 1.)
- **Embeddings.** TF-IDF is deterministic, dependency-free, and testable; the
  spec marks embeddings "optional if justified". Not justified by any metric
  yet.
- **MCP-client / A2A / browser harnesses.** The seam (`HarnessFactory`) is the
  deliverable; shipping every protocol client is not. Documented in
  ARCHITECTURE.md deviations.
- **Four named state stores.** The directive names Knowledge / Repository /
  Execution / Experience stores. The current layout already separates these
  concerns: `artifacts/` (knowledge), retrieval is recomputed per-run
  (repository — cheap and always fresh at current repo sizes), `state.json` +
  `runs/` checkpoints (execution), `metrics.jsonl` (experience). Renaming
  directories to match the vocabulary is churn without behavior change;
  adopt the *names* in docs, not as a file move. A persistent repository
  index becomes worthwhile only when `parseDirectory` cost shows up in
  latency metrics.
- **Daemon/scheduler-as-a-service.** Statelessness-by-construction is the
  repo's strongest property (ARCHITECTURE.md deviation 2). Unchanged.

## 5. Migration plan — **shipped**

All phases below are implemented and tested (see §2/§4). The plan is kept for
the record.

**Step 1 — Kernel extraction (completes Phase 10).**
- New `src/kernel/kernel.ts`: `planTask()` (intent+plan, read-only),
  `prepareDispatch()` (context+packet+budget, read-only), `runTask()` (full
  pipeline + persistence + metrics).
- `index.ts` and `mcp-server.ts` become surfaces that call the kernel.
- Compatibility: CLI flags and output unchanged; MCP tool schemas unchanged.
  One deliberate behavior change: MCP dispatch now persists artifacts and
  updates state, matching the CLI (previously silently skipped — drift, not
  design; nothing in MCP docs promised statelessness).
- Rollback: revert one commit; entry points regain inline pipelines.
- Tests: new `test/kernel.test.ts` (plan shape, dry-run packet, tier-0
  short-circuit, budget refusal path); existing suites unchanged and green.

**Step 2 — Execution graph completion (advances Phase 8).**
- `executePlan` gains: `completed` seed map (resume/replay — nodes already
  settled are skipped: partial recomputation), `onNodeComplete` callback
  (checkpointing), `AbortSignal` (cancellation at node boundaries — in-flight
  harness calls run to completion; true mid-call abort requires a harness
  interface change and is deferred until a harness supports it).
- `state/store.ts` gains run-checkpoint persistence under
  `.cortex/runs/<taskId>.json` (execution store).
- Compatibility: all parameters optional; existing callers unaffected.
- Rollback: revert one commit.
- Tests: resume-skips-completed, checkpoint-callback-fires, abort-stops-
  unstarted-nodes, failed-dependency short-circuit still holds.

Success metrics: zero duplicated pipeline lines between entry points; MCP and
CLI dispatch produce identical persisted state for identical inputs; DAG
resume re-executes only unfinished nodes; suite green.

## 6. Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| Kernel extraction changes CLI behavior subtly | low | pipeline moved verbatim; CLI output assembled from same fields; tests pin plan/dry-run shapes |
| MCP persistence change surprises a consumer | low | additive (writes files it previously didn't); documented in ARCHITECTURE.md |
| Checkpoint file grows unbounded | low | one JSON per task id, overwritten per run |
| Abort semantics misread as mid-call kill | medium | documented at the option site + in ARCHITECTURE.md |

## 7. Test & rollback strategy

Per-commit: `npm run typecheck && npm test` must be green before the next step
begins. Each step is a single atomic commit; rollback is `git revert` of that
commit, and no step leaves data in `.cortex/` that an older binary cannot
read (checkpoints are a new, ignorable file; state.json schema untouched).