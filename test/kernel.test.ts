import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import '../src/harness/cli-harness.js'
import { planTask, prepareDispatch, runTask } from '../src/kernel/index.js'
import { DEFAULT_BUDGET } from '../src/core/types.js'

// The kernel resolves .cortex/ relative to the project root under test.
delete process.env['CORTEX_DIR']

function makeProject(withSource = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-kernel-'))
  if (withSource) {
    fs.writeFileSync(path.join(dir, 'auth.ts'), [
      'export function validateToken(token: string): boolean {',
      '  return token.length > 0 && !token.includes(" ")',
      '}',
      '',
      'export function expireSession(sessionId: string): void {',
      '  console.log(`expiring ${sessionId}`)',
      '}',
    ].join('\n'))
  }
  return dir
}

// An overlay that retires the default claude-cli worker and adds a worker
// whose "model" is /bin/echo emitting an IMPOSSIBLE verdict — a real cli
// harness dispatch with no model, no network.
function writeEchoOverlay(projectRoot: string): void {
  const cortex = path.join(projectRoot, '.cortex')
  fs.mkdirSync(cortex, { recursive: true })
  const echoWorker = {
    id: 'echo-worker',
    capabilities: ['coding', 'reasoning'],
    harness: {
      kind: 'cli',
      bin: '/bin/echo',
      args: ['IMPOSSIBLE: echo worker refuses everything'],
      stripEnv: [],
      promptVia: 'stdin',
      probeArgs: ['probe'],
    },
    cost: { inPer1k: 0.01, outPer1k: 0.01 },
    speed: 10,
    contextWindow: 100_000,
    quality: { coding: 0.5, reasoning: 0.5 },
    reliability: 0.9,
    tier: 2,
    writeAccess: 'patch',
  }
  const retiredClaude = {
    id: 'claude-cli',
    capabilities: ['coding'],
    harness: { kind: 'cli', bin: 'claude', args: [], stripEnv: [], promptVia: 'stdin', probeArgs: ['--version'] },
    cost: { inPer1k: 3, outPer1k: 15 },
    speed: 0.3,
    contextWindow: 200_000,
    quality: { coding: 0.9 },
    reliability: 0.9,
    tier: 3,
    writeAccess: 'patch',
    disabled: true,
  }
  fs.writeFileSync(path.join(cortex, 'workers.json'), JSON.stringify({ workers: [echoWorker, retiredClaude] }, null, 2))
}

test('planTask: locate intents short-circuit to tier 0', () => {
  const dir = makeProject(false)
  const { intent, plan } = planTask('find where token validation happens', dir)
  assert.equal(intent.taskType, 'locate')
  assert.equal(plan.tier0, true)
  assert.equal(plan.ladder.length, 0)
})

test('planTask: patch intents produce a non-empty ladder from the registry', () => {
  const dir = makeProject(false)
  const { intent, plan } = planTask('fix the null check in auth.ts', dir)
  assert.equal(intent.taskType, 'patch')
  assert.equal(plan.tier0, false)
  assert.ok(plan.ladder.length >= 1)
})

test('prepareDispatch: locate returns pointers, never a packet', () => {
  const dir = makeProject()
  const prepared = prepareDispatch('find where token validation happens', { projectRoot: dir })
  assert.equal(prepared.kind, 'pointers')
  assert.ok(prepared.kind === 'pointers' && prepared.pointers.length > 0)
})

test('prepareDispatch: patch task yields a budgeted v2 work packet', () => {
  const dir = makeProject()
  const prepared = prepareDispatch('fix validateToken in auth.ts to reject empty tokens', { projectRoot: dir })
  assert.equal(prepared.kind, 'packet')
  if (prepared.kind !== 'packet') return
  assert.equal(prepared.ucp.v, 2)
  assert.equal(prepared.ucp.act, 'work')
  assert.ok(prepared.budgeted.chunks.length <= DEFAULT_BUDGET.maxChunks)
  assert.equal(prepared.budgeted.refused, false)
})

test('prepareDispatch: a spend cap of ~zero refuses the dispatch', () => {
  const dir = makeProject()
  const prepared = prepareDispatch('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    budget: { ...DEFAULT_BUDGET, maxSpend: 0.000001 },
  })
  assert.equal(prepared.kind, 'refused')
  assert.ok(prepared.kind === 'refused' && /spend/.test(prepared.reason))
})

test('runTask: persists artifacts, state, and metrics for CLI and MCP alike', async () => {
  const dir = makeProject()
  writeEchoOverlay(dir)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return
  // The echo worker replies IMPOSSIBLE — an unrecoverable failure artifact.
  assert.equal(outcome.result.accepted, false)
  assert.equal(outcome.result.state.iteration, 1)

  // Persistence is the kernel's job, identical for every surface.
  const artifactDir = path.join(dir, '.cortex', 'artifacts', outcome.ucp.t)
  const artifactFiles = fs.readdirSync(artifactDir).filter(f => f.endsWith('.json'))
  assert.ok(artifactFiles.length >= 1)

  const state = JSON.parse(fs.readFileSync(path.join(dir, '.cortex', 'state.json'), 'utf-8')) as { taskId: string }
  assert.equal(state.taskId, outcome.ucp.t)

  const metrics = fs.readFileSync(path.join(dir, '.cortex', 'metrics.jsonl'), 'utf-8').trim().split('\n')
  assert.ok(metrics.length >= 1)
  const record = JSON.parse(metrics[0]!) as { workerId: string; ok: boolean }
  assert.equal(record.workerId, 'echo-worker')
  assert.equal(record.ok, false)
})

