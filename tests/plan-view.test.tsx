import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

const PLAN = '/Users/someone/.claude/plans/a-plan.md'
const WIDE = { columns: 200, rows: 50, isFullscreen: true }
/** A phone attached to the session draws the pane too, narrow and with no dock. */
const PHONE = { columns: 40, rows: 80, isFullscreen: false }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'plan-view',
  component: 'Pane',
  requestId: 'plan',
  props: {
    title: 'Plan',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'plan-view',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 150,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const savedKey = (sessionId: string) => `session:${sessionId}`

/** Stands in for Claude Code beneath the plugin, and records what the plugin asks of it. */
function fakeEngine(
  on: On,
  {
    // What the engine answers when the plugin opens the pane.
    isPlaced = true,
    // Whether the pane is listed as open while opened and not since closed.
    tracksPanes = false,
    // Whether the pane is open at the start, as after a reload.
    isOpenAtStart = false,
    // What the plugin's store holds at the start.
    store = {},
    // The paths that exist.
    files = [PLAN],
    // The plan file's text.
    text = '# The plan\n\n- step one',
    // What a tool call resolves to.
    ran = { result: {} },
  }: {
    isPlaced?: boolean
    tracksPanes?: boolean
    isOpenAtStart?: boolean
    store?: Record<string, unknown>
    files?: string[]
    text?: string
    ran?: { result: unknown; isError?: true } | { deny: string }
  } = {},
) {
  const opens: { columns?: number; backgroundColor?: string }[] = []
  const closes: string[] = []
  const pane = { id: 'plan', title: 'Plan', isShown: true, isFocused: false, isPlaced }
  let isPaneOpen = isOpenAtStart
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.attachment', (_, e) => ({ text: e.text }))
  on('tool.call', () => ran)
  on('ui.panes', () => ({ value: tracksPanes && isPaneOpen ? [pane] : [] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.open', (_, e) => {
    opens.push(e)
    isPaneOpen = true
    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', (_, e) => {
    closes.push(e.origin.kind)
    isPaneOpen = false
    return { value: undefined }
  })

  let fileText = text
  const existing = new Set(files)
  // Only the files that exist can be read; any other path falls through to
  // the kit, which rejects it as missing.
  on('fs.read', (_, e, next) => (existing.has(e.path) ? { value: fileText } : next(e)))
  on('fs.exists', (_, e) => ({ value: existing.has(e.path) }))

  let sessionId = 'session-1'
  on('session.id', () => ({ value: sessionId }))

  // Keys keep the order they were first set in, like the real store's.
  const saved: Record<string, unknown> = { ...store }
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(saved) }))

  // The test kit can't raise ui.close, so the plugin's close hook goes
  // untested. closeByHand fakes its effect instead: the plan reads as
  // dismissed until the plugin next saves it, and the session is saved as
  // the hook saves it.
  let isClosedByHand = false
  on('state.get', async (_, e, next) => {
    const got = await next(e)
    const stored = got.value?.value as { shape: string; value: object } | undefined
    if (!isClosedByHand || !got.value || !stored) return got
    const value = { ...stored, value: { ...stored.value, isDismissed: true } }
    return { value: { ...got.value, value } }
  })
  on('state.set', (_, e, next) => {
    if (e.key === 'plan') isClosedByHand = false
    return next(e)
  })

  return {
    opens,
    closes,
    saved,
    closeByHand: () => {
      isClosedByHand = true
      isPaneOpen = false
      const key = savedKey(sessionId)
      saved[key] = { ...(saved[key] as object), isOpen: false, isDismissed: true }
    },
    // Changes the plan file as an edit outside Write and Edit would.
    setText: (next: string) => {
      fileText = next
    },
    // Deletes a file, as a person might while Claude Code runs.
    removeFile: (path: string) => {
      existing.delete(path)
    },
    // Changes the session id, as a /clear or an in-app resume does.
    setSession: (id: string) => {
      sessionId = id
    },
  }
}

/** Draws the band above the prompt, which is how the plugin learns the layout. */
async function learnLayout($: Engine, viewport: { columns: number; rows: number; isFullscreen: boolean }) {
  const band = await $.ui.mount({ ...BAND, viewport })
  await band.unmount()
}

/** The plugin reads the plan back through fs.read, so the pane shows fakeEngine's `text`, not this `content`. */
const writePlan = ($: Engine, file_path = PLAN, agentId?: string) =>
  $.tool.call({ tool: 'Write', file_path, content: '# The plan', ...(agentId ? { agentId } : {}) })

const editPlan = ($: Engine) => $.tool.call({ tool: 'Edit', file_path: PLAN, old_string: 'a', new_string: 'b' })

/** Runs /plan-view as typed in a terminal of the given layout. */
const runCommand = ($: Engine, presentation = { isFullscreen: true, columns: 200 }) =>
  $.command.run({ command: 'plan-view', args: '', origin: { kind: 'composer' }, presentation })

const commandText = async ($: Engine) => (await runCommand($)).text

const planModeNote = (
  $: Engine,
  { path = PLAN, hasPlan = true, agentId }: { path?: string; hasPlan?: boolean; agentId?: string } = {},
) =>
  $.prompt.attachment({
    type: 'plan_mode',
    text: 'Plan mode is active.',
    origin: { kind: 'engine' },
    detail: { reminder: 'full', planFilePath: path, hasPlan },
    ...(agentId ? { agentId } : {}),
  })

