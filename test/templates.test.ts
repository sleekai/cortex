import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { codexAdapter, cursorAdapter, opencodeAdapter } from '../src/worker/templates.js'

function cliHarness(spec: ReturnType<typeof opencodeAdapter>) {
  assert.equal(spec.harness.kind, 'cli')
  return spec.harness
}

test('opencodeAdapter uses run subcommand with auto-approve and arg prompt', () => {
  const spec = opencodeAdapter({ id: 'opencode' })
  const harness = cliHarness(spec)
  assert.equal(harness.bin, 'opencode')
  assert.deepEqual(harness.args, ['run', '--format', 'default', '--auto'])
  assert.equal(harness.promptVia, 'arg')
  assert.ok(!JSON.stringify(harness.args).includes('{{prompt}}'))
})

test('codexAdapter uses codex exec in full-auto mode', () => {
  const spec = codexAdapter({ id: 'codex' })
  const harness = cliHarness(spec)
  assert.equal(harness.bin, 'codex')
  assert.deepEqual(harness.args, ['exec', '--full-auto'])
  assert.equal(harness.promptVia, 'arg')
  assert.equal(harness.binEnvOverride, 'CODEX_BIN')
})

test('cursorAdapter uses agent headless flags', () => {
  const spec = cursorAdapter({ id: 'cursor' })
  const harness = cliHarness(spec)
  assert.equal(harness.bin, 'agent')
  assert.deepEqual(harness.args, ['-p', '--trust', '--force', '--output-format', 'text'])
  assert.equal(harness.promptVia, 'arg')
  assert.equal(harness.binEnvOverride, 'CURSOR_AGENT_BIN')
})
