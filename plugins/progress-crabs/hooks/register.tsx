import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Side, Step } from '../types'
import { CARD_H, MOOD, cardSvg, moodColor, moodOf } from './crabs'
import { DEFAULT_THEME, THEMES, isTheme, paletteOf } from './themes'
import type { Overrides, Palette } from './themes'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const steps = atom({ plugin: 'progress-crabs', key: 'steps' } as const, [], { shape: 'steps-2' })
const sides = atom({ plugin: 'progress-crabs', key: 'sides' } as const, [], { shape: 'sides-2' })
const activity = atom({ plugin: 'progress-crabs', key: 'activity' } as const, null as Activity | null, { shape: 'activity-1' })
const isHidden = atom({ plugin: 'progress-crabs', key: 'isHidden' } as const, false)
// Ticks while a step runs, so the elapsed time redraws on its own.
// The theme `/progress theme` picked; null falls back to the settings' theme.
const themeName = atom({ plugin: 'progress-crabs', key: 'theme' } as const, null as string | null)
const clockNow = atom({ plugin: 'progress-crabs', key: 'now' } as const, 0)
const TICK_MS = 5_000

const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
const LINKED = /([\w.-]+) = (local_[0-9a-f-]+) \(([^)]+)\)/g

type PlanArgs = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: boolean
  done?: number[]
  start?: number
}

const toStatus = (s: unknown): Step['status'] =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

// Mirrors the app's own task-list semantics: items replace, advance completes
// the running step and starts the next pending one, done/start are 1-based.
const applyPlan = (list: Step[], args: PlanArgs, now: number): Step[] => {
  // A replaced list keeps the times of steps it carries over by name.
  const next: Step[] = Array.isArray(args.items)
    ? args.items.map(item => {
        const content = String(item.content ?? '')
        const was = list.find(step => step.content === content)

        return { ...was, content, status: toStatus(item.status) }
      })
    : list.map(step => ({ ...step }))

  if (args.advance) {
    const running = next.findIndex(step => step.status === 'in_progress')
    if (running >= 0) next[running].status = 'completed'
    const pending = next.findIndex((step, i) => i > running && step.status === 'pending')
    if (pending >= 0) next[pending].status = 'in_progress'
  }
  for (const n of args.done ?? []) {
    if (next[n - 1]) next[n - 1].status = 'completed'
  }
  if (typeof args.start === 'number' && next[args.start - 1]) {
    next[args.start - 1].status = 'in_progress'
  }

  return stamp(next, now)
}

const stamp = (list: Step[], now: number): Step[] =>
  list.map(step => {
    if (step.status === 'in_progress') return { ...step, startedAt: step.startedAt ?? now, finishedAt: undefined }
    if (step.status === 'completed') return { ...step, startedAt: step.startedAt ?? now, finishedAt: step.finishedAt ?? now }

    return { content: step.content, status: step.status }
  })

