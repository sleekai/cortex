// Generic JSON-over-HTTP harness. Covers OpenAI-compatible endpoints, Ollama,
// and arbitrary JSON APIs via a body template and an output dot-path — no
// provider-specific code in the kernel.
import { type Harness, type HarnessRequest, type HarnessResult, type HttpHarnessConfig, registerHarness } from './harness.js'

function fillTemplate(template: unknown, prompt: string): unknown {
  if (typeof template === 'string') {
    return template.includes('{{prompt}}') ? template.replaceAll('{{prompt}}', prompt) : template
  }
  if (Array.isArray(template)) {
    return template.map(t => fillTemplate(t, prompt))
  }
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(template)) {
      out[k] = fillTemplate(v, prompt)
    }
    return out
  }
  return template
}

function readPath(obj: unknown, dotPath: string): unknown {
  let current: unknown = obj
  for (const seg of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    const container = current as Record<string, unknown>
    const index = /^\d+$/.test(seg) ? Number(seg) : seg
    current = Array.isArray(current) && typeof index === 'number' ? current[index] : container[String(seg)]
  }
  return current
}

export class HttpHarness implements Harness {
  constructor(private readonly config: HttpHarnessConfig) {}

  available(): boolean {
    // No cheap synchronous probe for HTTP; availability is decided at invoke
    // time. Excluding remote workers from planning over a probe would punish
    // slow networks, not broken workers.
    return true
  }

  async invoke(req: HarnessRequest): Promise<HarnessResult> {
    const start = Date.now()
    const body = fillTemplate(this.config.bodyTemplate, req.prompt)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), req.timeoutMs)

    try {
      const response = await fetch(this.config.url, {
        method: this.config.method,
        headers: { 'content-type': 'application/json', ...this.config.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const latencyMs = Date.now() - start
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { ok: false, output: '', latencyMs, failReason: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      }

      const json: unknown = await response.json()
      const output = readPath(json, this.config.outputPath)
      if (typeof output !== 'string') {
        return { ok: false, output: '', latencyMs, failReason: `no string at output path "${this.config.outputPath}"` }
      }
      return { ok: true, output: output.slice(0, req.maxOutputBytes), latencyMs }
    } catch (e: unknown) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? `timeout after ${req.timeoutMs}ms` : e.message) : String(e)
      return { ok: false, output: '', latencyMs: Date.now() - start, failReason: msg }
    } finally {
      clearTimeout(timer)
    }
  }
}

registerHarness('http', (config) => {
  if (config.kind !== 'http') throw new Error('http harness factory received non-http config')
  return new HttpHarness(config)
})
