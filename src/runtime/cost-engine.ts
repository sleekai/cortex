import { type BudgetConfig } from '../core/types.js'
import { estimateTokens } from '../core/tokens.js'
import { type SpendEstimate } from '../packet/budget-controller.js'

export interface CostLedger {
  promptTokens: number
  completionTokens: number
  cumulativeCost: number
  compressionSavings: number
  escalationCost: number
  estimatedRemainingBudget: number
}

export function emptyCostLedger(budget: BudgetConfig): CostLedger {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cumulativeCost: 0,
    compressionSavings: 0,
    escalationCost: 0,
    estimatedRemainingBudget: Number.isFinite(budget.maxSpend) ? budget.maxSpend : Number.POSITIVE_INFINITY,
  }
}

export function recordSpend(ledger: CostLedger, spend: SpendEstimate | undefined, budget: BudgetConfig): CostLedger {
  if (!spend) return ledger
  const cumulativeCost = ledger.cumulativeCost + spend.expectedSpend
  return {
    ...ledger,
    promptTokens: ledger.promptTokens + spend.inputTokens,
    completionTokens: ledger.completionTokens + spend.outputTokens,
    cumulativeCost,
    estimatedRemainingBudget: Number.isFinite(budget.maxSpend)
      ? Math.max(0, budget.maxSpend - cumulativeCost)
      : Number.POSITIVE_INFINITY,
  }
}

export function recordAttemptCost(
  ledger: CostLedger,
  promptTokens: number,
  completionTokens: number,
  cost: number,
  budget: BudgetConfig,
): CostLedger {
  const cumulativeCost = ledger.cumulativeCost + cost
  return {
    ...ledger,
    promptTokens: ledger.promptTokens + promptTokens,
    completionTokens: ledger.completionTokens + completionTokens,
    cumulativeCost,
    estimatedRemainingBudget: Number.isFinite(budget.maxSpend)
      ? Math.max(0, budget.maxSpend - cumulativeCost)
      : Number.POSITIVE_INFINITY,
  }
}

export function recordCompressionSavings(ledger: CostLedger, savedTokens: number): CostLedger {
  return { ...ledger, compressionSavings: ledger.compressionSavings + Math.max(0, savedTokens) }
}

export function recordEscalationCost(ledger: CostLedger, cost: number): CostLedger {
  return { ...ledger, escalationCost: ledger.escalationCost + Math.max(0, cost) }
}

export function tokenCost(text: string, cost: { inPer1k: number; outPer1k: number }, direction: 'in' | 'out'): number {
  const tokens = estimateTokens(text)
  const rate = direction === 'in' ? cost.inPer1k : cost.outPer1k
  return (tokens / 1000) * rate
}

