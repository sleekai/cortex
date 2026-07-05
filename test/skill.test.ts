import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import '../src/skill/builtins.js'
import { getSkill, registeredSkills, registerSkill } from '../src/skill/registry.js'
import { triageSkill, grillingSkill, recommendBlueprint, type TriageData } from '../src/skill/builtins.js'
import { type Skill, type SkillContext, observation } from '../src/skill/skill.js'
import { DEFAULT_POLICIES, mergePolicies } from '../src/policy/policies.js'
import { isKind, type Artifact } from '../src/artifact/artifacts.js'
import { compileIntent } from '../src/capability/intent-compiler.js'

function ctxFor(task: string, overrides?: Partial<SkillContext>): SkillContext {
  return {
    taskId: 't-test',
    task,
    raw: task,
    projectRoot: process.cwd(),
    policies: DEFAULT_POLICIES,
    blackboard: {},
    artifacts: [],
    ...overrides,
  }
}

test('built-in skills are registered', () => {
  for (const name of ['triage', 'grilling', 'summarize', 'review']) {
    assert.ok(getSkill(name), `missing skill ${name}`)
  }
  assert.ok(registeredSkills().length >= 4)
})

test('custom skills register through the same seam', () => {
  const custom: Skill = {
    name: 'noop-test-skill',
    purpose: 'test',
    meta: { capabilities: [], costLevel: 'free', deterministic: true },
    applicable: () => true,
    execute: () => ({ artifacts: [], observations: observation() }),
  }
  registerSkill(custom)
  assert.equal(getSkill('noop-test-skill'), custom)
})

test('triage skill emits intent artifact and blueprint recommendation', async () => {
  const ctx = ctxFor('fix the failing login validation bug in auth.ts')
  assert.equal(triageSkill.applicable(ctx), true)
  const outcome = await triageSkill.execute(ctx)
  const data = outcome.data as TriageData

  assert.ok(data.cts)
  assert.ok(data.intent)
  assert.equal(data.blueprint, 'debug') // "fix ... bug" routes to debug
  assert.ok(outcome.artifacts.some(a => a.kind === 'intent'))
  assert.ok(outcome.artifacts.some(a => a.kind === 'triage'))
})

test('triage skill skips when its data is already on the blackboard', async () => {
  const ctx = ctxFor('anything')
  const outcome = await triageSkill.execute(ctxFor('fix parser bug in x.ts'))
  ctx.blackboard['triage'] = outcome.data
  assert.equal(triageSkill.applicable(ctx), false)
})

test('grilling applies only when policy says the ambiguity justifies it', async () => {
  // Vague, tiny task → low ambiguity score → grill.
  const vague = await triageSkill.execute(ctxFor('fix it'))
  const vagueCtx = ctxFor('fix it')
  vagueCtx.blackboard['triage'] = vague.data
  assert.equal(grillingSkill.applicable(vagueCtx), true)

  const outcome = await grillingSkill.execute(vagueCtx)
  const clar = outcome.artifacts.find(a => isKind(a, 'clarification')) as Artifact<'clarification'> | undefined
  assert.ok(clar)
  assert.ok(clar.body.questions.length > 0)
  // Default clarification policy halts → grilling recommends clarify.
  assert.equal(outcome.observations.recommendedAction, 'clarify')

  // Clear, specific task → no grilling.
  const clear = await triageSkill.execute(ctxFor('add a null check to parseArgs in src/index.ts when argv is empty'))
  const clearCtx = ctxFor('add a null check to parseArgs in src/index.ts when argv is empty')
  clearCtx.blackboard['triage'] = clear.data
  assert.equal(grillingSkill.applicable(clearCtx), false)
})

test('grilling under proceed-mode policy recommends proceed, still surfaces questions', async () => {
  const policies = mergePolicies(DEFAULT_POLICIES, {
    clarification: {
      name: 'proceed-clar',
      ambiguityThreshold: 0.5,
      mode: 'proceed',
      shouldClarify(score: number) { return score <= this.ambiguityThreshold },
    },
  })
  const ctx = ctxFor('fix it', { policies })
  ctx.blackboard['triage'] = (await triageSkill.execute(ctx)).data
  const outcome = await grillingSkill.execute(ctx)
  assert.equal(outcome.observations.recommendedAction, 'proceed')
  assert.ok(outcome.artifacts.some(a => isKind(a, 'clarification')))
})

test('LLM-backed skills are inapplicable without a dispatch seam', () => {
  const ctx = ctxFor('review this change')
  assert.equal(getSkill('summarize')!.applicable(ctx), false)
  assert.equal(getSkill('review')!.applicable(ctx), false)
  const withDispatch = ctxFor('review this change', {
    dispatch: async (packet) => ({ id: 'x', kind: 'decision', taskId: packet.t, createdAt: '', producedBy: 'w', body: { question: '', decision: 'ok', why: '' } }),
  })
  assert.equal(getSkill('summarize')!.applicable(withDispatch), true)
})

test('recommendBlueprint maps task shapes to blueprints', () => {
  assert.equal(recommendBlueprint(compileIntent('review the auth changes'), 'review the auth changes'), 'pr-review')
  assert.equal(recommendBlueprint(compileIntent('fix crash in parser'), 'fix crash in parser'), 'debug')
  assert.equal(recommendBlueprint(compileIntent('add pagination to the users endpoint'), 'add pagination to the users endpoint'), 'feature')
})
