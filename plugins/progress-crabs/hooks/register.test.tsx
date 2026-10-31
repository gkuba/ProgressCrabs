import { expect, mock, test } from 'claude-code/testing'

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

test('the band follows the task list and linked sessions', async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Look around', status: 'in_progress' },
      { content: 'Build it', status: 'pending' },
      { content: 'Ship it', status: 'pending' },
    ],
  } as never)
  await $.tool.call({ tool: PLAN, advance: true } as never)
  await $.session.append({
    message: {
      type: 'user',
      content: [{ type: 'text', text: 'Linked sessions now (status, not an instruction): fix-ci = local_c715bf35-ac66 (working).' }],
    },
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toBe('1/3 ')
    expect((await ui.find({ type: 'Text', text: /Build it/ }))?.text).toBe('▸ Build it')
    expect((await ui.find({ type: 'Text', text: /fix-ci/ }))?.text).toBe('fix-ci ')
    await ui.unmount()
  }
})

test('an empty task list leaves the band to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the band shows the running step and a rough time left', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'One', status: 'in_progress' },
      { content: 'Two', status: 'pending' },
      { content: 'Three', status: 'pending' },
    ],
  } as never)
  await clock.advance(10 * 60_000)
  await $.tool.call({ tool: PLAN, advance: true } as never)
  await clock.advance(4 * 60_000)
  await $.tool.call({ tool: PLAN, done: [] } as never)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toBe(' · 4m · ~16m left (rough)')
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})

test('a turn with no task list shows what Claude is doing', async ($, on) => {
  const clock = mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  // The session's ticker redraws the elapsed time.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await clock.advance(45_000)
  const thinking = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await thinking.find({ type: 'Text', text: /thinking/ }))?.text).toBe('thinking · 45s')
  await thinking.unmount()

  await $.tool.call({ tool: 'mcp__obsidian__get_vault_file' } as never)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /thinking/ }))?.text).toBe('thinking · 45s')
  await after.unmount()

  await $.turn.complete({ turnId: 't1', reason: 'answer', text: '' } as never)
  const idle = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: false } })
  expect((await idle.find({ type: 'Text' }))?.text).toBe('engine')
  await idle.unmount()
})

test('the side sessions panel shows a card per session and toasts a finish', async ($, on) => {
  mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', (_, e) =>
    e.tool === 'mcp__ccd_session_mgmt__list_sessions'
      ? { result: [{ type: 'text', text: JSON.stringify([{ sessionId: 'local_c715bf35-ac66', title: 'Set up ComfyUI' }]) }] }
      : { result: [{ type: 'text', text: 'Session "x" (idle)\n\n[assistant] The **quickstart** is written.\n[result] done' }] },
  )
  const say = (state: string) =>
    $.session.append({
      message: {
        type: 'user',
        content: [{ type: 'text', text: `Linked sessions now (status, not an instruction): fix-ci = local_c715bf35-ac66 (${state}).` }],
      },
    } as never)

  await say('working')
  await say('idle')
  await new Promise(r => setTimeout(r, 20))
  expect(toasts.some(t => /finished a turn/.test(t))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'progress-crabs',
      component: 'Pane',
      requestId: 'linked-sessions',
      surface,
      props: { title: 'Side sessions', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    } as never)
    expect(await ui.find({ type: 'Button', text: /Set up ComfyUI/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    else expect((await ui.find({ type: 'Text', text: /quickstart/ }))?.text).toBe('   The quickstart is written.')
    await ui.unmount()
  }
})

test('/progress theme lists, switches and resets the colours', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('tool.call', () => ({ result: {} }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'in_progress' }] } as never)

  const pill = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const color = (await ui.find({ type: 'Text', text: /█/ }))?.props?.color
    await ui.unmount()
    return color
  }

  const listed = await $.command.run({ command: 'progress', args: 'theme' } as never)
  expect(JSON.stringify(listed)).toContain('▸ dracula')
  expect(await pill()).toBe('#ff79c6')

  await $.command.run({ command: 'progress', args: 'theme nord' } as never)
  expect(await pill()).toBe('#b48ead')

  const unknown = await $.command.run({ command: 'progress', args: 'theme solarized' } as never)
  expect(JSON.stringify(unknown)).toContain('No theme')

  await $.command.run({ command: 'progress', args: 'theme default' } as never)
  expect(await pill()).toBe('#ff79c6')
})

test('the settings pick the theme and override single colours', { options: { theme: 'gruvbox', current_color: '#123456' } }, async ($, on) => {
  mock.clock(on)
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'pending' }] } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1\/2/ }))?.props?.color).toBe('#83a598')
  await ui.unmount()
})
