## ADR-001: Star Topology with Zero Leaf-to-Leaf Dependencies

**Status:** Accepted

**Context:**
The Cortex system is decomposed into 7 crates. Without a strict topology constraint, leaf crates would inevitably import each other for convenience, creating a tangled dependency graph that undermines modularity and testability.

**Decision:**
Enforce a strict star topology. `cortex-types` is the sole center. All functional crates (`cortex-kernel`, `cortex-policy`, `cortex-directives`, `cortex-runtime`, `cortex-blueprint`) are leaves that must not depend on each other. `cortex-cli` is the exclusive composition root that wires all crates together via trait objects (`Box<dyn Trait>`, `Arc<dyn Trait>`).

**Consequences:**
- **Positive:** Enforces trait-based design at every boundary. Prevents monolithic coupling. Makes each leaf crate independently testable with mocks.
- **Positive:** `cortex-cli` becomes the single source of truth for system composition, making the wiring explicit and inspectable.
- **Negative:** Requires defining all trait seams in `cortex-types` upfront. Any missing seam forces a center-crate change rather than a leaf-to-leaf edge.
- **Resolution of Temptations:**
  - Blueprint compiler needing directive schemas: resolved via `DirectiveMetadataProvider` trait in `cortex-types`, implemented by CLI.
  - Runtime needing concrete directives: resolved via `HashMap<String, Box<dyn Directive>>` registered by CLI at startup.
  - Shared utilities: resolved via a separate inert `cortex-utils` leaf crate if needed; `cortex-types` remains strictly domain definitions.
