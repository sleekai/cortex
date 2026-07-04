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
import { compileIntent } from './capability/intent-compiler.js'
import { planDispatch, type Plan } from './capability/planner.js'
import { DEFAULT_POLICY } from './capability/policy.js'
import { loadRegistry } from './worker/registry.js'
import { compileContext } from './retrieval/context-compiler.js'
import { generateWorkPacket } from './packet/generator.js'
import { enforceBudget } from './packet/budget-controller.js'
import { buildPrompt } from './worker/prompt.js'
import { runValidationLoop, type LoopResult } from './validator/validation-loop.js'
import { initProject, updateState, loadState, saveArtifact, stateDir } from './state/store.js'
import { appendMetric, readMetrics, aggregateStats, reliabilityOverrides } from './state/metrics.js'
import { createHarness } from './harness/harness.js'
import { type UCP } from './packet/ucp.js'

interface CliArgs {
  command: 'run' | 'dispatch' | 'plan' | 'locate' | 'workers' | 'metrics' | 'init'
  task: string
  goal?: string
  dir?: string
  stateDir?: string
  budget?: string
  timeout?: string
  dryRun?: boolean
}

const COMMANDS = new Set(['run', 'dispatch', 'plan', 'locate', 'workers', 'metrics', 'init'])

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
    } else if (arg === '--dry-run') {
      args.dryRun = true
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
  cortex plan <task> [options]       print intent + dispatch plan, no model call
  cortex locate <keywords> [options] tier-0 deterministic pointers, no model call
  cortex workers [options]           list registered workers + availability
  cortex metrics [options]           per-worker stats from .cortex/metrics.jsonl

Options:
  --task, -t     Task description (required for dispatch/plan/locate)
  --goal, -g     Goal keywords (optional, derived from task if omitted)
  --dir, -d      Project root directory (default: cwd)
  --state-dir    State directory override (env: CORTEX_DIR, default: <.cortex>)
  --budget       Max input tokens (default: ${DEFAULT_BUDGET.maxInputTokens})
  --timeout      Worker timeout in ms (default: 180000)
  --dry-run      Print packet + prompt and exit (no model call, no patch)
  --help, -h     Show help

Examples:
  cortex init
  cortex dispatch "add JWT auth middleware to Express app"
  cortex plan --task "fix login form validation" --dir ./my-app
  cortex locate "budget enforcement" --dir .
`)
}

function printResult(ucp: UCP, result: LoopResult): void {
  const verdict = result.success ? 'PASS' : 'FAIL'
  const border = '═'.repeat(60)

  const output: string[] = [
    '',
    border,
    `  CORTEX RESULT: ${verdict}`,
    border,
    `  Task:    ${ucp.t}`,
    `  Goal:    ${ucp.g}`,
    `  Iter:    ${result.iterations}`,
    '',
    `  Patch:   ${result.patch ? `${result.patch.length} chars` : 'none'}`,
    `  Reason:  ${result.reasoning || 'none'}`,
    `  Hooks:   ${result.validation.passed ? 'passed' : 'FAILED'}`,
  ]

  if (result.validation.errors.length > 0) {
    output.push('', '  Errors:')
    for (const e of result.validation.errors) {
      output.push(`    - ${e}`)
    }
  }

  output.push(border, '')
  process.stdout.write(output.join('\n'))

  if (!result.success) {
    process.exit(1)
  }
}

function buildPlan(task: string, projectRoot: string): { plan: Plan; intent: ReturnType<typeof compileIntent> } {
  const intent = compileIntent(task)
  const registry = loadRegistry(projectRoot)
  const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
  const overrides = reliabilityOverrides(projectRoot, priors)
  const plan = planDispatch(intent, registry, DEFAULT_POLICY, overrides, DEFAULT_BUDGET.retryProbability)
  return { plan, intent }
}

async function commandRun(args: CliArgs): Promise<void> {
  if (args.stateDir) process.env['CORTEX_DIR'] = args.stateDir
  const projectRoot = args.dir ?? process.cwd()
  const goal = args.goal ?? args.task
  const budget = args.budget ? parseInt(args.budget, 10) : DEFAULT_BUDGET.maxInputTokens
  const timeout = args.timeout ? parseInt(args.timeout, 10) : 180_000
  const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

  info(`project: ${projectRoot}`)
  info(`task: ${args.task}`)
  info(`goal: ${goal}`)

  const { plan, intent } = buildPlan(args.task, projectRoot)
  info(`intent: ${intent.taskType}/${intent.complexity} conf=${intent.confidence.toFixed(2)} caps=${intent.capabilities.join('+')}`)

  const context = compileContext(projectRoot, goal, intent, budgetConfig)
  for (const escalation of context.escalations) {
    info(`context: ${escalation}`)
  }

  if (plan.tier0 || intent.taskType === 'locate') {
    process.stdout.write(context.pointers.join('\n') + '\n')
    return
  }

  const previousFacts = loadState(projectRoot).distilledFacts
  const ucp = generateWorkPacket(args.task, context.chunks, previousFacts)
  const spendContext = plan.ladder[0] ? { cost: plan.ladder[0].worker.cost } : undefined
  const budgeted = enforceBudget(ucp, context.chunks, budgetConfig, spendContext)

  if (budgeted.refused) {
    logError(`budget refused dispatch: ${budgeted.refusedReason}`)
    process.exit(1)
  }
  if (budgeted.exceeded) {
    warn(`budget exceeded (${budgeted.totalTokens} > ${budgetConfig.maxInputTokens}) — reduced context`)
  }

  if (args.dryRun) {
    const prompt = buildPrompt(budgeted.ucp, budgeted.chunks)
    process.stdout.write(JSON.stringify(budgeted.ucp, null, 2) + '\n')
    process.stdout.write(`\n--- ladder ---\n${plan.ladder.map(r => `${r.worker.id} (tier ${r.worker.tier}): ${r.justification}`).join('\n')}\n`)
    process.stdout.write(`\n--- prompt (${budgeted.totalTokens} est tokens) ---\n${prompt}\n`)
    return
  }

  info('starting validation loop...')
  const result = await runValidationLoop(budgeted.ucp, budgeted.chunks, plan.ladder, projectRoot, {
    timeoutMs: timeout,
    maxOutputBytes: 10 * 1024 * 1024,
    onMetric: (record) => appendMetric(projectRoot, record),
  })

  for (const artifact of result.artifacts) {
    saveArtifact(projectRoot, artifact)
  }
  updateState(projectRoot, ucp.t, result.patch, budgeted.chunks, result.iterations)
  printResult(budgeted.ucp, result)
}

function commandPlan(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const { plan, intent } = buildPlan(args.task, projectRoot)
  process.stdout.write(JSON.stringify({
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
  }, null, 2) + '\n')
}

function commandLocate(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const intent = { ...compileIntent(args.task), taskType: 'locate' as const }
  const context = compileContext(projectRoot, args.goal ?? args.task, intent, DEFAULT_BUDGET)
  process.stdout.write(context.pointers.join('\n') + '\n')
}

function commandWorkers(args: CliArgs): void {
  const projectRoot = args.dir ?? process.cwd()
  const registry = loadRegistry(projectRoot)
  const stats = aggregateStats(readMetrics(projectRoot))
  for (const w of registry.workers) {
    let availability = 'unknown'
    try {
      availability = createHarness(w.harness).available() ? 'available' : 'UNAVAILABLE'
    } catch (e: unknown) {
      availability = `error: ${e instanceof Error ? e.message : String(e)}`
    }
    const s = stats.get(w.id)
    const observed = s ? ` observed: ${(s.successRate * 100).toFixed(0)}% over ${s.dispatches} dispatches` : ''
    process.stdout.write(
      `${w.id}  tier=${w.tier}  caps=${w.capabilities.join(',')}  harness=${w.harness.kind}  ${availability}${observed}\n`,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  if (args.command !== 'workers' && args.command !== 'metrics' && args.command !== 'init' && !args.task) {
    printHelp()
    process.exit(1)
  }

  switch (args.command) {
    case 'dispatch': return commandRun(args)
    case 'plan': return commandPlan(args)
    case 'locate': return commandLocate(args)
    case 'workers': return commandWorkers(args)
    case 'metrics': return commandMetrics(args)
    case 'init': return commandInit(args)
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  logError(`unhandled error: ${msg}`)
  process.exit(1)
})