const formatSpan = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// Elapsed time of the running step, and a rough estimate of what is left from
// the average of the steps that ran for a measured time.
const timing = (list: Step[], now: number) => {
  const current = list.find(step => step.status === 'in_progress')
  const elapsed = current?.startedAt !== undefined ? Math.max(0, now - current.startedAt) : null
  const spans = list
    .filter(step => step.status === 'completed' && step.startedAt !== undefined && step.finishedAt !== undefined)
    .map(step => (step.finishedAt as number) - (step.startedAt as number))
    .filter(span => span > 1000)
  if (spans.length === 0) return { elapsed, left: null }

  const average = spans.reduce((sum, span) => sum + span, 0) / spans.length
  const pending = list.filter(step => step.status === 'pending').length
  const left = pending * average + (current ? Math.max(0, average - (elapsed ?? 0)) : 0)

  return { elapsed, left: pending || current ? left : null }
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(block => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
    .join('\n')
}


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

// What the main loop is doing, for the working row. A mode is written only
// when it changes, not per streamed piece.
async function setMode($: EngineInterface, mode: Activity['mode'], tool?: string) {
  const now = await $.clock.now()
  await update($, activity, was =>
    was && was.mode === mode && was.tool === tool ? was : { mode, tool, since: was?.since ?? now },
  )
}

const sideColor = (P: Palette, state: string) => moodColor(P, moodOf(state))

const PANE = 'linked-sessions'
const LIST_TOOL = 'mcp__ccd_session_mgmt__list_sessions'
const EVENTS_TOOL = 'mcp__ccd_session_mgmt__list_events'
const OPEN_TOOL = 'mcp__ccd_window__open_session_in'

// An MCP tool's answer as text, however the result wraps it.
const resultText = (r: unknown): string => {
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return textOf(r)
  if (r && typeof r === 'object' && 'content' in r) return resultText((r as { content: unknown }).content)

  return ''
}

// The first line of the session's latest answer, markdown stripped.
const latestStep = (transcript: string): string | undefined => {
  const at = transcript.lastIndexOf('[assistant]')
  if (at < 0) return undefined
  const line = transcript
    .slice(at + '[assistant]'.length)
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)

  return line?.replace(/\*\*|`/g, '').replace(/^[-*] /, '')
}

// Titles for every linked session, and the latest step of the ones named.
async function refreshSides($: EngineInterface, stepsOf: string[]) {
  const titles = new Map<string, string>()
  try {
    const listed = await $.tool.call({ tool: LIST_TOOL, linked: true } as never)
    const rows = JSON.parse(resultText('result' in listed ? listed.result : '') || '[]') as { sessionId?: string; title?: string }[]
    for (const row of rows) if (row.sessionId && row.title) titles.set(row.sessionId, row.title)
  } catch {
    // The panel falls back to the short names.
  }
  const found = new Map<string, string>()
  for (const id of stepsOf) {
    try {
      const events = await $.tool.call({ tool: EVENTS_TOOL, session_id: id, limit: 3 } as never)
      const step = latestStep(resultText('result' in events ? events.result : ''))
      if (step) found.set(id, step)
    } catch {
      // Left without a step.
    }
  }
  await update($, sides, list =>
    list.map(side => ({ ...side, title: titles.get(side.id) ?? side.title, step: found.get(side.id) ?? side.step })),
  )
}

async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await $.ui.close({ id: PANE })

    return false
  }
  await $.ui.open({ id: PANE, title: 'Side sessions' })

  return true
}

// The colours to draw with: the picked theme, else the settings' one, with the settings' overrides on top.
async function paletteNow($: EngineInterface, fallback: string, over: Overrides) {
  return paletteOf((await read($, themeName)) ?? fallback, over)
}

const themeList = (current: string) =>
  Object.keys(THEMES)
    .map(name => `${name === current ? '▸' : ' '} ${name}`)
    .join('\n')

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
      argumentHint: '[theme [name|default]]',
    })
    await $.command.register({
      name: 'crabs',
      description: 'Show or hide the side sessions panel',
    })
    const saved = await $.store.get('theme').catch(() => undefined)
    if (isTheme(saved)) await update($, themeName, () => saved)
    const startedAt = await $.clock.now()
    await update($, clockNow, () => startedAt)
    $.clock.every(TICK_MS, async () => {
      const list = await read($, steps)
      const linked = await read($, sides)
      if (
        (await read($, activity)) ||
        list.some(step => step.status === 'in_progress') ||
        linked.some(side => moodOf(side.state) === 'working')
      ) {
        const now = await $.clock.now()
        await update($, clockNow, () => now)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const [verb, name] = e.args.trim().toLowerCase().split(/\s+/)
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
      return { text: `Theme: ${name}.` }
    }
    const hidden = await update($, isHidden, was => !was)

    return { text: hidden ? 'Task progress band hidden. Run /progress to show it again.' : 'Task progress band shown.' }
  })

  on('command.run', { command: 'crabs' }, async $ => {
    const isOpen = await togglePane($)

    return { text: isOpen ? 'Side sessions panel open.' : 'Side sessions panel closed.' }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId && !('deny' in ran && ran.deny) && !ran.isError) {
      const now = await $.clock.now()
      await update($, steps, list => applyPlan(list, e as unknown as PlanArgs, now))
      await update($, clockNow, () => now)
    }

    return ran
  })

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, steps, list =>
        stamp(list.map(step => (step.status === 'in_progress' ? { ...step, status: 'completed' } : step)), now),
      )
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, activity, () => ({ mode: 'thinking', since: now }))
      await update($, clockNow, () => now)
    }

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    await setMode($, 'thinking')
    const stream = next(e)
    let mode: Activity['mode'] = 'thinking'
    while (true) {
      const piece = await stream.next()
      if (piece.done) return piece.value
      const chunk = piece.value
      const now: Activity['mode'] | null =
        chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'writing' : chunk.kind === 'tool' ? 'tool' : null
      if (now && (now !== mode || chunk.kind === 'tool')) {
        mode = now
        await setMode($, now, chunk.kind === 'tool' ? shortTool(chunk.name) : undefined)
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    await setMode($, 'tool', shortTool(e.tool))
    const ran = await next(e)
    await setMode($, 'thinking')

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) await update($, activity, () => null)

    return done
  })

  // The app's "Linked sessions now" reminder carries each side session's state.
  on('session.append', async ($, e, next) => {
    if (!e.agentId) {
      const text = textOf(e.message.content)
      const at = text.indexOf('Linked sessions now')
      if (at >= 0) {
        const line = text.slice(at).split('\n')[0]
        const now = await $.clock.now()
        const before = await read($, sides)
        const found: Side[] = [...line.matchAll(LINKED)].map(m => {
          const was = before.find(side => side.id === m[2])
          const state = m[3]

          return { ...was, name: m[1], id: m[2], state, since: was && was.state === state ? was.since : now }
        })
        await update($, sides, () => found)

        // A toast when a session finishes a turn or starts waiting on the person.
        const changed = found.filter(side => before.find(b => b.id === side.id)?.state !== side.state)
        for (const side of changed) {
          const was = before.find(b => b.id === side.id)
          const mood = moodOf(side.state)
          if (mood === 'waiting') $.ui.toast(`🦀 ${side.title ?? side.name} is waiting on you`)
          else if (was && moodOf(was.state) === 'working') $.ui.toast(`🦀 ${side.title ?? side.name} finished a turn`)
        }
        if (found.length > 0 && before.length === 0) void $.ui.open({ id: PANE, title: 'Side sessions' }).catch(() => undefined)
        const stale = found.filter(side => !side.title || changed.includes(side)).map(side => side.id)
        if (stale.length > 0) void refreshSides($, stale).catch(() => undefined)
      }
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

    const upNext = running && done + running < total ? 1 : 0
    const cells = Math.max(10, e.props.bodyColumns)
    const cellsFor = (n: number) => (total ? Math.round((n / total) * cells) : 0)
    const doneCells = cellsFor(done)
    const runCells = running ? Math.max(1, cellsFor(done + running) - doneCells) : 0
    const nextCells = upNext ? Math.max(1, cellsFor(done + running + upNext) - doneCells - runCells) : 0
    const restCells = Math.max(0, cells - doneCells - runCells - nextCells)
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
              <Text mono color={P.purple}>{'█'.repeat(doneCells)}</Text>
              <Text mono color={P.pink}>{'█'.repeat(runCells)}</Text>
              <Text mono color={P.orange}>{'█'.repeat(nextCells)}</Text>
              <Text mono color={P.comment}>{'░'.repeat(restCells)}</Text>
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
            <Text bold tabular color={isFinished ? P.green : P.purple}>{done}/{total} </Text>
            <Text wrap="truncate-end" dimColor={isFinished}>
              {isFinished ? '✓ all steps done' : current ? `▸ ${current.content}` : `${total - done} pending`}
            </Text>
            {times.length > 0 && (
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
    const open = (id: string) => () =>
      void $.tool.call({ tool: OPEN_TOOL, session_id: id, target: 'focus' } as never).catch(() => undefined)
    if (linked.length === 0) return <Text dimColor>No side sessions from this chat yet.</Text>

    const cards = linked.map(side => ({
      side,
      card: {
        title: side.title ?? side.name,
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
