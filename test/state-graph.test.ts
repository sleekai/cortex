import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { lastValue, appendList, mapMerge, applyUpdate, initialState } from '../src/graph/channels.js'
import { stateGraph, send, START, END } from '../src/graph/state-graph.js'
import { runGraph, resumeGraph, type GraphCheckpoint } from '../src/graph/executor.js'
import { packetNode, packetChannels } from '../src/graph/packet-node.js'
import { registerHarness, type Harness, type HarnessConfig } from '../src/harness/harness.js'
import { type ScoredWorker } from '../src/capability/planner.js'
import { type WorkerSpec } from '../src/worker/registry.js'
import { type UCP } from '../src/packet/ucp.js'
import { isKind, type Artifact } from '../src/artifact/artifacts.js'
import { type NodeResult } from '../src/worker/dispatch.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- channels ---

test('reducers: lastValue overwrites, appendList concatenates, mapMerge merges by key', () => {
  const channels = { note: lastValue('none'), log: appendList<string>(), byId: mapMerge<number>() }
  let state = initialState(channels)
  state = applyUpdate(channels, state, { note: 'first', log: ['a'], byId: { x: 1 } })
  state = applyUpdate(channels, state, { note: 'second', log: ['b', 'c'], byId: { y: 2 } })
  assert.equal(state.note, 'second')
  assert.deepEqual(state.log, ['a', 'b', 'c'])
  assert.deepEqual(state.byId, { x: 1, y: 2 })
})

test('update to an undeclared channel fails loud', () => {
  const channels = { log: appendList<string>() }
  assert.throws(() => applyUpdate(channels, initialState(channels), { ghost: 1 }), /unknown channel "ghost"/)
})

// --- builder validation ---

test('compile rejects edges to unknown nodes and graphs without an entry', () => {
  assert.throws(
    () => stateGraph({}).addNode('a', () => ({})).addEdge(START, 'a').addEdge('a', 'ghost').compile(),
    /unknown node "ghost"/,
  )
  assert.throws(() => stateGraph({}).addNode('a', () => ({})).compile(), /no entry edge from START/)
})

// --- execution basics ---

test('linear flow merges updates and terminates at END', async () => {
  const graph = stateGraph({ log: appendList<string>() })
    .addNode('a', () => ({ update: { log: ['a'] } }))
    .addNode('b', () => ({ update: { log: ['b'] } }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile()
  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'done')
  if (outcome.status === 'done') {
    assert.deepEqual(outcome.state.log, ['a', 'b'])
    assert.equal(outcome.steps, 2)
  }
})

test('parallel updates apply in node-id order regardless of completion order', async () => {
  const graph = stateGraph({ log: appendList<string>() })
    .addNode('a-slow', async () => { await sleep(20); return { update: { log: ['a-slow'] } } })
    .addNode('b-fast', () => ({ update: { log: ['b-fast'] } }))
    .addEdge(START, 'b-fast')
    .addEdge(START, 'a-slow')
    .addEdge('a-slow', END)
    .addEdge('b-fast', END)
    .compile()
  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'done')
  if (outcome.status === 'done') assert.deepEqual(outcome.state.log, ['a-slow', 'b-fast'])
})

test('conditional edges route from merged state', async () => {
  const graph = stateGraph({ verdict: lastValue(''), log: appendList<string>() })
    .addNode('check', () => ({ update: { verdict: 'bad' } }))
    .addNode('happy', () => ({ update: { log: ['happy'] } }))
    .addNode('repair', () => ({ update: { log: ['repair'] } }))
    .addEdge(START, 'check')
    .addConditionalEdges('check', s => (s.verdict === 'good' ? 'happy' : 'repair'))
    .addEdge('happy', END)
    .addEdge('repair', END)
    .compile()
  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'done')
  if (outcome.status === 'done') assert.deepEqual(outcome.state.log, ['repair'])
})

test('goto overrides static edges (Command-style)', async () => {
  const graph = stateGraph({ log: appendList<string>() })
    .addNode('a', () => ({ update: { log: ['a'] }, goto: ['c'] }))
    .addNode('b', () => ({ update: { log: ['b'] } }))
    .addNode('c', () => ({ update: { log: ['c'] } }))
    .addEdge(START, 'a')
    .addEdge('a', 'b') // shadowed by goto
    .addEdge('b', END)
    .addEdge('c', END)
    .compile()
  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'done')
  if (outcome.status === 'done') assert.deepEqual(outcome.state.log, ['a', 'c'])
})