const planModeExit = ($: Engine) =>
  $.prompt.attachment({
    type: 'plan_mode_exit',
    text: 'Plan mode has ended.',
    origin: { kind: 'engine' },
    detail: { planFilePath: PLAN, hasPlan: true },
  })

const planModeReentry = ($: Engine) =>
  $.prompt.attachment({
    type: 'plan_mode_reentry',
    text: 'Plan mode is active again.',
    origin: { kind: 'engine' },
    detail: { planFilePath: PLAN },
  })

const startSession = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const endSession = ($: Engine, reason: 'clear' | 'resume') =>
  $.session.end({ reason, sessionId: 'session-1', resume: { id: 'session-1' } })

const mountPane = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({ ...PANE, surface, viewport: WIDE })

/** All the Markdown the pane draws, joined. */
async function drawnMarkdown($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await mountPane($, surface)
  const drawn = (await ui.findAll({ type: 'Markdown' })).map(element => element.text).join('\n')
  await ui.unmount()
  return drawn
}

/** A saved session entry for session-1. */
const savedPlan = (session: Record<string, unknown> = {}) => ({ [savedKey('session-1')]: { path: PLAN, ...session } })

/** Plan paths for `count` other sessions. */
const oldPaths = (count: number) => Array.from({ length: count }, (_, i) => `/p/${i}.md`)

/** Saved entries for `count` other sessions, oldest first. Their plan files exist only if passed in `files`. */
const oldSessions = (count: number) =>
  Object.fromEntries(oldPaths(count).map((path, i) => [savedKey(`old-${i}`), { path }]))

describe('auto-open', () => {
  test('opens at 45% width on a wide fullscreen terminal', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)

    expect(opens.length).toBe(1)
    expect(opens[0]?.columns).toBe(90)
  })

  test("opens with no background, so the terminal's shows through", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)

    expect(opens[0]?.backgroundColor).toBe('transparent')
  })

  test("doesn't open outside the fullscreen layout", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, { ...WIDE, isFullscreen: false })
    await writePlan($)

    expect(opens.length).toBe(0)
  })

  test('a main-screen terminal keeps it from opening on its own, even with a fullscreen desktop attached', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, { ...WIDE, isFullscreen: false })
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop', viewport: WIDE })
    await desktop.unmount()
    await writePlan($)

    expect(opens.length).toBe(0)
  })

  test("closes again when Claude Code can't place it (too narrow), instead of waiting", async ($, on) => {
    // isPlaced: false stands in for Claude Code refusing; the plugin never compares widths itself.
    const { opens, closes } = fakeEngine(on, { isPlaced: false })
    await learnLayout($, WIDE)
    await writePlan($)

    expect(opens.length).toBe(1)
    expect(closes).toEqual(['plugin'])
  })

  test("doesn't reopen an open pane on each edit", async ($, on) => {
    const { opens } = fakeEngine(on, { tracksPanes: true })
    await learnLayout($, WIDE)
    await writePlan($)
    await editPlan($)

    expect(opens.length).toBe(1)
  })

  test("a phone drawing the pane doesn't stop it opening on the terminal", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile', viewport: PHONE })
    await phone.unmount()
    await writePlan($)

    expect(opens.length).toBe(1)
    expect(opens[0]).toMatchObject({ columns: 90, rows: 50 })
  })
})

