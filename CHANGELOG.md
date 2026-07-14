# Changelog

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
