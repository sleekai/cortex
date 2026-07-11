use cortex_blueprint::{compile, BlueprintAst, InputBindingAst, StepAst, TransitionAst, TransitionTargetAst, ConditionAst};

#[test]
fn compile_simple_blueprint() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![
            StepAst {
                id: "n1".into(),
                directive: "cortex.plan.v1".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "n2".into(),
                directive: "cortex.produce.v1".into(),
                inputs: vec![],
                policies: vec![],
            },
        ],
        transitions: vec![TransitionAst {
            from: "n1".into(),
            to: vec![TransitionTargetAst {
                target: "n2".into(),
                condition: ConditionAst::OnSuccess,
            }],
        }],
        patterns: vec![],
        policies: vec![],
    };

    let graph = compile(ast).unwrap();
    assert_eq!(graph.entry.as_str(), "n1");
    assert_eq!(graph.nodes.len(), 2);

    let n1_edges = graph.edges.get(&cortex_types::ids::NodeId::new("n1"));
    assert!(n1_edges.is_some());
    assert_eq!(n1_edges.unwrap().len(), 1);
}

#[test]
fn compile_blueprint_infers_default_edges() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![
            StepAst {
                id: "n1".into(),
                directive: "a".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "n2".into(),
                directive: "b".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "n3".into(),
                directive: "c".into(),
                inputs: vec![],
                policies: vec![],
            },
        ],
        transitions: vec![],
        patterns: vec![],
        policies: vec![],
    };

    let graph = compile(ast).unwrap();
    assert_eq!(graph.nodes.len(), 3);

    let n1_edges = graph.edges.get(&cortex_types::ids::NodeId::new("n1")).unwrap();
    assert_eq!(n1_edges.len(), 1);
    assert_eq!(n1_edges[0].target.as_str(), "n2");

    let n2_edges = graph.edges.get(&cortex_types::ids::NodeId::new("n2")).unwrap();
    assert_eq!(n2_edges.len(), 1);
    assert_eq!(n2_edges[0].target.as_str(), "n3");
}

#[test]
fn compile_blueprint_adds_default_policies() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![StepAst {
            id: "n1".into(),
            directive: "a".into(),
            inputs: vec![],
            policies: vec![],
        }],
        transitions: vec![],
        patterns: vec![],
        policies: vec![],
    };

    let graph = compile(ast).unwrap();
    let n1 = graph.nodes.get(&cortex_types::ids::NodeId::new("n1")).unwrap();
    assert!(n1.policies.iter().any(|p| p.policy_id == "max_iterations"));
    assert!(n1.policies.iter().any(|p| p.policy_id == "budget"));
    assert!(n1.policies.iter().any(|p| p.policy_id == "retry"));
}

#[test]
fn compile_empty_blueprint_fails() {
    let ast = BlueprintAst {
        id: "empty".into(),
        steps: vec![],
        transitions: vec![],
        patterns: vec![],
        policies: vec![],
    };

    let result = compile(ast);
    assert!(result.is_err());
}

#[test]
fn compile_blueprint_rejects_duplicate_ids() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![
            StepAst {
                id: "n1".into(),
                directive: "a".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "n1".into(),
                directive: "b".into(),
                inputs: vec![],
                policies: vec![],
            },
        ],
        transitions: vec![],
        patterns: vec![],
        policies: vec![],
    };

    let result = compile(ast);
    assert!(result.is_err());
}

#[test]
fn compile_blueprint_rejects_bad_transition_refs() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![StepAst {
            id: "n1".into(),
            directive: "a".into(),
            inputs: vec![],
            policies: vec![],
        }],
        transitions: vec![TransitionAst {
            from: "n1".into(),
            to: vec![TransitionTargetAst {
                target: "nonexistent".into(),
                condition: ConditionAst::OnSuccess,
            }],
        }],
        patterns: vec![],
        policies: vec![],
    };

    let result = compile(ast);
    assert!(result.is_err());
}

#[test]
fn compile_blueprint_with_input_bindings() {
    let ast = BlueprintAst {
        id: "test".into(),
        steps: vec![
            StepAst {
                id: "n1".into(),
                directive: "producer".into(),
                inputs: vec![],
                policies: vec![],
            },
            StepAst {
                id: "n2".into(),
                directive: "consumer".into(),
                inputs: vec![InputBindingAst {
                    source: "n1".into(),
                    filter: cortex_blueprint::InputFilterAst::All,
                }],
                policies: vec![],
            },
        ],
        transitions: vec![TransitionAst {
            from: "n1".into(),
            to: vec![TransitionTargetAst {
                target: "n2".into(),
                condition: ConditionAst::OnSuccess,
            }],
        }],
        patterns: vec![],
        policies: vec![],
    };

    let graph = compile(ast).unwrap();
    let n2 = graph.nodes.get(&cortex_types::ids::NodeId::new("n2")).unwrap();
    assert_eq!(n2.inputs.len(), 1);
    assert_eq!(n2.inputs[0].source_node.as_str(), "n1");
}
