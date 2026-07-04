#!/usr/bin/env node

import './harness/cli-harness.js'
import './harness/http-harness.js'

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DEFAULT_BUDGET, type BudgetConfig } from './core/types.js'
import { compileIntent } from './capability/intent-compiler.js'
import { planDispatch } from './capability/planner.js'
import { DEFAULT_POLICY } from './capability/policy.js'
import { loadRegistry } from './worker/registry.js'
import { compileContext } from './retrieval/context-compiler.js'
import { generateWorkPacket } from './packet/generator.js'
import { enforceBudget } from './packet/budget-controller.js'
import { buildPrompt } from './worker/prompt.js'
import { runValidationLoop } from './validator/validation-loop.js'
import { initProject, loadState } from './state/store.js'
import { appendMetric, readMetrics, aggregateStats, reliabilityOverrides } from './state/metrics.js'
import { createHarness } from './harness/harness.js'

const server = new McpServer({
  name: 'cortex',
  version: '2.0.0',
}, {
  capabilities: {
    tools: {},
    resources: {},
  },
})

const taskSchema = { task: z.string().describe('Task description (e.g. "add JWT auth to Express app")') }
const goalSchema = { goal: z.string().optional().describe('Optional goal keywords (derived from task if omitted)') }
const dirSchema = { dir: z.string().optional().describe('Project root directory (default: cwd)') }

function resolveDir(dir?: string): string {
  return dir ?? process.cwd()
}

