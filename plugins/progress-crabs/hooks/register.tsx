import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Activity, Helper, Side, Step } from '../types'
import { CARD_H, MOOD, byUrgency, cardSvg, moodColor, moodOf } from './crabs'
import { applyPlan, barCells, completeAll, formatSpan, listSpan, replay, stepEstimate, timing } from './plan'
import type { PlanArgs } from './plan'
import { idleSince, latestStep, parentOf, parseLinked, resultText, textOf } from './sides'
import type { FamilyRow } from './sides'
import { barFraction, barLabel, helperLine, isRunning, miniBarSvg, parseProgress, spawned, treeOrder, upsert } from './helpers'
import { BAR_H, FLASH_MS, runsOf, stepBars, stepCells, stepSvg } from './tasks'
import { DEFAULT_THEME, THEMES, isTheme, paletteOf } from './themes'
import type { Overrides, Palette } from './themes'

const PLUGIN = 'progress-crabs'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const steps = atom({ plugin: 'progress-crabs', key: 'steps' } as const, [], { shape: 'steps-2' })
const sides = atom({ plugin: 'progress-crabs', key: 'sides' } as const, [], { shape: 'sides-2' })
const activity = atom({ plugin: 'progress-crabs', key: 'activity' } as const, null as Activity | null, { shape: 'activity-1' })
// The subagents this chat started, until the person's next prompt clears the finished ones.
const helpers = atom({ plugin: 'progress-crabs', key: 'helpers' } as const, [] as Helper[], { shape: 'helpers-1' })
const isHidden = atom({ plugin: 'progress-crabs', key: 'isHidden' } as const, false)
// The theme `/progress theme` picked; null falls back to the settings' theme.
const themeName = atom({ plugin: 'progress-crabs', key: 'theme' } as const, null as string | null)
// Set once the person closes the Crab Tasks pane, so side sessions stop opening it by itself.
const isPaneDismissed = atom({ plugin: 'progress-crabs', key: 'isPaneDismissed' } as const, false)
// Ticks while something works, and once a minute while side sessions sit idle,
// so elapsed times redraw on their own.
const clockNow = atom({ plugin: 'progress-crabs', key: 'now' } as const, 0)
// Set while a background read of the session tools would put up a permission dialog.
const needsAllow = atom({ plugin: 'progress-crabs', key: 'needsAllow' } as const, false)
// Turns started since the task list last changed; an old list draws dimmed.
const planAge = atom({ plugin: 'progress-crabs', key: 'planAge' } as const, 0)
const STALE_TURNS = 3
// Set when a turn is stopped with a step still running and no wrap-up; the next
// task-list update clears it.
const isInterrupted = atom({ plugin: 'progress-crabs', key: 'isInterrupted' } as const, false)
const TICK_MS = 5_000
// The family is read this often while one of it works, and less often while all sit idle.
const FAMILY_FAST_MS = 10_000
const FAMILY_SLOW_MS = 60_000
// Under this many cells, or with fewer rows than the full band needs, it folds into one row.
const COMPACT_COLUMNS = 40

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

