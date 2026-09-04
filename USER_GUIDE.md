# AgentMux — User Guide

## Install

Build the VSIX on a machine with Node.js:

```bash
cd claude-tmux-sidebar
npm run check
npm run package
```

Install `claude-tmux-sidebar-0.16.0.vsix` from **Extensions → … → Install from
VSIX…**, then reload VS Code. From a shell you can instead run:

```bash
code --install-extension claude-tmux-sidebar-0.16.0.vsix --force
```

With Remote-SSH, perform the install from the connected VS Code window so the
extension runs beside the remote `tmux`, `claude` and `codex` binaries.

## Use both agents

Open a folder, then open the **AgentMux** Activity Bar view. Tabs are not
placeholders: each one appears only after the matching tmux session has been
detected for this workspace. Use the initial launcher or `+` to start an absent
agent.

### Claude tab

- **Start new Claude** creates `tmux_claude_<folder>` in the workspace root.
- Existing Claude conversations shown in the card come only from that folder's
  `~/.claude/projects/...` directory.
- **Resume / switch** in the toolbar opens the same folder-filtered list.

### Codex tab

- **Start new Codex** creates `tmux_codex_<folder>` in the workspace root.
- **Start new OpenCode** creates `tmux_opencode_<folder>` and runs `opencode`.
  Its live state comes from a small AgentMux plugin installed into
  `~/.config/opencode/plugins/`; it only ever acts on panes AgentMux launched
  (they carry `AGENTMUX=1`), and **AgentMux: Remove agent integrations** deletes it.
  OpenCode publishes its own session index, so the side bar lists real past
  conversations for the folder — only sessions rooted in this workspace are
  offered, because OpenCode binds a resumed session to the directory it was
  created in — and resumes one with `opencode --session <id>`;
  **Resume previous session** runs `opencode --continue`.
