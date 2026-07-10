// Branded identifiers for kernel primitives. A bare `string` would let a
// TraceId flow where a TaskId is expected; the phantom brand makes the
// compiler reject that without any runtime cost. IDs are opaque tokens —
// downstream code compares them, never parses them.

declare const brand: unique symbol

type Branded<T, B extends string> = T & { readonly [brand]: B }

export type TaskId = Branded<string, 'TaskId'>
export type ArtifactId = Branded<string, 'ArtifactId'>
export type BlueprintId = Branded<string, 'BlueprintId'>
export type NodeId = Branded<string, 'NodeId'>
export type DirectiveId = Branded<string, 'DirectiveId'>
export type AgentId = Branded<string, 'AgentId'>
export type TraceId = Branded<string, 'TraceId'>

// Constructors are thin casts — the brand only exists at type level. They
// exist so intent reads at the call site (`taskId('t-1')`) and so a future
// format check has one place to live.
export const taskId = (v: string): TaskId => v as TaskId
export const artifactId = (v: string): ArtifactId => v as ArtifactId
export const blueprintId = (v: string): BlueprintId => v as BlueprintId
export const nodeId = (v: string): NodeId => v as NodeId
export const directiveId = (v: string): DirectiveId => v as DirectiveId
export const agentId = (v: string): AgentId => v as AgentId
export const traceId = (v: string): TraceId => v as TraceId
