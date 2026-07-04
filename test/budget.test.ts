import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { enforceBudget, estimateSpend } from '../src/packet/budget-controller.js'
import { generateWorkPacket } from '../src/packet/generator.js'
import { DEFAULT_BUDGET, type CodeChunk } from '../src/core/types.js'

function makeChunk(file: string, name: string, score: number, sourceLen = 400): CodeChunk {
  return {
    file, name, kind: 'function',
    source: 'x'.repeat(sourceLen),
    startLine: 1, endLine: 20,
    signature: `function ${name}()`,
    score,
  }
}

test('budget keeps the highest-scored chunks within caps', () => {
  const chunks = [
    makeChunk('a.ts', 'low', 0.1),
    makeChunk('b.ts', 'high', 0.9),
    makeChunk('c.ts', 'mid', 0.5),
  ]
  const packet = generateWorkPacket('fix things', chunks, [])
  const result = enforceBudget(packet, chunks, { ...DEFAULT_BUDGET, maxChunks: 2 })
  assert.equal(result.chunks.length, 2)
  assert.equal(result.chunks[0]!.name, 'high')
  assert.equal(result.chunks[1]!.name, 'mid')
})

test('maxFiles cap skips chunks from extra files', () => {
  const chunks = [
    makeChunk('a.ts', 'one', 0.9),
    makeChunk('b.ts', 'two', 0.8),
    makeChunk('c.ts', 'three', 0.7),
  ]
  const packet = generateWorkPacket('fix things', chunks, [])
  const result = enforceBudget(packet, chunks, { ...DEFAULT_BUDGET, maxFiles: 2 })
  const files = new Set(result.chunks.map(c => c.file))
  assert.ok(files.size <= 2)
})

test('token overrun degrades by dropping chunks, never expanding', () => {
  const chunks = Array.from({ length: 7 }, (_, i) => makeChunk(`f${i}.ts`, `fn${i}`, 1 - i * 0.1, 2000))
  const packet = generateWorkPacket('fix many things in many places', chunks, [])
  const result = enforceBudget(packet, chunks, { ...DEFAULT_BUDGET, maxInputTokens: 800, maxFiles: 7 })
  assert.ok(result.totalTokens <= 800 || result.exceeded)
  assert.ok(result.chunks.length < 7)
})

test('spend estimate inflates by retry probability', () => {
  const spend = estimateSpend(1000, { inPer1k: 3, outPer1k: 15 }, 0.25, 1000)
  // base = 3 + 15 = 18; ×1.25 = 22.5
  assert.ok(Math.abs(spend.expectedSpend - 22.5) < 0.001)
})

test('maxSpend policy gate refuses instead of silently dispatching', () => {
  const chunks = [makeChunk('a.ts', 'fn', 0.9)]
  const packet = generateWorkPacket('fix fn', chunks, [])
  const result = enforceBudget(
    packet, chunks,
    { ...DEFAULT_BUDGET, maxSpend: 0.0001 },
    { cost: { inPer1k: 3, outPer1k: 15 } },
  )
  assert.equal(result.refused, true)
  assert.ok(result.refusedReason?.includes('exceeds cap'))
})
