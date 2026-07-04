# UCP v2 — Ultra-Compact Packet Specification

Version: 2
Status: Stable

## Overview

UCP v2 is the wire format for all communication between Cortex and its workers/oracles. It uses single-letter keys for minimum token overhead, keyword-compressed goals, and file-path pointers instead of pasted content.

## Acts

| Field | Worker act | Oracle acts |
|-------|-----------|-------------|
| `act` | `work` | `ask`, `review` |

## Packet Structure

```json
{
  "v": 2,
  "t": "task-slug",
  "act": "work|ask|review",
  "g": "keyword goal",
  "q": "one-line question",
  "c": ["constraint"],
  "ctx": {
    "f": ["file#L or file:symbol"],
    "d": ["prefix-keyed fact line"]
  },
  "r": { "out": "patch|decision|design|review" }
}
```

### Fields

| Key | Required | Description |
|-----|----------|-------------|
| `v` | always | Protocol version (2) |
| `t` | always | Task slug — short identifier, no spaces |
| `act` | always | Packet act: `work`, `ask`, or `review` |
| `g` | work | Goal compressed to keywords (space-separated) |
| `q` | ask | One-line question the oracle decides |
| `c` | optional | Constraints as atomic phrases |
| `ctx.f` | work | File pointers (`path#L` or `path:symbol`) |
| `ctx.d` | optional | Facts, one per line, prefix-keyed |
| `r.out` | always | Expected output shape |

### Fact prefix keys (for `ctx.d`)

| Prefix | Used with | Description |
|--------|-----------|-------------|
| `spec:` | ask, review | Pointer to spec document |
| `diff:` | review | Git range, file list, or `unstaged` |
| `tried:` | ask | What was attempted |
| `failed:` | ask | What was observed on failure |
| `human:` | ask | Human decision on a prior question |
| `already:` | work | What's been done already |

## Output Shapes

### Work output (`act: work`)

```json
{ "a": "<unified diff or IMPOSSIBLE: reason>", "why": "one line" }
```

### Ask output (`act: ask`)

```json
{ "a": "<decision>", "why": "optional rationale" }
```

### Review output (`act: review`)

```json
{ "v": "PASS" }
{ "v": "ISSUES", "i": [["R|Y|G", "path#L", "finding"]] }
```

### Intent question

```json
{ "q": "question only a human can answer" }
```

### Failure

```json
{ "fail": "reason the oracle couldn't judge" }
```

## Validation Rules

1. `act: work` requires `g` and `ctx.f`
2. `act: ask` requires `q`
3. `act: review` requires a `diff:` fact in `ctx.d`
4. `r.out` must match one of: `patch`, `decision`, `design`, `review`
5. File paths in `ctx.f` must be relative
6. Facts in `ctx.d` must be ≤ 10 lines total
7. Every packet must have exactly one `act`
