# OS-Kernel Architecture Review and Migration Plan

## Decision

Adopt the proposal's operating-system framing, but evolve the current codebase
instead of reorganizing it into the proposed directory tree.

Cortex already is an execution kernel in the important sense: ingress compiles
work, the kernel prepares and runs it, workers are selected by capability, the
CUEA loop controls continuation, and typed artifacts cross the execution seams.
The remaining work is to make capability requirements and extension contracts
first-class, remove a few false or duplicated seams, and decide explicitly
whether reusable worker sessions belong in this product.

The target is therefore:

```text
Ingress -> Compiler Runtime -> Kernel -> Blueprint Runtime -> Skill
                                      |                  |
                                      v                  v
                                PolicySet <------ Capability Resolver
                                      |                  |
                                      v                  v
                                Artifact Store -> Worker + Harness
```

`Worker` remains the canonical term. The proposal's `Agent` combines worker
identity, harness configuration, model metadata, and session behavior into one
large interface. The current split between `WorkerSpec` (data) and `Harness`
(execution adapter) is deeper: planning can change without touching process or
HTTP invocation, and new execution protocols do not change worker selection.

## Current fit

| Proposed concept | Current implementation | Verdict |
|---|---|---|
| Kernel / execution engine | `src/kernel/*`, `src/loop/*` | Keep. The kernel is already the single orchestration entry and CUEA is bounded by the Router. |
| Blueprint runtime | `src/blueprint/*` | Keep and deepen. Blueprints are data, but skill requirements are not yet executable inputs to planning. |
| Skill runtime | `src/skill/*` | Partial. Registry and execution exist; metadata is descriptive only. |
| Capability resolver | `src/capability/planner.ts` | Partial. It resolves task intents to workers, not skill capability profiles to workers. |
| Policy engine | `src/policy/policies.ts`, `src/capability/constraints.ts`, `BudgetConfig` | Partial. Lifecycle policy is first-class, but constraints and budget inputs are spread across types and call parameters. |
| Artifact store | `src/artifact/*`, `src/state/store.ts` | Strong fit. Typed artifacts are the internal currency and are persisted. Runtime validation is structural rather than kind-specific. |
| Session manager | None; ingress merely carries `sessionId` | Missing by design. CLI workers are currently configured for stateless execution. |
| Cost engine | `src/runtime/cost-engine.ts`, budget controller, planner spend estimation | Partial. Cost is represented in several places and provider-reported usage is absent. |
| Telemetry | `src/state/metrics.ts`, execution/cost/final artifacts | Good MVP fit. Metrics influence reliability, but the event model is implicit callbacks and log writes. |
| Agent registry | `src/worker/registry.ts`, harness factories, worker templates | Stronger than proposed. Keep WorkerSpec separate from Harness. |
| Compiler services | Concrete intent/context/artifact compilers | Implementation exists, replaceable facade does not. Documentation currently claims `src/compiler/runtime.ts`, but that file is absent. |
| Ingress / egress | `src/ingress`, `src/egress`, CLI, MCP | Good for two real surfaces. Adapter registries should remain deferred until behavior actually varies. |
| Capability SDK | No coherent public package | Missing. Registries exist independently, but there is no validated extension contract joining capabilities, skills, workers, harnesses, policies, and artifacts. |

## Architectural findings

### 1. The OS-kernel reframing is already implemented

The README, domain language, kernel entry points, worker registry, planner, and
artifact model all follow the proposal's central rule: workflows name work,
not models. Rebranding or moving directories would add no leverage.

### 2. Skill metadata is too shallow

`SkillMeta.capabilities` is `string[]`, while the planner consumes a closed
`Capability[]` on `TaskIntent`. There are no minimum scores, preferred
capabilities, forbidden capabilities, required tools, context constraints, or
artifact input/output declarations. As a result, a skill can describe its
needs but cannot cause the resolver to honor them.

This is the largest functional gap relative to the proposal.

### 3. The resolver is task-centric, not execution-unit-centric

`planDispatch` filters workers for an intent and scores quality, reliability,
speed, and estimated spend. It does not score tool match, context fit beyond a
hard constraint, session reuse, or per-skill historical success. More
importantly, LLM-backed skills receive a `SkillDispatch` already bound to the
task's ladder, so different skills in one blueprint cannot request different
worker characteristics.

### 4. The compiler extension seam is documented but absent

Both architecture and extension docs describe a `CompilerRuntime` facade.
Production code instead imports `compileIntent`, `compileContext`, and
`parseWorkerOutput` directly. This is a documentation defect and an incomplete
module seam. It should be implemented or removed from the docs; the proposal
gives a sound reason to implement it because three concrete compiler variants
already exist.

### 5. Session reuse conflicts with a current invariant

