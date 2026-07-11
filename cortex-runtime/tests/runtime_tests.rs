use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use cortex_runtime::{CortexExecutor, InMemoryStore, Provider};
use cortex_types::ids::NodeId;
use cortex_types::kernel::*;

struct EchoProvider;

#[async_trait]
impl Provider for EchoProvider {
    async fn resolve(&self, request: ExecutionRequest) -> Result<ExecutionResponse, ExecutorError> {
        Ok(ExecutionResponse {
            text: request.prompt,
            cost: Cost {
                estimated_usd: 0.01,
                tokens_input: Some(10),
                tokens_output: Some(20),
                provider: Some("echo".into()),
            },
            duration: std::time::Duration::from_millis(5),
        })
    }
}

struct TestDirective;

impl Directive for TestDirective {
    fn metadata(&self) -> DirectiveMetadata {
        DirectiveMetadata {
            id: "test.v1".into(),
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
            prompt: "test prompt".into(),
            context: serde_json::json!({}),
        })
    }

    fn parse(
        &self,
        response: ExecutionResponse,
    ) -> Result<Vec<ParsedOutput>, ExecutorError> {
        Ok(vec![ParsedOutput {
            kind: "test_output".into(),
            body: serde_json::json!({"text": response.text}),
            label: Some("test".into()),
        }])
    }
}

#[tokio::test]
async fn in_memory_store_round_trip() {
    let store = InMemoryStore::new();

    let result = store.get("nonexistent").await.unwrap();
    assert!(result.is_none());

    store.put("abc", b"hello world".to_vec()).await.unwrap();
    let data = store.get("abc").await.unwrap();
    assert_eq!(data, Some(b"hello world".to_vec()));
}

#[tokio::test]
async fn cortex_executor_executes_node() {
    let store = Arc::new(InMemoryStore::new());

    store
        .put("ctx_hash", serde_json::to_vec(&serde_json::json!({"key": "val"})).unwrap())
        .await
        .unwrap();

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("test.v1".into(), Box::new(TestDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(EchoProvider));

    let executor = CortexExecutor::new(directives, store, providers);

    let node = Node {
        id: NodeId::new("n1"),
        directive: "test.v1".into(),
        inputs: vec![],
        policies: vec![],
    };

    let result = executor
        .execute_node(&node, &[], &ExecutionHints::default())
        .await
        .unwrap();

    assert_eq!(result.worker_id, "default");
    assert_eq!(result.cost.estimated_usd, 0.01);
    assert_eq!(result.artifacts.len(), 1);
    assert_eq!(result.artifacts[0].kind, "test_output");
    assert_eq!(result.artifacts[0].label, Some("test".into()));
}

#[tokio::test]
async fn cortex_executor_hydrates_inputs() {
    let store = Arc::new(InMemoryStore::new());

    let input_body = serde_json::json!({"input_data": "hello"});
    let input_bytes = serde_json::to_vec(&input_body).unwrap();
    let input_hash = sha2_hex(&input_bytes);

    store.put(&input_hash, input_bytes).await.unwrap();

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("test.v1".into(), Box::new(TestDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(EchoProvider));

    let executor = CortexExecutor::new(directives, store, providers);

    let node = Node {
        id: NodeId::new("n1"),
        directive: "test.v1".into(),
        inputs: vec![],
        policies: vec![],
    };

    let input_artifact = Artifact {
        id: uuid::Uuid::new_v4(),
        kind: "context".into(),
        body_hash: input_hash.clone(),
        label: None,
    };

    let result = executor
        .execute_node(&node, &[input_artifact], &ExecutionHints::default())
        .await
        .unwrap();

    assert_eq!(result.artifacts.len(), 1);
    assert!(!result.artifacts[0].body_hash.is_empty());
}

fn sha2_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[tokio::test]
async fn cortex_executor_errors_on_missing_directive() {
    let store = Arc::new(InMemoryStore::new());
    let executor = CortexExecutor::new(
        HashMap::new(),
        store,
        HashMap::new(),
    );

    let node = Node {
        id: NodeId::new("n1"),
        directive: "nonexistent".into(),
        inputs: vec![],
        policies: vec![],
    };

    let result = executor
        .execute_node(&node, &[], &ExecutionHints::default())
        .await;

    assert!(matches!(result, Err(ExecutorError::PrepareFailed(_))));
}

#[tokio::test]
async fn cortex_executor_errors_on_missing_hash() {
    let store = Arc::new(InMemoryStore::new());

    let mut directives: HashMap<String, Box<dyn Directive>> = HashMap::new();
    directives.insert("test.v1".into(), Box::new(TestDirective));

    let mut providers: HashMap<String, Box<dyn Provider>> = HashMap::new();
    providers.insert("default".into(), Box::new(EchoProvider));

    let executor = CortexExecutor::new(directives, store, providers);

    let node = Node {
        id: NodeId::new("n1"),
        directive: "test.v1".into(),
        inputs: vec![],
        policies: vec![],
    };

    let bad_artifact = Artifact {
        id: uuid::Uuid::new_v4(),
        kind: "context".into(),
        body_hash: "nonexistent_hash".into(),
        label: None,
    };

    let result = executor
        .execute_node(&node, &[bad_artifact], &ExecutionHints::default())
        .await;

    assert!(matches!(result, Err(ExecutorError::StoreError(_))));
}
