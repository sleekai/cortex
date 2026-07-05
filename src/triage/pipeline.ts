// The CTS pipeline (spec §5). Runs the registered skills in the fixed stage
// order, threading a draft CTSPacket through each, then validates and returns
// it. Deterministic and cheap: every built-in skill is deterministic, so
// repeated identical tasks always produce the same packet.
//
// Pluggability (spec §13): stage order is a declared list of skill names, not
// hard-wired calls. Skills registered under an unknown name still run — after
// the known stages — so new skills need no pipeline edit.
import { type UCP } from '../packet/ucp.js'
import { type IngressPacket } from '../ingress/ingress.js'
import { type CTSPacket, emptyPacket, validateCtsPacket } from './packet.js'
import { type TriageContext, type TriagePolicy, DEFAULT_TRIAGE_POLICY } from './skill.js'
import { enabledSkills } from './registry.js'

// Canonical stage order (spec §5). Skills not in this list run afterward.
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

// Order the enabled skills by STAGE_ORDER; unknown skills keep registration
// order and run last.
function orderedSkills(policy: TriagePolicy): ReturnType<typeof enabledSkills> {
  const enabled = enabledSkills(policy)
  const rank = new Map<string, number>(STAGE_ORDER.map((n, i) => [n, i]))
  return [...enabled].sort((a, b) => (rank.get(a.name) ?? STAGE_ORDER.length) - (rank.get(b.name) ?? STAGE_ORDER.length))
}

export function runTriage(input: TriageInput | IngressPacket, policy: TriagePolicy = DEFAULT_TRIAGE_POLICY): CTSPacket {
  const raw = resolveRaw(input)
  const ctx: TriageContext = { ucp: input.ucp, raw, draft: emptyPacket(), policy }
  const skills = orderedSkills(policy)

  for (const skill of skills) {
    const { patch } = skill.execute(ctx)
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
