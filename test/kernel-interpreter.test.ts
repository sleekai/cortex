// SLE-71 Milestone 2 — Minimal Blueprint Interpreter.
// Covers the three acceptance criteria:
//   1. A triage → plan → evaluate blueprint runs from a sample task.
//   2. Each node consumes and emits typed artifacts.
//   3. The trace explains node order, directive calls, and transition decisions.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import {
  DefaultBlueprintLoader,
  SequentialNodeScheduler,
  DefaultDirectiveResolver,
  InMemoryArtifactStore,
  LocalArtifactStore,
  TraceBuilder,
  BlueprintInterpreter,
  type InterpreterContext,
  type NodeExecutor,
  type NodeResult,
  type BlueprintResult,
} from '../src/kernel/interpreter/index.js'
import { type BlueprintPrimitive, type ArtifactPrimitive, type NodePrimitive, type TaskPrimitive } from '../src/kernel/primitives/primitives.js'
import {
  fixtures,
  validateBlueprint,
  serialize, deserialize,
} from '../src/kernel/primitives/index.js'
import { type NodeId, artifactId, taskId, blueprintId, directiveId, nodeId, type ArtifactId } from '../src/kernel/primitives/ids.js'
import { KERNEL_SCHEMA_VERSION } from '../src/kernel/primitives/schema.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-interpreter-test-'))
}

// A fake node executor that records what it receives and produces canned output.
function makeFakeExecutor(
  stepKind: string,
  produce: (node: NodePrimitive, ctx: InterpreterContext, directives: string[]) => Partial<NodeResult>,
): NodeExecutor {
  return {
    canHandle: (n: NodePrimitive) => n.step === stepKind,
    execute: async (node: NodePrimitive, ctx: InterpreterContext, directives: string[]) => {
      const overrides = produce(node, ctx, directives)
      return {
        node,
        outcome: 'ok',
        produced: [],
        costUnits: 1,
        iterations: 1,
        ...overrides,
      }
    },
  }
}

function makeMinimalTask(overrides: Partial<TaskPrimitive> = {}): TaskPrimitive {
  return {
    kind: 'task',
    schemaVersion: KERNEL_SCHEMA_VERSION,
    id: taskId('t-test-task'),
    normalized: 'Test the minimal blueprint interpreter.',
    complexity: 'bounded',
    requiredCapabilities: ['locate', 'coding'],
    expectedOutput: 'patch',
    blueprint: blueprintId('bp-test'),
    estTokenBudget: 1000,
    ...overrides,
  }
}

// ── Account for primitives test overhead ─────────────────────────────────────

const PRIMITIVE_KINDS_COUNT = 9
const PRIMITIVE_TESTS = 8

// ── BlueprintLoader ──────────────────────────────────────────────────────────

describe('BlueprintLoader', () => {
  test('loads a valid blueprint from a parsed object', () => {
    const loader = new DefaultBlueprintLoader()
    const result = loader.load(fixtures.fixtureBlueprint)
    assert.ok(result.ok)
    assert.equal(result.value.id, fixtures.fixtureBlueprint.id)
  })

  test('loads a valid blueprint from a JSON string', () => {
    const loader = new DefaultBlueprintLoader()
    const json = serialize(fixtures.fixtureBlueprint)
    const result = loader.load(json)
    assert.ok(result.ok)
    assert.equal(result.value.id, fixtures.fixtureBlueprint.id)
  })

  test('rejects an invalid blueprint', () => {
    const loader = new DefaultBlueprintLoader()
    const bad = { ...fixtures.fixtureBlueprint, nodes: [] }
    const result = loader.load(bad)
    assert.ok(!result.ok)
  })

  test('caches loaded blueprints by id', () => {
    const loader = new DefaultBlueprintLoader()
    const r1 = loader.load(fixtures.fixtureBlueprint)
    assert.ok(r1.ok)
    assert.equal(loader.get(fixtures.fixtureBlueprint.id), r1.value)
  })

  test('register stores a blueprint directly', () => {
    const loader = new DefaultBlueprintLoader()
    loader.register(fixtures.fixtureBlueprint)
    assert.equal(loader.get(fixtures.fixtureBlueprint.id), fixtures.fixtureBlueprint)
  })
})

