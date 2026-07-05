// Egress Layer — converts Cortex artifacts into harness-native output formats.
// Every exit point (CLI, MCP, IDE, browser) routes through here so formatting
// is never duplicated across surfaces.
//
// Responsibilities:
//   - Convert typed artifacts into harness-specific text/JSON
//   - Preserve artifact structure where possible
//   - Attach execution metadata (cost, latency, worker selection)
//   - Multi-artifact bundle rendering
//
// NOT responsible for: modifying execution results, re-running reasoning,
// altering decisions made by scheduler or workers.

import { type Artifact, type ArtifactKind, isKind, type ReviewFinding } from '../artifact/artifacts.js'
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

type ArtifactRenderer = (artifact: Artifact, options: EgressOptions) => string

const renderers = new Map<ArtifactKind, ArtifactRenderer>()

export function registerRenderer(kind: ArtifactKind, renderer: ArtifactRenderer): void {
  renderers.set(kind, renderer)
}

export function registeredRenderers(): ArtifactKind[] {
  return [...renderers.keys()]
}

export function renderArtifact(artifact: Artifact, options: EgressOptions): string {
  const renderer = renderers.get(artifact.kind)
  if (renderer) return renderer(artifact, options)
  return jsonRender(artifact, options)
}

export function renderBundle(artifacts: Artifact[], options: EgressOptions): string {
  const parts: string[] = []
  for (const art of artifacts) {
    parts.push(renderArtifact(art, options))
  }
  return parts.join('\n---\n')
}

function jsonRender(artifact: Artifact, options: EgressOptions): string {
  const indent = options.indent ?? 2
  return options.targetKind === 'mcp'
    ? JSON.stringify(artifact.body)
    : JSON.stringify(artifact.body, null, indent)
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

// ── Built-in renderers ───────────────────────────────────────────────

registerRenderer('patch', (artifact, options) => {
  if (!isKind(artifact, 'patch')) return jsonRender(artifact, options)
  const { diff, reasoning } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ diff, reasoning })
  }
  const lines: string[] = []
  if (reasoning) lines.push(`Reason: ${reasoning}`)
  if (diff) lines.push(`\n${diff}`)
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  return lines.join('\n')
})

registerRenderer('plan', (artifact, options) => {
  if (!isKind(artifact, 'plan')) return jsonRender(artifact, options)
  const { steps } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify(steps)
  }
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
})

registerRenderer('decision', (artifact, options) => {
  if (!isKind(artifact, 'decision')) return jsonRender(artifact, options)
  const { question, decision, why } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ question, decision, why })
  }
  const lines: string[] = []
  if (question) lines.push(`Q: ${question}`)
  lines.push(`Decision: ${decision}`)
  if (why) lines.push(`Why: ${why}`)
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  return lines.join('\n')
})

registerRenderer('review', (artifact, options) => {
  if (!isKind(artifact, 'review')) return jsonRender(artifact, options)
  const { verdict, findings } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ verdict, findings })
  }
  const lines: string[] = [`Verdict: ${verdict}`]
  for (const f of findings) {
    lines.push(`  [${f.severity}] ${f.pointer}: ${f.finding}`)
  }
  if (options.includeMetadata && options.metadata) {
    lines.push('', ...metadataBlock(options.metadata))
  }
  return lines.join('\n')
})

registerRenderer('test-result', (artifact, options) => {
  if (!isKind(artifact, 'test-result')) return jsonRender(artifact, options)
  const { passed, errors, output } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ passed, errors, output })
  }
  const lines: string[] = [`Tests: ${passed ? 'PASS' : 'FAIL'}`]
  if (errors.length > 0) {
    lines.push('Errors:')
    for (const e of errors) lines.push(`  - ${e}`)
  }
  if (output) lines.push(`\n${output}`)
  return lines.join('\n')
})

registerRenderer('pointer-set', (artifact, options) => {
  if (!isKind(artifact, 'pointer-set')) return jsonRender(artifact, options)
  const { pointers } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify(pointers)
  }
  return pointers.length > 0 ? pointers.join('\n') : 'no pointers found'
})

registerRenderer('failure', (artifact, options) => {
  if (!isKind(artifact, 'failure')) return jsonRender(artifact, options)
  const { reason, recoverable } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ reason, recoverable })
  }
  const tag = recoverable ? 'RECOVERABLE' : 'UNRECOVERABLE'
  return `FAILURE [${tag}]: ${reason}`
})

registerRenderer('clarification', (artifact, options) => {
  if (!isKind(artifact, 'clarification')) return jsonRender(artifact, options)
  const { questions, reason } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ questions, reason })
  }
  const lines: string[] = ['CLARIFICATION NEEDED']
  if (reason) lines.push(`Reason: ${reason}`)
  for (const q of questions) lines.push(`  ? ${q}`)
  return lines.join('\n')
})

registerRenderer('token-estimate', (artifact, options) => {
  if (!isKind(artifact, 'token-estimate')) return jsonRender(artifact, options)
  const { inputTokens, outputTokens, expectedSpend } = artifact.body
  if (options.targetKind === 'mcp') {
    return JSON.stringify({ inputTokens, outputTokens, expectedSpend })
  }
  return `~${inputTokens} in / ~${outputTokens} out — spend ≈ ${expectedSpend}`
})

registerRenderer('intent', (artifact, options) => {
  return jsonRender(artifact, options)
})

registerRenderer('metric', (artifact, options) => {
  return jsonRender(artifact, options)
})

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
