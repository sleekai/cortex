use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Coding,
    Reasoning,
    Planning,
    Review,
    Docs,
    Translation,
    Vision,
    Audio,
    Embeddings,
    Search,
    Locate,
}

pub const ALL_CAPABILITIES: &[Capability] = &[
    Capability::Coding,
    Capability::Reasoning,
    Capability::Planning,
    Capability::Review,
    Capability::Docs,
    Capability::Translation,
    Capability::Vision,
    Capability::Audio,
    Capability::Embeddings,
    Capability::Search,
    Capability::Locate,
];

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Triage,
    Grill,
    Context,
    Patch,
    Plan,
    Execution,
    Evaluation,
    Final,
    Decision,
    Review,
    TestResult,
    PointerSet,
    TokenEstimate,
    Compression,
    Cost,
    Intent,
    Metric,
    Failure,
    Clarification,
}

pub fn is_capability(value: &str) -> bool {
    matches!(
        value,
        "coding"
            | "reasoning"
            | "planning"
            | "review"
            | "docs"
            | "translation"
            | "vision"
            | "audio"
            | "embeddings"
            | "search"
            | "locate"
    )
}

pub const ALL_ARTIFACT_KINDS: &[ArtifactKind] = &[
    ArtifactKind::Triage,
    ArtifactKind::Grill,
    ArtifactKind::Context,
    ArtifactKind::Patch,
    ArtifactKind::Plan,
    ArtifactKind::Execution,
    ArtifactKind::Evaluation,
    ArtifactKind::Final,
    ArtifactKind::Decision,
    ArtifactKind::Review,
    ArtifactKind::TestResult,
    ArtifactKind::PointerSet,
    ArtifactKind::TokenEstimate,
    ArtifactKind::Compression,
    ArtifactKind::Cost,
    ArtifactKind::Intent,
    ArtifactKind::Metric,
    ArtifactKind::Failure,
    ArtifactKind::Clarification,
];