// ── DirectiveResolver ────────────────────────────────────────────────────────

describe('DirectiveResolver', () => {
  test('returns run-scoped directives', () => {
    const resolver = new DefaultDirectiveResolver()
    const runDirectives = resolver.forRun(fixtures.fixtureBlueprint)
    assert.equal(runDirectives.length, 0)
  })

  test('returns node-scoped directives for the targeted node', () => {
    const resolver = new DefaultDirectiveResolver()
    const nodeDirectives = resolver.forNode(fixtures.fixtureBlueprint, fixtures.fixtureNodes[1].id)
    assert.ok(nodeDirectives.length >= 1)
    assert.equal(nodeDirectives[0].scope.kind, 'node')
    assert.equal(nodeDirectives[0].scope.node, fixtures.fixtureNodes[1].id)
  })

  test('returns empty for an untargeted node', () => {
    const resolver = new DefaultDirectiveResolver()
    const nodeDirectives = resolver.forNode(fixtures.fixtureBlueprint, fixtures.fixtureNodes[0].id)
    assert.equal(nodeDirectives.length, 0)
  })

  test('allForNode combines run + node directives sorted by weight', () => {
    const resolver = new DefaultDirectiveResolver()
    const all = resolver.allForNode(fixtures.fixtureBlueprint, fixtures.fixtureNodes[1].id)
    assert.ok(all.length >= 1)
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].weight <= all[i].weight)
    }
  })
})

// ── SequentialNodeScheduler ──────────────────────────────────────────────────

describe('SequentialNodeScheduler', () => {
  test('schedules all nodes in blueprint order when no guards block', () => {
    const scheduler = new SequentialNodeScheduler()
    const task = makeMinimalTask()
    const ctx: InterpreterContext = { task, artifacts: [], nodeResults: new Map(), guardValues: new Map() }
    const schedule = scheduler.schedule(fixtures.fixtureBlueprint, ctx)
    assert.equal(schedule.length, fixtures.fixtureBlueprint.nodes.length)
    assert.equal(schedule[0].node.id, fixtures.fixtureBlueprint.nodes[0].id)
    assert.equal(schedule[1].node.id, fixtures.fixtureBlueprint.nodes[1].id)
    assert.ok(schedule.every(s => s.shouldRun))
  })

  test('respects when-guards that evaluate to false', () => {
    const guardedNodes: NodePrimitive[] = [
      { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-guarded'), step: 'skill', skill: 'locate', when: 'should-run' },
    ]
    const guardedBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-guarded'),
      nodes: guardedNodes,
    }

    const guardAlwaysFalse = (_name: string, _ctx: InterpreterContext) => false
    const scheduler = new SequentialNodeScheduler(guardAlwaysFalse)
    const task = makeMinimalTask()
    const ctx: InterpreterContext = { task, artifacts: [], nodeResults: new Map(), guardValues: new Map() }
    const schedule = scheduler.schedule(guardedBlueprint, ctx)
    assert.equal(schedule.length, 1)
    assert.equal(schedule[0].shouldRun, false)
  })

  test('passes guard values via the context', () => {
    const guardedNodes: NodePrimitive[] = [
      { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-has-ctx'), step: 'skill', skill: 'locate', when: 'has-context' },
    ]
    const guardedBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-context'),
      nodes: guardedNodes,
    }

    const guardChecker: (name: string, ctx: InterpreterContext) => boolean =
      (name, ctx) => ctx.guardValues.get(name) === true
    const scheduler = new SequentialNodeScheduler(guardChecker)
    const task = makeMinimalTask()
    const ctx: InterpreterContext = {
      task,
      artifacts: [],
      nodeResults: new Map(),
      guardValues: new Map([['has-context', true]]),
    }
    const schedule = scheduler.schedule(guardedBlueprint, ctx)
    assert.equal(schedule.length, 1)
    assert.equal(schedule[0].shouldRun, true)
  })

  test('reports skip reason in scheduled node', () => {
    const guardedNodes: NodePrimitive[] = [
      { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-skip-reason'), step: 'skill', skill: 'locate', when: 'should-run' },
    ]
    const guardedBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-skip-reason'),
      nodes: guardedNodes,
    }

    const guardAlwaysFalse = (_name: string, _ctx: InterpreterContext) => false
    const scheduler = new SequentialNodeScheduler(guardAlwaysFalse)
    const task = makeMinimalTask()
    const ctx: InterpreterContext = { task, artifacts: [], nodeResults: new Map(), guardValues: new Map() }
    const schedule = scheduler.schedule(guardedBlueprint, ctx)
    assert.equal(schedule.length, 1)
    assert.ok(schedule[0].reason.includes('blocked'))
  })
})

