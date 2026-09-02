# Changelog

## 0.14.1

Comprehensive performance and snappiness improvements across the input pump,
webview terminal rendering, presence detection, and background telemetry:

- **Near-zero input latency with static hex lookup table:** Eliminated array spreads, map callbacks, and per-byte string allocations on the keystroke critical path (`sendInputData`) using a precomputed 256-entry hex lookup table.
- **Hardware-accelerated cursor movements:** Switched cursor placement from layout-invalidating `left`/`top` CSS styles to GPU compositor transforms (`translate3d`), eliminating browser reflows on every keystroke and cursor position update.
- **Fast-path ANSI decoding:** Lines without escape sequences bypass character-by-character loops, regex scans, and style object allocations, speeding up terminal row rendering by up to 70%.
- **Eliminated continuous string joins on delta frames:** Stored line arrays directly in the delta frame cache instead of executing `liveLines.join('\n')` on every keystroke/delta change, significantly reducing memory allocations and GC churn during active sessions.
- **DOM node recycling across tab switches:** Switching between agent tabs now reuses existing row elements in place instead of clearing and rebuilding 30–50 DOM nodes, making tab switching instant.
- **Bypassed layout thrashing in linkification:** Path detection checks in-memory raw strings (`raw.indexOf('.') >= 0`) before accessing `row.textContent` and spawning DOM `TreeWalker` passes.
- **CSS containment on terminal rows:** Added `contain: layout inline-size` to `#screen .row`, preventing line updates from triggering layout recalcs across the entire screen container.
- **Concurrent agent presence checks:** Replaced serial `for..of` presence queries with `Promise.all()`, probing all configured agents in parallel and cutting presence poll latency by ~80%.
- **Non-blocking async telemetry I/O:** Converted `TranscriptTail` scans and reads (`newestClaude`, `newestCodex`, `readAppended`) to asynchronous `fs.promises`, preventing synchronous disk I/O from freezing the Node.js Extension Host event loop.
- **Optimized status metadata updates:** Guarded DOM updates to the status footer so `textContent` and `title` are only modified when values actually change.
- **Refined visual design with zero-overhead styling:**
  - Added sub-pixel font smoothing (`-webkit-font-smoothing: antialiased`) and `optimizeLegibility` for razor-sharp terminal text on Retina/HiDPI displays.
  - Native editor selection styling (`#screen ::selection`) matching the active VS Code theme.
  - Slim, discreet custom scrollbars for all scrollable views and overlays.
  - Switched state pulse and shimmer animations to GPU compositor transforms (`scale`/`opacity`), eliminating expensive continuous `box-shadow` repaints.
  - Modern glassmorphism backdrop blur on modals, popup menus, and the prompt recall overlay (`backdrop-filter: blur()`).
  - Tactile micro-hover pill highlights on clickable file paths (`.path-link`).
  - Tabular monospace typography for status metadata, preventing layout jitter as token and time counters update.

## 0.14.0

