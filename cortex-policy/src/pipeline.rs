use cortex_types::kernel::{Event, ExecutorError, Node, Policy, PolicyAction, ExecutionState};

pub struct PolicyPipeline {
    policies: Vec<Box<dyn Policy>>,
}

impl PolicyPipeline {
    pub fn new(policies: Vec<Box<dyn Policy>>) -> Self {
        Self { policies }
    }
}

impl Policy for PolicyPipeline {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError> {
        for policy in &self.policies {
            let action = policy.evaluate(state, event, node)?;
            match action {
                PolicyAction::Continue => continue,
                terminal => return Ok(terminal),
            }
        }
        Ok(PolicyAction::Continue)
    }
}
