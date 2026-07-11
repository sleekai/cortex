use crate::errors::PrimitiveError;
use serde::Serialize;
use serde_json::Value;

pub fn serialize<T: Serialize>(value: &T, pretty: bool) -> String {
    if pretty {
        serde_json::to_string_pretty(value)
            .expect("serialization should not fail for valid primitives")
    } else {
        serde_json::to_string(value).expect("serialization should not fail for valid primitives")
    }
}

pub fn deserialize(input: &str) -> Result<Value, PrimitiveError> {
    serde_json::from_str(input).map_err(|e| PrimitiveError::MalformedJson(e.to_string()))
}

pub fn round_trip<T>(value: &T) -> Result<Value, PrimitiveError>
where
    T: Serialize,
{
    let serialized = serialize(value, false);
    deserialize(&serialized)
}
