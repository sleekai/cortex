## ADR-002: Artifact Dual Identity Model (UUID + Content Hash)

**Status:** Accepted

**Context:**
Artifacts need two distinct identifiers: one for storage/deduplication (content identity) and one for execution tracing (instance identity). Using only one identifier creates either memory bloat (passing content by value) or loss of provenance (cannot distinguish two identical productions).

**Decision:**
The `Artifact` struct carries both `id: Uuid` (instance identity) and `body_hash: String` (content identity). The `ArtifactStore` is keyed strictly by `body_hash`. The kernel passes `Artifact` envelopes (lightweight) between nodes, while heavy content is fetched by hash only during hydration.

**Consequences:**
- **Positive:** Automatic deduplication via content-addressable storage. Identical outputs from different nodes share one store entry.
- **Positive:** Precise provenance tracking. The event log and execution state can trace exactly which node produced which artifact instance, even when content is identical.
- **Positive:** The `Artifact` envelope remains lightweight (~80 bytes) and safe to clone by value.
- **Negative:** Slightly more complex than a single identifier. Requires both fields to be populated correctly.
