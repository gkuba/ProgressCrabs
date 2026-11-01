import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Side, Step } from '../types'
import { CARD_H, MOOD, cardSvg, moodColor, moodOf } from './crabs'
import { applyPlan, barCells, completeRunning, formatSpan, timing } from './plan'
import type { PlanArgs } from './plan'
import { idleSince, latestStep, parentOf, parseLinked, resultText, textOf } from './sides'
import type { FamilyRow } from './sides'
import { DEFAULT_THEME, THEMES, isTheme, paletteOf } from './themes'
import type { Overrides, Palette } from './themes'

const PLUGIN = 'progress-crabs'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const steps = atom({ plugin: 'progress-crabs', key: 'steps' } as const, [], { shape: 'steps-2' })
const sides = atom({ plugin: 'progress-crabs', key: 'sides' } as const, [], { shape: 'sides-2' })
const activity = atom({ plugin: 'progress-crabs', key: 'activity' } as const, null as Activity | null, { shape: 'activity-1' })
const isHidden = atom({ plugin: 'progress-crabs', key: 'isHidden' } as const, false)
// The theme `/progress theme` picked; null falls back to the settings' theme.
const themeName = atom({ plugin: 'progress-crabs', key: 'theme' } as const, null as string | null)
// Set once the person closes the side sessions panel, so it stops opening by itself.
const isPaneDismissed = atom({ plugin: 'progress-crabs', key: 'isPaneDismissed' } as const, false)
// Ticks while something works, and once a minute while side sessions sit idle,
// so elapsed times redraw on their own.
const clockNow = atom({ plugin: 'progress-crabs', key: 'now' } as const, 0)
// Set while a background read of the session tools would put up a permission dialog.
const needsAllow = atom({ plugin: 'progress-crabs', key: 'needsAllow' } as const, false)
// Turns started since the task list last changed; an old list draws dimmed.
const planAge = atom({ plugin: 'progress-crabs', key: 'planAge' } as const, 0)
const STALE_TURNS = 3
const TICK_MS = 5_000
const FAMILY_MS = 30_000

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'

// A full-width pill: solid purple for finished steps, pink for the running one,
// orange for the one up next, the rest an empty track. Percent lengths let the
// frame's own width decide the size.
const pillSvg = (P: Palette, height: number, total: number, done: number, running: number, upNext: number) => {
  const r = height / 2
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`
  const seg = (n: number, fill: string) =>
    n > 0 ? `<rect x="0" y="0" width="${pct(n)}" height="${height}" rx="${r}" fill="${fill}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">
<rect x="0" y="0" width="100%" height="${height}" rx="${r}" fill="${P.comment}" fill-opacity="0.3"/>
${seg(done + running + upNext, P.orange)}
${seg(done + running, P.pink)}
${seg(done, P.purple)}
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

const PANE = 'linked-sessions'
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

async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })
    await update($, isPaneDismissed, () => true)

    return false
  }
  await update($, isPaneDismissed, () => false)
  await $.ui.open({ id: PANE, title: 'Side sessions' })

  return true
}

// Opens the panel the first time a side session appears, unless the person closed it.
async function openPaneOnce($: EngineInterface) {
  if (!(await read($, isPaneDismissed))) await $.ui.open({ id: PANE, title: 'Side sessions' })
}

// The colours to draw with: the picked theme, else the settings' one, with the settings' overrides on top.
async function paletteNow($: EngineInterface, fallback: string, over: Overrides) {
  return paletteOf((await read($, themeName)) ?? fallback, over)
}

const themeList = (current: string) =>
  Object.keys(THEMES)
    .map(name => `${name === current ? '▸' : ' '} ${name}`)
    .join('\n')

// Whether the family has been read once; until then each tick tries again
// (the app's tools may connect after the session starts).
let isFamilyRead = false
// One read at a time, so two never toast the same finish; asks made while one
// runs fold into a single read after it.
let queued: Set<string> | null = null
let queuedAsk = false
let running: Promise<void> | null = null
const resetFamily = () => {
  isFamilyRead = false
}

