import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { applyPatch, runValidationHooks } from '../src/validator/patch-apply.js'

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-patch-'))
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email test@example.com && git config user.name test', { cwd: dir })
  fs.writeFileSync(path.join(dir, 'greet.ts'), 'export const greeting = "hello"\n')
  execSync('git add -A && git commit -qm init', { cwd: dir })
  return dir
}

const PATCH = [
  '--- a/greet.ts',
  '+++ b/greet.ts',
  '@@ -1 +1 @@',
  '-export const greeting = "hello"',
  '+export const greeting = "goodbye"',
  '',
].join('\n')

test('applyPatch applies a valid unified diff to the working tree', () => {
  const dir = makeGitRepo()
  assert.equal(applyPatch(PATCH, dir), true)
  assert.equal(fs.readFileSync(path.join(dir, 'greet.ts'), 'utf-8'), 'export const greeting = "goodbye"\n')
})

test('applyPatch strips invented hunk context after @@', () => {
  const dir = makeGitRepo()
  const withContext = PATCH.replace('@@ -1 +1 @@', '@@ -1 +1 @@ export function inventedContext()')
  assert.equal(applyPatch(withContext, dir), true)
})

test('applyPatch returns false when every strategy fails', () => {
  const dir = makeGitRepo()
  const garbage = '--- a/missing.ts\n+++ b/missing.ts\n@@ -99 +99 @@\n-not there\n+still not there\n'
  assert.equal(applyPatch(garbage, dir), false)
  // The working tree is untouched.
  assert.equal(fs.readFileSync(path.join(dir, 'greet.ts'), 'utf-8'), 'export const greeting = "hello"\n')
})

test('runValidationHooks passes when package.json declares no hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hooks-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }))
  const result = runValidationHooks(dir)
  assert.equal(result.passed, true)
  assert.equal(result.output, 'no hooks configured')
})

test('runValidationHooks reports a failing hook with extracted errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-hooks-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: { typecheck: 'node -e "console.error(\'error TS9999: fixture failure\'); process.exit(1)"' },
  }))
  const result = runValidationHooks(dir)
  assert.equal(result.passed, false)
  assert.ok(result.errors.some(e => e.includes('TS9999')))
})
