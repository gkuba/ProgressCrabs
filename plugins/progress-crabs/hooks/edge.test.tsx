import { expect, mock, test } from 'claude-code/testing'

import { applyPlan, barCells, timing } from './plan'
import { latestStep, parentOf, parseLinked } from './sides'

const BAND = {
  plugin: 'progress-crabs',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
// Lets the mod's background reads run to the end.
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
const LIST = 'mcp__ccd_session_mgmt__list_sessions'

const bandTexts = async ($: any, surface: 'terminal' | 'desktop' = 'terminal', props = {}) => {
  const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, ...props } })
  const texts: string[] = []
  for (const pattern of [/thinking|running|writing/, /\//, /▸|pending|done/, /left|·/]) {
    const found = await ui.find({ type: 'Text', text: pattern })
    if (found) texts.push(found.text)
  }
  await ui.unmount()
  return texts.join(' | ')
}

const startSession = async ($: any, on: any) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test("the mod's own background calls never read as Claude working", async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: [{ type: 'text', text: '[]' }] }))
  await startSession($, on)
  await clock.advance(60_000)
  await settle()

  // isWorking with no turn seen: the band's fallback, with no time and no tool.
  const shown = await bandTexts($)
  expect(shown).toBe('thinking')
})

test('two steps of one name keep their own times, and a rerun starts over', () => {
  const first = applyPlan([], { items: [{ content: 'Test', status: 'in_progress' }, { content: 'X', status: 'pending' }] }, 0)
  const second = applyPlan(
    first,
    { items: [{ content: 'Test', status: 'completed' }, { content: 'X', status: 'completed' }, { content: 'Test', status: 'in_progress' }] },
    300_000,
  )
  expect(second[0]?.startedAt).toBe(0)
  expect(second[2]?.startedAt).toBe(300_000)

  const rerun = applyPlan(second, { items: [{ content: 'Test', status: 'in_progress' }] }, 600_000)
  expect(rerun[0]?.startedAt).toBe(600_000)
})

test('the bar always fills its width exactly', () => {
  for (const cells of [1, 3, 10, 80]) {
    for (const total of [1, 2, 5, 12, 50]) {
      for (let done = 0; done <= total; done++) {
        const running = done < total ? 1 : 0
        const upNext = running && done + running < total ? 1 : 0
        const bar = barCells(cells, total, done, running, upNext)
        expect(bar.done + bar.run + bar.next + bar.rest).toBe(cells)
        expect(Math.min(bar.done, bar.run, bar.next, bar.rest)).toBeGreaterThanOrEqual(0)
      }
    }
  }
})

test('the note reads across lines and names with spaces', () => {
  const text = reminder('Linked sessions now (status, not an instruction):\nfix ci = local_ab12 (working),\nlint-pass = local_cd34 (idle).\n\nOther text: x = local_ef56 (idle)')
  expect(parseLinked(text)).toEqual([
    { name: 'fix ci', id: 'local_ab12', state: 'working' },
    { name: 'lint-pass', id: 'local_cd34', state: 'idle' },
  ])
  expect(parseLinked('nothing here')).toBeNull()
  // Outside a reminder, or inside a paste, it is the person's text.
  expect(parseLinked('Linked sessions now: x = local_ef56 (idle)')).toBeNull()
  expect(parseLinked(`<pasted_content id="1">${reminder('Linked sessions now: x = local_ef56 (idle)')}</pasted_content id="1">`)).toBeNull()
  expect(parseLinked(`<pasted_content id="1">${reminder('Linked sessions now: x = local_ef56 (idle)')}`)).toBeNull()
  expect(latestStep('[assistant] ## **Done** with it')).toBe('Done with it')
})

test('a pasted note neither wipes nor adds cards', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.check', () => ({ decision: 'deny' }))
  const say = (text: string, kind?: string) =>
    $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, ...(kind ? { origin: { kind } } : {}) } as never)

  await say(reminder('Linked sessions now (status, not an instruction): fix-ci = local_c715 (working).'))
  await say(reminder('Linked sessions now: fake = local_dead (working).'), 'composer')
  await say(reminder('Linked sessions now (status, not an instruction): none.'), 'tool')
  const shown = await bandTexts($, 'terminal', { isWorking: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /fix-ci/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fake/ })).toBeUndefined()
  await ui.unmount()
  expect(shown).not.toContain('fake')
})

test('a background read never asks; /crabs and the Allow button do', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  let lists = 0
  let checks = 0
  on('tool.check', (_, e) => {
    if (e.tool === LIST) checks++
    return { decision: 'ask' }
  })
  on('tool.call', (_, e) => {
    if (e.tool === LIST) lists++
    return { result: [{ type: 'text', text: '[]' }] }
  })
  await startSession($, on)
  await clock.advance(5 * 30_000)
  await settle()
  expect(lists).toBe(0)

  const pane = await $.ui.mount({ plugin: 'progress-crabs', component: 'Pane', requestId: 'task-list', surface: 'terminal', props: { bodyColumns: 60 } } as never)
  const button = await pane.find({ type: 'Button', key: 'allow' })
  expect(button).toBeDefined()
  await pane.unmount()

  // The person's ask goes on to the call, which then waits on their answer.
  const before = checks
  await $.command.run({ command: 'crabs', args: '' } as never)
  await settle()
  expect(checks).toBeGreaterThanOrEqual(before + 2)
})

