use std::collections::HashMap;

use cortex_types::ids::NodeId;
use cortex_types::kernel::{
    Edge, EdgeCondition, ExecutionGraph, InputBinding, InputFilter, Node, PolicyBinding,
};

use crate::ast::{BlueprintAst, ConditionAst, StepAst};
use crate::error::CompileError;

pub fn compile(ast: BlueprintAst) -> Result<ExecutionGraph, CompileError> {
    let ast = expand_patterns(ast)?;
    let ast = infer_default_edges(ast)?;
    let ast = resolve_inputs(ast)?;
    let ast = bind_policies(ast)?;
    validate(&ast)?;
    let graph = lower(ast)?;
    Ok(graph)
}

fn expand_patterns(ast: BlueprintAst) -> Result<BlueprintAst, CompileError> {
    if ast.patterns.is_empty() {
        return Ok(ast);
    }
    Err(CompileError::ExpandPatterns(
        "pattern expansion not yet implemented".into(),
    ))
}

fn infer_default_edges(ast: BlueprintAst) -> Result<BlueprintAst, CompileError> {
    let steps: Vec<StepAst> = ast.steps.clone();
    if ast.transitions.is_empty() && steps.len() > 1 {
        let mut transitions = ast.transitions.clone();
        for window in steps.windows(2) {
            transitions.push(crate::ast::TransitionAst {
                from: window[0].id.clone(),
                to: vec![crate::ast::TransitionTargetAst {
                    target: window[1].id.clone(),
                    condition: crate::ast::ConditionAst::OnSuccess,
                }],
            });
        }
        let mut ast = ast;
        ast.transitions = transitions;
        Ok(ast)
    } else {
        Ok(ast)
    }
}

fn resolve_inputs(ast: BlueprintAst) -> Result<BlueprintAst, CompileError> {
    let step_ids: std::collections::HashSet<&str> =
        ast.steps.iter().map(|s| s.id.as_str()).collect();

    for step in &ast.steps {
        for binding in &step.inputs {
            if !step_ids.contains(binding.source.as_str()) {
                return Err(CompileError::Validation(format!(
                    "step '{}' references unknown input source '{}'",
                    step.id, binding.source
                )));
            }
        }
    }
    Ok(ast)
}

fn bind_policies(ast: BlueprintAst) -> Result<BlueprintAst, CompileError> {
    let mut ast = ast;
    for step in &mut ast.steps {
        let has_budget = step.policies.iter().any(|p| p.policy_id == "budget");
        let has_max_iterations = step
            .policies
            .iter()
            .any(|p| p.policy_id == "max_iterations");
        let has_retry = step.policies.iter().any(|p| p.policy_id == "retry");

        if !has_max_iterations {
            step.policies.push(crate::ast::PolicyBindingAst {
                policy_id: "max_iterations".into(),
                config: serde_json::json!({"max": 10}),
            });
        }
        if !has_budget {
            step.policies.push(crate::ast::PolicyBindingAst {
                policy_id: "budget".into(),
                config: serde_json::json!({"max": 100.0}),
            });
        }
        if !has_retry {
            step.policies.push(crate::ast::PolicyBindingAst {
                policy_id: "retry".into(),
                config: serde_json::json!({"max_retries": 3, "timeout_secs": 60}),
            });
        }
    }
    if ast.policies.is_empty() {
        ast.policies = vec![
            crate::ast::PolicyBindingAst {
                policy_id: "max_iterations".into(),
                config: serde_json::json!({"max": 10}),
            },
            crate::ast::PolicyBindingAst {
                policy_id: "budget".into(),
                config: serde_json::json!({"max": 100.0}),
            },
            crate::ast::PolicyBindingAst {
                policy_id: "retry".into(),
                config: serde_json::json!({"max_retries": 3, "timeout_secs": 60}),
            },
        ];
    }
    Ok(ast)
}

fn validate(ast: &BlueprintAst) -> Result<(), CompileError> {
    if ast.steps.is_empty() {
        return Err(CompileError::Validation(
            "blueprint must have at least one step".into(),
        ));
    }

    let mut seen_ids = std::collections::HashSet::new();
    for step in &ast.steps {
        if !seen_ids.insert(&step.id) {
            return Err(CompileError::Validation(format!(
                "duplicate step id: {}",
                step.id
            )));
        }
    }

    for transition in &ast.transitions {
        let from_exists = ast.steps.iter().any(|s| s.id == transition.from);
        if !from_exists {
            return Err(CompileError::Validation(format!(
                "transition from unknown step: {}",
                transition.from
            )));
        }
        for target in &transition.to {
            let to_exists = ast.steps.iter().any(|s| s.id == target.target);
            if !to_exists {
                return Err(CompileError::Validation(format!(
                    "transition to unknown step: {}",
                    target.target
                )));
            }
        }
    }

    Ok(())
}

fn lower(ast: BlueprintAst) -> Result<ExecutionGraph, CompileError> {
    let mut nodes = HashMap::new();
    let mut edges_map: HashMap<NodeId, Vec<Edge>> = HashMap::new();

    let entry = ast
        .steps
        .first()
        .ok_or_else(|| CompileError::Lower("no steps to lower".into()))?
        .id
        .clone();

    for step in &ast.steps {
        let mut inputs = Vec::new();
        for binding in &step.inputs {
            let filter = match &binding.filter {
                crate::ast::InputFilterAst::All => InputFilter::All,
                crate::ast::InputFilterAst::ByLabel(l) => InputFilter::ByLabel(l.clone()),
                crate::ast::InputFilterAst::ByIndex(i) => InputFilter::ByIndex(*i),
            };
            inputs.push(InputBinding {
                source_node: NodeId::new(&binding.source),
                filter,
            });
        }

        let mut policies = Vec::new();
        for binding in &step.policies {
            policies.push(PolicyBinding {
                policy_id: binding.policy_id.clone(),
                config: binding.config.clone(),
            });
        }

        nodes.insert(
            NodeId::new(&step.id),
            Node {
                id: NodeId::new(&step.id),
                directive: step.directive.clone(),
                inputs,
                policies,
            },
        );
    }

    for transition in &ast.transitions {
        let from_id = NodeId::new(&transition.from);
        let edges = edges_map.entry(from_id).or_default();

        for target in &transition.to {
            let condition = match &target.condition {
                ConditionAst::Always => EdgeCondition::Always,
                ConditionAst::OnSuccess => EdgeCondition::OnSuccess,
                ConditionAst::OnFailure => EdgeCondition::OnFailure,
                ConditionAst::OnLabel(l) => EdgeCondition::OnLabel(l.clone()),
            };
            edges.push(Edge {
                target: NodeId::new(&target.target),
                condition,
            });
        }
    }

    Ok(ExecutionGraph {
        nodes,
        edges: edges_map,
        entry: NodeId::new(entry),
    })
}