describe('which writes count as the plan', () => {
  test('writes to other files are ignored', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($, '/tmp/notes.md')

    expect(opens.length).toBe(0)
  })

  test('a plan file with Windows separators counts', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($, 'C:\\Users\\someone\\.claude\\plans\\a-plan.md')

    expect(opens.length).toBe(1)
  })

  test("before any plan-mode note, a project's own .claude/plans file is ignored", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($, '/work/project/.claude/plans/notes.md')

    expect(opens.length).toBe(0)
    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  test("before any plan-mode note, another plan file doesn't replace the current plan", async ($, on) => {
    const { saved } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    await writePlan($, '/Users/someone/.claude/plans/old-plan.md')

    expect(saved[savedKey('session-1')]).toMatchObject({ path: PLAN })
  })

  test("a subagent's own plan file is ignored", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($, '/Users/someone/.claude/plans/a-plan-agent-1.md', 'agent-1')

    expect(opens.length).toBe(0)
    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  test('the plan-mode note names the plan', async ($, on) => {
    fakeEngine(on)
    await planModeNote($)

    expect(await commandText($)).toBe('Plan pane opened.')
  })

  test('a plan first named by the plan-mode note opens the pane, as a write would', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await planModeNote($)

    expect(opens.length).toBe(1)
    expect(opens[0]?.columns).toBe(90)
  })

  test("a subagent's plan-mode note is ignored", async ($, on) => {
    fakeEngine(on)
    await planModeNote($, { agentId: 'agent-1' })

    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  test('a plan outside .claude/plans counts once the plan-mode note names it', async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    const elsewhere = '/work/project/docs/plans/a-plan.md'
    await planModeNote($, { path: elsewhere, hasPlan: false })
    await writePlan($, elsewhere)

    expect(opens.length).toBe(1)
  })

  test('once the plan-mode note names the plan, other plan files are ignored', async ($, on) => {
    const { opens } = fakeEngine(on, { files: [] })
    await learnLayout($, WIDE)
    await planModeNote($, { hasPlan: false })
    await writePlan($, '/Users/someone/.claude/plans/old-plan.md')

    expect(opens.length).toBe(0)
    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  for (const [outcome, ran] of [
    ['failed', { result: 'File has not been read yet.', isError: true }],
    ['refused', { deny: 'The user declined.' }],
  ] as const) {
    test(`a ${outcome} write is ignored`, async ($, on) => {
      const { opens } = fakeEngine(on, { ran })
      await learnLayout($, WIDE)
      await writePlan($)

      expect(opens.length).toBe(0)
      expect(await commandText($)).toBe('No plan yet in this session.')
    })
  }
})

describe('/plan-view', () => {
  test('opens the pane at any width', async ($, on) => {
    const { opens } = fakeEngine(on)
    const small = { columns: 80, rows: 30, isFullscreen: false }
    await learnLayout($, small)
    await writePlan($)
    expect(opens.length).toBe(0)

    expect((await runCommand($, small)).text).toBe('Plan pane opened.')
    expect(opens.length).toBe(1)
    expect(opens[0]?.columns).toBe(36)
  })

  test('says so when there is no plan yet', async ($, on) => {
    const { opens } = fakeEngine(on)

    expect(await commandText($)).toBe('No plan yet in this session.')
    expect(opens.length).toBe(0)
  })

  test('shows the plan the plan-mode note named, even if no write announced it', async ($, on) => {
    const { opens, saved } = fakeEngine(on)
    await planModeNote($, { hasPlan: false })

    expect(await commandText($)).toBe('Plan pane opened.')
    expect(opens.length).toBe(1)
    expect(saved[savedKey('session-1')]).toMatchObject({ path: PLAN, isOpen: true })
    expect(await drawnMarkdown($)).toContain('step one')
  })

  test("still says so while the plan file the note named doesn't exist", async ($, on) => {
    const { opens } = fakeEngine(on, { files: [] })
    await planModeNote($, { hasPlan: false })

    expect(await commandText($)).toBe('No plan yet in this session.')
    expect(opens.length).toBe(0)
  })

  test("says so when the pane can't be placed, and doesn't save it as open", async ($, on) => {
    const { opens, saved } = fakeEngine(on, { isPlaced: false })
    await writePlan($)

    expect(await commandText($)).toBe("The plan pane can't be shown here: narrow")
    expect(opens.length).toBe(1)
    expect((saved[savedKey('session-1')] as { isOpen?: boolean }).isOpen).toBeUndefined()
  })

  test("when the pane can't be placed, a close by hand still holds", async ($, on) => {
    const { saved } = fakeEngine(on, { isPlaced: false, store: savedPlan({ isOpen: false, isDismissed: true }) })
    await startSession($)
    await runCommand($)

    expect(saved[savedKey('session-1')]).toMatchObject({ isDismissed: true })
  })

  test("a phone drawing the pane doesn't narrow the width it asks for", async ($, on) => {
    const { opens } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile', viewport: PHONE })
    await phone.unmount()
    await runCommand($)

    expect(opens.at(-1)).toMatchObject({ columns: 90, rows: 50 })
  })
})

describe('closing by hand', () => {
  test('stays closed while Claude rewrites the plan', async ($, on) => {
    const { opens, closeByHand } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    closeByHand()
    await writePlan($)

    expect(opens.length).toBe(1)
  })

  test('opens again for the next plan in the same file', async ($, on) => {
    const { opens, closeByHand } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    closeByHand()
    await planModeReentry($)
    await writePlan($)

    expect(opens.length).toBe(2)
  })

  test("is saved, and Claude's edits don't undo it", async ($, on) => {
    const { saved, closeByHand } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    closeByHand()
    await editPlan($)

    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: false, isDismissed: true })
  })

  test('/plan-view undoes it', async ($, on) => {
    const { saved, closeByHand } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)
    closeByHand()
    await runCommand($)
    await editPlan($)

    expect(saved[savedKey('session-1')]).toMatchObject({ isDismissed: false })
  })

  test('stays closed after a restart while Claude edits the plan', async ($, on) => {
    const { opens } = fakeEngine(on, { store: savedPlan({ isOpen: false, isDismissed: true }) })
    await startSession($)
    await learnLayout($, WIDE)
    await editPlan($)

    expect(opens.length).toBe(0)
  })
})