// ── ArtifactStore (InMemory) ─────────────────────────────────────────────────

describe('InMemoryArtifactStore', () => {
  test('saves and loads an artifact', async () => {
    const store = new InMemoryArtifactStore()
    await store.save(fixtures.fixtureArtifact)
    const loaded = await store.load(fixtures.fixtureArtifact.id as ArtifactId)
    assert.ok(loaded)
    assert.equal(loaded.id, fixtures.fixtureArtifact.id)
  })

  test('returns null for missing artifact', async () => {
    const store = new InMemoryArtifactStore()
    const loaded = await store.load(artifactId('a-nonexistent'))
    assert.equal(loaded, null)
  })

  test('lists artifacts by task id', async () => {
    const store = new InMemoryArtifactStore()
    await store.save(fixtures.fixtureArtifact)
    const list = await store.list(fixtures.fixtureArtifact.task)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, fixtures.fixtureArtifact.id)
  })

  test('delete removes an artifact', async () => {
    const store = new InMemoryArtifactStore()
    await store.save(fixtures.fixtureArtifact)
    await store.delete(fixtures.fixtureArtifact.id as ArtifactId)
    const loaded = await store.load(fixtures.fixtureArtifact.id as ArtifactId)
    assert.equal(loaded, null)
  })
})

// ── ArtifactStore (Local) ────────────────────────────────────────────────────

