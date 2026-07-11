use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cortex_blueprint::{compile, BlueprintAst, StepAst, TransitionAst, TransitionTargetAst, ConditionAst};
use cortex_kernel::KernelInterpreter;
use cortex_policy::{BudgetPolicy, MaxIterationsPolicy, PolicyPipeline, RetryPolicy, RouterPolicy};
use cortex_runtime::{CortexExecutor, InMemoryStore, Provider};
use cortex_types::ids::NodeId;
use cortex_types::kernel::*;

struct MockProvider;

#[async_trait]
impl Provider for MockProvider {
    async fn resolve(&self, request: ExecutionRequest) -> Result<ExecutionResponse, ExecutorError> {
        Ok(ExecutionResponse {
            text: request.prompt,
            cost: Cost {
                estimated_usd: 0.05,
                tokens_input: Some(50),
                tokens_output: Some(100),
                provider: Some("mock".into()),
            },
            duration: Duration::from_millis(10),
        })
    }
}

struct EchoDirective;

impl Directive for EchoDirective {
    fn metadata(&self) -> DirectiveMetadata {
        DirectiveMetadata {
            id: "echo.v1".into(),
            required_capabilities: vec![],
            input_schema: vec![],
            output_schema: vec![],
        }
    }

    fn prepare(
        &self,
        _node: &Node,
        _artifacts: &[HydratedArtifact],
    ) -> Result<ExecutionRequest, ExecutorError> {
        Ok(ExecutionRequest {
            prompt: "echo".into(),
            context: serde_json::json!({}),
        })
    }

    fn parse(
        &self,
        response: ExecutionResponse,
    ) -> Result<Vec<ParsedOutput>, ExecutorError> {
        Ok(vec![ParsedOutput {
            kind: "echo".into(),
            body: serde_json::json!({"text": response.text}),
            label: Some("echo".into()),
        }])
    }
}

fn setup_runtime(
    directives: HashMap<String, Box<dyn Directive>>,
    providers: HashMap<String, Box<dyn Provider>>,
) -> (Arc<CortexExecutor>, Arc<InMemoryStore>) {
    let store = Arc::new(InMemoryStore::new());
    let executor = Arc::new(CortexExecutor::new(directives, store.clone(), providers));
    (executor, store)
}

