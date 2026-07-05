import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { compileContext } from '../src/retrieval/context-compiler.js'
import { compileIntent } from '../src/capability/intent-compiler.js'
import { DEFAULT_BUDGET } from '../src/core/types.js'

// Fixture repo: a handful of TS files with distinct identifiers so TF-IDF
// ranking has something to bite on. Built once per run in a temp dir.
function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ctx-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), [
    'export function validateToken(token: string): boolean {',
    '  return token.length > 0',
    '}',
    'export function refreshSession(sessionId: string): void {',
    '  // session refresh logic',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'src', 'billing.ts'), [
    'export function computeInvoiceTotal(items: number[]): number {',
    '  return items.reduce((a, b) => a + b, 0)',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'src', 'parser.ts'), [
    'export function parseManifest(raw: string): object {',
    '  return JSON.parse(raw)',
    '}',
  ].join('\n'))
  return dir
}

const repo = makeFixtureRepo()

test('locate intent stays at the signature level — pointers, no climb', () => {
  const intent = compileIntent('find where validateToken is defined')
  const ctx = compileContext(repo, 'validateToken', intent, DEFAULT_BUDGET)
  assert.equal(intent.taskType, 'locate')
  assert.equal(ctx.level, 2)
  // L2 chunks are signature stubs, not source slices
  for (const c of ctx.chunks) assert.equal(c.source, c.signature)
  assert.ok(ctx.pointers.some(p => p.includes('validateToken')))
  assert.equal(ctx.escalations.length, 1) // entry only — locate never climbs
})

test('patch intent enters at L3 with ranked source chunks', () => {
  const intent = compileIntent('fix validateToken to reject empty tokens')
  const ctx = compileContext(repo, 'validateToken token', intent, DEFAULT_BUDGET)
  assert.equal(ctx.level, 3)
  assert.ok(ctx.chunks.length > 0)
  // goal names validateToken — the auth chunk must rank at the top
  assert.equal(ctx.chunks[0]!.name, 'validateToken')
})

test('file hints outrank keyword similarity', () => {
  const intent = compileIntent('fix the bug in src/billing.ts')
  const ctx = compileContext(repo, 'fix the bug', intent, DEFAULT_BUDGET)
  assert.ok(ctx.chunks.length > 0)
  assert.equal(ctx.chunks[0]!.file, path.join('src', 'billing.ts'))
})

test('chunk file paths are repo-relative', () => {
  const intent = compileIntent('fix validateToken to reject empty tokens')
  const ctx = compileContext(repo, 'validateToken', intent, DEFAULT_BUDGET)
  for (const c of ctx.chunks) {
    assert.ok(!path.isAbsolute(c.file), `expected relative path, got ${c.file}`)
  }
})

test('empty repo yields no chunks and records the entry level', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-empty-'))
  const intent = compileIntent('fix the login bug')
  const ctx = compileContext(empty, 'login', intent, DEFAULT_BUDGET)
  assert.equal(ctx.chunks.length, 0)
  assert.ok(ctx.escalations[0]!.startsWith('entry L'))
})

test('compilation is deterministic for identical inputs', () => {
  const intent = compileIntent('fix validateToken to reject empty tokens')
  const a = compileContext(repo, 'validateToken', intent, DEFAULT_BUDGET)
  const b = compileContext(repo, 'validateToken', intent, DEFAULT_BUDGET)
  assert.deepEqual(a.pointers, b.pointers)
  assert.deepEqual(a.chunks.map(c => `${c.file}:${c.name}`), b.chunks.map(c => `${c.file}:${c.name}`))
})