The proposed Session Manager is not a missing implementation detail. It
contradicts the current stateless-dispatch guarantee and the default Claude CLI
configuration (`--no-session-persistence`). Session reuse can reduce priming
cost, but introduces affinity, expiration, isolation, secret retention, stale
context, and reproducibility concerns. It needs an ADR and measured evidence,
not an automatic milestone.

### 6. Policy ownership is split

Lifecycle decisions live in `PolicySet`; worker deny/write constraints live in
`PlannerConstraints`; token/spend controls also travel through `BudgetConfig`
and positional planner parameters. These distinctions are legitimate
internally, but the external interface makes callers know too much. A single
`ExecutionPolicy` input should hide the projections used by planning,
budgeting, context compilation, and routing.

### 7. The artifact model is strong but validation is weak

The discriminated `ArtifactBodies` map gives useful compile-time typing.
`isArtifact`, however, validates only the envelope, so persisted or plugin
artifacts can carry an invalid body. A plugin SDK needs runtime schemas,
versioning, and explicit compatibility behavior before third-party artifact
kinds are safe.

### 8. “Everything is a plugin” should not become “everything has a registry”

The codebase correctly deferred ingress/egress adapter registries until a
second behaviorally distinct implementation exists. Preserve that discipline.
Use a seam when two adapters exist or when tests need a fake; otherwise keep
the implementation local. Plugin-first should describe stable extension
contracts, not speculative indirection.

## Target interfaces

These are directional contracts, not a mandate to introduce all types in one
commit.

```ts
interface CapabilityRequirement {
  capability: Capability
  minimum: number
  weight?: number
}

interface CapabilityProfile {
  minimum: CapabilityRequirement[]
  preferred?: CapabilityRequirement[]
  forbidden?: Capability[]
  tools?: ToolRequirement[]
  context?: { minimumWindow?: number }
  cost?: 'free' | 'low' | 'medium' | 'high'
}

interface SkillContract {
  name: string
  profile: CapabilityProfile
  consumes: ArtifactKind[]
  produces: ArtifactKind[]
}

interface ResolveRequest {
  intent: TaskIntent
  profile: CapabilityProfile
  policy: ExecutionPolicy
  runtime: RuntimeSignals
}

interface CapabilityResolver {
  resolve(request: ResolveRequest, workers: WorkerRegistry): Resolution
}
```

The resolver should return a ranked `Resolution` with exclusions and score
components, not a single worker. The Router needs an escalation ladder, and
operators need an auditable explanation.

Keep the scoring model deterministic and decomposable:

```text
score = capability match
      + preferred capability bonus
      + tool match
      + context fit
      + historical success
      + optional session-affinity bonus
      - expected cost
      - expected latency
      - token pressure
```

Hard requirements and policy prohibitions exclude a worker before scoring.
Weights must be named configuration with normalized ranges; avoid a formula
whose terms use incomparable units.

## Migration sequence

### Phase 0 — Correct the architecture record

Goal: establish an honest baseline before changing runtime behavior.

- Fix the nonexistent `src/compiler/runtime.ts` claim or implement the facade
  in Phase 1 immediately.
- Reconcile stale statements in `docs/AUDIT.md` (for example historical DAG
  claims) with the current tree.
- Record this decision: keep the current `src/` layout and Worker/Harness split;
  do not introduce a monolithic Agent interface.
- Add an architecture conformance test that checks documented production paths
  exist.

Exit: documentation describes only modules present in the build.

### Phase 1 — Make compiler services a real deep module

Goal: one small compiler interface used by all kernel paths.

- Add `src/compiler/runtime.ts` with intent, context, and artifact compiler
  functions and default adapters around the current implementations.
- Inject a `CompilerRuntime` through `KernelConfig` (defaulting internally),
  rather than maintaining process-global mutable configuration.
- Route `kernel.ts`, built-in triage skills, worker dispatch, and context-on-
  demand through it.
- Add contract tests with fake compilers and parity tests for defaults.

Exit: no kernel or skill imports a concrete compiler implementation directly.

### Phase 2 — Promote capability profiles into the skill interface

Goal: make skill requirements executable rather than documentary.

- Replace `SkillMeta.capabilities: string[]` with typed `CapabilityProfile`.
- Add `consumes` and `produces` artifact declarations.
- Validate skill registration: known capabilities, satisfiable ranges, declared
  artifact kinds, and unique names.
- Migrate built-ins without changing behavior; deterministic skills declare a
  free/local execution profile.
- Add registry introspection so CLI/MCP can expose skill contracts.

Exit: every registered skill has a validated, machine-readable contract.

### Phase 3 — Extract the capability resolver

Goal: resolve each executable skill/produce operation against requirements.

- Extract feasibility and scoring from `capability/planner.ts` behind a
  `CapabilityResolver` interface.
- Preserve the current algorithm as the default adapter, then add score
  components for tools and context fit.
