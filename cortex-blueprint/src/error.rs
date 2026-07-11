use thiserror::Error;

#[derive(Debug, Error)]
pub enum CompileError {
    #[error("expand patterns failed: {0}")]
    ExpandPatterns(String),
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("lower failed: {0}")]
    Lower(String),
}
