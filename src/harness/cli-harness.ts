// Generic process harness — the generalization of the old claude-adapter.
// Which binary, which flags, which env vars to strip, how the prompt travels:
// all data from WorkerSpec.harness, no model-specific code.
import { spawn, spawnSync } from 'node:child_process'
import { type Harness, type HarnessRequest, type HarnessResult, type CliHarnessConfig, registerHarness } from './harness.js'
import { debug } from '../core/logger.js'

export class CliHarness implements Harness {
  constructor(private readonly config: CliHarnessConfig) {}

  available(): boolean {
    const probe = spawnSync(this.config.bin, this.config.probeArgs, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return probe.status === 0
  }

  invoke(req: HarnessRequest): Promise<HarnessResult> {
    const start = Date.now()
    const env = { ...process.env }
    for (const key of this.config.stripEnv) {
      delete env[key]
    }

    const args = this.config.promptVia === 'arg'
      ? [...this.config.args, req.prompt]
      : [...this.config.args]

    return new Promise<HarnessResult>((resolve) => {
      const child = spawn(this.config.bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })

      let stdout = ''
      let stderr = ''
      let settled = false
      let truncated = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        resolve({
          ok: false,
          output: stdout,
          latencyMs: Date.now() - start,
          failReason: `timeout after ${req.timeoutMs}ms`,
        })
      }, req.timeoutMs)

      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < req.maxOutputBytes) {
          stdout += d.toString('utf-8')
        } else if (!truncated) {
          truncated = true
          debug(`cli-harness: output exceeded ${req.maxOutputBytes} bytes, truncating`)
        }
      })
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += d.toString('utf-8')
      })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, output: '', latencyMs: Date.now() - start, failReason: err.message })
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) {
          resolve({
            ok: false,
            output: stdout,
            latencyMs: Date.now() - start,
            failReason: stderr.trim() || `exit code ${code}`,
          })
          return
        }
        resolve({ ok: true, output: stdout.trim(), latencyMs: Date.now() - start })
      })

      if (this.config.promptVia === 'stdin') {
        child.stdin.write(req.prompt)
      }
      child.stdin.end()
    })
  }
}

registerHarness('cli', (config) => {
  if (config.kind !== 'cli') throw new Error('cli harness factory received non-cli config')
  return new CliHarness(config)
})
