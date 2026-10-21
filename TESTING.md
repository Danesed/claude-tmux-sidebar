# Testing AgentMux

Two layers: a hermetic Node suite that mocks `vscode`, `tmux` and the agent
CLIs, and a short manual smoke test against a real tmux server.

## Automated

```bash
npm run check
```

Runs `node --check` on `extension.js` and `media/main.js`, then `test/test.js`.
The suite starts no tmux and touches no real agent: every `execFile`/`spawn`
is intercepted (see the top of `test/test.js`), so it runs anywhere Node runs.
Screen fixtures for state detection live in `test/screens/*.txt`; add one
there whenever a detection rule is added or changed.

## Manual smoke test

Install the built `.vsix` (`Extensions: Install from VSIX…`), open a folder,
then:

1. **Start** — `＋` → *Start Claude* (or any installed agent). The tab appears
   within a second, the footer shows `WxH · up …`, the dot turns live.
2. **Type** — click the mirror, type a prompt, press Enter. Keys must land on
   the first try; the status dot goes `working` immediately, the tab pulses.
3. **Second agent** — start another one. Switching tabs paints the cached
   frame instantly; the accent colour of the active tab's underline and the
   cursor follows the active agent.
4. **Scrollback** — wheel up at the top of the live screen: history loads
   landing near the seam (the recent rows just above the pane, not the oldest
   lines of the capture), and the view stays where you scrolled — including
   while the agent is still streaming (no snap back to the bottom, no
   mid-gesture jumps). Wheeling *past* the bottom edge (or `Shift+PageDown`
   there) returns to live mode; merely arriving at the bottom does not.
5. **Agent roster** — `claudeTmux.enabledAgents` defaults hide Hermes and pi:
   their tabs, presence dots and `agentmux` statuses are absent. Add one to the
   list, reload the window: its tab appears. `agentmux prompt hermes …` while
   hermes is off must answer `unknown-agent`, not type into the active tab.
6. **Needs input** — trigger an approval dialog on a *background* agent: its
   tab turns amber, the VS Code badge counts it, hovering the tab previews the
   question, the notification offers the numbered answers.
7. **Adopt flag** — `tmux new-session -d -s pickme`, then
   `tmux set-option @agentmux_adopt "Pick me"`: within ~15 s a toast offers a
   reload, the flag is cleared (`tmux show -v -t pickme @agentmux_adopt` →
   empty) and after the reload a "Pick me" tab mirrors the session — in this
   window only. `@agentmux_adopt 1` labels the tab with the session name.
8. **Usage bars** — with a Codex session having emitted `token_count` entries,
   the footer shows `codex` followed by two thin bars with percentages (5h and
   weekly; tooltip names them and the resets). Claude's bar appears when its
   status line payload was captured (check it did not replace a status line
   you configured yourself in `~/.claude/settings.json`) or — a minute or two
   after `claude` refreshed its login — via the OAuth endpoint. `agy` gains
   bars within ~5 min from its own `agy -p /usage` report — the most-used
   model group takes the bars, other groups are lines in the tooltip. With the
   CodexBar CLI installed, providers nothing else reached (devin, opencode…)
   gain bars too — CodexBar is additive, never required.
9. **Background-task done** — ask Claude to run a Task subagent or a
   `run_in_background` shell, then let the turn end: the tab must stay
   `working` while the background task runs and flip to `done` when the last
   one finishes — not the instant the main turn stops.
10. **CLI** — in a terminal inside the workspace:
   `agentmux list`, `agentmux read claude --lines 20`,
   `agentmux prompt codex "say hi" --wait --until done`. The wait returns on
   `done`, or immediately with `blocked: true` if the agent stops to ask.
11. **Resilience** — `tmux kill-server`. One notification lists every stopped
   agent; the sidebar shows the launcher, nothing hangs, no tab flickers back.
12. **Remote** — repeat 1–3 over Remote-SSH: typing must stay responsive and
   the footer `lag` chip should stay under a few hundred ms.
