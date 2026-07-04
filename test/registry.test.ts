import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadRegistry, validateWorkerSpec } from '../src/worker/registry.js'

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'))
}

test('default registry loads with claude-cli as a tier-3 worker', () => {
  const registry = loadRegistry()
  const claude = registry.byId('claude-cli')
  assert.ok(claude)
  assert.equal(claude.tier, 3)
  assert.equal(claude.harness.kind, 'cli')
  assert.ok(claude.capabilities.includes('coding'))
})

test('project overlay adds and retires workers', () => {
  const root = tmpProject()
  fs.mkdirSync(path.join(root, '.cortex'), { recursive: true })
  fs.writeFileSync(path.join(root, '.cortex', 'workers.json'), JSON.stringify({
    workers: [
      {
        id: 'local-llm',
        capabilities: ['coding'],
        harness: { kind: 'http', url: 'http://localhost:11434/api/generate', method: 'POST', headers: {}, bodyTemplate: { prompt: '{{prompt}}' }, outputPath: 'response' },
        cost: { inPer1k: 0.01, outPer1k: 0.01 },
        speed: 2,
        contextWindow: 32000,
        quality: { coding: 0.5 },
        reliability: 0.7,
        tier: 1,
        writeAccess: 'patch',
      },
      { id: 'claude-cli', disabled: true,
        capabilities: ['coding'], harness: { kind: 'cli', bin: 'claude', args: [], stripEnv: [], promptVia: 'stdin', probeArgs: [] },
        cost: { inPer1k: 1, outPer1k: 1 }, speed: 1, contextWindow: 1000, quality: {}, reliability: 0.5, tier: 3, writeAccess: 'patch' },
    ],
  }))

  const registry = loadRegistry(root)
  assert.ok(registry.byId('local-llm'))
  assert.equal(registry.byId('claude-cli'), undefined)
})

test('invalid overlay specs are skipped, valid ones kept', () => {
  const root = tmpProject()
  fs.mkdirSync(path.join(root, '.cortex'), { recursive: true })
  fs.writeFileSync(path.join(root, '.cortex', 'workers.json'), JSON.stringify({
    workers: [{ id: 'broken', capabilities: ['not-a-capability'] }],
  }))
  const registry = loadRegistry(root)
  assert.equal(registry.byId('broken'), undefined)
  assert.ok(registry.byId('claude-cli'))
})

test('validateWorkerSpec reports every problem', () => {
  const errors = validateWorkerSpec({ id: 'x', capabilities: ['coding'], harness: { kind: 'carrier-pigeon' } })
  assert.ok(errors.some(e => e.includes('harness')))
  assert.ok(errors.some(e => e.includes('cost')))
  assert.ok(errors.some(e => e.includes('tier')))
})

test('withCapabilities requires full coverage', () => {
  const registry = loadRegistry()
  assert.ok(registry.withCapabilities(['coding', 'review']).some(w => w.id === 'claude-cli'))
  assert.equal(registry.withCapabilities(['vision']).length, 0)
})
