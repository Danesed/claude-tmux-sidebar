# Changelog

## 0.10.2
- Fix the mirror cursor sticking to the top-left corner and the frame jittering up/down on hosts whose tmux octal-escapes control characters in `display-message` output (e.g. tmux 3.4 on Ubuntu 24.04, typical Remote-SSH targets): the `\x1f` cursor-meta sentinel can arrive as the literal text `\037`, so the meta never parsed, the cursor defaulted to (0,0), and the unstripped meta line rendered as an extra changing bottom row that made the view scrollable and re-pinned the follow scroll on every tick. Both sentinel forms are now parsed and stripped; wheel-up scrollback and the footer size/uptime/hist chips work on these hosts again.
- The webview now hides the cursor when no cursor meta has been parsed instead of painting it at the top-left corner.
- Control-client deaths (watchdog kill, tmux exit) are now marked as transport failures and idempotent commands retry once over execFile, so a wedged control client no longer flashes the "no session" overlay, raises false "stopped" toasts, or reads as failed input. Input commands are never retried — nothing is ever replayed.
- Speed up the resume-session list: transcripts are no longer read in full; a head chunk yields the title, a tail chunk the newest `/rename`, and file mtime stands in for last activity. Large transcript folders no longer freeze the overlay.
- Background tab captures now carry cursor meta, so switching agents paints the cached frame with a correctly placed cursor instead of a stale one.
- Programmatic scroll writes now use a consume-once flag tied to the event they cause, instead of timing-dependent set/clear around a frame callback.
- Default tmux session prefixes are now `tmux_claude_` (Claude) and `tmux_codex_` (Codex). If you relied on the old defaults (`tmux_`, `codex_`), running sessions keep their old names — set `claudeTmux.sessionPrefix` / `claudeTmux.codexSessionPrefix` back to the old values, or finish those sessions before updating.

## 0.10.1
- Fix intermittent unresponsive typing on some tmux versions: the control-mode client now writes one command per control line instead of ';'-fused lines. Fused lines yield a version-dependent number of `%begin` reply blocks, which desynchronized the reply queue — keystrokes stalled until the 10s watchdog killed the client and dropped everything in flight, and the `\x1f` cursor-meta line leaked into the rendered frame as an incrementing number line under the agent's footer (also mispositioning/hiding the mirror cursor).
- Strip any leaked meta line from frames as defense in depth, and never mistake legitimate pane bytes for the sentinel.
- Input suspension around session operations is now depth-counted and watchdog-released, so a wedged tmux call can no longer swallow typing forever.
- Slim down: removed the per-tab activity sparklines, the predictive keystroke echo overlay, and the experimental vendored xterm.js renderer (~490 KB) with their settings (`showSparklines`, `predictiveEcho`, `renderer`). tmux already does the terminal emulation; the DOM mirror stays the single renderer.

## 0.10.0
- Fuse the pane capture and cursor/size metadata into one tmux invocation per tick: cursor position is now always exactly as fresh as the frame it describes and the live path costs a single process.
- Add a persistent tmux control-mode client (`claudeTmux.transport`, default `auto`) that replaces fork/exec-per-command and pushes output notifications via format subscriptions on the active pane; a `pipe-pane` FIFO tap is the fallback event source and classic polling remains the watchdog. Failed in-flight input is reported, never replayed.
- Make the refresh loop adaptive: hot while typing or output streams, configured rate normally, slow decay when static, watchdog-only when a push source is live.
- Ship background presence captures to the tab cache, so switching agents paints an at-most-seconds-old frame instantly.
- Transport small screen changes as per-line deltas with sequence-checked resync; the webview patches only the changed rows.
- Add display-only predictive local echo (mosh-style), virtualized rendering for large history captures, Cmd/Ctrl+click file:line links that open in the editor, Alt+Up prompt recall (host-reconstructed, ESC-safe), per-agent activity sparklines and a first-run environment checklist.
- Ground-truth agent state via generated Claude Code hooks and a Codex notify program stamping tmux pane options (heuristic remains the fallback); the footer, tabs, per-agent status bar items and richer view badge now show state, elapsed time, current tool, token/turn telemetry from local transcript tails, and per-turn git deltas.
- Raise an actionable notification when a background agent asks a question; numbered menu options become identity-pinned answer buttons (explicit, never automatic).
- Record session, turn, input-discard, handoff and arbiter events to `.claude/agentmux/ledger.jsonl` with a Timeline overlay; a delivered handoff now survives an extension-host restart as manual-accept only.
- Move the handoff exchange onto the `.claude/agentmux` file channel (briefing file + short pasted pointer + ACK file) with the pane-marker block as automatic fallback; `.claude` remains the agents' only coordination medium and Codex's rule bridge now skips the transient channel directory.
- Enrich the briefing capsule with recent commits, capped real diff hunks, the task file, an opt-in trust-gated verify command's output and best-effort conversation resume pointers.
- Add a findings round-trip after review-mode handoffs, native Codex session listing/resume from `~/.codex/sessions`, and an arbiter mode that asks both agents in parallel and makes the chosen winner the Pair Mode writer.
- Set the agent sessions' tmux status-right to compact AgentMux facts for real-terminal attachers, and add an experimental vendored xterm.js renderer (`claudeTmux.renderer`, default `dom`).

