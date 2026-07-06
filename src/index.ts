#!/usr/bin/env node

// Cortex CLI — the kernel's surface. `run` preserves the legacy `ucp` flags
// exactly (they route through the intent compiler and planner now); `plan`,
// `locate`, `workers`, and `metrics` expose the kernel's decisions without
// spending a single model token.

// Side-effect imports: register the built-in harness factories.
import './harness/cli-harness.js'
import './harness/http-harness.js'

import { DEFAULT_BUDGET, type BudgetConfig } from './core/types.js'
import { info, warn, error as logError } from './core/logger.js'
import { loadRegistry } from './worker/registry.js'
import { buildPrompt } from './worker/prompt.js'
import { planTask, prepareDispatch, executeTask, runBlueprint, runLocate, listWorkers, triagedTask, type ExecuteConfig, type BlueprintConfig } from './kernel/index.js'
import { registeredBlueprints } from './blueprint/blueprint.js'
import { registeredSkills } from './skill/registry.js'
import { getPolicySet, DEFAULT_POLICIES } from './policy/policies.js'
import { renderBlueprintSummary } from './egress/egress.js'
import { DEFAULT_BOUNDS, type RouterBounds } from './loop/router.js'
import { isKind } from './artifact/artifacts.js'
import { initProject } from './state/store.js'
import { readMetrics, aggregateStats } from './state/metrics.js'
import { TEMPLATES, type TemplateKind, openAiTemplate, anthropicTemplate, chatGptTemplate, ollamaTemplate, cliTemplate, httpTemplate, opencodeAdapter, codexAdapter, cursorAdapter, claudeCliAdapter } from './worker/templates.js'
import { type WorkerSpec } from './worker/registry.js'
import { normalizeInput as ingressNormalize } from './ingress/ingress.js'
import { renderDispatchSummary, renderLoopSummary, renderPlanSummary, renderPointerList } from './egress/egress.js'
// Triage Skill System (CTS) — opt-in pre-execution cognitive filter. The
// side-effect import registers the built-in skills; runTriage is only called
// when --triage / CORTEX_TRIAGE is set, so the pipeline is inert by default.
import './triage/stages/builtins.js'
import { runTriage } from './triage/pipeline.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface CliArgs {
  command: 'run' | 'dispatch' | 'loop' | 'exec' | 'plan' | 'locate' | 'workers' | 'metrics' | 'init' | 'add-worker' | 'blueprints' | 'skills'
  task: string
  goal?: string
  dir?: string
  stateDir?: string
  budget?: string
  timeout?: string
  dryRun?: boolean
  // loop (CUEA) bounds
  maxIter?: string
  maxEscalation?: string
  maxCost?: string
  // add-worker specific
  provider?: string
  workerId?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  bin?: string
  writeAccess?: string
  triage?: boolean
  // exec (blueprint) specific
  blueprint?: string
  policies?: string
}

const COMMANDS = new Set(['run', 'dispatch', 'loop', 'exec', 'plan', 'locate', 'workers', 'metrics', 'init', 'add-worker', 'blueprints', 'skills'])

const COMMAND_ALIASES: Record<string, CliArgs['command']> = {
  run: 'dispatch',
}

