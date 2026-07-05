#!/usr/bin/env node

import './harness/cli-harness.js'
import './harness/http-harness.js'

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DEFAULT_BUDGET, type BudgetConfig } from './core/types.js'
import { loadRegistry } from './worker/registry.js'
import { buildPrompt } from './worker/prompt.js'
import { planTask, prepareDispatch, runTask, runBlueprint, runLocate, listWorkers, triagedTask, type BlueprintConfig } from './kernel/index.js'
import { getPolicySet, DEFAULT_POLICIES } from './policy/policies.js'
import { renderBlueprintSummary } from './egress/egress.js'
import { initProject } from './state/store.js'
import { readMetrics, aggregateStats } from './state/metrics.js'
import { normalizeInput as ingressNormalize } from './ingress/ingress.js'
import { renderPlanSummary, renderPointerList } from './egress/egress.js'
import { isKind } from './artifact/artifacts.js'
// Triage Skill System (CTS) — opt-in per-call via the `triage` argument.
import './triage/skills/builtins.js'
import { runTriage } from './triage/pipeline.js'

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
const triageSchema = { triage: z.boolean().optional().describe('Run the Triage Skill System first (normalize + structure the task before intent compilation)') }

function resolveDir(dir?: string): string {
  return dir ?? process.cwd()
}

// Opt-in CTS seam. Triage itself runs inside the kernel (once per task) when
// config.triage is set; this surface only forwards the flag.

