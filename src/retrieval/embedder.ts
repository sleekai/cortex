import { type CodeChunk, type ChunkScore } from '../core/types.js'

function tokenize(text: string): string[] {
  const cleaned = text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/['"`][^'"`]*['"`]/g, '')
  return cleaned
    .toLowerCase()
    .split(/[^a-zA-Z0-9_$#]+/)
    .filter(t => t.length > 1)
}

function buildTermFreq(terms: string[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const t of terms) {
    freq.set(t, (freq.get(t) ?? 0) + 1)
  }
  return freq
}

class CorpusIndex {
  private docFreq = new Map<string, number>()
  private docTerms: Map<string, number>[] = []
  private totalDocs = 0

  addDocument(chunk: CodeChunk): number {
    const docId = this.totalDocs++
    const terms = tokenize(`${chunk.name} ${chunk.signature} ${chunk.source.slice(0, 200)}`)
    const seen = new Set<string>()
    for (const t of terms) {
      if (!seen.has(t)) {
        this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1)
        seen.add(t)
      }
    }
    this.docTerms[docId] = buildTermFreq(terms)
    return docId
  }

  scoreChunks(query: string, chunks: CodeChunk[]): Map<number, ChunkScore> {
    const qTerms = tokenize(query)
    const scores = new Map<number, ChunkScore>()

    for (let i = 0; i < chunks.length; i++) {
      const tf = this.docTerms[i]
      if (!tf) continue
      let score = 0
      for (const qt of qTerms) {
        const termFreq = tf.get(qt) ?? 0
        if (termFreq > 0) {
          const idf = Math.log((this.totalDocs + 1) / ((this.docFreq.get(qt) ?? 0) + 1))
          score += termFreq * idf
        }
      }
      scores.set(i, score)
    }
    return scores
  }
}

export function rankChunks(chunks: CodeChunk[], goal: string): CodeChunk[] {
  if (chunks.length === 0) return []

  const index = new CorpusIndex()
  for (const c of chunks) {
    index.addDocument(c)
  }

  const scores = index.scoreChunks(goal, chunks)
  const ranked = chunks
    .map((c, i) => ({ chunk: c, score: scores.get(i) ?? 0 }))
    .sort((a, b) => b.score - a.score)

  const maxScore = ranked[0]!.score
  return ranked.map(({ chunk, score }) => {
    chunk.score = maxScore > 0 ? score / maxScore : 0
    return chunk
  })
}
