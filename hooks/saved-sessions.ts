// Each session's plan path and pane state, saved so a restarted or resumed
// session finds its plan and reopens its pane. Each session gets its own key
// in the shared store, so sessions never overwrite each other.

import type { EngineInterface } from 'claude-code'

/** One session's saved entry. */
export type SavedSession = {
  path: string
  /** Whether the pane was open when the session last ran. */
  isOpen?: boolean
  /** The width the pane was sized from when it last docked, used on resume before the terminal's width is known. */
  terminalColumns?: number
  /** Closed by hand; see `Plan.isDismissed`. */
  isDismissed?: boolean
}

const KEY_PREFIX = 'session:'
const MAX_SAVED = 100

const keyFor = (id: string) => KEY_PREFIX + id

/** A session's saved entry, or undefined if none is saved or it isn't a valid entry. */
export async function loadSession($: EngineInterface, id: string) {
  const value = await $.store.get(keyFor(id))
  return isSavedSession(value) ? value : undefined
}

/** Merges `change` into this session's saved entry. */
export async function saveSession($: EngineInterface, change: SavedSession) {
  // Asked fresh each time: after a /clear, the id cached in register.tsx is
  // stale until the next turn.
  const id = await $.session.id()
  const saved = await loadSession($, id)
  const fields = Object.keys(change) as (keyof SavedSession)[]
  if (saved && fields.every(field => saved[field] === change[field])) return

  await saveAsNewest($, id, { ...saved, ...change })
  await pruneSavedSessions($)
}

/** Deletes a session's saved entry, as when its plan file is gone. */
export async function forgetSession($: EngineInterface, id: string) {
  await $.store.delete(keyFor(id))
}

/**
 * Whether a plan file exists. A network location makes `$.fs.exists` reject;
 * such a plan can't be read either, so it counts as missing.
 */
export function planExists($: EngineInterface, path: string) {
  return $.fs.exists(path).catch(() => false)
}

/** Forgets every session whose plan file is gone. */
export async function forgetMissingPlans($: EngineInterface) {
  for (const key of await sessionKeys($)) {
    const value = await $.store.get(key)
    if (isSavedSession(value) && !(await planExists($, value.path))) await $.store.delete(key)
  }
}

/**
 * Saves `entry` as the most recently used session, so pruning drops it last.
 * Deleting first moves the key to the end of $.store.keys(), so the keys stay
 * ordered from least to most recently used.
 */
export async function saveAsNewest($: EngineInterface, id: string, entry: SavedSession) {
  await $.store.delete(keyFor(id))
  await $.store.set(keyFor(id), entry)
}

/** Keeps only the most recently used sessions. */
async function pruneSavedSessions($: EngineInterface) {
  const keys = await sessionKeys($)
  for (const key of keys.slice(0, -MAX_SAVED)) await $.store.delete(key)
}

async function sessionKeys($: EngineInterface) {
  return (await $.store.keys()).filter(key => key.startsWith(KEY_PREFIX))
}

function isSavedSession(value: unknown): value is SavedSession {
  return typeof value === 'object' && value !== null && typeof (value as SavedSession).path === 'string'
}
