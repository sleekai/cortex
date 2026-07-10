import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import '../src/skill/builtins.js'
import '../src/blueprint/builtins.js'
import { getBlueprint, registerBlueprint, registeredBlueprints, type Blueprint } from '../src/blueprint/blueprint.js'
import { executeBlueprint, type BlueprintRunConfig, type ProduceResult } from '../src/blueprint/runner.js'
import { registerSkill } from '../src/skill/registry.js'
import { type Skill, observation } from '../src/skill/skill.js'
import { DEFAULT_POLICIES, mergePolicies } from '../src/policy/policies.js'
import { makeArtifact } from '../src/artifact/artifacts.js'

const okProduce = (): Promise<ProduceResult> => Promise.resolve({
  artifacts: [makeArtifact('patch', 't-bp', 'w0', { diff: 'd', reasoning: 'r' })],
  accepted: true,
  summary: { iterations: 1, escalationDepth: 0, cost: 1, terminationReason: 'accepted', status: 'finished' },
})

function runConfig(task: string, overrides?: Partial<BlueprintRunConfig>): BlueprintRunConfig {
  return {
    taskId: 't-bp',
    task,
    raw: task,
    projectRoot: process.cwd(),
    policies: DEFAULT_POLICIES,
    produce: okProduce,
    ...overrides,
  }
}

test('built-in blueprints are registered', () => {
  for (const name of ['debug', 'feature', 'pr-review', 'default']) {
    assert.ok(getBlueprint(name), `missing blueprint ${name}`)
  }
  assert.ok(registeredBlueprints().length >= 4)
})

test('clear task runs triage, skips grilling, and produces', async () => {
  const bp = getBlueprint('debug')!
  const outcome = await executeBlueprint(bp, runConfig('fix the null pointer crash in parseArgs in src/index.ts'))
  assert.equal(outcome.kind, 'completed')
  assert.ok(outcome.kind === 'completed' && outcome.accepted)

  const byId = new Map(outcome.steps.map(s => [s.id, s]))
  assert.equal(byId.get('triage')?.ran, true)
  assert.equal(byId.get('grill')?.ran, false) // clear task → grilling not applicable
  assert.equal(byId.get('produce')?.ran, true)
  assert.ok(outcome.artifacts.some(a => a.kind === 'intent'))
  assert.ok(outcome.artifacts.some(a => a.kind === 'patch'))
})

test('ambiguous task halts for clarification before producing (halt policy)', async () => {
  const bp = getBlueprint('debug')!
  let produced = false
  const outcome = await executeBlueprint(bp, runConfig('fix it', {
    produce: () => { produced = true; return okProduce() },
  }))
  assert.equal(outcome.kind, 'clarification')
  assert.ok(outcome.kind === 'clarification' && outcome.questions.length > 0)
  assert.equal(produced, false) // never reached produce — cheap-first discipline
})

test('proceed-mode clarification policy grills but keeps executing', async () => {
  const bp = getBlueprint('debug')!
  const policies = mergePolicies(DEFAULT_POLICIES, {
    clarification: {
      name: 'proceed-clar',
      ambiguityThreshold: 0.5,
      mode: 'proceed',
      shouldClarify(score: number) { return score <= this.ambiguityThreshold },
    },
  })
  const outcome = await executeBlueprint(bp, runConfig('fix it', { policies }))
  assert.equal(outcome.kind, 'completed')
  assert.ok(outcome.artifacts.some(a => a.kind === 'clarification')) // questions recorded
  assert.ok(outcome.artifacts.some(a => a.kind === 'patch')) // but execution continued
})

test('blueprint policy overrides merge over the run policies', async () => {
  // debug blueprint raises maxIterations to 6; the runner must hand skills the
  // merged set. A probe skill records what it saw.
  let seenMaxIter = 0
  const probe: Skill = {
    name: 'probe-policy',
    purpose: 'test',
    meta: { profile: { minimum: [] }, consumes: [], produces: [], costLevel: 'free', deterministic: true },
    applicable: () => true,
    execute: (ctx) => {
      seenMaxIter = ctx.policies.retry.maxIterations
      return { artifacts: [], observations: observation() }
    },
  }
  registerSkill(probe)
  const bp: Blueprint = {
    name: 'probe-bp',
    description: 'test',
    steps: [{ id: 'probe', kind: 'skill', skill: 'probe-policy' }],
    policies: { retry: { name: 'probe-retry', maxIterations: 42 } },
  }
  registerBlueprint(bp)
  await executeBlueprint(bp, runConfig('anything'))
  assert.equal(seenMaxIter, 42)
})

test('step conditions gate execution against the blackboard', async () => {
  const bp: Blueprint = {
    name: 'cond-bp',
    description: 'test',
    steps: [
      { id: 'triage', kind: 'skill', skill: 'triage' },
      { id: 'produce', kind: 'produce', when: (view) => view.blackboard['triage'] === undefined },
    ],
  }
  registerBlueprint(bp)
  const outcome = await executeBlueprint(bp, runConfig('add a retry count field to the config parser in src/index.ts'))
  assert.equal(outcome.kind, 'completed')
  const produce = outcome.steps.find(s => s.id === 'produce')!
  assert.equal(produce.ran, false)
  assert.equal(produce.reason, 'condition false')
})

test('a step naming an unregistered skill fails loud', async () => {
  const bp: Blueprint = {
    name: 'broken-bp',
    description: 'test',
    steps: [{ id: 'ghost', kind: 'skill', skill: 'does-not-exist' }],
  }
  registerBlueprint(bp)
  await assert.rejects(
    () => executeBlueprint(bp, runConfig('anything')),
    /unregistered skill "does-not-exist"/,
  )
})

test('produce result lands on the blackboard and in the outcome', async () => {
  const bp = getBlueprint('feature')!
  const outcome = await executeBlueprint(bp, runConfig('add a --verbose flag to the CLI arg parser in src/index.ts'))
  assert.equal(outcome.kind, 'completed')
  assert.ok(outcome.kind === 'completed' && outcome.produce)
  assert.equal(outcome.kind === 'completed' && outcome.produce!.summary.terminationReason, 'accepted')
})