server.registerTool('cortex_plan', {
  title: 'cortex-plan',
  description: 'Compile intent and show dispatch plan. Read-only — no model calls, no side effects.',
  inputSchema: { ...taskSchema, ...goalSchema, ...dirSchema, ...triageSchema },
}, (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const ingressPacket = ingressNormalize({ content: args.task, kind: 'mcp', explicitGoal: args.goal, metadata: { projectRoot } })
    const cts = args.triage ? runTriage(ingressPacket) : undefined
    const task = cts ? cts.normalized_task : args.task
    const { intent, plan } = planTask(task, projectRoot, undefined, undefined, cts?.worker_recommendation)
    const data = {
      intent,
      plan,
      _ingress: {
        source: ingressPacket.source,
        sessionId: ingressPacket.sessionId,
        preClassified: ingressPacket.preClassified,
      },
      ...(cts ? { _triage: cts } : {}),
    }
    return { content: [{ type: 'text', text: renderPlanSummary(data, { targetKind: 'mcp' }) }] }
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
    const ingressPacket = ingressNormalize({ content: args.task, kind: 'mcp', explicitGoal: args.goal, metadata: { projectRoot } })
    const pointers = runLocate(args.task, projectRoot, ingressPacket.ucp.g)
    const text = renderPointerList(pointers, { targetKind: 'mcp' })
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
    const lines: string[] = []
    for (const w of listWorkers(projectRoot)) {
      const availability = w.availableError ?? (w.available ? 'available' : 'UNAVAILABLE')
      const observed = w.dispatches ? `  success: ${((w.successRate ?? 0) * 100).toFixed(0)}% (${w.dispatches} dispatches)` : ''
      lines.push(`${w.id}  tier=${w.tier}  caps=${w.capabilities.join(',')}  harness=${w.harnessKind}  ${availability}${observed}`)
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
    ...triageSchema,
  },
}, async (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const budget = args.budget ?? DEFAULT_BUDGET.maxInputTokens
    const budgetConfig: BudgetConfig = { ...DEFAULT_BUDGET, maxInputTokens: budget }

    const ingressPacket = ingressNormalize({
      content: args.task,
      kind: 'mcp',
      explicitGoal: args.goal,
      metadata: { projectRoot, budget: String(budget) },
    })
    const config = {
      projectRoot,
      goal: ingressPacket.ucp.g,
      budget: budgetConfig,
      timeoutMs: args.timeout ?? 180_000,
      triage: args.triage ?? false,
    }

    if (args.dry_run) {
      const triaged = triagedTask(args.task, config)
      const prepared = prepareDispatch(triaged.task, config, triaged.tierHint)
      if (prepared.kind === 'pointers') {
        return { content: [{ type: 'text', text: renderPointerList(prepared.pointers, { targetKind: 'mcp' }) }] }
      }
      if (prepared.kind === 'refused') {
        return { content: [{ type: 'text', text: `budget refused dispatch: ${prepared.reason}` }], isError: true }
      }
      const prompt = buildPrompt(prepared.ucp, prepared.budgeted.chunks)
      const ladder = prepared.plan.ladder.map(r => `${r.worker.id} (tier ${r.worker.tier}): ${r.justification}`).join('\n')
      return { content: [
        { type: 'text', text: JSON.stringify(prepared.ucp, null, 2) },
        { type: 'text', text: `\n--- ladder ---\n${ladder}` },
        { type: 'text', text: `\n--- prompt (${prepared.budgeted.totalTokens} est tokens) ---\n${prompt}` },
      ]}
    }

    const outcome = await runTask(args.task, config)
    if (outcome.kind === 'pointers') {
      return { content: [{ type: 'text', text: renderPointerList(outcome.pointers, { targetKind: 'mcp' }) }] }
    }
    if (outcome.kind === 'refused') {
      return { content: [{ type: 'text', text: `budget refused dispatch: ${outcome.reason}` }], isError: true }
    }

    const { result } = outcome
    const verdict = result.accepted ? 'PASS' : 'FAIL'
    const patch = result.finalOutput && isKind(result.finalOutput, 'patch') ? result.finalOutput.body.diff : ''
    const reasoning = result.finalOutput && isKind(result.finalOutput, 'patch') ? result.finalOutput.body.reasoning : ''
    const output: string[] = [
      `Result: ${verdict}`,
      `Task: ${outcome.ucp.t}`,
      `Iterations: ${result.state.iteration}`,
      `Patch: ${patch ? `${patch.length} chars` : 'none'}`,
      `Reasoning: ${reasoning || 'none'}`,
    ]

    return { content: [{ type: 'text', text: output.join('\n') }] }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

server.registerTool('cortex_exec', {
  title: 'cortex-exec',
  description: 'Blueprint execution: triage recommends a blueprint, skills run conditionally, produce steps run the CUEA closed loop with context-on-demand. Makes model calls. May return clarification questions instead of a result.',
  inputSchema: {
    ...taskSchema,
    ...goalSchema,
    ...dirSchema,
    blueprint: z.string().optional().describe('Blueprint name (default: triage recommendation; built-ins: debug, feature, pr-review, default)'),
    policies: z.string().optional().describe('Named policy set (default | strict | generous)'),
    budget: z.number().optional().describe('Max input tokens (default: policy set budget)'),
    timeout: z.number().optional().describe('Worker timeout in ms (default: policy set timeout)'),
  },
}, async (args) => {
  try {
    const projectRoot = resolveDir(args.dir)
    const policies = args.policies ? getPolicySet(args.policies) : DEFAULT_POLICIES
    if (!policies) {
      return { content: [{ type: 'text', text: `error: unknown policy set "${args.policies}"` }], isError: true }
    }
    const config: BlueprintConfig = {
      projectRoot,
      policies,
      raw: args.task,
      ...(args.goal ? { goal: args.goal } : {}),
      ...(args.blueprint ? { blueprint: args.blueprint } : {}),
      ...(args.budget ? { budget: { ...DEFAULT_BUDGET, maxInputTokens: args.budget } } : {}),
      ...(args.timeout ? { timeoutMs: args.timeout } : {}),
    }
    const outcome = await runBlueprint(args.task, config)
    const text = renderBlueprintSummary({
      taskId: outcome.artifacts[0]?.taskId ?? '',
      blueprint: outcome.blueprint,
      kind: outcome.kind,
      accepted: outcome.kind === 'completed' ? outcome.accepted : false,
      steps: outcome.steps,
      questions: outcome.kind === 'clarification' ? outcome.questions : [],
      artifacts: outcome.artifacts,
      ...(outcome.kind === 'completed' && outcome.produce ? { produce: outcome.produce.summary } : {}),
    }, { targetKind: 'mcp' })
    return { content: [{ type: 'text', text }] }
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
