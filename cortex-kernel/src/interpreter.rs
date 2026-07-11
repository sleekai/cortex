use std::sync::Arc;

use cortex_types::kernel::{
    Artifact, DirectiveExecutor, Event, ExecutorError, ExecutionGraph, ExecutionState,
    InputFilter, Node, Policy, PolicyAction,
};

pub struct KernelInterpreter {
    executor: Arc<dyn DirectiveExecutor>,
    policy: Arc<dyn Policy>,
}

impl KernelInterpreter {
    pub fn new(executor: Arc<dyn DirectiveExecutor>, policy: Arc<dyn Policy>) -> Self {
        Self { executor, policy }
    }

    pub async fn run(
        &self,
        graph: &ExecutionGraph,
        state: &mut ExecutionState,
    ) -> Result<(), ExecutorError> {
        loop {
            let node = graph
                .nodes
                .get(&state.current_node)
                .ok_or_else(|| ExecutorError::PrepareFailed("Node not found".into()))?;

            let inputs = self.get_inputs(node, state);
            let hints = state.hints.clone();

            let event = match self
                .executor
                .execute_node(node, &inputs, &hints)
                .await
            {
                Ok(result) => {
                    if !result.artifacts.is_empty() {
                        state
                            .artifacts
                            .insert(node.id.clone(), result.artifacts.clone());
                    }
                    let cost = result.cost;
                    Event::NodeSucceeded {
                        node_id: node.id.clone(),
                        artifacts: result.artifacts,
                        cost,
                        worker_id: result.worker_id,
                        duration: result.duration,
                    }
                }
                Err(ExecutorError::ResolveTimeout) => {
                    Event::Timeout {
                        node_id: node.id.clone(),
                    }
                }
                Err(e) => Event::NodeFailed {
                    node_id: node.id.clone(),
                    error: e,
                },
            };

            let action = self.policy.evaluate(state, &event, node)?;

            match action {
                PolicyAction::Continue => continue,
                PolicyAction::Transition(next) => {
                    state.current_node = next;
                }
                PolicyAction::Halt { .. } => {
                    state.status = cortex_types::kernel::ExecutionStatus::Halted;
                    break;
                }
                PolicyAction::AwaitUser => {
                    state.status = cortex_types::kernel::ExecutionStatus::AwaitUser;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn get_inputs(&self, node: &Node, state: &ExecutionState) -> Vec<Artifact> {
        let mut inputs = Vec::new();
        for binding in &node.inputs {
            if let Some(produced) = state.artifacts.get(&binding.source_node) {
                match &binding.filter {
                    InputFilter::All => inputs.extend(produced.iter().cloned()),
                    InputFilter::ByLabel(l) => {
                        inputs.extend(
                            produced
                                .iter()
                                .filter(|a| a.label.as_deref() == Some(l.as_str()))
                                .cloned(),
                        );
                    }
                    InputFilter::ByIndex(i) => {
                        if let Some(a) = produced.get(*i) {
                            inputs.push(a.clone());
                        }
                    }
                }
            }
        }
        inputs
    }
}
