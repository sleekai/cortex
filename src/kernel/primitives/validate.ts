// Validators (Deliverable 3, Acceptance Criterion 3). Each returns a Result:
// the ok branch carries the value narrowed to its primitive type, the err
// branch a KernelValidationError with structured issues. Validators operate
// on `unknown` so they double as the trust boundary for deserialized JSON.
import {
  type Result, ok, err, IssueBag, type ValidationIssue,
} from './errors.js'
import {
  KERNEL_SCHEMA_VERSION, type PrimitiveKind,
} from './schema.js'
import {
  ALL_CAPABILITIES, ALL_ARTIFACT_KINDS,
} from './capabilities.js'
import {
  type Primitive, type TaskPrimitive, type BlueprintPrimitive,
  type NodePrimitive, type AgentPrimitive, type PolicyPrimitive,
  type ArtifactPrimitive, type TracePrimitive, type DirectivePrimitive,
  type CapabilityDescriptor,
} from './primitives.js'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// ── Small field checkers ────────────────────────────────────────────────────
function reqString(bag: IssueBag, o: Obj, key: string, path: string): void {
  if (!(key in o)) bag.add('missing_field', `${path}.${key}`, `required string "${key}" is missing`)
  else if (typeof o[key] !== 'string') bag.add('wrong_type', `${path}.${key}`, `"${key}" must be a string`)
  else if ((o[key] as string).length === 0) bag.add('invalid_value', `${path}.${key}`, `"${key}" must be non-empty`)
}

function reqNumber(bag: IssueBag, o: Obj, key: string, path: string): void {
  if (!(key in o)) bag.add('missing_field', `${path}.${key}`, `required number "${key}" is missing`)
  else if (typeof o[key] !== 'number' || Number.isNaN(o[key])) bag.add('wrong_type', `${path}.${key}`, `"${key}" must be a number`)
}

function reqBool(bag: IssueBag, o: Obj, key: string, path: string): void {
  if (!(key in o)) bag.add('missing_field', `${path}.${key}`, `required boolean "${key}" is missing`)
  else if (typeof o[key] !== 'boolean') bag.add('wrong_type', `${path}.${key}`, `"${key}" must be a boolean`)
}

function reqEnum(bag: IssueBag, o: Obj, key: string, path: string, allowed: readonly string[]): void {
  if (!(key in o)) { bag.add('missing_field', `${path}.${key}`, `required "${key}" is missing`); return }
  if (typeof o[key] !== 'string' || !allowed.includes(o[key] as string)) {
    bag.add('unknown_enum_value', `${path}.${key}`, `"${key}" must be one of: ${allowed.join(', ')}`)
  }
}

function header(bag: IssueBag, o: Obj, kind: PrimitiveKind, path: string): void {
  if (o.kind !== kind) bag.add('invalid_value', `${path}.kind`, `expected kind "${kind}"`)
  if (!('schemaVersion' in o)) bag.add('missing_field', `${path}.schemaVersion`, 'schemaVersion is required')
  else if (o.schemaVersion !== KERNEL_SCHEMA_VERSION) {
    bag.add('schema_version_mismatch', `${path}.schemaVersion`, `unsupported schemaVersion ${String(o.schemaVersion)}; kernel understands ${KERNEL_SCHEMA_VERSION}`)
  }
}

function capabilityArray(bag: IssueBag, o: Obj, key: string, path: string): void {
  const v = o[key]
  if (!Array.isArray(v)) { bag.add('wrong_type', `${path}.${key}`, `"${key}" must be an array`); return }
  v.forEach((c, i) => {
    if (typeof c !== 'string' || !(ALL_CAPABILITIES as readonly string[]).includes(c)) {
      bag.add('unknown_enum_value', `${path}.${key}[${i}]`, `unknown capability "${String(c)}"`)
    }
  })
}

function finish<T>(bag: IssueBag, value: unknown): Result<T> {
  return bag.length === 0 ? ok(value as T) : err(bag.drain())
}

// ── Node ─────────────────────────────────────────────────────────────────────
export function validateNode(input: unknown, path = 'node'): Result<NodePrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'node must be an object' }])
  header(bag, input, 'node', path)
  reqString(bag, input, 'id', path)
  reqEnum(bag, input, 'step', path, ['skill', 'produce'])
  if (input.step === 'skill') reqString(bag, input, 'skill', path)
  if ('when' in input && input.when !== undefined && typeof input.when !== 'string') {
    bag.add('wrong_type', `${path}.when`, '"when" must be a string guard name')
  }
  return finish(bag, input)
}