describe('saved sessions', () => {
  test('a resumed session finds its plan', async ($, on) => {
    fakeEngine(on, { store: savedPlan() })
    await startSession($)

    expect(await commandText($)).toBe('Plan pane opened.')
  })

  test('at startup, a saved plan whose file is gone is forgotten', async ($, on) => {
    const { saved } = fakeEngine(on, { store: savedPlan(), files: [] })
    await startSession($)

    expect(await commandText($)).toBe('No plan yet in this session.')
    expect(Object.keys(saved)).toEqual([])
  })

  test('at startup, other sessions whose plan files are gone are forgotten', async ($, on) => {
    const kept = { path: '/elsewhere/kept.md' }
    const { saved } = fakeEngine(on, {
      store: { ...oldSessions(2), [savedKey('session-2')]: kept },
      files: [PLAN, kept.path],
    })
    await startSession($)

    expect(Object.keys(saved)).toEqual([savedKey('session-2')])
  })

  test('a saved entry of the wrong shape is ignored', async ($, on) => {
    fakeEngine(on, { store: { [savedKey('session-1')]: { path: 3 } } })
    await startSession($)

    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  test("a write keeps other sessions' entries", async ($, on) => {
    const other = { path: '/elsewhere/plan.md' }
    const { saved } = fakeEngine(on, { store: { [savedKey('session-2')]: other } })
    await learnLayout($, WIDE)
    await writePlan($)

    expect(saved[savedKey('session-2')]).toEqual(other)
    expect((saved[savedKey('session-1')] as { path: string }).path).toBe(PLAN)
  })

  test('only the 100 most recently used sessions are kept', async ($, on) => {
    const { saved } = fakeEngine(on, { store: oldSessions(100) })
    await writePlan($)

    const keys = Object.keys(saved)
    expect(keys.length).toBe(100)
    expect(keys).not.toContain(savedKey('old-0'))
    expect(keys.at(-1)).toBe(savedKey('session-1'))
  })

  test('resuming a session counts as using it, so pruning keeps it', async ($, on) => {
    const { saved, setSession } = fakeEngine(on, {
      store: { ...savedPlan(), ...oldSessions(99) },
      files: [PLAN, ...oldPaths(99)],
    })
    await startSession($)
    setSession('session-2')
    await writePlan($)

    expect(Object.keys(saved)).toContain(savedKey('session-1'))
    expect(Object.keys(saved)).not.toContain(savedKey('old-0'))
  })

  test("an open pane is saved as open, with the terminal's width", async ($, on) => {
    const { saved } = fakeEngine(on)
    await learnLayout($, WIDE)
    await writePlan($)

    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: true, terminalColumns: 200 })
  })

  test('a resumed session reopens a pane that was open', async ($, on) => {
    const { opens } = fakeEngine(on, { store: savedPlan({ isOpen: true, terminalColumns: 200 }) })
    await startSession($)

    expect(opens.length).toBe(1)
    expect(opens[0]?.columns).toBe(90)
  })

  test('a resumed pane follows the current Pane width setting', { options: { width: 'narrow' } }, async ($, on) => {
    const { opens } = fakeEngine(on, { store: savedPlan({ isOpen: true, terminalColumns: 200 }) })
    await startSession($)

    expect(opens[0]?.columns).toBe(60)
  })

  test(
    'a reload leaves a pane that stayed open at its size, so a new Pane width waits',
    { options: { width: 'narrow' } },
    async ($, on) => {
      const { opens } = fakeEngine(on, {
        store: savedPlan({ isOpen: true, terminalColumns: 200 }),
        tracksPanes: true,
        isOpenAtStart: true,
      })
      await startSession($)
      await learnLayout($, { columns: 110, rows: 50, isFullscreen: true })
      await editPlan($)

      expect(opens.length).toBe(0)
    },
  )

  test("/plan-view above the prompt doesn't save its width, which a docked pane ignores", async ($, on) => {
    const { saved } = fakeEngine(on, { store: savedPlan({ isOpen: false, terminalColumns: 200 }) })
    await startSession($)
    await runCommand($, { isFullscreen: false, columns: 80 })

    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: true, terminalColumns: 200 })
  })

  test('a resumed session leaves a closed pane closed', async ($, on) => {
    const { opens } = fakeEngine(on, { store: savedPlan({ isOpen: false }) })
    await startSession($)

    expect(opens.length).toBe(0)
  })

  test('a resumed pane the terminal is too narrow for is left waiting, and still saved as open', async ($, on) => {
    const { closes, saved } = fakeEngine(on, { store: savedPlan({ isOpen: true }), isPlaced: false })
    await startSession($)

    expect(closes).toEqual([])
    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: true })
  })

  test('an edit leaves a resumed pane waiting for room alone', async ($, on) => {
    const { opens, closes } = fakeEngine(on, { store: savedPlan({ isOpen: true }), isPlaced: false, tracksPanes: true })
    await startSession($)
    await learnLayout($, { columns: 120, rows: 40, isFullscreen: true })
    await editPlan($)

    expect(opens.length).toBe(1)
    expect(closes).toEqual([])
  })

  test('after /clear the old plan is gone and not saved for the new session', async ($, on) => {
    const { saved, setSession } = fakeEngine(on)
    await startSession($)
    await writePlan($)
    await endSession($, 'clear')
    setSession('session-2')

    expect(await commandText($)).toBe('No plan yet in this session.')
    expect(Object.keys(saved)).toEqual([savedKey('session-1')])
  })

  test('/clear closes the pane', async ($, on) => {
    const { closes, saved } = fakeEngine(on)
    await startSession($)
    await learnLayout($, WIDE)
    await writePlan($)
    await endSession($, 'clear')

    expect(closes).toEqual(['plugin'])
    // The plugin's own close isn't the person's, so resuming session-1 brings the pane back.
    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: true })
  })

  test("after /clear, the new session's first plan opens the pane again", async ($, on) => {
    const { opens, setSession } = fakeEngine(on, { tracksPanes: true })
    await startSession($)
    await learnLayout($, WIDE)
    await writePlan($)
    await endSession($, 'clear')
    setSession('session-2')
    await writePlan($)

    expect(opens.length).toBe(2)
  })

  test('an in-app resume into a session whose pane was closed leaves it closed', async ($, on) => {
    const { opens, closes, saved, setSession } = fakeEngine(on, {
      store: { [savedKey('session-2')]: { path: PLAN, isOpen: false } },
    })
    await startSession($)
    await learnLayout($, WIDE)
    await writePlan($)
    await endSession($, 'resume')
    setSession('session-2')
    await $.turn.start({ text: 'go on', turnId: 'turn-1' })

    expect(closes).toEqual(['plugin'])
    expect(opens.length).toBe(1)
    expect(saved[savedKey('session-1')]).toMatchObject({ isOpen: true })
  })

  test('an in-app resume into a session whose plan file is gone forgets it', async ($, on) => {
    const { opens, saved, setSession, removeFile } = fakeEngine(on, {
      store: { [savedKey('session-2')]: { path: PLAN, isOpen: true } },
    })
    await startSession($)
    removeFile(PLAN)
    await endSession($, 'resume')
    setSession('session-2')
    await $.turn.start({ text: 'go on', turnId: 'turn-1' })

    expect(Object.keys(saved)).not.toContain(savedKey('session-2'))
    expect(opens.length).toBe(0)
    expect(await commandText($)).toBe('No plan yet in this session.')
  })

  test("an in-app resume finds the resumed session's plan at its first turn", async ($, on) => {
    const { opens, setSession } = fakeEngine(on, { store: { [savedKey('session-2')]: { path: PLAN, isOpen: true } } })
    await startSession($)
    await endSession($, 'resume')
    setSession('session-2')
    await $.turn.start({ text: 'go on', turnId: 'turn-1' })

    expect(opens.length).toBe(1)
    expect(await commandText($)).toBe('Plan pane opened.')
  })
})

