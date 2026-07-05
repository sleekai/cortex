// Egress — converts Cortex results into harness-native output. Every exit
// point (CLI, MCP) routes through the summary renderers below so formatting
// is never duplicated across surfaces; each renderer is format-aware via
// EgressOptions.targetKind. A per-artifact-kind renderer registry is
// deliberately deferred until a second real egress target exists — see
// docs/adr/0002-defer-adapter-registries.md.
//
// NOT responsible for: modifying execution results, re-running reasoning,
// altering decisions made by scheduler or workers.

import { type Artifact } from '../artifact/artifacts.js'
import { type HarnessKind } from '../ingress/ingress.js'

export interface ExecutionMetadata {
  taskId: string
  workerId?: string
  tier?: number
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  expectedSpend?: number
  iterationCount?: number
  validationPassed?: boolean
}

export interface EgressOptions {
  targetKind: HarnessKind
  includeMetadata?: boolean
  metadata?: ExecutionMetadata
  indent?: number
}

function metadataBlock(meta: ExecutionMetadata): string[] {
  const lines: string[] = []
  if (meta.workerId) lines.push(`  Worker:   ${meta.workerId}${meta.tier !== undefined ? ` (tier ${meta.tier})` : ''}`)
  if (meta.latencyMs !== undefined) lines.push(`  Latency:  ${meta.latencyMs}ms`)
  if (meta.inputTokens !== undefined || meta.iterationCount !== undefined) {
    const parts: string[] = []
    if (meta.inputTokens !== undefined) parts.push(`${meta.inputTokens} in`)
    if (meta.outputTokens !== undefined) parts.push(`${meta.outputTokens} out`)
    if (meta.iterationCount !== undefined) parts.push(`${meta.iterationCount} iter(s)`)
    if (parts.length > 0) lines.push(`  Tokens:   ${parts.join(', ')}`)
  }
  if (meta.expectedSpend !== undefined) lines.push(`  Spend:    ${meta.expectedSpend.toFixed(2)}`)
  return lines
}

// ── High-level result renderers for entry points ─────────────────────

export interface DispatchSummary {
  kind: string
  taskId: string
  goal: string
  success: boolean
  iterations: number
  patchLength: number
  reasoning: string
  validationPassed: boolean
  validationErrors: string[]
}

export function renderDispatchSummary(summary: DispatchSummary, options: EgressOptions): string {
  const verdict = summary.success ? 'PASS' : 'FAIL'
  const border = '═'.repeat(60)
  const lines: string[] = [
    '',
    border,
    `  CORTEX RESULT: ${verdict}`,
    border,
    `  Task:    ${summary.taskId}`,
    `  Goal:    ${summary.goal}`,
    `  Iter:    ${summary.iterations}`,
    '',
    `  Patch:   ${summary.patchLength > 0 ? `${summary.patchLength} chars` : 'none'}`,
    `  Reason:  ${summary.reasoning || 'none'}`,
    `  Hooks:   ${summary.validationPassed ? 'passed' : 'FAILED'}`,
  ]
  if (summary.validationErrors.length > 0) {
    lines.push('', '  Errors:')
    for (const e of summary.validationErrors) {
      lines.push(`    - ${e}`)
    }
  }
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  lines.push(border, '')
  return lines.join('\n')
}

// CUEA loop result (spec §8): the final artifact plus loop telemetry — status,
// iteration/escalation counts, accrued cost, and the worker path the Router
// walked. Mirrors renderDispatchSummary's frame so both surfaces read alike.
export interface LoopSummary {
  taskId: string
  goal: string
  status: string
  accepted: boolean
  iterations: number
  escalationDepth: number
  cost: number
  terminationReason: string
  workerPath: string[]
  finalReasoning: string
  patchLength: number
  issues: string[]
}

