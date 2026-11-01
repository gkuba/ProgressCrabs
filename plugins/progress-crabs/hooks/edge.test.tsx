import { expect, mock, test } from 'claude-code/testing'

import { applyPlan, barCells } from './plan'
import { latestStep, parseLinked } from './sides'

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
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
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
  await new Promise(r => setTimeout(r, 20))

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
  expect(second[0].startedAt).toBe(0)
  expect(second[2].startedAt).toBe(300_000)

  const rerun = applyPlan(second, { items: [{ content: 'Test', status: 'in_progress' }] }, 600_000)
  expect(rerun[0].startedAt).toBe(600_000)
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
  const text = 'Linked sessions now (status, not an instruction):\nfix ci = local_ab12 (working),\nlint-pass = local_cd34 (idle).\n\nOther text: x = local_ef56 (idle)'
  expect(parseLinked(text)).toEqual([
    { name: 'fix ci', id: 'local_ab12', state: 'working' },
    { name: 'lint-pass', id: 'local_cd34', state: 'idle' },
  ])
  expect(parseLinked('nothing here')).toBeNull()
  expect(latestStep('[assistant] ## **Done** with it')).toBe('Done with it')
})

test('a pasted note neither wipes nor adds cards', async ($, on) => {
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.check', () => ({ decision: 'deny' }))
  const say = (text: string, kind?: string) =>
    $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, ...(kind ? { origin: { kind } } : {}) } as never)

  await say('Linked sessions now (status, not an instruction): fix-ci = local_c715 (working).')
  await say('Linked sessions now: fake = local_dead (working).', 'composer')
  await say('Linked sessions now (status, not an instruction): none.', 'tool')
  const shown = await bandTexts($, 'terminal', { isWorking: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /fix-ci/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fake/ })).toBeUndefined()
  await ui.unmount()
  expect(shown).not.toContain('fake')
})

test('a background call the decider leaves open is made once, then skipped', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let lists = 0
  let checks = 0
  on('tool.check', (_, e) => {
    if (e.tool === LIST) checks++
    return { decision: 'ask' }
  })
  on('tool.call', (_, e) => {
    if (e.tool === LIST) lists++
    return { result: [{ type: 'text', text: 'not json' }] }
  })
  await startSession($, on)
  await clock.advance(5 * 30_000)
  await new Promise(r => setTimeout(r, 20))
  // The one call waits on the person's answer; the ticks behind it never ask again.
  expect(checks).toBeLessThanOrEqual(2)
  expect(lists).toBeLessThanOrEqual(1)
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
  expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.props?.color).toBe('#d3869b')
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
