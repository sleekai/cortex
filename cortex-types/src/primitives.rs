use crate::capabilities::{ArtifactKind, Capability};
use crate::ids::*;
use crate::schema::*;
use serde::{Deserialize, Serialize};

// -- Capability descriptor ------------------------------------------------
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub name: Capability,
    pub description: String,
}

// -- Agent (capability provider) ------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTier {
    #[serde(rename = "1")]
    T1,
    #[serde(rename = "2")]
    T2,
    #[serde(rename = "3")]
    T3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteAccess {
    None,
    Patch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostPrior {
    #[serde(rename = "inPer1k")]
    pub in_per_1k: u32,
    #[serde(rename = "outPer1k")]
    pub out_per_1k: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: AgentId,
    pub capabilities: Vec<Capability>,
    pub tier: AgentTier,
    #[serde(rename = "writeAccess")]
    pub write_access: WriteAccess,
    #[serde(rename = "contextWindow")]
    pub context_window: u64,
    pub cost: CostPrior,
    pub reliability: f64,
}

// -- Task -----------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Complexity {
    Trivial,
    Bounded,
    Open,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskPrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: TaskId,
    pub normalized: String,
    pub complexity: Complexity,
    #[serde(rename = "requiredCapabilities")]
    pub required_capabilities: Vec<Capability>,
    #[serde(rename = "expectedOutput")]
    pub expected_output: ArtifactKind,
    pub blueprint: BlueprintId,
    #[serde(rename = "estTokenBudget")]
    pub est_token_budget: u64,
}

// -- Node -----------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Skill,
    Produce,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodePrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: NodeId,
    pub step: NodeKind,
    pub skill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

// -- Directive ------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectiveScope {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<NodeId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectivePrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: DirectiveId,
    pub instruction: String,
    pub scope: DirectiveScope,
    pub weight: u32,
}

// -- Policy ---------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClarificationMode {
    Halt,
    Proceed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyPrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub name: String,
    #[serde(rename = "maxIterations")]
    pub max_iterations: u32,
    #[serde(rename = "maxEscalationDepth")]
    pub max_escalation_depth: u32,
    #[serde(rename = "ambiguityThreshold")]
    pub ambiguity_threshold: f64,
    #[serde(rename = "clarificationMode")]
    pub clarification_mode: ClarificationMode,
    #[serde(rename = "maxCost")]
    pub max_cost: u64,
    #[serde(rename = "maxInputTokens")]
    pub max_input_tokens: u64,
}

// -- Blueprint ------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintPrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: BlueprintId,
    pub name: String,
    pub description: String,
    pub nodes: Vec<NodePrimitive>,
    pub directives: Vec<DirectivePrimitive>,
    pub policy: PolicyPrimitive,
}

// -- Artifact -------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactPrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: ArtifactId,
    #[serde(rename = "artifactKind")]
    pub artifact_kind: ArtifactKind,
    pub task: TaskId,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "producedBy")]
    pub produced_by: Option<NodeId>,
    #[serde(rename = "bodyHash")]
    pub body_hash: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// -- Trace ----------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepOutcome {
    Ok,
    Retried,
    Escalated,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceStep {
    pub node: NodeId,
    pub outcome: StepOutcome,
    pub agent: Option<AgentId>,
    pub iterations: u32,
    #[serde(rename = "costUnits")]
    pub cost_units: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TracePrimitive {
    pub kind: PrimitiveKind,
    #[serde(rename = "schemaVersion")]
    pub schema_version: SchemaVersion,
    pub id: TraceId,
    pub task: TaskId,
    pub blueprint: BlueprintId,
    pub steps: Vec<TraceStep>,
    pub accepted: bool,
    #[serde(rename = "totalCostUnits")]
    pub total_cost_units: u64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: String,
}