server.registerTool('cortex_plan', {
  title: 'cortex-plan',
  description: 'Compile intent and show dispatch plan. Read-only — no model calls, no side effects.',
  inputSchema: { ...taskSchema, ...goalSchema, ...dirSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const intent = compileIntent(args.task)
    const registry = loadRegistry(projectRoot)
    const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
    const overrides = reliabilityOverrides(projectRoot, priors)
    const plan = planDispatch(intent, registry, DEFAULT_POLICY, overrides, DEFAULT_BUDGET.retryProbability)
    return { content: [{ type: 'text', text: JSON.stringify({ intent, plan }, null, 2) }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_locate', {
  title: 'cortex-locate',
  description: 'Deterministic file pointer retrieval for a query. Read-only — no model calls.',
  inputSchema: { ...taskSchema, ...goalSchema, ...dirSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const intent = { ...compileIntent(args.task), taskType: 'locate' as const }
    const context = compileContext(projectRoot, args.goal ?? args.task, intent, DEFAULT_BUDGET)
    const text = context.pointers.length > 0 ? context.pointers.join('\n') : 'no pointers found'
    return { content: [{ type: 'text', text }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_workers', {
  title: 'cortex-workers',
  description: 'List registered workers with capabilities, harness kind, availability, and observed success rate.',
  inputSchema: { ...dirSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const registry = loadRegistry(projectRoot)
    const stats = aggregateStats(readMetrics(projectRoot))
    const lines: string[] = []
    for (const w of registry.workers) {
      let availability = 'unknown'
      try {
        availability = createHarness(w.harness).available() ? 'available' : 'UNAVAILABLE'
      } catch (e: unknown) {
        availability = `error: ${e instanceof Error ? e.message : String(e)}`
      }
      const s = stats.get(w.id)
      const observed = s ? `  success: ${(s.successRate * 100).toFixed(0)}% (${s.dispatches} dispatches)` : ''
      lines.push(`${w.id}  tier=${w.tier}  caps=${w.capabilities.join(',')}  harness=${w.harness.kind}  ${availability}${observed}`)
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_metrics', {
  title: 'cortex-metrics',
  description: 'Per-worker dispatch statistics from metrics.jsonl.',
  inputSchema: { ...dirSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const stats = aggregateStats(readMetrics(projectRoot))
    if (stats.size === 0) {
      return { content: [{ type: 'text', text: 'no metrics recorded yet' }] }
    }
    const lines: string[] = []
    for (const s of stats.values()) {
      lines.push(
        `${s.workerId}: ${s.dispatches} dispatches, ${(s.successRate * 100).toFixed(0)}% success, ` +
        `mean ${Math.round(s.meanLatencyMs)}ms, mean ${Math.round(s.meanInputTokens)} in-tokens, ` +
        `retry rate ${(s.retryRate * 100).toFixed(0)}%`,
      )
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_dispatch', {
  title: 'cortex-dispatch',
  description: 'Full dispatch pipeline: plan + context compilation + worker dispatch + validation. Makes model calls.',
  inputSchema: {
    ...taskSchema,
    ...goalSchema,
    ...dirSchema,
    budget: z.number().optional().describe('Max input tokens (default: 2500)'),
    timeout: z.number().optional().describe('Worker timeout in ms (default: 180000)'),
    dry_run: z.boolean().optional().describe('Print packet + prompt and exit without executing'),
  },
}, async (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const goal = args.goal ?? args.task
    const budget = args.budget ?? DEFAULT_BUDGET.maxInputTokens
    const timeout = args.timeout ?? 180_000
    const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

    const intent = compileIntent(args.task)
    const registry = loadRegistry(projectRoot)
    const priors = new Map(registry.workers.map(w => [w.id, w.reliability]))
    const overrides = reliabilityOverrides(projectRoot, priors)
    const plan = planDispatch(intent, registry, DEFAULT_POLICY, overrides, DEFAULT_BUDGET.retryProbability)

    if (plan.tier0) {
      const context = compileContext(projectRoot, goal, { ...intent, taskType: 'locate' as const }, budgetConfig)
      return { content: [{ type: 'text', text: context.pointers.join('\n') }] }
    }

    const context = compileContext(projectRoot, goal, intent, budgetConfig)
    const previousFacts = loadState(projectRoot).distilledFacts
    const ucp = generateWorkPacket(args.task, context.chunks, previousFacts)
    const spendContext = plan.ladder[0] ? { cost: plan.ladder[0].worker.cost } : undefined
    const budgeted = enforceBudget(ucp, context.chunks, budgetConfig, spendContext)

    if (budgeted.refused) {
      return { content: [{ type: 'text', text: `budget refused dispatch: ${budgeted.refusedReason}` }], isError: true }
    }

    if (args.dry_run) {
      const prompt = buildPrompt(budgeted.ucp, budgeted.chunks)
      const ladder = plan.ladder.map(r => `${r.worker.id} (tier ${r.worker.tier}): ${r.justification}`).join('\n')
      return { content: [
        { type: 'text', text: JSON.stringify(budgeted.ucp, null, 2) },
        { type: 'text', text: `\n--- ladder ---\n${ladder}` },
        { type: 'text', text: `\n--- prompt (${budgeted.totalTokens} est tokens) ---\n${prompt}` },
      ]}
    }

    const result = await runValidationLoop(budgeted.ucp, budgeted.chunks, plan.ladder, projectRoot, {
      timeoutMs: timeout,
      maxOutputBytes: 10 * 1024 * 1024,
      onMetric: (record) => appendMetric(projectRoot, record),
    })

    const verdict = result.success ? 'PASS' : 'FAIL'
    const output: string[] = [
      `Result: ${verdict}`,
      `Task: ${budgeted.ucp.t}`,
      `Iterations: ${result.iterations}`,
      `Patch: ${result.patch ? `${result.patch.length} chars` : 'none'}`,
      `Reasoning: ${result.reasoning || 'none'}`,
      `Validation: ${result.validation.passed ? 'passed' : 'FAILED'}`,
    ]

    if (result.validation.errors.length > 0) {
      for (const e of result.validation.errors) {
        output.push(`  Error: ${e}`)
      }
    }

    return { content: [{ type: 'text', text: output.join('\n') }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_init', {
  title: 'cortex-init',
  description: 'Scaffold .cortex/ state directory with empty workers overlay and state file.',
  inputSchema: { ...dirSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const dir = initProject(projectRoot)
    return { content: [{ type: 'text', text: `initialised cortex state directory at ${dir}` }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerResource('cortex-registry', 'cortex://registry', {
  description: 'All registered workers with capabilities, harness kind, and observed metrics',
}, async (uri) => {
  const projectRoot = process.cwd()
  const registry = loadRegistry(projectRoot)
  const stats = aggregateStats(readMetrics(projectRoot))
  const workers = registry.workers.map(w => {
    const s = stats.get(w.id)
    return {
      id: w.id,
      tier: w.tier,
      capabilities: w.capabilities,
      harness: w.harness.kind,
      contextWindow: w.contextWindow,
      speed: w.speed,
      cost: w.cost,
      reliability: w.reliability,
      quality: w.quality,
      observed: s ? { dispatches: s.dispatches, successRate: s.successRate, meanLatencyMs: s.meanLatencyMs } : null,
    }
  })
  return { contents: [{ uri: uri.href, text: JSON.stringify(workers, null, 2) }] }
})

export { server }

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const currentFile = new URL(import.meta.url).pathname
if (process.argv[1] && (process.argv[1] === currentFile || process.argv[1] === '.')) {
  main().catch((e: unknown) => {
    process.stderr.write(`mcp-server error: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