- Key historical success by worker plus capability (later worker plus skill),
  not worker alone.
- Return full score breakdowns and exclusion reasons as a decision artifact.
- Change `SkillDispatch` to accept a profile or resolve request so judgment
  skills are not forced to reuse the producer ladder.

Exit: blueprints and skills contain no worker/model names, and each nonlocal
step gets an independently auditable resolution.

### Phase 4 — Unify the external policy interface

Goal: callers provide one policy object while internal modules receive narrow
projections.

- Introduce `ExecutionPolicy` containing lifecycle, feasibility, budget,
  routing weights, compression, and optional session rules.
- Add pure projection functions for Router bounds, planner constraints,
  context policy, timeout, and budget configuration.
- Remove positional `retryProbability`, `tierHint`, and `maxSpend` parameters
  from `planTask`/`planDispatch` in favor of request objects.
- Emit a policy-decision artifact for refusal, retry, repair, clarification,
  escalation, compression, and finish.

Exit: policy has one public owner and each decision is explainable without
reading call-site parameter plumbing.

### Phase 5 — Harden artifacts and extension contracts

Goal: publish a minimal Capability SDK without destabilizing the kernel.

- Add versioned runtime schemas for built-in artifact bodies and worker/skill
  registrations.
- Define a plugin manifest that can contribute capabilities, skills,
  blueprints, policy sets, workers, and harness factories.
- Keep registration explicit during startup; avoid import-time side effects for
  SDK consumers.
- Add compatibility checks and namespaced extension IDs.
- Export a single SDK entry point plus conformance tests and a sample plugin.

Exit: a third party can add one capability, one skill, and one worker adapter
without importing kernel implementation modules.

### Phase 6 — Consolidate events, telemetry, and cost

Goal: make operational data an interface rather than scattered callbacks.

- Define typed kernel events for compile, resolve, dispatch, evaluate, route,
  context fetch, artifact persist, and finish.
- Adapt logging, JSONL metrics, and test observers to one event sink.
- Consolidate cost estimation and accounting behind a Cost Engine; distinguish
  estimated from provider-reported usage.
- Feed capability/skill-level outcomes back into resolver history.

Exit: one run can be reconstructed from events and artifacts, and resolver
scores use the same cost data shown to users.

### Phase 7 — Decide session support by ADR and experiment

Goal: resolve the stateless-versus-reuse choice with evidence.

- First add an optional `SessionProvider` seam to Harness, defaulting to no
  sessions and preserving current behavior.
- Prototype one real adapter with create/resume/release/expire operations.
- Measure token savings, latency, failure rate, and stale-context incidents.
- Specify isolation keys, TTL, maximum reuse, invalidation, secret handling,
  and observability before enabling reuse.
- If the experiment fails its threshold, retain stateless dispatch and remove
  the unused seam. If it succeeds, add session affinity as a bounded resolver
  bonus, never a hard preference.

Exit: an ADR either rejects session reuse or ships one production adapter with
explicit policy and tests.

### Phase 8 — Expand blueprints only from real workflows

Goal: grow software, research, documentation, review, migration, and debugging
blueprints without hard-coding domains into the runtime.

- Add a blueprint only with an end-to-end acceptance test and required skills.
- Introduce fan-out/DAG scheduling only when a blueprint requires independent
  parallel branches; retain ordered steps until then.
- Treat repair as an explicit skill only when it has behavior distinct from the
  existing error-only retry and Router escalation loop.

Exit: each new workflow proves a missing runtime capability rather than merely
adding taxonomy.

## Suggested delivery slices

1. **Documentation truth + compiler runtime** — Phases 0–1.
2. **Capability SDK core** — typed profiles, skill contracts, resolver request
   objects, built-in migration (Phases 2–3).
3. **Policy and artifact hardening** — Phases 4–5.
4. **Operational feedback loop** — events, cost, per-capability history
   (Phase 6).
5. **Session experiment** — isolated and reversible (Phase 7).
6. **Workflow expansion** — only after SDK consumers exercise the seams
   (Phase 8).

Each slice should preserve CLI and MCP behavior, include migration adapters for
public TypeScript imports for one release, and land with typecheck plus focused
unit, contract, and end-to-end tests.

## Explicit non-goals

- No repository-wide directory move.
- No `Agent` class that absorbs Worker, Harness, resolver, and session roles.
- No daemon or distributed scheduler until a real harness requires one.
- No universal plugin registry for modules with only one implementation.
- No session persistence enabled by default.
- No scoring terms without normalized units and tests showing their effect.

## Immediate next milestone

Start with Phases 0 and 1. They repair a known documentation/runtime mismatch,
create a real compiler seam with three existing adapters, and do not alter
selection or execution semantics. That gives the later Capability SDK a stable
place to plug in while keeping the current tested kernel intact.
