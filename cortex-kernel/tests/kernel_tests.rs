use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cortex_kernel::KernelInterpreter;
use cortex_types::ids::NodeId;
use cortex_types::kernel::*;

// ── Mock Executor ───────────────────────────────────────────────────────

struct MockExecutor {
    results: HashMap<String, Result<ExecutionResult, ExecutorError>>,
}

#[async_trait]
impl DirectiveExecutor for MockExecutor {
    async fn execute_node(
        &self,
        node: &Node,
        _inputs: &[Artifact],
        _hints: &ExecutionHints,
    ) -> Result<ExecutionResult, ExecutorError> {
        match self.results.get(&node.directive) {
            Some(Ok(result)) => Ok(result.clone()),
            Some(Err(e)) => Err(e.clone()),
            None => Ok(ExecutionResult {
                artifacts: vec![],
                cost: Cost::default(),
                worker_id: "mock".into(),
                duration: Duration::from_millis(0),
            }),
        }
    }
}

// ── Mock Policy ─────────────────────────────────────────────────────────

struct MockPolicy {
    actions: Vec<PolicyAction>,
    index: std::sync::Mutex<usize>,
}

impl Policy for MockPolicy {
    fn evaluate(
        &self,
        __state: &mut ExecutionState,
        _event: &Event,
        _node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        let mut idx = self.index.lock().unwrap();
        let action = self.actions[*idx % self.actions.len()].clone();
        *idx += 1;
        Ok(action)
    }
}

fn make_graph(
    nodes: Vec<(&str, &str)>,
    edges: Vec<(&str, &str, EdgeCondition)>,
) -> ExecutionGraph {
    let mut node_map = HashMap::new();
    let mut edge_map: HashMap<NodeId, Vec<Edge>> = HashMap::new();

    let entry = nodes[0].0;
    for (id, directive) in nodes {
        node_map.insert(
            NodeId::new(id),
            Node {
                id: NodeId::new(id),
                directive: directive.to_string(),
                inputs: vec![],
                policies: vec![],
            },
        );
    }

    for (from, to, condition) in edges {
        edge_map
            .entry(NodeId::new(from))
            .or_default()
            .push(Edge {
                target: NodeId::new(to),
                condition,
            });
    }

    ExecutionGraph {
        nodes: node_map,
        edges: edge_map,
        entry: NodeId::new(entry),
    }
}

// ── Routing Policy for Kernel Integration Tests ─────────────────────────

struct RoutingPolicy {
    edges: HashMap<NodeId, Vec<Edge>>,
}

impl Policy for RoutingPolicy {
    fn evaluate(
        &self,
        _state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        match event {
            Event::NodeSucceeded { artifacts, .. } => {
                if let Some(edges) = self.edges.get(&node.id) {
                    for edge in edges {
                        let matched = match &edge.condition {
                            EdgeCondition::Always => true,
                            EdgeCondition::OnSuccess => true,
                            EdgeCondition::OnFailure => false,
                            EdgeCondition::OnLabel(label) => {
                                artifacts.iter().any(|a| a.label.as_deref() == Some(label.as_str()))
                            }
                        };
                        if matched {
                            return Ok(PolicyAction::Transition(edge.target.clone()));
                        }
                    }
                }
                Ok(PolicyAction::Halt {
                    reason: "no matching edge".into(),
                })
            }
            Event::NodeFailed { .. } | Event::Timeout { .. } => {
                if let Some(edges) = self.edges.get(&node.id) {
                    for edge in edges {
                        if matches!(edge.condition, EdgeCondition::Always | EdgeCondition::OnFailure)
                        {
                            return Ok(PolicyAction::Transition(edge.target.clone()));
                        }
                    }
                }
                Ok(PolicyAction::Halt {
                    reason: "no failure edge".into(),
                })
            }
            _ => Ok(PolicyAction::Halt {
                reason: "unhandled".into(),
            }),
        }
    }
}

