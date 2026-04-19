export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return dot / denom
}

export type Scored<T> = { score: number; value: T }

export function topKCosine<T>(
  query: number[],
  rows: Array<{ embedding: number[]; value: T }>,
  k: number
): Scored<T>[] {
  const scored: Scored<T>[] = rows.map((r) => ({
    score: cosineSimilarity(query, r.embedding),
    value: r.value
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}
