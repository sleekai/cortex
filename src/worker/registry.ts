// Workers are data, not code. The default registry ships with the kernel;
// a project overlays `.cortex/workers.json` to add, replace, or retire
// workers without touching kernel source. Tier 0 (deterministic retrieval)
// is kernel-internal and deliberately not represented here — the planner
// short-circuits `locate` intents before consulting the registry.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Capability, isCapability } from '../capability/capabilities.js'
import { type HarnessConfig } from '../harness/harness.js'
import { warn, debug } from '../core/logger.js'

export type WorkerTier = 1 | 2 | 3
export type WriteAccess = 'none' | 'patch'

export interface WorkerSpec {
  id: string
  capabilities: Capability[]
  harness: HarnessConfig
  cost: { inPer1k: number; outPer1k: number }
  speed: number // relative, higher = faster
  contextWindow: number
  quality: Partial<Record<Capability, number>> // 0..1 priors
  reliability: number // 0..1 prior; metrics shift it (state/metrics.ts)
  tier: WorkerTier
  writeAccess: WriteAccess
  // Overlay entries can retire a default worker by id.
  disabled?: boolean
}

export interface WorkerRegistry {
  workers: WorkerSpec[]
  byId(id: string): WorkerSpec | undefined
  withCapabilities(required: Capability[]): WorkerSpec[]
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

export function validateWorkerSpec(spec: unknown): string[] {
  const errors: string[] = []
  if (typeof spec !== 'object' || spec === null) return ['worker spec is not an object']
  const w = spec as Record<string, unknown>
  if (typeof w.id !== 'string' || !w.id) errors.push('missing id')
  if (!Array.isArray(w.capabilities) || w.capabilities.length === 0) {
    errors.push(`${String(w.id)}: missing capabilities`)
  } else {
    for (const c of w.capabilities) {
      if (!isCapability(c)) errors.push(`${String(w.id)}: unknown capability "${String(c)}"`)
    }
  }
  const h = w.harness as Record<string, unknown> | undefined
  if (!h || (h.kind !== 'cli' && h.kind !== 'http')) errors.push(`${String(w.id)}: harness.kind must be cli or http`)
  const cost = w.cost as Record<string, unknown> | undefined
  if (!cost || typeof cost.inPer1k !== 'number' || typeof cost.outPer1k !== 'number') {
    errors.push(`${String(w.id)}: cost.inPer1k/outPer1k required`)
  }
  if (typeof w.speed !== 'number' || w.speed <= 0) errors.push(`${String(w.id)}: speed must be > 0`)
  if (typeof w.contextWindow !== 'number' || w.contextWindow <= 0) errors.push(`${String(w.id)}: contextWindow must be > 0`)
  if (typeof w.reliability !== 'number' || w.reliability < 0 || w.reliability > 1) {
    errors.push(`${String(w.id)}: reliability must be in [0,1]`)
  }
  if (w.tier !== 1 && w.tier !== 2 && w.tier !== 3) errors.push(`${String(w.id)}: tier must be 1|2|3`)
  if (w.writeAccess !== 'none' && w.writeAccess !== 'patch') errors.push(`${String(w.id)}: writeAccess must be none|patch`)
  return errors
}

function applyEnvOverrides(spec: WorkerSpec): WorkerSpec {
  if (spec.harness.kind === 'cli' && spec.harness.binEnvOverride) {
    const override = process.env[spec.harness.binEnvOverride]
    if (override) {
      return { ...spec, harness: { ...spec.harness, bin: override } }
    }
  }
  return spec
}

function loadSpecsFromFile(filePath: string): WorkerSpec[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e: unknown) {
    // Overlay files are optional; only a present-but-unreadable file is news.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`worker registry: cannot read ${filePath} — ignoring overlay`)
    }
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn(`worker registry: invalid JSON in ${filePath}, ignoring`)
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>).workers
  if (!Array.isArray(list)) {
    warn(`worker registry: ${filePath} has no workers array, ignoring`)
    return []
  }
  const specs: WorkerSpec[] = []
  for (const entry of list) {
    const errors = validateWorkerSpec(entry)
    if (errors.length > 0) {
      warn(`worker registry: skipping invalid spec in ${filePath}: ${errors.join('; ')}`)
      continue
    }
    specs.push(entry as WorkerSpec)
  }
  return specs
}

export function defaultRegistryPath(): string {
  return path.join(moduleDir(), 'registry.default.json')
}

function cortexDir(projectRoot: string): string {
  return process.env['CORTEX_DIR'] ?? path.join(projectRoot, '.cortex')
}

export function projectOverlayPath(projectRoot: string): string {
  return path.join(cortexDir(projectRoot), 'workers.json')
}

export function loadRegistry(projectRoot?: string): WorkerRegistry {
  const merged = new Map<string, WorkerSpec>()

  for (const spec of loadSpecsFromFile(defaultRegistryPath())) {
    merged.set(spec.id, spec)
  }

  if (projectRoot) {
    for (const spec of loadSpecsFromFile(projectOverlayPath(projectRoot))) {
      debug(`worker registry: overlay ${spec.disabled ? 'retires' : 'sets'} ${spec.id}`)
      merged.set(spec.id, spec)
    }
  }

  const workers = [...merged.values()]
    .filter(w => !w.disabled)
    .map(applyEnvOverrides)

  return {
    workers,
    byId: (id: string) => workers.find(w => w.id === id),
    withCapabilities: (required: Capability[]) =>
      workers.filter(w => required.every(c => w.capabilities.includes(c))),
  }
}
