// Ingress Layer — normalizes heterogeneous external input into standardized
// internal representation. Every entry point (CLI, MCP, IDE, browser) must
// route through here before the kernel touches the task text.
//
// Responsibilities:
//   - Capture raw input from any harness
//   - Normalize into a UCP packet with source metadata
//   - Lightweight pre-classification (zero model calls)
//   - Strip irrelevant context noise
//   - Attach constraints + session continuity
//
// NOT responsible for: planning, scheduling, worker selection, reasoning.

import { type UCP, type PacketAct } from '../packet/ucp.js'
import { compressGoal, extractConstraints } from '../packet/generator.js'
import { type Artifact } from '../artifact/artifacts.js'
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

export interface OutputFormat {
  kind: string
  mimeType: string
}

export interface HarnessAdapter {
  kind: HarnessKind
  description: string
  normalize(raw: RawInput): IngressPacket
  renderOutput(artifact: Artifact): string
  renderBundle(artifacts: Artifact[]): string
  supportedFormats(): OutputFormat[]
}

const adapters = new Map<HarnessKind, HarnessAdapter>()

export function registerAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.kind, adapter)
}

export function getAdapter(kind: HarnessKind): HarnessAdapter | undefined {
  return adapters.get(kind)
}

export function registeredAdapters(): HarnessAdapter[] {
  return [...adapters.values()]
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
