use async_trait::async_trait;
use cortex_types::kernel::{ExecutorError, ExecutionRequest, ExecutionResponse};

#[async_trait]
pub trait Provider: Send + Sync {
    async fn resolve(&self, request: ExecutionRequest) -> Result<ExecutionResponse, ExecutorError>;
}
