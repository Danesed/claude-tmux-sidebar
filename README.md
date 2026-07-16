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

- a persistent tmux **control-mode client** drives everything by default: no
  fork/exec per refresh, and tmux *pushes* an output notification the moment the
  active pane changes (a `pipe-pane` tap and classic polling are automatic
  fallbacks — `claudeTmux.transport`);
- each refresh fuses the frame and its cursor/size metadata into one atomic
  call, and small changes travel to the view as **per-line deltas**;
- the refresh loop is adaptive: hot while you type or output streams, slow when
  the pane is static, watchdog-only when push notifications are live;
- one ordered input pump merges pending keystrokes under backpressure, while
  bracketed paste preserves large UTF-8 input; printable keys get an instant
  display-only **predictive echo** until the real frame lands;
- a **Claude** or **Codex** tab appears only while that workspace's matching
  tmux session exists; tabs carry live state dots and an activity sparkline;
- the `+` menu starts or resumes an absent agent (Codex conversations are now
  listed natively from `~/.codex/sessions`, workspace-filtered);
- `Cmd/Ctrl+click` a `path/file.js:42` in agent output to open it in the editor;
- `Alt+Up` recalls previously submitted prompts (reconstructed locally from
  your keystrokes, never from agent output);
- mouse wheel, scrollbar and `Shift+PageUp` / `Shift+PageDown` navigate history;
  large history captures render virtualized, so scrolling up never hitches;
- new output follows automatically only while you are at the bottom;
- switching tabs paints an at-most-seconds-old frame instantly (background
  captures keep the inactive tab's cache warm).

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
code --install-extension claude-tmux-sidebar-0.10.0.vsix --force
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
6. Only **Send handoff** delivers the reviewed message. By default the briefing
   is written to `.claude/agentmux/handoff-<id>.md` and only a short pointer is
   pasted into the target TUI; the target acknowledges by writing
   `.claude/agentmux/ack-<id>` (or printing the marker line if it cannot write
   files). On success it becomes the Pair Mode writer. If the best-effort
   acknowledgement is not observed, AgentMux offers manual acceptance or
   dismissal without ever resending. A delivered handoff even survives a VS Code
   restart (rehydrated from the workspace ledger as manual-accept only).
7. After a **Review only** / **Review & Fix** handoff completes, `↩` asks the
   reviewer to author a structured findings report and hands it back to the
   original author under the same acknowledgement rules.
8. Hand back with `⇄`, release the lock with `◇`, or audit everything in the
   `◷` Timeline.

### Arbiter mode

`⚖` (or **AgentMux: Ask both agents**) sends one question to Claude and Codex
in parallel — answers only, no file changes. Both replies are gathered through
the `.claude/agentmux` channel and shown side by side; the answer you pick makes
that agent the Pair Mode writer and tells it to proceed.

The briefing capsule now includes recent commits, capped real diff hunks, your
task file (`claudeTmux.handoffTodoFile`), optional verify-command output
(`claudeTmux.handoffVerifyCommand`, trust-gated) and best-effort conversation
resume pointers, in addition to the Git status/stat facts.

The compact footer shows pane size, session uptime and agent state — plus, when
available, token usage and turn count tailed from the CLI's own local
transcript, the current tool while working, and the last turn's git delta
(`Δ3 +120−14`). It also shows available history, attached tmux clients and
capture lag when that lag is high enough to matter. All of it reuses existing
snapshots and local file reads; nothing new runs on the live refresh path and
nothing leaves your machine.

Agent state is no longer only a heuristic: managed launches install Claude Code
lifecycle hooks and a Codex notify program that stamp `working` /
`needs-input` / `done` (and the current tool) into tmux pane options, which the
extension already reads for free. Per-agent **status bar items** mirror this
everywhere in VS Code, the view badge counts agents that finished or are
waiting, and when a hidden agent asks a numbered question a notification offers
its options as one-click answer buttons (explicit, identity-pinned, never
automatic). Anyone attached to the tmux session from a real terminal sees the
same facts on the tmux status line.

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
| `claudeTmux.transport` | `auto` | `auto` (control mode → pipe tap → polling), `control`, `pipe`, or `poll`. |
| `claudeTmux.predictiveEcho` | `true` | Instant display-only echo of printable keystrokes. |
| `claudeTmux.fileLinks` | `true` | Cmd/Ctrl+click `file:line` tokens to open them in the editor. |
| `claudeTmux.showSparklines` | `true` | Per-agent activity sparkline in the tabs. |
| `claudeTmux.promptHistory` | `true` | Alt+Up prompt recall (workspace-local; clear via command). |
| `claudeTmux.statusBarItems` | `true` | One status bar item per running agent. |
| `claudeTmux.notifyPrompts` | `true` | Notification with answer buttons when a background agent asks. |
| `claudeTmux.stateHooks` | `true` | Ground-truth state via Claude hooks / Codex notify. |
| `claudeTmux.telemetry` | `true` | Token/turn/tool chips tailed from local CLI transcripts. |
| `claudeTmux.eventLog` | `true` | Timeline ledger at `.claude/agentmux/ledger.jsonl`. |
| `claudeTmux.tmuxStatusBar` | `true` | AgentMux facts on the tmux status line of agent sessions. |
| `claudeTmux.fileChannel` | `true` | Handoffs/ACKs/arbiter answers travel as `.claude/agentmux` files. |
| `claudeTmux.handoffDiffChars` | `6000` | Diff-hunk budget in briefings (0 disables). |
| `claudeTmux.handoffTodoFile` | `tasks/todo.md` | Task file included in briefings (empty disables). |
| `claudeTmux.handoffVerifyCommand` | `""` | Optional trust-gated verify command run once at draft time. |
| `claudeTmux.renderer` | `dom` | `dom` or experimental vendored `xterm` for the live screen. |

## Scope and limits

- A workspace folder is required; the extension never falls back to `$HOME`.
- In a multi-root workspace, the first root is used.
- With `stateHooks` off (or unmanaged launches), `working`, `finished` and
  `needs input` fall back to visual heuristics based on submitted input, pane
  changes and common prompts; they can occasionally be wrong.
- The control-mode client parks on a private `_agentmux_ctl_<pid>` session and
  rides along on the active agent session to receive push notifications; it is
  excluded from the footer's client count and cleans up after itself.
- Transcript telemetry parses the CLIs' local JSONL files, which are not a
  stable API; the chips silently disappear if a format changes.
- This is a terminal mirror, not a full PTY. Mouse input is not forwarded.
- The experimental xterm renderer draws the live screen only; history mode and
  text selection use the DOM renderer.
- Scrollback is bounded by `claudeTmux.scrollbackLines` and tmux's own history.
- Multi-line paste is sent raw and a newline may submit input.
- Pair Mode transfers a source-authored, target-specific snapshot and uses a
  best-effort terminal acknowledgement; it remains sequential and user-reviewed.
- A tab disappears when the agent TUI exits even if its tmux shell remains; the
  launcher can start the agent again in that workspace session.

See [USER_GUIDE.md](USER_GUIDE.md) for troubleshooting and [TESTING.md](TESTING.md)
for the installation smoke test.
