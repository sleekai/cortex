// The Harness seam: the planner and dispatcher never know how a worker
// executes. CLI, HTTP, MCP, browser, remote cluster — all are HarnessFactory
// registrations keyed by `kind`. Adding an execution protocol never touches
// planning code.

export interface HarnessRequest {
  prompt: string
  timeoutMs: number
  maxOutputBytes: number
}

export interface HarnessResult {
  ok: boolean
  output: string
  latencyMs: number
  failReason?: string
}

export interface Harness {
  // Cheap availability probe; a worker whose harness is unavailable is
  // excluded from planning instead of failing at dispatch time.
  available(): boolean
  invoke(req: HarnessRequest): Promise<HarnessResult>
}

export interface CliHarnessConfig {
  kind: 'cli'
  bin: string
  args: string[]
  // Env vars stripped before spawn (e.g. CLAUDECODE — a nested claude
  // inherits it and exits instantly).
  stripEnv: string[]
  // 'stdin' pipes the prompt; 'arg' appends it as the final argument.
  promptVia: 'stdin' | 'arg'
  probeArgs: string[]
  // Name of an env var that, when set, overrides `bin` (e.g.
  // TOOLCHAIN_CLAUDE_BIN). Resolved by the registry loader.
  binEnvOverride?: string
}

export interface HttpHarnessConfig {
  kind: 'http'
  url: string
  method: 'POST'
  headers: Record<string, string>
  // JSON template; the string "{{prompt}}" anywhere in it is replaced.
  bodyTemplate: unknown
  // Dot-path into the response JSON where the text output lives.
  outputPath: string
}

export type HarnessConfig = CliHarnessConfig | HttpHarnessConfig

export type HarnessFactory = (config: HarnessConfig) => Harness

const factories = new Map<string, HarnessFactory>()

export function registerHarness(kind: string, factory: HarnessFactory): void {
  factories.set(kind, factory)
}

export function createHarness(config: HarnessConfig): Harness {
  const factory = factories.get(config.kind)
  if (!factory) {
    throw new Error(`no harness registered for kind "${config.kind}"`)
  }
  return factory(config)
}

export function registeredHarnessKinds(): string[] {
  return [...factories.keys()]
}
