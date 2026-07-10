import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import '../src/harness/cli-harness.js'
import { runTask } from '../src/kernel/index.js'
import { isKind } from '../src/artifact/artifacts.js'

delete process.env['CORTEX_DIR']

const AUTH_TS = [
  'export function validateToken(token: string): boolean {',
  '  return token.length > 0 && !token.includes(" ")',
  '}',
].join('\n')

const GOOD_DIFF = [
  '```diff',
  '--- a/auth.ts',
  '+++ b/auth.ts',
  '@@ -1,3 +1,3 @@',
  ' export function validateToken(token: string): boolean {',
  '-  return token.length > 0 && !token.includes(" ")',
  '+  return token.length > 0',
  ' }',
  '```',
].join('\n')

function makeProject(withSource = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-e2e-'))
  if (withSource) {
    fs.writeFileSync(path.join(dir, 'auth.ts'), AUTH_TS)
    execSync('git init && git add -A && git commit -m init', { cwd: dir, stdio: 'ignore' })
  }
  return dir
}

function writeWorkerScript(projectRoot: string, output: string): string {
  const script = path.join(projectRoot, 'worker.sh')
  fs.writeFileSync(script, `#!/bin/sh\ncat > /dev/null\necho '${output}'\n`, 'utf-8')
  fs.chmodSync(script, 0o755)
  return script
}

function writeOverlay(projectRoot: string, workerBin: string): void {
  const cortex = path.join(projectRoot, '.cortex')
  fs.mkdirSync(cortex, { recursive: true })
  fs.writeFileSync(path.join(cortex, 'workers.json'), JSON.stringify({
    workers: [
      {
        id: 'e2e-worker',
        capabilities: ['coding', 'reasoning'],
        harness: { kind: 'cli', bin: workerBin, args: [], stripEnv: [], promptVia: 'stdin', probeArgs: [] },
        cost: { inPer1k: 0.01, outPer1k: 0.01 },
        speed: 10,
        contextWindow: 100_000,
        quality: { coding: 0.5, reasoning: 0.5 },
        reliability: 0.9,
        tier: 2,
        writeAccess: 'patch',
      },
      {
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
      },
    ],
  }, null, 2))
}

test('e2e: success path produces all artifact types', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, GOOD_DIFF)
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const { artifacts, result, ucp } = outcome

  // Pre-execution planning artifacts
  assert.ok(artifacts.some(a => isKind(a, 'plan')), 'plan artifact')
  assert.ok(artifacts.some(a => isKind(a, 'context')), 'context artifact')
  assert.ok(artifacts.some(a => isKind(a, 'compression')), 'compression artifact')
  assert.ok(artifacts.some(a => isKind(a, 'cost')), 'cost artifact')

  // Per-iteration evaluation artifacts from loop
  const evaluations = artifacts.filter(a => isKind(a, 'evaluation'))
  assert.ok(evaluations.length >= 1, 'evaluation artifact')
  assert.equal(evaluations[0]!.body.decision, 'ACCEPT')

  // Post-loop summary artifacts
  assert.ok(artifacts.some(a => isKind(a, 'execution')), 'execution artifact')
  assert.ok(artifacts.some(a => isKind(a, 'final')), 'final artifact')

  // Worker output
  const patch = artifacts.find(a => isKind(a, 'patch'))
  assert.ok(patch, 'patch artifact')
  assert.ok(!artifacts.some(a => isKind(a, 'failure')), 'no failure artifact')

  // Correct completion
  assert.equal(result.accepted, true)
  assert.equal(result.state.status, 'finished')

  // Persistence: artifacts on disk
  const artifactDir = path.join(dir, '.cortex', 'artifacts', ucp.t)
  const files = fs.existsSync(artifactDir) ? fs.readdirSync(artifactDir) : []
  assert.ok(files.length >= artifacts.length, 'all artifacts persisted')

  // Persistence: state file
  const stateFile = path.join(dir, '.cortex', 'state.json')
  assert.ok(fs.existsSync(stateFile))
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  assert.equal(state.taskId, ucp.t)

  // Persistence: metrics
  const metricsFile = path.join(dir, '.cortex', 'metrics.jsonl')
  assert.ok(fs.existsSync(metricsFile))
  const lines = fs.readFileSync(metricsFile, 'utf-8').trim().split('\n')
  assert.ok(lines.length >= 1)
  const record = JSON.parse(lines[0]!)
  assert.equal(record.workerId, 'e2e-worker')
  assert.equal(record.ok, true)
})

