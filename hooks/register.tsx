import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderSurface, RenderViewport } from 'claude-code'

import type { Plan } from '../types'
import { NO_PLAN, drawPlan, readPlanText } from './pane'
import { forgetMissingPlans, forgetSession, loadSession, planExists, saveAsNewest, saveSession } from './saved-sessions'

const PANE_ID = 'plan'
const PANE_TITLE = 'Plan'
/** Columns of padding on each side of the plan. */
const PADDING_X = 1

/** The share of the terminal's width the docked pane asks for. 45% is the most Claude Code allows. */
const WIDTH_SHARES: Record<string, number> = { narrow: 0.3, medium: 0.38, wide: 0.45 }

/**
 * The plugin's /config values. Changing one reloads the plugin, so they're
 * read once per load; `register` sets them before any hook can run.
 */
let settings: ReturnType<typeof readSettings>

// `plan` and `notedPlanPath` are atoms: they survive a reload, and changing
// `plan` redraws the pane. The rest are plain variables, which a reload
// clears; the plugin learns each one again at the next draw or turn.

/**
 * This session's plan. Bump `shape` when Plan's fields change, so a reload
 * ignores a value saved by older code.
 */
const plan = atom({ plugin: 'plan-view', key: 'plan' } as const, null as Plan | null, { shape: 'v1' })

/**
 * The last viewport each surface (terminal, desktop app, phone…) drew with,
 * kept apart so one surface's size never decides the pane's width on another.
 */
const viewports: Partial<Record<RenderSurface, RenderViewport>> = {}

/**
 * The plan path named by Claude Code's plan-mode notes. Until the first
 * note, `isDefaultPlanPath` decides.
 */
const notedPlanPath = atom({ plugin: 'plan-view', key: 'notedPlanPath' } as const, null as string | null, {
  shape: 'v1',
})

/**
 * The session the plan belongs to. /clear and an in-app resume change the
 * session id without firing session.start, so turn.start and /plan-view check.
 */
let sessionId: string | undefined

/** Turns the raw /config values into the ones the plugin uses, with defaults for anything missing. */
function readSettings(options: PluginOptions) {
  return {
    autoOpen: options.autoOpen !== false,
    widthShare: WIDTH_SHARES[String(options.width)] ?? WIDTH_SHARES.wide!,
  }
}

/**
 * Whether `path` is a file right inside the plans folder of a home folder,
 * like ~/.claude/plans/my-plan.md, where Claude Code keeps plans by default.
 * A project's own .claude/plans doesn't count. A hooks module can't ask for
 * the home folder, so this knows the usual places for one.
 */
const DEFAULT_PLAN_PATH =
  /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/

function isDefaultPlanPath(path: string) {
  return DEFAULT_PLAN_PATH.test(path)
}

/** The viewport to size the dock for: the terminal's, or else any surface in the fullscreen layout. */
function dockViewport() {
  return viewports.terminal ?? Object.values(viewports).find(viewport => viewport?.isFullscreen)
}

/**
 * The size to open the pane at: docked, its share of `columns` (the dock
 * viewport's if not given); Claude Code keeps it within its own limits. Above
 * the prompt (outside the fullscreen layout), the whole terminal's height, so
 * it opens as tall as Claude Code allows rather than its default third.
 *
 * The terminal's viewport is the conversation's width, which is the
 * terminal's only while nothing is docked beside it. The plugin never sizes
 * the pane from it while the pane is open, but another plugin's pane or the
 * diff panel still narrows it, and the plugin can't see either.
 */
function paneSize(columns?: number) {
  const viewport = dockViewport()
  const totalColumns = columns ?? viewport?.columns
  if (totalColumns === undefined) return undefined

  return {
    columns: Math.max(1, Math.floor(totalColumns * settings.widthShare)),
    rows: viewport?.rows,
  }
}

/** Opens the pane with no background of its own, so the terminal's shows through. */
function openPane($: EngineInterface, size?: { columns?: number; rows?: number }) {
  return $.ui.open({ id: PANE_ID, title: PANE_TITLE, backgroundColor: 'transparent', ...size })
}

/**
 * Opens the pane on its own, but only where it can dock beside the chat. If
 * it can't be placed now, closes it, so it never pops up later out of nowhere.
 * A pane already open, even one waiting for room, is left as it is. Returns
 * what to save about a pane it opened, for the caller's one save.
 */
