import { test, describe, before, after } from 'node:test'
import * as assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client'
import { server } from '../src/mcp-server.js'

interface Transport {
  start(): Promise<void>
  send(message: unknown): Promise<void>
  close(): Promise<void>
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: unknown) => void
}

function linkedTransports(): [Transport, Transport] {
  const pair: Transport[] = []
  for (let i = 0; i < 2; i++) {
    const self = i
    const other = i ^ 1
    const transport: Transport = {
      start: async () => {},
      close: async () => { transport.onclose?.() },
      send: async (msg) => { pair[other]?.onmessage?.(msg) },
    }
    pair.push(transport)
  }
  return pair as [Transport, Transport]
}

let client: Client

before(async () => {
  const [clientTransport, serverTransport] = linkedTransports()
  client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
})

after(async () => {
  await client.close()
})

describe('mcp-server', () => {

  test('tools/list returns all 7 cortex tools', async () => {
    const result = await client.listTools()
    assert.equal(result.tools.length, 7)
    const names = result.tools.map((t: { name: string }) => t.name)
    assert.ok(names.includes('cortex_plan'))
    assert.ok(names.includes('cortex_locate'))
    assert.ok(names.includes('cortex_workers'))
    assert.ok(names.includes('cortex_metrics'))
    assert.ok(names.includes('cortex_dispatch'))
    assert.ok(names.includes('cortex_exec'))
    assert.ok(names.includes('cortex_init'))
  })

  test('cortex_plan returns intent and plan JSON', async () => {
    const result = await client.callTool({
      name: 'cortex_plan',
      arguments: { task: 'fix bug in src/auth.ts' },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    const parsed = JSON.parse(text)
    assert.equal(parsed.intent.taskType, 'patch')
    assert.equal(parsed.intent.complexity, 'bounded')
    assert.ok(parsed.plan.ladder.length > 0)
    assert.ok(parsed.plan.ladder[0].utility > 0)
  })

  test('cortex_locate returns file pointers', async () => {
    const result = await client.callTool({
      name: 'cortex_locate',
      arguments: { task: 'find auth module', dir: process.cwd() },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    assert.ok(text.length > 0)
  })

  test('cortex_locate returns empty when no project root', async () => {
    const result = await client.callTool({
      name: 'cortex_locate',
      arguments: { task: 'find something', dir: '/nonexistent/path' },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    assert.equal(text, 'no pointers found')
  })

  test('cortex_workers returns worker list', async () => {
    const result = await client.callTool({
      name: 'cortex_workers',
      arguments: {},
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    assert.ok(text.includes('claude-cli'))
    assert.ok(text.includes('tier='))
    assert.ok(text.includes('harness='))
  })

  test('cortex_metrics returns message when no metrics', async () => {
    const result = await client.callTool({
      name: 'cortex_metrics',
      arguments: { dir: `/tmp/cortex-mcp-metrics-${Date.now()}` },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    assert.ok(text === 'no metrics recorded yet')
  })

  test('cortex_init creates state directory', async () => {
    const tmpDir = `/tmp/cortex-mcp-test-${Date.now()}`
    const result = await client.callTool({
      name: 'cortex_init',
      arguments: { dir: tmpDir },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const text = (result.content as { text: string }[])[0]!.text
    assert.ok(text.includes('initialised cortex state directory'))
  })

  test('cortex_dispatch with dry_run returns packet and prompt', async () => {
    const result = await client.callTool({
      name: 'cortex_dispatch',
      arguments: { task: 'fix typo in README.md', dry_run: true },
    })
    assert.ok(!('isError' in result) || !result.isError)
    const contents = result.content as { text: string }[]
    assert.ok(contents.length >= 3)
    const packetText = contents[0]!.text
    assert.ok(packetText.includes('"v": 2'))
    assert.ok(packetText.includes('"act": "work"'))
    const ladderText = contents[1]!.text
    assert.ok(ladderText.includes('ladder'))
    const promptText = contents[2]!.text
    assert.ok(promptText.includes('prompt'))
  })

  test('resources/list returns cortex://registry', async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r: { uri: string }) => r.uri)
    assert.ok(uris.includes('cortex://registry'))
  })

  test('resources/read returns worker JSON', async () => {
    const result = await client.readResource({ uri: 'cortex://registry' })
    const first = result.contents[0]!
    assert.equal('text' in first, true)
    const text = (first as { text: string }).text
    const parsed = JSON.parse(text)
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.length > 0)
    assert.ok(typeof parsed[0]!.id === 'string')
    assert.ok(Array.isArray(parsed[0]!.capabilities))
  })
})
