import { type Artifact, type ArtifactKind, makeArtifact } from '../artifact/artifacts.js'
import { type CodeChunk } from '../core/types.js'
import { estimateTokens } from '../core/tokens.js'

export interface CompressionResult {
  text: string
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  ratio: number
}

const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'will', 'would', 'there',
  'their', 'about', 'after', 'before', 'into', 'onto', 'only', 'very', 'really',
])

function compactText(text: string, maxWords: number): string {
  return text
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => !STOP.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ')
}

export function compressText(text: string, maxTokens: number): CompressionResult {
  const originalTokens = estimateTokens(text)
  if (originalTokens <= maxTokens) {
    return { text, originalTokens, compressedTokens: originalTokens, savedTokens: 0, ratio: 1 }
  }

  const maxWords = Math.max(12, Math.floor(maxTokens * 0.75))
  let compressed = compactText(text, maxWords)
  while (estimateTokens(compressed) > maxTokens && compressed.length > 20) {
    compressed = compressed.slice(0, Math.floor(compressed.length * 0.85)).trim()
  }
  const compressedTokens = estimateTokens(compressed)
  return {
    text: compressed,
    originalTokens,
    compressedTokens,
    savedTokens: Math.max(0, originalTokens - compressedTokens),
    ratio: compressedTokens / Math.max(originalTokens, 1),
  }
}

export function compressArtifact(artifact: Artifact, maxTokens = 300): CompressionResult {
  return compressText(JSON.stringify({ kind: artifact.kind, body: artifact.body }), maxTokens)
}

export function makeCompressionArtifact(
  taskId: string,
  sourceKind: ArtifactKind | 'context' | 'history' | 'text',
  result: CompressionResult,
  makeArtifactFn: typeof makeArtifact = makeArtifact,
): Artifact<'compression'> {
  return makeArtifactFn('compression', taskId, 'compression-runtime', {
    sourceKind,
    originalTokens: result.originalTokens,
    compressedTokens: result.compressedTokens,
    savedTokens: result.savedTokens,
    ratio: result.ratio,
    text: result.text,
  })
}

export function compressChunks(chunks: CodeChunk[], maxTokens = 500): CompressionResult {
  const text = chunks
    .map(c => `${c.file}:${c.name} L${c.startLine}-${c.endLine} ${c.signature}`)
    .join('\n')
  return compressText(text, maxTokens)
}

