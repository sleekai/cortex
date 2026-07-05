export function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  for (let end = text.length; end > start; end--) {
    if (text[end - 1] !== '}') continue
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end))
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      /* keep shrinking */
    }
  }
  return null
}
