import { expect, mock, test } from 'claude-code/testing'

import { barLabel, parseProgress, spawned, treeOrder } from './helpers'

const PANE = { plugin: 'progress-crabs', component: 'Pane', requestId: 'task-list', props: { bodyColumns: 60 } } as const
const BAND = {
  plugin: 'progress-crabs',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const paneText = async ($: any, pattern: RegExp, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ ...PANE, surface } as never)
  const found = await ui.find({ type: 'Text', text: pattern })
  await ui.unmount()
  return found?.text as string | undefined
}

// The engine's own answers beneath the mod: a spawn starts `a1`, tool calls and turns go through.
const engine = (on: any) => {
  mock.clock(on)
  on('agent.spawn', () => ({ agentId: 'a1', model: 'haiku' }))
  on('tool.call', () => ({ result: [{ type: 'text', text: 'ok' }] }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }))
  // The engine's own band, drawn when the mod has nothing to show.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('a progress call reads as a bar: counts, percent, total and steps, done and fail', () => {
  const sh = (args: string) => `bash "$CLAUDE_PROGRESS_SH" ${args}`
  expect(parseProgress(sh('-n frames 96/240 converting'))).toEqual({ name: 'frames', done: 96, total: 240 })
  expect(parseProgress(sh('-n copy 42%'))).toEqual({ name: 'copy', done: 42, total: 100, isPercent: true })
  const total = parseProgress(sh('-n files -t 500'))
  expect(total).toEqual({ name: 'files', done: 0, total: 500 })
  expect(parseProgress(sh('-n files +1'), total ?? undefined)).toEqual({ name: 'files', done: 1, total: 500 })
  expect(parseProgress(sh('-n files done'), { name: 'files', done: 3, total: 500 })).toEqual({ name: 'files', done: 500, total: 500, isOver: true })
  expect(parseProgress(sh('-n files fail "disk full"'))?.isFailed).toBe(true)
  expect(parseProgress('for f in *; do bash "$CLAUDE_PROGRESS_SH" -n "big job" 3/9; done')?.name).toBe('big job')
  expect(parseProgress('ls -la')).toBeNull()
  expect(parseProgress(sh('17/240'))).toBeNull()
  expect(barLabel({ name: 'frames', done: 96, total: 240 })).toBe('frames 96/240')
})

test('helpers nest under the helper that started them, in start order', () => {
  const list = [spawned('b', 'kid', 'Explore', 2, 'a'), spawned('c', 'second', 'Explore', 3), spawned('a', 'first', 'general-purpose', 1), spawned('d', 'orphan', 'x', 4, 'gone')]
  expect(treeOrder(list).map(o => `${o.helper.id}${o.depth}`)).toEqual(['a0', 'b1', 'c0', 'd0'])
})

test('a helper shows working with its tool, then done, and the next prompt clears it', async ($, on) => {
  engine(on)
  await $.agent.spawn({ prompt: 'look', description: 'Search vault notes', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await paneText($, /Helpers/, surface)).toBe('Helpers')
  }
  expect(await paneText($, /Explore/)).toBe('   Explore · 1 tool call')

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await band.find({ type: 'Text', text: /helper/ }))?.text).toBe('🦀 1 helper')
  await band.unmount()

  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', text: '', answer: '' } as never)
  expect(await paneText($, /done/)).toMatch(/^ done/)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await after.find({ type: 'Text', text: /helper/ })).toBeUndefined()
  await after.unmount()

  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as never)
  expect(await paneText($, /Helpers/)).toBeUndefined()
})

test('a stopped helper reads as stopped', async ($, on) => {
  engine(on)
  await $.agent.spawn({ prompt: 'go', description: 'Convert frames', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'aborted', isAborted: true, text: '' } as never)
  expect(await paneText($, /stopped/)).toMatch(/stopped/)
})

test("a helper's progress command draws a bar under its card", async ($, on) => {
  engine(on)
  await $.agent.spawn({ prompt: 'go', description: 'Convert frames', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'Bash', command: 'bash "$CLAUDE_PROGRESS_SH" -n frames 96/240', agentId: 'a1' } as never)
  expect(await paneText($, /96\/240/)).toBe('   frames 96/240')
  expect(await paneText($, /▰/)).toBe('▰▰▰▰▰')
})

test('an agent no list names (a compaction fork) is no helper', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'fork-1' } as never)
  expect(await paneText($, /Helpers/)).toBeUndefined()
})
