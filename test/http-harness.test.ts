import { test, after } from 'node:test'
import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import '../src/harness/http-harness.js'
import { createHarness, type HttpHarnessConfig } from '../src/harness/harness.js'

// One throwaway server; the request path selects the behaviour under test.
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    if (req.url === '/ok') {
      res.setHeader('content-type', 'application/json')
      const prompt = (JSON.parse(body) as { messages: { content: string }[] }).messages[0]!.content
      res.end(JSON.stringify({ choices: [{ message: { content: `echo: ${prompt}` } }] }))
    } else if (req.url === '/error') {
      res.statusCode = 500
      res.end('upstream exploded')
    } else if (req.url === '/bad-shape') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ unexpected: true }))
    } else if (req.url === '/hang') {
      // never respond — exercises the timeout/abort path
    }
  })
})

const port: number = await new Promise((resolve) => {
  server.listen(0, () => resolve((server.address() as { port: number }).port))
})
after(() => server.close())

function httpConfig(urlPath: string): HttpHarnessConfig {
  return {
    kind: 'http',
    url: `http://127.0.0.1:${port}${urlPath}`,
    method: 'POST',
    headers: {},
    bodyTemplate: { messages: [{ content: '{{prompt}}' }] },
    outputPath: 'choices.0.message.content',
  }
}

test('templated request round-trips and output path extracts the reply', async () => {
  const harness = createHarness(httpConfig('/ok'))
  const result = await harness.invoke({ prompt: 'ping', timeoutMs: 5000, maxOutputBytes: 4096 })
  assert.equal(result.ok, true)
  assert.equal(result.output, 'echo: ping')
})

test('non-2xx responses fail with status and body excerpt', async () => {
  const harness = createHarness(httpConfig('/error'))
  const result = await harness.invoke({ prompt: 'ping', timeoutMs: 5000, maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.ok(result.failReason!.includes('HTTP 500'))
  assert.ok(result.failReason!.includes('upstream exploded'))
})

test('a reply without a string at the output path fails loudly', async () => {
  const harness = createHarness(httpConfig('/bad-shape'))
  const result = await harness.invoke({ prompt: 'ping', timeoutMs: 5000, maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.ok(result.failReason!.includes('output path'))
})

test('timeout aborts the request and reports it', async () => {
  const harness = createHarness(httpConfig('/hang'))
  const result = await harness.invoke({ prompt: 'ping', timeoutMs: 150, maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.ok(result.failReason!.includes('timeout'))
})
