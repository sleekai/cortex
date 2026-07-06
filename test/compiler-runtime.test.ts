import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { type TaskIntent } from '../src/capability/capabilities.js'
import { type CompiledContext } from '../src/retrieval/context-compiler.js'
import { type BudgetConfig, DEFAULT_BUDGET } from '../src/core/types.js'
import { type Artifact } from '../src/artifact/artifacts.js'
import {
  getCompilerRuntime,
  setCompilerRuntime,
  resetCompilerRuntime,
  type CompilerRuntime,
} from '../src/compiler/runtime.js'
import { compileIntent } from '../src/capability/intent-compiler.js'
import { makeArtifact } from '../src/artifact/artifacts.js'

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

test('default runtime matches direct imports (intent compiler)', () => {
  const result = getCompilerRuntime().compileIntent('fix typo in README.md')
  const direct = compileIntent('fix typo in README.md')
  assert.deepEqual(result, direct)
})

test('default runtime matches direct imports (artifact factory)', () => {
  const result = getCompilerRuntime().makeArtifact('plan', 't-test', 'test', { steps: ['a'], workerLadder: ['w'], entryTier: 1, expectedSpend: 2 })
  const direct = makeArtifact('plan', 't-test', 'test', { steps: ['a'], workerLadder: ['w'], entryTier: 1, expectedSpend: 2 })
  assert.equal(result.kind, direct.kind)
  assert.equal(result.taskId, direct.taskId)
  assert.equal(result.producedBy, direct.producedBy)
  assert.deepEqual(result.body, direct.body)
})

test('setCompilerRuntime overrides intent compiler', () => {
  const restore = setCompilerRuntime({
    compileIntent: () => FIXED_INTENT,
  })
  try {
    const result = getCompilerRuntime().compileIntent('anything')
    assert.equal(result.taskType, 'patch')
    assert.equal(result.complexity, 'trivial')
    assert.equal(result.confidence, 0.9)
  } finally {
    restore()
  }
})

test('setCompilerRuntime overrides context compiler', () => {
  const restore = setCompilerRuntime({
    compileContext: () => FIXED_CONTEXT,
  })
  try {
    const result = getCompilerRuntime().compileContext('', '', FIXED_INTENT, DEFAULT_BUDGET)
    assert.equal(result.level, 0)
    assert.deepEqual(result.pointers, ['src/test.ts'])
  } finally {
    restore()
  }
})

test('setCompilerRuntime overrides artifact factory', () => {
  const restore = setCompilerRuntime({
    makeArtifact: ((kind: string, taskId: string, producedBy: string, body: unknown) => ({
      id: 'fake-id',
      kind,
      taskId,
      createdAt: '2026-01-01T00:00:00.000Z',
      producedBy,
      body,
    })) as CompilerRuntime['makeArtifact'],
  })
  try {
    const result = getCompilerRuntime().makeArtifact('cost', 't-fake', 'fake', {
      promptTokens: 0, completionTokens: 0, cumulativeCost: 0,
      compressionSavings: 0, escalationCost: 0, estimatedRemainingBudget: Infinity,
    })
    assert.equal(result.id, 'fake-id')
    assert.equal(result.taskId, 't-fake')
  } finally {
    restore()
  }
})

test('partial override keeps other compilers at defaults', () => {
  const restore = setCompilerRuntime({
    compileIntent: () => FIXED_INTENT,
  })
  try {
    const result = getCompilerRuntime()
    assert.equal(result.compileIntent('x').taskType, 'patch')
    assert.notEqual(result.compileContext, undefined)
    assert.notEqual(result.makeArtifact, undefined)
  } finally {
    restore()
  }
})

test('resetCompilerRuntime restores defaults', () => {
  setCompilerRuntime({
    compileIntent: () => FIXED_INTENT,
  })
  resetCompilerRuntime()
  const result = getCompilerRuntime().compileIntent('fix typo in README.md')
  const direct = compileIntent('fix typo in README.md')
  assert.deepEqual(result, direct)
})

test('restore function restores previous runtime', () => {
  const restore = setCompilerRuntime({
    compileIntent: () => FIXED_INTENT,
  })
  restore()
  const result = getCompilerRuntime().compileIntent('fix typo in README.md')
  const direct = compileIntent('fix typo in README.md')
  assert.deepEqual(result, direct)
})
