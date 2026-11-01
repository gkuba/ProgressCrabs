// Reading the app's words about linked sessions: its "Linked sessions now"
// note, and the text its session tools answer with.

export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(block => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
    .join('\n')
}

// An MCP tool's answer as text, however the result wraps it.
export const resultText = (r: unknown): string => {
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return textOf(r)
  if (r && typeof r === 'object' && 'content' in r) return resultText((r as { content: unknown }).content)

  return ''
}

// The first line of the session's latest answer, markdown stripped.
export const latestStep = (transcript: string): string | undefined => {
  const at = transcript.lastIndexOf('[assistant]')
  if (at < 0) return undefined
  const line = transcript
    .slice(at + '[assistant]'.length)
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)

  return line
    ?.replace(/\*\*|`/g, '')
    .replace(/^(?:#{1,6}|>|[-*]|\d+\.)\s+/, '')
    .trim() || undefined
}

const NOTE = 'Linked sessions now'
// `name = local_<id> (state)`; a name may hold spaces, never `:`, `,` or `=`.
const LINKED = /([\w.-]+(?: [\w.-]+)*) = (local_[0-9a-f-]+) \(([^)]+)\)/g

export type Linked = { name: string; id: string; state: string }

// The sessions the note names, or null when the text holds no note. The note
// runs to the first blank line or the end of its reminder, so a list spread
// over lines reads whole.
export const parseLinked = (text: string): Linked[] | null => {
  const at = text.indexOf(NOTE)
  if (at < 0) return null
  const rest = text.slice(at + NOTE.length)
  const end = rest.search(/\n\s*\n|<\/system-reminder>/)
  const body = end < 0 ? rest : rest.slice(0, end)

  return [...body.matchAll(LINKED)].map(m => ({ name: m[1] ?? '', id: m[2] ?? '', state: m[3] ?? '' }))
}
