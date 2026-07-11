## ADR-006: Label as Instance Metadata on Artifact

**Status:** Accepted

**Context:**
`ParsedOutput` carries an optional semantic label (e.g., `"refine"`, `"accept"`) used for routing via `EdgeCondition::OnLabel`. The `Artifact` struct originally had no label field, making it impossible for the kernel or `RouterPolicy` to know which label produced which artifact after storage.

**Decision:**
Add `label: Option<String>` to the `Artifact` struct. The label is instance metadata (like `id: Uuid`), not content identity (like `body_hash`). It travels with the artifact through the graph and is used by `InputFilter::ByLabel` and `EdgeCondition::OnLabel`.

**Consequences:**
- **Positive:** Multi-output directives can produce artifacts with different labels. A `ReviewDirective` can emit a `"patch"` artifact and a `"needs_refinement"` artifact simultaneously.
- **Positive:** `RouterPolicy` scans `event.artifacts` (or `state.artifacts[current_node]`) and matches labels against outgoing edges. Routing is purely data-driven.
- **Positive:** `InputFilter::ByLabel` filters artifacts by their own label field without requiring state-side tuple tracking.
- **Negative:** The `Artifact` envelope grows slightly. This is accepted as the label is essential for routing semantics.