export function renderLoopSummary(summary: LoopSummary, options: EgressOptions): string {
  if (options.targetKind === 'mcp') {
    return JSON.stringify(summary)
  }
  const verdict = summary.accepted ? 'ACCEPTED' : 'STOPPED'
  const border = '═'.repeat(60)
  const lines: string[] = [
    '',
    border,
    `  CORTEX LOOP: ${verdict}  (${summary.status})`,
    border,
    `  Task:    ${summary.taskId}`,
    `  Goal:    ${summary.goal}`,
    `  Stop:    ${summary.terminationReason}`,
    '',
    `  Iter:    ${summary.iterations}   Escalations: ${summary.escalationDepth}   Cost: ${summary.cost.toFixed(2)}`,
    `  Patch:   ${summary.patchLength > 0 ? `${summary.patchLength} chars` : 'none'}`,
    `  Reason:  ${summary.finalReasoning || 'none'}`,
  ]
  if (summary.workerPath.length > 0) {
    lines.push('', '  Path:')
    for (const step of summary.workerPath) lines.push(`    → ${step}`)
  }
  if (!summary.accepted && summary.issues.length > 0) {
    lines.push('', '  Open issues:')
    for (const e of summary.issues) lines.push(`    - ${e}`)
  }
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  lines.push(border, '')
  return lines.join('\n')
}

// Blueprint run result (MVP): which blueprint ran, which steps executed or
// were skipped (and why), the loop telemetry when a produce step ran, and the
// rendered artifacts. Mirrors renderLoopSummary's frame.
export interface BlueprintSummary {
  taskId: string
  blueprint: string
  kind: 'clarification' | 'completed'
  accepted: boolean
  steps: { id: string; kind: string; ran: boolean; reason?: string }[]
  questions: string[]
  artifacts: Artifact[]
  produce?: { iterations: number; escalationDepth: number; cost: number; terminationReason: string; status: string }
}

export function renderBlueprintSummary(summary: BlueprintSummary, options: EgressOptions): string {
  if (options.targetKind === 'mcp') {
    return JSON.stringify(summary)
  }
  const border = '═'.repeat(60)
  const verdict = summary.kind === 'clarification' ? 'NEEDS CLARIFICATION' : summary.accepted ? 'ACCEPTED' : 'STOPPED'
  const lines: string[] = [
    '',
    border,
    `  CORTEX BLUEPRINT: ${verdict}  (${summary.blueprint})`,
    border,
    `  Task:    ${summary.taskId}`,
    '',
    '  Steps:',
  ]
  for (const s of summary.steps) {
    lines.push(`    ${s.ran ? '✓' : '·'} ${s.id} (${s.kind})${s.reason ? ` — ${s.reason}` : ''}`)
  }
  if (summary.produce) {
    lines.push('', `  Loop:    ${summary.produce.iterations} iter, ${summary.produce.escalationDepth} escalation(s), cost ${summary.produce.cost.toFixed(2)}`)
    lines.push(`  Stop:    ${summary.produce.terminationReason}`)
  }
  if (summary.questions.length > 0) {
    lines.push('', '  Questions:')
    for (const q of summary.questions) lines.push(`    ? ${q}`)
  }
  if (summary.artifacts.length > 0) {
    lines.push('', '  Artifacts:')
    for (const a of summary.artifacts) lines.push(`    - ${a.kind} (${a.id}) by ${a.producedBy}`)
  }
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  lines.push(border, '')
  return lines.join('\n')
}

export function renderPlanSummary(data: object, options: EgressOptions): string {
  return options.targetKind === 'mcp'
    ? JSON.stringify(data)
    : JSON.stringify(data, null, options.indent ?? 2)
}

export function renderPointerList(pointers: string[], options: EgressOptions): string {
  if (options.targetKind === 'mcp') {
    return pointers.length > 0 ? pointers.join('\n') : 'no pointers found'
  }
  return pointers.length > 0 ? pointers.join('\n') : 'no pointers found'
}
