#!/usr/bin/env bash
set -euo pipefail

# Dependency-boundary check for cortex workspace.
# Verifies that no crate depends on a crate that should be "farther out"
# in the inward dependency direction:
#
#   CLI → Adapters → Kernel → { Blueprint, Policy } → Types
#                        ↘ Registry, Store → Types

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

errors=0

# allowed_dep CRATE ALLOWED_PREFIXES...
#   Asserts that CRATE's Cargo.toml only has workspace dependencies
#   whose names start with one of ALLOWED_PREFIXES.
allowed_dep() {
    local crate="$1"
    shift
    local -a allowed=("$@")

    # Extract all cortex-* dependency names from the crate's Cargo.toml
    while IFS= read -r dep; do
        local ok=0
        for prefix in "${allowed[@]}"; do
            if [[ "$dep" == "$prefix"* ]]; then
                ok=1
                break
            fi
        done
        if [[ $ok -eq 0 ]]; then
            echo "ERROR: $crate depends on '$dep' which is not in allowed list: ${allowed[*]}"
            errors=1
        fi
    done < <(grep -E '^cortex-' "$crate/Cargo.toml" 2>/dev/null | sed 's/=.*//' | tr -d ' ')
}

# cortex-types must not depend on any other cortex crate.
allowed_dep "cortex-types" ""

# cortex-blueprint and cortex-policy may only depend on cortex-types.
allowed_dep "cortex-blueprint" "cortex-types"
allowed_dep "cortex-policy" "cortex-types"
allowed_dep "cortex-registry" "cortex-types"
allowed_dep "cortex-store" "cortex-types"

# cortex-kernel may depend on types, blueprint, and policy (not registry, store, etc.)
allowed_dep "cortex-kernel" "cortex-types" "cortex-blueprint" "cortex-policy"

# cortex-adapters may depend on kernel, types (not blueprint/policy directly)
allowed_dep "cortex-adapters" "cortex-kernel" "cortex-types"

# cortex-cli may depend on adapters, kernel (not types/blueprint/policy directly)
allowed_dep "cortex-cli" "cortex-adapters" "cortex-kernel"

if [[ $errors -eq 0 ]]; then
    echo "PASS: all dependency boundaries are satisfied"
else
    echo "FAIL: some dependency boundaries were violated"
    exit 1
fi
