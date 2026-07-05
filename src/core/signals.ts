export type SignalComplexity = 'trivial' | 'bounded' | 'open'

export const FILE_PATTERN = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|java|rb|php|sh|yml|yaml|toml))(?=$|[\s"'`),.:;])/g

export const OPEN_SIGNALS = [/\bre-?architect/i, /\bacross\b/i, /\ball\b/i, /\bentire\b/i, /\bmigrat/i, /\bredesign\b/i, /\bcross-cutting\b/i, /\beverywhere\b/i]
export const TRIVIAL_SIGNALS = [/\btypo\b/i, /\brename\b/i, /\bcomment\b/i, /\bformat\b/i, /\bbump\b/i, /\bone[- ]line\b/i]

export function extractFileTokens(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  FILE_PATTERN.lastIndex = 0
  while ((m = FILE_PATTERN.exec(text)) !== null) out.add(m[1]!)
  return [...out]
}

export function classifyComplexity(text: string, fileCount: number, subtaskCount?: number): SignalComplexity {
  if (OPEN_SIGNALS.some(rx => rx.test(text)) || fileCount > 3 || (subtaskCount ?? 0) >= 5) return 'open'
  if (TRIVIAL_SIGNALS.some(rx => rx.test(text)) && fileCount <= 1 && (subtaskCount ?? 0) <= 1) return 'trivial'
  return 'bounded'
}
