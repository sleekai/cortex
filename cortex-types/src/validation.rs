use crate::errors::{PrimitiveError, ValidationIssue};
use crate::schema::{PrimitiveKind, ALL_PRIMITIVE_KINDS, KERNEL_SCHEMA_VERSION};
use serde_json::Value;

pub fn validate_schema_version(value: &Value) -> Result<(), Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    if let Some(sv) = value.get("schemaVersion").and_then(|v| v.as_u64()) {
        if sv != KERNEL_SCHEMA_VERSION as u64 {
            issues.push(ValidationIssue::new(
                "schema_version_mismatch",
                format!(
                    "expected schema version {}, got {}",
                    KERNEL_SCHEMA_VERSION, sv
                ),
                Some("schemaVersion"),
            ));
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

pub fn validate_blueprint(value: &Value) -> crate::errors::ValidationResult {
    let mut issues = Vec::new();

    if let Err(mut v) = validate_schema_version(value) {
        issues.append(&mut v);
    }

    let nodes = match value.get("nodes").and_then(|v| v.as_array()) {
        Some(n) if n.is_empty() => {
            issues.push(ValidationIssue::new(
                "empty_collection",
                "blueprint must have at least one node".to_string(),
                Some("blueprint.nodes"),
            ));
            return crate::errors::ValidationResult::invalid(PrimitiveError::ValidationError(
                issues,
            ));
        }
        Some(n) => n,
        None => {
            issues.push(ValidationIssue::new(
                "missing_field",
                "blueprint missing nodes".to_string(),
                Some("nodes"),
            ));
            return crate::errors::ValidationResult::invalid(PrimitiveError::ValidationError(
                issues,
            ));
        }
    };

    let mut seen_ids: Vec<&str> = Vec::new();
    for node in nodes {
        if let Some(id) = node.get("id").and_then(|v| v.as_str()) {
            if seen_ids.contains(&id) {
                issues.push(ValidationIssue::new(
                    "duplicate_id",
                    format!("duplicate node id: {}", id),
                    Some("blueprint.nodes"),
                ));
            }
            seen_ids.push(id);
        }
    }

    if let Some(dirs) = value.get("directives").and_then(|v| v.as_array()) {
        for dir in dirs {
            if let Some(scope) = dir.get("scope") {
                if scope.get("kind").and_then(|v| v.as_str()) == Some("node") {
                    let target = scope.get("node").and_then(|v| v.as_str());
                    if let Some(target) = target {
                        if !seen_ids.contains(&target) {
                            issues.push(ValidationIssue::new(
                                "dangling_reference",
                                format!("directive references unknown node: {}", target),
                                Some("directives"),
                            ));
                        }
                    }
                }
            }
        }
    }

    if issues.is_empty() {
        crate::errors::ValidationResult::valid()
    } else {
        crate::errors::ValidationResult::invalid(PrimitiveError::ValidationError(issues))
    }
}

fn kind_name(k: &PrimitiveKind) -> &'static str {
    match k {
        PrimitiveKind::Task => "task",
        PrimitiveKind::Artifact => "artifact",
        PrimitiveKind::Blueprint => "blueprint",
        PrimitiveKind::Node => "node",
        PrimitiveKind::Directive => "directive",
        PrimitiveKind::Agent => "agent",
        PrimitiveKind::Capability => "capability",
        PrimitiveKind::Policy => "policy",
        PrimitiveKind::Trace => "trace",
    }
}

pub fn validate_primitive(value: &Value) -> crate::errors::ValidationResult {
    let mut issues = Vec::new();

    let kind = value.get("kind").and_then(|v| v.as_str());
    match kind {
        None => {
            issues.push(ValidationIssue::new(
                "missing_field",
                "missing kind discriminant".to_string(),
                Some("kind"),
            ));
            return crate::errors::ValidationResult::invalid(PrimitiveError::ValidationError(
                issues,
            ));
        }
        Some(k) => {
            let known = ALL_PRIMITIVE_KINDS.iter().any(|pk| kind_name(pk) == k);
            if !known {
                issues.push(ValidationIssue::new(
                    "invalid_value",
                    format!("unknown primitive kind: {}", k),
                    Some("kind"),
                ));
                return crate::errors::ValidationResult::invalid(PrimitiveError::ValidationError(
                    issues,
                ));
            }
        }
    }

    crate::errors::ValidationResult::valid()
}
