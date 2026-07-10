# ADR-0001: Defer DAG execution until a consumer exists

Date: 2026-07-05
Status: accepted

## Context

`worker/dispatch.ts` shipped a full DAG executor (`executePlan`: parallel
fan-in, per-node retry, `resumeFrom` replay, `onNodeComplete` checkpointing,
`AbortSignal` cancellation) plus a paired checkpoint store
(`state/store.ts`: `saveRunCheckpoint`/`loadRunCheckpoint`). No production
path ever called it — every entry point reaches `dispatchOne`. Only tests
exercised the machinery. AUDIT.md §2 graded it "keep" on build quality
without checking reachability.

The Cortex vision ("future parallel branches, DAG execution, cyclic graphs
without redesign") is satisfied by the seams that remain — the loop engine's
Producer seam and `dispatchOne` — not by shipping a dormant scheduler. A
zero-adapter seam is speculation: it constrains refactors (three dead options
on `DispatchOptions`), pins behaviour nobody observes, and its known gaps
(no true mid-call abort) would likely not survive contact with a real
fan-out consumer anyway.

## Decision

Delete `executePlan`, `DispatchPlan`, `DispatchNode`, the
`resumeFrom`/`onNodeComplete`/`signal` options, and the run-checkpoint store
functions, together with their tests.

## Consequences

- Dispatch interface shrinks to what production uses (`dispatchOne` + ladder).
- Future DAG/parallel execution is rebuilt against its first real consumer's
  requirements; the deleted implementation is recoverable from git history
  (pre-2026-07 `dev`, commit d9c6ba9 era) as a reference.
- Architecture reviews should not re-suggest "wire up the DAG executor" —
  the removal is deliberate, not an oversight.
