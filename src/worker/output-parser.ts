import { type UCP } from '../packet/ucp.js'
import { type Artifact } from '../artifact/artifacts.js'
import { buildWorkArtifact, buildJudgmentArtifact } from './artifact-builder.js'

export function parseWorkerOutput(raw: string, packet: UCP, workerId: string): Artifact {
  return packet.act === 'work'
    ? buildWorkArtifact(raw.trim(), packet, workerId)
    : buildJudgmentArtifact(raw.trim(), packet, workerId)
}