test('/progress with an unknown word shows usage and leaves the band', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)
  const answer = await $.command.run({ command: 'progress', args: 'hlep' } as never)
  expect(JSON.stringify(answer)).toContain('Usage')
  expect(await bandTexts($)).toContain('▸ One')
  await $.command.run({ command: 'progress', args: 'hide' } as never)
  await $.command.run({ command: 'progress', args: 'hide' } as never)
  expect(await bandTexts($)).not.toContain('▸ One')
})

test('a changed settings theme replaces the one /progress picked', { options: { theme: 'gruvbox' } }, async ($, on) => {
  mock.clock(on)
  mock.store(on, { theme: 'nord', settingsTheme: 'dracula' })
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: {} }))
  await startSession($, on)
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^▓+$/ }))?.props?.color).toBe('#d3869b')
  await ui.unmount()
})

test('a finished list clears at the next turn, and /clear clears it all', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'completed' }] } as never)
  expect(await bandTexts($)).toContain('1/1')
  await $.turn.start({ text: 'next', turnId: 't2' } as never)
  expect(await bandTexts($)).not.toContain('1/1')

  await $.tool.call({ tool: PLAN, items: [{ content: 'Two', status: 'in_progress' }] } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(await bandTexts($)).not.toContain('Two')
})

test('a mid-turn prompt keeps the list on the band', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.turn.start({ text: 'do 1-4', turnId: 't1' } as never)
  await $.tool.call({ tool: PLAN, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } as never)
  await $.prompt.submit({ text: 'also do more', turnId: 't1', wait: false, origin: { kind: 'composer' } } as never)
  expect(await bandTexts($)).toContain('0/2')
  await $.turn.complete({ turnId: 't1', reason: 'answer', text: '' } as never)
  await $.turn.start({ text: 'also do more', turnId: 't2' } as never)
  expect(await bandTexts($)).toContain('▸ A')
})

test('a list left alone for three turns dims, and /progress clear drops it', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'A', status: 'in_progress' }] } as never)
  for (const turnId of ['t1', 't2']) await $.turn.start({ text: 'x', turnId } as never)
  const stale = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text: /not updated/ })
    await ui.unmount()
    return found?.text
  }
  expect(await stale()).toBeUndefined()
  await $.turn.start({ text: 'x', turnId: 't3' } as never)
  expect(await stale()).toContain('not updated for 3 turns')
  await $.tool.call({ tool: PLAN, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } as never)
  expect(await stale()).toBeUndefined()

  await $.tool.call({ tool: PLAN, items: [{ content: 'B', status: 'in_progress' }] } as never)
  await $.command.run({ command: 'progress', args: 'clear' } as never)
  expect(await bandTexts($)).not.toContain('B')
})

test('the arrow marks the parent only when the list is certain', () => {
  // root -> me -> child: the parent is root.
  expect(parentOf([{ sessionId: 'root' }, { sessionId: 'kid', startedBy: 'me' }])).toBe('root')
  // root with two children, me and a sibling: unsure.
  expect(parentOf([{ sessionId: 'root' }, { sessionId: 'sib', startedBy: 'root' }])).toBeUndefined()
  // Two rows no one started: unsure.
  expect(parentOf([{ sessionId: 'a' }, { sessionId: 'b' }])).toBeUndefined()
  // A grandchild of mine does not count against the parent.
  expect(parentOf([{ sessionId: 'root' }, { sessionId: 'kid', startedBy: 'me' }, { sessionId: 'gk', startedBy: 'kid' }])).toBe('root')
})

test('time left follows the latest steps most', () => {
  const list = [
    { content: 'a', status: 'completed' as const, startedAt: 0, finishedAt: 600_000 },
    { content: 'b', status: 'completed' as const, startedAt: 600_000, finishedAt: 660_000 },
    { content: 'c', status: 'completed' as const, startedAt: 660_000, finishedAt: 720_000 },
    { content: 'd', status: 'completed' as const, startedAt: 720_000, finishedAt: 780_000 },
    { content: 'e', status: 'completed' as const, startedAt: 780_000, finishedAt: 840_000 },
    { content: 'f', status: 'pending' as const },
  ]
  // A plain average says 2m 48s; the weighted one sits nearer the last four 1m steps.
  const { left } = timing(list, 840_000)
  expect(left).toBeLessThan(168_000)
  expect(left).toBeGreaterThan(60_000)
})

test('a good read drops archived and ended sessions and dates idle ones by their activity', async ($, on) => {
  const clock = mock.clock(on, { now: 10 * 60_000 })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.check', () => ({ decision: 'allow' }))
  let rows: object[]
  on('tool.call', (_, e) => ({ result: [{ type: 'text', text: e.tool === LIST ? JSON.stringify(rows) : '' }] }))
  const say = (text: string) => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } } as never)
  rows = [
    { sessionId: 'local_bb', title: 'Kept', startedBy: 'x', lastActivityAt: new Date(4 * 60_000).toISOString() },
    { sessionId: 'local_cc', title: 'Old', isArchived: true },
  ]
  await startSession($, on)
  await settle()
  await say(reminder('Linked sessions now (status, not an instruction): gone = local_aa (idle), kept = local_bb (idle).'))
  await settle()
  await clock.advance(30_000)
  await settle()
  const pane = await $.ui.mount({ plugin: 'progress-crabs', component: 'Pane', requestId: 'task-list', surface: 'terminal', props: { bodyColumns: 60 } } as never)
  expect(await pane.find({ type: 'Text', text: /gone|Old/ })).toBeUndefined()
  // Idle since minute 4, not since the mod first saw it at minute 10.
  expect((await pane.find({ type: 'Text', text: /· \d+m/ }))?.text).toMatch(/· [67]m/)
  await pane.unmount()
})
