# Claude Tmux Sidebar — User Guide

A side-bar view that runs **Claude Code inside a persistent tmux session**, so
your agent survives SSH drops and VS Code restarts — and you can reach the exact
same chat from the side bar, a terminal, or a bare SSH login on your phone.

---

## 1. Why

The official Claude extension ties the agent to your VS Code/SSH connection: close
it and the agent stops. Here, **tmux owns the Claude process** (it's a daemon), so:

- a training-watch or long task keeps running when you disconnect;
- you reattach from VS Code (this view) **or** from a plain SSH shell — same chat;
- one tmux session per project folder, named **`tmux_<folder>`**.

This view is a **mirror**: it reads the tmux pane with `tmux capture-pane` and
sends your keys with `tmux send-keys`. It does not spawn its own terminal, which
is why it can live in the Secondary Side Bar next to your other agentic chats.

---

## 2. Requirements

On the machine the extension runs on (the **remote** lab machine under Remote-SSH):

- `tmux` ≥ 2.9 — `tmux -V`
- `claude` (Claude Code CLI) on `PATH` — `claude --version`

---

## 3. Install

Build a VSIX and install it where tmux + claude live:

```bash
cd claude-tmux-sidebar
npx @vscode/vsce package        # -> claude-tmux-sidebar-<version>.vsix
```

- **Local:** `code --install-extension claude-tmux-sidebar-<version>.vsix`
- **Remote-SSH:** copy the `.vsix` to the lab machine → in the Remote window,
  Extensions → `…` → **Install from VSIX…** → **Developer: Reload Window**.

**First run:** a **Claude Tmux** icon appears in the Activity Bar. **Drag the
view into the Secondary Side Bar** (the right one) once; VS Code remembers it.

---

## 4. Daily workflow

1. Open your project folder over Remote-SSH.
2. Open the **Claude Tmux** view on the right.
3. You'll see the folder's past Claude conversations:
   - **click one** to resume it (creates/attaches `tmux_<folder>` running
     `claude --resume <id>`), or
   - **＋ Start new session** for a fresh chat.
   - With 6+ sessions, a **filter box** appears — type to narrow.
4. Click the screen and type. Detaching is automatic — just close VS Code; the
   tmux session (and Claude) keep running.

### Toolbar buttons

| Icon | Action |
|---|---|
| 🕘 | **Attach** — switch this folder to another conversation |
| ↻ | **Restart** — relaunch `claude` in the current session |
| 🗑 | **Kill** — stop this folder's `tmux_<folder>` session |
| ☰ | **Manage / kill tmux sessions…** — multi-select any of *your* sessions to delete |

### Status footer

`tmux_<folder>` · `cols×rows` · `up <uptime>` · a dot that is **live** (green),
**idle** (yellow, no updates), or **stopped** (red).

### Activity badge

If Claude updates while the view is hidden, the Activity-Bar icon shows an unread
count; opening the view clears it.

---

## 5. The headless companion (`ct`)

For the phone → SSH path (no VS Code), install the `claude-tmux-remote.sh` helper
on the lab machine and use the **same** `tmux_<folder>` sessions from a bare shell:

```bash
cd /path/to/project && ct      # create/attach tmux_<folder>
ct ls        # list your sessions
ct menu      # pick one to attach
ct stop      # pick one to kill
```

Detach with `Ctrl-b d`. Because the names match, the side bar and `ct` drive the
same sessions.

---

## 6. Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeTmux.refreshMs` | `250` | Mirror refresh interval (ms). |
| `claudeTmux.claudeArgs` | `--dangerously-skip-permissions --ide` | Args for `claude`. |
| `claudeTmux.sessionPrefix` | `tmux_` | Session = `<prefix><folder>`. |
| `claudeTmux.fontFamily` | `""` | Empty = inherit `terminal.integrated.fontFamily`. |
| `claudeTmux.fontSize` | `0` | `0` = inherit `terminal.integrated.fontSize`. |
| `claudeTmux.cursorStyle` | `block` | `block` / `bar` / `underline`. |
| `claudeTmux.autoResume` | `true` | Resume the most recent conversation on open (off = always show chooser). |

---

## 7. Troubleshooting

- **Prompt glyphs are boxes** → your terminal font is a Nerd Font not picked up.
  Set `claudeTmux.fontFamily` to that font (it must be installed locally).
- **The chooser is empty** → no Claude sessions for that folder yet, or a path
  edge case. Check `ls ~/.claude/projects/ | grep -i <folder>` on that machine.
- **Box looks cut off on the right** → tmux < 2.9 can't be resized to the side-bar
  width. Upgrade tmux, or widen the side bar.
- **`--ide` didn't connect** → type `/ide` inside Claude once VS Code is open.
- **Typing does nothing** → click the screen first (focus ring appears).

---

## 8. Limits

It's a mirror, not a full PTY: no native scrollback (use Claude's own scrolling),
no mouse forwarding, refresh is polled. For typing + reading Claude it's smooth;
for a 1:1 terminal you'd want the xterm.js + node-pty route (heavier, native
module — not ideal over Remote-SSH on arbitrary machines).
