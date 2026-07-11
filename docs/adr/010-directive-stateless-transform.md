## ADR-010: Directive as Pure Stateless Transform

**Status:** Accepted

**Context:**
Directives translate artifacts to/from provider requests. They could be stateful (holding provider clients, caches, etc.) or stateless (pure functions over data).

**Decision:**
Directives are **stateless** and perform **no I/O**. They implement `Directive::prepare()` (artifacts -> execution request) and `Directive::parse()` (execution response -> parsed outputs). All I/O (provider calls, storage access) is handled by the `DirectiveExecutor` in `cortex-runtime`. Directives are registered by string ID (`"cortex.plan.v1"`) in a `HashMap` held by the runtime.

**Consequences:**
- **Positive:** Directives are trivially unit-testable. They are pure functions over JSON values.
- **Positive:** The kernel and runtime do not need to know directive internals. They only need the `Directive` trait seam.
- **Positive:** New directives can be added without modifying the kernel, runtime, or types crates.
- **Negative:** The `DirectiveExecutor` must handle all hydration, dehydration, and provider routing. This centralizes I/O complexity in the runtime.
- **Mitigation:** This is the intended design. The runtime is the I/O boundary; directives are the logic boundary.
