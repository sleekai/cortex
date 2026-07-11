pub const KERNEL_SCHEMA_VERSION: u32 = 1;

pub type SchemaVersion = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrimitiveKind {
    Task,
    Artifact,
    Blueprint,
    Node,
    Directive,
    Agent,
    Capability,
    Policy,
    Trace,
}

pub const ALL_PRIMITIVE_KINDS: &[PrimitiveKind] = &[
    PrimitiveKind::Task,
    PrimitiveKind::Artifact,
    PrimitiveKind::Blueprint,
    PrimitiveKind::Node,
    PrimitiveKind::Directive,
    PrimitiveKind::Agent,
    PrimitiveKind::Capability,
    PrimitiveKind::Policy,
    PrimitiveKind::Trace,
];

pub trait PrimitiveHeader {
    fn kind(&self) -> PrimitiveKind;
    fn schema_version(&self) -> SchemaVersion;
}
