# Cortex — AI Compute Operating System

A harness-agnostic, policy-driven execution kernel: it decides what executes,
where, with how much context, at what spend. Models, CLIs, and HTTP APIs are
plugins; Cortex is the operating system.

```bash
cargo build --release
cortex execute blueprint.json   # Compile + execute a blueprint
cortex plan blueprint.json      # Print dispatch plan, zero execution
```

## What is Cortex?

Cortex is a **pure reducer loop** that walks an `ExecutionGraph` node by node.
For each node it delegates to a `DirectiveExecutor` (the I/O seam), translates
the result into an `Event`, and feeds it to a `PolicyPipeline` that decides the
next transition — continue, move to another node, halt, or await user input.

The kernel knows nothing about LLMs, transport protocols, or artifact schemas.

## Architecture

```
BlueprintAst (JSON/YAML)
  │
  ▼
Blueprint Compiler  ──►  ExecutionGraph
                               │
                         KernelInterpreter  ──►  DirectiveExecutor  ──►  Provider
                          │       │                                       │
                          │       ▼                                       ▼
                          │   Event                                  Worker / API
                          │       │
                          ▼       ▼
                      PolicyPipeline
                     (MaxIterations → Budget → Retry → Router)
```

## Design principles

- **Kernel purity**: the kernel never mutates policy-managed state, performs
  I/O, or interprets domain concepts — it is a mechanical loop.
- **Star topology**: all functional crates depend only on `cortex-types`.
  `cortex-cli` is the sole composition root wiring trait objects together.
  *See ADR-001.*
- **Artifacts as references**: the kernel passes lightweight `Artifact`
  envelopes (ID, kind URI, content hash). Content lives in a
  content-addressable WORM store (SHA-256).
  *See ADR-002, ADR-009.*
- **Directives as stateless transforms**: directives are pure functions over
  JSON values — `prepare()` builds execution requests, `parse()` transforms
  responses. All I/O lives in the runtime. *See ADR-010.*

## Project structure (Rust workspace)

| Crate | Role |
|---|---|
| `cortex-types` | IR types (Artifact, Node, Edge, ExecutionGraph, Event, Cost) and all traits (Directive, Policy, ArtifactStore, DirectiveExecutor) |
| `cortex-kernel` | Pure reducer loop — `KernelInterpreter::run()` |
| `cortex-policy` | `PolicyPipeline` with MaxIterations, Budget, Retry, Router policies |
| `cortex-blueprint` | `BlueprintAst` schema → `ExecutionGraph` compiler |
| `cortex-directives` | `Directive` trait implementations (PlanDirective) |
| `cortex-runtime` | I/O seam — `CortexExecutor`, `InMemoryStore`, `Provider` trait |
| `cortex-cli` | Composition root — `execute` and `plan` commands |
| `cortex-store` | Store abstractions (stub) |
| `cortex-adapters` | Adapter crate (stub) |
| `cortex-registry` | Registry crate (stub) |

All leaf crates depend only on `cortex-types`. No leaf-to-leaf dependencies.

## Commands

| Command | Description |
|---|---|
| `cortex execute <blueprint.json>` | Compile BlueprintAst → ExecutionGraph, run the kernel loop, print final status and cost |
| `cortex plan <blueprint.json>` | Compile and print the dispatch plan without executing |

## Build & run

```bash
cargo build --release
cargo run --release -- execute path/to/blueprint.json
cargo run --release -- plan path/to/blueprint.json
```

The blueprint input is a `BlueprintAst` JSON file describing nodes, edges, and
directive bindings. See `cortex-blueprint/src/ast.rs` for the schema.

## Key concepts

- **ExecutionGraph** — directed IR of `Node`s and `Edge`s, compiled from a
  `BlueprintAst`. The kernel walks this graph linearly.
- **KernelInterpreter** — the pure reducer loop. For each node: execute →
  translate to Event → feed PolicyPipeline → apply PolicyAction.
- **PolicyPipeline** — sequential chain of policies. The first to return
  something other than `Continue` wins (short-circuit).
- **DirectiveExecutor** — the single I/O seam. Hydrates artifacts from store,
  calls `Directive::prepare()` and `Directive::parse()`, invokes Provider,
  dehydrates results.
- **Provider** — owns transport and session lifecycle for an execution backend.
- **ArtifactStore** — async content-addressable WORM store (SHA-256 keyed).

## Implementation status

| Area | Status |
|---|---|
| `cortex-types` | All IR types, traits, capabilities, schemas, validation — fully implemented |
| `cortex-kernel` | KernelInterpreter reducer loop — implemented |
| `cortex-policy` | PolicyPipeline + 4 concrete policies — implemented |
| `cortex-blueprint` | BlueprintAst schema + compiler — implemented |
| `cortex-directives` | PlanDirective — stub (only one directive) |
| `cortex-runtime` | CortexExecutor, InMemoryStore, Provider trait — partially implemented |
| `cortex-cli` | `execute` and `plan` commands — implemented |
| Other crates | Stubs (cortex-store, cortex-adapters, cortex-registry) |

See [PLAN.md](./PLAN.md) for the full roadmap.

## Documentation

- [docs/GLOSSARY.md](./docs/GLOSSARY.md) — canonical terms
- [docs/adr/](./docs/adr/) — 10 architecture decision records
- [CONTEXT.md](./CONTEXT.md) — overview and design principles

## License

MPL-2.0
