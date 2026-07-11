## ADR-005: Compile-Time Input Binding (Separate Data Flow from Control Flow)

**Status:** Accepted

**Context:**
The kernel must resolve which artifacts to pass to a node before execution. Two models exist: runtime gather (traverse incoming edges dynamically) or compile-time binding (pre-resolve upstream outputs into node-local input bindings).

**Decision:**
Use compile-time binding. Each `Node` carries `inputs: Vec<InputBinding>`, where `InputBinding` specifies `source_node: NodeId` and a filter (`All`, `ByLabel`, `ByIndex`). The compiler's Pass 3 (Resolve Inputs) maps upstream outputs to downstream inputs. `Edge` structs encode only control flow (when to transition); `Node.inputs` encodes only data flow (what to pass).

**Consequences:**
- **Positive:** The kernel resolves inputs via flat lookup—no graph traversal at runtime.
- **Positive:** Directives receive inputs in a deterministic order matching their declared schema. No directive-side filtering required.
- **Positive:** Data flow is explicit in the IR, making the graph inspectable and debuggable without execution.
- **Negative:** The compiler must perform full topological resolution. Dynamic data flow (e.g., conditional outputs that change shape) must be handled via graph patterns rather than runtime discovery.
