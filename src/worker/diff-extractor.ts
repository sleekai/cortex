export function extractDiff(text: string): string {
  const lines = text.split('\n')
  const diffLines: string[] = []
  let inDiff = false

  for (const line of lines) {
    if (line.startsWith('```diff') || line.trim() === '```diff') {
      inDiff = true
      continue
    }
    if (line.startsWith('```') && inDiff) {
      inDiff = false
      continue
    }
    if (inDiff) {
      diffLines.push(line)
    }
  }

  if (diffLines.length === 0) {
    const altDiff = text.match(/^--- a\/.*$/m)
    if (altDiff) {
      const idx = text.indexOf(altDiff[0])
      return text.slice(idx).replace(/```$/m, '').trim()
    }
  }

  return diffLines.join('\n').trim()
}

export function extractReasoning(text: string): string {
  const lines = text.split('\n')
  const beforeDiff: string[] = []
  for (const line of lines) {
    if (line.startsWith('```diff') || line.startsWith('--- a/')) break
    if (!line.startsWith('<') && !line.startsWith('```')) {
      beforeDiff.push(line)
    }
  }
  return beforeDiff.join(' ').trim().slice(0, 200)
}