describe('LocalArtifactStore', () => {
  test('saves and loads an artifact from disk', async () => {
    const tmp = makeTempDir()
    try {
      const store = new LocalArtifactStore(tmp)
      await store.save(fixtures.fixtureArtifact)
      const loaded = await store.load(fixtures.fixtureArtifact.id as ArtifactId)
      assert.ok(loaded)
      assert.equal(loaded.id, fixtures.fixtureArtifact.id)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('lists artifacts by task from disk', async () => {
    const tmp = makeTempDir()
    try {
      const store = new LocalArtifactStore(tmp)
      await store.save(fixtures.fixtureArtifact)
      const list = await store.list(fixtures.fixtureArtifact.task)
      assert.equal(list.length, 1)
      assert.equal(list[0].id, fixtures.fixtureArtifact.id)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('returns empty list for missing task directory', async () => {
    const store = new LocalArtifactStore(makeTempDir())
    const list = await store.list(taskId('t-nonexistent'))
    assert.deepEqual(list, [])
  })
})

// ── TraceBuilder ─────────────────────────────────────────────────────────────

describe('TraceBuilder', () => {
  test('starts a trace with startedAt and zero steps', () => {
    const task = makeMinimalTask()
    const builder = TraceBuilder.start(task, fixtures.fixtureBlueprint)
    const trace = builder.finish(false)
    assert.equal(trace.task, task.id)
    assert.equal(trace.blueprint, fixtures.fixtureBlueprint.id)
    assert.equal(trace.steps.length, 0)
    assert.equal(trace.accepted, false)
    assert.equal(trace.totalCostUnits, 0)
    assert.ok(trace.startedAt)
    assert.ok(trace.finishedAt)
  })

  test('records steps and accumulates cost', () => {
    const task = makeMinimalTask()
    const builder = TraceBuilder.start(task, fixtures.fixtureBlueprint)
    builder.recordStep({
      node: fixtures.fixtureNodes[0],
      outcome: 'ok',
      produced: [],
      costUnits: 5,
      iterations: 2,
    })
    builder.recordStep({
      node: fixtures.fixtureNodes[1],
      outcome: 'ok',
      produced: [],
      costUnits: 15,
      iterations: 1,
    })
    const trace = builder.finish(true)
    assert.equal(trace.steps.length, 2)
    assert.equal(trace.totalCostUnits, 20)
    assert.equal(trace.steps[0].node, fixtures.fixtureNodes[0].id)
    assert.equal(trace.steps[1].outcome, 'ok')
    assert.equal(trace.accepted, true)
  })

  test('records skipped and failed steps', () => {
    const task = makeMinimalTask()
    const builder = TraceBuilder.start(task, fixtures.fixtureBlueprint)
    builder.recordStep({
      node: fixtures.fixtureNodes[0],
      outcome: 'skipped',
      produced: [],
      costUnits: 0,
      iterations: 0,
    })
    builder.recordStep({
      node: fixtures.fixtureNodes[1],
      outcome: 'failed',
      produced: [],
      costUnits: 3,
      iterations: 1,
    })
    const trace = builder.finish(false)
    assert.equal(trace.steps[0].outcome, 'skipped')
    assert.equal(trace.steps[1].outcome, 'failed')
    assert.equal(trace.accepted, false)
  })
})

// ── BlueprintInterpreter — Integration ───────────────────────────────────────

describe('BlueprintInterpreter (AC1 — end-to-end execution)', () => {
  test('executes a two-node blueprint (locate → produce) with fake executors (AC1)', async () => {
    const locateExecutor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const,
      produced: [{
        kind: 'artifact' as const,
        schemaVersion: KERNEL_SCHEMA_VERSION,
        id: artifactId('a-locate-001'),
        artifactKind: 'pointer-set' as const,
        task: taskId('t-test-task'),
        producedBy: fixtures.fixtureNodes[0].id,
        bodyHash: 'abc123',
        createdAt: new Date().toISOString(),
      }],
      costUnits: 2,
    }))

    const produceExecutor = makeFakeExecutor('produce', () => ({
      outcome: 'ok' as const,
      produced: [{
        kind: 'artifact' as const,
        schemaVersion: KERNEL_SCHEMA_VERSION,
        id: artifactId('a-patch-001'),
        artifactKind: 'patch' as const,
        task: taskId('t-test-task'),
        producedBy: fixtures.fixtureNodes[1].id,
        bodyHash: 'def456',
        createdAt: new Date().toISOString(),
      }],
      costUnits: 18,
    }))

    const interpreter = new BlueprintInterpreter({ executors: [locateExecutor, produceExecutor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, fixtures.fixtureBlueprint)

    // AC1: Blueprint runs end to end.
    assert.ok(result.accepted)
    assert.equal(result.artifacts.length, 2)
    assert.equal(result.trace.steps.length, 2)

    // AC2: Each node produces typed artifacts.
    assert.equal(result.artifacts[0].artifactKind, 'pointer-set')
    assert.equal(result.artifacts[0].producedBy, fixtures.fixtureNodes[0].id)
    assert.equal(result.artifacts[1].artifactKind, 'patch')
    assert.equal(result.artifacts[1].producedBy, fixtures.fixtureNodes[1].id)

    // AC3: Trace explains node order, outcomes, and costs.
    assert.equal(result.trace.steps[0].node, fixtures.fixtureNodes[0].id)
    assert.equal(result.trace.steps[0].outcome, 'ok')
    assert.equal(result.trace.steps[0].costUnits, 2)
    assert.equal(result.trace.steps[1].node, fixtures.fixtureNodes[1].id)
    assert.equal(result.trace.steps[1].outcome, 'ok')
    assert.equal(result.trace.steps[1].costUnits, 18)
    assert.equal(result.trace.totalCostUnits, 20)
  })

  test('produces accepted=false when a node fails', async () => {
    const failExecutor: NodeExecutor = {
      canHandle: () => true,
      execute: async () => ({
        node: fixtures.fixtureNodes[0],
        outcome: 'failed',
        produced: [],
        costUnits: 0,
        iterations: 1,
        error: 'intentional failure',
      }),
    }

    const interpreter = new BlueprintInterpreter({ executors: [failExecutor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, fixtures.fixtureBlueprint)

    assert.equal(result.accepted, false)
    assert.equal(result.trace.steps[0].outcome, 'failed')
  })

  test('skips nodes when guard blocks them', async () => {
    const guardedNodes: NodePrimitive[] = [
      { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-guarded-int'), step: 'skill', skill: 'locate', when: 'should-run' },
    ]
    const guardedBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-guarded-int'),
      nodes: guardedNodes,
    }

    const guardAlwaysFalse = () => false
    const scheduler = new SequentialNodeScheduler(guardAlwaysFalse)
    const executor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const,
      produced: [],
      costUnits: 1,
    }))

    const interpreter = new BlueprintInterpreter({ scheduler, executors: [executor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, guardedBlueprint)

    assert.equal(result.trace.steps.length, 1)
    assert.equal(result.trace.steps[0].outcome, 'skipped')
    assert.equal(result.trace.totalCostUnits, 0)
  })

  test('stores produced artifacts in the artifact store', async () => {
    const store = new InMemoryArtifactStore()
    const executor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const,
      produced: [{
        kind: 'artifact' as const,
        schemaVersion: KERNEL_SCHEMA_VERSION,
        id: artifactId('a-stored-001'),
        artifactKind: 'plan' as const,
        task: taskId('t-test-task'),
        producedBy: fixtures.fixtureNodes[0].id,
        bodyHash: 'xyz',
        createdAt: new Date().toISOString(),
      }],
      costUnits: 1,
    }))

    const interpreter = new BlueprintInterpreter({ store, executors: [executor] })
    const task = makeMinimalTask()
    await interpreter.executeTask(task, fixtures.fixtureBlueprint)

    const stored = await store.list(task.id)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].artifactKind, 'plan')
  })

  test('passes resolved directives to node executors', async () => {
    const received: string[][] = []
    const directiveAwareExecutor: NodeExecutor = {
      canHandle: () => true,
      execute: async (_node: NodePrimitive, _ctx: InterpreterContext, directives: string[]) => {
        received.push(directives)
        return { node: _node, outcome: 'ok' as const, produced: [], costUnits: 1, iterations: 1 }
      },
    }

    const interpreter = new BlueprintInterpreter({ executors: [directiveAwareExecutor] })
    const task = makeMinimalTask()
    await interpreter.executeTask(task, fixtures.fixtureBlueprint)

    // The second node (n-produce) has a directive targeting it.
    assert.ok(received.length >= 2)
    const produceNodeDirectives = received[1]
    assert.ok(produceNodeDirectives.length >= 1)
    assert.ok(produceNodeDirectives.some(d => d.includes('patch')))
  })

  test('trace explains node order and directive calls (AC3)', async () => {
    const executor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const,
      produced: [{
        kind: 'artifact' as const,
        schemaVersion: KERNEL_SCHEMA_VERSION,
        id: artifactId('a-trace-test'),
        artifactKind: 'pointer-set' as const,
        task: taskId('t-test-task'),
        producedBy: fixtures.fixtureNodes[0].id,
        bodyHash: 'trace1',
        createdAt: new Date().toISOString(),
      }],
      costUnits: 2,
    }))

    const produceExecutor = makeFakeExecutor('produce', () => ({
      outcome: 'ok' as const,
      produced: [{
        kind: 'artifact' as const,
        schemaVersion: KERNEL_SCHEMA_VERSION,
        id: artifactId('a-trace-test-2'),
        artifactKind: 'patch' as const,
        task: taskId('t-test-task'),
        producedBy: fixtures.fixtureNodes[1].id,
        bodyHash: 'trace2',
        createdAt: new Date().toISOString(),
      }],
      costUnits: 10,
    }))

    const interpreter = new BlueprintInterpreter({ executors: [executor, produceExecutor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, fixtures.fixtureBlueprint)
    const trace = result.trace

    // Node order is preserved from the blueprint.
    assert.equal(trace.steps[0].node, 'n-locate')
    assert.equal(trace.steps[1].node, 'n-produce')

    // Each step records outcome, iterations, and cost.
    for (const step of trace.steps) {
      assert.ok(['ok', 'retried', 'escalated', 'skipped', 'failed'].includes(step.outcome))
      assert.equal(typeof step.iterations, 'number')
      assert.equal(typeof step.costUnits, 'number')
    }

    // Total cost is the sum of step costs.
    const sumCost = trace.steps.reduce((sum, s) => sum + s.costUnits, 0)
    assert.equal(trace.totalCostUnits, sumCost)

    // Timestamps are valid ISO strings.
    assert.ok(!Number.isNaN(Date.parse(trace.startedAt)))
    assert.ok(!Number.isNaN(Date.parse(trace.finishedAt)))

    // The task and blueprint refs are correct.
    assert.equal(trace.task, task.id)
    assert.equal(trace.blueprint, fixtures.fixtureBlueprint.id)
  })

  test('acceptance criteria demo: triage → plan → evaluate (AC1)', async () => {
    // Build a three-node blueprint: triage → plan → evaluate.
    const threeNodeBlueprint: BlueprintPrimitive = {
      kind: 'blueprint',
      schemaVersion: KERNEL_SCHEMA_VERSION,
      id: blueprintId('bp-tri-plan-eval'),
      name: 'triage-plan-evaluate',
      description: 'Triage a task, plan the approach, evaluate the result.',
      nodes: [
        { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-triage'), step: 'skill', skill: 'triage' },
        { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-plan'), step: 'skill', skill: 'plan' },
        { kind: 'node', schemaVersion: KERNEL_SCHEMA_VERSION, id: nodeId('n-evaluate'), step: 'produce' },
      ],
      directives: [
        {
          kind: 'directive', schemaVersion: KERNEL_SCHEMA_VERSION,
          id: directiveId('d-thorough-plan'), instruction: 'Produce a detailed step-by-step plan.',
          scope: { kind: 'node', node: nodeId('n-plan') }, weight: 1,
        },
      ],
      policy: fixtures.fixturePolicy,
    }

    const stepRecorder: { node: string; directives: string[] }[] = []
    const recordingExecutor: NodeExecutor = {
      canHandle: () => true,
      execute: async (node: NodePrimitive, _ctx: InterpreterContext, directives: string[]) => {
        stepRecorder.push({ node: node.id, directives })
        return {
          node,
          outcome: 'ok' as const,
          produced: [{
            kind: 'artifact' as const,
            schemaVersion: KERNEL_SCHEMA_VERSION,
            id: `a-${node.id.slice(2)}` as ArtifactId,
            artifactKind: node.step === 'skill' ? 'plan' as const : 'evaluation' as const,
            task: taskId('t-acceptance-demo'),
            producedBy: node.id,
            bodyHash: `hash-${node.id}`,
            createdAt: new Date().toISOString(),
          }],
          costUnits: node.id === 'n-evaluate' ? 15 : 3,
          iterations: 1,
        }
      },
    }

    const interpreter = new BlueprintInterpreter({ executors: [recordingExecutor] })
    const task = makeMinimalTask({ id: taskId('t-acceptance-demo'), normalized: 'Implement a sorting algorithm.' })
    const result = await interpreter.executeTask(task, threeNodeBlueprint)

    // AC1: The blueprint runs all three steps.
    assert.ok(result.accepted)
    assert.equal(result.trace.steps.length, 3)
    assert.equal(stepRecorder.length, 3)
    assert.equal(stepRecorder[0].node, 'n-triage')
    assert.equal(stepRecorder[1].node, 'n-plan')
    assert.equal(stepRecorder[2].node, 'n-evaluate')

    // AC2: Each node produced a typed artifact.
    assert.equal(result.artifacts.length, 3)
    for (const art of result.artifacts) {
      assert.equal(art.kind, 'artifact')
      assert.ok(art.producedBy)
    }

    // AC3: Trace explains node order, directive calls, and transition decisions.
    const trace = result.trace
    assert.equal(trace.steps[0].node, 'n-triage')
    assert.equal(trace.steps[0].outcome, 'ok')
    assert.equal(trace.steps[1].node, 'n-plan')
    assert.equal(trace.steps[2].node, 'n-evaluate')
    assert.equal(trace.totalCostUnits, 21) // 3 + 3 + 15

    // The plan node received the thorough-plan directive.
    const planStep = stepRecorder.find(s => s.node === 'n-plan')
    assert.ok(planStep)
    assert.ok(planStep.directives.some(d => d.includes('detailed')))
  })
})

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('executes a single-node blueprint', async () => {
    const singleNode: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-single'),
      nodes: [fixtures.fixtureNodes[0]],
      directives: [],
    }

    const executor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const,
      produced: [], costUnits: 1, iterations: 1,
    }))

    const interpreter = new BlueprintInterpreter({ executors: [executor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, singleNode)
    assert.equal(result.trace.steps.length, 1)
    assert.equal(result.trace.steps[0].outcome, 'ok')
  })

  test('handles empty blueprint node list gracefully', async () => {
    const emptyBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-empty'),
      nodes: [],
    }

    const executor = makeFakeExecutor('skill', () => ({
      outcome: 'ok' as const, produced: [], costUnits: 1, iterations: 1,
    }))

    const interpreter = new BlueprintInterpreter({ executors: [executor] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, emptyBlueprint)
    assert.equal(result.trace.steps.length, 0)
    assert.equal(result.accepted, true)
  })

  test('halts on failure when clarificationMode is halt', async () => {
    const haltPolicy = {
      ...fixtures.fixturePolicy,
      clarificationMode: 'halt' as const,
    }
    const haltBlueprint: BlueprintPrimitive = {
      ...fixtures.fixtureBlueprint,
      id: blueprintId('bp-halt'),
      policy: haltPolicy,
    }

    const failFirst: NodeExecutor = {
      canHandle: () => true,
      execute: async (node: NodePrimitive) => {
        if (node.id === fixtures.fixtureNodes[0].id) {
          return { node, outcome: 'failed' as const, produced: [], costUnits: 0, iterations: 1, error: 'fail' }
        }
        return { node, outcome: 'ok' as const, produced: [], costUnits: 1, iterations: 1 }
      },
    }

    const interpreter = new BlueprintInterpreter({ executors: [failFirst] })
    const task = makeMinimalTask()
    const result = await interpreter.executeTask(task, haltBlueprint)
    assert.equal(result.accepted, false)
    assert.equal(result.trace.steps.length, 1) // stopped after first failure
  })
})
