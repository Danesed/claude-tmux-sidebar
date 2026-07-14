# Claude & Codex Tmux Sidebar — User Guide

## Install

Build the VSIX on a machine with Node.js:

```bash
cd claude-tmux-sidebar
npm run check
npm run package
```

Install `claude-tmux-sidebar-0.7.0.vsix` from **Extensions → … → Install from
VSIX…**, then reload VS Code. From a shell you can instead run:

```bash
code --install-extension claude-tmux-sidebar-0.7.0.vsix --force
```

With Remote-SSH, perform the install from the connected VS Code window so the
extension runs beside the remote `tmux`, `claude` and `codex` binaries.

## Use both agents

Open a folder, then open the **Tmux Agents** Activity Bar view. Tabs are not
placeholders: each one appears only after the matching tmux session has been
detected for this workspace. Use the initial launcher or `+` to start an absent
agent.

### Claude tab

- **Start new Claude** creates `tmux_<folder>` in the workspace root.
- Existing Claude conversations shown in the card come only from that folder's
  `~/.claude/projects/...` directory.
- **Resume / switch** in the toolbar opens the same folder-filtered list.

### Codex tab

- **Start new Codex** creates `codex_<folder>` in the workspace root.
- Start, resume and restart use Full Access by default. Disable
  `claudeTmux.codexFullAccess` if approvals and sandboxing are required.
- **Resume previous session** or the toolbar resume action replaces the current
  Codex tmux session and starts `codex resume` in the workspace root.
- Codex's own picker filters sessions by cwd because the extension never passes
  `--all`.

Clicking the other tab changes only the mirror target. It does not stop, detach
or restart either agent. The last selected tab is restored after reload.

## Pair Mode: exact workflow

1. Finish or pause the current agent and select its tab.
2. Press `⇄` in the footer or run **Tmux Agents: Hand off to the other agent…**.
3. If the source still looks active, confirm that you want to prepare the
   handoff. If the target tmux is absent, allow the extension to start it.
4. The dialog contains an automatically prepared message with git status,
   staged and unstaged diff summaries, and the last 60 source-pane lines.
5. Select **Review only** or **Review & Fix**. The entire textarea is editable:
   add, delete or replace anything before pressing **Send handoff**.
6. The edited text is sent unchanged and submitted to the target. That agent is
   marked with a small diamond and becomes the only tab accepting input through
   this extension. The source remains readable and scrollable.
7. Press `⇄` from the writer to hand the work back, or `◇` to unlock both tabs.

Pair Mode never commits, resets or reverts the working tree. Its lock applies to
this VS Code view only; another tmux client can still type into either session.
The target gets a snapshot, not a continuous hidden chat channel, which keeps
file ownership explicit and prevents automatic concurrent edits.

The handoff is rejected while either agent is marked working and the editor
stays open on validation or delivery errors. Because activity is inferred from
terminal output, stop any turn started from another tmux client before handing
off.

## Project rules for both agents

Claude continues to use its normal project-instruction behavior. For Codex, the
default `claudeTmux.codexReadClaudeRules` option adds a launch instruction to
recursively read every Markdown file under `.claude/`, including nested files,
before doing work and again when relevant rules change. No `AGENTS.md` is
generated and no `.claude` file is altered.

This bridge occupies the per-launch Codex `developer_instructions` value. An
explicit value in `claudeTmux.codexArgs` wins and triggers a one-time warning;
global developer instructions are replaced for bridged launches. Put the shared
project constraints in `.claude`, or disable the bridge and merge them manually.

## Scroll and input

- Mouse wheel and the scrollbar load and navigate up to
  `claudeTmux.scrollbackLines` on demand. Normal live refreshes capture only the
  current pane, which keeps Codex input responsive.
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

The footer and each tab show a discreet state:

- **working**: input was submitted and/or output continues changing;
- **finished**: output stabilized after work;
- **needs input**: a common confirmation or approval prompt was detected;
- **idle**: the session exists without detected activity;
- **stopped**: no matching workspace session exists.

These states are terminal-output heuristics, not private Claude/Codex APIs.
`working` starts on a submitted Enter; `finished` appears after output has been
stable for four seconds. A silent long-running tool or an external tmux client
can still make the result imperfect. Motion is reduced automatically when the
OS requests reduced motion.

Toolbar actions are scoped to the active tab. The manage action shows zero, one
or two entries and rechecks the workspace path immediately before killing.

## Troubleshooting

- **No workspace**: open a folder, not only an individual file.
- **Typing does nothing**: click the mirror and verify the focus border.
- **A tab disappeared**: its matching workspace tmux ended. Restart it from `+`.
- **The tmux still exists but its tab disappeared**: the Claude/Codex TUI exited
  to its shell. Use `+` to start it again; handoffs are never sent to that shell.
- **A tab is read-only**: Pair Mode assigned the other agent as writer; hand off
  from that writer or press `◇` to release the lock.
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
- **Full Access is too permissive**: set `claudeTmux.codexFullAccess` to `false`.
- **Codex should ignore `.claude` rules**: set
  `claudeTmux.codexReadClaudeRules` to `false`.

For a clean end-to-end check after installing, follow [TESTING.md](TESTING.md).
