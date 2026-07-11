use crate::ids::NodeId;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

// ── Artifacts & Data Flow ────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub id: Uuid,
    pub kind: String,
    pub body_hash: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HydratedArtifact {
    pub descriptor: Artifact,
    pub body: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ParsedOutput {
    pub kind: String,
    pub body: serde_json::Value,
    pub label: Option<String>,
}

// ── Graph & Execution State ─────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionGraph {
    pub nodes: HashMap<NodeId, Node>,
    pub edges: HashMap<NodeId, Vec<Edge>>,
    pub entry: NodeId,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub directive: String,
    pub inputs: Vec<InputBinding>,
    pub policies: Vec<PolicyBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InputBinding {
    pub source_node: NodeId,
    pub filter: InputFilter,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum InputFilter {
    All,
    ByLabel(String),
    ByIndex(usize),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Edge {
    pub target: NodeId,
    pub condition: EdgeCondition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum EdgeCondition {
    Always,
    OnSuccess,
    OnFailure,
    OnLabel(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExecutionState {
    pub current_node: NodeId,
    pub artifacts: HashMap<NodeId, Vec<Artifact>>,
    pub status: ExecutionStatus,
    pub attempts: HashMap<NodeId, u32>,
    pub total_cost: f64,
    pub visits: HashMap<NodeId, u32>,
    pub hints: ExecutionHints,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExecutionHints {
    pub worker_override: Option<String>,
    pub timeout_override_millis: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum ExecutionStatus {
    #[default]
    Running,
    Halted,
    AwaitUser,
}

// ── Execution & Cost Types ──────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cost {
    pub estimated_usd: f64,
    pub tokens_input: Option<u64>,
    pub tokens_output: Option<u64>,
    pub provider: Option<String>,
}

impl Default for Cost {
    fn default() -> Self {
        Self {
            estimated_usd: 0.0,
            tokens_input: None,
            tokens_output: None,
            provider: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ExecutionResult {
    pub artifacts: Vec<Artifact>,
    pub cost: Cost,
    pub worker_id: String,
    pub duration: Duration,
}

#[derive(Clone, Debug)]
pub struct ExecutionRequest {
    pub prompt: String,
    pub context: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct ExecutionResponse {
    pub text: String,
    pub cost: Cost,
    pub duration: Duration,
}

// ── Events ──────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum Event {
    NodeSucceeded {
        node_id: NodeId,
        artifacts: Vec<Artifact>,
        cost: Cost,
        worker_id: String,
        duration: Duration,
    },
    NodeFailed {
        node_id: NodeId,
        error: ExecutorError,
    },
    Timeout {
        node_id: NodeId,
    },
    BudgetExceeded {
        node_id: NodeId,
        spent: f64,
        limit: f64,
    },
}

// ── Policy Action ───────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum PolicyAction {
    Continue,
    Transition(NodeId),
    Halt { reason: String },
    AwaitUser,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PolicyBinding {
    pub policy_id: String,
    pub config: serde_json::Value,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ExecutorError {
    #[error("prepare failed: {0}")]
    PrepareFailed(String),
    #[error("resolve timed out")]
    ResolveTimeout,
    #[error("resolve failed: {0}")]
    ResolveFailed(String),
    #[error("parse failed: {0}")]
    ParseFailed(String),
    #[error("store error: {0}")]
    StoreError(String),
    #[error("policy error: {0}")]
    PolicyError(String),
}

// ── Trait Seams ─────────────────────────────────────────────────────────

#[async_trait]
pub trait DirectiveExecutor: Send + Sync {
    async fn execute_node(
        &self,
        node: &Node,
        inputs: &[Artifact],
        hints: &ExecutionHints,
    ) -> Result<ExecutionResult, ExecutorError>;
}

#[async_trait]
pub trait ArtifactStore: Send + Sync {
    async fn get(&self, hash: &str) -> Result<Option<Vec<u8>>, ExecutorError>;
    async fn put(&self, hash: &str, body: Vec<u8>) -> Result<(), ExecutorError>;
}

pub trait Directive: Send + Sync + 'static {
    fn metadata(&self) -> DirectiveMetadata;
    fn prepare(
        &self,
        node: &Node,
        artifacts: &[HydratedArtifact],
    ) -> Result<ExecutionRequest, ExecutorError>;
    fn parse(
        &self,
        response: ExecutionResponse,
    ) -> Result<Vec<ParsedOutput>, ExecutorError>;
}

pub struct DirectiveMetadata {
    pub id: String,
    pub required_capabilities: Vec<String>,
    pub input_schema: Vec<String>,
    pub output_schema: Vec<String>,
}

pub trait Policy: Send + Sync {
    fn evaluate(
        &self,
        state: &mut ExecutionState,
        event: &Event,
        node: &Node,
    ) -> Result<PolicyAction, ExecutorError>;
}
