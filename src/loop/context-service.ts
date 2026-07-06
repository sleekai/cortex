import { type CodeChunk, type BudgetConfig } from '../core/types.js'
import { type TaskIntent } from '../capability/capabilities.js'
import { type ContextPolicy } from '../policy/policies.js'
import { type CompilerRuntime, DEFAULT_COMPILER_RUNTIME } from '../compiler/runtime.js'
import { info } from '../core/logger.js'

export interface ContextService {
  fetch(needs: string[], current: CodeChunk[]): Promise<CodeChunk[]>
}

export function defaultContextService(
  projectRoot: string,
  intent: TaskIntent,
  budget: BudgetConfig,
  contextPolicy: ContextPolicy,
  compilerRuntime: CompilerRuntime = DEFAULT_COMPILER_RUNTIME,
): ContextService {
  let fetches = 0

  return {
    async fetch(needs, current) {
      if (!contextPolicy.shouldFetch(fetches, needs)) return current
      fetches++
      info(`context-on-demand: fetch ${fetches}/${contextPolicy.maxFetches} for needs: ${needs.join(', ')}`)
      const { compileContext } = compilerRuntime
      const extra = compileContext(projectRoot, needs.join(' '), intent, budget)
      const seen = new Set(current.map(c => `${c.file}:${c.name}`))
      return [...current, ...extra.chunks.filter(c => !seen.has(`${c.file}:${c.name}`))]
    },
  }
}
