use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ValidationIssue {
    #[error("{}: {}", code, message)]
    Issue {
        code: String,
        message: String,
        path: Option<String>,
    },
}

impl ValidationIssue {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        path: Option<impl Into<String>>,
    ) -> Self {
        ValidationIssue::Issue {
            code: code.into(),
            message: message.into(),
            path: path.map(|p| p.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidationResult {
    pub ok: bool,
    pub error: Option<PrimitiveError>,
}

impl ValidationResult {
    pub fn valid() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }
    pub fn invalid(err: PrimitiveError) -> Self {
        Self {
            ok: false,
            error: Some(err),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum PrimitiveError {
    #[error("malformed JSON: {0}")]
    MalformedJson(String),
    #[error("unknown primitive kind: {0}")]
    UnknownKind(String),
    #[error("schema version mismatch: expected {expected}, got {actual}")]
    SchemaVersionMismatch { expected: u32, actual: u32 },
    #[error("validation error")]
    ValidationError(Vec<ValidationIssue>),
}
