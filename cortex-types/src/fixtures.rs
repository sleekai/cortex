use crate::capabilities::{ArtifactKind, Capability};
use crate::ids::*;
use crate::primitives::*;
use crate::schema::PrimitiveKind;

pub fn fixture_policy() -> PolicyPrimitive {
    PolicyPrimitive {
        kind: PrimitiveKind::Policy,
        schema_version: 1,
        name: "bounded-default".into(),
        max_iterations: 3,
        max_escalation_depth: 2,
        ambiguity_threshold: 0.4,
        clarification_mode: ClarificationMode::Proceed,
        max_cost: 100,
        max_input_tokens: 2500,
    }
}

pub fn fixture_nodes() -> Vec<NodePrimitive> {
    vec![
        NodePrimitive {
            kind: PrimitiveKind::Node,
            schema_version: 1,
            id: node_id("n-locate"),
            step: NodeKind::Skill,
            skill: Some("locate".into()),
            when: None,
        },
        NodePrimitive {
            kind: PrimitiveKind::Node,
            schema_version: 1,
            id: node_id("n-produce"),
            step: NodeKind::Produce,
            skill: None,
            when: None,
        },
    ]
}

pub fn fixture_directive() -> DirectivePrimitive {
    DirectivePrimitive {
        kind: PrimitiveKind::Directive,
        schema_version: 1,
        id: directive_id("d-scope-narrow"),
        instruction: "Keep the patch to the smallest change that satisfies the task.".into(),
        scope: DirectiveScope {
            kind: "node".into(),
            node: Some(node_id("n-produce")),
        },
        weight: 1,
    }
}

pub fn fixture_blueprint() -> BlueprintPrimitive {
    BlueprintPrimitive {
        kind: PrimitiveKind::Blueprint,
        schema_version: 1,
        id: blueprint_id("bp-simple-patch"),
        name: "simple-patch".into(),
        description: "Locate relevant code, then produce a bounded patch under policy.".into(),
        nodes: fixture_nodes(),
        directives: vec![fixture_directive()],
        policy: fixture_policy(),
    }
}

pub fn fixture_task() -> TaskPrimitive {
    TaskPrimitive {
        kind: PrimitiveKind::Task,
        schema_version: 1,
        id: task_id("t-fix-typo"),
        normalized: "Fix the typo in the README installation section.".into(),
        complexity: Complexity::Bounded,
        required_capabilities: vec![Capability::Locate, Capability::Coding],
        expected_output: ArtifactKind::Patch,
        blueprint: blueprint_id("bp-simple-patch"),
        est_token_budget: 1200,
    }
}

pub fn fixture_agent() -> AgentPrimitive {
    AgentPrimitive {
        kind: PrimitiveKind::Agent,
        schema_version: 1,
        id: agent_id("worker-coder-t2"),
        capabilities: vec![
            Capability::Coding,
            Capability::Reasoning,
            Capability::Locate,
        ],
        tier: AgentTier::T2,
        write_access: WriteAccess::Patch,
        context_window: 128000,
        cost: CostPrior {
            in_per_1k: 3,
            out_per_1k: 15,
        },
        reliability: 0.9,
    }
}

pub fn fixture_capability() -> CapabilityDescriptor {
    CapabilityDescriptor {
        kind: PrimitiveKind::Capability,
        schema_version: 1,
        name: Capability::Coding,
        description: "Produce or modify source code as a typed patch artifact.".into(),
    }
}

pub fn fixture_artifact() -> ArtifactPrimitive {
    ArtifactPrimitive {
        kind: PrimitiveKind::Artifact,
        schema_version: 1,
        id: artifact_id("a-patch-001"),
        artifact_kind: ArtifactKind::Patch,
        task: task_id("t-fix-typo"),
        produced_by: Some(node_id("n-produce")),
        body_hash: "9f2c1b7e".into(),
        created_at: "2026-07-11T00:00:00.000Z".into(),
    }
}

pub fn fixture_trace() -> TracePrimitive {
    TracePrimitive {
        kind: PrimitiveKind::Trace,
        schema_version: 1,
        id: trace_id("tr-run-001"),
        task: task_id("t-fix-typo"),
        blueprint: blueprint_id("bp-simple-patch"),
        steps: vec![
            TraceStep {
                node: node_id("n-locate"),
                outcome: StepOutcome::Ok,
                agent: None,
                iterations: 1,
                cost_units: 2,
            },
            TraceStep {
                node: node_id("n-produce"),
                outcome: StepOutcome::Ok,
                agent: Some(agent_id("worker-coder-t2")),
                iterations: 1,
                cost_units: 18,
            },
        ],
        accepted: true,
        total_cost_units: 20,
        started_at: "2026-07-11T00:00:00.000Z".into(),
        finished_at: "2026-07-11T00:00:03.000Z".into(),
    }
}
