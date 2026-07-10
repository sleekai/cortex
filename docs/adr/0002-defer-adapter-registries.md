# ADR-0002: Defer ingress/egress adapter registries until a second adapter exists

Date: 2026-07-05
Status: accepted

## Context

Two registries shipped with zero adapters wired from any entry point:

- `egress/egress.ts` per-artifact-kind renderer registry
  (`registerRenderer`/`renderArtifact`/`renderBundle`, 12 built-in
  registrations) — no production caller; entry points render exclusively via
  the summary renderers (`renderDispatchSummary`, `renderLoopSummary`,
  `renderBlueprintSummary`, `renderPlanSummary`, `renderPointerList`).
- `ingress/ingress.ts` `HarnessAdapter` registry
  (`registerAdapter`/`getAdapter`/`registeredAdapters`) — no adapter ever
  registered; both entry points call `normalizeInput` directly.

The "everything is replaceable" principle is not violated by removing them:
replaceability lives at the seams production actually crosses —
`normalizeInput` on the way in, the summary renderers (already
format-aware via `targetKind: 'cli' | 'mcp'`) on the way out. One adapter is
a hypothetical seam; zero adapters is fiction.

## Decision

Delete both registries and their tests. Keep `normalizeInput` and the
summary renderers as the ingress/egress interfaces.

## Consequences

- Egress has one rendering design instead of two parallel ones.
- When a third egress target (e.g. Slack, HTTP webhook) or a genuinely
  different ingress source arrives, that adapter's real requirements define
  the registry shape; the deleted implementation remains in git history as
  reference.
- Architecture reviews should not re-suggest wiring these registries; the
  removal is deliberate.
