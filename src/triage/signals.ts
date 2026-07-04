// Shared deterministic heuristics for the triage skills. Regex signal tables in
// the style of intent-compiler.ts, but kept local to src/triage/ so CTS never
// imports the Intent Compiler — the two layers stay strictly separated (spec §2).
// Pure functions only; no state, no I/O.

export type TriageComplexity = 'trivial' | 'bounded' | 'open'

// A file/path token, e.g. src/auth.ts. Mirrors the intent-compiler FILE_HINT.
const FILE_TOKEN = /(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|go|rs|java|rb|php|sh|yml|yaml|toml))(?=$|[\s"'`),.:;])/g

// An identifier-shaped token worth keeping as required context: camelCase,
// snake_case, dotted member access, or a `backtick` span.
const IDENTIFIER = /`[^`]+`|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b\w+\.\w+\b/g

export const PATCH_VERBS = /\b(?:fix|add|implement|refactor|update|remove|delete|rename|change|write|create|build|migrate|patch)\b/i
export const LOCATE_VERBS = /\b(?:find|locate|list|search|show|where\s+is)\b/i

const OPEN_SIGNALS = [/\bre-?architect/i, /\bacross\b/i, /\ball\b/i, /\bentire\b/i, /\bmigrat/i, /\bredesign\b/i, /\bcross-cutting\b/i, /\beverywhere\b/i]
const TRIVIAL_SIGNALS = [/\btypo\b/i, /\brename\b/i, /\bcomment\b/i, /\bformat\b/i, /\bbump\b/i, /\bone[- ]line\b/i]

export const VAGUE_SIGNALS = [/\bsomehow\b/i, /\bsome(?:thing|where)?\b/i, /\betc\.?\b/i, /\bstuff\b/i, /\band so on\b/i, /\bor whatever\b/i]
export const CONFLICT_SIGNALS = [/\bbut\b/i, /\bhowever\b/i, /\binstead\b/i, /\bactually,?\s+(?:no|not)\b/i]
export const HUMAN_SIGNALS = [/\bbrowser\b/i, /\bclick\b/i, /\bscreenshot\b/i, /\bmanual(?:ly)?\b/i, /\blog\s?in\b/i, /\bsign\s?in\b/i, /\bcaptcha\b/i, /\bhuman\b/i, /\bby hand\b/i]

const OPTIONAL_CUE = /\b(?:optional(?:ly)?|if possible|if you can|nice to have|ideally|would be nice)\b/i
// Cues that make a clause depend on the one before it.
const SEQUENTIAL_CUE = /^(?:then|after(?:wards)?|once|next|finally|and then|,?\s*then)\b/i
export const POLITENESS = /\b(?:please|kindly|could you|can you|would you|i(?:'| a)?m wondering if you could|i(?:'| wa)?nt you to|i need you to|let(?:'|')?s|we should)\b/gi
export const GREETING = /^(?:hi|hey|hello|yo|greetings|good (?:morning|afternoon|evening))\b[\s,!.]*/i
export const FILLER = /\b(?:just|really|basically|actually|simply|kind of|sort of|you know|by the way|as i (?:mentioned|said))\b/gi

export function wordCount(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

export function extractFileTokens(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  FILE_TOKEN.lastIndex = 0
  while ((m = FILE_TOKEN.exec(text)) !== null) out.add(m[1]!)
  return [...out]
}

export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  IDENTIFIER.lastIndex = 0
  while ((m = IDENTIFIER.exec(text)) !== null) {
    out.add(m[0]!.replace(/`/g, ''))
  }
  return [...out]
}

// Split a normalized task into ordered clauses. Enumerations (numbered or
// bulleted), sentence boundaries, and coordinating cues each break a clause.
export function splitClauses(text: string): string[] {
  return text
    // numbered "1." / "1)" and bullet "- " / "* " markers → boundary
    .replace(/(?:^|\s)(?:\d+[.)]|[-*•])\s+/g, '\n')
    // sentence terminators
    .replace(/([.!?])\s+/g, '$1\n')
    // coordinating / sequencing cues
    .replace(/\s*;\s*/g, '\n')
    .replace(/\s+and then\s+/gi, '\nthen ')
    .replace(/,\s*then\s+/gi, '\nthen ')
    .replace(/\s+then\s+/gi, '\nthen ')
    .replace(/\s+and also\s+/gi, '\nalso ')
    .split('\n')
    .map(c => c.trim().replace(/[.!?,;]+$/, '').trim())
    .filter(c => wordCount(c) >= 1)
}

export function isOptionalClause(clause: string): boolean {
  return OPTIONAL_CUE.test(clause)
}

export function isSequentialClause(clause: string): boolean {
  return SEQUENTIAL_CUE.test(clause.trim())
}

// Shared complexity read so strategy and routing agree. Deterministic.
export function complexityOf(text: string, fileCount: number, subtaskCount: number): TriageComplexity {
  if (OPEN_SIGNALS.some(rx => rx.test(text)) || fileCount > 3 || subtaskCount >= 5) return 'open'
  if (TRIVIAL_SIGNALS.some(rx => rx.test(text)) && fileCount <= 1 && subtaskCount <= 1) return 'trivial'
  return 'bounded'
}
