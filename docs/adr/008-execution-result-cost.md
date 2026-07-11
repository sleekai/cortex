## ADR-008: ExecutionResult and Cost Shape

**Status:** Accepted

**Context:**
The `ExecutionResult` returned by the executor and the `Event::NodeSucceeded` variant needed definition. A node-level `label` field was originally present but became redundant once `Artifact` carried labels.

**Decision:**
- Remove `label` from `ExecutionResult` and `Event::NodeSucceeded`. Routing is purely artifact-driven.
- `ExecutionResult` contains: `artifacts: Vec<Artifact>`, `cost: Cost`, `worker_id: String`, `duration: Duration`.
- `Cost` contains: `estimated_usd: f64` (mandatory, used by `BudgetPolicy`), `tokens_input: Option<u64>`, `tokens_output: Option<u64>`, `provider: Option<String>` (optional, for observability).
- `Event::NodeSucceeded` passes `artifacts`, `cost`, `worker_id`, and `duration` to the policy pipeline.

**Consequences:**
- **Positive:** Single source of truth for routing labels (the `Artifact` struct). No conflicting node-level label.
- **Positive:** `BudgetPolicy` only needs `estimated_usd`. Optional fields allow providers to report telemetry without forcing all directives to populate them.
- **Positive:** Observability metadata (`worker_id`, `duration`) flows through the event log for tracing and debugging.
- **Negative:** `Cost` requires all providers to at least estimate USD cost. This is accepted as a baseline requirement for budget-aware execution.
