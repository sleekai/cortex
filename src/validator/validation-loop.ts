import { type CodeChunk, type ValidationResult } from '../core/types.js'
import { type UCP } from '../packet/ucp.js'
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type ScoredWorker } from '../capability/planner.js'
import { dispatchWithLadder, type DispatchOptions, DEFAULT_DISPATCH_OPTIONS } from '../worker/dispatch.js'
import { applyPatch, runValidationHooks } from './patch-apply.js'
import { generateErrorPacket } from '../packet/generator.js'
import { info, warn } from '../core/logger.js'

const MAX_ITERATIONS = 3

export interface LoopResult {
  success: boolean
  patch: string
  reasoning: string
  validation: ValidationResult
  iterations: number
  artifacts: Artifact[]
}

export async function runValidationLoop(
  packet: UCP,
  chunks: CodeChunk[],
  ladder: ScoredWorker[],
  projectRoot: string,
  options: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
): Promise<LoopResult> {
  let currentPacket = packet
  let currentChunks = chunks
  const artifacts: Artifact[] = []

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    info(`=== iteration ${i + 1}/${MAX_ITERATIONS} ===`)

    const result = await dispatchWithLadder(currentPacket, currentChunks, ladder, options)
    artifacts.push(result.artifact)

    if (isKind(result.artifact, 'failure')) {
      const reason = result.artifact.body.reason
      warn(`worker returned failure: ${reason}`)
      return {
        success: false,
        patch: '',
        reasoning: '',
        validation: { passed: false, errors: [reason], output: '', iteration: i + 1 },
        iterations: i + 1,
        artifacts,
      }
    }

    if (!isKind(result.artifact, 'patch')) {
      warn(`expected a patch artifact, got ${result.artifact.kind}`)
      return {
        success: false,
        patch: '',
        reasoning: '',
        validation: { passed: false, errors: [`unexpected artifact kind: ${result.artifact.kind}`], output: '', iteration: i + 1 },
        iterations: i + 1,
        artifacts,
      }
    }

    const { diff, reasoning } = result.artifact.body

    const applied = applyPatch(diff, projectRoot)
    if (!applied) {
      warn('patch could not be applied')
      return {
        success: false,
        patch: diff,
        reasoning,
        validation: { passed: false, errors: ['patch apply failed'], output: '', iteration: i + 1 },
        iterations: i + 1,
        artifacts,
      }
    }

    const validation: ValidationResult = runValidationHooks(projectRoot)

    if (validation.passed) {
      info('all validations passed')
      return { success: true, patch: diff, reasoning, validation, iterations: i + 1, artifacts }
    }

    warn(`validation failed on iteration ${i + 1}: ${validation.errors.join('; ')}`)

    if (i < MAX_ITERATIONS - 1) {
      const errorSummary = validation.errors[0] ?? 'validation failure'
      const errorDiff = validation.output.slice(0, 600)
      currentPacket = generateErrorPacket(currentPacket.t, currentPacket.g, errorDiff, errorSummary, i + 1)
      currentChunks = []
      info(`retrying with error-only context (${errorSummary})`)
    }
  }

  return {
    success: false,
    patch: '',
    reasoning: 'max iterations reached',
    validation: { passed: false, errors: ['max iterations'], output: '', iteration: MAX_ITERATIONS },
    iterations: MAX_ITERATIONS,
    artifacts,
  }
}