#[tokio::test]
async fn kernel_runs_single_node() {
    let mut results = HashMap::new();
    results.insert(
        "test".into(),
        Ok(ExecutionResult {
            artifacts: vec![],
            cost: Cost::default(),
            worker_id: "mock".into(),
            duration: Duration::from_millis(0),
        }),
    );

    let executor = Arc::new(MockExecutor { results });
    let policy = Arc::new(MockPolicy {
        actions: vec![PolicyAction::Halt {
            reason: "done".into(),
        }],
        index: std::sync::Mutex::new(0),
    });

    let kernel = KernelInterpreter::new(executor, policy);
    let graph = make_graph(vec![("n1", "test")], vec![]);
    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();
    assert_eq!(
        state.status,
        cortex_types::kernel::ExecutionStatus::Halted
    );
}

#[tokio::test]
async fn kernel_transitions_between_nodes() {
    let mut results = HashMap::new();
    results.insert(
        "a".into(),
        Ok(ExecutionResult {
            artifacts: vec![],
            cost: Cost::default(),
            worker_id: "mock".into(),
            duration: Duration::from_millis(0),
        }),
    );
    results.insert(
        "b".into(),
        Ok(ExecutionResult {
            artifacts: vec![],
            cost: Cost::default(),
            worker_id: "mock".into(),
            duration: Duration::from_millis(0),
        }),
    );

    let executor = Arc::new(MockExecutor { results });
    let mut edges = HashMap::new();
    edges.insert(
        NodeId::new("n1"),
        vec![Edge {
            target: NodeId::new("n2"),
            condition: EdgeCondition::OnSuccess,
        }],
    );

    let policy = Arc::new(RoutingPolicy { edges });
    let kernel = KernelInterpreter::new(executor, policy);

    let graph = make_graph(
        vec![("n1", "a"), ("n2", "b")],
        vec![("n1", "n2", EdgeCondition::OnSuccess)],
    );
    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();
    assert_eq!(state.current_node, NodeId::new("n2"));
}

#[tokio::test]
async fn kernel_stores_artifacts_in_state() {
    let mut results = HashMap::new();
    results.insert(
        "producer".into(),
        Ok(ExecutionResult {
            artifacts: vec![Artifact {
                id: uuid::Uuid::new_v4(),
                kind: "output".into(),
                body_hash: "abc123".into(),
                label: Some("result".into()),
            }],
            cost: Cost::default(),
            worker_id: "mock".into(),
            duration: Duration::from_millis(0),
        }),
    );

    let executor = Arc::new(MockExecutor { results });
    let policy = Arc::new(MockPolicy {
        actions: vec![PolicyAction::Halt {
            reason: "done".into(),
        }],
        index: std::sync::Mutex::new(0),
    });

    let kernel = KernelInterpreter::new(executor, policy);
    let graph = make_graph(vec![("n1", "producer")], vec![]);
    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();
    let artifacts = state.artifacts.get(&NodeId::new("n1"));
    assert!(artifacts.is_some());
    assert_eq!(artifacts.unwrap().len(), 1);
}

#[tokio::test]
async fn kernel_continues_on_retry() {
    let results: HashMap<String, Result<ExecutionResult, ExecutorError>> = HashMap::new();
    let executor = Arc::new(MockExecutor { results });

    // Policy always returns Continue, simulating a retry scenario
    let policy = Arc::new(MockPolicy {
        actions: vec![
            PolicyAction::Continue,
            PolicyAction::Continue,
            PolicyAction::Halt { reason: "max retries".into() },
        ],
        index: std::sync::Mutex::new(0),
    });

    let kernel = KernelInterpreter::new(executor, policy);
    let graph = make_graph(vec![("n1", "missing")], vec![]);
    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();
    assert_eq!(
        state.status,
        cortex_types::kernel::ExecutionStatus::Halted
    );
}

#[tokio::test]
async fn kernel_awaits_user() {
    let mut results = HashMap::new();
    results.insert(
        "test".into(),
        Ok(ExecutionResult {
            artifacts: vec![],
            cost: Cost::default(),
            worker_id: "mock".into(),
            duration: Duration::from_millis(0),
        }),
    );

    let executor = Arc::new(MockExecutor { results });
    let policy = Arc::new(MockPolicy {
        actions: vec![PolicyAction::AwaitUser],
        index: std::sync::Mutex::new(0),
    });

    let kernel = KernelInterpreter::new(executor, policy);
    let graph = make_graph(vec![("n1", "test")], vec![]);
    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();
    assert_eq!(
        state.status,
        cortex_types::kernel::ExecutionStatus::AwaitUser
    );
}
