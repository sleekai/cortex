import { type CodeChunk, type BudgetConfig, DEFAULT_BUDGET } from '../core/types.js'
import { type UCP } from './ucp.js'
import { estimateTokens } from '../core/tokens.js'
import { info, warn, debug } from '../core/logger.js'

function totalTokens(ucp: UCP, chunks: CodeChunk[]): number {
  let total = 0
  total += estimateTokens(JSON.stringify(ucp))
  for (const c of chunks) {
    total += estimateTokens(c.signature)
    total += estimateTokens(c.source.slice(0, 500))
  }
  return total
}

export interface SpendEstimate {
  inputTokens: number
  outputTokens: number
  // (in + out) inflated by retry probability, in the worker's cost units per 1k.
  expectedSpend: number
}

export function estimateSpend(
  inputTokens: number,
  cost: { inPer1k: number; outPer1k: number },
  retryProbability: number,
  expectedOutputTokens = 800,
): SpendEstimate {
  const base = (inputTokens / 1000) * cost.inPer1k + (expectedOutputTokens / 1000) * cost.outPer1k
  return {
    inputTokens,
    outputTokens: expectedOutputTokens,
    expectedSpend: base * (1 + retryProbability),
  }
}

export interface BudgetResult {
  ucp: UCP
  chunks: CodeChunk[]
  totalTokens: number
  exceeded: boolean
  // Set when the maxSpend policy gate refuses the dispatch outright.
  refused: boolean
  refusedReason?: string
  spend?: SpendEstimate
}

export interface SpendContext {
  cost: { inPer1k: number; outPer1k: number }
}

// Degrade cascade: drop lowest-ranked chunks -> shrink facts/constraints ->
// compress the goal. Never silently expands; over maxSpend refuses instead.
export function enforceBudget(
  ucp: UCP,
  chunks: CodeChunk[],
  config: BudgetConfig = DEFAULT_BUDGET,
  spendContext?: SpendContext,
): BudgetResult {
  const sorted = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const selected: CodeChunk[] = []
  const usedFiles = new Set<string>()

  for (const c of sorted) {
    if (selected.length >= config.maxChunks) {
      debug(`budget: hit maxChunks limit (${config.maxChunks})`)
      break
    }

    const fileCountWithNew = usedFiles.has(c.file) ? usedFiles.size : usedFiles.size + 1
    if (fileCountWithNew > config.maxFiles) {
      debug(`budget: hit maxFiles limit (${config.maxFiles}) — skipping ${c.file}:${c.name}`)
      continue
    }

    selected.push(c)
    usedFiles.add(c.file)
  }

  const simplifiedUcp: UCP = {
    ...ucp,
    ctx: {
      f: selected.map(c => `${c.file}:${c.name} L${c.startLine}`),
      d: ucp.ctx.d.slice(0, 5),
    },
    c: ucp.c.slice(0, 4),
  }

  let tok = totalTokens(simplifiedUcp, selected)
  let exceeded = tok > config.maxInputTokens

  while (exceeded && selected.length > 1) {
    const removed = selected.pop()!
    usedFiles.delete(removed.file)
    simplifiedUcp.ctx.f = selected.map(c => `${c.file}:${c.name} L${c.startLine}`)
    tok = totalTokens(simplifiedUcp, selected)
    exceeded = tok > config.maxInputTokens
    warn(`budget overrun: ${tok} tokens, removed ${removed.file}:${removed.name}`)
  }

  if (exceeded) {
    simplifiedUcp.g = simplifiedUcp.g.split(' ').slice(0, 5).join(' ')
    const shortUcpStr = JSON.stringify(simplifiedUcp)
    tok = estimateTokens(shortUcpStr) + estimateTokens(selected[0]?.source.slice(0, 300) ?? '')
    exceeded = tok > config.maxInputTokens
  }

  let spend: SpendEstimate | undefined
  let refused = false
  let refusedReason: string | undefined
  if (spendContext) {
    spend = estimateSpend(tok, spendContext.cost, config.retryProbability)
    if (spend.expectedSpend > config.maxSpend) {
      refused = true
      refusedReason = `expected spend ${spend.expectedSpend.toFixed(2)} exceeds cap ${config.maxSpend}`
      warn(`budget: ${refusedReason}`)
    }
  }

  info(`budget: ${tok}/${config.maxInputTokens} tokens, ${selected.length} chunks, ${usedFiles.size} files`)

  return {
    ucp: simplifiedUcp,
    chunks: selected,
    totalTokens: tok,
    exceeded,
    refused,
    ...(refusedReason !== undefined ? { refusedReason } : {}),
    ...(spend !== undefined ? { spend } : {}),
  }
}
