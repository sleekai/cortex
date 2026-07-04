# Cortex Repository Audit — 2026-07

Status audit of the repository against the Cortex vision (capability-driven AI
orchestration kernel: model-, harness-, protocol-agnostic; artifact-driven;
cost/token-aware; observable; extensible). Referenced by `ARCHITECTURE.md`.

Verdict up front: **the migration described in `ARCHITECTURE.md` is largely
complete.** Phases 1–7 of the canonical roadmap are implemented and tested
(67 tests green at v2.0.1). What remains is completion work, not
transformation: the kernel exists but is duplicated across two entry points
instead of extracted; the DAG executor exists but lacks checkpointing, resume,
and cancellation; several roadmap items are deliberately deferred and the
deferrals are documented here with their tradeoffs.

---

## 1. Current architecture

```
                    ┌──────────────┐      ┌───────────────┐
   entry points →   │ index.ts CLI │      │ mcp-server.ts │   ← both re-implement
                    └──────┬───────┘      └───────┬───────┘     the same pipeline
                           └────────┬─────────────┘             (THE gap)
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │ orchestration pipeline (currently inline, twice): │
        │  compileIntent → loadRegistry → reliability-       │
        │  Overrides → planDispatch → compileContext →       │
        │  generateWorkPacket → enforceBudget →              │
        │  runValidationLoop → saveArtifact/updateState/     │
        │  appendMetric                                      │
        └───────────────────────────────────────────────────┘
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
core/ (types, tokens, logger)        ← everyone
artifact/                            ← worker, validator, state, kernel-pipeline
capability/ → worker/registry, packet/budget (spend), artifact
worker/ → harness, packet/ucp, artifact, capability(planner types), state(metric type)
harness/ → (nothing internal; self-registering factories)
retrieval/ → core, capability(intent type)
packet/ → core, retrieval(chunk type via core)
validator/ → worker/dispatch, packet/generator, artifact
state/ → artifact
index.ts / mcp-server.ts → all of the above (too much — see §3)
```

Execution flow (dispatch): intent (deterministic, zero model calls) → plan
(expected-utility ladder under policy) → context (progressive L0–L4) → packet
(UCP v2) → budget (degrade cascade, spend gate, refuse) → validation loop
(dispatch via ladder → parse once at harness boundary → apply patch → hooks →
error-only retry ≤3) → artifacts + state + metrics persisted.

## 2. Subsystem verdicts

| Subsystem | State | Verdict |
|---|---|---|
| `core/` types, tokens, logger | single token estimator, shared primitives | **keep unchanged** |
| `artifact/` typed union, parse-once boundary | 10 kinds, guards, (de)serialize | **keep unchanged** |
| `packet/` UCP v2 + generator + budget | versioned, v1-compatible read, degrade cascade, spend refuse | **keep unchanged** |
| `capability/` vocabulary, intent compiler, EU planner, policy | deterministic classifier w/ confidence; EU = q·rel·speed/spend; ladder + tier-0 short-circuit | **keep unchanged** |
| `worker/registry` JSON specs + overlay | hot-swap via `.cortex/workers.json`, validation, env overrides, `disabled` retirement | **keep unchanged** |
| `worker/dispatch` ladder + DAG executor | ladder walk solid; `executePlan` DAG runs parallel w/ fan-in short-circuit but **no checkpoint/resume/cancel, and no production caller** | **refactor (complete it)** |
| `harness/` seam + cli/http | factory registry; planner never sees execution detail | **keep; extend by registration only** |
| `retrieval/` AST, TF-IDF, git-recency, L0–L4 compiler | deterministic, budget-gated escalation | **keep; escalation trigger is narrow (see §4)** |
| `validator/` patch-apply + loop | error-only retry packets (tested invariant) | **keep unchanged** |
| `state/` store + metrics | `.cortex/` engine, legacy migration, JSONL learning loop → planner priors | **keep; add run checkpoints** |
| `index.ts` (557 lines) | CLI + **inlined orchestration** + interactive prompts | **extract** pipeline → `kernel/` |
| `mcp-server.ts` (262 lines) | MCP surface + **second copy** of orchestration | **extract**; fix drift |
| `dist/`, `dist-test/` | build artifacts on disk | gitignored, untracked — no action |

Nothing qualifies for **remove** in source. Nothing is dead code.

## 3. Technical debt inventory (ranked)

1. **Kernel duplication (highest).** `index.ts:commandRun` and
   `mcp-server.ts:cortex_dispatch` each inline the full pipeline. Already
   diverged: the MCP path **does not persist artifacts and does not update
   state** after a dispatch; the CLI path does. Same for plan construction
   (duplicated `buildPlan` logic). This is Phase 10 (kernel activation) left
   unfinished — the kernel exists as a code path, not as a module.
2. **DAG executor is dark launched.** `executePlan` is implemented and tested
   but no entry point constructs multi-node plans; the validation loop calls
   `dispatchWithLadder` directly. Fine per Rule 4 (shadow mode), but the
   directive's Phase 8 requirements — checkpointing, replay, partial
   recomputation, cancellation — are absent.
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
| 8 Execution graphs | DAG + retries + cancel + checkpoint + replay | **partial** | DAG + retries exist; checkpoint/resume/cancel missing → **this migration** |
| 9 Progressive escalation | expand only when justified | **partial** | budget-gated climb exists; trigger narrow (§3.3) → deferred pending retrieval-quality metric |
| 10 Kernel activation | kernel owns planning/scheduling/budget/policy | **partial** | logic exists, module doesn't → **this migration** |

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

## 5. Migration plan (this iteration)

Both steps obey the rules: incremental, runnable after each commit, tested,
old paths preserved.

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