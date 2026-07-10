// Golden fixtures (Deliverable 4) — one simple task blueprint and the
// primitives around it. "Simple" = a two-node blueprint (locate then produce)
// that fulfils a bounded coding task. These values are the reference the
// round-trip and golden-file tests assert against; treat them as frozen.
import { KERNEL_SCHEMA_VERSION } from './schema.js'
import {
  taskId, blueprintId, nodeId, directiveId, agentId, artifactId, traceId,
} from './ids.js'
import {
  type TaskPrimitive, type BlueprintPrimitive, type NodePrimitive,
  type DirectivePrimitive, type PolicyPrimitive, type AgentPrimitive,
  type ArtifactPrimitive, type TracePrimitive, type CapabilityDescriptor,
} from './primitives.js'

export const fixturePolicy: PolicyPrimitive = {
  kind: 'policy',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  name: 'bounded-default',
  maxIterations: 3,
  maxEscalationDepth: 2,
  ambiguityThreshold: 0.4,
  clarificationMode: 'proceed',
  maxCost: 100,
  maxInputTokens: 2500,
}

export const fixtureNodes: NodePrimitive[] = [
  { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-locate'), step: 'skill', skill: 'locate' },
  { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-produce'), step: 'produce' },
]

export const fixtureDirective: DirectivePrimitive = {
  kind: 'directive',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: directiveId('d-scope-narrow'),
  instruction: 'Keep the patch to the smallest change that satisfies the task.',
  scope: { kind: 'node', node: nodeId('n-produce') },
  weight: 1,
}

export const fixtureBlueprint: BlueprintPrimitive = {
  kind: 'blueprint',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: blueprintId('bp-simple-patch'),
  name: 'simple-patch',
  description: 'Locate relevant code, then produce a bounded patch under policy.',
  nodes: fixtureNodes,
  directives: [fixtureDirective],
  policy: fixturePolicy,
}

export const fixtureTask: TaskPrimitive = {
  kind: 'task',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: taskId('t-fix-typo'),
  normalized: 'Fix the typo in the README installation section.',
  complexity: 'bounded',
  requiredCapabilities: ['locate', 'coding'],
  expectedOutput: 'patch',
  blueprint: blueprintId('bp-simple-patch'),
  estTokenBudget: 1200,
}

export const fixtureAgent: AgentPrimitive = {
  kind: 'agent',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: agentId('worker-coder-t2'),
  capabilities: ['coding', 'reasoning', 'locate'],
  tier: 2,
  writeAccess: 'patch',
  contextWindow: 128000,
  cost: { inPer1k: 3, outPer1k: 15 },
  reliability: 0.9,
}

export const fixtureCapability: CapabilityDescriptor = {
  kind: 'capability',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  name: 'coding',
  description: 'Produce or modify source code as a typed patch artifact.',
}

export const fixtureArtifact: ArtifactPrimitive = {
  kind: 'artifact',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: artifactId('a-patch-001'),
  artifactKind: 'patch',
  task: taskId('t-fix-typo'),
  producedBy: nodeId('n-produce'),
  bodyHash: '9f2c1b7e',
  createdAt: '2026-07-11T00:00:00.000Z',
}

export const fixtureTrace: TracePrimitive = {
  kind: 'trace',
  schemaVersion: KERNEL_SCHEMA_VERSION,
  id: traceId('tr-run-001'),
  task: taskId('t-fix-typo'),
  blueprint: blueprintId('bp-simple-patch'),
  steps: [
    { node: nodeId('n-locate'), outcome: 'ok', iterations: 1, costUnits: 2 },
    { node: nodeId('n-produce'), outcome: 'ok', agent: agentId('worker-coder-t2'), iterations: 1, costUnits: 18 },
  ],
  accepted: true,
  totalCostUnits: 20,
  startedAt: '2026-07-11T00:00:00.000Z',
  finishedAt: '2026-07-11T00:00:03.000Z',
}

// Every fixture primitive, keyed by kind — the test suite iterates this to
// prove all nine primitive kinds round-trip.
export const ALL_FIXTURES = {
  task: fixtureTask,
  artifact: fixtureArtifact,
  blueprint: fixtureBlueprint,
  node: fixtureNodes[0],
  directive: fixtureDirective,
  agent: fixtureAgent,
  capability: fixtureCapability,
  policy: fixturePolicy,
  trace: fixtureTrace,
} as const
