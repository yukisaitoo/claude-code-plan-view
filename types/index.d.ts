/** This session's plan file. */
export type Plan = {
  path: string
  /**
   * Goes up whenever the plan file may have changed (a write, a plan-mode
   * note, approval), so the pane re-reads it. Closing or reopening the pane
   * doesn't change it.
   */
  revision: number
  /**
   * Set when the person closes the pane by hand. Cleared by /plan-view, by
   * re-entering plan mode, or by a different plan file.
   */
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'plan-view': { plan: Shaped<Plan | null>; notedPlanPath: Shaped<string | null> }
  }
}
