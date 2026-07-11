# Cortex

A harness-agnostic, policy-driven execution kernel: it decides what executes,
where, with how much context, at what spend. Models, CLIs, and HTTP APIs are
plugins; Cortex is the operating system.

The kernel is a pure, linear reducer — it walks an `ExecutionGraph` node by
node, delegates execution to a `DirectiveExecutor`, and applies a
`PolicyPipeline` to decide the next transition. The kernel knows nothing
about LLMs, transport protocols, or artifact schemas.

## Design principles

- **Kernel purity**: the kernel does not mutate policy-managed state, perform
  I/O, or interpret domain concepts. It is a mechanical loop.
- **Star topology**: all functional crates depend only on `cortex-types`.
  `cortex-cli` is the sole composition root wiring trait objects together.
- **Artifacts as references**: the kernel passes lightweight `Artifact`
  envelopes (ID, kind URI, content hash). Content is fetched and stored by
  the runtime via a content-addressable store.
- **Directives as stateless transforms**: directives are pure functions over
  JSON values — they prepare execution requests and parse responses. All I/O
  lives in the runtime.

## Glossary

The project glossary lives in `docs/GLOSSARY.md`. Key ADRs are in `docs/adr/`.
