// Ingress — normalizes heterogeneous external input into a standardized
// internal representation. Every entry point (CLI, MCP) routes through
// normalizeInput before the kernel touches the task text: raw input becomes
// a UCP packet with source metadata plus a lightweight pre-classification
// (zero model calls). A per-source adapter registry is deliberately
// deferred until a second real ingress source exists — see
// docs/adr/0002-defer-adapter-registries.md.
//
// NOT responsible for: planning, scheduling, worker selection, reasoning.

import { type UCP, type PacketAct } from '../packet/ucp.js'
import { compressGoal, extractConstraints } from '../packet/generator.js'
import * as crypto from 'node:crypto'

export type HarnessKind = 'cli' | 'mcp' | 'opencode' | 'ide' | 'web-browser' | 'http' | 'unknown'

export interface RawInput {
  content: string
  kind: HarnessKind
  sessionId?: string
  explicitGoal?: string
  constraints?: string[]
  taskId?: string
  metadata?: Record<string, unknown>
}

export interface IngressPacket {
  ucp: UCP
  source: HarnessKind
  sessionId?: string
  rawContent: string
  metadata: Record<string, unknown>
  preClassified: {
    likelyType: PacketAct
    confidence: number
  }
}

function generateTaskId(): string {
  return `in-${crypto.randomBytes(4).toString('hex')}`
}

function preClassify(content: string): { likelyType: PacketAct; confidence: number } {
  const lower = content.toLowerCase().trim()
  if (/^(review|audit|judge|critique)\b/i.test(lower)) {
    return { likelyType: 'review', confidence: 0.7 }
  }
  if (/^what\s|^how\s|^why\s|^explain\b|^decide\b|^should\b/i.test(lower) || lower.endsWith('?')) {
    return { likelyType: 'ask', confidence: 0.6 }
  }
  return { likelyType: 'work', confidence: 0.5 }
}

export function normalizeInput(raw: RawInput): IngressPacket {
  const goal = raw.explicitGoal ?? raw.content
  const ucp: UCP = {
    v: 2,
    t: raw.taskId ?? generateTaskId(),
    act: 'work',
    g: compressGoal(goal),
    c: raw.constraints ?? extractConstraints(raw.content),
    ctx: { f: [], d: [] },
    r: { out: 'patch', format: 'text' },
  }
  return {
    ucp,
    source: raw.kind,
    sessionId: raw.sessionId,
    rawContent: raw.content,
    metadata: raw.metadata ?? {},
    preClassified: preClassify(raw.content),
  }
}
