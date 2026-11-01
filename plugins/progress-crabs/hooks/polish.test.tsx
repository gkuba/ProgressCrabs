import { expect, mock, test } from 'claude-code/testing'

import { timing } from './plan'
import { THEMES, contrast } from './themes'

const BAND = {
  plugin: 'progress-crabs',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
const LIST = 'mcp__ccd_session_mgmt__list_sessions'
const reminder = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const startSession = async ($: any, on: any) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

const band = async ($: any, props = {}, surface = 'terminal') =>
  $.ui.mount({ ...BAND, surface, props: { ...BAND.props, ...props } })

test('short of rows or width the band folds into one row', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress' },
      { content: 'Three', status: 'pending' },
    ],
  } as never)

  for (const props of [{ maxRows: 1 }, { bodyColumns: 30 }]) {
    const ui = await band($, props)
    expect((await ui.find({ type: 'Text', text: /\d\/\d/ }))?.text).toBe(' 1/3 ')
    expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('▸ Two')
    // The small bar, not one the width of the band.
    const cells = (await ui.findAll({ type: 'Text', text: /[█▓▒░]/ })).map((t: { text: string }) => t.text).join('')
    expect(cells.length).toBeLessThanOrEqual(10)
    await ui.unmount()
  }

  const full = await band($)
  const cells = (await full.findAll({ type: 'Text', text: /[█▓▒░]/ })).map((t: { text: string }) => t.text).join('')
  expect(cells.length).toBe(100)
  await full.unmount()
})

test('a finished list goes green and says how long it took', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }] } as never)
  await clock.advance(5 * 60_000)
  await $.tool.call({ tool: PLAN, advance: true } as never)
  await clock.advance(7 * 60_000)
  await $.tool.call({ tool: PLAN, advance: true } as never)

  // It flashes bright once, then stays green.
  const flash = await band($)
  expect((await flash.find({ type: 'Text', text: /█/ }))?.props?.color).toBe(THEMES.dracula.fg)
  await flash.unmount()
  await clock.advance(2_000)

  const ui = await band($)
  const done = await ui.find({ type: 'Text', text: /✓/ })
  expect(done?.text).toBe('✓ all steps done in 12m')
  expect(done?.props?.color).toBe(THEMES.dracula.green)
  expect((await ui.find({ type: 'Text', text: /█/ }))?.props?.color).toBe(THEMES.dracula.green)
  await ui.unmount()
})

test('a stale list says how to hide it', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)
  for (let i = 0; i < 3; i++) await $.turn.start({ turnId: `t${i}` } as never)

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /not updated/ }))?.text).toBe(' · not updated for 3 turns · /progress clear hides it')
  await ui.unmount()
})

test('no time left from one timed step, nor from steps too uneven to guess from', () => {
  const one = [
    { content: 'a', status: 'completed' as const, startedAt: 0, finishedAt: 60_000 },
    { content: 'b', status: 'pending' as const },
  ]
  expect(timing(one, 60_000).left).toBeNull()

  const uneven = [
    { content: 'a', status: 'completed' as const, startedAt: 0, finishedAt: 10_000 },
    { content: 'b', status: 'completed' as const, startedAt: 10_000, finishedAt: 20_000 },
    { content: 'c', status: 'completed' as const, startedAt: 20_000, finishedAt: 920_000 },
    { content: 'd', status: 'pending' as const },
  ]
  expect(timing(uneven, 920_000).left).toBeNull()

  const even = [
    { content: 'a', status: 'completed' as const, startedAt: 0, finishedAt: 60_000 },
    { content: 'b', status: 'completed' as const, startedAt: 60_000, finishedAt: 150_000 },
    { content: 'c', status: 'pending' as const },
  ]
  expect(timing(even, 150_000).left).toBeGreaterThan(60_000)
})

test('the panel puts sessions that need you first, then working ones', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.check', () => ({ decision: 'allow' }))
  // The list can't be read, so the panel keeps the note's sessions as they are.
  on('tool.call', (_, e) => ({ result: [{ type: 'text', text: e.tool === LIST ? 'unreadable' : '' }] }))
  await startSession($, on)
  await settle()
  const note = 'Linked sessions now (status, not an instruction): calm = local_aa (idle), busy = local_bb (working), stuck = local_cc (waiting for input).'
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: reminder(note) }] } } as never)
  await settle()

  const pane = await $.ui.mount({ plugin: 'progress-crabs', component: 'Pane', requestId: 'task-list', surface: 'terminal', props: { bodyColumns: 60 } } as never)
  const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key)
  expect(keys).toEqual(['open-local_cc', 'open-local_bb', 'open-local_aa'])
  expect(await pane.find({ type: 'Text', text: /needs you/ })).toBeDefined()
  await pane.unmount()
})

test('the Themes panel draws each theme and switches on a press', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
  await startSession($, on)
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)

  const pane = await $.ui.mount({ plugin: 'progress-crabs', component: 'Pane', requestId: 'themes', surface: 'terminal', props: { bodyColumns: 60 } } as never)
  expect(await pane.findAll({ type: 'Button' })).toHaveLength(Object.keys(THEMES).length + 1)
  await pane.press({ key: 'theme-nord' })
  await pane.unmount()

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /▓/ }))?.props?.color).toBe(THEMES.nord.pink)
  await ui.unmount()
})

test('on a light theme every colour role keeps 3:1 contrast', () => {
  for (const [name, P] of Object.entries(THEMES)) {
    const isLight = contrast(P.bg, '#000000') > contrast(P.bg, '#ffffff')
    const roles = isLight ? (['comment', 'green', 'orange', 'pink', 'purple'] as const) : (['green', 'orange', 'pink', 'purple'] as const)
    for (const role of roles) expect([name, role, contrast(P[role], P.bg) >= 3]).toEqual([name, role, true])
  }
})

test("another mod's band beneath ours stacks above it", async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>bars beneath</Text>
  })
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)

  const ui = await band($)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  expect(texts[0]).toBe('bars beneath')
  expect(texts.indexOf('▸ One')).toBeGreaterThan(0)
  await ui.unmount()
})

test('wrap_up checks off every step, pending ones too', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'One', status: 'in_progress' },
      { content: 'Two', status: 'pending' },
      { content: 'Three', status: 'pending' },
    ],
  } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)

  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: /\d\/\d/ }))?.text).toBe('3/3 ')
  await ui.unmount()
})
