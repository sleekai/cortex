import { execSync } from 'node:child_process'
import { type ValidationResult } from '../core/types.js'
import { info, warn, debug } from '../core/logger.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Workers often emit stale or invented function context after the closing
// `@@` of a hunk header; git/patch only need the line numbers, so stripping
// the context is safer than attempting to repair it.
function stripHunkContext(patch: string): string {
  return patch.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm, '$1')
}

export function applyPatch(patch: string, projectRoot: string): boolean {
  const patchPath = path.join(os.tmpdir(), `ucp-apply-${Date.now()}.patch`)
  const sanitized = stripHunkContext(patch)
  // git apply requires a trailing newline on the last hunk line
  fs.writeFileSync(patchPath, sanitized.endsWith('\n') ? sanitized : sanitized + '\n', 'utf-8')

  const attempts = [
    `git apply --whitespace=fix "${patchPath}"`,
    `git apply --3way --whitespace=fix "${patchPath}"`,
    `patch -p1 --batch --forward < "${patchPath}"`,
  ]

  for (const cmd of attempts) {
    try {
      execSync(cmd, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      info(`patch applied via: ${cmd.split(' ').slice(0, 2).join(' ')}`)
      return true
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      debug(`apply attempt failed (${cmd}): ${msg}`)
    }
  }

  warn('all patch apply strategies failed')
  return false
}

function findTestCommand(projectRoot: string): string[] {
  const pkgPath = path.join(projectRoot, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const scripts: Record<string, string> = pkg.scripts ?? {}
    const candidates = ['typecheck', 'type-check', 'lint', 'test']
    const found: string[] = []
    for (const c of candidates) {
      if (scripts[c]) {
        found.push(c)
      }
    }
    return found
  } catch {
    return []
  }
}

export function runValidationHooks(projectRoot: string): ValidationResult {
  const hooks = findTestCommand(projectRoot)

  if (hooks.length === 0) {
    info('no validation hooks found in package.json')
    return { passed: true, errors: [], output: 'no hooks configured', iteration: 0 }
  }

  for (const hook of hooks) {
    info(`running: npm run ${hook}`)
    try {
      const out = execSync(`npm run ${hook} 2>&1`, {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      })
      info(`${hook}: passed`)
      debug(out)
    } catch (e: unknown) {
      // execSync puts the process output on e.stdout/e.stderr, not in the
      // message — the message alone would leave error extraction (and the
      // error-only retry packets built from it) empty.
      const err = e as { message?: string; stdout?: string; stderr?: string }
      const combined = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n')
      warn(`${hook}: FAILED`)
      return {
        passed: false,
        errors: extractErrors(combined),
        output: combined,
        iteration: 0,
      }
    }
  }

  return { passed: true, errors: [], output: 'all hooks passed', iteration: 0 }
}

function extractErrors(output: string): string[] {
  const lines = output.split('\n')
  const errors: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/error/i.test(trimmed) && trimmed.length > 10 && trimmed.length < 200) {
      errors.push(trimmed)
    }
  }
  return errors.slice(0, 5)
}
