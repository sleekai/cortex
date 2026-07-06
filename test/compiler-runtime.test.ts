import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { type TaskIntent } from '../src/capability/capabilities.js'
import { type CompiledContext } from '../src/retrieval/context-compiler.js'
import { type BudgetConfig, DEFAULT_BUDGET } from '../src/core/types.js'
import { type Artifact } from '../src/artifact/artifacts.js'
import {
  DEFAULT_COMPILER_RUNTIME,
  type CompilerRuntime,
} from '../src/compiler/runtime.js'
import { compileIntent } from '../src/capability/intent-compiler.js'
import { makeArtifact } from '../src/artifact/artifacts.js'
import { planTask, prepareDispatch, runLocate, type KernelConfig } from '../src/kernel/index.js'
import '../src/harness/cli-harness.js'

const FIXED_INTENT: TaskIntent = {
  taskType: 'patch',
  complexity: 'trivial',
  capabilities: ['coding'],
  requiredArtifacts: [],
  expectedOutput: 'patch',
  estTokenBudget: 800,
  estReasoningDepth: 0,
  confidence: 0.9,
  fileHints: [],
}

const FIXED_CONTEXT: CompiledContext = {
  level: 0,
  chunks: [],
  pointers: ['src/test.ts'],
  estTokens: 10,
  escalations: [],
}

const FIXED_ARTIFACT: Artifact = {
  id: 'fake-id',
  kind: 'cost',
  taskId: 't-fake',
  createdAt: '2026-01-01T00:00:00.000Z',
  producedBy: 'fake',
  body: {
    promptTokens: 0, completionTokens: 0, cumulativeCost: 0,
    compressionSavings: 0, escalationCost: 0, estimatedRemainingBudget: Infinity,
  },
}

function makeProject(withSource = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-runtime-'))
  if (withSource) {
    fs.writeFileSync(path.join(dir, 'auth.ts'), [
      'export function validateToken(token: string): boolean {',
      '  return token.length > 0 && !token.includes(" ")',
      '}',
    ].join('\n'))
  }
  return dir
}

test('DEFAULT_COMPILER_RUNTIME matches direct imports (intent compiler)', () => {
  const result = DEFAULT_COMPILER_RUNTIME.compileIntent('fix typo in README.md')
  const direct = compileIntent('fix typo in README.md')
  assert.deepEqual(result, direct)
})

test('DEFAULT_COMPILER_RUNTIME matches direct imports (artifact factory)', () => {
  const result = DEFAULT_COMPILER_RUNTIME.makeArtifact('plan', 't-test', 'test', { steps: ['a'], workerLadder: ['w'], entryTier: 1, expectedSpend: 2 })
  const direct = makeArtifact('plan', 't-test', 'test', { steps: ['a'], workerLadder: ['w'], entryTier: 1, expectedSpend: 2 })
  assert.equal(result.kind, direct.kind)
  assert.equal(result.taskId, direct.taskId)
  assert.equal(result.producedBy, direct.producedBy)
  assert.deepEqual(result.body, direct.body)
})

test('planTask injected runtime overrides intent compiler', () => {
  const recorded: string[] = []
  const stub: CompilerRuntime = {
    ...DEFAULT_COMPILER_RUNTIME,
    compileIntent: (r: string) => {
      recorded.push(r)
      return FIXED_INTENT
    },
  }
  const dir = makeProject(false)
  const { intent } = planTask('anything', dir, undefined, undefined, undefined, undefined, stub)
  assert.equal(intent.taskType, 'patch')
  assert.ok(recorded.includes('anything'))
})

test('prepareDispatch KernelConfig.compilerRuntime reaches artifact factories', () => {
  const dir = makeProject()
  const made: { kind: string; producedBy: string }[] = []
  const stub: CompilerRuntime = {
    compileIntent: DEFAULT_COMPILER_RUNTIME.compileIntent,
    compileContext: DEFAULT_COMPILER_RUNTIME.compileContext,
    makeArtifact: (kind, _taskId, producedBy, body) => {
      made.push({ kind, producedBy })
      return DEFAULT_COMPILER_RUNTIME.makeArtifact(kind, _taskId, producedBy, body as never)
    },
  }
  const config: KernelConfig = { projectRoot: dir, compilerRuntime: stub }
  const prepared = prepareDispatch('fix token validation in auth.ts', config)
  assert.ok(made.length > 0)
  if (prepared.kind === 'packet') {
    assert.ok(made.some(m => m.kind === 'plan'), `expected plan artifact, got: ${JSON.stringify(made)}`)
    assert.ok(made.some(m => m.kind === 'context'), `expected context artifact, got: ${JSON.stringify(made)}`)
  }
})

test('runLocate with injected runtime uses custom compileIntent', () => {
  const recorded: string[] = []
  const stub: CompilerRuntime = {
    ...DEFAULT_COMPILER_RUNTIME,
    compileIntent: (r: string) => {
      recorded.push(r)
      return { ...FIXED_INTENT, taskType: 'locate' }
    },
  }
  const dir = makeProject()
  runLocate('find auth.ts', dir, undefined, stub)
  assert.ok(recorded.some(r => r.includes('auth')), `expected recorded to include auth, got: ${JSON.stringify(recorded)}`)
})
