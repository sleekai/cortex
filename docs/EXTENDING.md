# Extending Cortex — Skills, Blueprints, Policies

Cortex is plugin-first: the kernel only orchestrates; business logic lives in
plugins registered through seams. This guide documents every extension point
the MVP exposes and the execution lifecycle that connects them.

```
Ingress adapter → Triage (a Skill) → Blueprint → [Skill steps | produce steps]
                                                        │
                                        produce = CUEA loop (Producer →
                                        Evaluator → Router) under Policies,
                                        with context-on-demand
                                                        │
                                     Artifacts → Egress renderer → harness
```

Every seam is a `Map`-backed registry with the same shape: `register*()`,
`get*()`, `registered*()`, and a `clear*()` test hook. Registering is a
side-effect import — ship a module that calls `register*` at load time.

| Extension point | Module | Register with |
|---|---|---|
| Execution skill | `src/skill/registry.ts` | `registerSkill(skill)` |
| Blueprint | `src/blueprint/blueprint.ts` | `registerBlueprint(bp)` |
| Policy set | `src/policy/policies.ts` | `registerPolicySet(set)` |
| Triage (CTS) stage | `src/triage/registry.ts` | `registerSkill(stage)` (type `TriageStage`) |
| Ingress adapter | `src/ingress/ingress.ts` | `registerAdapter(adapter)` |
| Egress renderer | `src/egress/egress.ts` | `registerRenderer(kind, fn)` |
| Worker | `.cortex/workers.json` overlay | JSON, no code |
| Harness | `src/harness/harness.ts` | `registerHarnessFactory(kind, fn)` |
| Evaluator | `loop/loop-engine.ts` options | `{ evaluator }` per run |
| Compiler service | `src/compiler/runtime.ts` | `setCompilerRuntime(partial)` |

## Skill API (`src/skill/skill.ts`)

The primitive execution unit. Everything that performs reasoning — triage,
grilling, summarization, review, planning — is a Skill. Skills never
escalate, retry, fetch context, or terminate execution; they emit structured
observations and the runner + policies decide what happens next.

```ts
import { type Skill, observation } from '@sleekai/cortex/skill/skill'
import { registerSkill } from '@sleekai/cortex/skill/registry'

const docSkill: Skill = {
  name: 'docs',
  purpose: 'Draft documentation for the produced change.',
  meta: { capabilities: ['docs'], costLevel: 'low', deterministic: false },

  // Cheap, side-effect-free: should this skill run given the context?
  applicable: (ctx) => ctx.dispatch !== undefined,

  async execute(ctx) {
    // ctx.blackboard      — outputs of upstream skills, keyed by skill name
    // ctx.artifacts       — artifacts accumulated this run (read-only)
    // ctx.policies        — the merged PolicySet in force
    // ctx.dispatch        — LLM seam: (packet, chunks) => Promise<Artifact>
    const artifact = await ctx.dispatch!(myPacket(ctx), [])
    return {
      artifacts: [artifact],
      observations: observation({
        confidence: 0.8,
        missingContext: [],          // needs, not requests (MVP §6)
        recommendedAction: 'proceed', // proceed | clarify | escalate | stop
      }),
      data: { summaryLength: 120 },   // lands on blackboard['docs']
    }
  },
}
registerSkill(docSkill)
```

Contract:

- `applicable()` gates the skill; a blueprint step's `when` condition gates it
  again from outside. Both must pass.
- `recommendedAction` is a recommendation. `'clarify'` halts the run **only**
  if the clarification policy is in `'halt'` mode *and* the skill emitted a
  `clarification` artifact. `'stop'` ends the blueprint unaccepted.
- `data` is merged into the shared blackboard under the skill's name — the
  composition mechanism between skills.
- CTS stages (`src/triage/skill.ts`: `TriageStage`) are a different, narrower
  contract: they are *stages inside* the triage pipeline. The whole triage
  pipeline is one execution Skill here.

## Blueprint API (`src/blueprint/blueprint.ts`)

Blueprints describe reusable workflows as data. The runtime executes them and
knows nothing about debugging, reviewing, or planning.

```ts
import { registerBlueprint } from '@sleekai/cortex/blueprint/blueprint'

registerBlueprint({
  name: 'docs-flow',
  description: 'Produce a change, then document it.',
  steps: [
    { id: 'triage', kind: 'skill', skill: 'triage' },
    { id: 'grill', kind: 'skill', skill: 'grilling' },
    { id: 'produce', kind: 'produce' },                 // the CUEA loop
    { id: 'docs', kind: 'skill', skill: 'docs',
      when: (view) => view.artifacts.some(a => a.kind === 'patch') },
  ],
  // Optional per-blueprint policy overrides, merged over the run's set.
  policies: { retry: { name: 'docs-retry', maxIterations: 4 } },
})
```

