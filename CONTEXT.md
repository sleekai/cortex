# Cortex

A harness-agnostic, policy-driven execution kernel: it decides what executes,
where, with how much context, at what spend. Models, CLIs, and HTTP APIs are
plugins; Cortex is the operating system.

## Language

### Execution

**Skill**:
The primitive execution unit — a named, registered capability (triage,
grilling, summarize, review) that a Blueprint step invokes. Skills emit
artifacts and observations; they never escalate, retry, fetch context, or
terminate execution.
_Avoid_: stage (that's triage), tool, action

**Blueprint**:
A workflow described as data — an ordered list of steps (skills run
conditionally; a produce step runs the CUEA loop). The runtime interprets
blueprints; it knows nothing about debugging or reviewing.
_Avoid_: workflow, pipeline, plan

**CUEA loop**:
The closed execution loop (Cortex Unified Execution Architecture): a
Producer → Evaluator → Router cycle that refines, escalates, or terminates
on evaluation feedback under explicit bounds.
_Avoid_: validation loop (the removed fixed-iteration predecessor)

**Producer**:
The loop seam that dispatches exactly one ladder rung per iteration and
returns an artifact. Never walks the ladder itself.

**Evaluator**:
A pure function from a produced artifact (plus validation evidence) to a
decision — ACCEPT, RETRY, ESCALATE, or FINISH — with confidence and issues.
Evaluators observe; they never modify execution state.
_Avoid_: judge, validator

**Router**:
The only component that continues the CUEA loop. A pure function from
(execution state, evaluation) to the next action, enforcing all bounds and
convergence guarantees.
_Avoid_: scheduler, controller

### Planning

**Capability**:
A closed string-literal vocabulary entry (coding, reasoning, review, …)
naming what a task needs and what a Worker offers. The planner matches the
two; nothing references concrete workers.

**Intent**:
The deterministic, structured parse of a request (task type, complexity,
capabilities, budgets, confidence). The planner never sees raw user text —
only intent.
_Avoid_: request, prompt

**Ladder**:
The ordered escalation sequence of feasible workers for an intent — tier 0
deterministic → tier 1 small → tier 2 mid → tier 3 premium. Entry point
comes from complexity; only the Router climbs it.
_Avoid_: fallback chain

**PlannerConstraints**:
Hard gates the planner may never trade away — worker deny-lists, write-access
enforcement, context-window fit. A cheaper worker that violates constraints
is not a candidate; it is excluded.
_Avoid_: policy (that's PolicySet)

**PolicySet**:
The first-class execution-lifecycle policy object: retry, escalation,
clarification, context, budget, timeout. Router bounds are a projection of a
policy set. The sole owner of the word "policy".
_Avoid_: config, settings

### Triage

**TriageStage**:
A deterministic, stateless stage inside the CTS triage pipeline (normalize,
ambiguity, routing), each patching one slice of the CTS packet. Never called
a skill — the whole triage pipeline is itself wrapped as one Skill.
_Avoid_: skill (reserved for the execution unit), filter

**CTS packet**:
Triage's output grammar: the normalized task, ambiguity signals, and a
worker-tier hint. Every field has a downstream reader.

### Workers & dispatch

**Worker**:
An execution provider described as data (a WorkerSpec: capabilities, cost,
speed, tiers, write access) — never privileged code. Workers consume packets
and produce output; they never control execution, escalate, or fetch context.
_Avoid_: agent, model (a model is one kind of worker backend)

**Harness**:
The seam through which a worker executes — CLI process, HTTP endpoint, or a
future protocol — registered as a factory by kind. Planning never knows how
a worker runs.
_Avoid_: adapter, driver, backend

**UCP** (Ultra-Compact Packet):
The versioned wire grammar for everything sent to a worker — single-letter
keys, pointers-never-paste, `act: work | ask | review` dialects.
_Avoid_: prompt, message

**Judgment packet**:
A UCP with `act: ask` or `act: review` — a question or review request on the
judgment channel, answered with a decision or review artifact.

**Artifact**:
The only currency of the system: a typed, discriminated record (patch, plan,
decision, review, failure, clarification, …) parsed exactly once at the
harness boundary. Everything persisted is an artifact.
_Avoid_: result, output, response

### Context

**Context level (L0–L4)**:
The progressive context ladder — L0 file names → L1 symbols → L2 signatures
→ L3 ranked chunks → L4 full source of top files. Escalation climbs one
level at a time, only with budget headroom, never silently.

**Context-on-demand**:
Mid-loop context acquisition: an Evaluator names missing context, a
policy-gated ContextService fetches the minimal addition.
_Avoid_: eager loading, context stuffing
