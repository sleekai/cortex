// Typed validation errors (Acceptance Criterion 3). Validation never throws a
// bare string or a generic Error: it returns a Result whose failure branch
// carries structured ValidationIssue records. Each issue names a machine
// code, the JSON path it applies to, and a human message — enough for a
// caller to branch programmatically or render a useful diagnostic.

export type ValidationCode =
  | 'missing_field'
  | 'wrong_type'
  | 'unknown_enum_value'
  | 'duplicate_id'
  | 'dangling_reference'
  | 'schema_version_mismatch'
  | 'empty_collection'
  | 'invalid_value'
  | 'malformed_json'

export interface ValidationIssue {
  code: ValidationCode
  // JSON-pointer-ish path to the offending value, e.g. `blueprint.nodes[1].id`.
  path: string
  message: string
}

// A validation failure is a non-empty bag of issues. Carrying an Error
// subclass means it can also be `throw`n at a boundary that prefers
// exceptions, without losing the structured payload.
export class KernelValidationError extends Error {
  readonly issues: readonly ValidationIssue[]

  constructor(issues: readonly ValidationIssue[]) {
    super(KernelValidationError.summarize(issues))
    this.name = 'KernelValidationError'
    this.issues = issues
  }

  private static summarize(issues: readonly ValidationIssue[]): string {
    if (issues.length === 0) return 'validation failed'
    const head = issues.slice(0, 3).map(i => `${i.path}: ${i.message}`).join('; ')
    const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : ''
    return `validation failed — ${head}${more}`
  }
}

// A minimal Result. Kept local so the kernel owns its own error surface
// rather than importing one from the runtime.
export type Ok<T> = { ok: true; value: T }
export type Err = { ok: false; error: KernelValidationError }
export type Result<T> = Ok<T> | Err

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
export const err = (issues: readonly ValidationIssue[]): Err => ({ ok: false, error: new KernelValidationError(issues) })

// Accumulator used by validators to collect issues before deciding ok/err.
export class IssueBag {
  private readonly items: ValidationIssue[] = []

  add(code: ValidationCode, path: string, message: string): void {
    this.items.push({ code, path, message })
  }

  get length(): number {
    return this.items.length
  }

  drain(): ValidationIssue[] {
    return this.items.slice()
  }
}