// ── Directive ─────────────────────────────────────────────────────────────────
export function validateDirective(input: unknown, path = 'directive'): Result<DirectivePrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'directive must be an object' }])
  header(bag, input, 'directive', path)
  reqString(bag, input, 'id', path)
  reqString(bag, input, 'instruction', path)
  reqNumber(bag, input, 'weight', path)
  const scope = input.scope
  if (!isObj(scope)) bag.add('missing_field', `${path}.scope`, 'scope is required')
  else if (scope.kind === 'node') reqString(bag, scope, 'node', `${path}.scope`)
  else if (scope.kind !== 'run') bag.add('unknown_enum_value', `${path}.scope.kind`, 'scope.kind must be "run" or "node"')
  return finish(bag, input)
}

// ── Policy ─────────────────────────────────────────────────────────────────────
export function validatePolicy(input: unknown, path = 'policy'): Result<PolicyPrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'policy must be an object' }])
  header(bag, input, 'policy', path)
  reqString(bag, input, 'name', path)
  reqNumber(bag, input, 'maxIterations', path)
  reqNumber(bag, input, 'maxEscalationDepth', path)
  reqNumber(bag, input, 'ambiguityThreshold', path)
  reqEnum(bag, input, 'clarificationMode', path, ['halt', 'proceed'])
  reqNumber(bag, input, 'maxCost', path)
  reqNumber(bag, input, 'maxInputTokens', path)
  return finish(bag, input)
}

// ── Agent ─────────────────────────────────────────────────────────────────────
export function validateAgent(input: unknown, path = 'agent'): Result<AgentPrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'agent must be an object' }])
  header(bag, input, 'agent', path)
  reqString(bag, input, 'id', path)
  capabilityArray(bag, input, 'capabilities', path)
  if ((input.capabilities as unknown[] | undefined)?.length === 0) {
    bag.add('empty_collection', `${path}.capabilities`, 'an agent must advertise at least one capability')
  }
  if (!('tier' in input)) bag.add('missing_field', `${path}.tier`, 'tier is required')
  else if (typeof input.tier !== 'number' || ![1, 2, 3].includes(input.tier)) {
    bag.add('unknown_enum_value', `${path}.tier`, 'tier must be 1, 2, or 3')
  }
  reqEnum(bag, input, 'writeAccess', path, ['none', 'patch'])
  reqNumber(bag, input, 'contextWindow', path)
  reqNumber(bag, input, 'reliability', path)
  const cost = input.cost
  if (!isObj(cost)) bag.add('missing_field', `${path}.cost`, 'cost is required')
  else { reqNumber(bag, cost, 'inPer1k', `${path}.cost`); reqNumber(bag, cost, 'outPer1k', `${path}.cost`) }
  return finish(bag, input)
}

// ── Capability descriptor ──────────────────────────────────────────────────────
export function validateCapability(input: unknown, path = 'capability'): Result<CapabilityDescriptor> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'capability must be an object' }])
  header(bag, input, 'capability', path)
  reqEnum(bag, input, 'name', path, ALL_CAPABILITIES as readonly string[])
  reqString(bag, input, 'description', path)
  return finish(bag, input)
}

// ── Task ─────────────────────────────────────────────────────────────────────
export function validateTask(input: unknown, path = 'task'): Result<TaskPrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'task must be an object' }])
  header(bag, input, 'task', path)
  reqString(bag, input, 'id', path)
  reqString(bag, input, 'normalized', path)
  reqEnum(bag, input, 'complexity', path, ['trivial', 'bounded', 'open'])
  capabilityArray(bag, input, 'requiredCapabilities', path)
  reqEnum(bag, input, 'expectedOutput', path, ALL_ARTIFACT_KINDS as readonly string[])
  reqString(bag, input, 'blueprint', path)
  reqNumber(bag, input, 'estTokenBudget', path)
  return finish(bag, input)
}

// ── Artifact ─────────────────────────────────────────────────────────────────
export function validateArtifact(input: unknown, path = 'artifact'): Result<ArtifactPrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'artifact must be an object' }])
  header(bag, input, 'artifact', path)
  reqString(bag, input, 'id', path)
  reqEnum(bag, input, 'artifactKind', path, ALL_ARTIFACT_KINDS as readonly string[])
  reqString(bag, input, 'task', path)
  reqString(bag, input, 'bodyHash', path)
  reqString(bag, input, 'createdAt', path)
  if ('producedBy' in input && input.producedBy !== undefined && typeof input.producedBy !== 'string') {
    bag.add('wrong_type', `${path}.producedBy`, '"producedBy" must be a node id string')
  }
  return finish(bag, input)
}

