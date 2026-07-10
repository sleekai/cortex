// Schema versioning (Deliverable 3). Every primitive carries a `kind`
// discriminant and a `schemaVersion`. The kernel refuses to deserialize a
// version it does not understand, so a stored fixture from a future build
// fails loud instead of being silently misread.

export const KERNEL_SCHEMA_VERSION = 1 as const
export type SchemaVersion = typeof KERNEL_SCHEMA_VERSION

// The nine primitive kinds this crate defines. The string tags double as the
// serialization discriminant.
export type PrimitiveKind =
  | 'task'
  | 'artifact'
  | 'blueprint'
  | 'node'
  | 'directive'
  | 'agent'
  | 'capability'
  | 'policy'
  | 'trace'

export const ALL_PRIMITIVE_KINDS: readonly PrimitiveKind[] = [
  'task', 'artifact', 'blueprint', 'node', 'directive',
  'agent', 'capability', 'policy', 'trace',
]

// Shared header every primitive embeds. Keeping it flat (not nested under an
// envelope) means a serialized primitive is self-describing on its own.
export interface PrimitiveHeader {
  kind: PrimitiveKind
  schemaVersion: SchemaVersion
}