test('Send fan-out runs one task per payload; plain fan-in dedupes the join', async () => {
  const joinRuns: number[] = []
  const graph = stateGraph({ items: lastValue<number[]>([]), doubled: appendList<number>(), total: lastValue(0) })
    .addNode('plan', ctx => ({ goto: (ctx.state.items as number[]).map(n => send('double', n)) }))
    .addNode('double', ctx => ({ update: { doubled: [(ctx.input as number) * 2] } }))
    .addNode('join', ctx => {
      joinRuns.push(ctx.step)
      return { update: { total: (ctx.state.doubled as number[]).reduce((s, n) => s + n, 0) } }
    })
    .addEdge(START, 'plan')
    .addEdge('double', 'join')
    .addEdge('join', END)
    .compile()
  const outcome = await runGraph(graph, { items: [1, 2, 3] })
  assert.equal(outcome.status, 'done')
  if (outcome.status === 'done') {
    assert.deepEqual(outcome.state.doubled, [2, 4, 6])
    assert.equal(outcome.state.total, 12)
  }
  assert.equal(joinRuns.length, 1) // three doubles fan into one join run
})

// --- cycles ---

test('cycles run until a router exits; recursion limit stops runaways', async () => {
  const bounded = stateGraph({ n: lastValue(0) })
    .addNode('inc', ctx => ({ update: { n: (ctx.state.n as number) + 1 } }))
    .addEdge(START, 'inc')
    .addConditionalEdges('inc', s => ((s.n as number) >= 3 ? END : 'inc'))
    .compile()
  const done = await runGraph(bounded)
  assert.equal(done.status, 'done')
  if (done.status === 'done') assert.equal(done.state.n, 3)

  const runaway = await runGraph(bounded, {}, { recursionLimit: 2 })
  assert.equal(runaway.status, 'exhausted')
  if (runaway.status === 'exhausted') assert.equal(runaway.checkpoint.state.n, 2)
})

// --- interrupt / resume ---

test('interrupt pauses the run; peers settle; resume re-runs the node with the value', async () => {
  const graph = stateGraph({ log: appendList<string>(), approval: lastValue('') })
    .addNode('peer', () => ({ update: { log: ['peer'] } }))
    .addNode('gate', ctx => {
      if (ctx.resume === undefined) return { interrupt: { reason: 'needs approval', payload: { ask: 'ok?' } } }
      return { update: { approval: ctx.resume as string, log: ['gate'] } }
    })
    .addEdge(START, 'gate')
    .addEdge(START, 'peer')
    .addEdge('gate', END)
    .addEdge('peer', END)
    .compile()

  const paused = await runGraph(graph)
  assert.equal(paused.status, 'interrupted')
  if (paused.status !== 'interrupted') return
  assert.deepEqual(paused.interrupts, [{ node: 'gate', reason: 'needs approval', payload: { ask: 'ok?' } }])
  assert.deepEqual(paused.checkpoint.state.log, ['peer']) // peer's update survived
  assert.deepEqual(paused.checkpoint.interrupted, ['gate'])

  const finished = await resumeGraph(graph, paused.checkpoint, 'approved')
  assert.equal(finished.status, 'done')
  if (finished.status === 'done') {
    assert.equal(finished.state.approval, 'approved')
    assert.deepEqual(finished.state.log, ['peer', 'gate'])
  }
})

// --- checkpoints / time travel / failure / cancellation ---

test('resuming an earlier checkpoint replays deterministically', async () => {
  const graph = stateGraph({ n: lastValue(0) })
    .addNode('inc', ctx => ({ update: { n: (ctx.state.n as number) + 1 } }))
    .addEdge(START, 'inc')
    .addConditionalEdges('inc', s => ((s.n as number) >= 4 ? END : 'inc'))
    .compile()
  const checkpoints: GraphCheckpoint[] = []
  const first = await runGraph(graph, {}, { onCheckpoint: cp => checkpoints.push(cp) })
  assert.equal(first.status, 'done')

  const replay = await resumeGraph(graph, checkpoints[1]!) // n=1, frontier=[inc]
  assert.equal(replay.status, 'done')
  if (replay.status === 'done' && first.status === 'done') {
    assert.deepEqual(replay.state, first.state)
  }
})

