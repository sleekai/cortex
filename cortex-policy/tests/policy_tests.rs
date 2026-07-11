use std::collections::HashMap;

use cortex_policy::*;
use cortex_types::ids::NodeId;
use cortex_types::kernel::*;

fn make_node(id: &str, policies: Vec<(&str, serde_json::Value)>) -> Node {
    Node {
        id: NodeId::new(id),
        directive: "test".into(),
        inputs: vec![],
        policies: policies
            .into_iter()
            .map(|(policy_id, config)| PolicyBinding {
                policy_id: policy_id.into(),
                config,
            })
            .collect(),
    }
}

fn make_state() -> ExecutionState {
    ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    }
}

#[test]
fn max_iterations_policy_allows_under_limit() {
    let policy = MaxIterationsPolicy;
    let mut state = make_state();
    let node = make_node("n1", vec![("max_iterations", serde_json::json!({"max": 5}))]);
    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Continue));
    assert_eq!(state.visits[&NodeId::new("n1")], 1);
}

#[test]
fn max_iterations_policy_halts_at_limit() {
    let policy = MaxIterationsPolicy;
    let mut state = make_state();
    let node = make_node("n1", vec![("max_iterations", serde_json::json!({"max": 2}))]);
    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    policy.evaluate(&mut state, &event, &node).unwrap();
    policy.evaluate(&mut state, &event, &node).unwrap();
    let action = policy.evaluate(&mut state, &event, &node).unwrap();

    assert!(matches!(action, PolicyAction::Halt { .. }));
    assert_eq!(state.visits[&NodeId::new("n1")], 3);
}

#[test]
fn budget_policy_tracks_cost() {
    let policy = BudgetPolicy;
    let mut state = make_state();
    let node = make_node("n1", vec![("budget", serde_json::json!({"max": 10.0}))]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost {
            estimated_usd: 5.0,
            ..Default::default()
        },
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    policy.evaluate(&mut state, &event, &node).unwrap();
    assert_eq!(state.total_cost, 5.0);

    // Second call: total_cost = 10.0, now >= max_budget (10.0), so halts
    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Halt { .. }));
    assert_eq!(state.total_cost, 10.0);
}

#[test]
fn retry_policy_retries_on_failure() {
    let policy = RetryPolicy;
    let mut state = make_state();
    let node = make_node(
        "n1",
        vec![("retry", serde_json::json!({"max_retries": 2, "timeout_secs": 30}))],
    );

    let event = Event::NodeFailed {
        node_id: NodeId::new("n1"),
        error: ExecutorError::ResolveFailed("timeout".into()),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Continue));
    assert_eq!(state.attempts[&NodeId::new("n1")], 1);
    assert_eq!(state.hints.timeout_override_millis, Some(30000));
}

#[test]
fn retry_policy_continues_after_max_retries() {
    let policy = RetryPolicy;
    let mut state = make_state();
    let node = make_node(
        "n1",
        vec![("retry", serde_json::json!({"max_retries": 1, "timeout_secs": 30}))],
    );

    let event = Event::NodeFailed {
        node_id: NodeId::new("n1"),
        error: ExecutorError::ResolveFailed("timeout".into()),
    };

    policy.evaluate(&mut state, &event, &node).unwrap();
    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Continue));
    assert_eq!(state.attempts[&NodeId::new("n1")], 2);
}

#[test]
fn retry_policy_ignores_success() {
    let policy = RetryPolicy;
    let mut state = make_state();
    let node = make_node("n1", vec![]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Continue));
}

#[test]
fn router_policy_transitions_on_success() {
    let mut edges: HashMap<NodeId, Vec<Edge>> = HashMap::new();
    edges.insert(
        NodeId::new("n1"),
        vec![Edge {
            target: NodeId::new("n2"),
            condition: EdgeCondition::OnSuccess,
        }],
    );

    let policy = RouterPolicy::new(edges);
    let mut state = make_state();
    let node = make_node("n1", vec![]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Transition(t) if t == NodeId::new("n2")));
}

#[test]
fn router_policy_halts_when_no_success_edge() {
    let policy = RouterPolicy::new(HashMap::new());
    let mut state = make_state();
    let node = make_node("n1", vec![]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Halt { .. }));
}

#[test]
fn router_policy_uses_label_condition() {
    let mut edges: HashMap<NodeId, Vec<Edge>> = HashMap::new();
    edges.insert(
        NodeId::new("n1"),
        vec![
            Edge {
                target: NodeId::new("n2"),
                condition: EdgeCondition::OnLabel("primary".into()),
            },
            Edge {
                target: NodeId::new("n3"),
                condition: EdgeCondition::OnSuccess,
            },
        ],
    );

    let policy = RouterPolicy::new(edges);
    let mut state = make_state();
    let node = make_node("n1", vec![]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![Artifact {
            id: uuid::Uuid::new_v4(),
            kind: "test".into(),
            body_hash: "abc".into(),
            label: Some("primary".into()),
        }],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Transition(t) if t == NodeId::new("n2")));
}

#[test]
fn router_policy_handles_failure_edge() {
    let mut edges: HashMap<NodeId, Vec<Edge>> = HashMap::new();
    edges.insert(
        NodeId::new("n1"),
        vec![Edge {
            target: NodeId::new("error_handler"),
            condition: EdgeCondition::OnFailure,
        }],
    );

    let policy = RouterPolicy::new(edges);
    let mut state = make_state();
    let node = make_node("n1", vec![]);

    let event = Event::NodeFailed {
        node_id: NodeId::new("n1"),
        error: ExecutorError::ResolveFailed("boom".into()),
    };

    let action = policy.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Transition(t) if t == NodeId::new("error_handler")));
}

#[test]
fn pipeline_runs_all_policies() {
    let pipeline = PolicyPipeline::new(vec![
        Box::new(MaxIterationsPolicy),
        Box::new(RetryPolicy),
    ]);

    let mut state = make_state();
    let node = make_node("n1", vec![("max_iterations", serde_json::json!({"max": 10}))]);

    let event = Event::NodeSucceeded {
        node_id: NodeId::new("n1"),
        artifacts: vec![],
        cost: Cost::default(),
        worker_id: "w1".into(),
        duration: std::time::Duration::from_secs(0),
    };

    let action = pipeline.evaluate(&mut state, &event, &node).unwrap();
    assert!(matches!(action, PolicyAction::Continue));
    assert_eq!(state.visits[&NodeId::new("n1")], 1);
}
