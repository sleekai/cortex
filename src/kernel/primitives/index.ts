// Cortex kernel — typed core primitives (Milestone 1, SLE-70).
//
// The domain model for tasks, artifacts, blueprints, nodes, directives,
// agents, capabilities, policies, and traces, with canonical-JSON
// serialization, schema versioning, and typed validation. This module is
// deliberately self-contained: it imports nothing from any agent provider,
// harness, planner, or runtime, so the core types compile independently
// (Acceptance Criterion 1). Adapters wiring these primitives to the existing
// TypeScript runtime contracts land in a later milestone.
export * from './ids.js'
export * from './capabilities.js'
export * from './schema.js'
export * from './primitives.js'
export * from './errors.js'
export * from './validate.js'
export * from './serialize.js'
export * as fixtures from './fixtures.js'
