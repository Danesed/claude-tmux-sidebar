# Claude & Codex Tmux Sidebar — User Guide

## Install

Build the VSIX on a machine with Node.js:

```bash
cd claude-tmux-sidebar
npm run check
npm run package
```

Install `claude-tmux-sidebar-0.6.0.vsix` from **Extensions → … → Install from
VSIX…**, then reload VS Code. From a shell you can instead run:

```bash
code --install-extension claude-tmux-sidebar-0.6.0.vsix --force
```

With Remote-SSH, perform the install from the connected VS Code window so the
extension runs beside the remote `tmux`, `claude` and `codex` binaries.

## Use both agents

Open a folder, then open the **Tmux Agents** Activity Bar view.

### Claude tab

- **Start new Claude** creates `tmux_<folder>` in the workspace root.
- Existing Claude conversations shown in the card come only from that folder's
  `~/.claude/projects/...` directory.
- **Resume / switch** in the toolbar opens the same folder-filtered list.

### Codex tab

- **Start new Codex** creates `codex_<folder>` in the workspace root.
- **Resume previous session** or the toolbar resume action replaces the current
  Codex tmux session and starts `codex resume` in the workspace root.
- Codex's own picker filters sessions by cwd because the extension never passes
  `--all`.

Clicking the other tab changes only the mirror target. It does not stop, detach
or restart either agent. The last selected tab is restored after reload.

## Scroll and input

- Mouse wheel and the scrollbar navigate up to `claudeTmux.scrollbackLines`.
- If tmux history is empty, wheel movement forwards page navigation to the agent TUI.
- `Shift+PageUp` and `Shift+PageDown` scroll the mirror by one viewport.
- Plain `PageUp` and `PageDown` go to the active agent.
- While the view is at the bottom, new output auto-follows.
- After scrolling up, refreshes preserve the reading position.
- Each agent has an independent scroll position.
- Click the terminal mirror before typing; the focus border confirms input.
- Text selection pauses visual replacement until the selection is released,
  making copy reliable during frequent refreshes.

## Workspace isolation

The name is not the security boundary. Before capture, input, resize, restart or
kill, the extension checks that tmux reports `session_path` equal to the current
workspace root. Tmux targets also use exact-name syntax.

If another project with the same basename already owns `tmux_<folder>` or
`codex_<folder>`, this project uses `<name>-<path-hash>`. Unrelated sessions are
never shown by **Manage this workspace's tmux sessions…**.

No workspace means no operation: the view asks you to open a folder and does not
use the home directory as a fallback. Multi-root workspaces use the first root.

## Status and toolbar

The footer shows the selected tmux name, pane size, uptime and one of:

- **live**: the tmux session exists and is updating;
- **idle**: no frame arrived recently;
- **stopped**: no matching workspace session exists.

`live` describes tmux, not the child process. If Claude or Codex exits back to a
shell, the tmux session remains live and you can use **Restart**.

Toolbar actions are scoped to the active tab. The manage action shows zero, one
or two entries and rechecks the workspace path immediately before killing.

## Troubleshooting

- **No workspace**: open a folder, not only an individual file.
- **Typing does nothing**: click the mirror and verify the focus border.
- **Codex has no history**: keep the default `--no-alt-screen` in
  `claudeTmux.codexArgs`; older output is still limited by tmux history.
- **Claude or Codex command not found**: install the CLI on the extension host
  and ensure it is on the environment `PATH` visible to VS Code.
- **Remote-SSH starts local tmux**: reinstall the VSIX in the SSH-connected
  window under the remote extension host.
- **Prompt glyphs are boxes**: set `claudeTmux.fontFamily` to the local Nerd Font
  used by the integrated terminal.
- **Wrong size or clipped layout**: use tmux 2.9+ and widen the side bar.
- **Resume replaces a running agent**: this is intentional and requires a modal
  confirmation; the other agent's tmux session is untouched.

For a clean end-to-end check after installing, follow [TESTING.md](TESTING.md).
