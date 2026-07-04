// Packet -> prompt rendering, per act. This is the only place where a typed
// packet becomes model-facing text; harnesses transport it verbatim.
import { type UCP } from '../packet/ucp.js'
import { type CodeChunk } from '../core/types.js'

const WORK_PREAMBLE = `<sys>Generate unified diff patch for given UCP task.
Output ONLY:
\`\`\`diff
--- a/file
+++ b/file
@@ ... @@
\`\`\`
No explanations before or after.
If impossible, output ONLY: IMPOSSIBLE: <one-line reason></sys>`

// The oracle contract from mother-escalate, verbatim: read-only judgment,
// one JSON object out, never edits.
const JUDGMENT_PREAMBLE = `<sys>You are a read-only judgment oracle. Input: one JSON packet {t,act,q,c,ctx,r}.
Read every ctx.f pointer and every spec:/diff: fact in ctx.d from the working
tree before answering — the packet carries pointers so you do the legwork.
Never edit, write, or commit anything.
Reply with exactly one JSON object, no prose outside it:
- act ask -> {"a":"...","why":"..."} ; a matches r.out: decision = one line,
  design = structure sketch, patch = code sketch the caller applies.
  If tried:/failed: pairs are present, the caller failed twice the same way —
  diagnose why the attempts failed before proposing a third path; never
  re-suggest a tried approach.
- act review -> judge the diff against the spec on five axes: correctness,
  spec fit, security, architecture, simplicity. Examine every changed hunk on
  each axis. {"v":"PASS"} only when no axis fires; otherwise
  {"v":"ISSUES","i":[["R|Y|G","path#L","one-line finding"]]} — R blocking,
  Y important, G nice-to-have; dedupe to the most specific finding.
- Question hinges on product intent (what SHOULD it do)? -> {"q":"..."} instead
  of guessing.
- Bad pointer, unreadable diff, spec too thin to judge -> {"fail":"reason"} —
  never fill gaps with assumptions.</sys>`

export function buildPrompt(ucp: UCP, chunks: CodeChunk[]): string {
  const preamble = ucp.act === 'work' ? WORK_PREAMBLE : JUDGMENT_PREAMBLE
  const parts: string[] = [preamble]

  parts.push(`<ucp>${JSON.stringify(ucp)}</ucp>`)

  if (chunks.length > 0) {
    parts.push('<ctx>')
    for (const c of chunks) {
      parts.push(`### ${c.file}`)
      parts.push(`${c.kind} ${c.name} (L${c.startLine}-L${c.endLine}) score:${(c.score ?? 0).toFixed(2)}`)
      const body = c.source.length > 600 ? c.source.slice(0, 600) + '\n// ...' : c.source
      parts.push(body)
      parts.push('')
    }
    parts.push('</ctx>')
  }

  return parts.join('\n')
}