- `kind: 'skill'` runs a registered skill (if applicable).
- `kind: 'produce'` delegates to the kernel-wired CUEA closed loop
  (Producer → Evaluator → Router) — retry, escalation, convergence, and
  context-on-demand all live there, bounded by policy.
- `when(view)` sees `{ blackboard, artifacts }` and gates the step.
- Naming an unregistered skill throws — wiring errors fail loud.

Blueprint selection: the triage skill recommends one
(`skill/builtins.ts:recommendBlueprint`); `--blueprint`/`blueprint` argument
overrides; unknown names fall back to `default`.

## Policy API (`src/policy/policies.ts`)

Policies are first-class runtime objects; the runtime asks them for decisions.
A `PolicySet` bundles six:

| Policy | Decides |
|---|---|
| `retry` | max same-tier iterations of the loop |
| `escalation` | max ladder depth the Router may climb |
| `clarification` | when ambiguity justifies asking (`shouldClarify`), and whether to halt or proceed |
| `context` | whether/how often mid-loop context fetches happen (`shouldFetch`) |
| `budget` | run-wide cost ceiling + input token cap |
| `timeout` | worker invocation timeout |

Built-in sets: `default`, `strict`, `generous`. Register your own:

```ts
import { registerPolicySet, DEFAULT_POLICIES } from '@sleekai/cortex/policy/policies'

registerPolicySet({
  ...DEFAULT_POLICIES,
  name: 'ci',
  clarification: { name: 'ci-clar', ambiguityThreshold: 0.3, mode: 'proceed',
    shouldClarify(s) { return s <= this.ambiguityThreshold } },
  retry: { name: 'ci-retry', maxIterations: 3 },
})
```

Router bounds are a projection of the policy set (`boundsFromPolicies`) —
the Router itself stays pure and policy-free. `capability/policy.ts` (worker
deny-lists, write access) is a separate, complementary layer: it defines the
*feasible worker set*; spend gates live in `core/types.ts` `BudgetConfig` and
the `PolicySet.budget` policy.

## Compiler Runtime (`src/compiler/runtime.ts`)

Three compiler services behind one replaceable facade:

- **Intent Compiler** — task text → `TaskIntent` (deterministic rules today)
- **Context Compiler** — goal + intent → minimal `CompiledContext` (L0–L4)
- **Artifact Compiler** — raw worker output → typed `Artifact` (parse-once)

`setCompilerRuntime({ intent: myLlmClassifier })` swaps any service without
touching callers; it returns a restore function.

## Execution lifecycle (`kernel.runBlueprint`)

1. **Ingress** — the surface (CLI `cortex exec`, MCP `cortex_exec`) normalizes
   raw input into a UCP packet with source metadata.
2. **Triage** — the kernel pre-runs the `triage` skill (deterministic, zero
   model calls): CTS pipeline → intent → blueprint + tier recommendation. Its
   output seeds the blackboard, so the blueprint's own triage step skips.
3. **Blueprint selection** — explicit name, else triage's recommendation,
   else `default`. The blueprint's policy overrides merge over the run's set.
4. **Steps** — the runner walks the step list: skills conditionally
   (`when` + `applicable`), each contributing artifacts + blackboard data.
   A `clarify` recommendation under a halt-mode policy stops the run and
   returns questions to the harness (exit code 2 on the CLI).
5. **Produce** — `prepareDispatch` (intent → plan → context → packet →
   budget) then the CUEA loop: the cheapest capable worker attempts first
   (MVP §4); the Evaluator judges; the Router retries / escalates / finishes
   under policy bounds. Evaluations naming `missingContext` trigger the
   context provider — the context policy decides whether the fetch happens,
    the `ContextService` (`loop/context-service.ts`) decides — the context
    policy gates the fetch, the Context Compiler finds minimal context.
6. **Persistence + egress** — artifacts land in `.cortex/artifacts/<task>/`,
   state and metrics update, and the surface renders the outcome through the
   egress layer.

Tier-0 note: `locate`-shaped intents short-circuit inside produce with a
pointer-set artifact — zero model calls end to end.

## Worker & harness plugins (unchanged, for completeness)

Workers are JSON (`.cortex/workers.json` overlay; `cortex add-worker`);
harness kinds (`cli`, `http`) are code-registered factories. See
`docs/ARCHITECTURE.md` §Worker registry / §Harness layer.
