use cortex_types::kernel::{
    Directive, DirectiveMetadata, ExecutorError, ExecutionRequest, ExecutionResponse, HydratedArtifact,
    Node, ParsedOutput,
};

pub struct PlanDirective;

impl Directive for PlanDirective {
    fn metadata(&self) -> DirectiveMetadata {
        DirectiveMetadata {
            id: "cortex.plan.v1".into(),
            required_capabilities: vec!["planning".into()],
            input_schema: vec!["context".into()],
            output_schema: vec!["plan".into()],
        }
    }

    fn prepare(
        &self,
        _node: &Node,
        artifacts: &[HydratedArtifact],
    ) -> Result<ExecutionRequest, ExecutorError> {
        let mut context = serde_json::Map::new();
        for artifact in artifacts {
            context.insert(
                artifact.descriptor.kind.clone(),
                artifact.body.clone(),
            );
        }

        Ok(ExecutionRequest {
            prompt: "Generate an execution plan based on the provided context.".into(),
            context: serde_json::Value::Object(context),
        })
    }

    fn parse(
        &self,
        response: ExecutionResponse,
    ) -> Result<Vec<ParsedOutput>, ExecutorError> {
        let body: serde_json::Value = serde_json::from_str(&response.text)
            .unwrap_or_else(|_| serde_json::Value::String(response.text.clone()));

        Ok(vec![ParsedOutput {
            kind: "plan".into(),
            body,
            label: Some("plan".into()),
        }])
    }
}
