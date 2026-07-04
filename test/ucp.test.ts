import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { parsePacket, validatePacket, type UCP } from '../src/packet/ucp.js'
import { generateWorkPacket, generateAskPacket, generateErrorPacket } from '../src/packet/generator.js'

test('v1 packets upgrade to v2 work packets', () => {
  const v1 = JSON.stringify({
    t: 'tabc',
    g: 'fix add function',
    c: ['must pass tests'],
    ctx: { f: ['src/math.js:add'], d: ['f:add @src/math.js L1-L5'] },
    r: { out: 'patch', format: 'unified diff' },
  })
  const packet = parsePacket(v1)
  assert.ok(packet)
  assert.equal(packet.v, 2)
  assert.equal(packet.act, 'work')
  assert.equal(packet.g, 'fix add function')
  assert.equal(validatePacket(packet).valid, true)
})

test('ask packets require a question', () => {
  const packet: UCP = {
    v: 2, t: 't1', act: 'ask', g: 'goal', c: [],
    ctx: { f: [], d: [] }, r: { out: 'decision', format: 'json' },
  }
  const result = validatePacket(packet)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('question')))
})

test('review packets require a diff fact', () => {
  const bad: UCP = {
    v: 2, t: 't1', act: 'review', g: 'goal', c: [],
    ctx: { f: [], d: ['spec: /tmp/spec.md'] }, r: { out: 'review', format: 'json' },
  }
  assert.equal(validatePacket(bad).valid, false)
  const good: UCP = { ...bad, ctx: { f: [], d: ['diff: unstaged'] } }
  assert.equal(validatePacket(good).valid, true)
})

test('generateWorkPacket compresses the goal and extracts constraints', () => {
  const packet = generateWorkPacket('Fix the login form. Must not break existing tests.', [], [])
  assert.equal(packet.act, 'work')
  assert.ok(packet.g.includes('login'))
  assert.ok(!packet.g.includes('the'))
  assert.ok(packet.c.some(c => c.includes('not break existing tests')))
  assert.equal(validatePacket(packet).valid, true)
})

test('generateAskPacket is a valid judgment packet', () => {
  const packet = generateAskPacket('t9', 'REST or GraphQL for the new API?', ['human decided: TypeScript'], ['src/api.ts'], ['spec: /tmp/spec.md#L4'])
  assert.equal(packet.act, 'ask')
  assert.equal(packet.q, 'REST or GraphQL for the new API?')
  assert.equal(validatePacket(packet).valid, true)
})

test('error packets carry only failure evidence, never context', () => {
  const packet = generateErrorPacket('t1', 'fix login', 'error output here', 'TS2345 type error', 1)
  assert.equal(packet.ctx.f.length, 0)
  assert.ok(packet.ctx.d.some(d => d.includes('TS2345')))
  assert.equal(packet.t, 't1-v1')
})

test('parsePacket rejects garbage', () => {
  assert.equal(parsePacket('nope'), null)
  assert.equal(parsePacket('{"g":"no task id"}'), null)
})
