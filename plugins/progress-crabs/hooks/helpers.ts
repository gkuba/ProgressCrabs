// Helpers: the subagents this chat starts. Their loops' events carry an
// `agentId`; these are the pure parts of following them.

import type { Helper, HelperBar } from '../types'

export const isRunning = (h: Helper) => h.status === 'working'

// A spawn the mod saw, or one it met first through a tool call.
export const spawned = (id: string, description: string, type: string, now: number, parentId?: string): Helper => ({
  id,
  description: description || type || 'helper',
  type,
  parentId,
  status: 'working',
  calls: 0,
  startedAt: now,
})

export const upsert = (list: readonly Helper[], id: string, fn: (h: Helper) => Helper) =>
  list.map(h => (h.id === id ? fn(h) : h))

// Parents before their children, each in start order; a helper whose parent is
// gone sits at the top. `depth` is how far in it nests.
export function treeOrder(list: readonly Helper[]): { helper: Helper; depth: number }[] {
  const ids = new Set(list.map(h => h.id))
  const kids = (parent: string | undefined) =>
    list.filter(h => (parent === undefined ? !h.parentId || !ids.has(h.parentId) : h.parentId === parent)).sort((a, b) => a.startedAt - b.startedAt)
  const out: { helper: Helper; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const helper of kids(parent)) {
      if (out.some(o => o.helper.id === helper.id)) continue
      out.push({ helper, depth })
      walk(helper.id, depth + 1)
    }
  }
  walk(undefined, 0)

  return out
}

// A progress report inside a shell command: the `-n NAME` and the value of a
// `"$CLAUDE_PROGRESS_SH"` call (`17/240`, `42%`, `-t 500`, `+1`, `done`,
// `fail`). The first such call in the command wins; null when there is none.
const CALL = /\$\{?CLAUDE_PROGRESS_SH\}?"?\s+((?:[^\s;&|'"]+|"[^"]*"|'[^']*')(?:\s+(?:[^\s;&|'"]+|"[^"]*"|'[^']*'))*)/

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')

export function parseProgress(command: string, was?: HelperBar): HelperBar | null {
  const m = CALL.exec(command)
  if (!m?.[1]) return null
  const words = (m[1].match(/[^\s'"]+|"[^"]*"|'[^']*'/g) ?? []).map(unquote)
  let name: string | undefined
  let total: number | undefined
  let value: string | undefined
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (w === '-n') name = words[++i]
    else if (w === '-t') total = Number(words[++i])
    else if (!w.startsWith('-') || /^-?\d/.test(w)) {
      value = w
      break
    }
  }
  if (!name) return null
  const prior = was && was.name === name ? was : undefined
  const bar: HelperBar = { name, done: prior?.done ?? 0, total: total ?? prior?.total }
  if (value === undefined) return total !== undefined ? bar : null
  const count = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value)
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(value)
  const step = /^\+(\d+)$/.exec(value)
  if (count) return { name, done: Number(count[1]), total: Number(count[2]) }
  if (pct) return { name, done: Number(pct[1]), total: 100, isPercent: true }
  if (step) return { ...bar, done: bar.done + Number(step[1]) }
  if (value === 'done') return { ...bar, done: bar.total ?? bar.done, isOver: true }
  if (value === 'fail') return { ...bar, isOver: true, isFailed: true }

  return bar
}

// `frames 96/240`, `copy 42%`, or the name alone while the total is unknown.
export const barLabel = (b: HelperBar) =>
  b.isPercent ? `${b.name} ${b.done}%` : b.total ? `${b.name} ${b.done}/${b.total}` : `${b.name} ${b.done}`

export const barFraction = (b: HelperBar) => (b.total ? Math.max(0, Math.min(1, b.done / b.total)) : 0)

// The card's second line: type, current tool, tool calls.
export const helperLine = (h: Helper) =>
  [
    h.type,
    h.status === 'working' ? h.tool : undefined,
    h.calls > 0 ? `${h.calls} tool call${h.calls === 1 ? '' : 's'}` : undefined,
    h.status === 'failed' ? 'stopped' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

// A thin bar under a helper's card.
export const miniBarSvg = (track: string, fill: string, W: number, fraction: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="4"><rect x="0" y="0" width="${W}" height="4" rx="2" fill="${track}" fill-opacity="0.5"/><rect x="0" y="0" width="${(W * fraction).toFixed(1)}" height="4" rx="2" fill="${fill}"/></svg>`
