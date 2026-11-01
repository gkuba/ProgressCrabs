// The task list as the app's task-list tool shapes it, and its timing.

import type { Step } from '../types'

export type PlanArgs = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: boolean
  done?: number[]
  start?: number
}

const toStatus = (s: unknown): Step['status'] =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

// The earlier step a new item carries its times from: the one at the same
// place with the same name, else the first unclaimed one with that name, so
// two steps of one name never share a start.
const carryOver = (list: Step[], content: string, at: number, claimed: Set<number>) => {
  const index = list[at]?.content === content && !claimed.has(at)
    ? at
    : list.findIndex((step, i) => step.content === content && !claimed.has(i))
  if (index < 0) return undefined
  claimed.add(index)

  return list[index]
}

// Mirrors the app's own task-list semantics: items replace, advance completes
// the running step and starts the next pending one, done/start are 1-based.
export const applyPlan = (list: Step[], args: PlanArgs, now: number): Step[] => {
  const claimed = new Set<number>()
  const next: Step[] = Array.isArray(args.items)
    ? args.items.map((item, i) => {
        const content = String(item?.content ?? '')
        const status = toStatus(item?.status)
        const was = carryOver(list, content, i, claimed)
        // A finished step that runs again starts its clock over.
        const isRerun = was?.status === 'completed' && status === 'in_progress'

        return isRerun || !was ? { content, status } : { ...was, content, status }
      })
    : list.map(step => ({ ...step }))

  if (args.advance) {
    const running = next.findIndex(step => step.status === 'in_progress')
    const current = next[running]
    if (current) current.status = 'completed'
    const pending = next.find((step, i) => i > running && step.status === 'pending')
    if (pending) pending.status = 'in_progress'
  }
  for (const n of Array.isArray(args.done) ? args.done : []) {
    const step = next[n - 1]
    if (step) step.status = 'completed'
  }
  const started = typeof args.start === 'number' ? next[args.start - 1] : undefined
  if (started) started.status = 'in_progress'

  return stamp(next, now)
}

export const stamp = (list: Step[], now: number): Step[] =>
  list.map(step => {
    if (step.status === 'in_progress') return { ...step, startedAt: step.startedAt ?? now, finishedAt: undefined }
    if (step.status === 'completed') return { ...step, startedAt: step.startedAt ?? now, finishedAt: step.finishedAt ?? now }

    return { content: step.content, status: step.status }
  })

// wrap_up checks off the whole list, steps never advanced to included.
export const completeAll = (list: Step[], now: number): Step[] =>
  stamp(list.map(step => (step.status === 'completed' ? step : { ...step, status: 'completed' as const })), now)

export const formatSpan = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// How much each newer step's span moves the estimate.
const RECENT_WEIGHT = 0.4
// Step times whose spread passes this share of their mean give no estimate.
const MAX_SPREAD = 1
const SPREAD_OF = 4

// Elapsed time of the running step, and an estimate of what is left from the
// steps that ran for a measured time, the latest weighing most. No estimate
// until two steps were timed, nor while their times spread too wide to guess from.
export const timing = (list: Step[], now: number) => {
  const current = list.find(step => step.status === 'in_progress')
  const elapsed = current?.startedAt !== undefined ? Math.max(0, now - current.startedAt) : null
  const spans = list
    .filter(step => step.status === 'completed' && step.startedAt !== undefined && step.finishedAt !== undefined)
    .sort((a, b) => (a.finishedAt as number) - (b.finishedAt as number))
    .map(step => (step.finishedAt as number) - (step.startedAt as number))
    .filter(span => span > 1000)
  const [first, ...later] = spans
  if (first === undefined || later.length === 0) return { elapsed, left: null }
  // The spread of the latest few, so one slow step early on stops counting.
  const recent = spans.slice(-SPREAD_OF)
  const mean = recent.reduce((sum, span) => sum + span, 0) / recent.length
  const spread = Math.sqrt(recent.reduce((sum, span) => sum + (span - mean) ** 2, 0) / recent.length)
  if (spread > MAX_SPREAD * mean) return { elapsed, left: null }

  const average = later.reduce((avg, span) => RECENT_WEIGHT * span + (1 - RECENT_WEIGHT) * avg, first)
  const pending = list.filter(step => step.status === 'pending').length
  const left = pending * average + (current ? Math.max(0, average - (elapsed ?? 0)) : 0)

  return { elapsed, left: pending || current ? left : null }
}

// How long a whole list took, first start to last finish.
export const listSpan = (list: Step[]) => {
  const starts = list.flatMap(step => (step.startedAt === undefined ? [] : [step.startedAt]))
  const ends = list.flatMap(step => (step.finishedAt === undefined ? [] : [step.finishedAt]))

  return starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : null
}

// The bar's cells for done, running, up next and the rest, summing to `cells`
// exactly: the running and next steps keep a cell each while there is room.
export const barCells = (cells: number, total: number, done: number, running: number, upNext: number) => {
  if (total === 0 || cells <= 0) return { done: 0, run: 0, next: 0, rest: Math.max(0, cells) }
  const at = (n: number) => Math.round((n / total) * cells)
  const reserve = (running ? 1 : 0) + (upNext ? 1 : 0)
  const a = Math.min(at(done), Math.max(0, cells - reserve))
  const b = Math.min(cells, Math.max(a + (running ? 1 : 0), at(done + running)))
  const c = Math.min(cells, Math.max(b + (upNext ? 1 : 0), at(done + running + upNext)))

  return { done: a, run: b - a, next: c - b, rest: cells - c }
}