test('a throwing node fails the run with a pre-superstep checkpoint; resume retries it', async () => {
  let attempts = 0
  const graph = stateGraph({ log: appendList<string>() })
    .addNode('flaky', () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
      return { update: { log: ['ok'] } }
    })
    .addEdge(START, 'flaky')
    .addEdge('flaky', END)
    .compile()

  const failed = await runGraph(graph)
  assert.equal(failed.status, 'failed')
  if (failed.status !== 'failed') return
  assert.equal(failed.node, 'flaky')
  assert.equal(failed.error, 'transient')
  assert.deepEqual(failed.checkpoint.frontier, [{ node: 'flaky' }])

  const retried = await resumeGraph(graph, failed.checkpoint)
  assert.equal(retried.status, 'done')
  if (retried.status === 'done') assert.deepEqual(retried.state.log, ['ok'])
})

test('routing to an unknown node fails instead of hanging', async () => {
  const graph = stateGraph({})
    .addNode('a', () => ({ goto: ['ghost'] }))
    .addEdge(START, 'a')
    .compile()
  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'failed')
  if (outcome.status === 'failed') assert.match(outcome.error, /unknown node "ghost"/)
})

test('abort cancels at the superstep boundary with a resumable checkpoint', async () => {
  const controller = new AbortController()
  const graph = stateGraph({ log: appendList<string>() })
    .addNode('a', () => { controller.abort(); return { update: { log: ['a'] } } })
    .addNode('b', () => ({ update: { log: ['b'] } }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile()

  const cancelled = await runGraph(graph, {}, { signal: controller.signal })
  assert.equal(cancelled.status, 'cancelled')
  if (cancelled.status !== 'cancelled') return
  assert.deepEqual(cancelled.checkpoint.state.log, ['a']) // a settled before the boundary
  assert.deepEqual(cancelled.checkpoint.frontier, [{ node: 'b' }])

  const finished = await resumeGraph(graph, cancelled.checkpoint)
  assert.equal(finished.status, 'done')
  if (finished.status === 'done') assert.deepEqual(finished.state.log, ['a', 'b'])
})

// --- packet-node bridge ---

const scripts = new Map<string, () => { ok: boolean; output: string; failReason?: string }>()
registerHarness('fake-graph', (config) => {
  const key = (config as unknown as { bin: string }).bin
  const harness: Harness = {
    available: () => true,
    invoke: async () => {
      const r = (scripts.get(key) ?? (() => ({ ok: true, output: 'ok' })))()
      return { ...r, latencyMs: 1 }
    },
  }
  return harness
})

function fakeWorker(id: string, bin = id): ScoredWorker {
  const worker: WorkerSpec = {
    id,
    capabilities: ['coding'],
    harness: { kind: 'fake-graph', bin } as unknown as HarnessConfig,
    cost: { inPer1k: 1, outPer1k: 1 },
    speed: 1,
    contextWindow: 100_000,
    quality: { coding: 0.8 },
    reliability: 0.9,
    tier: 1,
    writeAccess: 'patch',
  }
  return { worker, utility: 1, expectedSpend: 1, justification: 'test' }
}

function workPacket(t: string): UCP {
  return {
    v: 2, t, act: 'work', g: 'fix thing', c: [],
    ctx: { f: [], d: [] }, r: { out: 'patch', format: 'unified diff' },
  }
}

const GOOD_DIFF = '```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n```'

test('packetNode dispatches through the ladder and lands artifacts in channels', async () => {
  scripts.set('good', () => ({ ok: true, output: GOOD_DIFF }))
  const graph = stateGraph(packetChannels())
    .addNode('work', packetNode({
      id: 'work',
      packet: workPacket('t-graph'),
      chunks: [],
      ladder: [fakeWorker('cheap', 'good')],
      dispatch: { timeoutMs: 1000, maxOutputBytes: 1024 },
    }))
    .addEdge(START, 'work')
    .addEdge('work', END)
    .compile()

  const outcome = await runGraph(graph)
  assert.equal(outcome.status, 'done')
  if (outcome.status !== 'done') return
  const artifacts = outcome.state.artifacts as Artifact[]
  assert.equal(artifacts.length, 1)
  assert.ok(isKind(artifacts[0]!, 'patch'))
  const results = outcome.state.results as Record<string, NodeResult>
  assert.equal(results.work!.workerId, 'cheap')
})
