// The state engine. Decisions, artifacts, and task state are memory;
// conversational transcripts are not. Everything lives under
// `<projectRoot>/.cortex/`, with a one-time migration from the legacy
// `.ucp-toolchain/state.json`.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type Artifact } from '../artifact/artifacts.js'
import { info, debug } from '../core/logger.js'

const STATE_DIR = '.cortex'
const LEGACY_DIR = '.ucp-toolchain'

export interface CortexState {
  taskId: string
  timestamp: string
  changedFiles: string[]
  distilledFacts: string[]
  lastPatch: string
  iterationCount: number
}

const EMPTY_STATE: CortexState = {
  taskId: '',
  timestamp: '',
  changedFiles: [],
  distilledFacts: [],
  lastPatch: '',
  iterationCount: 0,
}

export function stateDir(projectRoot: string, overrideDir?: string): string {
  return overrideDir ?? process.env['CORTEX_DIR'] ?? path.join(projectRoot, STATE_DIR)
}

export function statePath(projectRoot: string): string {
  return path.join(stateDir(projectRoot), 'state.json')
}

function legacyStatePath(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_DIR, 'state.json')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown>: null
  } catch {
    return null
  }
}

export function loadState(projectRoot: string): CortexState {
  const current = readJson(statePath(projectRoot))
  if (current) {
    return { ...EMPTY_STATE, ...current } as CortexState
  }
  // One-time legacy migration: read the old location, leave the file alone.
  const legacy = readJson(legacyStatePath(projectRoot))
  if (legacy) {
    debug('state: migrating from legacy .ucp-toolchain/state.json')
    return {
      ...EMPTY_STATE,
      taskId: typeof legacy.taskId === 'string' ? legacy.taskId : '',
      timestamp: typeof legacy.timestamp === 'string' ? legacy.timestamp : '',
      changedFiles: Array.isArray(legacy.changedFiles) ? legacy.changedFiles as string[] : [],
      distilledFacts: Array.isArray(legacy.distilledFacts) ? legacy.distilledFacts as string[] : [],
      lastPatch: typeof legacy.lastPatch === 'string' ? legacy.lastPatch : '',
      iterationCount: typeof legacy.iterationCount === 'number' ? legacy.iterationCount : 0,
    }
  }
  return { ...EMPTY_STATE, timestamp: new Date().toISOString() }
}

export function saveState(projectRoot: string, state: CortexState): void {
  const dir = stateDir(projectRoot)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2), 'utf-8')
  info(`state saved to ${statePath(projectRoot)}`)
}

export function saveArtifact(projectRoot: string, artifact: Artifact): string {
  const dir = path.join(stateDir(projectRoot), 'artifacts', artifact.taskId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${artifact.id}.json`)
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2), 'utf-8')
  return file
}

export function distillFacts(projectRoot: string, previous: CortexState): string[] {
  const facts: string[] = []
  if (previous.taskId) {
    facts.push(`last task: ${previous.taskId}`)
    facts.push(`iterations: ${previous.iterationCount}`)
  }
  if (previous.changedFiles.length > 0) {
    facts.push(`recently changed: ${previous.changedFiles.slice(0, 3).join(', ')}`)
  }
  return facts.slice(0, 8)
}

export function updateState(
  projectRoot: string,
  taskId: string,
  patch: string,
  chunks: { file: string }[],
  iterationCount: number,
): CortexState {
  const previous = loadState(projectRoot)
  const changedFiles = [...new Set(chunks.map(c => c.file))]

  const next: CortexState = {
    taskId,
    timestamp: new Date().toISOString(),
    changedFiles,
    distilledFacts: distillFacts(projectRoot, previous),
    lastPatch: patch.slice(0, 200),
    iterationCount,
  }

  saveState(projectRoot, next)
  return next
}

export function initProject(projectRoot: string, stateDirOverride?: string): string {
  const dir = stateDir(projectRoot, stateDirOverride)
  fs.mkdirSync(dir, { recursive: true })
  // Write default workers registry if none exists
  const workersPath = path.join(dir, 'workers.json')
  if (!fs.existsSync(workersPath)) {
    fs.writeFileSync(workersPath, JSON.stringify({ workers: [] }, null, 2), 'utf-8')
  }
  // Write empty state if none exists
  if (!fs.existsSync(statePath(projectRoot))) {
    saveState(projectRoot, { ...EMPTY_STATE, timestamp: new Date().toISOString() })
  }
  return dir
}
