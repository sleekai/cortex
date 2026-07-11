use async_trait::async_trait;
use cortex_types::kernel::{ArtifactStore, ExecutorError};
use std::collections::HashMap;
use std::sync::RwLock;

pub struct InMemoryStore {
    data: RwLock<HashMap<String, Vec<u8>>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            data: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ArtifactStore for InMemoryStore {
    async fn get(&self, hash: &str) -> Result<Option<Vec<u8>>, ExecutorError> {
        let data = self.data.read().map_err(|e| {
            ExecutorError::StoreError(format!("lock error: {}", e))
        })?;
        Ok(data.get(hash).cloned())
    }

    async fn put(&self, hash: &str, body: Vec<u8>) -> Result<(), ExecutorError> {
        let mut data = self.data.write().map_err(|e| {
            ExecutorError::StoreError(format!("lock error: {}", e))
        })?;
        data.insert(hash.to_string(), body);
        Ok(())
    }
}
