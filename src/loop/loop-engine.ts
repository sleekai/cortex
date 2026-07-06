// CUEA Execution Loop Engine (spec §3) — the closed loop:
//
//   Producer → Evaluator → Router
//        ↑                    ↓
//        └──── loop / escalate / finish
//
// The engine wires the three seams and owns nothing else: the Producer makes
// output, the Evaluator judges it, the Router alone decides the next move. The
// engine only advances the ladder rung when the Router says "escalate" and
// stops when it says "finish" — there is no other exit. Constraints §10 hold
// structurally: the single bounded `while` has no recursion, every output is
// evaluated before the Router runs, and no worker calls another worker.
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk, type ValidationResult } from '../core/types.js'
import { type Artifact, isKind } from '../artifact/artifacts.js'
import { type CompilerRuntime, DEFAULT_COMPILER_RUNTIME } from '../compiler/runtime.js'
import { type ScoredWorker } from '../capability/planner.js'
import { dispatchOne, type DispatchOptions, DEFAULT_DISPATCH_OPTIONS } from '../worker/dispatch.js'
import { applyPatch, runValidationHooks } from '../validator/patch-apply.js'
import { generateErrorPacket } from '../packet/generator.js'
import { compressText } from '../runtime/compression.js'
import {
  type ExecutionState,
  initialState,
  recordAttempt,
  escalate,
  finish,
} from './execution-state.js'
import { type Evaluator, hookDecisionEvaluator } from './evaluator.js'
import { type RouterBounds, type RouterAction, DEFAULT_BOUNDS, route } from './router.js'
import { type ContextService } from './context-service.js'
import { info, warn } from '../core/logger.js'

// What the Producer receives each attempt. `rung` is the ladder index the
// Router has escalated to; `issues` are the previous Evaluation's complaints,
// for same-tier refinement.
export interface ProducerContext {
  packet: UCP
  chunks: CodeChunk[]
  rung: number
  attempt: number
  issues: string[]
  // True when the engine's context provider returned new chunks since the
  // last attempt — a retry should then re-send full context, not errors-only.
  contextRefreshed?: boolean
}

export interface Production {
  artifact: Artifact
  workerId: string
  tier: number
  // Spend for this attempt in relative cost units (accrued into state.cost).
  cost: number
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
  // Deterministic validation of the output, when applicable (patches).
  validation?: ValidationResult
}

// A Producer is stateless (spec §4): it maps a context to one output and holds
// no memory between attempts — all continuity lives in ExecutionState.
export type Producer = (ctx: ProducerContext) => Promise<Production>

export interface LoopStep {
  action: RouterAction
  state: ExecutionState
}

export interface LoopEngineOptions {
  bounds?: RouterBounds
  evaluator?: Evaluator
  // Number of ladder rungs available; escalation past the last rung ends the
  // loop rather than re-dispatching the top worker forever.
  ladderSize: number
  onStep?: (step: LoopStep) => void
  // Context-on-demand seam (MVP §6): when an Evaluation names missing context
  // and the loop continues, the engine asks this service for a refreshed
  // chunk set before the next attempt. The service owns policy (whether and
  // how often to actually fetch) — returning the current chunks unchanged is
  // a legal "no". Absent service ⇒ behavior identical to before.
  contextService?: ContextService
  compilerRuntime?: CompilerRuntime
}

export interface LoopEngineResult {
  state: ExecutionState
  accepted: boolean
  terminationReason: string
  finalOutput: Artifact | null
  artifacts: Artifact[]
}