async function autoOpenPane($: EngineInterface) {
  if (!settings.autoOpen || dockViewport()?.isFullscreen !== true) return {}
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE_ID)) return {}

  const terminalColumns = dockViewport()?.columns
  // A close by hand may have landed while the panes were listed.
  if ((await read($, plan))?.isDismissed) return {}
  const opened = await openPane($, paneSize(terminalColumns))
  if (opened.isPlaced) return { isOpen: true, terminalColumns }
  await $.ui.close({ id: PANE_ID })
  return {}
}

/**
 * Loads this session's saved plan, and reopens the pane if it was open when
 * the session last ran. Forgets the session if its plan file is gone. A pane
 * still open (after a reload) keeps its size, so a new Pane width waits for
 * the next open.
 */
async function restoreSession($: EngineInterface) {
  sessionId = await $.session.id()
  const saved = await loadSession($, sessionId)
  if (!saved) return
  if (!(await planExists($, saved.path))) {
    await forgetSession($, sessionId)
    return
  }
  await saveAsNewest($, sessionId, saved)

  const isDismissed = saved.isDismissed === true
  await update($, plan, current => current ?? { path: saved.path, revision: 0, isDismissed })
  if (!saved.isOpen) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) return

  // Sized by the current Pane width setting. Before the first draw the
  // terminal's width is unknown, so the one saved with the session stands in.
  // If the terminal is too narrow, Claude Code keeps the pane waiting and
  // shows it once there's room.
  await openPane($, paneSize(dockViewport()?.columns ?? saved.terminalColumns))
}

/** Restores the session if its id changed since the last restore, which is how /clear and an in-app resume are noticed. */
async function restoreSessionIfChanged($: EngineInterface) {
  if ((await $.session.id()) !== sessionId) await restoreSession($)
}

/**
 * Saves the plan as it stands now, with what `autoOpenPane` opened. Read
 * fresh, so a close by hand that landed meanwhile isn't saved over.
 */
async function saveOpenedPlan(
  $: EngineInterface,
  path: string,
  opened: { isOpen?: boolean; terminalColumns?: number },
) {
  const latest = await read($, plan)
  if (latest?.path !== path) return
  await saveSession($, { path, isDismissed: latest.isDismissed, ...(latest.isDismissed ? {} : opened) })
}

/**
 * Runs after a successful Write or Edit. A write to this session's plan file
 * starts or revises the plan; writes to other files are ignored. A subagent
 * may revise the current plan, but its own plan file isn't this session's.
 * Before any plan-mode note, a write starts a plan only if there's none yet.
 */
async function handlePlanFileWrite($: EngineInterface, path: string, agentId: string | undefined) {
  const current = await read($, plan)
  const noted = await read($, notedPlanPath)
  const isCurrentPlan = path === current?.path
  const isSessionPlan = noted ? path === noted : !current && isDefaultPlanPath(path)
  const isNewSessionPlan = !agentId && isSessionPlan
  if (!isCurrentPlan && !isNewSessionPlan) return

  const next = await update($, plan, previous => ({
    path,
    revision: (previous?.revision ?? 0) + 1,
    // A close by hand only holds for the plan it closed.
    isDismissed: previous?.path === path && previous.isDismissed,
  }))
  await saveOpenedPlan($, path, next?.isDismissed ? {} : await autoOpenPane($))
}

/**
 * Follows the plan file named by Claude Code's plan-mode notes, and bumps the
 * revision so the pane re-reads it (it may have changed outside Write and
 * Edit). A plan the plugin hadn't seen yet (a forked session, a plan written
 * before the plugin was on) opens the pane as a write would. `isNewPlan`: plan
 * mode was entered again, which undoes a close by hand.
 */
async function handlePlanModeNote($: EngineInterface, path: string, { isNewPlan = false } = {}) {
  const current = await read($, plan)
  if (current?.path !== path) {
    await update($, plan, previous => ({ path, revision: (previous?.revision ?? 0) + 1, isDismissed: false }))
    await saveOpenedPlan($, path, await autoOpenPane($))
    return
  }

  // Worked out from the value `update` hands over, so a close by hand that
  // landed since the read above still holds.
  await update($, plan, previous => {
    if (!previous) return previous
    return { ...previous, revision: previous.revision + 1, isDismissed: previous.isDismissed && !isNewPlan }
  })
  // saveSession skips a save that changes nothing.
  if (isNewPlan) await saveSession($, { path, isDismissed: false })
}