- **Start new Hermes** creates `tmux_hermes_<folder>` and runs Nous Research's
  `hermes`. Past conversations come from the CLI's own store (`hermes sessions
  list`), so the side bar lists real sessions for the folder and resumes one
  with `hermes --resume <id> --in <workspace>` — the `--in` pins the agent to
  the open project, because Hermes would otherwise `cd` into the resumed
  session's recorded directory (possibly another folder). **Resume previous
  session** runs `hermes --continue --in <workspace>` (workspace-scoped most
  recent), and `hermes sessions browse` opens its own picker inside the pane.
  Approvals are set with `approvals.mode` in `~/.hermes/config.yaml`, not by
  a launch flag.
- **Start new Pi** creates `tmux_pi_<folder>` and runs Earendil's `pi`. Its live
  state comes from a small AgentMux extension installed into
  `~/.pi/agent/extensions/`; like the OpenCode plugin it only ever acts on panes
  AgentMux launched (they carry `AGENTMUX=1`), and **AgentMux: Remove agent
  integrations** deletes it. pi keeps readable per-folder transcripts, so the
  side bar lists real past conversations (with their `/name` titles) and resumes
  one with `pi --session <id>`; **Resume previous session** runs `pi --continue`.
  Both stay inside the open project: pi looks an id up in the current project
  before anywhere else, and AgentMux only ever offers ids from this folder.
  `claudeTmux.piArgs` is empty by default because pi has no approval prompts to
  bypass — it ships no sandbox. The one prompt it does show is a first-run
  *project trust* question about loading the repository's own `.pi` settings and
  extensions; answer it once in the pane, or add `-a` to answer it for every run.
- **Start new Antigravity** creates `tmux_agy_<folder>` in the workspace root and
  runs Google's `agy` CLI. Antigravity keeps its conversations in a local
  database rather than per-folder transcripts, so the side bar offers no
  conversation list for it; **Resume previous session** runs `agy --continue`.
- **Start new Devin** creates `tmux_devin_<folder>` in the workspace root and runs
  Cognition's `devin` CLI. The launcher lists this workspace's Devin sessions via
  `devin list --format json`; picking one runs `devin -r <id>` in the workspace session,
  and **Resume previous session** runs `devin -c`.
- Start, resume and restart use Full Access by default. Disable
  `claudeTmux.codexFullAccess` if approvals and sandboxing are required.
- The launcher card now lists this workspace's Codex conversations natively
  (read from `~/.codex/sessions`, cwd-filtered); picking one runs
  `codex resume <id>` in a fresh workspace session.
- **Resume previous session** still opens Codex's own cwd-filtered picker
  (`codex resume` without `--all`).

Clicking the other tab changes only the mirror target. It does not stop, detach
or restart either agent. The last selected tab is restored after reload.

## Pair Mode: exact workflow

1. Finish or pause the current agent and select its tab.
2. Press `⇄` in the footer or run **AgentMux: Hand off to the other agent…**.
3. Add any optional context for the other agent, then press **Create handoff**.
   Opening this step does not send anything to either agent.
4. AgentMux asks the source agent to create a concise, standalone handoff
   specifically for the target. No raw chat tail is used as the summary.
5. The dialog shows that authored briefing plus fresh, separate Git facts.
6. Select **Continue task**, **Review only** or **Review & Fix**. The entire textarea is editable:
   add, delete or replace anything before pressing **Send handoff**.
7. The edited text is delivered unchanged. By default it is written to
   `.claude/agentmux/handoff-<id>.md` and only a short pointer prompt is pasted
   into the target TUI; the target acknowledges by creating
   `.claude/agentmux/ack-<id>` (write-restricted agents print the marker line
   instead — same rules, automatic fallback). AgentMux waits for the
   acknowledgement before moving the writer diamond. On timeout, accept manually
   or dismiss; AgentMux never resends the work automatically. A delivered
   handoff survives a VS Code restart and is offered again as manual-accept.
8. After a review-mode handoff, `↩` asks the reviewer for a structured findings
   report and hands it back to the original author (same transaction rules,
   linked to the original handoff).
9. Press `⇄` from the writer to hand the work back, or `◇` to unlock both tabs.
   `◷` opens the Timeline: session starts/stops, turns with durations and git
   deltas, discarded input, and every handoff/arbiter transition, all recorded
   in `.claude/agentmux/ledger.jsonl`.

## Arbiter: ask both agents

Press `⚖` (both agents must be running and idle), type one question, and
AgentMux delivers it to Claude and Codex in parallel with an answers-only,
no-file-changes instruction. Both marked answers are collected through
`.claude/agentmux/answer-<id>-<agent>.md` (pane markers as fallback) and shown
stacked for comparison. Picking a winner makes that agent the Pair Mode writer
and tells it to proceed; input to both panes stays paused while answers are
being gathered (up to 3 minutes, cancellable).

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

## Multi-line prompts

`Shift+Enter` breaks the line instead of submitting. There is no single byte
sequence every agent understands for this, so each one's was measured in a live
pane: Claude, Codex and OpenCode read CSI-u; Hermes, pi and Antigravity read
xterm modifyOtherKeys. Plain `Enter` still submits.

You do **not** need `set -g extended-keys on` in `~/.tmux.conf` for this, even
though pi's own documentation asks for it. That setting controls how tmux
translates keys from a terminal; AgentMux writes the bytes straight into the
pane and never asks tmux to translate anything. The line in your `.tmux.conf`
still matters if you attach to the same session from a real terminal.

A free-mode agent declares its own with `modEnter` (`"\\x1b[13;2u"` or
`"\\x1b[27;2;13~"`). Without one, `Shift+Enter` submits, as it always did — the
wrong sequence types visible junk into the input box, so it is never guessed.

## Scroll and input

- Mouse wheel and the scrollbar load and navigate up to
  `claudeTmux.scrollbackLines` on demand. Normal live refreshes capture only the
  current pane, which keeps Codex input responsive.
- If tmux history is empty, wheel movement forwards page navigation to the agent TUI.
- `Shift+PageUp` and `Shift+PageDown` scroll the mirror by one viewport.
- Plain `PageUp` and `PageDown` go to the active agent.
- While the view is at the bottom, new output auto-follows.
- After scrolling up, refreshes preserve the reading position.
- Switching agents returns to the cached live frame; history remains available on demand.
- Click the terminal mirror before typing; the focus border confirms input.
- Terminal control keys reach tmux; on Windows/Linux `Ctrl+C` copies only when
  text is selected and otherwise interrupts the active agent.
- Text selection pauses visual replacement until the selection is released,
  making copy reliable during frequent refreshes.

## Workspace isolation

The name is not the security boundary. Before capture, input, resize, restart or
kill, the extension checks that tmux reports `session_path` equal to the current
workspace root. Tmux targets also use exact-name syntax.

If another project with the same basename already owns `tmux_claude_<folder>`,
`tmux_codex_<folder>`, `tmux_opencode_<folder>`, `tmux_hermes_<folder>`,
`tmux_pi_<folder>` or `tmux_agy_<folder>`, this project uses
`<name>-<path-hash>`. Unrelated sessions are never shown by **Manage this
workspace's tmux sessions…**.

No workspace means no operation: the view asks you to open a folder and does not
use the home directory as a fallback. Multi-root workspaces use the first root.

**Free mode is the deliberate exception.** A `claudeTmux.customAgents` entry with
a `session` name mirrors a tmux session you started yourself, wherever it lives —
that is the point of the mode. Because AgentMux did not create it, it is also
excluded from everything that destroys: it is never created, restarted or
resumed over, never offered by **Manage this workspace's tmux sessions…**, and
never listed by **Clean up this project's leftover tmux sessions…**. The single
**Kill active agent session** command can still stop it, and says so explicitly.
Add one from the **＋** at the end of the tab strip: under the list of agents
there is **Mirror a tmux session…**, which shows every running tmux session with
its path and writes the settings entry for you. **Remove a custom agent…**
appears next to it once you have one. Both are also in the palette, as
**AgentMux: Mirror an existing tmux session (free mode)…**.

If that list is empty, nothing is broken — sessions AgentMux already drives are
filtered out of it, so if the only tmux session on the machine is already an
agent tab there is nothing left to mirror. Start the session first:

```bash
tmux new-session -d -s notes
```

then open the **＋** again and it is there.

Entries that carry a `command` instead of a `session` are launched and managed
like any built-in agent.

## Status and toolbar

The footer and each tab show a discreet state:

- **working**: input was submitted and/or output continues changing;
- **finished**: output stabilized after work;
- **needs input**: a common confirmation or approval prompt was detected;
- **idle**: the session exists without detected activity;
- **stopped**: no matching workspace session exists.

With `claudeTmux.stateHooks` on (default), managed launches also install Claude
Code lifecycle hooks, Codex's native lifecycle hooks, an OpenCode plugin and a
pi extension that stamp the true state and current tool into tmux pane options —
the heuristics then only fill gaps. Each integration acts only on panes carrying
`AGENTMUX=1`. Run **AgentMux: Agent integrations: show, install or remove…** to
see every one of them: where it lives, whether it is installed and up to date,
and what it is for. **AgentMux: Remove agent integrations** deletes them all in
one step.

Codex is the one that needs a keypress: its hooks are passed at launch with
`-c`, and Codex asks once to trust the command set ("N hooks need review before
they can run" — press `t`). Until you do, they stay inactive and Codex's
`notify` program still reports `done`; AgentMux shows the tab as *needs input*
while that prompt is up. Nothing is written to your `config.toml` except the
trust record Codex itself writes. When
hooks are unavailable, `working` starts on a submitted Enter and `finished`
appears after output has been stable for four seconds; a silent long-running
tool or an external tmux client can still make the result imperfect. Motion is
reduced automatically when the OS requests reduced motion.

The same compact footer shows pane size and tmux uptime. When available it adds
`hist` for scrollback lines, attached tmux client count, `lag` only when a
capture takes at least 200 ms, token/turn chips tailed from the CLI's local
transcript, the current tool while working, and the last turn's git delta.
These fields reuse existing snapshots and local file reads and do not add
another tmux process. Per-agent status bar items mirror the same state across
all of VS Code (click one to focus that agent), and a hidden agent asking a
numbered question raises a notification whose buttons answer it — after
re-verifying the exact pane identity, and only when you click.

Toolbar actions are scoped to the active tab. The manage action shows zero, one
or two entries and rechecks the workspace path immediately before killing.

Agents that write a summary into the tmux pane title — Claude Code does — show
it as the second line of the tab tooltip, so you can tell two tabs apart without
switching. The title is also read as a state signal where an agent animates it,
and it is read on every poll even for a tab you are not looking at.

### When the dot looks wrong

Screen detection asks *where* a phrase appears, not only whether it does. The
pane is cut into regions and each rule names one, which is why typing "do you
want to delete these files?" at Claude no longer makes its own tab claim it is
asking **you** something: that text is in the prompt box, and the region
needs-input rules read has the prompt box cut out of it.

Some screens say nothing about the agent at all. Claude's transcript viewer
(Ctrl+O) and its model picker cover the pane with their own chrome, so they
**freeze** the status rather than resetting it — otherwise a working agent
decayed to idle behind an open transcript.

Two commands explain a verdict:

- **AgentMux: Explain the active agent's state** — which signal won (a hook, a
  rule, or decay), the regions the current frame was cut into, and what every
  rule made of them.
- **AgentMux: Explain a captured screen** — the same report against a file, with
  no tmux involved:

  ```bash
  tmux capture-pane -p -t '=tmux_claude_myproject:' > screen.txt
  ```

  Useful because a misfiring rule is usually gone by the time you go looking,
  and because the file travels: capture on one machine, explain on another.

Any rule can be replaced in `claudeTmux.detectionRules`; see the README for the
regions, priorities and guards.

## Getting to the right agent

With six or more tabs, "next agent" is rarely what you want. Press
`Ctrl/Cmd+Shift+Alt+A` (**AgentMux: Go to the agent that needs you**) to jump to
whichever agent is blocked on you, or failing that the most recent completion.
**Go back to the previous agent** toggles between the last two you used, and
`nextAgent` / `prevAgent` / `jumpAgent` walk the running ones. Clicking the
status bar item does the same thing as the first command when something wants
you, and cycles otherwise.

A pane is only recognised as an agent it did not launch when the running command
names one. When that command is a plain interpreter (`node`, `python`, `bun`,
`deno`), only the pane title may identify it — otherwise every Node or Python
process running in the folder would appear as an agent tab. Hermes runs as
`python` and does not set a title, so a Hermes you start yourself outside
AgentMux will not be adopted; one AgentMux starts is unaffected.

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
- **A `_agentmux_ctl_<pid>` tmux session appears in `tmux ls`**: that is the
  extension's control-mode client parking session; it destroys itself when the
  client disconnects. Set `claudeTmux.transport` to `poll` to avoid it entirely.
- **Sluggish or missing pushes over odd setups**: try `claudeTmux.transport`
  `pipe` or `poll`; polling always works everywhere.
- **Handoff files in `.claude/agentmux`**: transaction files are transient,
  gitignored and pruned automatically; `ledger.jsonl` is the Timeline's data and
  can be cleared from the Timeline overlay.
- **The agent can't write the ACK file**: sandboxed agents fall back to printing
  the marker line automatically; nothing to configure.
- **Too many chips or badges**: each surface has its own toggle —
  `telemetry`, `showSparklines`, `statusBarItems`, `notifyPrompts`,
  `tmuxStatusBar`, `eventLog`, `predictiveEcho`, `fileLinks`.

For a clean end-to-end check after installing, follow [TESTING.md](TESTING.md).
