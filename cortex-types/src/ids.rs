use std::fmt;

macro_rules! id_type {
    ($name:ident, $prefix:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        pub struct $name(String);

        impl $name {
            pub fn new(v: impl Into<String>) -> Self {
                Self(v.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

id_type!(TaskId, "t-");
id_type!(ArtifactId, "a-");
id_type!(BlueprintId, "bp-");
id_type!(NodeId, "n-");
id_type!(DirectiveId, "d-");
id_type!(AgentId, "a-");
id_type!(TraceId, "tr-");

pub fn task_id(v: impl Into<String>) -> TaskId {
    TaskId::new(v)
}
pub fn artifact_id(v: impl Into<String>) -> ArtifactId {
    ArtifactId::new(v)
}
pub fn blueprint_id(v: impl Into<String>) -> BlueprintId {
    BlueprintId::new(v)
}
pub fn node_id(v: impl Into<String>) -> NodeId {
    NodeId::new(v)
}
pub fn directive_id(v: impl Into<String>) -> DirectiveId {
    DirectiveId::new(v)
}
pub fn agent_id(v: impl Into<String>) -> AgentId {
    AgentId::new(v)
}
pub fn trace_id(v: impl Into<String>) -> TraceId {
    TraceId::new(v)
}
