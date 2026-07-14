# Claude & Codex Tmux Sidebar

Run **Claude Code** and **OpenAI Codex CLI** in two persistent tmux sessions and
switch between them from a single VS Code side-bar view.

The extension is deliberately workspace-scoped:

- the Claude tab controls only `tmux_<folder>`;
- the Codex tab controls only `codex_<folder>`;
- every existing session is accepted only when its tmux `session_path` matches
  the current VS Code workspace root;
- projects with the same folder name receive a stable path hash when needed,
  so one project can never attach to another project's tmux session.

Both agents survive VS Code restarts, Remote-SSH drops and local disconnects.

## What the view does

It mirrors the selected tmux pane instead of opening another VS Code terminal:

- `tmux capture-pane` reads the screen and bounded scrollback;
- `tmux send-keys` forwards keyboard and paste input;
- the **Claude / Codex tabs** swap the active session instantly;
- mouse wheel, scrollbar and `Shift+PageUp` / `Shift+PageDown` navigate history;
- when tmux has no captured history, the wheel forwards page navigation to the agent TUI;
- new output follows automatically only while you are at the bottom;
- each tab remembers its own scroll position while switching.

## Requirements

Install these on the machine where the extension runs. Under Remote-SSH that is
normally the remote host.

```bash
tmux -V
claude --version
codex --version
```

- tmux 2.9 or newer;
- Claude Code CLI on `PATH` for the Claude tab;
- Codex CLI on `PATH` for the Codex tab.

You may use either tab when only one agent CLI is installed.

## Build and install

From this repository:

```bash
npm run check
npm run package
code --install-extension claude-tmux-sidebar-0.6.0.vsix --force
```

Alternatively use VS Code: **Extensions → … → Install from VSIX…**, select the
generated file, then run **Developer: Reload Window**.

For Remote-SSH, install the VSIX in the remote extension host from the connected
window. `tmux`, `claude` and `codex` must be available on that same remote host.

The **Tmux Agents** icon appears in the Activity Bar. You can drag its
**Claude / Codex** view to the Secondary Side Bar; VS Code remembers the layout.

## Daily workflow

1. Open a project folder in VS Code.
2. Open **Tmux Agents** and select the **Claude** or **Codex** tab.
3. Start or resume:
   - Claude shows conversations read only from this folder's Claude project data;
   - Codex opens `codex resume` in this folder, using Codex's cwd-filtered picker.
4. Click the mirror and type. Switch tabs whenever you want; both tmux sessions
   continue running independently.
5. Scroll with the wheel or scrollbar. Use `Shift+PageUp/PageDown` from the
   keyboard. Plain `PageUp/PageDown` are still forwarded to the agent TUI.

The toolbar actions always target the selected tab:

| Action | Result |
|---|---|
| Resume / switch | Resume a Claude conversation or open the Codex resume picker. |
| Restart | Send `Ctrl-C`, then relaunch the selected agent. |
| Kill | Kill only the selected agent's workspace session. |
| Manage | List at most the Claude and Codex sessions belonging to this workspace. |

## Settings

The existing `claudeTmux.*` namespace is retained so upgrades keep current user
settings.

| Setting | Default | Meaning |
|---|---|---|
| `claudeTmux.refreshMs` | `250` | Mirror refresh interval in milliseconds. |
| `claudeTmux.claudeArgs` | `--dangerously-skip-permissions --ide` | Arguments used for Claude start/resume. |
| `claudeTmux.codexArgs` | `--no-alt-screen` | Arguments used for Codex start/resume; the default preserves scrollback. |
| `claudeTmux.sessionPrefix` | `tmux_` | Claude session prefix. |
| `claudeTmux.codexSessionPrefix` | `codex_` | Codex session prefix. |
| `claudeTmux.scrollbackLines` | `1000` | Captured history lines, from 0 to 5000. |
| `claudeTmux.fontFamily` | `""` | Empty inherits `terminal.integrated.fontFamily`. |
| `claudeTmux.fontSize` | `0` | Zero inherits `terminal.integrated.fontSize`. |
| `claudeTmux.cursorStyle` | `block` | `block`, `bar` or `underline`. |
| `claudeTmux.autoResume` | `true` | Auto-resume the newest Claude conversation when the Claude tab opens. |

## Scope and limits

- A workspace folder is required; the extension never falls back to `$HOME`.
- In a multi-root workspace, the first root is used.
- The status `live` means the tmux session exists; it does not inspect whether
  the agent process has returned to a shell prompt.
- This is a polled terminal mirror, not a full PTY. Mouse input is not forwarded.
- Scrollback is bounded by `claudeTmux.scrollbackLines` and tmux's own history.
- Multi-line paste is sent raw and a newline may submit input.

See [USER_GUIDE.md](USER_GUIDE.md) for troubleshooting and [TESTING.md](TESTING.md)
for the installation smoke test.
