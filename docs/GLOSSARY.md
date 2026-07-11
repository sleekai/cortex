# Cortex Glossary

This glossary defines the canonical terms used across the Cortex codebase,
ADRs, and documentation. Terms are organized by domain layer.

## Kernel (cortex-kernel)

**ExecutionGraph**
A strict, directed IR produced by the blueprint compiler. Contains `Node`s,
`Edge`s, and an entry point. The kernel walks this graph linearly; it knows
nothing about blueprints or authoring formats.
*See ADR-005 (Compile-Time Input Binding).*

**Node**
A single step in an `ExecutionGraph`. Carries a directive ID, input bindings,
and policy bindings. Does not contain control-flow logic — transitions are
encoded in `Edge`s.
*See ADR-005, ADR-007.*

**Edge**
A control-flow link between two nodes, optionally conditioned on artifact
labels or a default fallback. The kernel transitions when the policy pipeline
returns `PolicyAction::Transition(node_id)`.

**ExecutionState**
The kernel's dynamic state: `current_node`, `attempts: HashMap<NodeId, u32>`,
`artifacts: HashMap<NodeId, Vec<Artifact>>`, `status: ExecutionStatus`.
All mutable fields are managed by the `PolicyPipeline`, not the kernel.
*See ADR-004 (Kernel Purity).*

**Event**
A discriminated union emitted by the runtime and consumed by the policy
pipeline: `NodeSucceeded`, `NodeFailed`, `Timeout`, `BudgetExceeded`,
`UserInputReceived`. The kernel merely translates executor output into events.
*See ADR-008 (ExecutionResult and Cost Shape).*

## Policy (cortex-policy)

**PolicyPipeline**
A sequential chain of `Policy` implementations (MaxIterations, Budget, Retry,
Router) evaluated in canonical priority order. The first policy to return
something other than `PolicyAction::Continue` wins; the pipeline short-circuits.
*See ADR-003 (Policy Pipeline as Sequential Reducer).*

**PolicyAction**
The return value of a single policy evaluation: `Continue`, `Transition(NodeId)`,
`Halt`, `AwaitUser`. Determines the kernel's next mechanical step.

**PolicyBinding**
Per-node configuration for a named policy. A `Node`'s `policies` vector merges
blueprint-level defaults with node-level overrides.
*See ADR-007 (Global Policy Pipeline with Node-Local Config).*

## Runtime (cortex-runtime)

**DirectiveExecutor**
The single I/O seam between the kernel and the rest of the system. It hydrates
artifacts from the store, calls the directive's `prepare()` and `parse()`,
invokes the provider, and dehydrates results back to the store.
*See ADR-010 (Directive as Pure Stateless Transform).*

**Provider**
A stateful seam owning transport, authentication, session lifecycle, and
retry logic for a specific execution backend (CLI process, HTTP API, SDK).
Connects to one or more workers. Not to be confused with Worker (the
schedulable resource description).

**Session**
Conversation state, history, cache, and provider metadata for an active
execution context. Created and managed by the Provider.

**ArtifactStore**
An async, content-addressable, write-once-read-many (WORM) store keyed by
SHA-256 hash. The trait exposes `get(hash) -> Option<Vec<u8>>` and
`put(hash, body)`. The caller computes the hash.
*See ADR-009 (ArtifactStore as Async Content-Addressable WORM).*

## IR (cortex-types)

**Artifact**
A lightweight reference envelope passed through the kernel. Fields:
`id: Uuid` (instance identity), `kind: String` (e.g. `"cortex.plan.v1"`),
`body_hash: String` (SHA-256 of content), `label: Option<String>` (for
routing). Content is never carried by the kernel — only by `HydratedArtifact`
at the directive boundary.
*See ADR-002 (Artifact Dual Identity Model), ADR-006 (Label as Metadata).*

**HydratedArtifact**
The heavy counterpart used only at the Directive boundary: `{ descriptor: Artifact, body: Value }`.
The `DirectiveExecutor` hydrates before calling `Directive::prepare()` and
dehydrates after `Directive::parse()`.

**InputBinding**
A compile-time mapping from an upstream `NodeId` to a downstream node's
input slot, with an optional filter (`All`, `ByLabel(label)`, `ByIndex(i)`).
Resolved by the blueprint compiler, not the kernel.
*See ADR-005 (Compile-Time Input Binding).*

**ExecutionResult**
The output of a single node execution: `{ artifacts: Vec<Artifact>, cost: Cost, worker_id: String, duration: Duration }`.
Consumed by the kernel and forwarded as `Event::NodeSucceeded`.
*See ADR-008.*

**Cost**
Execution cost for a single node: `{ estimated_usd: f64, tokens_input: Option<u64>, tokens_output: Option<u64>, provider: Option<String> }`.
`estimated_usd` is mandatory for budget policy; remaining fields are optional
observability metadata.

## Worker & Dispatch

**Worker**
An execution provider described as data (capabilities, cost profile, speed
tiers, write access). Immutable and schedulable. Only the capability resolver
and directive executor reference workers by ID. The kernel never sees a worker.

**WorkerSpec**
The struct describing a worker. Placeholder term; eventual rename to
`TargetSpec` or `BackendSpec` to reflect that workers are targets, not agents.

**Capability**
A string-literal vocabulary entry (e.g., `"coding"`, `"reasoning"`,
`"review"`) naming what a task needs and what a worker offers. The capability
resolver matches the two.

## Blueprint (cortex-blueprint)

**BlueprintAst**
The human-facing authoring format (YAML). Contains high-level workflow
constructs (steps, conditions, sub-blueprints). Compiled to an `ExecutionGraph`.
Not imported by the kernel.
*See ADR-005.*

**ExecutionGraph** *(defined under Kernel above — this is the compiled output)*

**ForkDirective / JoinDirective**
Directives that encapsulate parallelism. Fork splits one artifact into N
sub-work items; join merges N results into one. The kernel walks past these
nodes linearly — the executor handles concurrent provider calls internally.

## Observability

**Trace**
A full execution record built by `cortex-runtime` from kernel-emitted events.
Contains node timings, cost breakdowns, worker assignments, and artifact
provenance. Not part of the kernel's IR — `ExecutionState` is the kernel's
only state.

## Historical (legacy, do not use in new code)

| Deprecated term | Replaced by |
|---|---|
| Skill | Directive |
| Blueprint (old) | BlueprintAst + ExecutionGraph |
| CUEA loop | Blueprint pattern (using directives) |
| Producer | Directive.prepare() |
| Evaluator | Directive.parse() + Policy |
| Router | RouterPolicy |
| Harness | Provider |
| CUEA | *removed* |
