// Single source of truth for token estimation. Providers disagree and CLI
// workers report nothing, so the kernel plans against one estimator and lets
// metrics correct it over time (see state/metrics.ts).
const CHARS_PER_TOKEN = 3.5

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function estimateTokensAll(parts: string[]): number {
  let total = 0
  for (const p of parts) total += estimateTokens(p)
  return total
}
