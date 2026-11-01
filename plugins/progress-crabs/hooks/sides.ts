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

// Pasted text, closed or cut off: the person's paste, never the app's note.
const PASTED = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>|<pasted_content[^>]*>[\s\S]*$/g
const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g

// The sessions the note names, or null when the text holds no note. The note
// is read only inside a system reminder outside any paste, and runs to the
// first blank line or the reminder's end, so a list spread over lines reads whole.
export const parseLinked = (text: string): Linked[] | null => {
  for (const [, reminder = ''] of text.replace(PASTED, '').matchAll(REMINDER)) {
    const at = reminder.indexOf(NOTE)
    if (at < 0) continue
    const rest = reminder.slice(at + NOTE.length)
    const end = rest.search(/\n\s*\n/)
    const body = end < 0 ? rest : rest.slice(0, end)

    return [...body.matchAll(LINKED)].map(m => ({ name: m[1] ?? '', id: m[2] ?? '', state: m[3] ?? '' }))
  }

  return null
}

// A row of the app's list_sessions answer, as far as the mod reads it.
export type FamilyRow = {
  sessionId?: string
  title?: string
  name?: string
  isRunning?: boolean
  isArchived?: boolean
  startedBy?: string
  lastActivityAt?: string
}

// The session that started this chat, when the list says so for certain. The
// list leaves this chat out, so the rows whose starter is not listed are this
// chat's own children; with them and theirs set aside, a single row that no
// one started is the parent. Anything else (siblings, a deeper chain) is
// ambiguous, and no card gets the arrow.
export function parentOf(rows: FamilyRow[]): string | undefined {
  const ids = new Set(rows.map(row => row.sessionId))
  const ours = new Set(rows.filter(row => row.startedBy && !ids.has(row.startedBy)).map(row => row.sessionId))
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (!ours.has(row.sessionId) && row.startedBy && ours.has(row.startedBy)) {
        ours.add(row.sessionId)
        grew = true
      }
    }
  }
  const rest = rows.filter(row => !ours.has(row.sessionId))

  return rest.length === 1 && !rest[0]?.startedBy ? rest[0]?.sessionId : undefined
}

// When an idle session last did anything, by the list's clock; never later than now.
export const idleSince = (row: FamilyRow | undefined, now: number) => {
  const at = row?.lastActivityAt ? Date.parse(row.lastActivityAt) : NaN

  return Number.isFinite(at) ? Math.min(now, at) : undefined
}
