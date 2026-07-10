// Serialization format (Deliverable 2). The wire format is canonical JSON:
// UTF-8, keys sorted lexicographically at every level, arrays in declared
// order. Canonical ordering makes serialized primitives stable and
// byte-comparable — which is what lets golden fixtures assert exact output
// and what a future content-address (bodyHash lineage) can rely on.
import { type Result, ok, err } from './errors.js'
import { type Primitive } from './primitives.js'
import { validatePrimitive } from './validate.js'

// Recursively sort object keys so JSON.stringify emits a canonical form.
// Arrays keep their order (semantic); objects are reordered (cosmetic).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = canonicalize(v) // drop undefined for stable output
    }
    return out
  }
  return value
}

// Serialize a primitive to canonical JSON. `pretty` yields 2-space indent for
// human-readable golden files; the default is compact.
export function serialize(primitive: Primitive, pretty = false): string {
  const canonical = canonicalize(primitive)
  return JSON.stringify(canonical, null, pretty ? 2 : 0)
}

// Parse and validate untrusted JSON into a typed primitive. Malformed JSON and
// schema violations both surface as a KernelValidationError — the caller gets
// one uniform failure branch.
export function deserialize(json: string): Result<Primitive> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return err([{ code: 'malformed_json', path: '$', message: `invalid JSON: ${(e as Error).message}` }])
  }
  return validatePrimitive(parsed)
}

// Round-trip helper used by fixtures/tests: serialize then deserialize and
// confirm the value survives unchanged.
export function roundTrip(primitive: Primitive): Result<Primitive> {
  return deserialize(serialize(primitive))
}

// True when two primitives serialize to identical canonical bytes. The
// equality the kernel cares about is structural, not reference.
export function canonicalEqual(a: Primitive, b: Primitive): boolean {
  return serialize(a) === serialize(b)
}

export { ok, err }
