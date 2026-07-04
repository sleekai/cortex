// Raw model output crosses into typed artifacts exactly once, here. Anything
// downstream of this file never touches prose.
import { type UCP } from '../packet/ucp.js'
import { type Artifact, type ReviewFinding, type ReviewSeverity, makeArtifact } from '../artifact/artifacts.js'

function extractDiff(text: string): string {
  const lines = text.split('\n')
  const diffLines: string[] = []
  let inDiff = false

  for (const line of lines) {
    if (line.startsWith('```diff') || line.trim() === '```diff') {
      inDiff = true
      continue
    }
    if (line.startsWith('```') && inDiff) {
      inDiff = false
      continue
    }
    if (inDiff) {
      diffLines.push(line)
    }
  }

  if (diffLines.length === 0) {
    const altDiff = text.match(/^--- a\/.*$/m)
    if (altDiff) {
      const idx = text.indexOf(altDiff[0])
      return text.slice(idx).replace(/```$/m, '').trim()
    }
  }

  return diffLines.join('\n').trim()
}

function extractReasoning(text: string): string {
  const lines = text.split('\n')
  const beforeDiff: string[] = []
  for (const line of lines) {
    if (line.startsWith('```diff') || line.startsWith('--- a/')) break
    if (!line.startsWith('<') && !line.startsWith('```')) {
      beforeDiff.push(line)
    }
  }
  return beforeDiff.join(' ').trim().slice(0, 200)
}

function parseSeverity(v: unknown): ReviewSeverity {
  return v === 'R' || v === 'Y' || v === 'G' ? v : 'Y'
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  // Try progressively longer candidates ending at each closing brace.
  for (let end = text.length; end > start; end--) {
    if (text[end - 1] !== '}') continue
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end))
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      /* keep shrinking */
    }
  }
  return null
}

// Work-channel output: diff or IMPOSSIBLE.
function parseWorkOutput(raw: string, packet: UCP, workerId: string): Artifact {
  if (raw.startsWith('IMPOSSIBLE:')) {
    return makeArtifact('failure', packet.t, workerId, { reason: raw, recoverable: false })
  }
  const diff = extractDiff(raw)
  if (!diff) {
    return makeArtifact('failure', packet.t, workerId, { reason: 'no diff found in output', recoverable: true })
  }
  return makeArtifact('patch', packet.t, workerId, { diff, reasoning: extractReasoning(raw) })
}

// Judgment-channel output: one JSON object — {a,why} | {v,i} | {q} | {fail}.
function parseJudgmentOutput(raw: string, packet: UCP, workerId: string): Artifact {
  const obj = firstJsonObject(raw)
  if (!obj) {
    return makeArtifact('failure', packet.t, workerId, { reason: 'no JSON object in oracle reply', recoverable: true })
  }
  if (typeof obj.fail === 'string') {
    return makeArtifact('failure', packet.t, workerId, { reason: obj.fail, recoverable: false })
  }
  if (typeof obj.q === 'string') {
    // An intent question for the human is a decision artifact with an empty
    // decision — the caller surfaces it and stops the line.
    return makeArtifact('decision', packet.t, workerId, { question: obj.q, decision: '', why: 'needs human intent' })
  }
  if (typeof obj.v === 'string') {
    const findings: ReviewFinding[] = Array.isArray(obj.i)
      ? obj.i
          .filter((f): f is unknown[] => Array.isArray(f) && f.length >= 3)
          .map(f => ({ severity: parseSeverity(f[0]), pointer: String(f[1]), finding: String(f[2]) }))
      : []
    return makeArtifact('review', packet.t, workerId, {
      verdict: obj.v === 'PASS' ? 'PASS' : 'ISSUES',
      findings,
    })
  }
  if (typeof obj.a === 'string') {
    return makeArtifact('decision', packet.t, workerId, {
      question: packet.q ?? '',
      decision: obj.a,
      why: typeof obj.why === 'string' ? obj.why : '',
    })
  }
  return makeArtifact('failure', packet.t, workerId, { reason: 'unrecognized oracle reply shape', recoverable: true })
}

export function parseWorkerOutput(raw: string, packet: UCP, workerId: string): Artifact {
  return packet.act === 'work'
    ? parseWorkOutput(raw.trim(), packet, workerId)
    : parseJudgmentOutput(raw.trim(), packet, workerId)
}
