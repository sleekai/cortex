# Cortex Rust Refactor Plan

## Status

- **ADRs complete**: 10 Architecture Decision Records written (`docs/adr/001-*` through `010-*`)
- **Old ADRs**: `0001` and `0002` (TS-era) deleted; decisions superseded by new ADRs
- **Glossary**: migrated from `CONTEXT.md` to `docs/GLOSSARY.md` with new terminology
- **Implementation**: all crates are stubs; `cortex-types` is the only functional crate

## Architecture

```
                    ┌─────────────┐
                    │ cortex-cli  │  Composition root — wires trait objects
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
   ┌─────────────────┐ ┌──────┐ ┌──────────┐
   │ cortex-blueprint│ │ ... │ │cortex-dir.│
   │  (BlueprintAst  │ │     │ │(Directive)│
   │   → ExecGraph)  │ │     │ │           │
   └─────────────────┘ └──────┘ └──────────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┴────────────┐
              │      cortex-kernel       │  Pure reducer loop
              │      cortex-policy       │  PolicyPipeline
              │      cortex-runtime      │  DirectiveExecutor + Provider + Store
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              │      cortex-types        │  IR: Artifact, Node, Edge, ExecutionGraph,
              │                         │  ExecutionState, Event, Cost, Policy trait
              └──────────────────────────┘
```

Star topology: all leaf crates depend only on `cortex-types`. No leaf-to-leaf
dependencies. The CLI is the sole composition root.
*See ADR-001 (Star Topology).*

## Roadmap (Theme-Focused)

### Theme 1: Data Plane

**Crates:** `cortex-types`, `cortex-runtime`

Goal: define the kernel's IR and the storage layer.

- `cortex-types`: Artifact (dual identity), Node, Edge, ExecutionGraph,
  ExecutionState, Event, Cost, Policy trait, Decision, InputBinding
- `cortex-runtime`: ArtifactStore trait (async WORM, content-addressable),
  DirectiveExecutor trait, Cost tracking
- Reference ADRs: 002, 005, 006, 008, 009

### Theme 2: Policy Engine

**Crates:** `cortex-policy`

Goal: composable policy pipeline with deterministic conflict resolution.

- PolicyPipeline with canonical priority ordering
- Concrete policies: MaxIterationsPolicy, BudgetPolicy, RetryPolicy, RouterPolicy
- PolicyAction enum (Continue, Transition, Halt, AwaitUser)
- Per-node PolicyBinding with config overrides
- Reference ADRs: 003, 004, 007

### Theme 3: Execution Loop

**Crates:** `cortex-kernel`, `cortex-directives`

Goal: the kernel reducer loop and the first directive implementations.

- Kernel loop: execute node → translate to Event → feed PolicyPipeline → apply action
- Directive trait (prepare + parse, stateless)
- Built-in directives: Plan, Review, Fork, Join, Produce
- Reference ADRs: 004, 010

### Theme 4: Blueprint Compiler

**Crates:** `cortex-blueprint`

Goal: human-friendly authoring format compiled to ExecutionGraph.

- BlueprintAst (YAML schema)
- Compiler passes: Normalize → Resolve Inputs → Bind Policies → Validate
- Sub-blueprint expansion
- Reference ADRs: 005, 007

### Theme 5: Ingress

**Crates:** `cortex-cli`

Goal: CLI surface that wires the full system together.

- `cortex execute <task>` — compile intent, run kernel, output artifacts
- `cortex plan <task>` — print dispatch plan without executing
- `cortex workers` — list registered workers with capabilities
- Intent compiler: user text → IntentArtifact → blueprint resolution
- Reference ADRs: 001

## Non-goals

- No daemon or long-lived scheduler (stateless per-invocation model)
- No session persistence (deferred until real provider seam exists)
- No plugin SDK (deferred until all core crate seams are stable)
- No MCP server in Rust (delegated to existing TypeScript wrapper)
- No WASM or dynamic loading of directives (static registration only)
