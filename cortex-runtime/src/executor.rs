use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use cortex_types::kernel::{
    Artifact, ArtifactStore, Cost, Directive, DirectiveExecutor, ExecutionHints,
    ExecutionResult, ExecutorError, HydratedArtifact, Node,
};
use sha2::{Digest, Sha256};

use crate::provider::Provider;
use crate::store::InMemoryStore;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub struct CortexExecutor {
    directives: HashMap<String, Box<dyn Directive>>,
    store: Arc<InMemoryStore>,
    providers: HashMap<String, Box<dyn Provider>>,
}

impl CortexExecutor {
    pub fn new(
        directives: HashMap<String, Box<dyn Directive>>,
        store: Arc<InMemoryStore>,
        providers: HashMap<String, Box<dyn Provider>>,
    ) -> Self {
        Self {
            directives,
            store,
            providers,
        }
    }
}

#[async_trait]
impl DirectiveExecutor for CortexExecutor {
    async fn execute_node(
        &self,
        node: &Node,
        inputs: &[Artifact],
        hints: &ExecutionHints,
    ) -> Result<ExecutionResult, ExecutorError> {
        let start = Instant::now();

        let directive = self
            .directives
            .get(&node.directive)
            .ok_or_else(|| ExecutorError::PrepareFailed("Directive not found".into()))?;

        // 1. Hydrate
        let mut hydrated = Vec::new();
        for ptr in inputs {
            let body_bytes = self
                .store
                .get(&ptr.body_hash)
                .await?
                .ok_or_else(|| ExecutorError::StoreError("Hash not found".into()))?;
            let body: serde_json::Value = serde_json::from_slice(&body_bytes)
                .map_err(|e| ExecutorError::StoreError(e.to_string()))?;
            hydrated.push(HydratedArtifact {
                descriptor: ptr.clone(),
                body,
            });
        }

        // 2. Prepare (Pure)
        let request = directive.prepare(node, &hydrated)?;

        // 3. Resolve Provider
        let worker_id = hints
            .worker_override
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let provider = self
            .providers
            .get(&worker_id)
            .ok_or_else(|| ExecutorError::ResolveFailed("Provider not found".into()))?;

        // 4. Execute I/O
        let response = provider.resolve(request).await?;

        let provider_cost = response.cost.clone();

        // 5. Parse (Pure)
        let outputs = directive.parse(response)?;

        // 6. Dehydrate
        let mut artifacts = Vec::new();
        for output in outputs {
            let body_bytes = serde_json::to_vec(&output.body)
                .map_err(|e| ExecutorError::ParseFailed(e.to_string()))?;
            let hash = sha256_hex(&body_bytes);

            // 7. Store
            self.store.put(&hash, body_bytes).await?;

            artifacts.push(Artifact {
                id: uuid::Uuid::new_v4(),
                kind: output.kind,
                body_hash: hash,
                label: output.label,
            });
        }

        let duration = start.elapsed();

        let cost = Cost {
            estimated_usd: provider_cost.estimated_usd,
            tokens_input: provider_cost.tokens_input,
            tokens_output: provider_cost.tokens_output,
            provider: Some(worker_id.clone()),
        };

        Ok(ExecutionResult {
            artifacts,
            cost,
            worker_id,
            duration,
        })
    }
}
