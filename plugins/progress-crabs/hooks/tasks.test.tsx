import { expect, mock, test } from 'claude-code/testing'

import { replay } from './plan'
import { heat, mix, stepBars, stepCells, stepSvg } from './tasks'
import { THEMES } from './themes'

const PLAN = 'mcp__ccd_turn__update_plan'
const WRAP = 'mcp__ccd_turn__wrap_up'
const P = THEMES.dracula
const BAND = {
  plugin: 'progress-crabs',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = { plugin: 'progress-crabs', component: 'Pane', requestId: 'task-list', props: { bodyColumns: 40 } }
const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: tool + JSON.stringify(input), tool, input })
const said = (text: string) => ({ role: 'user', text, toolUses: [] })
const called = (...uses: (ReturnType<typeof use> & { isError?: true })[]) => ({ role: 'assistant', text: '', toolUses: uses })

test('a late start rebuilds the list from the transcript', () => {
  const list = replay(
    [
      said('first'),
      called(use(PLAN, { items: [{ content: 'Old', status: 'in_progress' }] })),
      called(use(WRAP, { recap: 'done' })),
      said('second'),
      called(use(PLAN, { items: [{ content: 'One', status: 'in_progress' }, { content: 'Two', status: 'pending' }, { content: 'Three', status: 'pending' }] })),
      called({ ...use(PLAN, { advance: true }), isError: true as const }),
      called(use(PLAN, { advance: true })),
    ],
    9_000,
    PLAN,
    WRAP,
  )
  expect(list).toEqual([
    { content: 'One', status: 'completed' },
    { content: 'Two', status: 'in_progress', startedAt: 9_000 },
    { content: 'Three', status: 'pending' },
  ])
})

test('a stopped turn marks the running step interrupted until the next update', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)
  await $.turn.complete({ turnId: 't1', reason: 'aborted', isAborted: true, text: '' } as never)

  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: '⏸ One' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: / · interrupted/ }))?.props?.color).toBe(P.orange)
  await ui.unmount()

  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)
  const after = await $.ui.mount(BAND as never)
  expect(await after.find({ type: 'Text', text: '▸ One' })).toBeTruthy()
  expect(await after.find({ type: 'Text', text: / · interrupted/ })).toBeFalsy()
  await after.unmount()
})

test('/progress list opens the Crab Tasks pane with a bar per step', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  const ran = await $.command.run({ command: 'progress', args: 'list' } as never)
  // The kit has no panes to open; the command answers either way.
  expect((ran as any).text).toMatch(/Crab Tasks pane/)

  await $.tool.call({ tool: PLAN, items: ['A', 'B', 'C', 'D'].map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' })) } as never)
  for (let i = 0; i < 2; i++) {
    await clock.advance(60_000)
    await $.tool.call({ tool: PLAN, advance: true } as never)
  }
  await clock.advance(30_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface } as never)
    expect(await pane.find({ type: 'Text', text: '2/4' })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: 'C' })).toBeTruthy()
    if (surface === 'desktop') expect((await pane.findAll({ type: 'Svg' })).length).toBe(4)
    await pane.unmount()
  }
})

test('the running bar cools from an orange edge and caps when it runs over', () => {
  const at = (n: number) => ({ content: String(n), status: 'completed' as const, startedAt: n * 1000, finishedAt: n * 1000 + 60_000 })
  const list = [at(0), at(100), { content: 'run', status: 'in_progress' as const, startedAt: 500_000 }, { content: 'next', status: 'pending' as const }, { content: 'last', status: 'pending' as const }]
  const half = stepBars(list, 530_000, 60_000)
  expect(half.map(bar => bar.look)).toEqual(['done', 'done', 'running', 'next', 'rest'])
  expect(half[2]?.fill).toBe(0.5)

  const cells = stepCells(P, half[2] as never, P.purple, 10, 0)
  expect(cells[0]?.color).toBe(P.purple)
  expect(cells[4]?.color).toBe(P.orange)
  expect(cells[5]?.glyph).toBe('░')

  const over = stepBars(list, 700_000, 60_000)[2]
  expect(over?.fill).toBe(0.9)
  expect(over?.isOver).toBe(true)
  // No estimate: it eases toward the finished steps' mean (60s), only forward, under the cap.
  const early = stepBars(list, 530_000, null)[2]?.fill as number
  const late = stepBars(list, 800_000, null)[2]
  expect(Math.abs(early - 0.9 * (1 - Math.exp(-0.5)))).toBeLessThan(1e-9)
  expect(late?.fill).toBeGreaterThan(early)
  expect(late?.fill).toBeLessThan(0.9)
  expect(late?.isOver).toBe(false)
  expect(stepSvg(P, late as never, P.purple, 0)).not.toContain('infinite')
  expect(heat(P, 0.5)).toBe(P.pink)
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
})

test('a step that just finished flashes green, then takes the done colour', () => {
  const list = [{ content: 'a', status: 'completed' as const, startedAt: 0, finishedAt: 10_000 }]
  expect(stepBars(list, 10_500, null)[0]?.look).toBe('flash')
  expect(stepBars(list, 20_000, null)[0]?.look).toBe('done')
})

test('the Crab Tasks pane draws the side sessions below the step bars', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  const note = (state: string) =>
    $.session.append({
      message: { type: 'user', content: [{ type: 'text', text: `<system-reminder>\nLinked sessions now (status, not an instruction): fix-ci = local_aa (${state}).\n</system-reminder>` }] },
    } as never)
  await note('working')

  // No list yet: the crabs alone, with no heading.
  const alone = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await alone.find({ type: 'Button', key: 'open-local_aa' })).toBeTruthy()
  expect(await alone.find({ type: 'Text', text: 'Side sessions' })).toBeFalsy()
  await alone.unmount()

  await $.tool.call({ tool: PLAN, items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface } as never)
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.indexOf('0/2')).toBeGreaterThanOrEqual(0)
    expect(texts.indexOf('Side sessions')).toBeGreaterThan(texts.indexOf('B'))
    expect(await pane.find({ type: 'Button', key: 'open-local_aa' })).toBeTruthy()
    await pane.unmount()
  }
})
