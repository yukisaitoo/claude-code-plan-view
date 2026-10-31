import type { EngineInterface, PluginOptions, Register, RenderSurface, RenderViewport } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Plan } from '../types'
import { NO_PLAN, drawPlan, readPlanText } from './pane'
import { forgetMissingPlans, forgetSession, loadSession, planExists, saveAsNewest, saveSession } from './saved-sessions'

const PANE_ID = 'plan'
const PANE_TITLE = 'Plan'
const PADDING_X = 1 // Padding on each side of the pane

// Pane width setting to share of the terminal. 45% is the most Claude Code (CC) allows.
const WIDTH_SHARES: Record<string, number> = { narrow: 0.3, medium: 0.38, wide: 0.45 }

/** The plugin's /config values. Read once, in `register`: CC reloads the plugin when a setting changes. */
let settings: ReturnType<typeof readSettings>

/** Missing or unknown values fall back to the defaults. */
function readSettings(options: PluginOptions) {
  return {
    autoOpen: options.autoOpen !== false,
    widthShare: WIDTH_SHARES[String(options.width)] ?? WIDTH_SHARES.wide!,
  }
}

// Atoms (`plan`, `notedPlanPath`) are held by CC for the session.
//
// They survive a plugin reload, and writing `plan` redraws the pane.

/** This session's plan. Bump `shape` when Plan's fields change, so values saved by older code are ignored. */
const plan = atom({ plugin: 'plan-view', key: 'plan' } as const, null as Plan | null, { shape: 'v1' })

/** The plan path named by CC's plan-mode notes. Until the first note, `isDefaultPlanPath` guesses. */
const notedPlanPath = atom({ plugin: 'plan-view', key: 'notedPlanPath' } as const, null as string | null, {
  shape: 'v1',
})

/**
 * The session last restored. /clear and an in-app resume switch sessions
 * without session.start, so turn.start and /plan-view compare against this.
 */
let sessionId: string | undefined

/**
 * The last viewport each surface (terminal, desktop app, phone…) drew with.
 * Kept apart so one device's size never sizes the pane on another.
 */
const viewports: Partial<Record<RenderSurface, RenderViewport>> = {}

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

  // A close by hand keeps the pane closed for this plan, across restarts, until
  // the next plan or /plan-view. Other closes (a /clear, an auto-open with no
  // room) save nothing. Quitting skips this hook, so a pane open at quit reopens.
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
    const width = Math.max(0, e.props.bodyColumns - 2 * PADDING_X)

    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows} paddingX={PADDING_X}>
        {drawPlan(elements, current, text, e.surface, width)}
      </Box>
    )
  })
}

// Which file is the plan

/**
 * After a successful Write or Edit: a write to this session's plan file
 * starts or updates the plan. A subagent can update the current plan but
 * never starts one.
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
 * Follows the plan file CC's plan-mode note names. A new path becomes the
 * plan and may open the pane; the same path bumps `revision`, since the file
 * may have changed outside Write and Edit.
 *
 * `isNewPlan`: plan mode was entered again, which undoes a close by hand.
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
 * For /plan-view: takes up the noted plan file if it exists, like one a shell
 * command wrote, which neither the note nor a write announces.
 */
async function adoptNamedPlan($: EngineInterface) {
  const path = await read($, notedPlanPath)
  if (!path || !(await planExists($, path))) return null
  return update($, plan, previous => previous ?? { path, revision: 1, isDismissed: false })
}

/** Where home folders usually are. A hooks module can't ask for the home folder. */
const HOME_FOLDERS = [
  '/Users/[^/]+', // macOS
  '/home/[^/]+', // Linux
  '/root', // Linux, as root
  String.raw`[A-Za-z]:\\Users\\[^\\]+`, // Windows, like C:\Users\name
]

/**
 * A file right inside a home folder's plans folder, like
 * ~/.claude/plans/my-plan.md, where CC keeps plans by default. A project's
 * own .claude/plans doesn't count.
 *
 * Used before any plan-mode note, so a plan written outside plan mode still shows.
 */
const DEFAULT_PLAN_PATH = new RegExp(String.raw`^(?:${HOME_FOLDERS.join('|')})[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$`)

function isDefaultPlanPath(path: string) {
  return DEFAULT_PLAN_PATH.test(path)
}

// Opening the pane

/**
 * Opens the pane on its own, only where it docks beside the chat. If CC can't
 * place it, closes it again, so it never pops up later out of nowhere. A pane
 * already open, even one waiting for room, is left alone.
 *
 * Returns what to save about a pane it opened.
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

function openPane($: EngineInterface, size?: { columns?: number; rows?: number }) {
  return $.ui.open({ id: PANE_ID, title: PANE_TITLE, backgroundColor: 'transparent', ...size })
}

/** The size to open the pane at: its width share when docked, the full height above the prompt. CC caps both. */
function paneSize(columns?: number) {
  const viewport = dockViewport()
  // The viewport is the chat's width. Another plugin's pane or the diff panel
  // narrows it without the plugin knowing, so with one docked the pane opens narrower.
  const totalColumns = columns ?? viewport?.columns
  if (totalColumns === undefined) return undefined

  return {
    columns: Math.max(1, Math.floor(totalColumns * settings.widthShare)),
    rows: viewport?.rows,
  }
}

/** The viewport to size the dock for: the terminal's, or else any surface in the fullscreen layout. */
function dockViewport() {
  return viewports.terminal ?? Object.values(viewports).find(viewport => viewport?.isFullscreen)
}

// Sessions

/**
 * Loads this session's saved plan and reopens the pane if it was open last
 * time. Forgets the session if its plan file is gone.
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

  // Left as it is, so a new Pane width applies at the next open.
  if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) return

  // Before the first draw the terminal's width is unknown, so the saved one
  // stands in. With no room yet, CC shows the pane once there is.
  await openPane($, paneSize(dockViewport()?.columns ?? saved.terminalColumns))
}

/** Restores again when the session id changed: how /clear and an in-app resume are noticed. */
async function restoreSessionIfChanged($: EngineInterface) {
  if ((await $.session.id()) !== sessionId) await restoreSession($)
}

/**
 * Saves the plan with what `autoOpenPane` opened. Reads `plan` fresh, so a
 * close by hand that landed meanwhile isn't saved over.
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
