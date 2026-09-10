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
7. **CLI** — in a terminal inside the workspace:
   `agentmux list`, `agentmux read claude --lines 20`,
   `agentmux prompt codex "say hi" --wait --until done`. The wait returns on
   `done`, or immediately with `blocked: true` if the agent stops to ask.
8. **Resilience** — `tmux kill-server`. One notification lists every stopped
   agent; the sidebar shows the launcher, nothing hangs, no tab flickers back.
9. **Remote** — repeat 1–3 over Remote-SSH: typing must stay responsive and
   the footer `lag` chip should stay under a few hundred ms.
