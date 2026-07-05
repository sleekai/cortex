import { type UCP } from '../packet/ucp.js'
import { type Artifact, type ReviewFinding, type ReviewSeverity, makeArtifact } from '../artifact/artifacts.js'
import { extractDiff, extractReasoning } from './diff-extractor.js'
import { firstJsonObject } from './json-extractor.js'

function parseSeverity(v: unknown): ReviewSeverity {
  return v === 'R' || v === 'Y' || v === 'G' ? v : 'Y'
}

export function buildWorkArtifact(raw: string, packet: UCP, workerId: string): Artifact {
  if (raw.startsWith('IMPOSSIBLE:')) {
    return makeArtifact('failure', packet.t, workerId, { reason: raw, recoverable: false })
  }
  const diff = extractDiff(raw)
  if (!diff) {
    return makeArtifact('failure', packet.t, workerId, { reason: 'no diff found in output', recoverable: true })
  }
  return makeArtifact('patch', packet.t, workerId, { diff, reasoning: extractReasoning(raw) })
}

export function buildJudgmentArtifact(raw: string, packet: UCP, workerId: string): Artifact {
  const obj = firstJsonObject(raw)
  if (!obj) {
    return makeArtifact('failure', packet.t, workerId, { reason: 'no JSON object in oracle reply', recoverable: true })
  }
  if (typeof obj.fail === 'string') {
    return makeArtifact('failure', packet.t, workerId, { reason: obj.fail, recoverable: false })
  }
  if (typeof obj.q === 'string') {
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
