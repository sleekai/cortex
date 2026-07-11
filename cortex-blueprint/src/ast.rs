use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueprintAst {
    pub id: String,
    #[serde(default)]
    pub steps: Vec<StepAst>,
    #[serde(default)]
    pub transitions: Vec<TransitionAst>,
    #[serde(default)]
    pub patterns: Vec<PatternInvocationAst>,
    #[serde(default)]
    pub policies: Vec<PolicyBindingAst>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepAst {
    pub id: String,
    pub directive: String,
    #[serde(default)]
    pub inputs: Vec<InputBindingAst>,
    #[serde(default)]
    pub policies: Vec<PolicyBindingAst>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputBindingAst {
    pub source: String,
    #[serde(default)]
    pub filter: InputFilterAst,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputFilterAst {
    #[default]
    All,
    ByLabel(String),
    ByIndex(usize),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionAst {
    pub from: String,
    #[serde(default)]
    pub to: Vec<TransitionTargetAst>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionTargetAst {
    pub target: String,
    #[serde(default)]
    pub condition: ConditionAst,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionAst {
    Always,
    #[default]
    OnSuccess,
    OnFailure,
    OnLabel(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternInvocationAst {
    pub pattern: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyBindingAst {
    pub policy_id: String,
    #[serde(default)]
    pub config: serde_json::Value,
}
