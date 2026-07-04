import { type CodeChunk } from '../core/types.js'
import { type UCP, type PacketOut, type PacketFormat, MAX_FACTS } from './ucp.js'
import * as crypto from 'node:crypto'

function hash(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 8)
}

export function compressGoal(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'that', 'this', 'with', 'from', 'you', 'are'].includes(w))
    .slice(0, 15)
    .join(' ')
}

export function extractConstraints(task: string): string[] {
  const constraints: string[] = []
  const patterns = [
    /(?:must|should|need|require|ensure)\s+((?:not\s+)?(?:to\s+)?.+?)(?:\.|$)/gi,
    /((?:except|without|don't|dont|avoid|exclude|skip)\s+.+?)(?:\.|$)/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(task)) !== null) {
      constraints.push(match[1]!.trim())
    }
  }
  return constraints.length > 0 ? [...new Set(constraints)] : []
}

function serializeChunks(chunks: CodeChunk[]): string[] {
  const seen = new Set<string>()
  return chunks
    .filter(c => {
      const key = `${c.file}:${c.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(c => `${c.file}:${c.name}`)
}

function serializeFacts(chunks: CodeChunk[]): string[] {
  return chunks.map(c => `f:${c.name} @${c.file} L${c.startLine}-${c.endLine}`)
}

export interface GenerateOptions {
  out?: PacketOut
  format?: PacketFormat
  existingTaskId?: string
}

export function generateWorkPacket(
  task: string,
  chunks: CodeChunk[],
  distilledFacts: string[],
  options: GenerateOptions = {},
): UCP {
  const taskId = options.existingTaskId ?? `t${hash(task)}`
  const fullFacts = [...serializeFacts(chunks), ...distilledFacts]

  return {
    v: 2,
    t: taskId,
    act: 'work',
    g: compressGoal(task),
    c: extractConstraints(task),
    ctx: {
      f: serializeChunks(chunks),
      d: fullFacts.slice(0, MAX_FACTS),
    },
    r: {
      out: options.out ?? 'patch',
      format: options.format ?? 'unified diff',
    },
  }
}

export function generateAskPacket(
  taskId: string,
  question: string,
  constraints: string[],
  pointers: string[],
  facts: string[],
  out: PacketOut = 'decision',
): UCP {
  return {
    v: 2,
    t: taskId,
    act: 'ask',
    g: compressGoal(question),
    q: question,
    c: constraints,
    ctx: { f: pointers, d: facts.slice(0, MAX_FACTS) },
    r: { out, format: 'json' },
  }
}

// Error-only retry packet: context is never resent — only the failure evidence.
export function generateErrorPacket(
  taskId: string,
  originalGoal: string,
  errorDiff: string,
  errorSummary: string,
  attemptNum: number,
): UCP {
  return {
    v: 2,
    t: `${taskId}-v${attemptNum}`,
    act: 'work',
    g: `fix ${originalGoal}`,
    c: ['previous attempt failed', 'retry with different approach'],
    ctx: {
      f: [],
      d: [
        `error: ${errorSummary}`,
        `attempt: ${attemptNum}`,
        'diff of failures:',
        errorDiff.slice(0, 800),
      ],
    },
    r: {
      out: 'patch',
      format: 'unified diff',
    },
  }
}