// ── Blueprint (composite; enforces referential integrity) ────────────────────
export function validateBlueprint(input: unknown, path = 'blueprint'): Result<BlueprintPrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'blueprint must be an object' }])
  header(bag, input, 'blueprint', path)
  reqString(bag, input, 'id', path)
  reqString(bag, input, 'name', path)
  reqString(bag, input, 'description', path)

  const nodeIds = new Set<string>()
  if (!Array.isArray(input.nodes)) {
    bag.add('wrong_type', `${path}.nodes`, 'nodes must be an array')
  } else if (input.nodes.length === 0) {
    bag.add('empty_collection', `${path}.nodes`, 'a blueprint needs at least one node')
  } else {
    input.nodes.forEach((n, i) => {
      const r = validateNode(n, `${path}.nodes[${i}]`)
      if (!r.ok) for (const iss of r.error.issues) bag.add(iss.code, iss.path, iss.message)
      const id = isObj(n) ? n.id : undefined
      if (typeof id === 'string') {
        if (nodeIds.has(id)) bag.add('duplicate_id', `${path}.nodes[${i}].id`, `duplicate node id "${id}"`)
        nodeIds.add(id)
      }
    })
  }

  if (!Array.isArray(input.directives)) {
    bag.add('wrong_type', `${path}.directives`, 'directives must be an array')
  } else {
    input.directives.forEach((d, i) => {
      const r = validateDirective(d, `${path}.directives[${i}]`)
      if (!r.ok) for (const iss of r.error.issues) bag.add(iss.code, iss.path, iss.message)
      // Referential integrity: a node-scoped directive must target a real node.
      const scope = isObj(d) ? d.scope : undefined
      if (isObj(scope) && scope.kind === 'node' && typeof scope.node === 'string' && !nodeIds.has(scope.node)) {
        bag.add('dangling_reference', `${path}.directives[${i}].scope.node`, `directive targets unknown node "${scope.node}"`)
      }
    })
  }

  const pr = validatePolicy(input.policy, `${path}.policy`)
  if (!pr.ok) for (const iss of pr.error.issues) bag.add(iss.code, iss.path, iss.message)

  return finish(bag, input)
}

// ── Trace (composite; step nodes must belong to the blueprint) ───────────────
export function validateTrace(input: unknown, path = 'trace'): Result<TracePrimitive> {
  const bag = new IssueBag()
  if (!isObj(input)) return err([{ code: 'wrong_type', path, message: 'trace must be an object' }])
  header(bag, input, 'trace', path)
  reqString(bag, input, 'id', path)
  reqString(bag, input, 'task', path)
  reqString(bag, input, 'blueprint', path)
  reqBool(bag, input, 'accepted', path)
  reqNumber(bag, input, 'totalCostUnits', path)
  reqString(bag, input, 'startedAt', path)
  reqString(bag, input, 'finishedAt', path)
  if (!Array.isArray(input.steps)) {
    bag.add('wrong_type', `${path}.steps`, 'steps must be an array')
  } else {
    input.steps.forEach((s, i) => {
      const sp = `${path}.steps[${i}]`
      if (!isObj(s)) { bag.add('wrong_type', sp, 'step must be an object'); return }
      reqString(bag, s, 'node', sp)
      reqEnum(bag, s, 'outcome', sp, ['ok', 'retried', 'escalated', 'skipped', 'failed'])
      reqNumber(bag, s, 'iterations', sp)
      reqNumber(bag, s, 'costUnits', sp)
    })
  }
  return finish(bag, input)
}

// ── Dispatch by kind ─────────────────────────────────────────────────────────
const VALIDATORS: Record<PrimitiveKind, (v: unknown, p?: string) => Result<Primitive>> = {
  task: validateTask as (v: unknown, p?: string) => Result<Primitive>,
  artifact: validateArtifact as (v: unknown, p?: string) => Result<Primitive>,
  blueprint: validateBlueprint as (v: unknown, p?: string) => Result<Primitive>,
  node: validateNode as (v: unknown, p?: string) => Result<Primitive>,
  directive: validateDirective as (v: unknown, p?: string) => Result<Primitive>,
  agent: validateAgent as (v: unknown, p?: string) => Result<Primitive>,
  capability: validateCapability as (v: unknown, p?: string) => Result<Primitive>,
  policy: validatePolicy as (v: unknown, p?: string) => Result<Primitive>,
  trace: validateTrace as (v: unknown, p?: string) => Result<Primitive>,
}

// Validate any primitive, dispatching on its own `kind` discriminant.
export function validatePrimitive(input: unknown): Result<Primitive> {
  if (!isObj(input) || typeof input.kind !== 'string' || !(input.kind in VALIDATORS)) {
    const issues: ValidationIssue[] = [{ code: 'invalid_value', path: 'kind', message: 'unknown or missing primitive kind' }]
    return err(issues)
  }
  return VALIDATORS[input.kind as PrimitiveKind](input)
}
