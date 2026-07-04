export type ChunkKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable'
export type ChunkScore = number

export interface CodeChunk {
  file: string
  name: string
  kind: ChunkKind
  source: string
  startLine: number
  endLine: number
  signature: string
  score: ChunkScore
}

export interface ValidationResult {
  passed: boolean
  errors: string[]
  output: string
  iteration: number
}

export interface BudgetConfig {
  maxInputTokens: number
  maxFiles: number
  maxChunks: number
  // Spend ceiling in the worker's relative cost units; Infinity = uncapped.
  maxSpend: number
  // Prior probability a dispatch needs a retry, corrected by metrics.
  retryProbability: number
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxInputTokens: 2500,
  maxFiles: 3,
  maxChunks: 7,
  maxSpend: Number.POSITIVE_INFINITY,
  retryProbability: 0.25,
}
