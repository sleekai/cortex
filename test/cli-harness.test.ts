import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import '../src/harness/cli-harness.js'
import { createHarness, type CliHarnessConfig } from '../src/harness/harness.js'

function cliConfig(overrides: Partial<CliHarnessConfig>): CliHarnessConfig {
  return {
    kind: 'cli',
    bin: 'echo',
    args: [],
    stripEnv: [],
    promptVia: 'arg',
    probeArgs: ['ok'],
    ...overrides,
  }
}

test('availability probe succeeds for a real binary', () => {
  const harness = createHarness(cliConfig({}))
  assert.equal(harness.available(), true)
})

test('availability probe fails for a missing binary', () => {
  const harness = createHarness(cliConfig({ bin: 'definitely-not-a-real-binary-xyz' }))
  assert.equal(harness.available(), false)
})

test('promptVia arg delivers the prompt as the final argument', async () => {
  const harness = createHarness(cliConfig({}))
  const result = await harness.invoke({ prompt: 'hello worker', timeoutMs: 5000, maxOutputBytes: 1024 })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'hello worker')
})

test('promptVia stdin pipes the prompt through stdin', async () => {
  const harness = createHarness(cliConfig({ bin: 'cat', promptVia: 'stdin', probeArgs: [] }))
  const result = await harness.invoke({ prompt: 'piped prompt', timeoutMs: 5000, maxOutputBytes: 1024 })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'piped prompt')
})

test('non-zero exit becomes ok:false with the exit reason', async () => {
  const harness = createHarness(cliConfig({ bin: 'false', args: [], promptVia: 'stdin' }))
  const result = await harness.invoke({ prompt: 'x', timeoutMs: 5000, maxOutputBytes: 1024 })
  assert.equal(result.ok, false)
  assert.ok(result.failReason)
})

test('timeout kills the process and reports it', async () => {
  const harness = createHarness(cliConfig({ bin: 'sleep', args: ['5'], promptVia: 'stdin' }))
  const result = await harness.invoke({ prompt: 'x', timeoutMs: 150, maxOutputBytes: 1024 })
  assert.equal(result.ok, false)
  assert.ok(result.failReason!.includes('timeout'))
})