#[tokio::test]
async fn blueprint_to_execution_end_to_end() {
    let ast = BlueprintAst {
        id: "e2e-test".into(),
        steps: vec![
            StepAst {
                id: "plan".into(),
                directive: "echo.v1".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "produce".into(),
                directive: "echo.v1".into(),
                inputs: vec![],
                policies: vec![],
            },
        ],
        transitions: vec![TransitionAst {
            from: "plan".into(),
            to: vec![TransitionTargetAst {
                target: "produce".into(),
                condition: ConditionAst::OnSuccess,
            }],
        }],
        patterns: vec![],
        policies: vec![],
    };

    let graph = compile(ast).unwrap();

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("echo.v1".into(), Box::new(EchoDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(MockProvider));

    let (executor, _store) = setup_runtime(directives, providers);

    let pipeline = PolicyPipeline::new(vec![
        Box::new(MaxIterationsPolicy),
        Box::new(BudgetPolicy),
        Box::new(RetryPolicy),
        Box::new(RouterPolicy::new(graph.edges.clone())),
    ]);

    let kernel = KernelInterpreter::new(executor, Arc::new(pipeline));

    let mut state = ExecutionState {
        current_node: graph.entry.clone(),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();

    assert_eq!(state.current_node.as_str(), "produce");
    assert!(
        matches!(state.status, ExecutionStatus::Halted)
            || matches!(state.status, ExecutionStatus::Running)
    );
    assert!(state.total_cost >= 0.05);
}

#[tokio::test]
async fn blueprint_with_failure_edge_routes_to_error_handler() {
    // Create a graph where n1 always fails and routes to error node
    let mut results: HashMap<String, Result<ExecutionResult, ExecutorError>> = HashMap::new();
    results.insert(
        "failing".into(),
        Err(ExecutorError::ResolveFailed("unavailable".into())),
    );

    let graph = ExecutionGraph {
        nodes: {
            let mut m = HashMap::new();
            m.insert(
                NodeId::new("n1"),
                Node {
                    id: NodeId::new("n1"),
                    directive: "failing".into(),
                    inputs: vec![],
                    policies: vec![PolicyBinding {
                        policy_id: "retry".into(),
                        config: serde_json::json!({"max_retries": 1, "timeout_secs": 10}),
                    }],
                },
            );
            m.insert(
                NodeId::new("error_handler"),
                Node {
                    id: NodeId::new("error_handler"),
                    directive: "echo.v1".into(),
                    inputs: vec![],
                    policies: vec![],
                },
            );
            m
        },
        edges: {
            let mut m = HashMap::new();
            m.insert(
                NodeId::new("n1"),
                vec![Edge {
                    target: NodeId::new("error_handler"),
                    condition: EdgeCondition::OnFailure,
                }],
            );
            m
        },
        entry: NodeId::new("n1"),
    };

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("echo.v1".into(), Box::new(EchoDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(MockProvider));

    let (executor, _store) = setup_runtime(directives, providers);

    let pipeline = PolicyPipeline::new(vec![
        Box::new(MaxIterationsPolicy),
        Box::new(BudgetPolicy),
        Box::new(RetryPolicy),
        Box::new(RouterPolicy::new(graph.edges.clone())),
    ]);

    let kernel = KernelInterpreter::new(executor, Arc::new(pipeline));

    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();

    assert_eq!(state.current_node.as_str(), "error_handler");
}

#[tokio::test]
async fn blueprint_with_retry_eventually_succeeds() {
    // First attempt fails, second succeeds
    let attempt_count = Arc::new(std::sync::Mutex::new(0));
    let count = attempt_count.clone();

    struct RetryExecutor {
        count: Arc<std::sync::Mutex<usize>>,
    }

    #[async_trait]
    impl DirectiveExecutor for RetryExecutor {
        async fn execute_node(
            &self,
            _node: &Node,
            _inputs: &[Artifact],
            _hints: &ExecutionHints,
        ) -> Result<ExecutionResult, ExecutorError> {
            let mut c = self.count.lock().unwrap();
            *c += 1;
            if *c == 1 {
                Err(ExecutorError::ResolveTimeout)
            } else {
                Ok(ExecutionResult {
                    artifacts: vec![Artifact {
                        id: uuid::Uuid::new_v4(),
                        kind: "success".into(),
                        body_hash: "retry_success".into(),
                        label: Some("result".into()),
                    }],
                    cost: Cost::default(),
                    worker_id: "retry".into(),
                    duration: Duration::from_millis(0),
                })
            }
        }
    }

    let graph = ExecutionGraph {
        nodes: {
            let mut m = HashMap::new();
            m.insert(
                NodeId::new("n1"),
                Node {
                    id: NodeId::new("n1"),
                    directive: "flaky".into(),
                    inputs: vec![],
                    policies: vec![
                        PolicyBinding {
                            policy_id: "retry".into(),
                            config: serde_json::json!({"max_retries": 3, "timeout_secs": 10}),
                        },
                        PolicyBinding {
                            policy_id: "max_iterations".into(),
                            config: serde_json::json!({"max": 10}),
                        },
                    ],
                },
            );
            m
        },
        edges: HashMap::new(),
        entry: NodeId::new("n1"),
    };

    let executor = Arc::new(RetryExecutor {
        count: attempt_count,
    });

    let pipeline = PolicyPipeline::new(vec![
        Box::new(MaxIterationsPolicy),
        Box::new(BudgetPolicy),
        Box::new(RetryPolicy),
        Box::new(RouterPolicy::new(graph.edges.clone())),
    ]);

    let kernel = KernelInterpreter::new(executor, Arc::new(pipeline));

    let mut state = ExecutionState {
        current_node: NodeId::new("n1"),
        ..Default::default()
    };

    kernel.run(&graph, &mut state).await.unwrap();

    let final_count = *count.lock().unwrap();
    assert_eq!(final_count, 2, "should have executed twice (fail then succeed)");
    assert_eq!(
        state.artifacts.get(&NodeId::new("n1")).unwrap().len(),
        1,
        "should have one success artifact"
    );
}
