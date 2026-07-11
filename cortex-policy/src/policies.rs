use cortex_types::kernel::{
    EdgeCondition, Event, ExecutorError, ExecutionState, Node, Policy, PolicyAction,
};
use std::collections::HashMap;
use cortex_types::ids::NodeId;

fn read_policy_config(node: &Node, policy_id: &str, key: &str, default: u32) -> u32 {
    for binding in &node.policies {
        if binding.policy_id == policy_id {
            if let Some(val) = binding.config.get(key).and_then(|v| v.as_u64()) {
                return val as u32;
            }
        }
    }
    default
}

fn read_policy_config_f64(node: &Node, policy_id: &str, key: &str, default: f64) -> f64 {
    for binding in &node.policies {
        if binding.policy_id == policy_id {
            if let Some(val) = binding.config.get(key).and_then(|v| v.as_f64()) {
                return val;
            }
        }
    }
    default
}

fn has_policy_binding(node: &Node, policy_id: &str) -> bool {
    node.policies.iter().any(|b| b.policy_id == policy_id)
}

// ── Max Iterations Policy ───────────────────────────────────────────────

pub struct MaxIterationsPolicy;

impl Policy for MaxIterationsPolicy {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        _event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        let max_iterations = read_policy_config(node, "max_iterations", "max", 10);
        let visits = state.visits.entry(node.id.clone()).or_insert(0);
        *visits += 1;

        if *visits > max_iterations {
            return Ok(PolicyAction::Halt {
                reason: format!(
                    "max iterations ({}) exceeded for node {}",
                    max_iterations, node.id
                ),
            });
        }
        Ok(PolicyAction::Continue)
    }
}

// ── Budget Policy ───────────────────────────────────────────────────────

pub struct BudgetPolicy;

impl Policy for BudgetPolicy {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        let max_budget = read_policy_config_f64(node, "budget", "max", f64::MAX);

        if let Event::NodeSucceeded { ref cost, .. } = event {
            state.total_cost += cost.estimated_usd;
        }

        if state.total_cost >= max_budget {
            return Ok(PolicyAction::Halt {
                reason: format!(
                    "budget ({:.4}) exceeded for node {}",
                    max_budget, node.id
                ),
            });
        }
        Ok(PolicyAction::Continue)
    }
}

// ── Retry Policy ────────────────────────────────────────────────────────

pub struct RetryPolicy;

impl Policy for RetryPolicy {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        match event {
            Event::NodeFailed { .. } | Event::Timeout { .. } => {
                let max_retries = read_policy_config(node, "retry", "max_retries", 3);
                let attempts = state.attempts.entry(node.id.clone()).or_insert(0);
                *attempts += 1;

                if *attempts <= max_retries {
                    state.hints.timeout_override_millis = Some(
                        read_policy_config(node, "retry", "timeout_secs", 60) as u64 * 1000,
                    );
                    return Ok(PolicyAction::Continue);
                }
                Ok(PolicyAction::Continue)
            }
            _ => Ok(PolicyAction::Continue),
        }
    }
}

// ── Router Policy ───────────────────────────────────────────────────────

pub struct RouterPolicy {
    edges: HashMap<NodeId, Vec<cortex_types::kernel::Edge>>,
}

impl RouterPolicy {
    pub fn new(edges: HashMap<NodeId, Vec<cortex_types::kernel::Edge>>) -> Self {
        Self { edges }
    }
}

impl Policy for RouterPolicy {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        match event {
            Event::NodeSucceeded { artifacts, .. } => {
                let some_edges = match self.edges.get(&node.id) {
                    Some(e) => e,
                    None => return Ok(PolicyAction::Halt {
                        reason: format!("no outgoing edges from node {}", node.id),
                    }),
                };

                for edge in some_edges {
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

                Ok(PolicyAction::Halt {
                    reason: format!("no matching edge from node {}", node.id),
                })
            }
            Event::NodeFailed { .. } | Event::Timeout { .. } => {
                let has_retry = has_policy_binding(node, "retry");
                if has_retry {
                    let max_retries = read_policy_config(node, "retry", "max_retries", 3);
                    let attempts = state.attempts.get(&node.id).copied().unwrap_or(0);
                    if attempts <= max_retries {
                        return Ok(PolicyAction::Continue);
                    }
                }

                let some_edges = match self.edges.get(&node.id) {
                    Some(e) => e,
                    None => return Ok(PolicyAction::Halt {
                        reason: format!("node {} failed with no failure edge", node.id),
                    }),
                };

                for edge in some_edges {
                    match &edge.condition {
                        EdgeCondition::Always | EdgeCondition::OnFailure => {
                            return Ok(PolicyAction::Transition(edge.target.clone()));
                        }
                        _ => {}
                    }
                }

                Ok(PolicyAction::Halt {
                    reason: format!("node {} failed with no matching failure edge", node.id),
                })
            }
            _ => Ok(PolicyAction::Halt {
                reason: format!("unhandled event for node {}", node.id),
            }),
        }
    }
}
