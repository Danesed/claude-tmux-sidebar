# AgentMux

**Two agents. One terminal flow.**

Run **Claude Code** and **OpenAI Codex CLI** in persistent tmux sessions, switch
between them instantly, and hand work from one agent to the other from a single
VS Code side-bar view.

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

- `tmux capture-pane` reads the live screen; bounded scrollback is loaded only
  when you scroll up;
- one ordered input pump merges pending keystrokes under backpressure, while
  bracketed paste preserves large UTF-8 input;
- a **Claude** or **Codex** tab appears only while that workspace's matching
  tmux session exists;
- the `+` menu starts or resumes an absent agent;
- mouse wheel, scrollbar and `Shift+PageUp` / `Shift+PageDown` navigate history;
- when tmux has no captured history, the wheel forwards page navigation to the agent TUI;
- new output follows automatically only while you are at the bottom;
- switching tabs returns immediately to each agent's cached live frame.

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
code --install-extension claude-tmux-sidebar-0.9.0.vsix --force
```

Alternatively use VS Code: **Extensions → … → Install from VSIX…**, select the
generated file, then run **Developer: Reload Window**.

For Remote-SSH, install the VSIX in the remote extension host from the connected
window. `tmux`, `claude` and `codex` must be available on that same remote host.

The **AgentMux** icon appears in the Activity Bar. You can drag its view to the
Secondary Side Bar; VS Code remembers the layout.

## Daily workflow

1. Open a project folder in VS Code.
2. Open **AgentMux**. If no agent is running, choose Claude or Codex from the
   central launcher. Use `+` later to add the other agent.
3. Start or resume:
   - Claude shows conversations read only from this folder's Claude project data;
   - Codex opens `codex resume` in this folder, using Codex's cwd-filtered picker.
4. Click the mirror and type. Switch visible tabs whenever you want; both tmux
   sessions continue running independently.
5. Scroll with the wheel or scrollbar. Use `Shift+PageUp/PageDown` from the
   keyboard. Plain `PageUp/PageDown` are still forwarded to the agent TUI.

The toolbar actions always target the selected tab:

| Action | Result |
|---|---|
| Resume / switch | Resume a Claude conversation or open the Codex resume picker. |
| Restart | Replace only the selected workspace tmux and relaunch its agent cleanly. |
| Hand off | Open the editable Pair Mode handoff to the other agent. |
| Kill | Kill only the selected agent's workspace session. |
| Manage | List at most the Claude and Codex sessions belonging to this workspace. |

## Pair Mode

Pair Mode coordinates the agents sequentially and refuses a handoff while
either side is detected as working:

1. Select the agent that currently owns the work and press `⇄`.
2. Add optional details for the other agent. Nothing is sent until you press
   **Create handoff**.
3. If the other agent has no workspace tmux, the extension offers to start it.
4. AgentMux asks the source agent to author a standalone briefing specifically
   for the target: objective, completed work, files, decisions, tests, risks and
   the recommended next action.
5. Fresh Git facts are added separately. Choose **Continue task**, **Review
   only** or **Review & Fix**, then freely edit the complete message.
6. Only **Send handoff** delivers the reviewed message. The target then emits a transaction acknowledgement. On success,
   it becomes the Pair Mode writer. If the best-effort acknowledgement is not
   observed, AgentMux offers manual acceptance without resending. The other tab remains
   visible and scrollable, but its input is locked in this extension.
7. Hand back with `⇄`, or release the lock with `◇`.

The compact footer shows pane size, session uptime and agent state. It also
shows available history, attached tmux clients and capture lag when that lag is
high enough to matter; these values reuse the existing live snapshot.

The lock coordinates input sent through this side bar; it cannot stop a turn
that was launched outside the extension or prevent a user/process attached to
the same tmux session elsewhere from editing files.
**Review only** is an instruction to the agent, not an operating-system sandbox.

## Shared `.claude` rules

With `claudeTmux.codexReadClaudeRules` enabled (the default), every Codex start,
resume and restart receives a developer instruction to recursively discover and
read all Markdown files below the workspace `.claude` directory before working.
This includes `.claude/CLAUDE.md` and any other nested `.md` files. The extension
does not copy or modify those rules, so `.claude` remains the single source of
truth for both agents.

The bridge uses Codex's per-launch `developer_instructions`. If
`claudeTmux.codexArgs` already defines that key, the bridge is skipped and the
extension warns once instead of silently replacing the explicit value. An
existing global Codex `developer_instructions` value is replaced for bridged
launches; keep durable project constraints in `.claude`, or disable the bridge
and compose the instruction yourself in `codexArgs`.

Codex is also started in **Full Access** by default. This was chosen for the
requested workflow, but it disables Codex approvals and sandboxing. Turn off
`claudeTmux.codexFullAccess` for repositories you do not fully trust.

## Settings

The existing `claudeTmux.*` namespace is retained so upgrades keep current user
settings.

| Setting | Default | Meaning |
|---|---|---|
| `claudeTmux.refreshMs` | `120` | Mirror refresh interval in milliseconds. |
| `claudeTmux.claudeArgs` | `--dangerously-skip-permissions --ide` | Arguments used for Claude start/resume. |
| `claudeTmux.codexArgs` | `--no-alt-screen` | Arguments used for Codex start/resume; the default preserves scrollback. |
| `claudeTmux.codexFullAccess` | `true` | Add Codex's approval/sandbox bypass flag. Disable for untrusted repositories. |
| `claudeTmux.codexReadClaudeRules` | `true` | Tell Codex to read every Markdown file recursively under `.claude`. |
| `claudeTmux.sessionPrefix` | `tmux_` | Claude session prefix. |
| `claudeTmux.codexSessionPrefix` | `codex_` | Codex session prefix. |
| `claudeTmux.scrollbackLines` | `1000` | Captured history lines, from 0 to 5000. |
| `claudeTmux.fontFamily` | `""` | Empty inherits `terminal.integrated.fontFamily`. |
| `claudeTmux.fontSize` | `0` | Zero inherits `terminal.integrated.fontSize`. |
| `claudeTmux.cursorStyle` | `block` | `block`, `bar` or `underline`. |
| `claudeTmux.autoResume` | `false` | Optionally auto-resume the newest Claude conversation when the view opens. |

## Scope and limits

- A workspace folder is required; the extension never falls back to `$HOME`.
- In a multi-root workspace, the first root is used.
- `working`, `finished` and `needs input` are visual heuristics
  based on submitted input, pane changes and common prompts; they are not an
  agent protocol and can occasionally be wrong.
- This is a polled terminal mirror, not a full PTY. Mouse input is not forwarded.
- Scrollback is bounded by `claudeTmux.scrollbackLines` and tmux's own history.
- Multi-line paste is sent raw and a newline may submit input.
- Pair Mode transfers a source-authored, target-specific snapshot and uses a
  best-effort terminal acknowledgement; it remains sequential and user-reviewed.
- A tab disappears when the agent TUI exits even if its tmux shell remains; the
  launcher can start the agent again in that workspace session.

See [USER_GUIDE.md](USER_GUIDE.md) for troubleshooting and [TESTING.md](TESTING.md)
for the installation smoke test.
