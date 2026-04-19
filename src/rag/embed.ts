import { embeddingBaseUrl, type AppConfig } from '../config.js'

type EmbeddingsResponse = {
  data: Array<{ embedding: number[]; index: number }>
}

export async function embedTexts(
  config: AppConfig,
  inputs: string[]
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const base = embeddingBaseUrl(config)
  const url = `${base.replace(/\/$/, '')}/embeddings`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.OPENAI_EMBEDDING_MODEL,
      input: inputs
    })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`embeddings HTTP ${res.status}: ${t}`)
  }
  const data = (await res.json()) as EmbeddingsResponse
  const sorted = [...data.data].sort((a, b) => a.index - b.index)
  return sorted.map((d) => d.embedding)
}

export async function embedQuery(config: AppConfig, text: string): Promise<number[]> {
  const [vec] = await embedTexts(config, [text])
  return vec
}
