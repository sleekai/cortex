## ADR-004: Kernel Purity — Policies Own State Mutations

**Status:** Accepted

**Context:**
The kernel loop is described as a "pure reducer" that translates executor results into events and applies policy actions. If the kernel mutates policy-managed fields (visits, attempts, cost), it becomes a stateful bookkeeper and the boundary between kernel and policy blurs.

**Decision:**
The kernel performs **zero** mutations to policy-managed fields. It only:
1. Executes the node and translates the result into an `Event`.
2. Calls `policy.evaluate(&mut state, &event, node)`.
3. Applies the structural action returned by the policy (`Transition`, `Halt`, `AwaitUser`).

All counter increments (`visits`, `attempts`, `total_cost`) are performed by the `PolicyPipeline`. Cycle safety is guaranteed by the **compiler** (Pass 4: Bind Policies), which injects default `MaxIterationsPolicy` and `BudgetPolicy` if the blueprint contains cycles and the user omitted safety policies.

**Consequences:**
- **Positive:** The kernel is a pure mechanical loop. It can be unit-tested with mock executor and mock policy without any policy logic.
- **Positive:** Policies are self-contained. A custom policy can introduce new counters or hints without kernel changes.
- **Negative:** If a user manually constructs a cyclic graph and omits all safety policies, the kernel will spin forever. This is accepted as correct behavior for a pure engine.
- **Mitigation:** The blueprint compiler injects default safety policies for cyclic graphs, making infinite loops a user-opt-in scenario only.