// A full-width pill: solid purple for finished steps, pink for the running one,
// orange for the one up next, the rest an empty track. Percent lengths let the
// frame's own width decide the size.
// `isFlash`: the list just finished, so the done fill blinks bright once and settles green.
const pillSvg = (P: Palette, height: number, total: number, done: number, running: number, upNext: number, isFlash = false) => {
  const doneFill = done === total ? P.green : P.purple
  const r = height / 2
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`
  const seg = (n: number, fill: string, cls = '') =>
    n > 0 ? `<rect${cls ? ` class="${cls}"` : ''} x="0" y="0" width="${pct(n)}" height="${height}" rx="${r}" fill="${fill}"/>` : ''
  const flash = isFlash
    ? `<style>@keyframes f{0%{fill:${P.purple}}35%{fill:${P.fg}}100%{fill:${P.green}}}.f{animation:f ${FLASH_MS}ms ease-out forwards}@media (prefers-reduced-motion: reduce){.f{animation:none}}</style>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">${flash}
<rect x="0" y="0" width="100%" height="${height}" rx="${r}" fill="${P.comment}" fill-opacity="0.3"/>
${seg(done + running + upNext, P.orange)}
${seg(done + running, P.pink)}
${seg(done, doneFill, isFlash ? 'f' : '')}
</svg>`
}

const ACTIVITY = {
  thinking: { label: 'thinking', role: 'pink' },
  writing: { label: 'writing', role: 'purple' },
  tool: { label: 'running', role: 'orange' },
} as const

// `mcp__server__tool` reads as `tool`.
const shortTool = (name: string) => name.split('__').pop() ?? name

// What the main loop is doing, for the working row. `isTurnSure` is false
// for a tool call, which may come from outside a turn: it changes a mode but
// never starts one, so a stray call cannot leave the band "working".
async function setMode($: EngineInterface, mode: Activity['mode'], tool?: string, isTurnSure = true) {
  const now = await $.clock.now()
  await update($, activity, was =>
    !was && !isTurnSure
      ? was
      : was && was.mode === mode && was.tool === tool
        ? was
        : { mode, tool, since: was?.since ?? now },
  )
}

const sideColor = (P: Palette, state: string) => moodColor(P, moodOf(state))

const LIST_TOOL = 'mcp__ccd_session_mgmt__list_sessions'
const EVENTS_TOOL = 'mcp__ccd_session_mgmt__list_events'
const OPEN_TOOL = 'mcp__ccd_window__open_session_in'

// A call of the app's session tools. One the decision leaves to the person is
// made only when the person asked (/crabs, the panel's Allow button), never from
// a timer: the band says so instead of putting a dialog up unasked.
async function quietCall($: EngineInterface, tool: string, args: Record<string, unknown>, mayAsk = false) {
  const { decision } = await $.tool.check({ tool, input: args })
  if (decision === 'deny') throw new Error(`${tool}: deny`)
  if (decision === 'ask' && !mayAsk) {
    await update($, needsAllow, () => true)
    throw new Error(`${tool}: ask`)
  }
  const ran = await $.tool.call({ tool, ...args } as never)
  await update($, needsAllow, () => false)

  return resultText('result' in ran ? ran.result : '')
}

// The note's parse, read only from what the app or a plugin appended: never a
// prompt the person typed or pasted, a tool's result or the model's own words.
const isFromApp = (origin: { kind: string } | undefined) => !['composer', 'model', 'tool'].includes(origin?.kind ?? '')

// One tab for the task list, one bar per step, with the side sessions' crabs
// below it, beside the other mods' panes.
const PANE = 'task-list'
const PANE_TITLE = 'Crab Tasks'

async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    await update($, isPaneDismissed, () => true)

    return false
  }
  await update($, isPaneDismissed, () => false)
  await $.ui.open({ id: PANE, title: PANE_TITLE })

  return true
}

// Shows the pane, or brings it to the front; never closes it. The band's
// details button uses this: panes() also lists a pane that sits as a tab in
// the sidebar out of view, so a toggle there would close it.
async function showPane($: EngineInterface) {
  await update($, isPaneDismissed, () => false)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// Opens the pane the first time a side session appears, unless the person closed it.
async function openPaneOnce($: EngineInterface) {
  if (!(await read($, isPaneDismissed))) await $.ui.open({ id: PANE, title: PANE_TITLE })
}

// The colours to draw with: the picked theme, else the settings' one, with the settings' overrides on top.
async function paletteNow($: EngineInterface, fallback: string, over: Overrides) {
  return paletteOf((await read($, themeName)) ?? fallback, over)
}

// Picks a theme, or the settings' one for null.
async function setTheme($: EngineInterface, name: string | null) {
  if (name === null) await $.store.delete('theme')
  else await $.store.set('theme', name)
  await update($, themeName, () => name)
}

const THEME_PANE = 'themes'

// The list the transcript's own calls built, once per conversation, for a
// session joined late (a restart, a resume) whose list the atoms lost.
let isRebuilt = false
async function rebuild($: EngineInterface) {
  if (isRebuilt) return
  isRebuilt = true
  if ((await read($, steps)).length > 0) return
  const now = await $.clock.now()
  const found = replay(await Promise.resolve().then(() => $.session.messages()).catch(() => []), now, PLAN_TOOL, WRAP_TOOL)
  if (found.length > 0) await update($, steps, was => (was.length === 0 ? found : was))
}

// A finished step flashes green for a moment; one redraw after puts it back.
const redrawAfterFlash = ($: EngineInterface) =>
  $.clock.after(FLASH_MS + 100, () => {
    void $.clock.now().then(now => update($, clockNow, () => now)).catch(() => undefined)
  })

const themeList = (current: string) =>
  Object.keys(THEMES)
    .map(name => `${name === current ? '▸' : ' '} ${name}`)
    .join('\n')

// Whether the family has been read once; until then each tick tries again
// (the app's tools may connect after the session starts).
let isFamilyRead = false
// When the last family read began, for the timer's pace.
let lastFamilyAt = 0
// One read at a time, so two never toast the same finish; asks made while one
// runs fold into a single read after it.
let queued: Set<string> | null = null
let queuedAsk = false
let running: Promise<void> | null = null
const resetFamily = () => {
  isFamilyRead = false
  lastFamilyAt = 0
}

// The linked family as the app lists it: titles for every session, and the
// sessions the "Linked sessions now" note leaves out (the one that started
// this chat, and sessions further down), with their running state. Then the
// latest step of the ones named, or of any whose state changed.
async function readFamily($: EngineInterface, stepsOf: string[], mayAsk = false) {
  let rows: FamilyRow[] | null = null
  lastFamilyAt = await $.clock.now()
  try {
    const parsed: unknown = JSON.parse((await quietCall($, LIST_TOOL, { linked: true }, mayAsk)) || '[]')
    rows = Array.isArray(parsed) ? (parsed as FamilyRow[]).filter(row => row.sessionId && !row.isArchived) : []
    isFamilyRead = true
  } catch {
    // The panel falls back to the short names and the note's sessions.
  }
  const now = await $.clock.now()
  const before = await read($, sides)
  const rowOf = new Map((rows ?? []).map(row => [row.sessionId as string, row]))
  // A good read drops the note's sessions it no longer lists (archived, ended).
  const fromNote = before.filter(side => !side.isListed && (rows === null || rowOf.has(side.id)))
  const parent = rows === null ? undefined : parentOf(rows)
  // A failed read keeps the cards it had rather than dropping them.
  const listed: Side[] = rows === null
    ? before.filter(side => side.isListed)
    : rows
        .filter(row => !fromNote.some(side => side.id === row.sessionId))
        .map(row => {
          const id = row.sessionId as string
          const was = before.find(side => side.id === id)
          const state = row.isRunning ? 'working' : 'idle'

          return {
            ...was,
            id,
            name: row.name ?? row.title ?? 'session',
            title: row.title ?? was?.title,
            state,
            isListed: true,
            isParent: id === parent,
            since: was && was.state === state ? was.since : now,
          }
        })
  for (const side of listed) {
    const was = before.find(b => b.id === side.id)
    if (was && moodOf(was.state) === 'working' && side.state === 'idle') $.ui.toast(`🦀 ${side.title ?? side.name} finished a turn`)
  }
  const changed = listed.filter(side => before.find(b => b.id === side.id)?.state !== side.state).map(side => side.id)
  const found = new Map<string, string>()
  for (const id of new Set([...stepsOf, ...changed])) {
    try {
      const step = latestStep(await quietCall($, EVENTS_TOOL, { session_id: id, limit: 3 }))
      if (step) found.set(id, step)
    } catch {
      // Left without a step.
    }
  }
  const titles = new Map((rows ?? []).filter(row => row.sessionId && row.title).map(row => [row.sessionId as string, row.title as string]))
  // A note's session that arrived during the read stays; the list has not seen it yet.
  const isKept = (side: Side) => rows === null || rowOf.has(side.id) || !before.some(b => b.id === side.id)
  const merged = await update($, sides, list =>
    [...list.filter(side => !side.isListed && isKept(side)), ...listed].map(side => {
      // An idle session's time counts from its last activity, not from when the mod first saw it.
      const quietSince = moodOf(side.state) === 'working' || moodOf(side.state) === 'waiting' ? undefined : idleSince(rowOf.get(side.id), now)

      return {
        ...side,
        title: titles.get(side.id) ?? side.title,
        step: found.get(side.id) ?? side.step,
        since: quietSince ?? side.since,
      }
    }),
  )
  if (before.length === 0 && merged.length > 0) await openPaneOnce($)
}

function refreshSides($: EngineInterface, stepsOf: string[], mayAsk = false) {
  queued = new Set([...(queued ?? []), ...stepsOf])
  queuedAsk ||= mayAsk
  if (!running) running = drainFamily($).finally(() => { running = null })

  return running
}

async function drainFamily($: EngineInterface) {
  while (queued) {
    const ids = [...queued]
    const ask = queuedAsk
    queued = null
    queuedAsk = false
    await readFamily($, ids, ask).catch(() => undefined)
  }
}

// Agent ids that are no helper of ours (a compaction's fork, a workflow's
// agents): `$.agent.list()` names none of them, so they are asked about once.
const notHelpers = new Set<string>()

// Whether this agent id is a helper the mod follows. One met first through a
// tool call (the mod reloaded mid-run) is added from the engine's list.
async function knownHelper($: EngineInterface, id: string) {
  if ((await read($, helpers)).some(h => h.id === id)) return true
  if (notHelpers.has(id)) return false
  const info = (await $.agent.list().catch(() => [])).find(a => a.id === id)
  if (!info) {
    notHelpers.add(id)
    return false
  }
  const now = await $.clock.now()
  await update($, helpers, list => (list.some(h => h.id === id) ? list : [...list, spawned(id, info.description, info.type, now, info.parentId)]))

  return true
}

const helperMood = (h: Helper) => (h.status === 'working' ? 'working' : h.status === 'done' ? 'done' : 'idle') as 'working' | 'done' | 'idle'

const USAGE = [
  '/progress            show or hide the band',
  '/progress show|hide  show or hide it',
  '/progress list       open or close the Crab Tasks pane (also /crabs)',
  '/progress clear      drop the task list',
  '/progress theme      list the colour themes',
  '/progress theme <name>|default',
].join('\n')

export const register: Register = (on, options) => {
  const fromSettings = isTheme(options.theme) ? options.theme : DEFAULT_THEME
  const over: Overrides = {
    done: String(options.done_color ?? ''),
    current: String(options.current_color ?? ''),
    next: String(options.next_color ?? ''),
    crab: String(options.crab_color ?? ''),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Show or hide the task progress band; `theme` lists or switches colour themes',
      argumentHint: '[show|hide|list|clear|theme [name|default]]',
    })
    await $.command.register({
      name: 'crabs',
      description: 'Show or hide the Crab Tasks pane with the side sessions',
    })
    // A theme picked with /progress lasts until the settings' theme changes.
    const settingsWas = await $.store.get('settingsTheme').catch(() => undefined)
    if (settingsWas !== undefined && settingsWas !== fromSettings) await $.store.delete('theme').catch(() => undefined)
    if (settingsWas !== fromSettings) await $.store.set('settingsTheme', fromSettings).catch(() => undefined)
    const saved = await $.store.get('theme').catch(() => undefined)
    await update($, themeName, () => (isTheme(saved) ? saved : null))
    // The family the note leaves out (this chat's parent above all) is read
    // from the app's list: now, then every 10 seconds while one of it works and
    // every minute while all sit idle, or until a first read goes through.
    void refreshSides($, [])
    $.clock.every(FAMILY_FAST_MS, async () => {
      const linked = await read($, sides)
      if (isFamilyRead && linked.length === 0) return
      const pace = linked.some(side => moodOf(side.state) === 'working') ? FAMILY_FAST_MS : FAMILY_SLOW_MS
      if (!isFamilyRead || (await $.clock.now()) - lastFamilyAt >= pace - 1_000) await refreshSides($, [])
    })
    const startedAt = await $.clock.now()
    await update($, clockNow, () => startedAt)
    await rebuild($).catch(() => undefined)
    $.clock.every(TICK_MS, async () => {
      const list = await read($, steps)
      const linked = await read($, sides)
      const now = await $.clock.now()
      const was = await read($, clockNow)
      const isBusy =
        (await read($, activity)) !== null ||
        (list.some(step => step.status === 'in_progress') && !(await read($, isInterrupted))) ||
        linked.some(side => moodOf(side.state) === 'working') ||
        (await read($, helpers)).some(isRunning)
      const isNewMinute = linked.length > 0 && Math.floor(now / 60_000) !== Math.floor(was / 60_000)
      if (isBusy || isNewMinute) await update($, clockNow, () => now)
    })

    return next(e)
  })

  // A /clear starts a new conversation in the same process: its task list and
  // family are not this one's.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, steps, () => [])
      await update($, planAge, () => 0)
      await update($, isInterrupted, () => false)
      isRebuilt = false
      await update($, sides, () => [])
      await update($, activity, () => null)
      await update($, helpers, () => [])
      resetFamily()
    }

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const [verb = '', name] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'theme' || verb === 'themes') {
      if (!name) {
        const current = (await read($, themeName)) ?? fromSettings
        // The panel draws each theme's colours; picking one there switches at once.
        await $.ui.open({ id: THEME_PANE, title: 'Themes' })
        return { text: `Themes (▸ current):\n${themeList(current)}\n\nThe Themes panel shows their colours. /progress theme <name> to switch, /progress theme default for the settings' theme.` }
      }
      if (name === 'default' || name === 'reset') {
        await setTheme($, null)
        return { text: `Theme back to the settings' theme: ${fromSettings}.` }
      }
      if (!isTheme(name)) return { text: `No theme "${name}". Themes:\n${themeList('')}` }
      await setTheme($, name)
      return { text: `Theme: ${name}. Changing the theme in the settings replaces it.` }
    }
    if (verb === 'list' || verb === 'tasks') {
      const isOpen = await togglePane($).catch(() => null)
      return { text: isOpen === null ? 'The Crab Tasks pane cannot open here.' : isOpen ? 'Crab Tasks pane open.' : 'Crab Tasks pane closed.' }
    }
    if (verb === 'clear') {
      await update($, steps, () => [])
      await update($, planAge, () => 0)
      await update($, isInterrupted, () => false)
      return { text: 'Task list cleared from the band.' }
    }
    if (verb !== '' && !['show', 'on', 'hide', 'off'].includes(verb)) return { text: `Unknown "${verb}". Usage:\n${USAGE}` }

    const hidden = await update($, isHidden, was => (verb === '' ? !was : verb === 'hide' || verb === 'off'))

    return { text: hidden ? 'Task progress band hidden. Run /progress to show it again.' : 'Task progress band shown.' }
  })

  on('command.run', { command: 'crabs' }, async $ => {
    const isOpen = await togglePane($)
    // The person's own ask, so the read may put the permission dialog up.
    if (isOpen) void refreshSides($, [], true)

    return { text: isOpen ? 'Crab Tasks pane open.' : 'Crab Tasks pane closed.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isPaneDismissed, () => true)

    return next(e)
  })

  const wentThrough = (ran: object) => !('deny' in ran && ran.deny) && !('isError' in ran && ran.isError)

  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && wentThrough(ran)) {
      const now = await $.clock.now()
      const was = await read($, steps)
      const list = await update($, steps, before => applyPlan(before, e as unknown as PlanArgs, now))
      await update($, planAge, () => 0)
      await update($, clockNow, () => now)
      await update($, isInterrupted, () => false)
      const doneOf = (l: typeof list) => l.filter(step => step.status === 'completed').length
      if (doneOf(list) > doneOf(was)) redrawAfterFlash($)
    }

    return ran
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && wentThrough(ran)) {
      const now = await $.clock.now()
      await update($, steps, list => completeAll(list, now))
      await update($, isInterrupted, () => false)
      redrawAfterFlash($)
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, activity, () => ({ mode: 'thinking', since: now }))
      await update($, clockNow, () => now)
      await rebuild($).catch(() => undefined)
      // A list finished in an earlier turn makes way for the next one.
      const list = await update($, steps, was => (was.length > 0 && was.every(step => step.status === 'completed') ? [] : was))
      await update($, planAge, age => (list.length > 0 ? age + 1 : 0))
      if (!isFamilyRead) void refreshSides($, [])
      // A prompt typed mid-turn can take the band over while it queues; draw it again.
      $.ui.invalidate('ui.render')
    } else if ((await read($, helpers)).some(h => h.id === e.agentId)) {
      await update($, helpers, list => upsert(list, e.agentId as string, h => ({ ...h, status: 'working', finishedAt: undefined })))
    }

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (e.turnId) $.ui.invalidate('ui.render')
    if (e.origin.kind === 'composer' && !('drop' in entered && entered.drop)) await update($, helpers, list => list.filter(isRunning))

    return entered
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    await setMode($, 'thinking')
    const stream = next(e)
    let mode: Activity['mode'] = 'thinking'
    let tool: string | undefined
    while (true) {
      const piece = await stream.next()
      if (piece.done) return piece.value
      const chunk = piece.value
      const now: Activity['mode'] | null =
        chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'writing' : chunk.kind === 'tool' ? 'tool' : null
      const name = chunk.kind === 'tool' ? shortTool(chunk.name) : undefined
      // Written only when the mode or the tool changes, not per streamed piece.
      if (now && (now !== mode || name !== tool)) {
        mode = now
        tool = name
        await setMode($, now, name)
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    // The mod's own background calls are not Claude at work.
    if (next.origin.plugin === PLUGIN) return next(e)
    if (e.agentId) {
      const id = e.agentId
      if (!(await knownHelper($, id))) return next(e)
      const tool = shortTool(e.tool)
      const command = e.tool === 'Bash' ? String((e as { command?: unknown }).command ?? '') : ''
      await update($, helpers, list =>
        upsert(list, id, h => ({ ...h, status: 'working', finishedAt: undefined, tool, calls: h.calls + 1, bar: (command && parseProgress(command, h.bar)) || h.bar })),
      )
      try {
        return await next(e)
      } finally {
        await update($, helpers, list => upsert(list, id, h => (h.tool === tool ? { ...h, tool: undefined } : h)))
      }
    }
    const tool = shortTool(e.tool)
    await setMode($, 'tool', tool, false)
    try {
      return await next(e)
    } finally {
      // Back to thinking, unless a call that ran beside this one took the row.
      await update($, activity, was => (was && was.mode === 'tool' && was.tool === tool ? { ...was, mode: 'thinking' as const, tool: undefined } : was))
    }
  })

  on('turn.complete', async ($, e, next) => {
    // Stopped mid-step with no wrap-up: the running step is marked. The flag is
    // the input's, so it is read before the engine's end step runs.
    if (!e.agentId && e.isAborted && (await read($, steps)).some(step => step.status === 'in_progress')) {
      await update($, isInterrupted, () => true)
    }
    // A helper's loop ending: done, or stopped. Read from the input, like the flag above.
    if (e.agentId && (await read($, helpers)).some(h => h.id === e.agentId)) {
      const now = await $.clock.now()
      await update($, helpers, list =>
        upsert(list, e.agentId as string, h => ({ ...h, status: e.isAborted ? 'failed' : 'done', tool: undefined, finishedAt: now })),
      )
    }
    const done = await next(e)
    if (!e.agentId) await update($, activity, () => null)

    return done
  })

  // A helper starts: the Agent tool's description and type, and who spawned it.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if ('agentId' in ran && ran.agentId && !ran.deny) {
      const id = ran.agentId
      const now = await $.clock.now()
      notHelpers.delete(id)
      await update($, helpers, list =>
        list.some(h => h.id === id)
          ? upsert(list, id, h => ({ ...h, status: 'working', finishedAt: undefined }))
          : [...list, spawned(id, e.description, e.subagentType, now, e.parentAgentId)],
      )
      await update($, clockNow, () => now)
    }

    return ran
  })

  // The app's "Linked sessions now" reminder carries each side session's state.
  on('session.append', async ($, e, next) => {
    const found = !e.agentId && isFromApp(e.origin) ? parseLinked(textOf(e.message.content)) : null
    if (found) {
      const now = await $.clock.now()
      const before = await read($, sides)
      const noted: Side[] = found.map(({ name, id, state }) => {
        const was = before.find(side => side.id === id)

        return { ...was, name, id, state, isListed: false, since: was && was.state === state ? was.since : now }
      })
      await update($, sides, list => [...noted, ...list.filter(side => side.isListed && !noted.some(f => f.id === side.id))])

      // A toast when a session finishes a turn or starts waiting on the person.
      const changed = noted.filter(side => before.find(b => b.id === side.id)?.state !== side.state)
      for (const side of changed) {
        const was = before.find(b => b.id === side.id)
        const mood = moodOf(side.state)
        if (mood === 'waiting') $.ui.toast(`🦀 ${side.title ?? side.name} is waiting on you`)
        else if (was && moodOf(was.state) === 'working') $.ui.toast(`🦀 ${side.title ?? side.name} finished a turn`)
      }
      if (noted.length > 0 && before.length === 0) void openPaneOnce($).catch(() => undefined)
      const stale = noted.filter(side => !side.title || changed.includes(side)).map(side => side.id)
      if (stale.length > 0) void refreshSides($, stale)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, steps)
    const linked = await read($, sides)
    // A turn the mod missed the start of (a reload mid-turn) still reads as working.
    const doing = e.props.isWorking ? ((await read($, activity)) ?? { mode: 'thinking' as const, since: undefined }) : null
    const busyHelpers = (await read($, helpers)).filter(isRunning).length
    if (e.props.hasSurvey || (await read($, isHidden)) || (list.length === 0 && linked.length === 0 && !doing && busyHelpers === 0)) {
      return next(e)
    }

    const P = await paletteNow($, fromSettings, over)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isStopped = await read($, isInterrupted)
    // Another mod's band beneath ours (Simple Progress Bars, say) stacks above it, so
    // neither hides the other. The engine's own answer is left out: ours replaces it.
    const beneath = await next(e).catch(() => null)
    const isTheirs = next.trace.some(link => link.tier !== 'core' && link.outcome === 'returned')
    const stack = (band: RenderElement): RenderElement =>
      isTheirs && beneath ? (
        <Box flexDirection="column">
          {beneath}
          {band}
        </Box>
      ) : band
    const Svg = e.surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
    const total = list.length
    const done = list.filter(step => step.status === 'completed').length
    const running = list.filter(step => step.status === 'in_progress').length
    const current = list.find(step => step.status === 'in_progress')
    const isFinished = total > 0 && done === total
    const age = await read($, planAge)
    // A list no update has touched for a few turns was likely left behind.
    const isStale = !isFinished && age >= STALE_TURNS
    const lastFinish = Math.max(0, ...list.map(step => step.finishedAt ?? 0))
    const isFlash = isFinished && lastFinish > 0 && (await $.clock.now()) - lastFinish < FLASH_MS

    const upNext = running && done + running < total ? 1 : 0
    const clock = await read($, clockNow)
    const { elapsed, left } = timing(list, clock)
    const took = isFinished ? listSpan(list) : null
    const look = doing ? ACTIVITY[doing.mode] : null
    const working = doing && look
      ? [`${look.label}${doing.mode === 'tool' && doing.tool ? ` ${doing.tool}` : ''}`, doing.since !== undefined ? formatSpan(Math.max(0, clock - doing.since)) : null]
          .filter(Boolean)
          .join(' · ')
      : null
    const times = [
      !isFinished && elapsed !== null ? formatSpan(elapsed) : null,
      !isFinished && left !== null ? `~${formatSpan(left)} left` : null,
    ].filter(Boolean)
    const others = byUrgency(linked)
    const doneColor = isFinished ? P.green : P.purple
    const countColor = isFinished ? P.green : isStale ? P.comment : P.purple
    const stepText = isFinished
      ? `✓ all steps done${took ? ` in ${formatSpan(took)}` : ''}`
      : current ? `${isStopped ? '⏸' : '▸'} ${current.content}` : total > 0 ? `${total - done} pending` : null
    const textBar = (cells: number) => {
      const bar = barCells(cells, total, done, running, upNext)

      return (
        <Box flexDirection="row" flexShrink={0}>
          <Text mono color={isFlash ? P.fg : doneColor}>{'█'.repeat(bar.done)}</Text>
          <Text mono color={P.pink}>{'▓'.repeat(bar.run)}</Text>
          <Text mono color={P.orange}>{'▒'.repeat(bar.next)}</Text>
          <Text mono color={P.comment}>{'░'.repeat(bar.rest)}</Text>
        </Box>
      )
    }

    // Short of rows or width, the band folds into one row: a small bar, the
    // count, a dot for the main loop and one for the side sessions, then the step.
    const helperTag = busyHelpers > 0 ? `🦀 ${busyHelpers} helper${busyHelpers === 1 ? '' : 's'}` : null
    const rows = (total > 0 ? 2 : 0) + (working || linked.length > 0 || helperTag ? 1 : 0) + (total === 0 && linked.length > 0 && !working ? 1 : 0)
    const isCompact = (e.props.maxRows > 0 && e.props.maxRows < rows) || e.props.bodyColumns < COMPACT_COLUMNS
    if (isCompact) {
      const urgent = others[0]

      return stack(
        <Box flexDirection="row">
          {total > 0 && textBar(Math.min(10, Math.max(4, Math.floor(e.props.bodyColumns / 6))))}
          {total > 0 && (
            <Box flexShrink={0}>
              <Text bold tabular color={countColor}> {done}/{total} </Text>
            </Box>
          )}
          {working && look && (
            <Box flexShrink={0}>
              <Text color={P[look.role]}>● </Text>
            </Box>
          )}
          {busyHelpers > 0 && (
            <Box flexShrink={0}>
              <Text color={P.orange}>h{busyHelpers} </Text>
            </Box>
          )}
          {urgent && (
            <Box flexShrink={0}>
              <Text color={sideColor(P, urgent.state)}>🦀{linked.length} </Text>
            </Box>
          )}
          <Text wrap="truncate-end" dimColor={isFinished || isStale || !stepText}>{stepText ?? working ?? ''}</Text>
        </Box>
      )
    }

    return stack(
      <Box flexDirection="column" rowGap={0}>
        {total > 0 &&
          (Svg ? (
            <Svg alt={`${done} of ${total} steps done`} height={10} source={pillSvg(P, 10, total, done, running, upNext, isFlash)} />
          ) : (
            textBar(Math.max(1, e.props.bodyColumns))
          ))}
        {(working || linked.length > 0 || helperTag) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {working && look && (
              <Box flexDirection="row">
                <Text color={P[look.role]}>● </Text>
                <Text wrap="truncate-end">{working}</Text>
              </Box>
            )}
            {helperTag && (
              <Box flexDirection="row" flexShrink={0}>
                <Button key="helpers-tag" plain onPress={() => void showPane($).catch(() => undefined)}>
                  <Text color={P.orange}>{helperTag}</Text>
                </Button>
              </Box>
            )}
            {others.map(side => (
              <Box key={side.id} flexDirection="row">
                <Text color={sideColor(P, side.state)}>● </Text>
                <Text>{side.title ?? side.name} </Text>
                <Text dimColor>{side.state}</Text>
              </Box>
            ))}
          </Box>
        )}
        {total > 0 ? (
          <Box flexDirection="row">
            <Text bold tabular color={countColor}>{done}/{total} </Text>
            <Text wrap="truncate-end" dimColor={isFinished || isStale} color={isFinished ? P.green : undefined}>
              {stepText}
            </Text>
            {isStopped && current && (
              <Box flexShrink={0}>
                <Text color={P.orange}> · interrupted</Text>
              </Box>
            )}
            {isStale ? (
              <Box flexShrink={0}>
                <Text dimColor> · not updated for {age} turns · /progress clear hides it</Text>
              </Box>
            ) : times.length > 0 && (
              <Box flexShrink={0}>
                <Text dimColor> · {times.join(' · ')}</Text>
              </Box>
            )}
            <Box flexShrink={0}>
              <Text> </Text>
              <Button key="task-details" plain label="details ↗" onPress={() => void showPane($).catch(() => undefined)} />
            </Box>
          </Box>
        ) : linked.length > 0 && !working ? (
          <Text dimColor>No task list yet</Text>
        ) : null}
      </Box>
    )
  })

  // The Crab Tasks pane: the task list one bar per step (done steps solid, the
  // next orange, the running one cooling from its hot edge, its fill the time
  // spent against the usual step's; a step that just finished flashes green),
  // then a card per side session below it, or the cards alone with no list.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const P = await paletteNow($, fromSettings, over)
    const list = await read($, steps)
    const linked = await read($, sides)
    const crew = await read($, helpers)
    const now = Math.max(await read($, clockNow), await $.clock.now())
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    // A press is the person's own ask, so it may put the permission dialog up.
    const open = (id: string) => () =>
      void $.tool.call({ tool: OPEN_TOOL, session_id: id, target: 'focus' } as never).catch(() => undefined)
    const allow = (await read($, needsAllow)) ? (
      <Box flexDirection="column">
        <Text dimColor>The session tools need your allow to list this chat's family.</Text>
        <Button key="allow" label="Allow session tools" onPress={() => void refreshSides($, [], true)} />
      </Box>
    ) : null
    if (list.length === 0 && linked.length === 0 && crew.length === 0) {
      return allow ?? <Text dimColor>No task list, helpers or side sessions yet.</Text>
    }

    const tasks = async () => {
      const isStopped = await read($, isInterrupted)
      const total = list.length
      const done = list.filter(step => step.status === 'completed').length
      const isFinished = done === total
      const doneColor = isFinished ? P.green : P.purple
      const { left } = timing(list, now)
      const starts = list.flatMap(step => (step.startedAt === undefined ? [] : [step.startedAt]))
      const span = isFinished ? listSpan(list) : starts.length > 0 ? now - Math.min(...starts) : null
      const header = [
        span !== null && span > 1000 ? formatSpan(span) : null,
        !isFinished && left !== null ? `~${formatSpan(left)} left` : null,
      ].filter(Boolean)
      const bars = stepBars(list, now, stepEstimate(list))
      const cells = Math.max(8, Math.min(40, (e.props.bodyColumns || 30) - 2))
      const tick = Math.floor(now / TICK_MS)
      const lookColor = { done: doneColor, flash: P.green, running: P.orange, next: P.orange, rest: P.comment } as const

      return (
        <Box key="tasks" flexDirection="column" rowGap={1}>
          <Box flexDirection="row">
            <Text bold tabular color={isFinished ? P.green : P.purple}>{done}/{total}</Text>
            {header.length > 0 && <Text dimColor> · {header.join(' · ')}</Text>}
            {isStopped && <Text color={P.orange}> · interrupted</Text>}
          </Box>
          {list.map((step, i) => {
            const bar = bars[i] as (typeof bars)[number]
            const mark = step.status === 'completed' ? '✓' : step.status === 'in_progress' ? (isStopped ? '⏸' : '▸') : '○'
            const took =
              step.startedAt === undefined ? null : step.finishedAt !== undefined ? step.finishedAt - step.startedAt : now - step.startedAt

            return (
              <Box key={`step-${i}`} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={lookColor[bar.look]}>{mark} </Text>
                  <Text wrap="truncate-end" dimColor={bar.look === 'rest'}>{step.content}</Text>
                  {took !== null && took > 1000 && (
                    <Box flexShrink={0}>
                      <Text dimColor> {formatSpan(took)}</Text>
                    </Box>
                  )}
                </Box>
                {Svg ? (
                  <Svg alt={`${step.content}: ${step.status.replace('_', ' ')}`} height={BAR_H} source={stepSvg(P, bar, doneColor, i)} />
                ) : (
                  <Box flexDirection="row" flexShrink={0}>
                    {runsOf(stepCells(P, bar, doneColor, cells, tick)).map((run, j) => (
                      <Text key={`cell-${j}`} mono color={run.color}>{run.glyph}</Text>
                    ))}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    const cards = byUrgency(linked).map(side => ({
      side,
      card: {
        title: `${side.isParent ? '↑ ' : ''}${side.title ?? side.name}`,
        mood: moodOf(side.state),
        step: side.step,
        elapsed: side.since !== undefined && now > side.since ? formatSpan(now - side.since) : undefined,
      },
    }))
    const W = Math.max(240, Math.min(560, (e.props.bodyColumns || 40) * 8 - 8))
    const crabs = (
      <Box key="crabs" flexDirection="column" rowGap={Svg ? 1 : 0}>
        {(list.length > 0 || crew.length > 0) && (linked.length > 0 || allow) && <Text bold>Side sessions</Text>}
        {allow}
        {Svg
          ? cards.map(({ side, card }) => (
              <Box key={side.id} flexDirection="column">
                <Svg
                  alt={`${card.title}: ${MOOD[card.mood].label}${card.step ? `, ${card.step}` : ''}`}
                  width={W}
                  height={CARD_H}
                  source={cardSvg(P, W, card)}
                />
                <Button key={`open-${side.id}`} plain label={`Open ${card.title} ↗`} onPress={open(side.id)} />
              </Box>
            ))
          : cards.map(({ side, card }) => (
              <Box key={side.id} flexDirection="column">
                <Button key={`open-${side.id}`} plain onPress={open(side.id)}>
                  <Text color={moodColor(P, card.mood)}>🦀 </Text>
                  {card.title}
                  <Text dimColor> {[MOOD[card.mood].label, card.elapsed].filter(Boolean).join(' · ')}</Text>
                </Button>
                {card.step && <Text dimColor wrap="truncate-end">   {card.step}</Text>}
              </Box>
            ))}
      </Box>
    )

    // A card per helper, nested under the helper that started it, with its
    // reported progress bar below when it has one.
    const helperCards = (
      <Box key="helpers" flexDirection="column" rowGap={Svg ? 1 : 0}>
        <Text bold>Helpers</Text>
        {treeOrder(crew).map(({ helper, depth }) => {
          const mood = helperMood(helper)
          const span = (helper.finishedAt ?? now) - helper.startedAt
          const card = {
            title: helper.description,
            mood,
            step: helperLine(helper),
            elapsed: span > 1000 ? `${helper.status === 'working' ? '' : 'took '}${formatSpan(span)}` : undefined,
          }
          const w = Math.max(200, W - depth * 16)
          const bar = helper.bar
          const fill = bar?.isFailed ? P.red : P.green

          return (
            <Box key={`helper-${helper.id}`} flexDirection="column" paddingLeft={depth * 2}>
              {Svg ? (
                <Svg alt={`${card.title}: ${MOOD[mood].label}${card.step ? `, ${card.step}` : ''}`} width={w} height={CARD_H} source={cardSvg(P, w, card)} />
              ) : (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text color={moodColor(P, mood)}>🦀 </Text>
                    <Text wrap="truncate-end">{card.title}</Text>
                    <Box flexShrink={0}>
                      <Text dimColor> {[helper.status === 'failed' ? 'stopped' : MOOD[mood].label, card.elapsed].filter(Boolean).join(' · ')}</Text>
                    </Box>
                  </Box>
                  {card.step && <Text dimColor wrap="truncate-end">   {card.step}</Text>}
                </Box>
              )}
              {bar && (
                <Box flexDirection="column">
                  {Svg ? (
                    <Svg alt={barLabel(bar)} width={w} height={4} source={miniBarSvg(P.comment, fill, w, barFraction(bar))} />
                  ) : (
                    <Box flexDirection="row">
                      <Text>   </Text>
                      <Text mono color={fill}>{'▰'.repeat(Math.round(barFraction(bar) * 12))}</Text>
                      <Text mono color={P.comment}>{'▱'.repeat(12 - Math.round(barFraction(bar) * 12))}</Text>
                    </Box>
                  )}
                  <Text dimColor wrap="truncate-end">{Svg ? '' : '   '}{barLabel(bar)}</Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        {list.length > 0 && (await tasks())}
        {crew.length > 0 && helperCards}
        {crabs}
      </Box>
    )
  })

  // Each theme as a row of its colours, drawn with the settings' overrides on
  // top; a press switches to it.
  on('ui.render', { component: 'Pane', requestId: THEME_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const picked = await read($, themeName)
    const current = picked ?? fromSettings
    const swatch = (P: Palette) =>
      (['purple', 'pink', 'orange', 'green', 'comment'] as const).map(role => (
        <Text key={role} mono color={P[role]}>██</Text>
      ))

    return (
      <Box flexDirection="column">
        {Object.keys(THEMES).map(name => (
          <Button key={`theme-${name}`} plain onPress={() => void setTheme($, name)}>
            {swatch(paletteOf(name, over))}
            <Text> {name}</Text>
            <Text dimColor>{name === current ? ' ◂ current' : ''}</Text>
          </Button>
        ))}
        <Button key="theme-default" plain onPress={() => void setTheme($, null)}>
          <Text dimColor>Settings' theme ({fromSettings}){picked === null ? ' ◂ current' : ''}</Text>
        </Button>
      </Box>
    )
  })
}