## 0.9.0
- Rename the public extension to **AgentMux — Claude & Codex in tmux**, preserving the installed extension ID and `claudeTmux.*` settings.
- Add an optional user-details step before source-agent handoff generation; the initial click no longer contacts either agent.
- Preserve the generated full-message review before delivery and rehydrate the preliminary details after a webview reload.
- Extend the footer with scrollback size, attached tmux clients and a lag warning without adding a live-path process.

## 0.8.0
- Rebrand the public extension as **PairMux — Claude & Codex in tmux** while preserving the installed extension ID and `claudeTmux.*` settings.
- Replace generic terminal-tail handoffs with source-authored, target-specific briefings, fresh repository facts, editable Continue/Review modes and transaction validation.
- Add best-effort target acknowledgement with a manual-accept timeout path and no automatic resend.
- Replace chained input batches with a one-in-flight pump that merges pending input under tmux/SSH backpressure and reports delivery failures.
- Restore terminal control keys, improve Unicode/IME handling and preserve byte order for UTF-8 input.
- Reduce idle tmux churn with combined session verification, cached metadata, slower hidden polling and lazy background capture.
- Coalesce resize requests, cache the last frame per agent for instant tab switches and avoid repeated font measurement during sidebar drags.
- Add persistent per-agent completion attention, restart confirmation, session-stop feedback and focused keyboard/ARIA improvements without adding visual chrome.

## 0.7.1
- Fix sluggish typing introduced in 0.6.0/0.7.0: keystrokes no longer re-verify the tmux session identity on every flush. The presence loop keeps a short-lived verified-session cache, so the input hot path is back to a single `tmux send-keys` per flush (as in 0.5.x) while keeping the workspace-isolation safety checks.
- Reuse the cached session identity in the refresh tick, cutting background tmux process spawns roughly in half.
- Cache workspace realpath lookups briefly instead of hitting the filesystem on every keystroke.

## 0.7.0
- Start and resume Codex in Full Access by default, with an explicit safety setting.
- Instruct Codex to read every Markdown rule recursively under workspace `.claude/` by default.
- Batch and serialize per-agent input, preserve the keydown target, and update terminal rows incrementally to remove Codex input lag.
- Capture only the live pane during polling and load bounded scrollback on demand.
- Show Claude and Codex tabs only for matching live workspace sessions, with launcher controls for absent agents.
- Add discreet heuristic animations for working, finished, needs-input and idle states, including reduced-motion support.
- Add sequential Pair Mode with an editable handoff, Review only / Review & Fix modes, source context, git summaries and a single-writer input lock.
- Disable implicit Claude auto-resume by default so opening the view does not create a tab unexpectedly.
- Add automated coverage for launch flags, batched input, UTF-8 paste, lazy history, state detection and exact editable handoff text.

## 0.6.0
- Added Claude and Codex tabs backed by independent persistent tmux sessions.
- Added workspace-path validation and exact tmux targets to prevent cross-project attach, input or kill.
- Added stable path-hash disambiguation for projects sharing the same basename.
- Added bounded scrollback, mouse/scrollbar navigation, keyboard scrolling, auto-follow and per-tab scroll positions.
- Added Codex start and cwd-filtered native resume flow with configurable arguments.
- Restricted the manage command to the current workspace's Claude and Codex sessions.
- Removed the unsafe `$HOME` fallback when no workspace folder is open.
- Updated names, commands, settings, install documentation and the VSIX smoke-test checklist.

## 0.5.2
- Auto-resume the folder's most recent conversation on open is now the default
  (set `claudeTmux.autoResume` to false to always show the chooser).

## 0.5.1
- Final app icon (iOS-style terracotta logo).

## 0.5.0
- **Manage / kill tmux sessions…** command — multi-select any of your tmux
  sessions and kill them (only your own are ever listed).
- **Activity badge**: when Claude updates while the view is hidden, the
  activity-bar icon shows an unread count.
- **Search filter** in the session chooser (appears with 6+ sessions) and
  **relative timestamps** ("2h ago").
- **Copy-friendly**: the mirror no longer refreshes while you have text selected,
  so you can select and copy output.
- **Richer status footer**: session name · pane size · uptime · live/idle/stopped.
- **Configurable cursor** (`block` / `bar` / `underline`) and **auto-resume** of
  the most recent conversation on open.
- New keybinding to focus the view (`Cmd/Ctrl+Shift+A`, rebindable).
- More iconic logo.

## 0.4.0
- Renamed sessions to **`tmux_<folder>`**.
- In-side-bar **session chooser**: pick a past conversation to resume on open.
- Mirror now **inherits your terminal font** (Nerd Font / Powerline glyphs render
  correctly).

## 0.3.0
- Fixed the "attach to existing session" picker (correct project-path encoding).
- Status footer, redesigned empty state, blinking cursor, focus ring.

## 0.2.0
- Added "Attach to an existing session…" (resume past conversations).

## 0.1.0
- First version: mirror the folder's Claude tmux session in a Secondary Side Bar
  view via `tmux capture-pane` + `tmux send-keys`.
