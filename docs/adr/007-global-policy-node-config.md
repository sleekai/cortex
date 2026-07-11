## ADR-007: Global Policy Pipeline with Node-Local Config Overrides

**Status:** Accepted

**Context:**
Policies need configuration (e.g., `max_attempts`, `max_usd`), but each node may need different parameters. Two models exist: a global pipeline with node-local parameter overrides, or a per-node pipeline.

**Decision:**
Use a single global `PolicyPipeline` constructed once by the CLI. Each `Node` carries `policies: Vec<PolicyBinding>`, where `PolicyBinding` contains `policy_id: String` and `config: serde_json::Value`. The compiler's Pass 4 (Bind Policies) merges blueprint-level defaults with node-level overrides. The `Policy::evaluate` signature gains a `node: &Node` parameter so policies can read their local config.

**Consequences:**
- **Positive:** Global state (`total_cost`, `attempts`, `visits`) is managed by one pipeline. A `BudgetPolicy` sees costs accumulated across all nodes.
- **Positive:** Canonical ordering is enforced once, not per-node.
- **Positive:** Memory overhead is minimal (one pipeline object, N config vectors).
- **Negative:** Policies must deserialize their config from `serde_json::Value` at evaluation time. This is mitigated by using well-typed config structs with `serde_json::from_value` and `unwrap_or_default`.
