// Built-in execution blueprints (MVP §2). Side-effect module: importing it
// registers the four built-ins. Each is pure data — the runner executes them;
// the kernel selects one from triage's recommendation (or an explicit flag).
//
// Differences between them live in step lists and policy overrides, never in
// runner code — that is the whole point of blueprints.
import { registerBlueprint } from './blueprint.js'

// Debug: triage → grill if needed → produce (the CUEA loop supplies
// evaluator / retry / escalate / finish). Failures justify the full ladder,
// so escalation depth is generous and retries are allowed to iterate.
registerBlueprint({
  name: 'debug',
  description: 'Diagnose and fix a defect: triage, grill if ambiguous, then closed-loop produce with full escalation.',
  steps: [
    { id: 'triage', kind: 'skill', skill: 'triage' },
    { id: 'grill', kind: 'skill', skill: 'grilling' },
    { id: 'produce', kind: 'produce' },
  ],
  policies: {
    retry: { name: 'debug-retry', maxIterations: 6 },
    escalation: { name: 'debug-escalation', maxDepth: 3 },
  },
})

// Feature: triage (CTS decomposes internally) → grill if needed → produce.
// New code discovers its context as it goes, so on-demand fetches are
// generous while the ladder stays shallow — start cheap, stay cheap.
registerBlueprint({
  name: 'feature',
  description: 'Build new functionality: triage + decomposition, grill if ambiguous, produce with context-on-demand.',
  steps: [
    { id: 'triage', kind: 'skill', skill: 'triage' },
    { id: 'grill', kind: 'skill', skill: 'grilling' },
    { id: 'produce', kind: 'produce' },
  ],
  policies: {
    escalation: { name: 'feature-escalation', maxDepth: 2 },
    context: {
      name: 'feature-context',
      onDemand: true,
      maxFetches: 3,
      shouldFetch(fetchesSoFar, needs) {
        return this.onDemand && needs.length > 0 && fetchesSoFar < this.maxFetches
      },
    },
  },
})

// PR review: summarize → review → report. No produce step — the review
// artifact is the deliverable; nothing here writes code.
registerBlueprint({
  name: 'pr-review',
  description: 'Review a change set: triage, summarize, then judge with findings.',
  steps: [
    { id: 'triage', kind: 'skill', skill: 'triage' },
    { id: 'summarize', kind: 'skill', skill: 'summarize' },
    { id: 'review', kind: 'skill', skill: 'review' },
  ],
})

// Default: the generic path for anything triage cannot place more precisely.
registerBlueprint({
  name: 'default',
  description: 'Generic execution: triage, grill if ambiguous, closed-loop produce.',
  steps: [
    { id: 'triage', kind: 'skill', skill: 'triage' },
    { id: 'grill', kind: 'skill', skill: 'grilling' },
    { id: 'produce', kind: 'produce' },
  ],
})