export async function runExecutionLoop(
  packet: UCP,
  chunks: CodeChunk[],
  producer: Producer,
  options: LoopEngineOptions,
): Promise<LoopEngineResult> {
  const bounds = options.bounds ?? DEFAULT_BOUNDS
  const evaluator = options.evaluator ?? hookDecisionEvaluator
  const ladderSize = Math.max(1, options.ladderSize)
  const { makeArtifact } = options.compilerRuntime ?? DEFAULT_COMPILER_RUNTIME

  let state = initialState()
  let rung = 0
  let issues: string[] = []
  let currentChunks = chunks
  let contextRefreshed = false
  const artifacts: Artifact[] = []

  // Bounded by construction: the Router terminates on ACCEPT/FINISH, on any
  // §6 bound, or on convergence; escalation is capped by both the depth bound
  // and the physical ladder. The extra guard mirrors maxIterations so a
  // malformed custom Router can never spin forever.
  for (let guard = 0; guard <= bounds.maxIterations; guard++) {
    const production = await producer({ packet, chunks: currentChunks, rung, attempt: state.iteration, issues, contextRefreshed })
    contextRefreshed = false
    const evaluation = await evaluator({
      output: production.artifact,
      validation: production.validation,
      attempt: state.iteration,
    })
    const evaluationCompression = compressText([...evaluation.issues, ...(evaluation.missingContext ?? [])].join('\n'), 200)
    const evaluationArtifact = makeArtifact('evaluation', packet.t, 'evaluator', {
      decision: evaluation.decision,
      confidence: evaluation.confidence,
      issues: evaluation.issues,
      missingContext: evaluation.missingContext ?? [],
      compressedText: evaluationCompression.text,
    })
    artifacts.push(evaluationArtifact)

    state = recordAttempt(state, {
      iteration: state.iteration + 1,
      workerId: production.workerId,
      tier: production.tier,
      decision: evaluation.decision,
      confidence: evaluation.confidence,
      issues: evaluation.issues,
      cost: production.cost,
      latencyMs: production.latencyMs,
      ...(production.promptTokens !== undefined ? { promptTokens: production.promptTokens } : {}),
      ...(production.completionTokens !== undefined ? { completionTokens: production.completionTokens } : {}),
    }, production.artifact)

    const action = route(state, evaluation, bounds)
    info(`loop: iter ${state.iteration} tier ${production.tier} → ${evaluation.decision} (conf ${evaluation.confidence.toFixed(2)}) ⇒ ${action.action}`)
    options.onStep?.({ action, state })

    if (action.action === 'finish') {
      state = finish(state, state.escalationDepth > 0 ? 'escalated' : 'finished')
      return { state, accepted: action.accepted, terminationReason: action.reason, finalOutput: state.currentOutput, artifacts }
    }

    if (action.action === 'escalate') {
      if (rung + 1 >= ladderSize) {
        warn('loop: escalation requested but ladder exhausted — finishing')
        state = finish(state, 'escalated')
        return { state, accepted: false, terminationReason: 'ladder exhausted (no higher-tier worker)', finalOutput: state.currentOutput, artifacts }
      }
      rung++
      state = escalate(state)
    }

    // 'loop' and 'escalate' both carry the issues forward as refinement context.
    issues = evaluation.issues

    // Context-on-demand: the Evaluator expressed needs; the context service
    // decides whether the next attempt gets more.
    if (evaluation.missingContext && evaluation.missingContext.length > 0 && options.contextService) {
      const refreshed = await options.contextService.fetch(evaluation.missingContext, currentChunks)
      if (refreshed !== currentChunks) {
        currentChunks = refreshed
        contextRefreshed = true
      }
    }
  }

  // Unreachable when the Router honors maxIterations; kept as a hard backstop.
  state = finish(state, state.escalationDepth > 0 ? 'escalated' : 'finished')
  return { state, accepted: false, terminationReason: 'iteration guard tripped', finalOutput: state.currentOutput, artifacts }
}

// ── Default Producer: dispatch a single ladder rung ───────────────────────
// Escalation is the Router's job, so this Producer dispatches exactly ONE rung
// (never walks the ladder itself). It applies a patch artifact and runs the
// project's validation hooks so the Evaluator gets a deterministic verdict.
// Retries at the same rung swap in an error-only packet, matching the existing
// validation loop's refinement strategy.
export function ladderProducer(
  ladder: ScoredWorker[],
  projectRoot: string,
  dispatchOptions: DispatchOptions = DEFAULT_DISPATCH_OPTIONS,
): Producer {
  return async (ctx: ProducerContext): Promise<Production> => {
    const idx = Math.min(ctx.rung, ladder.length - 1)
    const scored = ladder[idx]!

    // On a same-tier retry, hand the worker the failing errors, not the whole
    // context again — the packet already delivered the goal once. Exception:
    // when the engine fetched context the Evaluator asked for, the retry must
    // carry the full packet so the new chunks actually reach the worker.
    const errorOnlyRetry = ctx.attempt > 0 && ctx.issues.length > 0 && !ctx.contextRefreshed
    const compressedIssues = errorOnlyRetry
      ? compressText(ctx.issues.join('\n'), 220).text
      : ''
    const packet = errorOnlyRetry
      ? generateErrorPacket(ctx.packet.t, ctx.packet.g, compressedIssues, ctx.issues[0]!, ctx.attempt)
      : ctx.packet
    const chunks = errorOnlyRetry ? [] : ctx.chunks

    const result = await dispatchOne(packet, chunks, scored, dispatchOptions)

    let validation: ValidationResult | undefined
    if (isKind(result.artifact, 'patch')) {
      const applied = applyPatch(result.artifact.body.diff, projectRoot)
      validation = applied
        ? runValidationHooks(projectRoot)
        : { passed: false, errors: ['patch apply failed'], output: '', iteration: ctx.attempt + 1 }
    }

    return {
      artifact: result.artifact,
      workerId: result.workerId,
      tier: scored.worker.tier,
      cost: scored.expectedSpend,
      latencyMs: result.latencyMs,
      promptTokens: result.estInputTokens,
      completionTokens: result.estOutputTokens,
      validation,
    }
  }
}