describe('settings', () => {
  test(
    'auto-open off: writes never open the pane, /plan-view still does',
    { options: { autoOpen: false } },
    async ($, on) => {
      const { opens } = fakeEngine(on)
      await learnLayout($, WIDE)
      await writePlan($)

      expect(opens.length).toBe(0)
      expect(await commandText($)).toBe('Plan pane opened.')
    },
  )

  for (const [width, percent, columns] of [
    ['narrow', 30, 60],
    ['medium', 38, 76],
    ['wide', 45, 90],
  ] as const) {
    test(`${width} width asks for ${percent}% of the terminal`, { options: { width } }, async ($, on) => {
      const { opens } = fakeEngine(on)
      await learnLayout($, WIDE)
      await writePlan($)

      expect(opens[0]?.columns).toBe(columns)
    })
  }

  test("a table takes the pane's width, less its padding", async ($, on) => {
    fakeEngine(on, { text: `| a |\n|---|\n| ${'word '.repeat(20).trim()} |` })
    await writePlan($)
    const ui = await mountPane($)

    // 60 columns, less 1 of padding on each side.
    const cell = (await ui.findAll({ type: 'Box' })).find(box => typeof box.props.width === 'number')
    expect(cell?.props.width).toBe(58)
    await ui.unmount()
  })
})

