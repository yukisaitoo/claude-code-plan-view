# plan-view

A live plan pane for Claude Code: watch Claude's plan-mode plan update beside the chat as it's written.

An unofficial community plugin; not made by or affiliated with Anthropic.

## What it does

- When Claude writes a plan in plan mode, a **Plan** pane opens beside the chat and shows the plan as formatted markdown.
- After each write or edit, the pane updates to show the plan as it stands.
- On a wide terminal, the pane takes about 45% of the width by default (the widest side pane Claude Code allows); see Pane width below.
- On a smaller terminal, it doesn't open on its own. Run `/plan-view` to open it anyway: beside the chat in the fullscreen layout from 110 columns, otherwise above the prompt. If a resumed session had the pane open and the terminal is too narrow, the pane waits and appears once the terminal is wide enough.
- Close it with the pane's close mark or ctrl+x x. It stays closed while Claude edits that plan, and opens again for the next plan or when you run `/plan-view`.
- `/plan-view` shows the current session's plan, or says there's no plan yet this session.
- `/clear`, or resuming another session from inside Claude Code, closes the pane. It opens again at your next message if the resumed session had it open.
- The pane follows the plan file Claude Code itself names in plan mode. Each session's plan path is also saved, so a restarted or resumed session finds its plan again, and the pane reopens if it was open when you left.

The plugin only displays the plan. It doesn't change how Claude plans.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install plan-view --marketplace yukisaitoo/claude-code-plan-view
```

From a shell:

```
claude plugin install plan-view --marketplace yukisaitoo/claude-code-plan-view
```

Update to the latest version with `claude plugin update plan-view@plan-view`, then restart Claude Code to apply it.

## Requirements

- For the side pane, use Claude Code's fullscreen layout (`"tui": "fullscreen"` in settings) and a terminal at least 144 columns wide. After you've opened the pane once with `/plan-view`, 110 columns is enough, until you close the pane yourself; run `/plan-view` again to get that back.
- In other layouts, or in narrower terminals, use `/plan-view`. That includes the desktop app attached to a session whose terminal uses the main screen: the pane opens on its own only when the terminal docks it.

## Settings

Set these during install, or later in `/config`; a change applies right away, except Pane width, which applies the next time the pane opens (or run `/plan-view`).

| Setting            | Default | What it does                                                                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Open automatically | on      | Open the pane when Claude writes a plan. Off: only `/plan-view` opens it. A resumed session still reopens a pane you left open. |
| Pane width         | wide    | `narrow` about 30%, `medium` about 38%, or `wide` about 45% of the terminal: the plan's width, plus the pane's frame.           |

The font, text colors inside the plan (from your Claude Code theme), and the pane's outer frame and close mark come from Claude Code and your terminal, and can't be changed by the plugin.

## Stored data

The plugin keeps a small list of session IDs, their plan file paths, whether the pane was open or closed by hand, and the terminal's width when the pane last opened, in its own store, under your Claude Code configuration directory. It holds at most 100 sessions, dropping the one used longest ago. Entries whose plan file is gone are removed each time a session starts. Plan contents are never stored; the pane reads them from the plan file.

## Development

Run Claude Code with the plugin loaded from this folder. It reloads after each edit, so there's no install step between changes (disable an installed copy first, so the hooks don't run twice):

```
claude plugin disable plan-view@plan-view
claude --plugin-dir .
```

Then repeat:

1. Edit the code.
2. Run the checks (after a one-time `npm install`, and once the `--plugin-dir` session above has started):

   ```
   npm run check
   ```

   That type-checks, checks formatting, validates the plugin and runs the tests. `npm run format` fixes formatting. The type-check needs Claude Code's type definitions, which loading the plugin with `--plugin-dir` writes to `.claude-plugin/types/` (the editor reads them too). They aren't in git, so on a fresh clone the type-check fails with errors about the `claude-code` module until that session has started once.

3. Try it in the `--plugin-dir` session: use the fullscreen layout in a terminal at least 144 columns wide, switch to plan mode (shift+tab), and ask for a plan. The pane should open and update as the plan is written. Also try `/plan-view`, closing the pane with ctrl+x x, a narrow terminal, and resuming the session.

When you're done, turn the installed copy back on with `claude plugin enable plan-view@plan-view`.

An installed copy is a snapshot saved under `~/.claude/plugins/cache/`, kept per version. To test the installed copy before a release, bump `version` in `.claude-plugin/plugin.json` and run `claude plugin update plan-view@plan-view`, then restart Claude Code.

## License

MIT
