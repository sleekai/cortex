// The CTS pipeline (spec §5). Runs the registered stages in the fixed stage
// order, threading a draft CTSPacket through each, then validates and returns
// it. Deterministic and cheap: every built-in stage is deterministic, so
// repeated identical tasks always produce the same packet.
//
// Pluggability (spec §13): stage order is a declared list of stage names, not
// hard-wired calls. Stages registered under an unknown name still run — after
// the known stages — so new stages need no pipeline edit.
import { type UCP } from '../packet/ucp.js'
import { type IngressPacket } from '../ingress/ingress.js'
import { type CTSPacket, emptyPacket, validateCtsPacket } from './packet.js'
import { type TriageContext, type TriagePolicy, DEFAULT_TRIAGE_POLICY } from './stage.js'
import { enabledStages } from './registry.js'

// Canonical stage order (spec §5). Stages not in this list run afterward.
export const STAGE_ORDER = ['normalize', 'ambiguity', 'routing'] as const

export interface TriageInput {
  ucp: UCP
  raw?: string
}

function resolveRaw(input: TriageInput | IngressPacket): string {
  if ('rawContent' in input && typeof input.rawContent === 'string') return input.rawContent
  if ('raw' in input && typeof input.raw === 'string') return input.raw
  return input.ucp.g
}

// Order the enabled stages by STAGE_ORDER; unknown stages keep registration
// order and run last.
function orderedStages(policy: TriagePolicy): ReturnType<typeof enabledStages> {
  const enabled = enabledStages(policy)
  const rank = new Map<string, number>(STAGE_ORDER.map((n, i) => [n, i]))
  return [...enabled].sort((a, b) => (rank.get(a.name) ?? STAGE_ORDER.length) - (rank.get(b.name) ?? STAGE_ORDER.length))
}

export function runTriage(input: TriageInput | IngressPacket, policy: TriagePolicy = DEFAULT_TRIAGE_POLICY): CTSPacket {
  const raw = resolveRaw(input)
  const ctx: TriageContext = { ucp: input.ucp, raw, draft: emptyPacket(), policy }
  const stages = orderedStages(policy)

  for (const stage of stages) {
    const { patch } = stage.execute(ctx)
    ctx.draft = { ...ctx.draft, ...patch }
  }

  // Fall back to raw if the normalize stage was disabled.
  if (!ctx.draft.normalized_task) ctx.draft.normalized_task = raw.trim()

  const validation = validateCtsPacket(ctx.draft)
  if (!validation.valid) {
    throw new Error(`CTS produced an invalid packet: ${validation.errors.join('; ')}`)
  }

  return ctx.draft
}