/**
 * The plan file the plan-mode note named, taken up as this session's plan
 * if it now exists. A file written outside Write and Edit (by a shell
 * command, say) is announced by neither the note nor a write.
 */
async function adoptNamedPlan($: EngineInterface) {
  const path = await read($, notedPlanPath)
  if (!path || !(await planExists($, path))) return null
  return update($, plan, previous => previous ?? { path, revision: 1, isDismissed: false })
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'plan-view', description: "Show this session's plan in a pane" })
    const result = await next(e)
    await forgetMissingPlans($)
    await restoreSession($)
    return result
  })

  // A /clear or an in-app resume starts a new session, so its plan is gone
  // and the pane closes. The next turn reopens it if the new session is a
  // resumed one that had it open.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, notedPlanPath, () => null)
      await update($, plan, () => null)
      await $.ui.close({ id: PANE_ID })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await restoreSessionIfChanged($)
    return next(e)
  })

  // Subagents get plan-mode notes about their own plan files; those are ignored.
  on('prompt.attachment', { type: ['plan_mode', 'plan_mode_exit'] }, async ($, e, next) => {
    if (!e.agentId && e.detail) {
      const path = e.detail.planFilePath
      await update($, notedPlanPath, () => path)
      if (e.detail.hasPlan) await handlePlanModeNote($, path)
    }
    return next(e)
  })

  on('prompt.attachment', { type: 'plan_mode_reentry' }, async ($, e, next) => {
    if (!e.agentId && e.detail) {
      const path = e.detail.planFilePath
      await update($, notedPlanPath, () => path)
      await handlePlanModeNote($, path, { isNewPlan: true })
    }
    return next(e)
  })

  on('command.run', { command: 'plan-view' }, async ($, e) => {
    await restoreSessionIfChanged($)
    const current = (await read($, plan)) ?? (await adoptNamedPlan($))
    if (!current) return { text: NO_PLAN }

    // Sized for the terminal the command ran in, not whichever surface drew last.
    const { columns, isFullscreen } = e.presentation
    const opened = await openPane($, paneSize(columns))
    // A failed /plan-view changes nothing, not even a close by hand.
    if (!opened.isPlaced) return { text: `The plan pane can't be shown here: ${opened.reason}` }

    await update($, plan, previous => previous && { ...previous, isDismissed: false })
    // Only a docked pane's width is worth keeping: above the prompt, the width is ignored.
    const size = isFullscreen && { terminalColumns: columns }
    await saveSession($, { path: current.path, isOpen: true, isDismissed: false, ...size })
    return { text: 'Plan pane opened.' }
  })

  on('tool.call', { tool: ['Write', 'Edit'] }, async ($, e, next) => {
    const result = await next(e)
    const succeeded = result.deny === undefined && !result.isError
    if (succeeded) await handlePlanFileWrite($, e.file_path, e.agentId)
    return result
  })

  // Editing the plan at approval (ctrl+g) changes the file outside Write and
  // Edit, so redraw the pane.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await update($, plan, previous => previous && { ...previous, revision: previous.revision + 1 })
    return result
  })

  // Closed by hand, the pane stays closed for this plan, even across restarts,
  // until the next plan or /plan-view. The plugin's own closes (a /clear, an
  // auto-open with no room) aren't the person's choice, so they save nothing.
  // Quitting Claude Code drops the pane without calling this hook, so a pane
  // left open at quit still counts as open on resume.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'person') return result

    const current = await update($, plan, previous => previous && { ...previous, isDismissed: true })
    if (current) await saveSession($, { path: current.path, isOpen: false, isDismissed: true })
    return result
  })

  // The band above the prompt draws in every session, so it's where the
  // plugin learns the layout before any pane is open. It adds nothing itself.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.viewport) viewports[e.surface] = e.viewport
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    if (e.viewport) viewports[e.surface] = e.viewport
    const elements = $.ui.resolve(e)
    const { Box } = elements
    const current = await read($, plan)
    const text = current && (await readPlanText($, current.path))
    // Less the padding on both sides.
    const width = Math.max(0, e.props.bodyColumns - 2 * PADDING_X)

    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows} paddingX={PADDING_X}>
        {drawPlan(elements, current, text, e.surface, width)}
      </Box>
    )
  })
}
