// Progressive context compiler. Context is expensive; it expands one level at
// a time and only with budget headroom, never silently. The engine underneath
// is the existing deterministic stack: AST parsing, TF-IDF ranking,
// git-recency boost.
import * as path from 'node:path'
import * as fs from 'node:fs'
import { type CodeChunk, type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { parseDirectory, findSourceFiles } from './ast-parser.js'
import { rankChunks } from './embedder.js'
import { prioritizeRecent } from './git-priority.js'
import { estimateTokens } from '../core/tokens.js'
import { info, debug } from '../core/logger.js'

export type ContextLevel = 0 | 1 | 2 | 3 | 4
// L0 file names → L1 symbols → L2 signatures → L3 ranked chunks (≤600ch)
// → L4 full source of the top files.

export interface CompiledContext {
  level: ContextLevel
  chunks: CodeChunk[]
  pointers: string[]
  estTokens: number
  escalations: string[] // one justification per level climbed
}

function rankedChunks(projectRoot: string, goal: string, fileHints: string[]): CodeChunk[] {
  const root = path.resolve(projectRoot)
  const all = parseDirectory(root).map(c => ({
    ...c,
    // relative paths keep packets small and match git apply's a/ b/ prefixes
    file: path.relative(root, c.file),
  }))
  if (all.length === 0) return []
  const ranked = rankChunks(all, goal)
  const recent = prioritizeRecent(projectRoot)
  // a file the task names outranks anything keyword similarity found
  const hinted = (file: string) =>
    fileHints.some(h => file === h || file.endsWith(`/${h}`) || file.endsWith(`/${path.basename(h)}`))
  const boosted = ranked.map(c => ({
    ...c,
    score: Math.min(1.5,
      (c.score ?? 0) +
      (recent.has(c.file) ? 0.3 : 0) +
      (hinted(c.file) ? 0.8 : 0)),
  }))
  boosted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return boosted
}

function entryLevel(intent: TaskIntent): ContextLevel {
  switch (intent.taskType) {
    case 'locate': return 2 // pointers with signatures answer "where is X"
    case 'question':
    case 'plan':
    case 'review': return 2
    case 'patch': return 3 // a patch needs source slices
  }
}

function levelView(level: ContextLevel, ranked: CodeChunk[], maxChunks: number, projectRoot: string): { chunks: CodeChunk[]; pointers: string[] } {
  const top = ranked.slice(0, maxChunks)
  switch (level) {
    case 0: {
      const files = findSourceFiles(path.resolve(projectRoot)).map(f => path.relative(path.resolve(projectRoot), f))
      return { chunks: [], pointers: [...new Set(files)].slice(0, 50) }
    }
    case 1:
      return { chunks: [], pointers: top.map(c => `${c.file}:${c.name}`) }
    case 2:
      return {
        chunks: top.map(c => ({ ...c, source: c.signature })),
        pointers: top.map(c => `${c.file}:${c.name} L${c.startLine} — ${c.signature.slice(0, 80)}`),
      }
    case 3:
      return { chunks: top, pointers: top.map(c => `${c.file}:${c.name} L${c.startLine}-L${c.endLine}`) }
    case 4: {
      const files = [...new Set(top.map(c => c.file))].slice(0, 3)
      const chunks: CodeChunk[] = []
      for (const file of files) {
        try {
          const source = fs.readFileSync(path.join(projectRoot, file), 'utf-8')
          chunks.push({
            file,
            name: path.basename(file),
            kind: 'variable',
            source,
            startLine: 1,
            endLine: source.split('\n').length,
            signature: `full source of ${file}`,
            score: 1,
          })
        } catch {
          debug(`context: cannot read ${file} for L4`)
        }
      }
      return { chunks, pointers: files.map(f => `${f} (full)`) }
    }
  }
}

function viewTokens(view: { chunks: CodeChunk[]; pointers: string[] }): number {
  let total = 0
  for (const p of view.pointers) total += estimateTokens(p)
  for (const c of view.chunks) total += estimateTokens(c.source.slice(0, 600))
  return total
}

// Compile context for an intent: start at the intent's entry level, escalate
// one level at a time only while the budget confirms headroom (the next level
// must fit in half the input budget — the packet needs the rest).
export function compileContext(
  projectRoot: string,
  goal: string,
  intent: TaskIntent,
  budget: BudgetConfig,
): CompiledContext {
  const ranked = rankedChunks(projectRoot, goal, intent.fileHints)
  const escalations: string[] = []

  let level = entryLevel(intent)
  let view = levelView(level, ranked, budget.maxChunks, projectRoot)
  let tokens = viewTokens(view)

  escalations.push(`entry L${level}: ${intent.taskType}/${intent.complexity} task`)

  // A patch task with zero retrieved chunks cannot act — climb to full source
  // if headroom allows; a locate task never climbs (pointers are the answer).
  while (
    level < 4 &&
    intent.taskType !== 'locate' &&
    view.chunks.length === 0 &&
    ranked.length > 0
  ) {
    const nextLevel = (level + 1) as ContextLevel
    const nextView = levelView(nextLevel, ranked, budget.maxChunks, projectRoot)
    const nextTokens = viewTokens(nextView)
    if (nextTokens > budget.maxInputTokens / 2) {
      escalations.push(`stop at L${level}: L${nextLevel} needs ~${nextTokens} tokens, headroom is ${Math.floor(budget.maxInputTokens / 2)}`)
      break
    }
    level = nextLevel
    view = nextView
    tokens = nextTokens
    escalations.push(`escalate to L${level}: previous level had no usable source (cost ~${nextTokens} tokens)`)
  }

  info(`context: L${level}, ${view.chunks.length} chunks, ${view.pointers.length} pointers, ~${tokens} tokens`)

  return {
    level,
    chunks: view.chunks,
    pointers: view.pointers,
    estTokens: tokens,
    escalations,
  }
}