describe('rendering', () => {
  test('shows the plan file path, then the plan, on every surface', async ($, on) => {
    fakeEngine(on)
    await writePlan($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const shown = (await ui.findAll({})).filter(element => element.type === 'Text' || element.type === 'Markdown')
      expect(shown.map(element => element.text)).toEqual([PLAN, '# The plan\n\n- step one'])
      await ui.unmount()
    }
  })

  // Being display-only is a product rule: the pane shows the plan and takes no input.
  test('the pane is display-only: no Buttons on any surface', async ($, on) => {
    fakeEngine(on)
    await writePlan($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
      await ui.unmount()
    }
  })

  test("says so when the plan file can't be read", async ($, on) => {
    fakeEngine(on, { files: [] })
    await writePlan($)
    const ui = await mountPane($)

    expect((await ui.findAll({ type: 'Text' })).map(element => element.text).join('')).toBe(
      `Can't read the plan file: ${PLAN}`,
    )
    await ui.unmount()
  })

  test("redraws after an edit at Claude Code's plan approval", async ($, on) => {
    const { setText } = fakeEngine(on)
    await writePlan($)
    const ui = await mountPane($)
    setText('# The plan\n\n- edited by hand')
    await $.tool.call({ tool: 'ExitPlanMode' })

    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# The plan\n\n- edited by hand')
    await ui.unmount()
  })

  test('re-reads the plan file on each plan-mode note', async ($, on) => {
    const { setText } = fakeEngine(on)
    await writePlan($)
    const ui = await mountPane($)
    setText('# The plan\n\n- edited elsewhere')
    await planModeNote($)

    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# The plan\n\n- edited elsewhere')
    await ui.unmount()
  })

  test('re-reads the plan file on the note that plan mode ended', async ($, on) => {
    const { setText } = fakeEngine(on)
    await writePlan($)
    const ui = await mountPane($)
    setText('# The plan\n\n- edited elsewhere')
    await planModeExit($)

    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# The plan\n\n- edited elsewhere')
    await ui.unmount()
  })

  test('redraws when a subagent revises the current plan', async ($, on) => {
    const { setText } = fakeEngine(on)
    await writePlan($)
    const ui = await mountPane($)
    setText('# The plan\n\n- revised by a subagent')
    await writePlan($, PLAN, 'agent-1')

    expect((await ui.find({ type: 'Markdown' }))?.text).toBe('# The plan\n\n- revised by a subagent')
    await ui.unmount()
  })

  test('joins lines wrapped for width, and keeps list items apart', async ($, on) => {
    const text = 'Intro wrapped\nover two lines.\n\n1. **One** wrapped\n   over three\n   lines.\n2. Two\n- Three'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(
      'Intro wrapped over two lines.\n\n1. **One** wrapped over three lines.\n2. Two\n- Three',
    )
  })

  test('keeps the lines of code, tables, headings and hard breaks', async ($, on) => {
    const text = [
      'Ends in a hard break  ',
      'next line',
      '',
      '```ts',
      'const a = 1',
      'const b = 2',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '## Heading',
      'text under it',
      '',
      '    indented code',
      '    more code',
    ].join('\n')
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(text)
  })

  test('keeps nested list items and code blocks on their own lines', async ($, on) => {
    const text = '- Step\n  - Run:\n    ```\n    npm test\n    ```\n- a\n  - b\n    - c\n\t- d'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(text)
  })

  test('keeps the lines of an HTML block', async ($, on) => {
    const text = 'Before.\n\n<details>\n<summary>Collapsed</summary>\nHidden text.\n</details>'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(text)
  })

  test('a fence line inside a code block, like ```bash, neither ends the block nor stops later text joining', async ($, on) => {
    const text = '```\nexample:\n```bash\nnpm test\nmore\n```\n\nThis is a\nwrapped paragraph.'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(
      '```\nexample:\n```bash\nnpm test\nmore\n```\n\nThis is a wrapped paragraph.',
    )
  })

  test('a line starting with inline code is not a code block', async ($, on) => {
    fakeEngine(on, { text: '```npm test``` runs\nfirst, then\nthis.' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe('```npm test``` runs first, then this.')
  })

  test('a fence line inside a code block does not stop later tables being drawn', async ($, on) => {
    fakeEngine(on, { text: '```\n```bash\nnpm test\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |' })
    await writePlan($)

    const drawn = await drawnMarkdown($)
    expect(drawn).not.toContain('| a | b |')
    expect(drawn).toEndWith('**a**\n**b**\n1\n2')
  })

  test('a code block opened in a quote ends with the quote', async ($, on) => {
    fakeEngine(on, { text: '> ```\n> code\n\nThis is a\nwrapped paragraph.\n\n```\nx = 1\ny = 2\n```' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(
      '> ```\n> code\n\nThis is a wrapped paragraph.\n\n```\nx = 1\ny = 2\n```',
    )
  })

  test('indented code ends at the first line that is not indented, so a paragraph right after it joins', async ($, on) => {
    fakeEngine(on, { text: '    code\nparagraph\nwrapped' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe('    code\nparagraph wrapped')
  })

  test('indented code that looks like a table stays code', async ($, on) => {
    const text = 'Example:\n\n    a | b\n    --|--\n    1 | 2'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(text)
  })

  test('a table ends at a fence, even one with a `|` in it', async ($, on) => {
    fakeEngine(on, {
      text: '| a | b |\n|---|---|\n| 1 | 2 |\n```sh | tee out\necho a | wc\n```\n\n| c | d |\n|---|---|\n| 3 | 4 |',
    })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(
      ['**a**', '**b**', '1', '2', '```sh | tee out\necho a | wc\n```\n', '**c**', '**d**', '3', '4'].join('\n'),
    )
  })

  test('a line mixing -, * and _ is not a rule, so it joins the paragraph', async ($, on) => {
    fakeEngine(on, { text: 'text\n-*-\nmore' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe('text -*- more')
  })

  test('joins a wrapped line that starts with an inline tag or a component name', async ($, on) => {
    fakeEngine(on, {
      text: 'Move the state into\n<PlanPane> so it can\nredraw itself. Press\n<kbd>Esc</kbd> to close it.',
    })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(
      'Move the state into <PlanPane> so it can redraw itself. Press <kbd>Esc</kbd> to close it.',
    )
  })

  test('a block tag still breaks a paragraph, and a lone tag after a blank line keeps its lines', async ($, on) => {
    const text = 'Text\n<details>\nHidden.\n</details>\n\n<PlanPane>\n  child\n</PlanPane>'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(text)
  })

  test('a quoted blank line ends an HTML block in the quote, so the paragraph after it joins', async ($, on) => {
    fakeEngine(on, { text: '> <details>\n> Hidden.\n> </details>\n>\n> This paragraph is\n> wrapped.' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(
      '> <details>\n> Hidden.\n> </details>\n>\n> This paragraph is wrapped.',
    )
  })

  test('joins a wrapped line that starts with a number and a period, like a year', async ($, on) => {
    fakeEngine(on, {
      text: 'The migration lands in release\n2026. After that we drop it.\n\nUpgrade to Node\n22) then rebuild.',
    })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(
      'The migration lands in release 2026. After that we drop it.\n\nUpgrade to Node 22) then rebuild.',
    )
  })

  test('a numbered list still keeps its items apart, and "1." can start one after text', async ($, on) => {
    const text = 'Steps:\n1. one\n2. two\n10. ten'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(text)
  })

  test('drops control characters Markdown text may not hold, C1 ones too', async ($, on) => {
    fakeEngine(on, { text: 'a\u009Bb\u0085c\u0007d' })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('abcd')
  })

  test('simplifies joined emoji, skin tones and tag flags, which some terminals draw too wide', async ($, on) => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    const technologist = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'
    const wave = '\u{1F44B}\u{1F3FF}'
    const rainbowFlag = '\u{1F3F3}\uFE0F\u200D\u{1F308}'
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'
    fakeEngine(on, { text: [family, technologist, wave, rainbowFlag, scotland].join(' ') })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('\u{1F468} \u{1F469} \u{1F44B} \u{1F3F3}\uFE0F \u{1F3F4}')
  })

  test('leaves simple emoji, keycaps, country flags, CJK and non-emoji joiners alone', async ($, on) => {
    const rocket = '\u{1F680}'
    const heart = '\u2764\uFE0F'
    const keycap = '1\uFE0F\u20E3'
    const japanFlag = '\u{1F1EF}\u{1F1F5}'
    const malayalam = '\u0D28\u0D4D\u200D'
    const text = [rocket, heart, keycap, japanFlag, 'ダークモード', malayalam].join(' ')
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(text)
  })

  test('still joins a wrapped line that starts with an autolink', async ($, on) => {
    fakeEngine(on, { text: 'See\n<https://example.com> for more.' })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('See <https://example.com> for more.')
  })

  test('keeps the lines of a table inside a quote', async ($, on) => {
    const text = '> | a | b |\n> |---|---|\n> | 1 | 2 |'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(text)
  })

  test('reads a plan with Windows line endings', async ($, on) => {
    fakeEngine(on, { text: '\uFEFF# Title\r\nwrapped\r\nline\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |' })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('# Title\nwrapped line\n\n**a**\n**b**\n1\n2')
  })

  test('reads heading underlines and quotes the way Markdown does', async ($, on) => {
    const text = 'Title\n===\n\n> quoted and\n> wrapped\n>> nested\n\nUse `a | b` here\nand more'
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('Title\n===\n\n> quoted and wrapped\n>> nested\n\nUse `a | b` here and more')
  })
})

describe('tables', () => {
  const TABLE = [
    'Before.',
    '',
    '| # | Finding | Verdict |',
    '|---|---|---|',
    '| 1 | No tests for `a | b` | True, but costly to fix. A test would actually switch spaces unless the code is restructured first. |',
    '| 2 | Escaped \\| pipe | Real. |',
    '',
    'After.',
  ].join('\n')

  /** Ten column headings, too many to fit the pane side by side. */
  const TEN_HEADINGS = Array.from({ length: 10 }, (_, i) => `Column ${i}`)

  /** The widths of the first row's cells, as drawn in a pane `bodyColumns` wide. */
  const drawnWidths = async ($: Engine, columnCount: number, bodyColumns: number = PANE.props.bodyColumns) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal', viewport: WIDE })
    const boxes = (await ui.findAll({ type: 'Box' })).filter(box => typeof box.props.width === 'number')
    await ui.unmount()
    return boxes.slice(0, columnCount).map(box => box.props.width as number)
  }

  test('on the terminal, draws cells sized to the pane', async ($, on) => {
    fakeEngine(on, { text: TABLE })
    await writePlan($)
    const ui = await mountPane($)

    const texts = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(texts).toEqual([
      'Before.\n',
      '**#**',
      '**Finding**',
      '**Verdict**',
      '1',
      'No tests for `a | b`',
      'True, but costly to fix. A test would actually switch spaces unless the code is restructured first.',
      '2',
      'Escaped | pipe',
      'Real.',
      '\nAfter.',
    ])
    await ui.unmount()

    // 60 columns, less 1 of padding on each side and 2 gaps of 2, leaves 54.
    const widths = await drawnWidths($, 3)
    expect(widths.reduce((total, width) => total + width, 0)).toBe(54)
    expect(Math.max(...widths)).toBe(widths[2])
  })

  test('on the desktop, stays in the Markdown', async ($, on) => {
    fakeEngine(on, { text: TABLE })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe(TABLE)
  })

  test('a squeezed column never gets narrower than its longest word', async ($, on) => {
    const long = 'word '.repeat(16).trim()
    const text = [
      '| A | B | C | D | E |',
      '|---|---|---|---|---|',
      `| ${long} | ${long} | ${long} | fifteen letters | seven c |`,
    ].join('\n')
    fakeEngine(on, { text })
    await writePlan($)

    // 40 columns, less 1 of padding on each side and 4 gaps of 2, leaves 30.
    const widths = await drawnWidths($, 5, 40)
    expect(widths.reduce((total, width) => total + width, 0)).toBe(30)
    const longestWords = [4, 4, 4, 7, 5]
    widths.forEach((width, i) => expect(width).toBeGreaterThanOrEqual(longestWords[i]!))
  })

  test('code spans count their contents as drawn, `__` and all', async ($, on) => {
    fakeEngine(on, { text: '| Fn | Note |\n|---|---|\n| `__init__` | x |' })
    await writePlan($)

    expect(await drawnWidths($, 2)).toEqual([8, 4])
  })

  test("a link's URL doesn't count toward its column's width, even when its text has a space", async ($, on) => {
    const link = '[the docs](https://example.com/a/long/path)'
    fakeEngine(on, { text: `| A | B | C |\n|---|---|---|\n| ${link} | ${link} | ${link} |` })
    await writePlan($)

    expect(await drawnWidths($, 3, 50)).toEqual([8, 8, 8])
  })

  test('emoji count as two cells wide', async ($, on) => {
    fakeEngine(on, { text: '| ? | Task |\n|---|---|\n| ✅✅ | x |' })
    await writePlan($)

    expect(await drawnWidths($, 2)).toEqual([4, 4])
  })

  test("draws as a list when the columns can't fit without breaking words", async ($, on) => {
    const text = [
      '| Environment Where Deployed | Feature Flag Name | Percentage Initially | Responsible Team | Completion Date |',
      '|---|---|---|---|---|',
      '| Local development | `hello_banner_enabled_local` | 100% | Whoever is running it | 2026-10-27 |',
      '| Shared staging | `hello_banner_enabled_staging` | 100% | QA team | 2026-10-29 |',
    ].join('\n')
    fakeEngine(on, { text })
    await writePlan($)
    const ui = await mountPane($)

    const rows = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toStartWith('**Environment Where Deployed:** Local development\n**Feature Flag Name:**')
    expect((await ui.findAll({ type: 'Text', text: /^─+$/ })).length).toBe(1)
    await ui.unmount()
  })

  test('in a pane too narrow for any text, still draws a table as a list', async ($, on) => {
    fakeEngine(on, { text: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |' })
    await writePlan($)

    const ui = await $.ui.mount({
      ...PANE,
      props: { ...PANE.props, bodyColumns: 1 },
      surface: 'terminal',
      viewport: WIDE,
    })
    expect((await ui.findAll({ type: 'Markdown' })).length).toBe(2)
    await ui.unmount()
  })

  test('a table with headings but no rows yet, too wide for the pane, shows its headings as a list', async ($, on) => {
    fakeEngine(on, { text: `| ${TEN_HEADINGS.join(' | ')} |\n|${' - |'.repeat(10)}` })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(TEN_HEADINGS.map(name => `**${name}**`).join('\n'))
  })

  test('a table with headings but no rows yet that fits is drawn as a grid', async ($, on) => {
    fakeEngine(on, { text: '| a | b |\n|---|---|' })
    await writePlan($)

    expect(await drawnWidths($, 2)).toEqual([1, 1])
  })

  test('a backtick with no partner in a row is just a backtick, not the start of code', async ($, on) => {
    fakeEngine(on, { text: '| Key | Shown |\n|---|---|\n| Press ` to quote | yes |' })
    await writePlan($)
    const ui = await mountPane($)

    const texts = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(texts).toEqual(['**Key**', '**Shown**', 'Press ` to quote', 'yes'])
    await ui.unmount()
  })

  test("a delimiter row with a different number of cells than the header isn't a table", async ($, on) => {
    fakeEngine(on, { text: 'Use a | b | c here\n|---|' })
    await writePlan($)

    // Not a table, so it's a paragraph, and its two lines join.
    expect(await drawnMarkdown($)).toBe('Use a | b | c here |---|')
  })

  test('a wrapped paragraph right after a table, with no blank line, is still joined', async ($, on) => {
    fakeEngine(on, { text: '| a | b |\n|---|---|\n| 1 | 2 |\nThis is a\nwrapped paragraph.' })
    await writePlan($)

    expect(await drawnMarkdown($, 'desktop')).toBe('| a | b |\n|---|---|\n| 1 | 2 |\nThis is a wrapped paragraph.')
  })

  test("a cell that starts like a quote, heading, list or numbered item isn't turned into one", async ($, on) => {
    fakeEngine(on, { text: '| Limit | Note |\n|---|---|\n| > 100ms | # 3 |\n| + | 1. done |' })
    await writePlan($)
    const ui = await mountPane($)

    const texts = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(texts.slice(2)).toEqual(['\\> 100ms', '\\# 3', '\\+', '1\\. done'])
    await ui.unmount()
  })

  test('a cell starting with inline code in triple backticks is left as it is', async ($, on) => {
    fakeEngine(on, { text: '| Step | Note |\n|---|---|\n| ```npm test``` first | x |' })
    await writePlan($)
    const ui = await mountPane($)

    const texts = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(texts[2]).toBe('```npm test``` first')
    await ui.unmount()
  })

  test('a row with more cells than the header drops the extra ones, as GFM does', async ($, on) => {
    fakeEngine(on, { text: '| a |\n|---|\n| 1 | 2 | 3 |' })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe('**a**\n1')
  })

  test('a heading ending in a backslash stays bold', async ($, on) => {
    fakeEngine(on, { text: '| C:\\temp\\ | b |\n|---|---|\n| 1 | 2 |' })
    await writePlan($)
    const ui = await mountPane($)

    const texts = (await ui.findAll({ type: 'Markdown' })).map(element => element.text)
    expect(texts[0]).toBe('**C:\\temp\\\\**')
    await ui.unmount()
  })

  test('Japanese punctuation and the long-vowel mark count as two cells wide', async ($, on) => {
    fakeEngine(on, { text: '| 「設計」、。 | サーバー |\n|---|---|\n| x | y |' })
    await writePlan($)

    expect(await drawnWidths($, 2)).toEqual([12, 8])
  })

  test('an emoji made of several code points counts as one two-cell character', async ($, on) => {
    fakeEngine(on, { text: '| 👍🏽 | 🇯🇵 | 👨‍👩‍👧 |\n|---|---|---|\n| x | y | z |' })
    await writePlan($)

    expect(await drawnWidths($, 3)).toEqual([2, 2, 2])
  })

  test('with too many columns for the pane, draws as a list', async ($, on) => {
    const text = [
      `| ${TEN_HEADINGS.join(' | ')} |`,
      `|${' - |'.repeat(10)}`,
      `| ${TEN_HEADINGS.map(() => 'value').join(' | ')} |`,
    ].join('\n')
    fakeEngine(on, { text })
    await writePlan($)

    expect(await drawnMarkdown($)).toBe(TEN_HEADINGS.map(name => `**${name}:** value`).join('\n'))
  })
})
