# Claude Tmux Sidebar

Shows **only** your folder's Claude tmux session as a view you can drag into the
**Secondary Side Bar** (right), next to your other agentic chats — without
touching the bottom Panel or any of your other terminals.

It does **not** open a terminal. It mirrors the tmux pane:
- reads the screen with `tmux capture-pane` (refreshed a few times/second)
- sends your keystrokes back with `tmux send-keys`
- renders with the **same font as your integrated terminal** (so Nerd Font /
  Powerline prompt glyphs look right)

One tmux session per folder, named **`tmux_<folder>`**. The same session is
reachable from the side bar, a panel terminal, or a headless SSH login.

## Workflow

1. Open the project folder over Remote-SSH.
2. Open the **Claude Tmux** view in the right side bar.
3. It shows the current folder's past Claude conversations — **click one to
   resume it** (creates/attaches `tmux_<folder>` running `claude --resume <id>`),
   or **＋ Start new session**.
4. Click the view and type. Toolbar: **🕘 Attach** (switch conversation),
   **↻ Restart**, **🗑 Kill**.

## Build & install (on the machine where tmux + claude live)

```bash
cd claude-tmux-sidebar
npx @vscode/vsce package          # -> claude-tmux-sidebar-<version>.vsix
```

- **Local VS Code:** `code --install-extension claude-tmux-sidebar-<version>.vsix`
- **Remote-SSH:** copy the `.vsix` to the lab machine, then in the Remote-SSH
  window: Extensions → `…` → *Install from VSIX…* (or
  `code --install-extension /path/on/remote/file.vsix` in its terminal).
  Then **Developer: Reload Window**.

First run: a **Claude Tmux** icon appears in the Activity Bar — **drag the view
into the Secondary Side Bar** once; VS Code remembers it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeTmux.refreshMs` | `250` | Mirror refresh interval (ms). |
| `claudeTmux.claudeArgs` | `--dangerously-skip-permissions --ide` | Args for `claude` on start/resume. |
| `claudeTmux.sessionPrefix` | `tmux_` | Session = `<prefix><folder name>`. |
| `claudeTmux.fontFamily` | `""` | Mirror font. Empty = inherit `terminal.integrated.fontFamily`. |
| `claudeTmux.fontSize` | `0` | Mirror font size (px). `0` = inherit `terminal.integrated.fontSize`. |
| `claudeTmux.cursorStyle` | `block` | Cursor shape: `block` / `bar` / `underline`. |
| `claudeTmux.autoResume` | `true` | On open, auto-resume the folder's most recent conversation (off = always show chooser). |

## Known limits

- It's a **mirror**, not a full PTY: no native scrollback (use Claude's own
  scrolling), no mouse forwarding, refresh is polled not streamed.
- Pasted multi-line text is sent raw (a newline may submit). Fine for typing and
  short pastes.
- `tmux` and `claude` must be on PATH on the machine the extension runs on.
- Requires tmux ≥ 2.9 for side-bar-driven window resizing.
- The mirror font must be installed **locally** (the webview renders on your
  machine). Since your real terminal already shows it, it is.