One theme: knowing what an agent is actually doing. Screen detection used to
throw every pattern at the last 12 lines of the pane and take the first hit —
which is why typing *"do you want to delete the old migrations?"* into Claude's
prompt box turned the tab orange. The engine was rebuilt around the idea that
**where** a phrase appears is what decides its meaning, taking its shape from
[herdr](https://github.com/herdrdev/herdr), whose per-agent detection manifests
solve the same problem for 21 agents.

- **Every rule now names the region it is matched against**, because where a phrase sits is what decides its meaning. `body` is the tail with the prompt box cut out of it and is the default for needs-input rules — so what you type can no longer impersonate what the agent asks. `foot` is the last five lines, where a TUI pins its mode line. `head` is the first twenty, where first-run banners live. There are also `prompt`, `dialog` (below the last rule the TUI drew), `tail`, `screen` and `title`.
- **A rule can freeze the status instead of setting one.** Opening Claude's transcript with Ctrl+O, or the model picker, replaces the bottom of the frame with chrome that describes itself and not the agent: nothing matched, the frame stopped changing, and the decay timer quietly walked a working agent down to *done* and then *idle* while it was still working. Those screens are now `hold` rules — the status is frozen until the covering UI goes away.
- **Rules carry a priority and can guard themselves.** They are evaluated highest first, so a broad low-confidence rule can coexist with a narrow high-confidence one instead of racing it. An entry may be one pattern, several that must **all** match, or `{ region, priority, match, any, not }` — and `not` is what lets a broad rule stay broad: Claude's live turn line and its finished line begin with the same glyph.
- **The pane title is read as a state channel.** A TUI that animates its own title reports its status better than any screen scrape can infer it, it costs nothing (the title already rides along with every presence poll, whether that pane's frame is being captured or not), and it works for panes AgentMux never launched, where no hook could have been installed. Title rules outrank everything else and ship for Claude, Codex and Hermes.
  - Measured rather than copied, and the measurement changed the design: on the versions installed here **only Claude and pi write a title at all** — Codex, Hermes and OpenCode leave it at the hostname or at a constant — and Claude Code v2.1.252 writes `✳ <summary>` where that prefix **never changes**. Sampled every 200 ms across a full 12-second turn, and again across twenty minutes of continuous work, it stayed `✳` throughout; only the summary text was rewritten. So there is deliberately **no idle rule** for the title: reading `✳` as idle would drag a working agent to *done* on every poll. The working and blocked markers ship anyway, since they are unambiguous on versions that do emit them and simply never match on versions that do not.
- **Three new rules for Claude, all measured on a live v2.1.252 pane.** A backgrounded shell keeps running after the turn ends — the mode line reads `⏸ manual mode on · 1 shell · ← for agents` with no interrupt affordance anywhere, and used to decay straight to idle while the work was still going. The live turn line above the prompt box (`· Spinning… (8s · ↓ 494 tokens)`) reads as working, guarded against the finished line it resembles. And Codex's first-run *"Do you trust the contents of this directory?"*, which sits at the **top** of the frame where no tail rule could ever reach it, now reads as needs input.
- **Add "AgentMux: Explain a captured screen".** A rule that misfires is gone by the time anyone looks at it, so detection has to be answerable offline. Capture a pane to a file (`tmux capture-pane -p -t =<session>: > screen.txt`) and this prints the regions the frame was cut into and what **every** rule made of them — matched, missed by which pattern, vetoed by which guard, or matched but outranked — with no tmux involved. It works on a screen captured on another machine or pasted into a bug report. *Explain the active agent's state* gained the same breakdown. Five real Claude screens are committed under `test/screens/` and the test suite asserts against them.
- **Only Claude's rules were narrowed.** Moving a rule into a tighter region can only *lose* a state, so it is done where the screen was actually measured: Claude (measured live), Codex and Hermes (corroborated — herdr's own measured manifest reads Codex's working line out of the bottom 3, and Hermes' status and input lines are the last two before its closing rule). OpenCode's and Antigravity's working rules were **left as wide as they were**, because nothing here measured them and herdr matches both against the whole recent screen.
- `claudeTmux.detectionRules` covers all of it: regions, priorities, `any`/`not` guards, `hold` rules and title rules are all overridable per agent, and a provided list still REPLACES the built-in one, so `[]` disables a noisy rule.

### Free mode you can find

- **The ＋ at the end of the tab strip now opens onto free mode too.** Under the agents it can start or resume, behind a rule, it offers **Mirror a tmux session…** and — once you have one — **Remove a custom agent…**. Free mode shipped in 0.13.0 but lived only in the command palette, which meant knowing its name to use it.
- **The ＋ no longer disappears when every agent is running.** It used to hide itself once there was nothing left to start, which removed the only in-UI route to free mode at exactly the moment a full side bar makes you want another tab.
- The mirror list filters out sessions AgentMux already drives, so it can legitimately come back empty and say so. Both docs now name that dead end and how to get past it, because it reads like a broken feature rather than an empty list.

## 0.13.0

A sixth agent, a way to add a seventh without a release, and a sustained push on
the thing everything else rests on: knowing what an agent is actually doing.
Several of the state-tracking changes came from reading
[workmux](https://github.com/raine/workmux), which solves the same problem from
the other direction (many worktrees, one agent each).

### pi joins as the sixth agent

- Add **pi** (Earendil, `pi`) on the same footing as the others: its own tab, tmux session (`tmux_pi_<folder>`, `claudeTmux.piSessionPrefix`), launch arguments (`claudeTmux.piArgs`), presence and status tracking, input pump, handoffs in both directions, arbiter participation, Pair Mode, status bar item, timeline events and preflight check.
- **pi reports real lifecycle state.** AgentMux installs a pi extension (`~/.pi/agent/extensions/agentmux-state.ts`, honouring `PI_CODING_AGENT_DIR`) that maps `agent_start`, `agent_settled`, `tool_execution_start/end` and `ui_prompt_start/end` onto the same tmux pane options Claude's and Codex's hooks use, and records the session id from `session_start`. It uses `agent_settled` rather than `agent_end` because pi may still auto-retry, auto-compact or drain queued messages after a run ends — settled is the event its own docs point status integrations at. Inert by design: the factory returns immediately unless `AGENTMUX=1`, so a `pi` you start yourself is untouched.
- Resume reads pi's own per-directory JSONL transcripts (`<agent dir>/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`), so the overlay gets a real conversation list with `/name` titles, and the delete button removes the transcript. **Resume previous session** runs `pi --continue`; a pick resumes with `pi --session <id>`. Both are workspace-anchored by pi's own lookup order — `--continue` reads only this directory's session dir, and `--session` resolves an id against the current project before any global search, while every id offered comes from this project's dir. Transcripts whose recorded `cwd` is elsewhere are dropped outright: a resumed pi adopts the cwd in its own header, so offering one would move the agent out of the project.
- `claudeTmux.piArgs` defaults to **empty**, and deliberately so. Unlike the other five, pi has no permission flag to bypass: it ships no sandbox and no per-tool approval prompts, so the agent already acts freely with no argument at all. The one prompt pi does show is a first-run *project trust* question — whether to load the repository's own `.pi` settings, extensions and skills — which is a different decision from "let the agent work", and it is answered once per folder in the pane. Add `-a` to answer it automatically for every run.
- Verified in a live pane: `pane_current_command` really is `pi`, and it does not use the alternate screen, so the mirror keeps real tmux scrollback. Its screen rules cover what the extension hook cannot see — pi's own pickers are not extension UI, so `ui_prompt_start` never fires for them: the first-run "Trust project folder?" prompt and both picker footers read as needs-input. The working rule requires the `Working...` label next to the interrupt hint, because pi's startup banner prints `escape interrupt · …` and stays in the visible frame until the conversation scrolls it away.

### Free mode — add an agent without a release

- **`claudeTmux.customAgents`** declares extra agent tabs in settings. Two shapes: `{ id, label, command, args }` gives AgentMux a new agent it manages exactly like a built-in (own tmux session, presence, status, input, handoffs, arbiter, cleanup, optional `resume` command templates, `pane` adoption regex and `detection` rules); `{ id, label, session }` **mirrors a tmux session you started yourself**.
- A mirrored session is the one tab not tied to the workspace root — you named it explicitly, so showing it is the point — and in exchange nothing destructive can reach it: AgentMux never creates it, never restarts it, never resumes over it, never offers it in bulk kill, and never lists it as a leftover to clean up. Killing it is still possible from the single Kill command, which says plainly that AgentMux did not create it. It also does not join arbiter rounds: a round demands a marked answer from every participant and fails as a whole if one cannot give it, and what runs in a session you started yourself may not be an agent. Handoffs to it remain available — those pick a target explicitly.
- **Add "AgentMux: Mirror an existing tmux session (free mode)…"** — pick from the running tmux sessions, give the tab a label, and the entry is written to settings for you. **AgentMux: Remove a custom agent…** undoes it, leaving the tmux session running. Both edit whichever settings scope already defines the list, and offer a window reload, since the roster is built once at activation.

### Ground truth: what each agent is really doing

- **Codex reports its whole lifecycle, not just "done".** Codex 0.147+ ships a Claude-shaped hook system, and AgentMux now uses it: `UserPromptSubmit`, `PreToolUse` and `PostToolUse` report **working** with the running tool, `PermissionRequest` reports **needs input** — real approval detection instead of a guess at prompt wording — and `Stop` reports **done**. `SessionStart` records the conversation id without claiming the session finished. Until now Codex's only ground truth was the `notify` program, which can say nothing but `done`.
  - Verified against the CLI itself, not inferred: the hook set registers, `codex exec` prints `hook: <Event>` as each one runs, and a hook whose command is a quoted path **containing a space** executes correctly — so the macOS `Application Support` path is safe.
  - The hooks are passed per launch with `-c`, never written into your `config.toml`; the same containment as the notify program before them.
  - **Codex asks once to trust them** ("N hooks need review before they can run" — press `t`), recording a hash in `config.toml`. The commands AgentMux generates are stable, so that question comes up once per machine; changing the set in a future release costs one more `t`. That prompt is also a detection rule, so the tab says *needs input* instead of looking stuck. `notify` is kept alongside as the fallback that still reports `done` if you decline. Turn the hooks off with `claudeTmux.codexHooks`.
- **Fix: an OpenCode subagent finishing marked the whole pane done.** OpenCode runs subagents as child sessions that emit their own idle events, and the plugin reported the first one it saw — so the tab went green while the parent was still working. It now tracks every session and reports the **aggregate** (anything waiting wins, then anything working, otherwise done), ignores the stale trailing `busy` OpenCode emits after an `idle`, serializes its writes so two updates cannot land out of order, and understands `session.status`, `question.asked`/`question.replied` and `session.deleted`. The test drives the real plugin source through the event sequence rather than pattern-matching it.
- **A pane running an interpreter is no longer guessed at.** `node` was an alias for Claude, which made every Node process in the workspace read as a Claude agent — `npm run dev` in a tmux session rooted here would appear as an agent tab AgentMux types into. Interpreters (`node`, `python`, `bun`, `deno`, …) now count as **unidentified**, and only the pane title, which a TUI sets deliberately, may resolve one. The classification is sticky per pane, because Claude rewrites that title with the conversation summary as work goes on and re-deriving it every poll would make an adopted agent blink out of the side bar.
  - A bare version string as the pane command (some Claude builds report `2.1.118`) is recognised as Claude, and pi — which sets its title to `π - <folder>`, measured live — is recognised by that mark on setups where it reports as `node`.
  - Measured, not assumed: **Hermes runs as `python` and leaves the tmux title at the hostname**, so neither signal identifies it and a Hermes started outside AgentMux is still not adopted. Claiming `python` anyway would hand every Python process an agent tab.
  - **The pane title is now shown.** Claude puts the conversation summary there, so it appears in the tab tooltip and in *Explain the active agent's state*, for free — presence already read it.
- **Session identity is harder to spoof.** What a handoff pins now includes the pane's shell pid and the tmux **server** pid alongside the creation stamp and launch generation, so a recreated pane or a restarted tmux server can never pass for the pane that was validated. `session_created` has one-second resolution and an adopted agent carries no generation at all, so neither was sufficient alone. Handoffs pinned by an earlier version are still honoured on the pair they did record.
- Claude's first-run folder-trust dialog is a detection rule too. It defaults to **No, exit**, appears before any hook can report state, and left the tab looking merely stuck; it now reads as *needs input*.

### Fixes

- **Session naming on tmux 3.4.** The `<base>-<hash>` name exists only to avoid attaching to a session another project already owns, and the check for "is this name free?" relied on tmux failing for a missing target. tmux 3.4 instead answers a missing `=name:` target with exit 0 and an empty line, so *every* new session was named `<base>-<hash>` even when the plain name was free. Empty output now means "absent". Sessions an affected tmux already named that way are adopted rather than orphaned: when the plain name is free, AgentMux checks for a hashed session belonging to this workspace and keeps using it.
- **Shift+Enter is a newline again.** The mirror encoded every Enter as a plain carriage return, so Shift+Enter submitted the prompt instead of breaking the line — in all six agents. There is no universal encoding for a modified Enter, and sending the wrong one types visible garbage into the input box, so each agent's sequence was **measured in a live pane**, one candidate at a time: Claude, Codex and OpenCode read CSI-u (`\x1b[13;2u`); Hermes, pi and Antigravity read xterm modifyOtherKeys (`\x1b[27;2;13~`). An agent with no verified sequence keeps the carriage return it had, so nothing regresses. The bytes go in raw through `send-keys -H`, which is why this needs no `extended-keys` line in your `~/.tmux.conf` — the setting pi's own docs ask for is about tmux translating keys, and AgentMux never asks it to. A free-mode agent can declare its own with `modEnter`.
- **A failed launch names the real cause.** "Cannot start Pi in tmux session tmux_pi_x" left you to guess; the overwhelmingly common cause is that the CLI is simply not on PATH. AgentMux re-probes on failure and says so, with a button that copies the install command.

### Getting around, and driving it from elsewhere

- **Go to the agent that needs you.** With six or more tabs, "next agent" is rarely what you want. `claudeTmux.gotoAttention` (**Ctrl/Cmd+Shift+Alt+A**) jumps to the agent that is blocked on you, or failing that the most recent completion; `claudeTmux.lastAgent` toggles back to where you came from; `nextAgent`, `prevAgent` and `jumpAgent` walk the running agents. Clicking the status bar item now goes to the agent that wants you when there is one, and only falls back to cycling.
- **AgentMux is scriptable.** Four commands that take arguments and **return values**, so it can be driven from a keybinding, a task or another extension: `claudeTmux.send` (`{agent, text, submit}`), `claudeTmux.capture` (`{agent, lines}` → the pane text), `claudeTmux.status` (`{agent}` → present/status/tool/title per agent) and `claudeTmux.waitFor` (`{agent, status, timeoutMs}`), which makes *send → wait for done → capture* a three-line script. They are held to the same rules as the side bar — workspace check, Pair Mode lock, handoff freeze — and return the reason for a refusal instead of swallowing it. `waitFor` and `status` read the pane directly when the side bar is closed, since the presence loop only runs while the view exists.
- **Add "AgentMux: Agent integrations: show, install or remove…".** Every file AgentMux can write outside its own storage in one inspectable list — where it lives, whether it is installed *and current*, and what it is for — with install, reinstall, remove and reveal. Content is compared, so a file left behind by an older version reads as **out of date** instead of silently doing the wrong thing. The Codex hooks are listed too, marked as launch arguments rather than a file, because they are not one.

### Look

- **Six tabs no longer look the same.** Each agent gets a product colour and a two-glyph mark, taking the idea from workmux. The colour rides the 2 px underline the tab already had — 34% at rest, full strength when active — so it costs no horizontal space, which is the whole problem in a side bar where six labels ellipsize to "Cl…" and "Co…". Below 78 px the label gives way to the mark (`CC`, `CX`, `OC`, `HR`, `π`, `AG`), so the narrowest strip gains the most. The same colour leads every entry in the launch menu. Vendor colours where the product publishes one; the rest chosen to stay distinct. A free-mode agent gets a hue derived from its id — stable, and inside the built-in palette's range — and both are overridable with `accent` and `mark`.

### Hermes

- **Per-project profiles.** Each workspace runs Hermes in its own profile (`~/.hermes/profiles/<slug>`) — separate config, memory, skills, cron, plugins and session store — so two open projects never leak knowledge into each other. Routing is `HERMES_HOME` pointing at the profile directory (verified in `hermes_cli/config.py`: `HERMES_PROFILE` alone is only a kanban author label, so both are set). The profile is created on first launch by cloning the active one, the sticky default is never changed, and a failure degrades to running on the default profile rather than blocking the launch.

## 0.12.0
- Add **Hermes** (Nous Research, `hermes`) as a fifth agent on the same footing as the others: its own tab, tmux session (`tmux_hermes_<folder>`, `claudeTmux.hermesSessionPrefix`), launch arguments (`claudeTmux.hermesArgs`), presence and status tracking, input pump, handoffs in both directions, arbiter participation, Pair Mode, status bar item, timeline events and preflight check.
  - Resume uses the CLI's own store: **Resume previous session** runs `hermes --continue --in <workspace>` (workspace-scoped most-recent), and a known id or title resumes with `hermes --resume <id> --in <workspace>`. The `--in` pins the agent to the open project — Hermes would otherwise `cd` into the resumed session's recorded directory on resume (verified against `hermes_cli/main.py`: `--in` sets `no_restore_cwd`), so a session from another folder can never pull the agent out of the workspace. The overlay's conversation list is parsed from `hermes sessions list --workspace <dir>` — column boundaries come from the table's header, so titles with spaces are safe — and the delete button runs `hermes sessions delete <id> --yes`. `hermes sessions browse` remains available inside the pane.
  - `claudeTmux.hermesArgs` defaults to `--cli`, the classic REPL, so the mirror keeps real tmux scrollback — the same reasoning behind Codex's `--no-alt-screen` default. Switch it to `--tui` for the Ink interface, at the cost of scrollback (alternate-screen apps keep none).
  - `--yolo` ("bypass all dangerous command approval prompts") is included in the default arguments, matching the full-access defaults of the other agents; remove it to be prompted. The persistent policy remains `approvals.mode` (`manual` / `smart` / `off`) in `~/.hermes/config.yaml` — AgentMux never writes that file.
  - Screen detection rules come from a live pane: a running turn is recognised by the interrupt affordance its input line shows (`msg=interrupt` / `Ctrl+C cancel`), which is stabler than the status-bar glyphs (`⏱` vs `⏲` differ by one codepoint).
  - Known limitation: Hermes runs as `python`, so `pane_current_command` reads `python` and a Hermes started OUTSIDE AgentMux is not auto-adopted. Sessions AgentMux launches are unaffected — they are identified by their pane marker. Aliasing `python` was rejected deliberately: it would let any Python process be claimed as an agent.
- **OpenCode reports real lifecycle state.** AgentMux now installs an OpenCode plugin (`~/.config/opencode/plugins/agentmux-state.js`) that maps `session.idle`, `permission.asked`, `message.updated` and `tool.execute.before` onto the same tmux pane options Claude's and Codex's hooks already use — so OpenCode's tab shows ground truth instead of a guess, and `session.created` records the session id for exact resume. It is the only file AgentMux writes into another tool's config, so it is inert by design: every launch is marked `AGENTMUX=1` and the plugin does nothing without it, leaving an `opencode` you start yourself untouched. Remove it any time with **AgentMux: Remove agent integrations**.
- **Screen detection is per-agent and user-editable.** The single hardcoded regex that judged all agents is replaced by declarative per-agent rules, including ones observed from each TUI (Antigravity's trust prompt, `esc to interrupt` as a working signal). Override any of them with `claudeTmux.detectionRules` — a supplied list replaces the built-in one, so a noisy rule can be deleted, not just added to. Hook-reported state still wins whenever it exists.
- **Add "AgentMux: Explain the active agent's state".** Prints, to an output channel, which signal decided the current status — hook vs screen rule vs decay — the exact rule that matched, every rule loaded for that agent, the pane command, session identity and transport. Status was almost entirely un-inspectable before this.
- **Add "AgentMux: Clean up this project's leftover tmux sessions…".** Clears leftovers inside the folder you have open — sessions from a renamed prefix (including the pre-0.10.2 `tmux_`/`codex_` names) or from an agent replaced by a restart. It is scoped by a hard rule: a session qualifies only when its tmux `session_path` **is this workspace root**, so another project's sessions can never be listed, not even when their folder is gone; control clients are excluded outright. Nothing is pre-selected, sessions AgentMux did not create are never listed, and ownership is re-verified immediately before each kill, so a stale snapshot cannot reach outside the project either.
- **Delete past conversations from the resume list.** Each entry in the overlay gets a delete button, using whatever the agent supports: `opencode session delete <id>`, `hermes sessions delete <id> --yes`, or removing the Claude/Codex transcript. Always confirms first.
- **Add `claudeTmux.ansiPalette`.** Set it to `terminal` to render the mirror with the classic xterm palette — the colours the program actually asked for — instead of remapping them onto the VS Code theme (`theme`, still the default).
- **Resume is anchored to the open project for every agent** (verified against each CLI): Claude (`claude --resume`) and Codex (`codex resume`) stay in the current directory, so the tmux `-c <workspace>` start directory already keeps them in the project root; Hermes would `cd` into the session's recorded directory, so its resume commands pass `--in <workspace>`; OpenCode binds a resumed session to its stored `directory`, so the resume list now drops any session not rooted in the workspace (the `directory` field, belt-and-braces on top of the already cwd-scoped list). An agent may `cd` elsewhere to inspect files — the tmux session itself stays rooted in the workspace.
- **Lighter chrome.** The five per-agent status bar items are one consolidated item: the active agent's live state, every present agent in the tooltip, a warning tint when any agent waits for input, and click-to-cycle focus across the agents that are running (`claudeTmux.statusBarItems` still disables it). The sidebar title bar drops to three actions (Attach, Handoff, Kill); Restart, Kill pick and Clean up leftovers stay in the command palette and the webview's own launch menu.
- **The agent registry now carries install hints, launch-arg composition and conversation deletion** (`installCmd`, `launchArgs`, `deleteConversation` per agent in `extension.js`). Preflight no longer hardcodes per-agent install commands in the webview, `launchArgs` has no per-agent branch left, and deleting a past conversation is one registry line per agent (including `hermes sessions delete`).
- Fix `claudeTmux.detectionRules` documentation to include `hermes` as a key (the description still listed the four pre-Hermes agents).

## 0.11.1
- Add **OpenCode** (`opencode`) as a fourth agent, on the same footing as the others: its own tab, tmux session (`tmux_opencode_<folder>`, `claudeTmux.opencodeSessionPrefix`), launch arguments (`claudeTmux.opencodeArgs`, default `--auto`), presence and status tracking, input pump, handoffs in both directions, arbiter participation, Pair Mode, status bar item, timeline events and preflight check.
  - OpenCode publishes its own session index, so unlike Antigravity it gets a real resume list: the overlay is filled from `opencode session list --format json` (run in the workspace) and resumes a pick with `opencode --session <id>`, while **Resume previous session** runs `opencode --continue`. The JSON is parsed defensively across field names and degrades to "no list offered" rather than breaking the overlay.
- Fix a preflight false negative that affected any CLI installed by a `~/.bashrc` PATH export — OpenCode's installer among them. The check ran the login shell non-interactively (`-lc`), and `~/.bashrc` returns immediately for non-interactive shells, so the CLI was reported "not on PATH" even though the interactive shell tmux starts finds it and the agent launches fine. Missing agents are now re-probed with `-lic`; the fast non-interactive probe still runs first.
- `runFile` accepts an optional timeout, used to bound the new third-party CLI probes.

## 0.11.0
- Add **Google Antigravity** (`agy`) as a first-class third agent, working exactly like Claude and Codex: its own tab, tmux session (`tmux_agy_<folder>`, `claudeTmux.antigravitySessionPrefix`), launch arguments (`claudeTmux.antigravityArgs`, default `--dangerously-skip-permissions`), presence and status tracking, input pump, handoffs in both directions, arbiter participation, Pair Mode, status bar item, timeline events and preflight check.
  - Resume mirrors what the CLI actually offers: Antigravity keeps conversations in a local database instead of readable per-folder transcripts, so the overlay shows no conversation list and **Resume previous session** runs `agy --continue`; a known ID resumes with `agy --conversation <id>`.
  - Antigravity exposes no hook/notify mechanism, so its live state comes from the existing frame-diff heuristic rather than the tmux pane-option hooks Claude and Codex use.
- Generalize the whole extension from a hardwired pair to an agent registry: tabs, launch menu, launcher buttons, per-agent state, preflight and the webview roster are now generated from it, so the two-agent assumption is gone from both the host and the webview.
- Handoffs now let you pick the peer. With more than two agents the details step offers a **Hand off to** selector (running agents first); a findings round-trip keeps its pinned target and ignores re-point attempts.
- Arbiter rounds now include every *running* agent instead of requiring exactly two: at least two must be running, all of them must be back at their prompts, and agents that are not started simply sit the round out. The verdict lists one answer block per participant.
- Recognizing an agent started outside the extension is now registry-driven and no longer cross-claims: a pane already marked for one agent can never read as another.

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