// The linked family as the app lists it: titles for every session, and the
// sessions the "Linked sessions now" note leaves out (the one that started
// this chat, and sessions further down), with their running state. Then the
// latest step of the ones named, or of any whose state changed.
async function readFamily($: EngineInterface, stepsOf: string[], mayAsk = false) {
  let rows: FamilyRow[] | null = null
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

const USAGE = [
  '/progress            show or hide the band',
  '/progress show|hide  show or hide it',
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
      argumentHint: '[show|hide|clear|theme [name|default]]',
    })
    await $.command.register({
      name: 'crabs',
      description: 'Show or hide the side sessions panel',
    })
    // A theme picked with /progress lasts until the settings' theme changes.
    const settingsWas = await $.store.get('settingsTheme').catch(() => undefined)
    if (settingsWas !== undefined && settingsWas !== fromSettings) await $.store.delete('theme').catch(() => undefined)
    if (settingsWas !== fromSettings) await $.store.set('settingsTheme', fromSettings).catch(() => undefined)
    const saved = await $.store.get('theme').catch(() => undefined)
    await update($, themeName, () => (isTheme(saved) ? saved : null))
    // The family the note leaves out (this chat's parent above all) is read
    // from the app's list: now, then every 30 seconds while there is one, or
    // until a first read goes through.
    void refreshSides($, [])
    $.clock.every(FAMILY_MS, async () => {
      if (!isFamilyRead || (await read($, sides)).length > 0) await refreshSides($, [])
    })
    const startedAt = await $.clock.now()
    await update($, clockNow, () => startedAt)
    $.clock.every(TICK_MS, async () => {
      const list = await read($, steps)
      const linked = await read($, sides)
      const now = await $.clock.now()
      const was = await read($, clockNow)
      const isBusy =
        (await read($, activity)) !== null ||
        list.some(step => step.status === 'in_progress') ||
        linked.some(side => moodOf(side.state) === 'working')
      const isNewMinute = linked.length > 0 && Math.floor(now / 60_000) !== Math.floor(was / 60_000)
      if (isBusy || isNewMinute) await update($, clockNow, () => now)
    })

    return next(e)
  })

  // A /clear starts a new conversation in the same process: its task list and
  // family are not this one's.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, steps, () => [])
      await update($, planAge, () => 0)
      await update($, sides, () => [])
      await update($, activity, () => null)
      resetFamily()
    }

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const [verb = '', name] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'theme' || verb === 'themes') {
      if (!name) {
        const current = (await read($, themeName)) ?? fromSettings
        return { text: `Themes (▸ current):\n${themeList(current)}\n\n/progress theme <name> to switch, /progress theme default for the settings' theme.` }
      }
      if (name === 'default' || name === 'reset') {
        await $.store.delete('theme')
        await update($, themeName, () => null)
        return { text: `Theme back to the settings' theme: ${fromSettings}.` }
      }
      if (!isTheme(name)) return { text: `No theme "${name}". Themes:\n${themeList('')}` }
      await $.store.set('theme', name)
      await update($, themeName, () => name)
      return { text: `Theme: ${name}. Changing the theme in the settings replaces it.` }
    }
    if (verb === 'clear') {
      await update($, steps, () => [])
      await update($, planAge, () => 0)
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

    return { text: isOpen ? 'Side sessions panel open.' : 'Side sessions panel closed.' }
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
      await update($, steps, list => applyPlan(list, e as unknown as PlanArgs, now))
      await update($, planAge, () => 0)
      await update($, clockNow, () => now)
    }

    return ran
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && wentThrough(ran)) {
      const now = await $.clock.now()
      await update($, steps, list => completeRunning(list, now))
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, activity, () => ({ mode: 'thinking', since: now }))
      await update($, clockNow, () => now)
      // A list finished in an earlier turn makes way for the next one.
      const list = await update($, steps, was => (was.length > 0 && was.every(step => step.status === 'completed') ? [] : was))
      await update($, planAge, age => (list.length > 0 ? age + 1 : 0))
      if (!isFamilyRead) void refreshSides($, [])
      // A prompt typed mid-turn can take the band over while it queues; draw it again.
      $.ui.invalidate('ui.render')
    }

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (e.turnId) $.ui.invalidate('ui.render')

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
    if (e.agentId || next.origin.plugin === PLUGIN) return next(e)
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
    const done = await next(e)
    if (!e.agentId) await update($, activity, () => null)

    return done
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
    if (e.props.hasSurvey || (await read($, isHidden)) || (list.length === 0 && linked.length === 0 && !doing)) {
      return next(e)
    }

    const P = await paletteNow($, fromSettings, over)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = e.surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
    const total = list.length
    const done = list.filter(step => step.status === 'completed').length
    const running = list.filter(step => step.status === 'in_progress').length
    const current = list.find(step => step.status === 'in_progress')
    const isFinished = total > 0 && done === total
    const age = await read($, planAge)
    // A list no update has touched for a few turns was likely left behind.
    const isStale = !isFinished && age >= STALE_TURNS

    const upNext = running && done + running < total ? 1 : 0
    const bar = barCells(Math.max(1, e.props.bodyColumns), total, done, running, upNext)
    const clock = await read($, clockNow)
    const { elapsed, left } = timing(list, clock)
    const look = doing ? ACTIVITY[doing.mode] : null
    const working = doing && look
      ? [`${look.label}${doing.mode === 'tool' && doing.tool ? ` ${doing.tool}` : ''}`, doing.since !== undefined ? formatSpan(Math.max(0, clock - doing.since)) : null]
          .filter(Boolean)
          .join(' · ')
      : null
    const times = [
      !isFinished && elapsed !== null ? formatSpan(elapsed) : null,
      !isFinished && left !== null ? `~${formatSpan(left)} left (rough)` : null,
    ].filter(Boolean)

    return (
      <Box flexDirection="column" rowGap={0}>
        {total > 0 &&
          (Svg ? (
            <Svg alt={`${done} of ${total} steps done`} height={10} source={pillSvg(P, 10, total, done, running, upNext)} />
          ) : (
            <Box flexDirection="row">
              <Text mono color={P.purple}>{'█'.repeat(bar.done)}</Text>
              <Text mono color={P.pink}>{'▓'.repeat(bar.run)}</Text>
              <Text mono color={P.orange}>{'▒'.repeat(bar.next)}</Text>
              <Text mono color={P.comment}>{'░'.repeat(bar.rest)}</Text>
            </Box>
          ))}
        {(working || linked.length > 0) && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {working && look && (
              <Box flexDirection="row">
                <Text color={P[look.role]}>● </Text>
                <Text wrap="truncate-end">{working}</Text>
              </Box>
            )}
            {linked.map(side => (
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
            <Text bold tabular color={isFinished ? P.green : isStale ? P.comment : P.purple}>{done}/{total} </Text>
            <Text wrap="truncate-end" dimColor={isFinished || isStale}>
              {isFinished ? '✓ all steps done' : current ? `▸ ${current.content}` : `${total - done} pending`}
            </Text>
            {isStale ? (
              <Box flexShrink={0}>
                <Text dimColor> · not updated for {age} turns</Text>
              </Box>
            ) : times.length > 0 && (
              <Box flexShrink={0}>
                <Text dimColor> · {times.join(' · ')}</Text>
              </Box>
            )}
          </Box>
        ) : linked.length > 0 && !working ? (
          <Text dimColor>No task list yet</Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const P = await paletteNow($, fromSettings, over)
    const linked = await read($, sides)
    const now = await read($, clockNow)
    // A press is the person's own ask, so it may put the permission dialog up.
    const open = (id: string) => () =>
      void $.tool.call({ tool: OPEN_TOOL, session_id: id, target: 'focus' } as never).catch(() => undefined)
    const allow = (await read($, needsAllow)) ? (
      <Box flexDirection="column">
        <Text dimColor>The session tools need your allow to list this chat's family.</Text>
        <Button key="allow" label="Allow session tools" onPress={() => void refreshSides($, [], true)} />
      </Box>
    ) : null
    if (linked.length === 0) {
      return allow ?? <Text dimColor>No side sessions from this chat yet.</Text>
    }

    const cards = linked.map(side => ({
      side,
      card: {
        title: `${side.isParent ? '↑ ' : ''}${side.title ?? side.name}`,
        mood: moodOf(side.state),
        step: side.step,
        elapsed: side.since !== undefined && now > side.since ? formatSpan(now - side.since) : undefined,
      },
    }))

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(560, (e.props.bodyColumns || 40) * 8 - 8))

      return (
        <Box flexDirection="column" rowGap={1}>
          {allow}
          {cards.map(({ side, card }) => (
            <Box key={side.id} flexDirection="column">
              <Svg
                alt={`${card.title}: ${MOOD[card.mood].label}${card.step ? `, ${card.step}` : ''}`}
                width={W}
                height={CARD_H}
                source={cardSvg(P, W, card)}
              />
              <Button key={`open-${side.id}`} plain label={`Open ${card.title} ↗`} onPress={open(side.id)} />
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {allow}
        {cards.map(({ side, card }) => (
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
  })
}
