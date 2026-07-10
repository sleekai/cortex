// SLE-70 Milestone 1 — kernel typed primitives.
// Covers the three acceptance criteria:
//   1. Core types compile independently of any agent provider (this file
//      imports only from src/kernel/primitives, nothing from worker/harness/
//      loop/runtime — if that ever changes, the import list here is the tell).
//   2. Fixtures round-trip through serialization.
//   3. Invalid blueprints fail with useful typed validation errors.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  serialize, deserialize, roundTrip, canonicalEqual,
  validateBlueprint, validatePrimitive, validateAgent,
  KernelValidationError, ALL_PRIMITIVE_KINDS,
  fixtures,
} from '../src/kernel/primitives/index.js'
import { type Primitive, type BlueprintPrimitive } from '../src/kernel/primitives/primitives.js'

const GOLDEN = path.resolve(process.cwd(), 'src/kernel/primitives/fixtures/simple-task-blueprint.golden.json')

test('all nine primitive kinds have a fixture', () => {
  const kinds = Object.keys(fixtures.ALL_FIXTURES).sort()
  assert.deepEqual(kinds, [...ALL_PRIMITIVE_KINDS].sort())
})

test('every fixture round-trips through serialization (AC2)', () => {
  for (const [kind, fixture] of Object.entries(fixtures.ALL_FIXTURES)) {
    const r = roundTrip(fixture as Primitive)
    assert.ok(r.ok, `${kind} failed to round-trip: ${r.ok ? '' : r.error.message}`)
    assert.deepEqual(r.value, fixture, `${kind} changed across round-trip`)
    assert.ok(canonicalEqual(r.value, fixture as Primitive))
  }
})

test('serialization is canonical — key order does not affect output', () => {
  const a = serialize(fixtures.fixtureTask)
  // Rebuild the same task with keys inserted in a different order.
  const shuffled = {
    estTokenBudget: fixtures.fixtureTask.estTokenBudget,
    blueprint: fixtures.fixtureTask.blueprint,
    kind: fixtures.fixtureTask.kind,
    normalized: fixtures.fixtureTask.normalized,
    schemaVersion: fixtures.fixtureTask.schemaVersion,
    expectedOutput: fixtures.fixtureTask.expectedOutput,
    requiredCapabilities: fixtures.fixtureTask.requiredCapabilities,
    complexity: fixtures.fixtureTask.complexity,
    id: fixtures.fixtureTask.id,
  }
  assert.equal(serialize(shuffled as unknown as Primitive), a)
})

test('golden fixture matches committed bytes (AC2/Deliverable 4)', () => {
  const expected = fs.readFileSync(GOLDEN, 'utf8')
  const actual = serialize(fixtures.fixtureBlueprint, true) + '\n'
  assert.equal(actual, expected, 'blueprint serialization drifted from golden file')
})

test('deserialize rejects malformed JSON with a typed issue', () => {
  const r = deserialize('{ not valid json ')
  assert.ok(!r.ok)
  assert.equal(r.error.issues[0]?.code, 'malformed_json')
})

test('invalid blueprints fail with useful typed validation errors (AC3)', () => {
  // Empty node list.
  const noNodes = { ...fixtures.fixtureBlueprint, nodes: [] }
  const r1 = validateBlueprint(noNodes)
  assert.ok(!r1.ok)
  assert.ok(r1.error instanceof KernelValidationError)
  assert.ok(r1.error.issues.some(i => i.code === 'empty_collection' && i.path === 'blueprint.nodes'))

  // Duplicate node id.
  const dupNode = {
    ...fixtures.fixtureBlueprint,
    nodes: [fixtures.fixtureNodes[0], { ...fixtures.fixtureNodes[0] }],
  }
  const r2 = validateBlueprint(dupNode)
  assert.ok(!r2.ok)
  assert.ok(r2.error.issues.some(i => i.code === 'duplicate_id'))

  // Directive targeting a node that does not exist.
  const dangling = {
    ...fixtures.fixtureBlueprint,
    directives: [{ ...fixtures.fixtureDirective, scope: { kind: 'node', node: 'n-ghost' } }],
  }
  const r3 = validateBlueprint(dangling)
  assert.ok(!r3.ok)
  assert.ok(r3.error.issues.some(i => i.code === 'dangling_reference' && /n-ghost/.test(i.message)))

  // Unknown capability requirement propagates through the task validator.
  const badTask = { ...fixtures.fixtureTask, requiredCapabilities: ['coding', 'telepathy'] }
  const r4 = validatePrimitive(badTask as unknown)
  assert.ok(!r4.ok)
  assert.ok(r4.error.issues.some(i => i.code === 'unknown_enum_value'))

  // Wrong schema version fails loud.
  const futureVersion = { ...fixtures.fixtureBlueprint, schemaVersion: 999 }
  const r5 = validateBlueprint(futureVersion as unknown as BlueprintPrimitive)
  assert.ok(!r5.ok)
  assert.ok(r5.error.issues.some(i => i.code === 'schema_version_mismatch'))
})

test('agent must advertise at least one capability', () => {
  const r = validateAgent({ ...fixtures.fixtureAgent, capabilities: [] })
  assert.ok(!r.ok)
  assert.ok(r.error.issues.some(i => i.code === 'empty_collection'))
})

test('validatePrimitive rejects unknown kinds', () => {
  const r = validatePrimitive({ kind: 'wormhole', schemaVersion: 1 })
  assert.ok(!r.ok)
  assert.equal(r.error.issues[0]?.code, 'invalid_value')
})
