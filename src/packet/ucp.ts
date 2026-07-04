// UCP v2 — one versioned packet grammar for both channels. `act: work` is the
// worker dialect (goal + context in, artifact out); `ask`/`review` are the
// judgment dialect that mother-escalate previously documented as prose only.
// v1 packets (no `v`, no `act`) parse compatibly as `work`.

export type PacketAct = 'work' | 'ask' | 'review'
export type PacketOut = 'patch' | 'analysis' | 'plan' | 'decision' | 'design' | 'review'
export type PacketFormat = 'unified diff' | 'text' | 'json'

export interface UCP {
  v: 2
  t: string
  act: PacketAct
  g: string
  q?: string
  c: string[]
  ctx: {
    f: string[]
    d: string[]
  }
  r: {
    out: PacketOut
    format: PacketFormat
  }
}

export const MAX_FACTS = 10

export interface PacketValidation {
  valid: boolean
  errors: string[]
}

export function validatePacket(packet: UCP): PacketValidation {
  const errors: string[] = []
  if (packet.v !== 2) errors.push(`unsupported version: ${String(packet.v)}`)
  if (!packet.t) errors.push('missing task id (t)')
  if (packet.act === 'ask' && !packet.q) errors.push('act "ask" requires a question (q)')
  if (packet.act === 'review' && !packet.ctx.d.some(d => d.startsWith('diff:'))) {
    errors.push('act "review" requires a diff: fact in ctx.d')
  }
  if (packet.act === 'work' && !packet.g) errors.push('act "work" requires a goal (g)')
  if (packet.ctx.d.length > MAX_FACTS) errors.push(`facts exceed cap (${packet.ctx.d.length} > ${MAX_FACTS})`)
  return { valid: errors.length === 0, errors }
}

// Accepts raw JSON of a v1 or v2 packet; returns a v2 packet or null.
export function parsePacket(raw: string): UCP | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.t !== 'string') return null
  const ctx = (typeof p.ctx === 'object' && p.ctx !== null ? p.ctx : {}) as Record<string, unknown>
  const r = (typeof p.r === 'object' && p.r !== null ? p.r : {}) as Record<string, unknown>

  const upgraded: UCP = {
    v: 2,
    t: p.t,
    act: p.act === 'ask' || p.act === 'review' ? p.act : 'work',
    g: typeof p.g === 'string' ? p.g : '',
    ...(typeof p.q === 'string' ? { q: p.q } : {}),
    c: Array.isArray(p.c) ? p.c.filter((x): x is string => typeof x === 'string') : [],
    ctx: {
      f: Array.isArray(ctx.f) ? ctx.f.filter((x): x is string => typeof x === 'string') : [],
      d: Array.isArray(ctx.d) ? ctx.d.filter((x): x is string => typeof x === 'string') : [],
    },
    r: {
      out: isPacketOut(r.out) ? r.out : 'patch',
      format: isPacketFormat(r.format) ? r.format : 'text',
    },
  }
  return upgraded
}

function isPacketOut(v: unknown): v is PacketOut {
  return v === 'patch' || v === 'analysis' || v === 'plan' || v === 'decision' || v === 'design' || v === 'review'
}

function isPacketFormat(v: unknown): v is PacketFormat {
  return v === 'unified diff' || v === 'text' || v === 'json'
}