test('e2e: failure path still produces full artifact chain', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, 'IMPOSSIBLE: e2e test failure simulation')
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const { artifacts, result } = outcome

  // Same planning artifacts as success
  assert.ok(artifacts.some(a => isKind(a, 'plan')), 'plan artifact')
  assert.ok(artifacts.some(a => isKind(a, 'context')), 'context artifact')
  assert.ok(artifacts.some(a => isKind(a, 'compression')), 'compression artifact')
  assert.ok(artifacts.some(a => isKind(a, 'cost')), 'cost artifact')

  // Evaluation artifact from loop
  assert.ok(artifacts.some(a => isKind(a, 'evaluation')), 'evaluation artifact')

  // Post-loop summary
  assert.ok(artifacts.some(a => isKind(a, 'execution')), 'execution artifact')
  assert.ok(artifacts.some(a => isKind(a, 'final')), 'final artifact')

  // Failure — not a patch
  assert.ok(artifacts.some(a => isKind(a, 'failure')), 'failure artifact')
  assert.ok(!artifacts.some(a => isKind(a, 'patch')), 'no patch artifact on failure')

  assert.equal(result.accepted, false)
  assert.equal(result.state.iteration, 1)
  assert.equal(result.state.status, 'finished')
})

test('e2e: compression artifact reports measurable token savings', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, GOOD_DIFF)
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const compressions = outcome.artifacts.filter(a => isKind(a, 'compression'))
  assert.ok(compressions.length >= 1, 'at least one compression artifact')

  for (const c of compressions) {
    assert.ok(typeof c.body.originalTokens === 'number' && c.body.originalTokens >= 0)
    assert.ok(typeof c.body.compressedTokens === 'number' && c.body.compressedTokens >= 0)
    assert.ok(typeof c.body.savedTokens === 'number' && c.body.savedTokens >= 0)
    assert.ok(typeof c.body.ratio === 'number' && c.body.ratio >= 0 && c.body.ratio <= 1)
  }
})

test('e2e: cost artifact tracks estimated budget', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, GOOD_DIFF)
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const cost = outcome.artifacts.find(a => isKind(a, 'cost'))
  assert.ok(cost, 'cost artifact present')
  assert.ok(typeof cost.body.promptTokens === 'number' && cost.body.promptTokens > 0)
  assert.ok(typeof cost.body.completionTokens === 'number')
  assert.ok(typeof cost.body.cumulativeCost === 'number' && cost.body.cumulativeCost > 0)
  assert.ok(typeof cost.body.compressionSavings === 'number')
  assert.ok(typeof cost.body.estimatedRemainingBudget === 'number')
})

test('e2e: evaluation artifact carries compressed issues and decision', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, 'IMPOSSIBLE: e2e eval test')
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const evaluations = outcome.artifacts.filter(a => isKind(a, 'evaluation'))
  assert.ok(evaluations.length >= 1)

  const evalArtifact = evaluations[0]!
  assert.ok(['ACCEPT', 'RETRY', 'ESCALATE', 'FINISH'].includes(evalArtifact.body.decision))
  assert.ok(typeof evalArtifact.body.confidence === 'number')
  assert.ok(Array.isArray(evalArtifact.body.issues))
  assert.ok(typeof evalArtifact.body.compressedText === 'string')
})

test('e2e: execution and final artifacts summarize the run', async () => {
  const dir = makeProject()
  const script = writeWorkerScript(dir, GOOD_DIFF)
  writeOverlay(dir, script)

  const outcome = await runTask('fix validateToken in auth.ts to reject empty tokens', {
    projectRoot: dir,
    timeoutMs: 10_000,
  })

  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') return

  const execution = outcome.artifacts.find(a => isKind(a, 'execution'))
  assert.ok(execution)
  assert.equal(typeof execution.body.accepted, 'boolean')
  assert.equal(typeof execution.body.iterations, 'number')
  assert.equal(typeof execution.body.cost, 'number')
  assert.ok(execution.body.iterations >= 1)

  const finalArtifact = outcome.artifacts.find(a => isKind(a, 'final'))
  assert.ok(finalArtifact)
  assert.equal(typeof finalArtifact.body.accepted, 'boolean')
  assert.equal(typeof finalArtifact.body.cost, 'number')
  assert.ok(finalArtifact.body.tokenUsage.promptTokens > 0)
})