function parseArgs(raw: string[]): CliArgs {
  const args: CliArgs = { command: 'dispatch', task: '' }
  let i = 2
  let rawCommand = raw[i] || ''
  if (raw[i] && COMMANDS.has(raw[i]!)) {
    // Resolve aliases
    args.command = COMMAND_ALIASES[raw[i]!] ?? raw[i] as CliArgs['command']
    i++
  }
  for (; i < raw.length; i++) {
    const arg = raw[i]!
    if ((arg === '--task' || arg === '-t') && i + 1 < raw.length) {
      args.task = raw[++i]!
    } else if ((arg === '--goal' || arg === '-g') && i + 1 < raw.length) {
      args.goal = raw[++i]!
    } else if ((arg === '--dir' || arg === '-d') && i + 1 < raw.length) {
      args.dir = raw[++i]!
    } else if (arg === '--state-dir' && i + 1 < raw.length) {
      args.stateDir = raw[++i]!
    } else if (arg === '--budget' && i + 1 < raw.length) {
      args.budget = raw[++i]!
    } else if (arg === '--timeout' && i + 1 < raw.length) {
      args.timeout = raw[++i]!
    } else if (arg === '--max-iter' && i + 1 < raw.length) {
      args.maxIter = raw[++i]!
    } else if (arg === '--max-escalation' && i + 1 < raw.length) {
      args.maxEscalation = raw[++i]!
    } else if (arg === '--max-cost' && i + 1 < raw.length) {
      args.maxCost = raw[++i]!
    } else if (arg === '--blueprint' && i + 1 < raw.length) {
      args.blueprint = raw[++i]!
    } else if (arg === '--policies' && i + 1 < raw.length) {
      args.policies = raw[++i]!
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--triage') {
      args.triage = true
    } else if ((arg === '--provider' || arg === '-p') && i + 1 < raw.length) {
      args.provider = raw[++i]!
    } else if ((arg === '--id' || arg === '-n') && i + 1 < raw.length) {
      args.workerId = raw[++i]!
    } else if (arg === '--model' && i + 1 < raw.length) {
      args.model = raw[++i]!
    } else if ((arg === '--api-key' || arg === '-k') && i + 1 < raw.length) {
      args.apiKey = raw[++i]!
    } else if (arg === '--base-url' && i + 1 < raw.length) {
      args.baseUrl = raw[++i]!
    } else if (arg === '--bin' && i + 1 < raw.length) {
      args.bin = raw[++i]!
    } else if (arg === '--write-access' && i + 1 < raw.length) {
      args.writeAccess = raw[++i]!
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!args.task) {
      args.task = arg
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(`Cortex — AI Compute Operating System

Usage:
  cortex init [options]              scaffold .cortex/ state directory
  cortex dispatch|run <task> [opts]  dispatch a task (run is alias)
  cortex loop <task> [options]       CUEA closed loop: Producer→Evaluator→Router
  cortex exec <task> [options]       blueprint execution: triage → skills → closed loop
  cortex blueprints                  list registered execution blueprints
  cortex skills                      list registered execution skills
  cortex plan <task> [options]       print intent + dispatch plan, no model call
  cortex locate <keywords> [options] tier-0 deterministic pointers, no model call
  cortex workers [options]           list registered workers + availability
  cortex metrics [options]           per-worker stats from .cortex/metrics.jsonl
  cortex add-worker <provider> [opts] add a worker from a harness template

Adapters (zero-config):
${TEMPLATES.filter(t => t.adapter).map(t => `  ${t.kind.padEnd(12)} ${t.description}`).join('\n')}
Templates:
${TEMPLATES.filter(t => !t.adapter).map(t => `  ${t.kind.padEnd(12)} ${t.description}`).join('\n')}

Options:
  --task, -t     Task description (required for dispatch/plan/locate)
  --goal, -g     Goal keywords (optional, derived from task if omitted)
  --dir, -d      Project root directory (default: cwd)
  --state-dir    State directory override (env: CORTEX_DIR, default: <.cortex>)
  --budget       Max input tokens (default: ${DEFAULT_BUDGET.maxInputTokens})
  --timeout      Worker timeout in ms (default: 180000)
  --dry-run      Print packet + prompt and exit (no model call, no patch)
  --max-iter        Loop: max iterations (default: ${DEFAULT_BOUNDS.maxIterations})
  --max-escalation  Loop: max escalation depth (default: ${DEFAULT_BOUNDS.maxEscalationDepth})
  --max-cost        Loop: cost ceiling in relative units (default: uncapped)
  --blueprint    Exec: blueprint name (default: triage's recommendation)
  --policies     Exec: named policy set (default|strict|generous)
  --triage       Run the Triage Skill System first (env: CORTEX_TRIAGE)
  --provider,-p  Worker template (openai, anthropic, chatgpt, ollama, cli, http)
  --id,-n        Worker id (default: derived from provider)
  --model        Model name (for openai/anthropic/ollama templates)
  --api-key,-k   API key (for openai/anthropic templates; falls back to env)
  --base-url     API base URL (for openai/ollama templates)
  --bin          Binary path (for cli template)
  --write-access Write access (none|patch, default: patch)
  --help, -h     Show help

Examples:
  cortex init
  cortex dispatch "add JWT auth middleware to Express app"
  cortex loop "refactor the parser" --max-iter 5 --max-escalation 2
  cortex exec "fix the login crash" --blueprint debug --policies generous
  cortex plan --task "fix login form validation" --dir ./my-app
  cortex locate "budget enforcement" --dir .
  cortex add-worker openai --model gpt-4o-mini --id openai-cheap
  cortex add-worker anthropic --model claude-sonnet-4-20250514
  cortex add-worker ollama --model llama3.2 --base-url http://192.168.1.5:11434
  cortex add-worker cli --id my-llamafile --bin ./llamafile --promptVia arg
`)
}

// Opt-in CTS seam. Triage itself runs inside the kernel (once per task) when
// the flag is on; the CLI only decides the flag.
function triageEnabled(args: CliArgs): boolean {
  return args.triage === true || !!process.env['CORTEX_TRIAGE']
}

async function commandRun(args: CliArgs): Promise<void> {
  if (args.stateDir) process.env['CORTEX_DIR'] = args.stateDir
  const projectRoot = args.dir ?? process.cwd()
  const budget = args.budget ? parseInt(args.budget, 10) : DEFAULT_BUDGET.maxInputTokens
  const timeout = args.timeout ? parseInt(args.timeout, 10) : 180_000
  const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

  const ingressPacket = ingressNormalize({
    content: args.task,
    kind: 'cli',
    explicitGoal: args.goal,
    metadata: { projectRoot, budget: String(budget), timeout: String(timeout) },
  })
  const goal = ingressPacket.ucp.g
  const config = { projectRoot, goal, budget: budgetConfig, timeoutMs: timeout, triage: triageEnabled(args) }

  info(`project: ${projectRoot}`)
  info(`task: ${args.task}`)
  info(`goal: ${goal}`)
  info(`source: ${ingressPacket.source} session=${ingressPacket.sessionId ?? 'none'}`)

  if (args.dryRun) {
    const triaged = triagedTask(args.task, config)
    const prepared = prepareDispatch(triaged.task, config, triaged.tierHint)
    if (prepared.kind === 'pointers') {
      process.stdout.write(prepared.pointers.join('\n') + '\n')
      return
    }
    if (prepared.kind === 'refused') {
      logError(`budget refused dispatch: ${prepared.reason}`)
      process.exit(1)
    }
    const prompt = buildPrompt(prepared.ucp, prepared.budgeted.chunks)
    process.stdout.write(JSON.stringify(prepared.ucp, null, 2) + '\n')
    process.stdout.write(`\n--- ladder ---\n${prepared.plan.ladder.map(r => `${r.worker.id} (tier ${r.worker.tier}): ${r.justification}`).join('\n')}\n`)
    process.stdout.write(`\n--- prompt (${prepared.budgeted.totalTokens} est tokens) ---\n${prompt}\n`)
    return
  }

  const outcome = await executeTask(args.task, config)
  if (outcome.kind === 'pointers') {
    process.stdout.write(renderPointerList(outcome.pointers) + '\n')
    return
  }
  if (outcome.kind === 'refused') {
    logError(`budget refused dispatch: ${outcome.reason}`)
    process.exit(1)
  }

  const { result } = outcome
  const patch = result.finalOutput && isKind(result.finalOutput, 'patch') ? result.finalOutput.body.diff : ''
  const reasoning = result.finalOutput && isKind(result.finalOutput, 'patch') ? result.finalOutput.body.reasoning : ''
  const summary = {
    kind: outcome.kind,
    taskId: outcome.ucp.t,
    goal: outcome.ucp.g,
    success: result.accepted,
    iterations: result.state.iteration,
    patchLength: patch.length,
    reasoning: reasoning || 'none',
    validationPassed: result.accepted,
    validationErrors: [] as string[],
  }
  const egressOut = renderDispatchSummary(summary, { targetKind: 'cli' })
  process.stdout.write(egressOut)
  if (!result.accepted) {
    process.exit(1)
  }
}

// Build RouterBounds from flags, falling back to DEFAULT_BOUNDS per field so a
// partial override (just --max-iter, say) keeps the other guarantees intact.
function boundsFromFlags(args: CliArgs): RouterBounds {
  return {
    ...DEFAULT_BOUNDS,
    ...(args.maxIter ? { maxIterations: parseInt(args.maxIter, 10) } : {}),
    ...(args.maxEscalation ? { maxEscalationDepth: parseInt(args.maxEscalation, 10) } : {}),
    ...(args.maxCost ? { maxCost: parseFloat(args.maxCost) } : {}),
  }
}

// `cortex loop` — the CUEA closed-loop executor. Same ingress/plan/budget path
// as dispatch, but the Router owns every continuation decision under the §6
// bounds instead of the fixed 3-iteration validation loop.
async function commandLoop(args: CliArgs): Promise<void> {
  if (args.stateDir) process.env['CORTEX_DIR'] = args.stateDir
  const projectRoot = args.dir ?? process.cwd()
  const budget = args.budget ? parseInt(args.budget, 10) : DEFAULT_BUDGET.maxInputTokens
  const timeout = args.timeout ? parseInt(args.timeout, 10) : 180_000
  const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

  const ingressPacket = ingressNormalize({
    content: args.task,
    kind: 'cli',
    explicitGoal: args.goal,
    metadata: { projectRoot, budget: String(budget), timeout: String(timeout) },
  })
  const goal = ingressPacket.ucp.g
  const bounds = boundsFromFlags(args)
  const config: ExecuteConfig = { projectRoot, goal, budget: budgetConfig, timeoutMs: timeout, bounds, triage: triageEnabled(args) }

  info(`project: ${projectRoot}`)
  info(`task: ${args.task}`)
  info(`bounds: maxIter=${bounds.maxIterations} maxEscalation=${bounds.maxEscalationDepth} maxCost=${bounds.maxCost}`)

  const outcome = await executeTask(args.task, config)
  if (outcome.kind === 'pointers') {
    process.stdout.write(renderPointerList(outcome.pointers) + '\n')
    return
  }
  if (outcome.kind === 'refused') {
    logError(`budget refused dispatch: ${outcome.reason}`)
    process.exit(1)
  }

  const { result } = outcome
  const final = result.finalOutput
  const patch = final && isKind(final, 'patch') ? final.body : { diff: '', reasoning: '' }
  const lastIssues = result.state.history[result.state.history.length - 1]?.issues ?? []
  const egressOut = renderLoopSummary({
    taskId: outcome.ucp.t,
    goal: outcome.ucp.g,
    status: result.state.status,
    accepted: result.accepted,
    iterations: result.state.iteration,
    escalationDepth: result.state.escalationDepth,
    cost: result.state.cost,
    terminationReason: result.terminationReason,
    workerPath: result.state.history.map(h => `${h.workerId} (tier ${h.tier}) → ${h.decision} @conf ${h.confidence.toFixed(2)}`),
    finalReasoning: patch.reasoning,
    patchLength: patch.diff.length,
    issues: lastIssues,
  }, { targetKind: 'cli' })
  process.stdout.write(egressOut)
  if (!result.accepted) {
    process.exit(1)
  }
}

// `cortex exec` — blueprint execution (the MVP flow): ingress → triage skill
// recommends a blueprint → runner executes skills conditionally → produce
// runs the CUEA loop with context-on-demand → artifacts out through egress.
async function commandExec(args: CliArgs): Promise<void> {
  if (args.stateDir) process.env['CORTEX_DIR'] = args.stateDir
  const projectRoot = args.dir ?? process.cwd()
  const budget = args.budget ? parseInt(args.budget, 10) : DEFAULT_BUDGET.maxInputTokens
  const timeout = args.timeout ? parseInt(args.timeout, 10) : 180_000
  const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

  const policies = args.policies ? getPolicySet(args.policies) : DEFAULT_POLICIES
  if (!policies) {
    logError(`unknown policy set "${args.policies}"`)
    process.exit(1)
  }

  const config: BlueprintConfig = {
    projectRoot,
    budget: budgetConfig,
    timeoutMs: timeout,
    policies,
    raw: args.task,
    ...(args.goal ? { goal: args.goal } : {}),
    ...(args.blueprint ? { blueprint: args.blueprint } : {}),
  }

  info(`project: ${projectRoot}`)
  info(`task: ${args.task}`)

  const outcome = await runBlueprint(args.task, config)
  const summary = renderBlueprintSummary({
    taskId: outcome.artifacts[0]?.taskId ?? '',
    blueprint: outcome.blueprint,
    kind: outcome.kind,
    accepted: outcome.kind === 'completed' ? outcome.accepted : false,
    steps: outcome.steps,
    questions: outcome.kind === 'clarification' ? outcome.questions : [],
    artifacts: outcome.artifacts,
    ...(outcome.kind === 'completed' && outcome.produce ? { produce: outcome.produce.summary } : {}),
  }, { targetKind: 'cli' })
  process.stdout.write(summary)

  if (outcome.kind === 'clarification') {
    process.exit(2)
  }
  if (!outcome.accepted) {
    process.exit(1)
  }
}

function commandBlueprints(): void {
  for (const bp of registeredBlueprints()) {
    const steps = bp.steps.map(s => s.kind === 'skill' ? s.skill : 'produce').join(' → ')
    process.stdout.write(`${bp.name}: ${bp.description}\n  steps: ${steps}\n`)
  }
}

function commandSkills(): void {
  for (const s of registeredSkills()) {
    const caps = s.meta.profile.minimum.map(r => r.capability).join(',')
    process.stdout.write(`${s.name} [${s.meta.costLevel}${s.meta.deterministic ? ', deterministic' : ''}]: ${s.purpose}\n  caps: ${caps}\n  produces: ${s.meta.produces.join(', ')}\n`)
  }
}

function commandPlan(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const ingressPacket = ingressNormalize({ content: args.task, kind: 'cli', explicitGoal: args.goal })
  const cts = triageEnabled(args) ? runTriage(ingressPacket) : undefined
  const task = cts?.normalized_task ?? args.task
  const { plan, intent } = planTask(task, projectRoot, undefined, undefined, cts?.worker_recommendation)
  const data = {
    intent,
    entryTier: plan.entryTier,
    tier0: plan.tier0,
    ladder: plan.ladder.map(r => ({
      worker: r.worker.id,
      tier: r.worker.tier,
      utility: r.utility,
      expectedSpend: r.expectedSpend,
      justification: r.justification,
    })),
    excluded: plan.excluded,
    _ingress: {
      source: ingressPacket.source,
      sessionId: ingressPacket.sessionId,
      preClassified: ingressPacket.preClassified,
    },
    ...(cts ? { _triage: cts } : {}),
  }
  process.stdout.write(renderPlanSummary(data, { targetKind: 'cli' }) + '\n')
}

function commandLocate(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const ingressPacket = ingressNormalize({ content: args.task, kind: 'cli', explicitGoal: args.goal })
  const pointers = runLocate(args.task, projectRoot, ingressPacket.ucp.g)
  process.stdout.write(renderPointerList(pointers) + '\n')
}

function commandWorkers(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  for (const w of listWorkers(projectRoot)) {
    const availability = w.availableError ?? (w.available ? 'available' : 'UNAVAILABLE')
    const observed = w.dispatches ? ` observed: ${((w.successRate ?? 0) * 100).toFixed(0)}% over ${w.dispatches} dispatches` : ''
    process.stdout.write(
      `${w.id}  tier=${w.tier}  caps=${w.capabilities.join(',')}  harness=${w.harnessKind}  ${availability}${observed}\n`,
    )
  }
}

function commandMetrics(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const stats = aggregateStats(readMetrics(projectRoot))
  if (stats.size === 0) {
    process.stdout.write('no metrics recorded yet\n')
    return
  }
  for (const s of stats.values()) {
    process.stdout.write(
      `${s.workerId}: ${s.dispatches} dispatches, ${(s.successRate * 100).toFixed(0)}% success, ` +
      `mean ${Math.round(s.meanLatencyMs)}ms, mean ${Math.round(s.meanInputTokens)} in-tokens, ` +
      `retry rate ${(s.retryRate * 100).toFixed(0)}%\n`,
    )
  }
}

function commandInit(args: CliArgs): void {
  if (args.stateDir) process.env['CORTEX_DIR'] = args.stateDir
  const projectRoot = args.dir ?? process.cwd()
  const dir = initProject(projectRoot, args.stateDir)
  process.stdout.write(`initialised cortex state directory at ${dir}\n`)
}

function cortexDir(projectRoot: string): string {
  return process.env['CORTEX_DIR'] ?? path.join(projectRoot, '.cortex')
}

// ── Interactive prompts ────────────────────────────────────────────────

import * as readline from 'node:readline/promises'

async function withRl<T>(fn: (rl: readline.Interface) => Promise<T>): Promise<T> {
  const rli = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await fn(rli)
  } finally {
    rli.close()
  }
}

async function ask(rli: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const hint = defaultVal ? ` [${defaultVal}]` : ''
  const answer = await rli.question(`${question}${hint}: `)
  return answer || defaultVal || ''
}

async function pick(rli: readline.Interface, label: string, choices: string[]): Promise<string> {
  process.stdout.write(`\n${label}\n`)
  for (let i = 0; i < choices.length; i++) {
    process.stdout.write(`  ${i + 1}) ${choices[i]}\n`)
  }
  const raw = await rli.question(`Enter number (1-${choices.length}): `)
  const idx = parseInt(raw, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= choices.length) {
    process.stdout.write(`invalid choice, defaulting to "${choices[0]}"\n`)
    return choices[0]
  }
  return choices[idx]!
}

async function promptOpenAi(rli: readline.Interface): Promise<WorkerSpec> {
  const id = await ask(rli, 'Worker id', 'openai')
  const model = await ask(rli, 'Model', 'gpt-4o')
  const keyHint = process.env['OPENAI_API_KEY'] ? '<from env>' : ''
  const apiKey = await ask(rli, 'API key (leave empty to skip)', keyHint) || undefined
  const baseUrl = await ask(rli, 'Base URL', 'https://api.openai.com/v1')
  return openAiTemplate({
    id, model, apiKey, baseUrl,
    writeAccess: await pick(rli, 'Write access', ['patch', 'none']) as 'patch' | 'none',
  })
}

async function promptAnthropic(rli: readline.Interface): Promise<WorkerSpec> {
  const id = await ask(rli, 'Worker id', 'anthropic')
  const model = await ask(rli, 'Model', 'claude-sonnet-4-20250514')
  const keyHint = process.env['ANTHROPIC_API_KEY'] ? '<from env>' : ''
  const apiKey = await ask(rli, 'API key (leave empty to skip)', keyHint) || undefined
  return anthropicTemplate({
    id, model, apiKey,
    writeAccess: await pick(rli, 'Write access', ['patch', 'none']) as 'patch' | 'none',
  })
}

async function promptChatGpt(rli: readline.Interface): Promise<WorkerSpec> {
  const id = await ask(rli, 'Worker id', 'chatgpt')
  const model = await ask(rli, 'Model', 'gpt-4o')
  const keyHint = process.env['CHATGPT_API_KEY'] || process.env['OPENAI_API_KEY'] ? '<from env>' : ''
  const apiKey = await ask(rli, 'API key (leave empty to skip)', keyHint) || undefined
  return chatGptTemplate({
    id, model, apiKey,
    writeAccess: await pick(rli, 'Write access', ['patch', 'none']) as 'patch' | 'none',
  })
}

async function promptOllama(rli: readline.Interface): Promise<WorkerSpec> {
  const id = await ask(rli, 'Worker id', 'ollama')
  const model = await ask(rli, 'Model', 'llama3.2')
  const baseUrl = await ask(rli, 'Base URL', 'http://localhost:11434')
  return ollamaTemplate({
    id, model, baseUrl,
    writeAccess: await pick(rli, 'Write access', ['none', 'patch']) as 'patch' | 'none',
  })
}

async function promptCli(rli: readline.Interface): Promise<WorkerSpec> {
  const id = await ask(rli, 'Worker id', 'cli-worker')
  const bin = await ask(rli, 'Binary path (e.g. ./llamafile)')
  if (!bin) { process.stdout.write('binary path is required\n'); process.exit(1) }
  const promptVia = await pick(rli, 'Prompt delivery', ['stdin', 'arg']) as 'stdin' | 'arg'
  const argsRaw = await ask(rli, 'Extra CLI args (comma-separated)', '')
  const args = argsRaw ? argsRaw.split(',').map(s => s.trim()).filter(Boolean) : []
  return cliTemplate({
    id, bin, promptVia, args,
    writeAccess: await pick(rli, 'Write access', ['patch', 'none']) as 'patch' | 'none',
  })
}

async function writeWorkerSpec(spec: WorkerSpec, projectRoot: string): Promise<void> {
  const dir = cortexDir(projectRoot)
  const filePath = path.join(dir, 'workers.json')
  let existing: { workers: unknown[] } = { workers: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    existing = JSON.parse(raw)
  } catch (e: unknown) {
    // A missing file starts fresh; a malformed one is about to be
    // overwritten — say so instead of silently discarding it.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`workers.json at ${filePath} is unreadable or malformed — rewriting it`)
    }
  }
  if (!Array.isArray(existing.workers)) existing.workers = []

  const idx = existing.workers.findIndex((w: unknown) => {
    const id = (w as Record<string, unknown>).id
    return id === spec.id
  })
  if (idx !== -1) {
    existing.workers[idx] = spec
    process.stdout.write(`replaced worker "${spec.id}" in ${filePath}\n`)
  } else {
    existing.workers.push(spec)
    process.stdout.write(`added worker "${spec.id}" to ${filePath}\n`)
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n')
  process.stdout.write(`\nworker spec:\n${JSON.stringify(spec, null, 2)}\n`)
}

function buildSpecFromFlags(args: CliArgs): WorkerSpec {
  const provider = args.provider ?? args.task
  const workerId = args.workerId ?? provider
  switch (provider) {
    case 'openai':
      return openAiTemplate({
        id: workerId, model: args.model, apiKey: args.apiKey, baseUrl: args.baseUrl,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'anthropic':
      return anthropicTemplate({
        id: workerId, model: args.model, apiKey: args.apiKey,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'chatgpt':
      return chatGptTemplate({
        id: workerId, model: args.model, apiKey: args.apiKey,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'ollama':
      return ollamaTemplate({
        id: workerId, model: args.model, baseUrl: args.baseUrl,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'none',
      })
    case 'opencode':
      return opencodeAdapter({
        id: workerId,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'codex':
      return codexAdapter({
        id: workerId,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'cursor':
      return cursorAdapter({
        id: workerId,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'claude-cli':
      return claudeCliAdapter({
        id: workerId,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    case 'cli':
      if (!args.bin) {
        logError('--bin is required for cli template')
        process.exit(1)
      }
      return cliTemplate({
        id: workerId, bin: args.bin,
        writeAccess: (args.writeAccess as 'none' | 'patch') ?? 'patch',
      })
    default:
      logError(`template ${provider} not yet supported via CLI flags (use interactive mode)`)
      process.exit(1)
  }
}

async function commandAddWorker(args: CliArgs): Promise<void> {
  const projectRoot = args.dir ?? process.cwd()

  if (args.provider || args.task) {
    const provider = args.provider ?? args.task
    if (!provider || !TEMPLATES.some(t => t.kind === provider)) {
      logError(`unknown provider "${provider}". Available: ${TEMPLATES.map(t => t.kind).join(', ')}`)
      process.exit(1)
    }
    const spec = buildSpecFromFlags(args)
    await writeWorkerSpec(spec, projectRoot)
    return
  }

  // Interactive mode
  process.stdout.write('\n── add worker ──────────────────────────────────\n')

  await withRl(async (rli) => {
    const provider = await pick(rli, 'Choose a harness template:', TEMPLATES.map(t => {
      const label = t.adapter ? `${t.kind} (adapter)` : t.kind
      return `${label.padEnd(22)} ${t.description}`
    }))

    // Map back from the padded display string to the raw kind
    const kind = TEMPLATES.find(t => provider.startsWith(t.kind))?.kind ?? provider as TemplateKind

    let spec: WorkerSpec
    switch (kind) {
      case 'opencode':
        process.stdout.write('\n── opencode adapter ────────────────────────────\n')
        spec = opencodeAdapter({
          id: await ask(rli, 'Worker id', 'opencode'),
        })
        break
      case 'codex':
        process.stdout.write('\n── codex adapter ───────────────────────────────\n')
        spec = codexAdapter({
          id: await ask(rli, 'Worker id', 'codex'),
        })
        break
      case 'cursor':
        process.stdout.write('\n── cursor adapter ──────────────────────────────\n')
        spec = cursorAdapter({
          id: await ask(rli, 'Worker id', 'cursor'),
        })
        break
      case 'claude-cli':
        process.stdout.write('\n── claude-cli adapter ───────────────────────────\n')
        spec = claudeCliAdapter({
          id: await ask(rli, 'Worker id', 'claude-cli'),
        })
        break
      case 'openai': spec = await promptOpenAi(rli); break
      case 'anthropic': spec = await promptAnthropic(rli); break
      case 'chatgpt': spec = await promptChatGpt(rli); break
      case 'ollama': spec = await promptOllama(rli); break
      case 'cli': spec = await promptCli(rli); break
      default:
        logError(`template ${kind} not yet supported in interactive mode`)
        process.exit(1)
    }

    process.stdout.write(`\n── preview ─────────────────────────────────────\n`)
    process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`)
    const ok = await pick(rli, 'Write this worker?', ['yes', 'no'])
    if (ok !== 'yes') {
      process.stdout.write('cancelled\n')
      return
    }

    await writeWorkerSpec(spec, projectRoot)
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  const taskless = new Set(['workers', 'metrics', 'init', 'add-worker', 'blueprints', 'skills'])
  if (!taskless.has(args.command) && !args.task) {
    printHelp()
    process.exit(1)
  }

  switch (args.command) {
    case 'dispatch': return commandRun(args)
    case 'loop': return commandLoop(args)
    case 'exec': return commandExec(args)
    case 'plan': return commandPlan(args)
    case 'locate': return commandLocate(args)
    case 'workers': return commandWorkers(args)
    case 'metrics': return commandMetrics(args)
    case 'init': return commandInit(args)
    case 'add-worker': return commandAddWorker(args)
    case 'blueprints': return commandBlueprints()
    case 'skills': return commandSkills()
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  logError(`unhandled error: ${msg}`)
  process.exit(1)
})
