import * as crypto from 'node:crypto'
import { type HarnessKind, type RawInput, normalizeInput } from '../ingress/ingress.js'
import { type UCP } from '../packet/ucp.js'

export interface Task {
  readonly id: string
  readonly raw: string
  readonly normalized: string
  readonly source: HarnessKind
  readonly createdAt: string
  readonly ucp: UCP
  readonly metadata: Readonly<Record<string, unknown>>
}

function stableTaskId(raw: string): string {
  return `task-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)}`
}

export function createTask(input: RawInput): Task {
  const taskId = input.taskId ?? stableTaskId(input.content)
  const ingress = normalizeInput({ ...input, taskId })
  return Object.freeze({
    id: ingress.ucp.t,
    raw: ingress.rawContent,
    normalized: input.explicitGoal ?? ingress.rawContent,
    source: ingress.source,
    createdAt: new Date().toISOString(),
    ucp: ingress.ucp,
    metadata: Object.freeze({ ...ingress.metadata }),
  })
}

