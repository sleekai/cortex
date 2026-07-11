use cortex_types::errors::{PrimitiveError, ValidationIssue};
use cortex_types::fixtures::*;
use cortex_types::primitives::*;
use cortex_types::serialize::{deserialize, serialize};

#[test]
fn task_fixture_round_trips_exactly() {
    let task = fixture_task();
    let json = serialize(&task, false);
    let deserialized: TaskPrimitive = serde_json::from_str(&json).expect("deserialize task");
    assert_eq!(deserialized.id.as_str(), "t-fix-typo");
    assert_eq!(
        deserialized.normalized,
        "Fix the typo in the README installation section."
    );
    assert_eq!(deserialized.est_token_budget, 1200);
}

#[test]
fn blueprint_fixture_round_trips_exactly() {
    let bp = fixture_blueprint();
    let json = serialize(&bp, false);
    let deserialized: BlueprintPrimitive =
        serde_json::from_str(&json).expect("deserialize blueprint");
    assert_eq!(deserialized.id.as_str(), "bp-simple-patch");
    assert_eq!(deserialized.nodes.len(), 2);
    assert_eq!(deserialized.directives.len(), 1);
    assert_eq!(deserialized.policy.name, "bounded-default");
    assert_eq!(
        deserialized.description,
        "Locate relevant code, then produce a bounded patch under policy."
    );
}

#[test]
fn agent_fixture_round_trips_exactly() {
    let agent = fixture_agent();
    let json = serialize(&agent, false);
    let deserialized: AgentPrimitive = serde_json::from_str(&json).expect("deserialize agent");
    assert_eq!(deserialized.id.as_str(), "worker-coder-t2");
    assert_eq!(deserialized.reliability, 0.9);
    assert_eq!(deserialized.context_window, 128000);
    assert_eq!(deserialized.capabilities.len(), 3);
}

#[test]
fn artifact_fixture_round_trips_exactly() {
    let artifact = fixture_artifact();
    let json = serialize(&artifact, false);
    let deserialized: ArtifactPrimitive =
        serde_json::from_str(&json).expect("deserialize artifact");
    assert_eq!(deserialized.id.as_str(), "a-patch-001");
    assert_eq!(deserialized.body_hash, "9f2c1b7e");
    assert!(deserialized.produced_by.is_some());
}

#[test]
fn capability_fixture_round_trips_exactly() {
    let cap = fixture_capability();
    let json = serialize(&cap, false);
    let deserialized: CapabilityDescriptor =
        serde_json::from_str(&json).expect("deserialize capability");
    assert_eq!(
        deserialized.description,
        "Produce or modify source code as a typed patch artifact."
    );
}

#[test]
fn directive_fixture_round_trips_exactly() {
    let dir = fixture_directive();
    let json = serialize(&dir, false);
    let deserialized: DirectivePrimitive =
        serde_json::from_str(&json).expect("deserialize directive");
    assert_eq!(deserialized.id.as_str(), "d-scope-narrow");
    assert!(deserialized.scope.node.is_some());
    assert_eq!(deserialized.scope.node.unwrap().as_str(), "n-produce");
}

#[test]
fn node_fixture_round_trips_exactly() {
    let node = fixture_nodes().into_iter().next().unwrap();
    let json = serialize(&node, false);
    let deserialized: NodePrimitive = serde_json::from_str(&json).expect("deserialize node");
    assert_eq!(deserialized.id.as_str(), "n-locate");
    assert_eq!(deserialized.skill, Some("locate".to_string()));
}

#[test]
fn policy_fixture_round_trips_exactly() {
    let policy = fixture_policy();
    let json = serialize(&policy, false);
    let deserialized: PolicyPrimitive = serde_json::from_str(&json).expect("deserialize policy");
    assert_eq!(deserialized.name, "bounded-default");
    assert_eq!(deserialized.max_iterations, 3);
    assert_eq!(deserialized.max_cost, 100);
}

#[test]
fn trace_fixture_round_trips_exactly() {
    let trace = fixture_trace();
    let json = serialize(&trace, false);
    let deserialized: TracePrimitive = serde_json::from_str(&json).expect("deserialize trace");
    assert_eq!(deserialized.steps.len(), 2);
    assert_eq!(deserialized.steps[0].node.as_str(), "n-locate");
    assert_eq!(deserialized.steps[1].node.as_str(), "n-produce");
    assert_eq!(deserialized.total_cost_units, 20);
    assert!(deserialized.accepted);
}

#[test]
fn deserialize_rejects_malformed_json() {
    let result = deserialize("{ not valid json ");
    assert!(result.is_err());
    match result {
        Err(PrimitiveError::MalformedJson(_)) => {}
        _ => panic!("expected MalformedJson error, got {:?}", result),
    }
}

#[test]
fn serialize_blueprint_matches_golden() {
    let bp = fixture_blueprint();
    let json = serialize(&bp, true);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["kind"], "blueprint");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["id"], "bp-simple-patch");
    assert_eq!(value["nodes"].as_array().unwrap().len(), 2);
}

#[test]
fn invalid_blueprint_empty_nodes_fails() {
    let mut bp = fixture_blueprint();
    bp.nodes = vec![];
    let json = serialize(&bp, false);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let result = cortex_types::validation::validate_blueprint(&value);
    assert!(!result.ok);
    let err = result.error.unwrap();
    match err {
        PrimitiveError::ValidationError(issues) => {
            assert!(issues.iter().any(
                |i| matches!(i, ValidationIssue::Issue { code, .. } if code == "empty_collection")
            ));
        }
        _ => panic!("expected ValidationError"),
    }
}

#[test]
fn invalid_blueprint_duplicate_id_fails() {
    let mut bp = fixture_blueprint();
    bp.nodes.push(bp.nodes[0].clone());
    let json = serialize(&bp, false);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let result = cortex_types::validation::validate_blueprint(&value);
    assert!(!result.ok);
    let err = result.error.unwrap();
    match err {
        PrimitiveError::ValidationError(issues) => {
            assert!(issues.iter().any(
                |i| matches!(i, ValidationIssue::Issue { code, .. } if code == "duplicate_id")
            ));
        }
        _ => panic!("expected ValidationError"),
    }
}

#[test]
fn unknown_primitive_kind_fails() {
    let bad = serde_json::json!({"kind": "wormhole", "schemaVersion": 1});
    let result = cortex_types::validation::validate_primitive(&bad);
    assert!(!result.ok);
}

#[test]
fn wrong_schema_version_fails() {
    let mut bp = fixture_blueprint();
    bp.schema_version = 999;
    let json = serialize(&bp, false);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let result = cortex_types::validation::validate_blueprint(&value);
    assert!(!result.ok);
}

#[test]
fn serialization_fields_present() {
    let task = fixture_task();
    let json = serialize(&task, false);
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(value.get("kind").is_some());
    assert!(value.get("schemaVersion").is_some());
    assert!(value.get("id").is_some());
    assert!(value.get("normalized").is_some());
    assert!(value.get("complexity").is_some());
    assert!(value.get("requiredCapabilities").is_some());
    assert!(value.get("expectedOutput").is_some());
    assert!(value.get("blueprint").is_some());
    assert!(value.get("estTokenBudget").is_some());
}
