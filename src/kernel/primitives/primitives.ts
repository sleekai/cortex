// The Cortex core domain model (Deliverable 1). Nine typed primitives that
// describe *what* the system operates on, independent of any agent provider,
// harness, or runtime. These are data shapes only — no behavior, no I/O — so
// they compile and serialize the same in any host.
//
// Relationship map:
//   Task      — a unit of work; names the Blueprint that fulfils it.
//   Blueprint — an ordered graph of Nodes plus attached Policy + Directives.
//   Node      — one step in a Blueprint (a Skill call or the produce loop).
//   Directive — a scoped instruction that steers a Node or the whole run.
//   Agent     — a capability provider (a worker/model behind a harness).
//   Capability— the closed vocabulary Agents advertise and Tasks require.
//   Policy    — execution bounds (retry / escalation / budget / clarify).
//   Artifact  — typed output produced while executing a Task.
//   Trace     — the recorded execution of a Task over a Blueprint.
import { type Capability, type ArtifactKind } from './capabilities.js'
import { type PrimitiveHeader } from './schema.js'
import {
  type TaskId, type ArtifactId, type BlueprintId, type NodeId,
  type DirectiveId, type AgentId, type TraceId,
} from './ids.js'

// -- Capability descriptor ------------------------------------------------
// The capability vocabulary as first-class data (some hosts want to enumerate
// and describe capabilities, not just reference the string).
export interface CapabilityDescriptor extends PrimitiveHeader {
  kind: 'capability'
  name: Capability
  description: string
}

// -- Agent (capability provider) ------------------------------------------
export type AgentTier = 1 | 2 | 3
export type WriteAccess = 'none' | 'patch'

export interface AgentPrimitive extends PrimitiveHeader {
  kind: 'agent'
  id: AgentId
  capabilities: Capability[]
  tier: AgentTier
  writeAccess: WriteAccess
  contextWindow: number
  // Relative cost priors, per 1k tokens; language-neutral units.
  cost: { inPer1k: number; outPer1k: number }
  // 0..1 prior the provider succeeds unaided.
  reliability: number
}

// -- Task -----------------------------------------------------------------
export type Complexity = 'trivial' | 'bounded' | 'open'

export interface TaskPrimitive extends PrimitiveHeader {
  kind: 'task'
  id: TaskId
  // The normalized instruction — never raw user prose downstream of triage.
  normalized: string
  complexity: Complexity
  requiredCapabilities: Capability[]
  expectedOutput: ArtifactKind
  // The blueprint expected to fulfil this task.
  blueprint: BlueprintId
  estTokenBudget: number
}

// -- Node (blueprint step) -----------------------------------------------
// A node is either a named skill call or the `produce` closed loop. `when`
// is a serializable predicate reference (a named guard), never a live
// function — primitives stay pure data.
export type NodeKind = 'skill' | 'produce'

export interface NodePrimitive extends PrimitiveHeader {
  kind: 'node'
  id: NodeId
  step: NodeKind
  // Required when step === 'skill': the registered skill name.
  skill?: string
  // Optional named guard resolved by the runtime; absence means always-run.
  when?: string
}

// -- Directive ------------------------------------------------------------
// A scoped instruction layered onto execution. `scope` is either the whole
// run or a specific node id. `weight` orders competing directives.
export type DirectiveScope = { kind: 'run' } | { kind: 'node'; node: NodeId }

export interface DirectivePrimitive extends PrimitiveHeader {
  kind: 'directive'
  id: DirectiveId
  instruction: string
  scope: DirectiveScope
  weight: number
}

// -- Policy ---------------------------------------------------------------
// Execution bounds. A flattened, serializable view of the runtime PolicySet:
// the kernel records the numbers; the runtime keeps the decide() behavior.
export type ClarificationMode = 'halt' | 'proceed'

export interface PolicyPrimitive extends PrimitiveHeader {
  kind: 'policy'
  name: string
  maxIterations: number
  maxEscalationDepth: number
  ambiguityThreshold: number
  clarificationMode: ClarificationMode
  maxCost: number
  maxInputTokens: number
}

// -- Blueprint ------------------------------------------------------------
export interface BlueprintPrimitive extends PrimitiveHeader {
  kind: 'blueprint'
  id: BlueprintId
  name: string
  description: string
  // Ordered execution graph. Order is the array order; branching is
  // expressed via node `when` guards, matching the runtime runner.
  nodes: NodePrimitive[]
  // Directives attached to this blueprint (may target run or specific nodes).
  directives: DirectivePrimitive[]
  // The policy governing runs of this blueprint.
  policy: PolicyPrimitive
}

// -- Artifact -------------------------------------------------------------
export interface ArtifactPrimitive extends PrimitiveHeader {
  kind: 'artifact'
  id: ArtifactId
  artifactKind: ArtifactKind
  // The task this artifact was produced for.
  task: TaskId
  // The node that produced it, when known.
  producedBy?: NodeId
  // Content-address of the body (hex). Bodies themselves live outside the
  // primitive; the kernel tracks identity and lineage, not payloads.
  bodyHash: string
  createdAt: string // ISO-8601
}

// -- Trace ----------------------------------------------------------------
export type StepOutcome = 'ok' | 'retried' | 'escalated' | 'skipped' | 'failed'

export interface TraceStep {
  node: NodeId
  outcome: StepOutcome
  agent?: AgentId
  iterations: number
  costUnits: number
}

export interface TracePrimitive extends PrimitiveHeader {
  kind: 'trace'
  id: TraceId
  task: TaskId
  blueprint: BlueprintId
  steps: TraceStep[]
  accepted: boolean
  totalCostUnits: number
  startedAt: string // ISO-8601
  finishedAt: string // ISO-8601
}

// Discriminated union over every primitive — lets a serializer dispatch on
// `.kind` alone.
export type Primitive =
  | TaskPrimitive
  | ArtifactPrimitive
  | BlueprintPrimitive
  | NodePrimitive
  | DirectivePrimitive
  | AgentPrimitive
  | CapabilityDescriptor
  | PolicyPrimitive
  | TracePrimitive
