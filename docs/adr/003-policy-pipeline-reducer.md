## ADR-003: Policy Pipeline as Sequential Reducer with Early Exit

**Status:** Accepted

**Context:**
Multiple policies (MaxIterations, Budget, Retry, Router) must evaluate each event and decide the next action. A consensus model would be ambiguous (what if Retry and Router disagree?). A two-phase model forces policies into rigid categories.

**Decision:**
Policies are composed into a `PolicyPipeline` that iterates in strict canonical priority order (0: MaxIterations, 1: Budget, 2: Retry, 3: Router). Each policy receives `&mut ExecutionState` and may mutate it. The first policy to return anything other than `PolicyAction::Continue` wins; the pipeline short-circuits and returns that action to the kernel.

**Consequences:**
- **Positive:** Deterministic, conflict-free control flow. No tie-breaking logic required.
- **Positive:** State mutations flow naturally. RetryPolicy can set `hints.worker_override` before RouterPolicy runs, or prevent RouterPolicy from running entirely.
- **Positive:** Custom policies can be inserted at any priority level without breaking the model.
- **Negative:** Policy ordering is load-bearing. Incorrect ordering (e.g., Router before Retry) would produce bugs.
- **Mitigation:** The compiler enforces canonical ordering by well-known policy IDs.
