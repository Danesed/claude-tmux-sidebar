const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// ---- tmux transport ----------------------------------------------------------
//
// Two transports share one contract ({ ok, out }):
//  - execFile: one fork/exec per command (always available, always the fallback).
//  - control mode: a single long-lived `tmux -C` client; each command is one
//    stdin line and one-or-more %begin/%end-framed replies. This removes the
//    steady-state fork/exec cost entirely. Probed on this platform: raw escape
//    bytes survive block output verbatim, and a ';'-fused line yields one
//    %begin block PER command, so replies are counted per fused part.
//
// Correctness rules: commands whose argv cannot be one control line (embedded
// newline/NUL, e.g. paste payloads) always use execFile; a wedged client hits a
// per-command timeout, everything in flight resolves ok:false, and NOTHING is
// ever replayed (failed input must be reported, not re-sent).

// Every tmux invocation is bounded: a tmux server shared with many sessions
// and several AgentMux windows can answer slowly, and an unanswered call must
// degrade to "try again" rather than wedge the input pump (queue.inFlight),
// the presence loop (_presenceRunning) or the tick loop forever — that wedge
// is what used to make typing silently stop working until a window reload.
// Timeouts resolve { ok:false, timedOut:true } so callers can tell "unknown"
// (keep state, keep the user's text) from a real tmux error (session gone).
let tmuxExecTimeoutMs = 15000;
let tmuxInputTimeoutMs = 10000;
// Session-identity probes are small and frequent: bound them tighter than full
// frame captures so a slow server degrades presence instead of stalling it.
const TMUX_PROBE_TIMEOUT_MS = 8000;
const TMUX_CAPTURE_TIMEOUT_MS = 20000;

// Test seam (see test/test.js): shorten the bounds so timeout paths run fast.
function setTmuxTimeouts(execMs, inputMs) {
  if (Number.isFinite(execMs) && execMs > 0) tmuxExecTimeoutMs = execMs;
  if (Number.isFinite(inputMs) && inputMs > 0) tmuxInputTimeoutMs = inputMs;
}

function tmuxExecFile(args, timeoutMs = tmuxExecTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(value);
    };
    let child = null;
    try {
      child = execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        done(err && err.killed
          ? { ok: false, out: stdout || '', timedOut: true }
          : { ok: !err, out: stdout || '' });
      });
    } catch { done({ ok: false, out: '' }); }
    // One mechanism only (no execFile `timeout` option alongside this): the
    // flag above is what makes timeouts deterministic, including under the
    // test mock, which ignores spawn options entirely.
    if (!settled && timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        done({ ok: false, out: '', timedOut: true });
      }, timeoutMs);
    }
  });
}

class TmuxControlClient {
  constructor() {
    this.proc = null;
    this.alive = false;
    this.buffer = '';
    this.pending = [];      // one slot per expected %begin block
    this.current = null;    // { entry, lines } for the open block
    this.failures = 0;
    this.failedAt = 0;
    this.notificationHandler = null;
    this.sessionName = `_agentmux_ctl_${process.pid}`;
    // Subscriptions only fire for panes in the client's ATTACHED session
    // (probed on tmux 3.6), so the client parks on its own throwaway session
    // and switch-client's onto the active agent's session to watch it.
    this.attachedSession = null;
    this.sawExit = false;
  }

  static controlSafe(args) {
    for (const a of args) {
      const s = String(a);
      if (s.includes('\n') || s.includes('\r') || s.includes('\0')) return false;
    }
    return true;
  }

  static quoteArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  usable() {
    return this.alive && this.proc && this.proc.exitCode === null;
  }

  ensure() {
    if (this.usable()) return true;
    if (this.proc) return false; // still starting or tearing down
    const now = Date.now();
    if (this.failures >= 3 && now - this.failedAt < 60000) return false; // circuit breaker
    let proc;
    try {
      proc = spawn('tmux', [
        '-C', 'new-session', '-A', '-D', '-s', this.sessionName, '-x', '2', '-y', '2',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      this.fail();
      return false;
    }
    this.proc = proc;
    this.alive = true;
    this.buffer = '';
    this.pending = [{ remaining: 1, ok: true, out: '', resolve: () => {}, timer: null }]; // implicit connect reply
    this.current = null;
    this.attachedSession = this.sessionName;
    this.sawExit = false;
    proc.on('error', () => this.destroy(true));
    proc.on('exit', () => this.destroy(!this.sawExit));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onData(chunk));
    // Never receive pane output floods; the parking session dies with us.
    // (set-option does not accept '='-exact session targets — plain name here.)
    this.exec(['refresh-client', '-f', 'no-output']);
    this.exec(['set-option', '-t', this.sessionName, 'destroy-unattached', 'on']);
    return true;
  }

  // Attach the client to `name` so subscriptions on its panes fire; with no
  // name, park back on the throwaway home session.
  async attachTo(name) {
    if (!this.usable()) return false;
    if (name) {
      if (this.attachedSession === name) return true;
      const switched = await this.exec(['switch-client', '-t', `=${name}`]);
      if (switched.ok) this.attachedSession = name;
      return switched.ok;
    }
    if (this.attachedSession === this.sessionName) return true;
    const parked = await this.exec(['new-session', '-A', '-D', '-s', this.sessionName, '-x', '2', '-y', '2']);
    if (parked.ok) {
      this.attachedSession = this.sessionName;
      this.exec(['set-option', '-t', this.sessionName, 'destroy-unattached', 'on']);
    }
    return parked.ok;
  }

  exec(args) {
    if (!this.usable()) return Promise.resolve({ ok: false, out: '', transportFailed: true });
    // One command per control line. A single line always yields exactly one
    // %begin/%end block, on every tmux version. ';'-fused lines do NOT: some
    // versions reply with one block per part, others with one block for the
    // whole line, which desynchronized this reply queue (stalled input for
    // 10s until the watchdog killed the client, and leaked the \x1f meta
    // line into rendered frames). Commands split from one argv are written in
    // a single stdin flush, so they still run back-to-back on the client.
    const commands = [[]];
    for (const a of args) {
      if (a === ';') commands.push([]);
      else commands[commands.length - 1].push(a);
    }
    const parts = commands.length;
    return new Promise((resolve) => {
      const entry = {
        remaining: parts, ok: true, out: '', resolve,
        timer: setTimeout(() => this.destroy(true, { timedOut: true }), 10000),
      };
      for (let i = 0; i < parts; i++) this.pending.push(entry);
      const lines = commands
        .map((cmd) => cmd.map((a) => TmuxControlClient.quoteArg(a)).join(' '))
        .join('\n');
      try {
        this.proc.stdin.write(lines + '\n');
      } catch {
        this.destroy(true);
      }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(line);
    }
  }

  onLine(line) {
    if (this.current) {
      if (/^%end \d+ \d+/.test(line) || /^%error \d+ \d+/.test(line)) {
        const { entry, lines } = this.current;
        this.current = null;
        entry.ok = entry.ok && line.startsWith('%end ');
        entry.out += lines.length ? lines.join('\n') + '\n' : '';
        entry.remaining--;
        if (entry.remaining === 0) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.resolve({ ok: entry.ok, out: entry.out });
        }
        return;
      }
      this.current.lines.push(line);
      return;
    }
    if (/^%begin \d+ \d+/.test(line)) {
      const entry = this.pending.shift();
      if (entry) this.current = { entry, lines: [] };
      else this.current = { entry: { remaining: 1, ok: true, out: '', resolve: () => {}, timer: null }, lines: [] };
      return;
    }
    if (line === '%exit') { this.sawExit = true; return; } // 'exit' event handles teardown
    if (line.startsWith('%session-changed ')) {
      this.attachedSession = line.split(' ').slice(2).join(' ');
    }
    if (this.notificationHandler) this.notificationHandler(line);
  }

  fail() {
    this.failures++;
    this.failedAt = Date.now();
  }

  destroy(failed = false, extra = null) {
    const proc = this.proc;
    this.proc = null;
    this.alive = false;
    const settled = new Set();
    const flush = (entry) => {
      if (!entry || settled.has(entry)) return;
      settled.add(entry);
      if (entry.timer) clearTimeout(entry.timer);
      // transportFailed distinguishes "the control client died" from a real
      // tmux error reply, so callers can retry over execFile instead of
      // treating a wedged transport as a missing session or failed input.
      entry.resolve({ ok: false, out: '', transportFailed: true, ...(extra || {}) });
    };
    if (this.current) flush(this.current.entry);
    for (const entry of this.pending) flush(entry);
    this.pending = [];
    this.current = null;
    if (failed) this.fail();
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }
}

const controlClient = new TmuxControlClient();

function transportMode() {
  const mode = cfg().get('transport') || 'auto';
  return ['auto', 'control', 'pipe', 'poll'].includes(mode) ? mode : 'auto';
}

// Run tmux with an argv array (no shell -> no quoting/injection issues).
// Resolves { ok, out } where ok=false means tmux exited non-zero (e.g. no session).
// Commands safe to re-run if the control client died with them in flight (the
// command may or may not have executed). Input commands (send-keys,
// paste-buffer) are deliberately absent: replaying them could double-type.
const TRANSPORT_RETRY_SAFE = new Set([
  'capture-pane', 'display-message', 'has-session', 'show-option',
  'set-option', 'set-window-option', 'resize-window', 'refresh-client', 'list-sessions',
]);

function tmux(args, timeoutMs) {
  if (['auto', 'control'].includes(transportMode())
    && TmuxControlClient.controlSafe(args) && controlClient.ensure()) {
    // A control-client death (watchdog kill, tmux exit) fails the command at
    // the transport layer, not in tmux; retry idempotent commands once over
    // execFile so a wedged client never masquerades as "no session".
    // Input commands (send-keys, set-buffer, paste-buffer) are deliberately
    // NOT retried: a command that died in flight may or may not have executed,
    // and replaying it would double-type into the agent's prompt. Callers
    // receive transportFailed/timedOut and preserve the text instead.
    return controlClient.exec(args).then((result) => (
      result.transportFailed && TRANSPORT_RETRY_SAFE.has(args[0]) ? tmuxExecFile(args, timeoutMs) : result
    ));
  }
  return tmuxExecFile(args, timeoutMs);
}

// Input takes a dedicated execFile instead of queuing behind heavy captures on
// the shared control-mode FIFO: with several windows capturing against one
// tmux server, head-of-line stalls make keystrokes time out and read as "not
// delivered". One fork per input burst is negligible next to that.
function tmuxInput(args) {
  if (transportMode() === 'control') return tmux(args);
  return tmuxExecFile(args, tmuxInputTimeoutMs);
}

// Event-tap fallback when control-mode subscriptions are unavailable:
// `pipe-pane -O` tees the active pane's output into a FIFO the extension holds
// open, so any byte means "output happened" and the poll loop can idle slowly
// while repaints stay instant. Only panes we marked ourselves are (re)claimed.
class PipeTap {
  constructor() {
    this.agent = null;
    this.session = null;
    this.fifoPath = null;
    this.fd = null;
    this.stream = null;
    this.onEvent = null;
    this._debounce = null;
    this._failedAt = 0;
  }

  live() { return !!this.stream; }

  async arm(agent, sessionName) {
    if (this.agent === agent && this.session === sessionName && this.stream) return true;
    if (Date.now() - this._failedAt < 30000) return false;
    await this.disarm();
    const fifo = path.join(os.tmpdir(), `agentmux-${process.pid}-${agent}.fifo`);
    const abort = () => {
      this._failedAt = Date.now();
      try { fs.unlinkSync(fifo); } catch { /* not created */ }
      return false;
    };
    try { fs.unlinkSync(fifo); } catch { /* not there */ }
    const made = await runFile('mkfifo', [fifo]);
    if (!made.ok) return abort();
    // Respect a user's own pipe-pane: only (re)claim panes we marked ourselves.
    const piped = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(sessionName), '#{pane_pipe}\t#{@agentmux_pipe}']);
    if (!piped.ok) return abort();
    const [pipeFlag, ours] = piped.out.trim().split('\t');
    if (pipeFlag === '1' && ours !== '1') return abort();
    try {
      this.fd = fs.openSync(fifo, 'r+'); // r+ so open never blocks waiting for a writer
    } catch {
      return abort();
    }
    const armed = await tmux(['pipe-pane', '-O', '-t', tmuxPaneTarget(sessionName), `cat > ${shellQuote(fifo)}`]);
    if (!armed.ok) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
      return abort();
    }
    tmux(['set-option', '-p', '-t', tmuxPaneTarget(sessionName), '@agentmux_pipe', '1']);
    this.agent = agent;
    this.session = sessionName;
    this.fifoPath = fifo;
    this.stream = fs.createReadStream(null, { fd: this.fd, autoClose: false });
    this.stream.on('data', () => {
      if (this._debounce) return;
      this._debounce = setTimeout(() => {
        this._debounce = null;
        if (this.onEvent && this.agent) this.onEvent(this.agent);
      }, 16);
    });
    this.stream.on('error', () => { this.disarm(); });
    return true;
  }

  async disarm() {
    const session = this.session;
    const fifo = this.fifoPath;
    const fd = this.fd;
    const stream = this.stream;
    this.agent = null;
    this.session = null;
    this.fifoPath = null;
    this.fd = null;
    this.stream = null;
    if (this._debounce) { clearTimeout(this._debounce); this._debounce = null; }
    if (stream) { try { stream.destroy(); } catch { /* already gone */ } }
    if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    if (session) {
      await tmux(['pipe-pane', '-t', tmuxPaneTarget(session)]); // no command = off
      tmux(['set-option', '-p', '-t', tmuxPaneTarget(session), '@agentmux_pipe', '0']);
    }
    if (fifo) { try { fs.unlinkSync(fifo); } catch { /* already gone */ } }
  }
}

// timeout is optional (0/undefined = none) so a probe of a third-party CLI can
// never wedge a one-shot path; existing callers keep their old behaviour.
function runFile(command, args, cwd, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: stderr || '' });
    });
  });
}

function cfg() {
  return vscode.workspace.getConfiguration('claudeTmux');
}

function workspaceFolder() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

// The agent registry drives everything generic: tabs, presence, handoff peers,
// arbiter participants, preflight and resume. Adding an agent here (plus its
// two settings in package.json) is all a new CLI needs.
//   paneRe/paneAliases — recognize an agent already running in a pane we did
//     not launch (matched against basename(pane_current_command)).
//   listSessions       — enumerate past conversations for the resume overlay,
//     or null when the CLI keeps no readable local transcripts.
//   resumeById         — command to resume one listed conversation.
//   resumeLatest       — command behind "Resume previous session"; for CLIs
//     with their own picker (or a --continue flag) this is what runs.
//   installCmd         — hint shown by the preflight banner when the CLI is
//     missing from PATH ("copy install cmd" button).
//   launchArgs         — argument composer when the agent needs more than the
//     plain argsSetting (hook/plugin wiring); omitted = plain argsSetting.
//   deleteConversation — how the resume list's delete button removes a past
//     conversation; omitted = no delete button offered.
//   modEnter           — the bytes this agent reads as "newline, do not submit"
//     when you press Shift+Enter. There is NO universal encoding: measured in
//     live panes, Codex speaks CSI-u (\x1b[13;2u) while Hermes, pi and
//     Antigravity speak xterm modifyOtherKeys (\x1b[27;2;13~). Sending the wrong
//     one types visible garbage into the input box, so an agent with no verified
//     sequence keeps the plain carriage return it has always had.
//   accent/mark        — the tab's identity: a product colour and a two-glyph
//     mark. Six tabs in a narrow side bar ellipsize to "Cl…"/"Co…", which is no
//     identity at all; the colour carries it in the space an underline already
//     occupies, and the mark replaces the label once the tab is too narrow for
//     one. Vendor colours where the product publishes one, otherwise a hue
//     picked to stay distinct from the other five.
const AGENTS = {
  claude: {
    label: 'Claude',
    accent: '#d97757',
    mark: 'CC',
    modEnter: '\x1b[13;2u',
    command: 'claude',
    prefixSetting: 'sessionPrefix',
    defaultPrefix: 'tmux_claude_',
    argsSetting: 'claudeArgs',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
    paneRe: /claude/i,
    // 'node' was an alias here until 0.13.0. It made every Node process in the
    // workspace read as Claude, so it is gone: an interpreter is resolved by
    // the pane title instead (Claude Code puts the conversation summary there).
    paneAliases: [],
    paneVersionCommand: true, // some builds report their own version as the command
    paneTitleRe: /claude/i,
    listSessions: (cwd) => listSessions(getProjectDir(cwd)),
    resumeById: (id, args) => `claude --resume ${shellQuote(id)}${args ? ' ' + args : ''}`,
    resumeLatest: null, // the extension's own picker covers Claude
    launchArgs: claudeLaunchArgs,
    deleteConversation: async (id, cwd) => {
      try { fs.unlinkSync(path.join(getProjectDir(cwd), `${id}.jsonl`)); return true; } catch { return false; }
    },
  },
  codex: {
    label: 'Codex',
    accent: '#10a37f',
    mark: 'CX',
    modEnter: '\x1b[13;2u',
    command: 'codex',
    prefixSetting: 'codexSessionPrefix',
    defaultPrefix: 'tmux_codex_',
    argsSetting: 'codexArgs',
    installCmd: 'npm install -g @openai/codex',
    paneRe: /(?:^|-)codex(?:$|-)/i,
    paneAliases: [],
    listSessions: (cwd) => listCodexSessions(cwd),
    resumeById: (id, args) => `codex resume ${shellQuote(id)}${args ? ' ' + args : ''}`,
    resumeLatest: (args) => `codex resume${args ? ' ' + args : ''}`,
    launchArgs: codexLaunchArgs,
    deleteConversation: async (id, cwd) => {
      const match = (await listCodexSessions(cwd)).find((s) => s.id === id);
      try { if (match?.file) { fs.unlinkSync(match.file); return true; } } catch { /* unreadable */ }
      return false;
    },
  },
  // opencode. Unlike the others it exposes its own session index as JSON, so the
  // resume overlay is populated by asking the CLI instead of reading transcripts.
  opencode: {
    label: 'OpenCode',
    accent: '#4d8bf0',
    mark: 'OC',
    modEnter: '\x1b[13;2u',
    command: 'opencode',
    prefixSetting: 'opencodeSessionPrefix',
    defaultPrefix: 'tmux_opencode_',
    argsSetting: 'opencodeArgs',
    installCmd: 'curl -fsSL https://opencode.ai/install | bash',
    paneRe: /(?:^|-)opencode(?:$|-)/i,
    paneAliases: [],
    paneTitleRe: /opencode/i,
    listSessions: (cwd) => listOpencodeSessions(cwd),
    resumeById: (id, args) => `opencode --session ${shellQuote(id)}${args ? ' ' + args : ''}`,
    resumeLatest: (args) => `opencode --continue${args ? ' ' + args : ''}`,
    launchArgs: opencodeLaunchArgs,
    deleteConversation: async (id, cwd) => (await runFile('opencode', ['session', 'delete', id], cwd, 15000)).ok,
  },
  // Nous Research Hermes. Sessions live in its own SQLite store, so the resume
  // list comes from the CLI's `sessions list --workspace <dir>` table (parsed
  // from its header, see listHermesSessions) and resume goes through
  // --continue/--resume. `hermes sessions browse` remains the interactive
  // picker inside the pane. Approval policy is NOT a launch flag here — it is
  // approvals.mode in ~/.hermes/config.yaml — so nothing about permissions is
  // implied by args.
  hermes: {
    label: 'Hermes',
    accent: '#d6689a',
    mark: 'HR',
    modEnter: '\x1b[27;2;13~',
    command: 'hermes',
    prefixSetting: 'hermesSessionPrefix',
    defaultPrefix: 'tmux_hermes_',
    argsSetting: 'hermesArgs',
    installCmd: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    // Hermes runs as `python` and, measured in a live pane, leaves the tmux
    // title at its default (the hostname) — so neither the command nor the
    // title identifies it, and a Hermes started OUTSIDE AgentMux is still not
    // adopted. Sessions AgentMux launches are unaffected: they carry a marker.
    paneRe: /(?:^|-)hermes(?:$|-)/i,
    paneAliases: [],
    listSessions: (cwd) => listHermesSessions(cwd),
    // --in <cwd> pins the resume to the open project: Hermes would otherwise
    // cd into the session's recorded directory on resume (verified in
    // hermes_cli/main.py: --in sets no_restore_cwd), so a session from another
    // folder could pull the agent out of the workspace AgentMux manages.
    resumeById: (id, args, cwd) => `hermes --resume ${shellQuote(id)}${cwd ? ` --in ${shellQuote(cwd)}` : ''}${args ? ' ' + args : ''}`,
    resumeLatest: (args, cwd) => `hermes --continue${cwd ? ` --in ${shellQuote(cwd)}` : ''}${args ? ' ' + args : ''}`,
    deleteConversation: async (id, cwd) => (await runFile('hermes', ['sessions', 'delete', id, '--yes'], cwd, 15000)).ok,
  },
  // pi (Earendil). Readable per-directory JSONL transcripts, so it gets a real
  // resume list read from disk. Both resume paths are workspace-anchored by
  // pi's own lookup order: --continue takes the most recent transcript in THIS
  // directory's session dir, and --session resolves an id against the current
  // project before falling back to a global search — and every id we offer
  // comes from this project's dir, so the local match always wins.
  pi: {
    label: 'Pi',
    accent: '#96bbb5',
    mark: 'π',
    modEnter: '\x1b[27;2;13~',
    command: 'pi',
    prefixSetting: 'piSessionPrefix',
    defaultPrefix: 'tmux_pi_',
    argsSetting: 'piArgs',
    installCmd: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    // Verified in a live pane: pane_current_command really is "pi" (it is a
    // bundled JS CLI but sets its own process title), so an externally started
    // pi is adopted without aliasing a runtime name like "node".
    paneRe: /(?:^|-)pi(?:$|-)/i,
    paneAliases: [],
    // Measured in a live pane: pi sets its tmux title to "π - <folder>", so on
    // setups where it reports as `node` the product mark still identifies it.
    paneTitleRe: /π/,
    listSessions: (cwd) => listPiSessions(cwd),
    resumeById: (id, args) => `pi --session ${shellQuote(id)}${args ? ' ' + args : ''}`,
    resumeLatest: (args) => `pi --continue${args ? ' ' + args : ''}`,
    launchArgs: piLaunchArgs,
    deleteConversation: async (id, cwd) => {
      const match = (await listPiSessions(cwd)).find((s) => s.id === id);
      try { if (match?.file) { fs.unlinkSync(match.file); return true; } } catch { /* unreadable */ }
      return false;
    },
  },
  // Google Antigravity. Its conversations live in a local database rather than
  // readable per-folder transcripts, so the resume overlay offers the CLI's own
  // --continue instead of an extension-side list; --conversation still resumes
  // a specific ID when one is known.
  antigravity: {
    label: 'Antigravity',
    accent: '#8957e5',
    mark: 'AG',
    modEnter: '\x1b[27;2;13~',
    command: 'agy',
    prefixSetting: 'antigravitySessionPrefix',
    defaultPrefix: 'tmux_agy_',
    argsSetting: 'antigravityArgs',
    installCmd: 'Install Google Antigravity and ensure its "agy" CLI is on PATH',
    paneRe: /(?:^|-)(?:agy|antigravity)(?:$|-)/i,
    paneAliases: [],
    listSessions: null,
    resumeById: (id, args) => `agy --conversation ${shellQuote(id)}${args ? ' ' + args : ''}`,
    resumeLatest: (args) => `agy --continue${args ? ' ' + args : ''}`,
    launchArgs: antigravityLaunchArgs,
  },
};

const AGENT_IDS = Object.keys(AGENTS);

// ---- screen detection rules --------------------------------------------------
// Hook-reported state is always authoritative; these patterns are the fallback
// for agents without hooks (and when stateHooks is off). Keeping them
// declarative and per-agent means a wrong verdict is a settings edit
// (claudeTmux.detectionRules) rather than a release, and each agent's TUI can
// be described separately instead of through one regex shared by all of them.
//
// Every rule names the REGION it is matched against instead of being thrown at
// one flat blob, because where a phrase sits decides what it means: "do you
// want to" typed into the prompt box is the user asking a question, the same
// words in the agent's dialog are the agent asking one. The regions:
//   title    the pane title, i.e. whatever the TUI wrote with OSC 0/2
//   tail     the last 12 non-blank lines of the frame, ANSI stripped
//   body     `tail` with the prompt box cut out of it — the default for
//            needs-input rules, and the one that stops the user's own typing
//            from impersonating an agent's question
//   foot     the last 5 non-blank lines: the mode/status line a TUI keeps
//            pinned to the bottom, where interrupt affordances live
//   head     the first 20 non-blank lines: first-run banners and trust prompts
//   prompt   the prompt box body itself, between the last two rule lines
//   dialog   everything below the last rule line the TUI drew
//   screen   the whole captured frame
//
// A rule is a pattern, an array of patterns that must all match, or an object
// { region, priority, match, any, not } for anything more specific:
//   match     pattern or patterns, ALL of which must match
//   any       patterns, at least ONE of which must match
//   not       patterns, NONE of which may match — the guard that lets a broad
//             rule stay broad without swallowing the screens it should not
// Defaults by list: needs-input -> region body, priority 900; working -> tail,
// 500; hold -> tail, 1000; anything under `title` -> title, 1100.
//
// Rules are evaluated highest priority first, declaration order breaking ties,
// and the first match wins. Priority is what lets a broad low-confidence rule
// coexist with a narrow high-confidence one instead of racing it: an agent
// stating "working" in its own title (1100) outranks a viewer covering the
// pane (1000), which outranks a dialog shape (900), which outranks the mode
// line looking busy (500).
//
// A rule casts one of three verdicts: 'needs-input', 'working', or 'hold'. A
// hold rule matches a screen that says nothing about the agent at all — a
// transcript viewer, a settings picker — and freezes the status instead of
// changing it. Without it, opening the transcript mid-turn changes the frame,
// matches nothing, and the decay timer quietly walks a working agent down to
// done and then idle while it is still working.
//
// A rule's pattern may also be an ARRAY of patterns, all of which must match
// the region. That is what makes a hold rule safe to write: "showing detailed
// transcript" alone is a phrase an agent could print in its own output, but it
// plus the viewer's own footer is the viewer.
// A line that is nothing but the horizontal rule a TUI draws around its prompt
// box and its dialogs. Claude and pi draw "──…", Codex's picker "▔▔…".
const RULE_LINE_CHARS = /^[\u2500\u2501\u2504\u2505\u2508\u2509\u250c-\u254b\u2550\u2554-\u256c\u2580\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588\u2594\u2594_=-]+$/;
function isRuleLine(line) {
  const packed = String(line).replace(/\s+/g, '');
  return packed.length >= 8 && RULE_LINE_CHARS.test(packed);
}

// Every region a rule may name, in the order Explain prints them.
const DETECTION_REGIONS = ['title', 'foot', 'prompt', 'dialog', 'body', 'tail', 'head', 'screen'];

// Slice one captured frame into the regions rules are matched against. Built
// once per evaluated frame, eagerly: a frame is a few dozen lines, and a lazy
// getter would only trade that for a memo table.
function detectionContext(frame, title) {
  const text = stripAnsi(String(frame || ''));
  const lines = text ? text.split('\n') : [];
  const kept = lines.filter((line) => line.trim());
  const tail = kept.slice(-12);
  // Where the TUI drew its rule lines, within the kept lines, so the prompt box
  // can be located relative to the same list the tail is cut from.
  const bars = [];
  for (let i = 0; i < kept.length; i++) if (isRuleLine(kept[i])) bars.push(i);
  const lastBar = bars.length ? bars[bars.length - 1] : -1;
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : -1;
  // The prompt box body: what sits between the last two rules. Cutting exactly
  // this out of the tail is what makes `body` safe — a phrase the user typed is
  // gone from it, while a dialog (which replaces the box rather than sitting
  // inside it) is untouched.
  const promptFrom = prevBar >= 0 ? prevBar + 1 : -1;
  const promptTo = prevBar >= 0 ? lastBar : -1;
  const inPrompt = (i) => promptFrom >= 0 && i >= promptFrom && i < promptTo;
  const body = [];
  for (let i = Math.max(0, kept.length - 12); i < kept.length; i++) {
    if (!inPrompt(i)) body.push(kept[i]);
  }
  return {
    title: title || '',
    screen: text,
    tail: tail.join('\n'),
    body: body.join('\n'),
    foot: kept.slice(-5).join('\n'),
    head: kept.slice(0, 20).join('\n'),
    prompt: promptFrom >= 0 ? kept.slice(promptFrom, promptTo).join('\n') : '',
    dialog: lastBar >= 0 ? kept.slice(lastBar + 1).join('\n') : '',
  };
}

const DETECTION_BASELINE = {
  needsInput: [
    'do you want to',
    'would you like to',
    'permission required',
    'approval required',
    'press enter to continue',
    '\\[[yY]/[nN]\\]',
    'allow\\s+.+\\?',
  ],
  working: [],
};

const AGENT_DETECTION = {
  // `hold` entries are evaluated before the state rules for that region.
  // Claude's first-run folder-trust dialog defaults to "No, exit", so a pane
  // sitting on it is genuinely blocked — and it appears before any hook can
  // report state. Observed wording, taken from a live pane.
  claude: {
    // Ctrl+O opens the transcript over the live UI, /model the model picker.
    // Both replace the bottom of the frame with chrome that describes itself
    // and not the agent, so they freeze the status rather than resetting it.
    // Both footers measured live on Claude Code v2.1.252:
    //   Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open
    //   in code · ? for shortcuts
    //   Enter to set as default · s to use this session only · Esc to cancel
    hold: [
      ['showing detailed transcript', 'ctrl\\+o to toggle|\\u2191\\u2193 scroll|\\? for shortcuts'],
      ['select model', 'enter to set as default', 'esc to cancel'],
    ],
    needsInput: ['quick safety check', 'yes, i trust this folder'],
    // All measured on v2.1.252.
    working: [
      // The interrupt affordance lives in the mode line pinned to the bottom
      // ("⏸ manual mode on · 1 shell · esc to interrupt · ← for agents"), so it
      // is matched there and not anywhere in the tail, where the same words can
      // sit in scrolled-back output.
      { region: 'foot', match: 'esc to interrupt' },
      // A backgrounded shell keeps running after the turn ends: the mode line
      // reads "⏸ manual mode on · 1 shell · ← for agents · ↓ to manage" with no
      // interrupt affordance at all, and used to decay straight to idle while
      // the work was still going.
      { region: 'foot', match: '(?:^|\\n)\\s*[\u23f8\u23f5].*\u00b7\\s+[1-9]\\d*\\s+shells?\\s+\u00b7' },
      // The live turn line above the prompt box: "· Spinning… (8s · ↓ 494
      // tokens)". The ellipsis and the elapsed-time parenthesis are what
      // separate it from the finished line, "✻ Cooked for 3s · done 1:48 PM".
      {
        region: 'body',
        match: '(?:^|\\n)\\s*[\\u002a\\u00b7\\u2722\\u2736\\u273b\\u273d]\\s+\\S[^\\n]*\u2026(?:\\s+\\(\\d+[smh]|\\s*$)',
        not: ['\u00b7 done \\d'],
      },
    ],
  },
  // "N hooks need review before they can run" is Codex's one-time trust prompt
  // for the hook set AgentMux passes at launch: it genuinely is waiting for a
  // keypress, and until it gets one the hooks stay inactive.
  codex: {
    // Codex's transcript viewer footer, which owns the whole bottom of the
    // frame while it is open.
    hold: [{ region: 'foot', match: ['\\u2191/\\u2193 to scroll', 'q to quit'] }],
    needsInput: [
      'allow command', 'hooks? needs? review', 'press t to trust',
      // Measured live: Codex opens on "> You are in <dir>" followed by "Do you
      // trust the contents of this directory?" at the TOP of the frame, which
      // no tail rule could ever have reached.
      { region: 'head', match: ['you are in ', 'do you trust the contents of this directory'] },
    ],
    // herdr's manifest, measured against Codex, reads its working fallback
    // out of the bottom 3 lines; `foot` is the bottom 5 and covers it.
    working: [{ region: 'foot', match: 'esc to interrupt' }],
  },
  // Deliberately left on the default `tail`. Claude's interrupt affordance
  // was measured in its pinned mode line, which is why THAT rule was
  // tightened to `foot`; OpenCode's was not measured here, and herdr — which
  // did measure it — searches OpenCode's whole recent screen rather than a
  // footer. Narrowing a region on an assumption loses a working state
  // outright, so an unmeasured rule stays as wide as it already was.
  opencode: {
    needsInput: ['approve\\b', 'permission'],
    working: ['esc to interrupt'],
  },
  // Observed on first run: the workspace trust prompt and its menu footer.
  // Same reasoning as OpenCode: unmeasured here, and herdr matches
  // Antigravity's spinner against the whole recent screen.
  antigravity: {
    needsInput: ['do you trust', '\u2191/\u2193 navigate'],
    working: ['esc to interrupt'],
  },
  // Observed in a live --cli pane: while a turn runs, the input line becomes
  // "⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel"; back at the
  // prompt it is a bare "❯". Matching the interrupt affordance is stable and
  // does not depend on the status-bar glyphs (⏱ vs ⏲), which differ by a
  // single codepoint.
  hermes: {
    needsInput: [],
    // Measured idle: the status line and the input line are the last two
    // before the closing rule, so a running turn's affordance is in `foot`.
    working: [{ region: 'foot', match: 'msg=interrupt' }, { region: 'foot', match: 'ctrl\\+c cancel' }],
  },
  // Observed in a live pane: a running turn shows "Working... (escape to
  // interrupt)", and every blocking picker — including the first-run "Trust
  // project folder?" prompt — shows the select footer. The word "interrupt"
  // alone is NOT usable: pi's startup banner prints "escape interrupt · …" and
  // sits in the visible frame until the conversation scrolls it away, so the
  // working rule requires the "Working..." label next to it.
  // pi's own pickers are NOT extension UI, so the ui_prompt_start hook does not
  // see them — these rules are what covers them. Two footers observed live: the
  // first-run trust prompt ("↑↓ navigate  enter select  escape/ctrl+c cancel")
  // and the built-in pickers ("Enter to select · Ctrl+S … · Esc to cancel");
  // both disappear the moment the picker closes.
  pi: {
    needsInput: ['trust project folder', 'enter (?:to )?select'],
    working: ['working\\.\\.\\..{0,24}interrupt'],
  },
};

// The pane title as a state channel. A TUI that animates its own title states
// its status more reliably than any screen scrape, costs nothing to read (the
// title already rides along with every presence poll, hidden view or not) and
// keeps working for panes AgentMux never launched, where no hook could have
// been installed.
//
// MEASURED here on 2026-09-01, against the versions actually installed: only
// Claude and pi write a title at all — codex, hermes and opencode leave it at
// the hostname or at a constant ("OpenCode"). Claude Code v2.1.252 writes
// "✳ <summary>" and that prefix NEVER changes: sampled every 200ms across a
// full 12-second turn it stayed "✳" from submit to finish, and only the
// summary text was rewritten. So there is deliberately NO idle rule below — on
// this version "✳" means nothing about the state, and reading it as idle would
// drag a working agent to `done` on every poll. Working and blocked markers are
// unambiguous on versions that do emit them, so they ship and simply never
// match on a version that does not.
const TITLE_DETECTION = {
  claude: {
    // Braille frames are the spinner up to 2.1.227; the half circles are the
    // 2.1.228 one. Both sit at the head of the title, before the summary.
    working: ['^[\u2800-\u28ff\u25d0-\u25d3] '],
  },
  codex: {
    working: ['(?:^| )[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f](?: |$)'],
    needsInput: ['action required'],
  },
  hermes: {
    working: ['^\u23f3'],
    needsInput: ['^\u26a0'],
  },
};

const detectionCache = new Map();

// What a rule is worth when it does not say. See the header note for why these
// numbers are ordered the way they are.
const DETECTION_PRIORITY = { title: 1100, hold: 1000, 'needs-input': 900, working: 500 };

// Compile one list of entries into rules and append them. An entry is one
// pattern, an array of patterns that must ALL match (which is how a rule gets
// specific enough to be safe without one unreadable regex), or an object with
// region / priority / match / any / not. A bad user regex drops that one rule
// rather than taking the whole agent down.
function pushRules(entries, defaultRegion, state, out) {
  const defaultPriority = defaultRegion === 'title'
    ? DETECTION_PRIORITY.title
    : DETECTION_PRIORITY[state];
  for (const entry of entries || []) {
    const scoped = entry && !Array.isArray(entry) && typeof entry === 'object';
    const region = scoped && typeof entry.region === 'string' ? entry.region : defaultRegion;
    const priority = scoped && Number.isFinite(entry.priority) ? entry.priority : defaultPriority;
    const asList = (value) => {
      if (value === undefined || value === null) return [];
      return Array.isArray(value) ? value : [value];
    };
    const all = asList(scoped ? entry.match : entry);
    const any = asList(scoped ? entry.any : null);
    const not = asList(scoped ? entry.not : null);
    if (!all.length && !any.length) continue; // a rule of pure guards matches nothing
    const bad = [...all, ...any, ...not].some((p) => typeof p !== 'string' || !p);
    if (bad) continue;
    try {
      out.push({
        region,
        state,
        priority,
        all: all.map((p) => new RegExp(p, 'i')),
        any: any.map((p) => new RegExp(p, 'i')),
        not: not.map((p) => new RegExp(p, 'i')),
        source: [
          all.join(' + '),
          any.length ? `any(${any.join(' | ')})` : '',
          not.length ? `not(${not.join(' | ')})` : '',
        ].filter(Boolean).join(' '),
      });
    } catch { /* skip a bad user regex */ }
  }
}

// The compiled rule list for one agent, in evaluation order. Title rules come
// first: a title that says "working" is the agent reporting on itself, which
// beats anything inferred from the shape of its screen.
function detectionRules(agent) {
  const overrides = cfg().get('detectionRules') || {};
  const key = `${agent}\u0000${JSON.stringify(overrides[agent] || null)}`;
  const hit = detectionCache.get(agent);
  if (hit && hit.key === key) return hit.rules;
  // Built-in rules live in AGENT_DETECTION / TITLE_DETECTION; a free-mode agent
  // carries its own on its registry entry, so both kinds override the same way.
  const own = AGENT_DETECTION[agent] || AGENTS[agent]?.detection || {};
  const ownTitle = TITLE_DETECTION[agent] || own.title || {};
  const override = overrides[agent] || {};
  const overrideTitle = (override.title && typeof override.title === 'object') ? override.title : {};
  // An override replaces that list outright, so a noisy built-in can be removed
  // (set it to []), not merely added to.
  const pick = (chosen, fallback) => (Array.isArray(chosen) ? chosen : fallback);
  const rules = [];
  pushRules(pick(overrideTitle.hold, ownTitle.hold), 'title', 'hold', rules);
  pushRules(pick(overrideTitle.needsInput, ownTitle.needsInput), 'title', 'needs-input', rules);
  pushRules(pick(overrideTitle.working, ownTitle.working), 'title', 'working', rules);
  // Hold before the state rules: a viewer covering the screen must win over
  // whatever the covered screen would otherwise have looked like.
  pushRules(pick(override.hold, own.hold), 'tail', 'hold', rules);
  // needs-input defaults to `body`, the tail minus the prompt box, so a
  // question the USER typed cannot be read as a question the AGENT asked.
  pushRules(pick(override.needsInput, [...DETECTION_BASELINE.needsInput, ...(own.needsInput || [])]),
    'body', 'needs-input', rules);
  pushRules(pick(override.working, [...DETECTION_BASELINE.working, ...(own.working || [])]),
    'tail', 'working', rules);
  // Highest priority first, declaration order preserved within a tie (sort is
  // stable), so the evaluation order below is exactly what Explain prints.
  rules.sort((a, b) => b.priority - a.priority);
  detectionCache.set(agent, { key, rules });
  return rules;
}

// Evaluate an agent's rules against `ctx`, one string per region. Returns
// { status, region, pattern } so the Explain command can name the rule that won
// AND the region it looked at; a region `ctx` has nothing for is skipped, so a
// title rule costs nothing on a host whose panes carry no title.
function detectState(agent, ctx) {
  for (const rule of detectionRules(agent)) {
    const text = ctx[rule.region];
    if (!text) continue;
    if (!rule.all.every((re) => re.test(text))) continue;
    if (rule.any.length && !rule.any.some((re) => re.test(text))) continue;
    if (rule.not.some((re) => re.test(text))) continue;
    return {
      status: rule.state, region: rule.region, pattern: rule.source, priority: rule.priority,
    };
  }
  return { status: null, region: null, pattern: null, priority: 0 };
}

// Why did every rule do what it did? The winner alone does not debug a wrong
// dot — the rule that missed by one pattern is usually the interesting one, and
// so is the guard that vetoed the rule you expected to win.
function explainDetection(agent, ctx) {
  const show = (list) => list.map((re) => `/${re.source}/`).join(' ');
  const rows = [];
  let winner = null;
  for (const rule of detectionRules(agent)) {
    const text = ctx[rule.region];
    let outcome;
    let why = '';
    if (text === undefined) { outcome = 'skip'; why = 'no region by that name'; }
    else if (!text) { outcome = 'skip'; why = 'that region is empty in this frame'; }
    else {
      const missed = rule.all.filter((re) => !re.test(text));
      const anyHit = !rule.any.length || rule.any.some((re) => re.test(text));
      const vetoed = rule.not.filter((re) => re.test(text));
      if (missed.length) {
        outcome = 'no';
        // Only worth naming when the rule has more than one thing to miss.
        if (rule.all.length + rule.any.length > 1) why = `missing ${show(missed)}`;
      } else if (!anyHit) { outcome = 'no'; why = 'none of its any() patterns matched'; }
      else if (vetoed.length) { outcome = 'veto'; why = `${show(vetoed)} matched`; }
      else if (winner) { outcome = 'match'; why = 'but outranked by the rule above'; }
      else { outcome = 'MATCH'; winner = rule; }
    }
    rows.push({ rule, outcome, why });
  }
  return { winner, rows };
}

// The shared body of both Explain commands: the regions a frame was cut into
// and what every rule made of them. Returns lines, so the live command can
// print it under the session facts and the file command can print it alone.
function explainLines(agent, ctx) {
  const { winner, rows } = explainDetection(agent, ctx);
  const lines = [
    `  verdict        : ${winner
      ? `${winner.state}  <-  [${winner.region}] p${winner.priority} /${winner.source}/`
      : '(no rule matched — the status falls back to frame-diff activity and decay)'}`,
    '',
    '  regions cut from this frame:',
  ];
  for (const region of DETECTION_REGIONS) {
    const text = ctx[region] || '';
    const shown = text ? text.split('\n').map((line) => `      | ${line}`).join('\n') : '      | (empty)';
    lines.push(`    ${region}:`, shown);
  }
  lines.push('', `  rules evaluated, highest priority first (${rows.length}):`);
  for (const { rule, outcome, why } of rows) {
    lines.push(`    ${String(rule.priority).padStart(4)}  ${rule.state.padEnd(11)} [${rule.region.padEnd(6)}] `
      + `${outcome.padEnd(6)} /${rule.source}/${why ? `   — ${why}` : ''}`);
  }
  return lines;
}

// ---- free mode: agents declared in settings ---------------------------------
// claudeTmux.customAgents adds entries to the registry above without a release.
// Two shapes:
//   { id, label, command, args }  — AgentMux launches and manages it exactly
//       like a built-in agent: its own tab, tmux session, presence, status,
//       input, handoffs, arbiter, cleanup.
//   { id, label, session }        — FREE mode: the tab mirrors an EXISTING tmux
//       session by name. AgentMux never creates it, never restarts it and never
//       lists it for cleanup; it only mirrors it and types into it. That is why
//       such a session is exempt from the workspace-root check every managed
//       session must pass: you named it explicitly, so mirroring it is the
//       point, and no destructive path can reach it anyway.
const CUSTOM_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const CUSTOM_AGENT_LIMIT = 12;

// A free-mode agent has no product colour, so one is derived from its id: the
// same id always gets the same hue, and the saturation/lightness are fixed so
// it sits alongside the built-in palette instead of shouting over it.
function derivedAccent(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const [s, l] = [0.42, 0.62];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// "#rrggbb" -> "r, g, b", so the stylesheet can build any alpha from one value.
function accentChannels(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return '128, 128, 128';
  const n = parseInt(match[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

// A settings string may spell the escape byte as "\\x1b", "\\u001b" or "\\e",
// since JSON cannot hold the byte itself. Only those forms are decoded, and only
// into an escape sequence — never into arbitrary text.
function decodeEscapes(value) {
  const text = String(value || '');
  if (!text) return '';
  const decoded = text
    .replace(/\\e/g, '\x1b')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // A sequence that is not an escape sequence would be typed as literal text.
  return decoded.startsWith('\x1b') && decoded.length <= 32 ? decoded : '';
}

// Two glyphs at most: it stands in for the label when the tab is too narrow.
function derivedMark(label, id) {
  const letters = String(label || id).replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || String(id).slice(0, 2)).toUpperCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeRegExp(source, fallback) {
  if (!source || typeof source !== 'string') return fallback;
  try { return new RegExp(source, 'i'); } catch { return fallback; }
}

// Resume commands are templates: {id} expands to the shell-quoted conversation
// id, {args} to the agent's configured launch arguments.
function fillCommandTemplate(template, id, args) {
  return String(template)
    .replace(/\{id\}/g, id ? shellQuote(id) : '')
    .replace(/\{args\}/g, args || '')
    .trim();
}

// A tmux session name AgentMux can actually address. Names reach tmux as argv,
// never through a shell, so this is not about quoting: it is about not building
// an unaddressable target. ':' and '.' separate session:window.pane inside a
// tmux target (tmux forbids them in session names for exactly that reason), and
// whitespace cannot survive a control-mode command line.
function validSessionName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 128) return '';
  return /[:.\s]/.test(name) ? '' : name;
}

const AGENT_PRESETS = [
  {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    accent: '#0984e3',
    mark: 'Ai',
    installCmd: 'pip install aider-chat',
    detection: {
      needsInput: [{ region: 'foot', any: ['>', 'yes/no', '[y/N]'] }],
      working: [{ region: 'tail', any: ['Thinking', 'Tokens:', 'Applied edit', 'Search and replace'] }],
    },
    resume: { latest: 'aider --restore' },
  },
  {
    id: 'goose',
    label: 'Goose',
    command: 'goose',
    args: 'session',
    accent: '#00b894',
    mark: 'Go',
    installCmd: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    detection: {
      needsInput: [{ region: 'foot', any: ['Goo', 'goose>', '(?i)confirm'] }],
      working: [{ region: 'tail', any: ['thinking', 'running tool', 'processing'] }],
    },
    resume: { latest: 'goose session --resume' },
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    accent: '#6c5ce7',
    mark: 'Cu',
    installCmd: 'npm install -g cursor-agent',
    detection: {
      needsInput: [{ region: 'foot', any: ['?', 'Enter to continue', '[y/N]'] }],
      working: [{ region: 'tail', any: ['Generating', 'Applying'] }],
    },
  },
  {
    id: 'continue',
    label: 'Continue',
    command: 'cn',
    accent: '#e17055',
    mark: 'Cn',
    installCmd: 'npm install -g @continuedev/cli',
    detection: {
      needsInput: [{ region: 'foot', any: ['>', '>>>'] }],
      working: [{ region: 'tail', any: ['Thinking...', 'Working...'] }],
    },
  },
];

async function promptAddAgentPreset() {
  const current = cfg().get('customAgents') || [];
  const existingIds = new Set([...Object.keys(AGENTS), ...current.map((c) => c && c.id).filter(Boolean)]);
  const available = AGENT_PRESETS.filter((p) => !existingIds.has(p.id));

  if (!available.length) {
    vscode.window.showInformationMessage('All built-in presets (Aider, Goose, Cursor, Continue) are already in your configuration.');
    return;
  }

  const items = available.map((p) => ({
    label: p.label,
    description: `${p.command}${p.args ? ' ' + p.args : ''} · ${p.installCmd}`,
    preset: p,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an agent preset to add to AgentMux',
  });
  if (!pick) return;

  const target = pick.preset;
  const next = [...current, target];
  await cfg().update('customAgents', next, vscode.ConfigurationTarget.Global);
  const action = await vscode.window.showInformationMessage(
    `Added ${target.label} to AgentMux custom agents. Reload window to load the new agent tab.`,
    'Reload Window'
  );
  if (action === 'Reload Window') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

function customAgentSpecs() {
  const raw = cfg().get('customAgents');
  if (!Array.isArray(raw)) return [];
  const specs = [];
  const seen = new Set();
  for (const entry of raw.slice(0, CUSTOM_AGENT_LIMIT)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim();
    if (!CUSTOM_ID_RE.test(id) || seen.has(id) || AGENTS[id]) continue;
    const command = String(entry.command || '').trim();
    const attachSession = validSessionName(entry.session);
    if (!command && !attachSession) continue; // nothing to launch, nothing to mirror
    seen.add(id);
    const args = String(entry.args || '').trim();
    const prefix = String(entry.sessionPrefix || '').trim();
    const detection = entry.detection && typeof entry.detection === 'object' ? entry.detection : null;
    const resume = entry.resume && typeof entry.resume === 'object' ? entry.resume : {};
    specs.push({
      id,
      custom: true,
      label: String(entry.label || '').trim().slice(0, 24) || id,
      accent: /^#[0-9a-fA-F]{6}$/.test(String(entry.accent || '')) ? entry.accent : derivedAccent(id),
      mark: String(entry.mark || '').trim().slice(0, 2)
        || derivedMark(entry.label, id),
      // "\x1b[13;2u" style escapes are written as readable text in settings and
      // decoded here; anything unrecognised leaves Shift+Enter as plain Enter.
      modEnter: decodeEscapes(entry.modEnter),
      command: command || null,
      attachSession: attachSession || null,
      prefixSetting: null, // custom agents carry their prefix inline
      defaultPrefix: /^[A-Za-z0-9_.-]{1,32}$/.test(prefix) ? prefix : `tmux_${id}_`,
      argsSetting: null,
      installCmd: String(entry.installCmd || '').trim(),
      paneRe: safeRegExp(
        entry.pane,
        new RegExp(`(?:^|-)${escapeRegExp(command ? path.basename(command.split(/\s+/)[0]) : id)}(?:$|-)`, 'i')
      ),
      paneAliases: [],
      detection: detection ? {
        needsInput: Array.isArray(detection.needsInput) ? detection.needsInput : undefined,
        working: Array.isArray(detection.working) ? detection.working : undefined,
      } : null,
      listSessions: null,
      resumeById: typeof resume.byId === 'string' && resume.byId.trim()
        ? (id2, args2) => fillCommandTemplate(resume.byId, id2, args2) : null,
      resumeLatest: typeof resume.latest === 'string' && resume.latest.trim()
        ? (args2) => fillCommandTemplate(resume.latest, '', args2) : null,
      launchArgs: () => args,
    });
  }
  return specs;
}

// Registered once, at activation, so every roster-driven path sees free-mode
// agents with no special case. Editing the setting needs a window reload, which
// activate() offers when it notices the value changed.
let registeredCustomAgents = '[]';

function registerCustomAgents() {
  registeredCustomAgents = JSON.stringify(cfg().get('customAgents') || []);
  const specs = customAgentSpecs();
  for (const spec of specs) {
    if (AGENTS[spec.id]) continue; // never shadow a built-in agent
    AGENTS[spec.id] = spec;
    AGENT_IDS.push(spec.id);
  }
  return specs;
}

function customAgentsChanged() {
  return JSON.stringify(cfg().get('customAgents') || []) !== registeredCustomAgents;
}

// Edit the roster in whichever scope already defines it, so a workspace-level
// list is not silently shadowed by a user-level one (and vice versa).
function customAgentsTarget() {
  const inspected = cfg().inspect ? cfg().inspect('customAgents') : null;
  if (inspected?.workspaceFolderValue) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function customAgentsAt(target) {
  const inspected = (cfg().inspect ? cfg().inspect('customAgents') : null) || {};
  const value = target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected.workspaceFolderValue
    : target === vscode.ConfigurationTarget.Workspace ? inspected.workspaceValue
      : inspected.globalValue;
  return Array.isArray(value) ? value : [];
}

// A stable, valid id derived from the session name, unique against both the
// built-in roster and the entries already in the list.
function freeAgentId(session, existing = []) {
  const base = String(session).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  let candidate = /^[a-z]/.test(base) ? base : `s-${base}`;
  candidate = candidate.slice(0, 24);
  const taken = new Set([...Object.keys(AGENTS), ...existing.map((entry) => String(entry?.id || ''))]);
  if (!taken.has(candidate) && CUSTOM_ID_RE.test(candidate)) return candidate;
  for (let n = 2; n < 100; n++) {
    const next = `${candidate.slice(0, 21)}-${n}`;
    if (!taken.has(next) && CUSTOM_ID_RE.test(next)) return next;
  }
  return `s-${crypto.randomBytes(4).toString('hex')}`;
}

// Sessions a free-mode agent only mirrors. Nothing destructive may include them.
function mirroredSessionNames() {
  const names = new Set();
  for (const agent of AGENT_IDS) {
    if (AGENTS[agent].attachSession) names.add(AGENTS[agent].attachSession);
  }
  return names;
}

// Per-agent map built from the registry, so no call site has to know the roster.
function byAgent(make) {
  const out = {};
  for (const agent of AGENT_IDS) out[agent] = make(agent);
  return out;
}

// normalizedPath runs on every keystroke (queueInput/sendInputData), so cache
// the realpath lookup briefly instead of hitting the filesystem each time.
const REALPATH_TTL_MS = 10000;
const realpathCache = new Map();
function normalizedPath(value) {
  if (!value) return '';
  const hit = realpathCache.get(value);
  const now = Date.now();
  if (hit && now - hit.ts < REALPATH_TTL_MS) return hit.path;
  let resolved;
  try { resolved = fs.realpathSync.native(value); } catch { resolved = path.resolve(value); }
  realpathCache.set(value, { path: resolved, ts: now });
  return resolved;
}

// How long a verified (name, ready) session identity may be reused by the input
// hot path before it must be re-verified against tmux. The presence loop
// refreshes it every ~900ms, so entries are normally always fresh.
const SESSION_CACHE_TTL_MS = 3000;

function baseSessionName(agent, cwd = workspaceFolder()) {
  const spec = AGENTS[agent];
  if (!spec) return '';
  // A free-mode agent mirrors one existing session, under its real name.
  if (spec.attachSession) return spec.attachSession;
  if (!cwd) return '';
  const prefix = (spec.prefixSetting ? cfg().get(spec.prefixSetting) : '') || spec.defaultPrefix;
  return prefix + path.basename(cwd).replace(/[:.]/g, '_');
}

function pathHash(cwd) {
  return crypto.createHash('sha256').update(normalizedPath(cwd)).digest('hex').slice(0, 8);
}

// Keep the legacy, readable name whenever it belongs to this workspace. If a
// same-basename project already owns it, add a stable path hash instead of ever
// attaching to another folder's tmux session.
async function sessionName(agent) {
  const cwd = workspaceFolder();
  const base = baseSessionName(agent, cwd);
  if (!base) return '';
  // A mirrored session's name is the user's, not ours to disambiguate.
  if (AGENTS[agent]?.attachSession) return base;
  const found = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(base), '#{session_path}'], TMUX_PROBE_TIMEOUT_MS);
  // tmux 3.4 answers a missing '=name:' target with exit 0 and an EMPTY line
  // rather than an error, so "not ok" is not the only way to say "no such
  // session". Without treating empty as absent, every brand-new session was
  // named <base>-<hash> — the disambiguation for a name another project already
  // owns — even when the plain name was free.
  const hashed = `${base}-${pathHash(cwd)}`;
  const owner = found.ok ? found.out.trim() : '';
  if (owner) {
    const normOwner = normalizedPath(owner);
    const normCwd = normalizedPath(cwd);
    const isOwnerThisWorkspace = normOwner === normCwd
      || !!(normOwner && normCwd && normOwner.startsWith(normCwd + '/.agentmux/worktrees/'));
    return isOwnerThisWorkspace ? base : hashed;
  }
  // Nothing holds the plain name. Before claiming it, adopt a hashed session
  // that already belongs to this workspace: on a tmux affected by the bug above
  // every session was named that way, and starting a second one under the clean
  // name would orphan the agent the user is actually running. One extra probe,
  // and only on the path where no agent answers to the plain name anyway.
  const legacy = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(hashed), '#{session_path}'], TMUX_PROBE_TIMEOUT_MS);
  const legacyOwner = legacy.ok ? legacy.out.trim() : '';
  if (legacyOwner) {
    const normLegacy = normalizedPath(legacyOwner);
    const normCwd = normalizedPath(cwd);
    const isLegacyThisWorkspace = normLegacy === normCwd
      || !!(normLegacy && normCwd && normLegacy.startsWith(normCwd + '/.agentmux/worktrees/'));
    if (isLegacyThisWorkspace) return hashed;
  }
  return base;
}

async function sessionBelongsToWorkspace(name) {
  const cwd = workspaceFolder();
  if (!name || !cwd) return false;
  const found = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(name), '#{session_path}']);
  if (!found.ok) return false;
  const p = normalizedPath(found.out.trim());
  const normCwd = normalizedPath(cwd);
  return p === normCwd || !!(p && normCwd && p.startsWith(normCwd + '/.agentmux/worktrees/'));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function tmuxSessionTarget(name) {
  return `=${name}`;
}

function tmuxPaneTarget(name) {
  return `=${name}:`;
}

function stripAnsi(value) {
  const s = String(value || '');
  if (s.indexOf('\x1b') < 0 && s.indexOf('\r') < 0) return s;
  return s
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function fmtDurationShort(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

// The live tick fuses `capture-pane` and the cursor/size `display-message` into
// ONE tmux invocation (';'-separated commands run in a single process). The
// meta line is prefixed with \x1f so it can be split from arbitrary pane text,
// and it is always exactly as fresh as the frame it describes.
const META_SENTINEL = '\x1f';
// Some tmux versions (e.g. 3.4 on Ubuntu 24.04) sanitize control characters in
// display-message output, so the sentinel arrives as the literal text "\037"
// instead of the raw byte. Both forms must parse, or the cursor/size meta is
// never seen and the meta line leaks into the rendered frame as pane text.
const META_SENTINEL_ESCAPED = '\\037';
const META_FORMAT = '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height},#{session_created},#{history_size},#{session_attached}';

// A leaked meta line is the sentinel followed by exactly the 7-number CSV at
// end of line; arbitrary pane bytes that merely contain \x1f must survive.
const META_LEAK_RE = /^.*(?:\x1f|\\037)\d+,\d+,\d+,\d+,\d+,\d+,\d+\s*$/;

function splitFusedCapture(out) {
  const text = String(out || '');
  for (const sentinel of [META_SENTINEL, META_SENTINEL_ESCAPED]) {
    const idx = text.lastIndexOf(sentinel);
    if (idx < 0) continue;
    const metaText = text.slice(idx + sentinel.length).trim();
    if (/^\d+,\d+,\d+,\d+,\d+,\d+,\d+$/.test(metaText)) {
      // Defense in depth: if reply framing ever drifts again, never let a
      // sentinel/meta line reach the renderer as pane text.
      return { frame: stripMetaLines(text.slice(0, idx)), meta: metaText };
    }
  }
  return { frame: stripMetaLines(text), meta: null };
}

function stripMetaLines(frame) {
  if (!frame.includes(META_SENTINEL) && !frame.includes(META_SENTINEL_ESCAPED)) return frame;
  return frame
    .split('\n')
    .filter((line) => !META_LEAK_RE.test(line))
    .join('\n');
}

// Index-wise line diff for the frame transport. Returns null when a full frame
// is cheaper or safer (row count changed, or the delta isn't small enough).
function diffFrameLines(oldLines, newLines, fullLength) {
  if (!oldLines || oldLines.length !== newLines.length) return null;
  const changes = [];
  let changedBytes = 0;
  for (let i = 0; i < newLines.length; i++) {
    if (newLines[i] !== oldLines[i]) {
      changes.push([i, newLines[i]]);
      changedBytes += newLines[i].length + 8;
      if (changedBytes >= fullLength * 0.4) return null;
    }
  }
  return changes;
}

function extractMarkedBlock(value, prefix, id) {
  const begin = `${prefix}_BEGIN:${id}`;
  const end = `${prefix}_END:${id}`;
  const start = String(value || '').lastIndexOf(begin);
  if (start < 0) return null;
  const contentStart = start + begin.length;
  const finish = String(value).indexOf(end, contentStart);
  if (finish < 0) return null;
  const content = String(value).slice(contentStart, finish).trim();
  return content || null;
}

// Where the source agent should put its authored block: through the
// .claude/agentmux file channel when enabled (no capture-window limits), with
// the pane-marker block as the universal fallback. Marker strings are always
// described indirectly so the echoed prompt can never satisfy the matcher.
function handoffReturnInstructions(id, kind = 'draft') {
  const fileName = `${kind}-${id}.md`;
  const lines = [];
  if (cfg().get('fileChannel') !== false) {
    lines.push(
      `Write the complete output to the workspace file .claude/agentmux/${fileName} (create the directories if needed).`,
      'The very last line of that file must be the end marker described below; do not add anything after it.',
      'If you cannot write files, instead print the output in your reply as one delimited block using both markers.'
    );
  } else {
    lines.push('Return only one delimited block.');
  }
  lines.push(
    'Build each marker by joining the prefix, a colon, and the transaction ID.',
    'Begin prefix: HANDOFF_BEGIN',
    'End prefix: HANDOFF_END',
    `Transaction ID: ${id}`
  );
  return lines;
}

function sourceHandoffPrompt(source, target, id, details = '') {
  const userDetails = String(details || '');
  return [
    `Prepare a standalone handoff specifically from ${AGENTS[source].label} to ${AGENTS[target].label}.`,
    'Do not continue implementation and do not modify files other than the handoff file described below. Report only verified facts and label uncertainty.',
    `${AGENTS[target].label} must be able to continue without reading this chat or terminal history.`,
    ...(userDetails.trim() ? [
      '',
      'The user supplied these additional details. Treat them as requirements/context and reflect every relevant point in the handoff:',
      '<USER_HANDOFF_DETAILS>',
      userDetails,
      '</USER_HANDOFF_DETAILS>',
    ] : []),
    '',
    'Include these concise sections:',
    '- Objective and acceptance criteria',
    '- Completed work',
    '- Files and symbols involved',
    '- Decisions and constraints',
    '- Verification already run',
    '- Open risks or questions',
    '- Recommended next action',
    '',
    ...handoffReturnInstructions(id, 'draft'),
  ].join('\n');
}

// Reverse leg after a review-mode handoff: the reviewer reports structured
// findings back to the original author under the same transaction machinery.
function findingsPrompt(source, target, id, details = '') {
  const userDetails = String(details || '');
  return [
    `Report your review findings from ${AGENTS[source].label} back to ${AGENTS[target].label}, who authored the work you just reviewed.`,
    'Do not start new implementation work. Report only findings you actually verified, with concrete evidence.',
    ...(userDetails.trim() ? [
      '',
      'The user supplied these additional details:',
      '<USER_HANDOFF_DETAILS>',
      userDetails,
      '</USER_HANDOFF_DETAILS>',
    ] : []),
    '',
    'Include these concise sections:',
    '- Verdict (one sentence)',
    '- Confirmed issues: file:line, severity, what breaks, suggested fix',
    '- Checked and found sound',
    '- Not verified / out of scope',
    '- Recommended next action for the author',
    '',
    ...handoffReturnInstructions(id, 'draft'),
  ].join('\n');
}

// ---- ground-truth agent state ------------------------------------------------
// Claude Code lifecycle hooks and Codex's notify program run a one-line script
// that stamps the agent's true state into tmux pane options; the presence loop
// already reads pane options every ~900ms, so the read-back is free and the
// frame-diff heuristic becomes a fallback instead of the only signal.
let stateHookDir = null; // set in activate() from globalStorageUri

function setStateHookDir(dir) {
  stateHookDir = dir || null;
}

// One script serves every hook of both CLIs. $1 is the state to stamp, or the
// literal "register", which records the conversation id WITHOUT touching the
// state — a session that has just started is not "finished", and stamping done
// there would raise a completion badge on an agent that has done nothing.
const STATE_HOOK_SCRIPT = `#!/bin/sh
# AgentMux: stamp agent state into tmux pane options. Generated file - do not edit.
[ -n "$TMUX_PANE" ] || exit 0
state="$1"
tool=""
session=""
# Claude and Codex both deliver the hook payload as JSON on stdin. Read it ONCE
# (bounded) and pull both fields from the copy: a second read would find the
# pipe already drained. A hook with no payload simply leaves them empty.
if [ ! -t 0 ]; then
  payload=$(head -c 4000 2>/dev/null)
  tool=$(printf '%s' "$payload" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]\\{1,40\\}\\)".*/\\1/p' | head -n 1)
  session=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]\\{1,64\\}\\)".*/\\1/p' | head -n 1)
fi
[ -n "$session" ] && tmux set-option -p -t "$TMUX_PANE" @agentmux_session_id "$session" 2>/dev/null
if [ "$state" != "register" ]; then
  tmux set-option -p -t "$TMUX_PANE" @agentmux_state "$state" 2>/dev/null
  tmux set-option -p -t "$TMUX_PANE" @agentmux_tool "$tool" 2>/dev/null
fi
exit 0
`;

// OpenCode has no hook flag, but it does load plugins from its config dir, and
// its plugin API emits exactly the lifecycle events we need. The plugin is the
// only asset AgentMux writes into another tool's user config, so it is inert by
// default: it acts only when AGENTMUX=1 is present, which we set on the launch
// command. An opencode you start yourself is never touched.
const OPENCODE_PLUGIN = `// AgentMux: report OpenCode lifecycle state into tmux pane options.
// Generated file - do not edit. Remove it with the AgentMux
// "Remove agent integrations" command, or just delete this file.
const PANE = process.env.TMUX_PANE || '';
const OWNED = process.env.AGENTMUX === '1';

async function run(args) {
  try {
    const { execFile } = await import('node:child_process');
    await new Promise((resolve) => execFile('tmux', args, () => resolve()));
  } catch { /* no tmux here: AgentMux falls back to screen detection */ }
}

// Writes are serialized: each one is its own tmux process, and an out-of-order
// pair would leave the tab showing the older state.
let writes = Promise.resolve();
let reportedState = '';
let reportedTool = '';

function write(state, tool) {
  writes = writes.then(async () => {
    await run(['set-option', '-p', '-t', PANE, '@agentmux_state', state]);
    await run(['set-option', '-p', '-t', PANE, '@agentmux_tool', tool || '']);
  }, () => {});
  return writes;
}

// opencode runs subagents as CHILD SESSIONS that emit their own idle events, so
// reporting the first idle would mark the whole pane done while the parent is
// still working. Every session's status is tracked and only the AGGREGATE is
// reported: anything waiting wins, then anything working, otherwise done.
const statusBySession = new Map();
const acceptWorking = new Map();
const deletedSessions = new Set();
let lastTool = '';

function aggregate() {
  const all = [...statusBySession.values()];
  if (all.includes('needs-input')) return 'needs-input';
  if (all.includes('working')) return 'working';
  return 'done';
}

async function report(tool) {
  if (tool !== undefined) lastTool = tool;
  const state = aggregate();
  const nextTool = state === 'working' ? lastTool : '';
  if (state === reportedState && nextTool === reportedTool) return;
  reportedState = state;
  reportedTool = nextTool;
  await write(state, nextTool);
}

async function setStatus(id, status, tool) {
  if (!PANE || !OWNED || !id || deletedSessions.has(id)) return;
  const previous = statusBySession.get(id);
  // A 'done' for a session that was never seen working is noise, not an edge.
  if (status === 'done' && previous === undefined) return;
  // opencode can emit a trailing stale 'busy' AFTER the 'idle' that closed a
  // turn. Ignore it; the next user message re-arms this session below.
  if (status === 'working' && acceptWorking.get(id) === false) return;
  if (previous !== status) {
    statusBySession.set(id, status);
    acceptWorking.set(id, status !== 'done');
  }
  await report(tool);
}

async function stampSession(id) {
  if (!PANE || !OWNED || !id) return;
  await run(['set-option', '-p', '-t', PANE, '@agentmux_session_id', String(id)]);
}

function pickSessionId(p) {
  const props = p || {};
  return props.sessionID || props.sessionId || props.session_id
    || (props.info && props.info.id) || props.id || '';
}

async function onEvent(type, properties) {
  if (!type) return;
  const props = properties || {};
  const id = pickSessionId(props);
  if (type === 'session.created') return stampSession(id);
  if (type === 'session.deleted') {
    const gone = pickSessionId(props) || (props.info && props.info.id);
    if (!gone) return;
    deletedSessions.add(gone);
    acceptWorking.delete(gone);
    if (statusBySession.delete(gone)) await report();
    return;
  }
  if (type === 'permission.asked' || type === 'question.asked') return setStatus(id, 'needs-input', '');
  if (type === 'permission.replied' || type === 'question.replied') return setStatus(id, 'working');
  if (type === 'session.idle' || type === 'session.error') return setStatus(id, 'done', '');
  if (type === 'session.status') {
    const kind = (props.status && props.status.type) || props.status || '';
    if (kind === 'busy') return setStatus(id, 'working');
    if (kind === 'idle') return setStatus(id, 'done', '');
    return;
  }
  if (type === 'tool.execute.before') {
    return setStatus(id, 'working', String(props.tool || props.name || '').slice(0, 40));
  }
  if (type === 'message.updated' || type === 'message.part.updated') {
    // A new user message re-arms a session that had gone quiet.
    const role = (props.info && props.info.role) || props.role || '';
    if (role === 'user' && id) acceptWorking.set(id, true);
    return setStatus(id, 'working');
  }
}

export const AgentMuxState = async () => ({
  // opencode has shipped both a single 'event' hook and per-event keys; declare
  // both so reporting survives either shape. Unknown keys are simply ignored.
  event: async (input) => {
    const payload = (input && input.event) || input || {};
    await onEvent(payload.type, payload.properties || payload);
  },
  'session.created': async (i) => onEvent('session.created', (i && i.properties) || i),
  'session.deleted': async (i) => onEvent('session.deleted', (i && i.properties) || i),
  'session.idle': async (i) => onEvent('session.idle', (i && i.properties) || i),
  'session.error': async (i) => onEvent('session.error', (i && i.properties) || i),
  'session.status': async (i) => onEvent('session.status', (i && i.properties) || i),
  'permission.asked': async (i) => onEvent('permission.asked', (i && i.properties) || i),
  'permission.replied': async (i) => onEvent('permission.replied', (i && i.properties) || i),
  'question.asked': async (i) => onEvent('question.asked', (i && i.properties) || i),
  'question.replied': async (i) => onEvent('question.replied', (i && i.properties) || i),
  'message.updated': async (i) => onEvent('message.updated', (i && i.properties) || i),
  'tool.execute.before': async (i) => onEvent('tool.execute.before', (i && i.properties) || i),
});
`;

function opencodePluginPath() {
  const home = process.env.HOME || '';
  const xdg = (process.env.XDG_CONFIG_HOME || '').trim();
  const base = xdg || path.join(home, '.config');
  return path.join(base, 'opencode', 'plugins', 'agentmux-state.js');
}

function ensureOpencodePlugin() {
  if (cfg().get('stateHooks') === false) return false;
  try {
    const file = opencodePluginPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== OPENCODE_PLUGIN) fs.writeFileSync(file, OPENCODE_PLUGIN);
    return true;
  } catch {
    return false; // read-only config dir: state stays heuristic
  }
}

function removeOpencodePlugin() {
  try {
    fs.unlinkSync(opencodePluginPath());
    return true;
  } catch {
    return false;
  }
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return process.env.HOME || '';
  if (text.startsWith('~/')) return path.join(process.env.HOME || '', text.slice(2));
  return text;
}

// pi's config root, honouring the CLI's own PI_CODING_AGENT_DIR override
// (verified in its config.js: getAgentDir()).
function piAgentDir() {
  const env = (process.env.PI_CODING_AGENT_DIR || '').trim();
  return env ? expandHome(env) : path.join(process.env.HOME || '', '.pi', 'agent');
}

// pi has no hook flag either, but it auto-discovers extensions from
// ~/.pi/agent/extensions/*.ts and its event set is the richest of any agent
// here: agent_settled is documented as the event "status integrations" should
// use, and ui_prompt_start/end mark exactly the spans where pi is blocked on
// the user. Same containment as the OpenCode plugin: the factory returns
// immediately unless AGENTMUX=1, so a pi you start yourself never touches tmux.
// Loaded through jiti, so this file may be plain JS in a .ts extension.
const PI_EXTENSION = `// AgentMux: report pi lifecycle state into tmux pane options.
// Generated file - do not edit. Remove it with the AgentMux
// "Remove agent integrations" command, or just delete this file.
import { execFile } from "node:child_process";

const PANE = process.env.TMUX_PANE || "";
const OWNED = process.env.AGENTMUX === "1";

function run(args) {
  return new Promise((resolve) => {
    try { execFile("tmux", args, () => resolve()); }
    catch { resolve(); } // no tmux here: AgentMux falls back to screen detection
  });
}

async function stamp(state, tool) {
  await run(["set-option", "-p", "-t", PANE, "@agentmux_state", state]);
  await run(["set-option", "-p", "-t", PANE, "@agentmux_tool", tool || ""]);
}

export default function (pi) {
  if (!PANE || !OWNED) return;
  // What pi goes back to once a blocking prompt closes, so a /model picker
  // opened mid-run does not leave the tab reading "waiting for input".
  let resting = "done";
  pi.on("session_start", async (_event, ctx) => {
    const id = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId
      ? ctx.sessionManager.getSessionId() : "";
    if (id) await run(["set-option", "-p", "-t", PANE, "@agentmux_session_id", String(id)]);
    resting = "done";
    await stamp("done", "");
  });
  pi.on("agent_start", async () => { resting = "working"; await stamp("working", ""); });
  pi.on("tool_execution_start", async (event) => {
    resting = "working";
    await stamp("working", String((event && event.toolName) || "").slice(0, 40));
  });
  pi.on("tool_execution_end", async () => {
    if (resting === "working") await stamp("working", "");
  });
  // agent_settled, not agent_end: after a run ends pi may still auto-retry,
  // auto-compact or drain queued messages, and only "settled" means it stopped.
  pi.on("agent_settled", async () => { resting = "done"; await stamp("done", ""); });
  pi.on("ui_prompt_start", async () => { await stamp("needs-input", ""); });
  pi.on("ui_prompt_end", async () => { await stamp(resting, ""); });
}
`;

function piExtensionPath() {
  return path.join(piAgentDir(), 'extensions', 'agentmux-state.ts');
}

function ensurePiExtension() {
  if (cfg().get('stateHooks') === false) return false;
  try {
    const file = piExtensionPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== PI_EXTENSION) fs.writeFileSync(file, PI_EXTENSION);
    return true;
  } catch {
    return false; // read-only config dir: state stays heuristic
  }
}

function removePiExtension() {
  try {
    fs.unlinkSync(piExtensionPath());
    return true;
  } catch {
    return false;
  }
}

function stateHookPaths() {
  if (!stateHookDir) return null;
  return {
    script: path.join(stateHookDir, 'agentmux-state.sh'),
    settings: path.join(stateHookDir, 'claude-hooks.json'),
  };
}

function ensureStateHookAssets() {
  const paths = stateHookPaths();
  if (!paths) return null;
  try {
    fs.mkdirSync(stateHookDir, { recursive: true });
    const current = fs.existsSync(paths.script) ? fs.readFileSync(paths.script, 'utf8') : '';
    if (current !== STATE_HOOK_SCRIPT) fs.writeFileSync(paths.script, STATE_HOOK_SCRIPT, { mode: 0o755 });
    const hook = (state) => [{ hooks: [{ type: 'command', command: `${shellQuote(paths.script)} ${state}` }] }];
    const settings = JSON.stringify({
      hooks: {
        UserPromptSubmit: hook('working'),
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${shellQuote(paths.script)} working` }] }],
        Notification: hook('needs-input'),
        Stop: hook('done'),
      },
    }, null, 2);
    const existing = fs.existsSync(paths.settings) ? fs.readFileSync(paths.settings, 'utf8') : '';
    if (existing !== settings) fs.writeFileSync(paths.settings, settings);
    return paths;
  } catch {
    return null;
  }
}

function claudeLaunchArgs() {
  const configured = (cfg().get('claudeArgs') || '').trim();
  const parts = configured ? [configured] : [];
  if (cfg().get('stateHooks') !== false && !/(?:^|\s)--settings\b/.test(configured)) {
    const paths = ensureStateHookAssets();
    if (paths) parts.push(`--settings ${shellQuote(paths.settings)}`);
  }
  return parts.join(' ');
}

const CODEX_CLAUDE_RULES = [
  'Before doing any work, recursively discover and read every Markdown file under the workspace .claude directory.',
  'Treat those Markdown files as the canonical project instructions and respect any path-specific scopes they declare.',
  'Do not follow symlinks while discovering them, and ignore non-Markdown files such as settings, hooks, caches, databases, and credentials.',
  'Skip the .claude/agentmux directory during this discovery; it holds transient AgentMux coordination files to read only when a prompt names one explicitly.',
  'Re-read the relevant .claude Markdown files when they change.',
].join(' ');

// A TOML basic string, for values that travel inside a `-c key=<toml>` override.
function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Codex 0.147+ ships a Claude-shaped lifecycle hook system. Verified against
// the CLI itself: the events are PreToolUse, PermissionRequest, PostToolUse,
// PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit,
// SubagentStart, SubagentStop and Stop, and `codex exec` prints "hook: <Event>"
// as each one runs. This replaces the notify program as Codex's state source:
// notify could only ever say `done`, so `working` and `needs-input` were left
// to the screen heuristics. PermissionRequest in particular is real approval
// detection instead of a guess at a prompt's wording.
//
// They are passed per launch with -c, never written into the user's
// config.toml — the same containment as the notify program before them.
//
// Codex asks ONCE to trust a hook command set, recording a sha256 in
// config.toml (`[hooks.state]`); until then the pane shows "N hooks need review
// before they can run" and they stay inactive. The command strings below are
// stable, so that question is asked once per machine — but changing this list
// changes the hashes, so a future edit here costs the user one more `t`.
// notify is kept alongside: if the trust prompt is declined, `done` still works.
const CODEX_HOOKS = [
  // register: record the conversation id without claiming the session finished.
  { event: 'SessionStart', state: 'register', matcher: 'startup|resume|clear' },
  { event: 'UserPromptSubmit', state: 'working', matcher: null },
  { event: 'PreToolUse', state: 'working', matcher: '*' },
  { event: 'PostToolUse', state: 'working', matcher: '*' },
  { event: 'PermissionRequest', state: 'needs-input', matcher: '*' },
  { event: 'Stop', state: 'done', matcher: null },
];

function codexHookArgs(script) {
  return CODEX_HOOKS.map(({ event, state, matcher }) => {
    const hook = `{type="command",command=${tomlString(`${shellQuote(script)} ${state}`)}}`;
    const group = matcher ? `{matcher=${tomlString(matcher)},hooks=[${hook}]}` : `{hooks=[${hook}]}`;
    return `-c ${shellQuote(`hooks.${event}=[${group}]`)}`;
  });
}

function codexLaunchArgs() {
  const configured = (cfg().get('codexArgs') || '').trim();
  const parts = configured ? [configured] : [];
  if (cfg().get('codexFullAccess')) {
    const hasPermissionOverride = /(?:^|\s)(?:--dangerously-bypass-approvals-and-sandbox|--yolo|--sandbox|-s\s|--ask-for-approval|-a\s)/.test(configured);
    if (!hasPermissionOverride) parts.push('--dangerously-bypass-approvals-and-sandbox');
  }
  const hasDeveloperOverride = codexArgsHaveDeveloperOverride(configured);
  if (cfg().get('codexReadClaudeRules') && !hasDeveloperOverride) {
    const value = `developer_instructions=${JSON.stringify(CODEX_CLAUDE_RULES)}`;
    parts.push(`-c ${shellQuote(value)}`);
  }
  if (cfg().get('stateHooks') !== false && !/notify\s*=/.test(configured)) {
    const paths = ensureStateHookAssets();
    if (paths) {
      parts.push(`-c ${shellQuote(`notify=${JSON.stringify([paths.script, 'done'])}`)}`);
      // An explicit hooks override in codexArgs wins outright: never fight the
      // user's own hook configuration.
      if (cfg().get('codexHooks') !== false && !/(?:^|\s)-c\s+\S*hooks\./.test(configured)) {
        parts.push(...codexHookArgs(paths.script));
      }
    }
  }
  return parts.join(' ');
}

function codexArgsHaveDeveloperOverride(configured = (cfg().get('codexArgs') || '')) {
  return /(?:^|\s)(?:-c|--config)\s+[^\n]*developer_instructions\s*=/.test(configured);
}

// Antigravity exposes no hook/notify mechanism, so its state stays on the
// frame-diff heuristic (the documented fallback) and its args pass through
// verbatim — permissions are whatever the user configured.
function antigravityLaunchArgs() {
  return (cfg().get('antigravityArgs') || '').trim();
}

// OpenCode takes no hook flag: its integration is a plugin file, installed
// on demand right before launch.
function opencodeLaunchArgs() {
  if (cfg().get('stateHooks') !== false) ensureOpencodePlugin();
  return (cfg().get('opencodeArgs') || '').trim();
}

// Same shape for pi, whose integration is an extension file.
function piLaunchArgs() {
  if (cfg().get('stateHooks') !== false) ensurePiExtension();
  return (cfg().get('piArgs') || '').trim();
}

function launchArgs(agent) {
  const spec = AGENTS[agent];
  if (!spec) return '';
  // Agents whose args need composition (hook/plugin wiring) carry a launcher
  // in the registry; everyone else is the plain argsSetting.
  if (spec.launchArgs) return spec.launchArgs();
  return (cfg().get(spec.argsSetting) || '').trim();
}

// tmux reports a pane's FOREGROUND PROCESS, which for several agents is not the
// agent: a Node CLI shows up as `node`, Hermes as `python`, and some Claude Code
// builds report their own version string as the command. Treating an
// interpreter name as an agent would claim every node/python process running in
// the workspace — `npm run dev` would appear as an agent tab AgentMux types
// into — so interpreters count as UNIDENTIFIED and only the pane title, which a
// TUI sets deliberately, is allowed to resolve them.
const GENERIC_INTERPRETERS = new Set(['node', 'python', 'python3', 'bun', 'deno', 'ruby']);

// A bare dotted version ("2.1.118") is never a real command name.
function looksLikeVersionString(value) {
  return /^\d+(?:\.\d+){1,3}$/.test(value);
}

// Does a pane already running something look like this agent, even though we
// did not launch it (so it carries no @claude_tmux_agent marker)?
function paneLooksLikeAgent(agent, command, title = '') {
  const spec = AGENTS[agent];
  if (!spec) return false;
  const base = path.basename(command || '');
  if (!base) return false;
  if (spec.paneRe.test(base) || (spec.paneAliases || []).includes(base)) return true;
  if (spec.paneVersionCommand && looksLikeVersionString(base)) return true;
  if (!GENERIC_INTERPRETERS.has(base.toLowerCase())) return false;
  return !!(spec.paneTitleRe && title && spec.paneTitleRe.test(title));
}

// Everything that must match for "this is still the exact process I validated":
// the session's creation stamp, the launch generation AgentMux stamped on it,
// the pane's shell pid and the tmux server's. A handoff briefing must never be
// pasted into a pane that merely reuses the name — session_created has
// one-second resolution and an adopted agent carries no generation at all, so
// neither is sufficient on its own.
function paneIdentity(info) {
  return [info?.created || '', info?.generation || '', info?.panePid || '', info?.serverPid || ''].join(':');
}

// Does a live pane still match what a handoff pinned? Transactions pinned
// before 0.13.0 — one rehydrated from an older ledger — recorded only the
// created/generation pair, so they are compared against what they actually
// have rather than being reported stale on sight.
function identityMatches(info, pinned) {
  if (!info || !pinned) return false;
  if (pinned.targetIdentity) return paneIdentity(info) === pinned.targetIdentity;
  return info.created === pinned.targetCreated && info.generation === pinned.targetGeneration;
}

// A title-derived identity is sticky. The title that revealed it drifts —
// Claude rewrites it with the conversation summary as work goes on — and losing
// the classification would make an adopted agent vanish from the side bar
// mid-session. Keyed by the session's tmux identity, and dropped the moment the
// pane falls back to a shell (the agent exited).
const paneIdentityCache = new Map();

function isShellCommand(command) {
  return /^(?:ba|da|fi|k|tc|z)?sh$|^(?:fish|nu|pwsh|powershell)$/.test(path.basename(command || ''));
}

async function agentSessionInfo(agent, name) {
  const result = await tmux([
    'display-message', '-p', '-t', tmuxPaneTarget(name),
    '#{session_path}\t#{@claude_tmux_agent}\t#{@claude_tmux_running}\t#{pane_current_command}\t#{session_created}\t#{@claude_tmux_generation}\t#{@agentmux_state}\t#{@agentmux_tool}\t#{@agentmux_session_id}\t#{pane_pid}\t#{pid}\t#{pane_in_mode}\t#{pane_mode}\t#{pane_title}',
  ], TMUX_PROBE_TIMEOUT_MS);
  // Timed out or transport-dead is "unknown", never "absent": callers on the
  // live path (tick, presence, input) must skip the cycle rather than tear
  // down state for a session that is probably still there.
  if (result.timedOut || result.transportFailed) return { exists: false, ready: false, transient: true };
  if (!result.ok) return { exists: false, ready: false };
  const fields = result.out.replace(/\r?\n$/, '').split('\t');
  const [sessionPath, marker, running, command = '', created = '', generation = '',
    hookState = '', hookTool = '', hookSessionId = '', panePid = '', serverPid = '',
    inModeFlag = '', modeName = ''] = fields;
  // The title is last so a tab inside it cannot shift any other field.
  const title = fields.slice(13).join('\t');
  // A pane sitting in copy mode (someone scrolled it from an attached
  // terminal, then walked away) swallows every key send-keys delivers while
  // capture-pane still shows the ordinary screen underneath. Surfacing the
  // mode lets the input path leave it before typing, instead of losing keys
  // with no visible reason.
  const paneMode = inModeFlag === '1' ? (modeName || 'mode') : '';
  const shell = isShellCommand(command);
  // panePid is the pane's shell process and serverPid the tmux server's, so the
  // pair distinguishes "this is the same pane I validated" from "a pane that
  // reuses its name after a recreate or a tmux server restart". session_created
  // alone cannot: it has one-second resolution.
  const base = { shell, command, created, generation, hookState, hookTool, hookSessionId, panePid, serverPid, title, paneMode };
  // Free mode: the user named this session explicitly, so mirroring it is the
  // whole point and it is not bound to the workspace root the way a managed
  // session is. Whatever runs in it — agent or plain shell — is ready to
  // mirror. Nothing destructive can reach it: creation, restart, kill-pick and
  // cleanup all exclude mirrored sessions.
  // An empty session_path means the target does not exist: tmux 3.4 answers a
  // missing '=name:' target with exit 0 and an empty line, not an error.
  if (!sessionPath) return { exists: false, ready: false };
  if (AGENTS[agent]?.attachSession) return { exists: true, ready: true, ...base };
  const normSessionPath = normalizedPath(sessionPath);
  const normWorkspace = normalizedPath(workspaceFolder());
  const inWorkspace = normSessionPath === normWorkspace
    || !!(normSessionPath && normWorkspace && normSessionPath.startsWith(normWorkspace + '/.agentmux/worktrees/'));
  if (!inWorkspace) return { exists: false, ready: false };
  if (marker === agent) {
    if (running === 'starting' && !shell) {
      await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_running', '1']);
      return { exists: true, ready: true, ...base };
    }
    return { exists: true, ready: running === '1', ...base };
  }
  // A pane already claimed by another agent must never read as this one.
  const claimedByOther = marker && AGENTS[marker] && marker !== agent;
  const identityKey = [serverPid, name, created, panePid].join(":");
  if (shell) paneIdentityCache.delete(identityKey); // the agent exited
  let direct = false;
  if (!claimedByOther) {
    direct = paneLooksLikeAgent(agent, command, title);
    if (direct) paneIdentityCache.set(identityKey, agent);
    else if (!shell && paneIdentityCache.get(identityKey) === agent) direct = true;
  }
  return { exists: true, ready: direct, ...base };
}

// Claude stores per-folder transcripts at ~/.claude/projects/<encoded-cwd>/<id>.jsonl
// Encoding: EVERY non-alphanumeric char becomes '-' (so '/', '_', '.', spaces all
// collapse to '-'). Verified against real ~/.claude/projects names.
function getProjectDir(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(process.env.HOME, '.claude', 'projects', encoded);
}

// Parse the folder's JSONL transcripts into a resume list (most recent first).
// Only a head and a tail chunk of each transcript is read: the head holds the
// first user message (the default title), the tail holds the newest /rename,
// and the file mtime stands in for last activity. Whole-file line-by-line
// reads froze the resume overlay once a folder accumulated large transcripts.
// (Renames buried in the untouched middle of a huge transcript are missed.)
const SESSION_LIST_HEAD_BYTES = 128 * 1024;
const SESSION_LIST_TAIL_BYTES = 64 * 1024;

function readFileChunk(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, position);
    return buf.toString('utf8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionFromTranscriptLines(lines) {
  let name = null, firstUserMsg = null;
  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.content && obj.content.includes('/rename')) {
        const m = obj.content.match(/<command-args>(.*?)<\/command-args>/);
        if (m) name = m[1];
      }
      if (!firstUserMsg && obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content;
        if (typeof content === 'string' && !content.includes('<command-') && content.length > 5) {
          firstUserMsg = content.substring(0, 80);
        }
      }
    } catch { /* skip malformed or chunk-truncated line */ }
  }
  return { name, firstUserMsg };
}

async function listSessions(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    const id = file.replace('.jsonl', '');
    const full = path.join(projectDir, file);
    let name = null, firstUserMsg = null, lastTs = null;
    try {
      const stat = fs.statSync(full);
      lastTs = stat.mtime.toISOString();
      let lines;
      if (stat.size <= SESSION_LIST_HEAD_BYTES + SESSION_LIST_TAIL_BYTES) {
        lines = fs.readFileSync(full, 'utf8').split('\n');
      } else {
        const head = readFileChunk(full, 0, SESSION_LIST_HEAD_BYTES);
        const tail = readFileChunk(full, stat.size - SESSION_LIST_TAIL_BYTES, SESSION_LIST_TAIL_BYTES);
        lines = head.slice(0, head.lastIndexOf('\n')).split('\n')
          .concat(tail.slice(tail.indexOf('\n') + 1).split('\n'));
      }
      ({ name, firstUserMsg } = sessionFromTranscriptLines(lines));
    } catch { /* skip unreadable file */ }
    sessions.push({ id, name: name || firstUserMsg || id, lastTs });
  }
  sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  return sessions;
}

// opencode owns its session index (a local database), and the supported way to
// read it is asking the CLI: `opencode session list --format json`. Run in the
// workspace so the answer is that project's sessions. Every field is read
// defensively across plausible names — opencode ships fast, and a schema change
// must degrade to "no list offered", never to a broken overlay or a throw.
async function listOpencodeSessions(cwd) {
  if (!cwd) return [];
  const result = await runFile(
    AGENTS.opencode.command, ['session', 'list', '--format', 'json', '-n', '40'], cwd, 15000
  );
  if (!result.ok) return [];
  let parsed;
  try { parsed = JSON.parse(result.out); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed
    : (Array.isArray(parsed?.sessions) ? parsed.sessions : []);
  const pick = (...values) => values.find((v) => v != null && v !== '');
  const stamp = (value) => {
    if (typeof value === 'number' && isFinite(value)) {
      // Seconds or milliseconds, both seen in the wild.
      return new Date(value > 1e12 ? value : value * 1000).toISOString();
    }
    if (typeof value === 'string') {
      const parsedTs = Date.parse(value);
      if (!isNaN(parsedTs)) return new Date(parsedTs).toISOString();
    }
    return null;
  };
  const sessions = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = pick(row.id, row.sessionID, row.sessionId, row.session_id);
    if (!id) continue;
    // Only offer sessions rooted in THIS workspace. The session's `directory`
    // is what opencode uses as its working root once resumed, so a foreign
    // row would bind the agent to another folder. The list is cwd-scoped
    // today, but never trust the CLI to keep filtering for us — a row
    // without a directory field is left in (older schemas), one with a
    // different directory is dropped.
    const dir = pick(row.directory, row.cwd) || '';
    if (dir && normalizedPath(dir) !== normalizedPath(cwd)) continue;
    const name = pick(row.title, row.summary, row.description, row.name) || String(id);
    const lastTs = stamp(pick(
      row.time?.updated, row.updated, row.updatedAt, row.modified,
      row.time?.created, row.created, row.createdAt
    ));
    sessions.push({ id: String(id), name: String(name).slice(0, 80), lastTs });
  }
  sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  return sessions;
}

// Hermes keeps sessions in SQLite and prints a fixed-width table (no JSON):
//   Title  Workspace  Last Active  ID
//   ─────────────────────────────────────────────
//   Fix login bug   my-project   2h ago       20260812_090310_348b8f
// Column boundaries come from the header line, so titles containing spaces are
// safe; anything unparseable degrades to "no list offered", never a throw.
async function listHermesSessions(cwd) {
  if (!cwd) return [];
  const result = await runFile('hermes', ['sessions', 'list', '--workspace', cwd, '--limit', '40'], cwd, 15000);
  if (!result.ok || !result.out) return [];
  const lines = result.out.split('\n');
  const header = lines.find((l) => /\bTitle\b/.test(l) && /\bWorkspace\b/.test(l) && /\bID\b/.test(l));
  if (!header) return [];
  const ws = header.indexOf('Workspace');
  const la = header.indexOf('Last Active');
  const idc = header.indexOf('ID');
  if (ws < 0 || la < 0 || idc < 0) return [];
  const toTs = (rel) => {
    const text = (rel || '').trim();
    if (!text) return null;
    if (text === 'just now') return new Date().toISOString();
    const match = /^(\d+)\s*(s|m|h|d|w)\s+ago$/.exec(text);
    if (!match) return null;
    const units = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };
    return new Date(Date.now() - Number(match[1]) * (units[match[2]] || 0)).toISOString();
  };
  const sessions = [];
  for (const line of lines) {
    if (line === header || !line.trim() || /^[─\-=]+$/.test(line.trim())) continue;
    const id = line.slice(idc).trim();
    if (!id) continue;
    const title = line.slice(0, ws).trim();
    sessions.push({ id, name: title || id, lastTs: toTs(line.slice(la, idc).trim()) });
  }
  sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  return sessions;
}

// pi keeps readable per-directory JSONL transcripts, so its resume list is read
// straight off disk like Claude's. Layout and encoding verified in the CLI's
// own core/session-manager.js:
//   <agent dir>/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl
// where <cwd> is the absolute path with its leading separator stripped and
// every '/', '\' and ':' replaced by '-'.
function piSessionDir(cwd) {
  const encoded = `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(piAgentDir(), 'sessions', encoded);
}

// First line is the {type:"session"} header (id, timestamp, cwd); a later
// {type:"session_info"} carries the latest /name, and the first user message is
// the fallback title.
function piSessionFromLines(lines) {
  let name = null;
  let firstUserMsg = null;
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; } // chunk-truncated line
    if (obj.type === 'session_info') {
      name = String(obj.name || '').trim() || null;
      continue;
    }
    if (firstUserMsg || obj.type !== 'message') continue;
    const message = obj.message;
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    const text = Array.isArray(content)
      ? content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ')
      : (typeof content === 'string' ? content : '');
    if (text.trim().length > 5) firstUserMsg = text.trim().slice(0, 80);
  }
  return { name, firstUserMsg };
}

async function listPiSessions(cwd) {
  if (!cwd) return [];
  const dir = piSessionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const wanted = normalizedPath(cwd);
  const files = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try { files.push([fs.statSync(full).mtimeMs, full]); } catch { /* raced */ }
    }
  } catch { return []; }
  files.sort((a, b) => b[0] - a[0]);
  const sessions = [];
  for (const [mtime, full] of files.slice(0, 40)) {
    try {
      const stat = fs.statSync(full);
      let lines;
      if (stat.size <= SESSION_LIST_HEAD_BYTES + SESSION_LIST_TAIL_BYTES) {
        lines = fs.readFileSync(full, 'utf8').split('\n');
      } else {
        const head = readFileChunk(full, 0, SESSION_LIST_HEAD_BYTES);
        const tail = readFileChunk(full, stat.size - SESSION_LIST_TAIL_BYTES, SESSION_LIST_TAIL_BYTES);
        lines = head.slice(0, head.lastIndexOf('\n')).split('\n')
          .concat(tail.slice(tail.indexOf('\n') + 1).split('\n'));
      }
      const header = JSON.parse(lines[0]);
      if (header?.type !== 'session' || !header.id) continue;
      // Belt and braces on top of the already per-directory listing: a resumed
      // pi session adopts the cwd recorded in its own header (verified in the
      // CLI's main.js), so a transcript recorded elsewhere must never be
      // offered — resuming it would move the agent out of this project.
      if (header.cwd && normalizedPath(header.cwd) !== wanted) continue;
      const { name, firstUserMsg } = piSessionFromLines(lines.slice(1));
      sessions.push({
        id: String(header.id),
        name: name || firstUserMsg || String(header.id),
        lastTs: new Date(mtime).toISOString(),
        // Host-side only (pushSessions forwards id/name/lastTs); the delete
        // path needs the transcript it came from.
        file: full,
      });
    } catch { /* skip unreadable or malformed transcript */ }
  }
  return sessions;
}

// ---- per-project Hermes profiles --------------------------------------------
// Every workspace runs Hermes in its own profile (~/.hermes/profiles/<slug>):
// separate config, memory, skills, cron, plugins and session DB, so two open
// projects never leak knowledge into each other. Profile routing is HERMES_HOME
// pointing at the profile dir (verified in hermes_cli/config.py — HERMES_PROFILE
// alone is only a kanban author label); HERMES_PROFILE is set too, so kanban
// items authored inside the pane are attributed to the project.
const HERMES_RESERVED_SLUGS = new Set(['hermes', 'test', 'tmp', 'root', 'sudo']);
function hermesProfileSlug(cwd) {
  const base = String(cwd ? path.basename(cwd) : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  let slug = base || 'workspace';
  if (!/^[a-z0-9]/.test(slug)) slug = `p-${slug}`;
  if (HERMES_RESERVED_SLUGS.has(slug)) slug = `${slug}-ws`;
  return slug;
}

function hermesProfileHome(slug) {
  const root = process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes');
  return path.join(root, 'profiles', slug);
}

// Create the profile on first launch for a slug (cloning config, .env, SOUL.md
// and skills from the active profile); reuse it afterwards. Never touches the
// sticky default — no `hermes profile use`. Failure degrades to running the
// session on the default profile rather than blocking the launch.
async function ensureHermesProfile(slug) {
  if (!slug) return false;
  const home = hermesProfileHome(slug);
  if (fs.existsSync(path.join(home, 'config.yaml'))) return true;
  const created = await runFile('hermes', ['profile', 'create', slug, '--clone'], workspaceFolder(), 30000);
  return created.ok || fs.existsSync(path.join(home, 'config.yaml'));
}

// Env prefix for the launch command line: empty for every agent except hermes,
// which gets HERMES_HOME=<profile dir> HERMES_PROFILE=<slug>.
async function launchEnvPrefix(agent) {
  if (agent !== 'hermes') return '';
  const cwd = workspaceFolder();
  if (!cwd) return '';
  const slug = hermesProfileSlug(cwd);
  if (!(await ensureHermesProfile(slug))) return '';
  return `HERMES_HOME=${shellQuote(hermesProfileHome(slug))} HERMES_PROFILE=${slug} `;
}

// Codex rollouts live at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; the
// first line's session_meta carries the conversation id and cwd. Best-effort
// and version-tolerant: only the first lines of each candidate are read.
async function listCodexSessions(cwd) {
  const root = path.join(process.env.HOME || '', '.codex', 'sessions');
  if (!cwd || !fs.existsSync(root)) return [];
  const wanted = normalizedPath(cwd);
  const files = [];
  try {
    for (const y of fs.readdirSync(root).sort().reverse().slice(0, 2)) {
      const yDir = path.join(root, y);
      for (const mo of fs.readdirSync(yDir).sort().reverse().slice(0, 3)) {
        const mDir = path.join(yDir, mo);
        for (const d of fs.readdirSync(mDir).sort().reverse().slice(0, 12)) {
          const dDir = path.join(mDir, d);
          for (const f of fs.readdirSync(dDir)) {
            if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
            const full = path.join(dDir, f);
            try { files.push([fs.statSync(full).mtimeMs, full]); } catch { /* raced */ }
          }
        }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b[0] - a[0]);
  const sessions = [];
  for (const [mtime, full] of files.slice(0, 120)) {
    if (sessions.length >= 30) break;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(16384);
      const len = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf8', 0, len).split('\n');
      const meta = JSON.parse(lines[0]);
      const payload = meta?.payload || meta || {};
      const id = payload.id || payload.session_id || null;
      const sessionCwd = payload.cwd || '';
      if (!id || !sessionCwd || normalizedPath(sessionCwd) !== wanted) continue;
      let name = null;
      for (const line of lines.slice(1)) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const p = obj.payload || {};
          const text = typeof p.message === 'string' ? p.message : (typeof p.text === 'string' ? p.text : null);
          if ((p.type === 'user_message' || obj.type === 'user_message') && text && text.length > 5) {
            name = text.slice(0, 80);
            break;
          }
        } catch { /* partial line at buffer end */ }
      }
      // `file` stays host-side (pushSessions only forwards id/name/lastTs); the
      // delete path needs the rollout it came from.
      sessions.push({ id, name: name || id, lastTs: new Date(mtime).toISOString(), file: full });
    } catch { /* skip unreadable */ }
  }
  return sessions;
}

// ---- transcript telemetry ------------------------------------------------------
// Ground-truth session stats the pane can never show, tailed incrementally
// (offset reads only) from the CLIs' own JSONL transcripts. Pure fs work on the
// extension host: zero tmux processes, nothing on the live refresh path.
// Transcript formats are not a stable API — every parse is guarded and the
// whole feature degrades to hiding its chips.
class TranscriptTail {
  constructor(agent) {
    this.agent = agent;
    this.file = null;
    this.offset = 0;
    this.carry = '';
    this.stats = null;
    this._busy = false;
    this._scanAt = 0;
    this._cwdMismatch = new Set();
  }

  reset() {
    this.file = null;
    this.offset = 0;
    this.carry = '';
    this.stats = null;
  }

  async poll(cwd) {
    if (this._busy || !cwd) return this.stats;
    this._busy = true;
    try {
      const now = Date.now();
      if (!this.file || now - this._scanAt > 5000) {
        this._scanAt = now;
        // Agents without readable local transcripts (e.g. Antigravity, whose
        // conversations live in a database) simply report no telemetry.
        const newest = this.agent === 'claude' ? await this.newestClaude(cwd)
          : this.agent === 'codex' ? await this.newestCodex(cwd)
            : null;
        if (newest !== this.file) {
          this.reset();
          this.file = newest;
          if (this.file) {
            try {
              const size = (await fs.promises.stat(this.file)).size;
              if (size > 2 * 1024 * 1024) {
                this.offset = size - 512 * 1024;
                this.carry = null; // skip the first partial line; stats become approximate
              }
            } catch { /* file removed */ }
          }
        }
      }
      if (this.file) await this.readAppended();
    } catch { /* best-effort */ }
    finally { this._busy = false; }
    return this.stats;
  }

  async newestClaude(cwd) {
    const dir = getProjectDir(cwd);
    try {
      const entries = await fs.promises.readdir(dir);
      let best = null;
      let bestM = 0;
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        try {
          const m = (await fs.promises.stat(full)).mtimeMs;
          if (m > bestM) { bestM = m; best = full; }
        } catch { /* removed mid-scan */ }
      }
      return best;
    } catch { return null; }
  }

  async newestCodex(cwd) {
    const root = path.join(process.env.HOME || '', '.codex', 'sessions');
    const dayDirs = [];
    try {
      const years = (await fs.promises.readdir(root)).sort().reverse().slice(0, 1);
      for (const y of years) {
        const yDir = path.join(root, y);
        const months = (await fs.promises.readdir(yDir)).sort().reverse().slice(0, 2);
        for (const mo of months) {
          const mDir = path.join(yDir, mo);
          const days = (await fs.promises.readdir(mDir)).sort().reverse().slice(0, 3);
          for (const d of days) {
            dayDirs.push(path.join(mDir, d));
            if (dayDirs.length >= 3) break;
          }
          if (dayDirs.length >= 3) break;
        }
      }
    } catch { return null; }
    const candidates = [];
    for (const dir of dayDirs) {
      try {
        const files = await fs.promises.readdir(dir);
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const full = path.join(dir, f);
          try {
            const m = (await fs.promises.stat(full)).mtimeMs;
            candidates.push([m, full]);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const wanted = normalizedPath(cwd);
    for (const [, full] of candidates.slice(0, 10)) {
      if (this._cwdMismatch.has(full)) continue;
      try {
        const handle = await fs.promises.open(full, 'r');
        try {
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await handle.read(buf, 0, 4096, 0);
          const first = buf.toString('utf8', 0, bytesRead).split('\n')[0];
          const meta = JSON.parse(first);
          const sessionCwd = meta?.payload?.cwd || meta?.cwd || '';
          if (sessionCwd && normalizedPath(sessionCwd) === wanted) return full;
          this._cwdMismatch.add(full);
        } finally {
          await handle.close();
        }
      } catch { this._cwdMismatch.add(full); }
    }
    return null;
  }

  async readAppended() {
    try {
      const stat = await fs.promises.stat(this.file);
      if (stat.size < this.offset) { this.offset = 0; this.carry = ''; this.stats = null; }
      if (stat.size === this.offset) return;
      const handle = await fs.promises.open(this.file, 'r');
      try {
        const len = Math.min(stat.size - this.offset, 1024 * 1024);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, this.offset);
        this.offset += bytesRead;
        let text = buf.toString('utf8', 0, bytesRead);
        if (this.carry === null) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1) : '';
          this.carry = '';
          (this.stats || (this.stats = this.newStats())).approx = true;
        }
        text = this.carry + text;
        const lines = text.split('\n');
        this.carry = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try { this.ingest(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      } finally {
        await handle.close();
      }
    } catch { /* file removed or read error */ }
  }

  newStats() {
    return { model: '', inTokens: 0, outTokens: 0, cacheTokens: 0, turns: 0, lastTool: '', turnStartedAt: 0, approx: false };
  }

  ingest(obj) {
    const s = this.stats || (this.stats = this.newStats());
    if (this.agent === 'claude') {
      if (obj.type === 'user' && !obj.isMeta) {
        s.turns++;
        s.turnStartedAt = Date.parse(obj.timestamp) || Date.now();
      }
      const msg = obj.message;
      if (obj.type === 'assistant' && msg) {
        if (msg.model) s.model = msg.model;
        const u = msg.usage;
        if (u) {
          s.outTokens += u.output_tokens || 0;
          s.inTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          s.cacheTokens = u.cache_read_input_tokens || 0;
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block && block.type === 'tool_use' && block.name) s.lastTool = block.name;
          }
        }
      }
      return;
    }
    const payload = obj.payload || {};
    const kind = payload.type || obj.type || '';
    if (kind === 'user_message') {
      s.turns++;
      s.turnStartedAt = Date.parse(obj.timestamp) || Date.now();
    } else if (kind === 'token_count') {
      const u = payload.info?.total_token_usage || payload.total_token_usage || payload.usage;
      if (u) {
        s.inTokens = u.input_tokens || 0;
        s.outTokens = u.output_tokens || 0;
        s.cacheTokens = u.cached_input_tokens || u.cache_read_input_tokens || 0;
      }
    } else if (kind === 'session_meta') {
      const model = payload.payload?.model || payload.model;
      if (model) s.model = String(model);
    }
  }
}

// ---- workspace event ledger --------------------------------------------------
// Append-only JSONL under .claude/agentmux/: session lifecycle, turns, discarded
// input and every handoff transition. It powers the Timeline overlay and lets a
// delivered handoff survive an extension-host restart (rehydrated as
// manual-accept only — never resent). Writes are serialized and fire-and-forget
// so a slow disk can never block the tick or input paths.
class EventLog {
  constructor() {
    this._queue = Promise.resolve();
    this._appends = 0;
  }

  dir() {
    const cwd = workspaceFolder();
    return cwd ? path.join(cwd, '.claude', 'agentmux') : null;
  }

  file() {
    const dir = this.dir();
    return dir ? path.join(dir, 'ledger.jsonl') : null;
  }

  ensureDir() {
    const dir = this.dir();
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    return dir;
  }

  append(event) {
    if (cfg().get('eventLog') === false) return;
    const file = this.file();
    if (!file) return;
    this._queue = this._queue.then(async () => {
      this.ensureDir();
      await fs.promises.appendFile(file, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
      if (++this._appends % 50 === 0) await this.prune(file);
    }).catch(() => {});
  }

  async prune(file) {
    const stat = await fs.promises.stat(file);
    if (stat.size < 512 * 1024) return;
    const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
    if (lines.length > 200) await fs.promises.writeFile(file, lines.slice(-200).join('\n') + '\n');
  }

  async tail(limit = 100) {
    const file = this.file();
    if (!file) return [];
    try {
      await this._queue;
      const raw = await fs.promises.readFile(file, 'utf8');
      const events = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return events.slice(-limit);
    } catch {
      return [];
    }
  }

  async clear() {
    const file = this.file();
    if (!file) return;
    try { await fs.promises.writeFile(file, ''); } catch { /* nothing to clear */ }
  }
}

// ---- the side-bar view -----------------------------------------------------

const HEX_BYTE_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

class ClaudeTmuxView {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.timer = null;
    this.presenceTimer = null;
    this.cols = 80;
    this.rows = 24;
    const savedAgent = context.workspaceState.get('claudeTmux.activeAgent');
    this.activeAgent = AGENTS[savedAgent] ? savedAgent : 'claude';
    const savedWriter = context.workspaceState.get('claudeTmux.pairWriter');
    this.writerAgent = AGENTS[savedWriter] ? savedWriter : null;
    this.agentState = byAgent(() => this.newAgentState());
    this.inputQueues = byAgent(() => this.newInputQueue());
    this.sessionCache = byAgent(() => null);
    this.unseen = 0;   // changes seen while the view was hidden (badge count)
    this._lastHiddenTickAt = 0;
    this._tickRunning = false;
    this._tickQueued = false;
    this._tickForce = false;
    this._loopGeneration = 0;
    this._lastInputAt = 0;        // adaptive cadence: run hot while typing…
    this._lastFrameChangeAt = 0;  // …or while output is actively changing
    this._eventSourceLive = false; // a push source (control mode / pipe tap) drives ticks
    this._eventTickTimer = null;
    this._subscribed = { agent: null, name: null };
    this.pipeTap = new PipeTap();
    this.eventLog = new EventLog();
    this.tails = byAgent((agent) => new TranscriptTail(agent));
    this._statusItem = null;
    this.arbiter = null;
    this.lastCompletedHandoff = null;
    this.focusHistory = [];   // most recently focused agents first, for the toggle
    this._presenceRunning = false;
    this._presenceHiddenSkips = 0;
    this._resizeRunning = false;
    this._resizeQueued = false;
    this._resizePromise = Promise.resolve();
    this.handoff = null;
    this._ipcServer = null;
    this._ipcSocketPath = null;
    this._statusListeners = [];
    this._stallTimers = {};
    this.initIpcServer();
  }

  newAgentState() {
    return {
      lastFrame: null,
      sessionsSent: false,
      present: false,
      status: 'idle',
      statusSince: Date.now(),
      lastActivity: 0,
      lastChange: 0,
      historyMode: false,
      historyPending: false,
      historySize: 0,
      lastLiveFrame: null,
      lastFrameLines: null,
      frameSeq: 0,
      lastMeta: '',
      lastName: '',
      backgroundPollAt: 0,
      attention: null,
      stalled: false,
      lastPromptTime: 0,
      paneTitle: '',           // what the TUI wrote there (Claude: the conversation summary)
      paneMode: '',            // tmux mode the pane sits in ('copy-mode'): keys are swallowed until it ends
      detectionHold: false,    // a viewer/picker is covering the pane: freeze the status
      promptLine: '',          // reconstructed prompt for Alt+Up recall (null = bailed)
    };
  }

  initIpcServer() {
    if (this._ipcServer) return;
    const sockPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\agentmux-${process.pid}`
      : path.join(os.tmpdir(), `agentmux-${process.pid}.sock`);

    try {
      if (process.platform !== 'win32' && fs.existsSync(sockPath)) {
        fs.unlinkSync(sockPath);
      }
    } catch { /* best effort */ }

    const server = net.createServer((socket) => {
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line);
            this.handleIpcRequest(req, socket);
          } catch (err) {
            socket.write(JSON.stringify({ ok: false, error: 'invalid_json', message: String(err.message) }) + '\n');
          }
        }
      });
      socket.on('error', () => { /* client disconnected */ });
    });

    server.on('error', () => { /* socket error */ });

    server.listen(sockPath, () => {
      server.unref();
      this._ipcSocketPath = sockPath;
      this.writeWorkspaceSocketPointer(sockPath);
    });

    this._ipcServer = server;
  }

  writeWorkspaceSocketPointer(sockPath) {
    try {
      const folder = workspaceFolder();
      if (!folder) return;
      const agentmuxDir = path.join(folder, '.claude', 'agentmux');
      fs.mkdirSync(agentmuxDir, { recursive: true });
      fs.writeFileSync(path.join(agentmuxDir, 'agentmux.sock'), sockPath, 'utf8');
    } catch { /* best effort */ }
  }

  closeIpcServer() {
    if (this._ipcServer) {
      try { this._ipcServer.close(); } catch {}
      this._ipcServer = null;
    }
    if (this._ipcSocketPath && process.platform !== 'win32') {
      try {
        if (fs.existsSync(this._ipcSocketPath)) fs.unlinkSync(this._ipcSocketPath);
      } catch {}
      this._ipcSocketPath = null;
    }
    try {
      const folder = workspaceFolder();
      if (folder) {
        const p = path.join(folder, '.claude', 'agentmux', 'agentmux.sock');
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch { /* best effort */ }
  }

  async handleIpcRequest(req, socket) {
    const action = req && req.action;
    switch (action) {
      case 'list': {
        const present = Object.keys(AGENTS).filter((a) => this.agentState[a]?.present);
        const agents = present.map((a) => ({
          id: a,
          label: AGENTS[a].label,
          status: this.agentState[a].status,
          attention: this.agentState[a].attention || null,
          lastTool: this.agentState[a].lastTool || '',
          turns: this.agentState[a].telemetry?.turns || 0,
          model: this.agentState[a].telemetry?.model || '',
        }));
        socket.write(JSON.stringify({ ok: true, agents }) + '\n');
        break;
      }

      case 'status': {
        const agent = req.agent || this.activeAgent;
        const state = this.agentState[agent];
        if (!state || !state.present) {
          socket.write(JSON.stringify({ ok: false, error: 'agent_not_found', agent }) + '\n');
          return;
        }
        socket.write(JSON.stringify({
          ok: true,
          agent,
          label: AGENTS[agent].label,
          status: state.status,
          statusSince: state.statusSince,
          attention: state.attention || null,
          lastTool: state.lastTool || '',
          title: state.paneTitle || '',
          telemetry: state.telemetry || null,
          delta: state.lastTurnDelta || null,
        }) + '\n');
        break;
      }

      case 'read': {
        const agent = req.agent || this.activeAgent;
        const state = this.agentState[agent];
        if (!state || !state.present) {
          socket.write(JSON.stringify({ ok: false, error: 'agent_not_found', agent }) + '\n');
          return;
        }
        const frame = state.lastFrame || state.backgroundFrame || '';
        const lines = stripAnsi(frame).split('\n');
        const count = Math.max(1, Math.min(500, parseInt(req.lines, 10) || 50));
        socket.write(JSON.stringify({ ok: true, agent, lines: lines.slice(-count) }) + '\n');
        break;
      }

      case 'prompt': {
        const agent = req.agent || this.activeAgent;
        const state = this.agentState[agent];
        if (!state || !state.present) {
          socket.write(JSON.stringify({ ok: false, error: 'agent_not_found', agent }) + '\n');
          return;
        }
        if (state.status === 'needs-input' && req.protectDialog !== false) {
          socket.write(JSON.stringify({
            ok: false,
            error: 'agent_blocked',
            message: `${AGENTS[agent].label} is awaiting input on a question/permission dialog. Complete or cancel the dialog first.`
          }) + '\n');
          return;
        }
        const text = String(req.text || '');
        if (!text.trim()) {
          socket.write(JSON.stringify({ ok: false, error: 'empty_prompt' }) + '\n');
          return;
        }
        await this.queueInput(agent, text + (req.raw ? '' : '\r'), true, false);

        if (!req.wait) {
          socket.write(JSON.stringify({ ok: true, agent, sent: true }) + '\n');
          return;
        }

        const targetStatus = req.until || 'done';
        const timeoutMs = Math.max(1000, Math.min(300000, parseInt(req.timeout, 10) || 60000));
        const start = Date.now();
        let resolved = false;

        const cleanup = () => {
          resolved = true;
          clearTimeout(timer);
          const idx = (this._statusListeners || []).indexOf(onStatus);
          if (idx >= 0) this._statusListeners.splice(idx, 1);
        };

        const timer = setTimeout(() => {
          if (resolved) return;
          cleanup();
          socket.write(JSON.stringify({
            ok: false,
            error: 'timeout',
            agent,
            status: state.status,
            durationMs: Date.now() - start
          }) + '\n');
        }, timeoutMs);

        const onStatus = ({ agent: a, status }) => {
          if (resolved || a !== agent) return;
          if (status === targetStatus || (targetStatus === 'done' && status === 'idle')) {
            cleanup();
            const frame = state.lastFrame || state.backgroundFrame || '';
            const lines = stripAnsi(frame).split('\n').slice(-30);
            socket.write(JSON.stringify({
              ok: true,
              agent,
              status,
              output: lines.join('\n'),
              durationMs: Date.now() - start
            }) + '\n');
          }
        };

        this._statusListeners = this._statusListeners || [];
        this._statusListeners.push(onStatus);
        break;
      }

      default:
        socket.write(JSON.stringify({ ok: false, error: 'unknown_action', action }) + '\n');
    }
  }

  armStallWatchdog(agent) {
    if (this._stallTimers?.[agent]) clearTimeout(this._stallTimers[agent]);
    this._stallTimers = this._stallTimers || {};
    const startFrame = this.agentState[agent]?.lastFrame;
    this._stallTimers[agent] = setTimeout(() => {
      const state = this.agentState[agent];
      if (state && state.present && state.status === 'idle') {
        const currentFrame = state.lastFrame;
        if (currentFrame === startFrame) {
          state.stalled = true;
          this.eventLog.append({ type: 'stall', agent, reason: 'No transition to working within 5s' });
          if (this.view) this.view.webview.postMessage({ type: 'agentStalled', agent });
        }
      }
    }, 5000);
  }

  newInputQueue() {
    return { data: '', cwd: null, paste: false, timer: null, chain: Promise.resolve(), inFlight: false, suspended: false };
  }

  // Forget the last delivered frame so the next tick sends a FULL frame — the
  // webview's line cache is only valid against an unbroken delta chain.
  resetLiveFrame(agent) {
    const state = this.agentState[agent];
    state.lastLiveFrame = null;
    state.lastFrameLines = null;
  }

  cachedSessionEntry(agent, cwd) {
    const entry = this.sessionCache[agent];
    if (entry && entry.cwd === cwd && Date.now() - entry.ts < SESSION_CACHE_TTL_MS) return entry;
    return null;
  }

  cachedReadySession(agent, cwd) {
    const entry = this.cachedSessionEntry(agent, cwd);
    return entry && entry.ready ? entry.name : null;
  }

  rememberSession(agent, cwd, name, ready) {
    this.sessionCache[agent] = { name, cwd, ready, ts: Date.now() };
  }

  invalidateSessionCache(agent) {
    if (agent) this.sessionCache[agent] = null;
    else this.sessionCache = byAgent(() => null);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible) { this.clearBadge(); this.tick(true); }
    });
    view.onDidDispose(() => { this.stopLoops(); this.view = null; });

    this.startLoop();
    this.startPresenceLoop();
    this.maybeAutoResume();
    this.runPreflight();
    this.rehydrateHandoff();
    this.sweepChannel();
  }

  clearBadge() {
    this.unseen = 0;
    if (this.view) this.view.badge = undefined;
    const state = this.agentState[this.activeAgent];
    if (state?.attention) {
      state.attention = null;
      this.postAgents();
    }
  }

  postAgents() {
    if (!this.view) return;
    const agents = {};
    for (const agent of Object.keys(AGENTS)) {
      const state = this.agentState[agent];
      agents[agent] = {
        present: state.present,
        status: state.status,
        statusSince: state.statusSince,
        attention: state.attention,
        telemetry: state.telemetry || null,
        delta: state.lastTurnDelta || null,
        lastTool: state.lastTool || '',
        // Claude Code writes its conversation summary into the pane title;
        // free for us to show, since presence already reads it every poll.
        title: state.paneTitle || '',
      };
    }
    this.view.webview.postMessage({
      type: 'agents',
      agents,
      activeAgent: this.activeAgent,
      writerAgent: this.writerAgent,
      handoffPhase: this.handoff?.phase || null,
      hasWorkspace: !!workspaceFolder(),
      handBack: !!(this.lastCompletedHandoff && !this.handoff
        && this.agentState[this.lastCompletedHandoff.source].present
        && this.agentState[this.lastCompletedHandoff.target].present),
      arbiterPhase: this.arbiter?.phase || null,
    });
    this.updateStatusBar();
  }

  // One consolidated status bar item: the active agent's live state, every
  // present agent in the tooltip, a warning tint when any agent waits for
  // input, click to cycle focus. Updated only from this choke point (no extra
  // timers, no extra tmux processes).
  updateStatusBar() {
    if (typeof vscode.window.createStatusBarItem !== 'function') return; // test host
    if (!this._statusItem) {
      this._statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 62);
      this._statusItem.name = 'AgentMux';
      this._statusItem.command = 'claudeTmux.statusBarCycle';
      this.context.subscriptions.push(this._statusItem);
    }
    const present = Object.keys(AGENTS).filter((agent) => this.agentState[agent]?.present);
    if (cfg().get('statusBarItems') === false || !present.length) {
      this._statusItem.hide();
      return;
    }
    const active = present.includes(this.activeAgent) ? this.activeAgent : present[0];
    const state = this.agentState[active];
    const icons = { working: '$(sync~spin)', done: '$(check)', 'needs-input': '$(report)', idle: '$(terminal)' };
    const elapsed = state.status === 'working' ? ' ' + fmtDurationShort(Date.now() - state.statusSince) : '';
    this._statusItem.text = `${icons[state.status] || icons.idle} ${AGENTS[active].label}${elapsed}`;
    const asking = present.filter((agent) => this.agentState[agent].status === 'needs-input');
    this._statusItem.backgroundColor = asking.length
      ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const tel = (agent) => {
      const t = this.agentState[agent]?.telemetry;
      return t ? ` ↑${fmtTokens(t.inTokens)} ↓${fmtTokens(t.outTokens)} · turn ${t.turns}${t.model ? ` · ${t.model}` : ''}` : '';
    };
    const lines = present.map((agent) => {
      const s = this.agentState[agent];
      return `${agent === active ? '▶ ' : ''}${AGENTS[agent].label}: ${s.status}${s.lastTool ? ` (${s.lastTool})` : ''}${tel(agent)}`;
    });
    if (asking.length) lines.push(`${asking.length} agent(s) waiting for input`);
    lines.push('State is partly heuristic. Click to cycle focus.');
    this._statusItem.tooltip = lines.join('\n');
    this._statusItem.show();
  }

  postTimeline() {
    if (!this.view) return;
    this.eventLog.tail(100).then((events) => {
      if (this.view) this.view.webview.postMessage({ type: 'timeline', events });
    });
  }

  setAgentStatus(agent, status) {
    const state = this.agentState[agent];
    if (state.status === status) return false;
    const previous = state.status;
    const heldFor = Date.now() - state.statusSince;
    state.status = status;
    state.statusSince = Date.now();
    if (status === 'working') {
      state.attention = null;
      state.stalled = false;
      if (this._stallTimers?.[agent]) {
        clearTimeout(this._stallTimers[agent]);
        delete this._stallTimers[agent];
      }
    }
    if (['done', 'needs-input'].includes(status) && (agent !== this.activeAgent || !this.view?.visible)) {
      state.attention = status;
    }
    // Turn-edge side effects (all fire-and-forget, none touch the live path):
    if (status === 'working' && ['idle', 'done'].includes(previous)) {
      this.snapshotGitBase(agent);
    }
    if (['done', 'needs-input'].includes(status) && previous === 'working') {
      this.computeGitDelta(agent).then(() => {
        this.eventLog.append({
          type: 'turn', agent, status, durationMs: heldFor,
          tool: state.lastTool || undefined, delta: state.lastTurnDelta || undefined,
        });
      });
    }
    if (status === 'needs-input') this.maybeNotifyPrompt(agent);
    if (status === 'done' && previous === 'working' && (agent !== this.activeAgent || !this.view?.visible)) {
      this.maybeNotifyDone(agent);
    }
    if (this._statusListeners?.length) {
      for (const fn of this._statusListeners.slice()) {
        try { fn({ agent, status, previous }); } catch {}
      }
    }
    this.postAgents();
    this.updateBadge();
    return true;
  }

  maybeNotifyDone(agent) {
    if (cfg().get('notifyDone') === false) return;
    const label = AGENTS[agent]?.label || agent;
    vscode.window.showInformationMessage(
      `${label} finished working in the background.`,
      `Switch to ${label}`
    ).then((choice) => {
      if (choice) {
        vscode.commands.executeCommand('claudeTmux.view.focus');
        this.switchAgent(agent);
      }
    });
  }

  // ---- richer view badge -----------------------------------------------------
  updateBadge() {
    if (!this.view) return;
    if (this.view.visible) return;
    const flagged = Object.keys(AGENTS).filter((a) => this.agentState[a].attention);
    const value = flagged.length || this.unseen;
    if (!value) { this.view.badge = undefined; return; }
    const tooltip = flagged.length
      ? flagged.map((a) => `${AGENTS[a].label}: ${this.agentState[a].attention === 'needs-input' ? 'needs input' : 'finished'}`).join(' · ')
      : `${AGENTS[this.activeAgent].label}: new activity`;
    this.view.badge = { value, tooltip };
  }

  // ---- per-turn git delta ------------------------------------------------------
  // Snapshot on idle/done -> working, diff on working -> done/needs-input; a few
  // git processes per TURN, zero on the refresh path. Attribution is
  // approximate (anything that changed during the turn is counted).
  async gitNumstat(cwd) {
    const [numstat, status] = await Promise.all([
      runFile('git', ['diff', '--numstat', 'HEAD'], cwd),
      runFile('git', ['status', '--porcelain'], cwd),
    ]);
    if (!numstat.ok && !status.ok) return null;
    const files = new Map();
    if (numstat.ok && numstat.out.length < 1024 * 1024) {
      for (const line of numstat.out.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (m) files.set(m[3], [(m[1] === '-' ? 0 : +m[1]), (m[2] === '-' ? 0 : +m[2])]);
      }
    }
    if (status.ok) {
      for (const line of status.out.split('\n')) {
        if (line.startsWith('??')) files.set(line.slice(3).trim(), files.get(line.slice(3).trim()) || [0, 0]);
      }
    }
    return files;
  }

  async snapshotGitBase(agent) {
    try {
      const cwd = workspaceFolder();
      if (!cwd) return;
      const state = this.agentState[agent];
      if (state.gitBaseAt && Date.now() - state.gitBaseAt < 3000) return;
      state.gitBaseAt = Date.now();
      state.gitBase = await this.gitNumstat(cwd);
    } catch { /* not a git repo or git unavailable */ }
  }

  async computeGitDelta(agent) {
    try {
      const cwd = workspaceFolder();
      const state = this.agentState[agent];
      if (!cwd || !state.gitBase) return;
      const now = await this.gitNumstat(cwd);
      if (!now) return;
      const base = state.gitBase;
      let files = 0, insertions = 0, deletions = 0;
      const names = [];
      for (const [file, [ins, del]] of now) {
        const [bIns, bDel] = base.get(file) || [0, 0];
        if (ins !== bIns || del !== bDel || !base.has(file)) {
          files++;
          insertions += Math.max(0, ins - bIns);
          deletions += Math.max(0, del - bDel);
          if (names.length < 10) names.push(file);
        }
      }
      const hadDelta = !!state.lastTurnDelta;
      state.lastTurnDelta = files ? { files, insertions, deletions, names, at: Date.now() } : null;
      if (state.lastTurnDelta || hadDelta) this.postAgents();
    } catch { /* best-effort */ }
  }

  // ---- actionable permission prompts -------------------------------------------
  // On the edge into needs-input (when the user isn't watching that pane),
  // parse the question and its numbered options from the frame we already have
  // and raise a native notification whose buttons answer through the normal
  // input pump — identity-pinned like the handoff ACK, never automatic.
  async maybeNotifyPrompt(agent) {
    try {
      if (cfg().get('notifyPrompts') === false) return;
      const state = this.agentState[agent];
      if (agent === this.activeAgent && this.view?.visible) return;
      if (state.lastPromptNotify && Date.now() - state.lastPromptNotify < 30000) return;
      state.lastPromptNotify = Date.now();
      const frame = agent === this.activeAgent ? state.lastFrame : (state.backgroundFrame || state.lastFrame);
      if (!frame) return;
      const lines = stripAnsi(frame).split('\n').slice(-15).map((l) => l.trim());
      const options = [];
      let question = '';
      for (const line of lines) {
        const m = line.match(/^(?:[❯>]\s*)?([1-9])[.)]\s+(.{1,60})/);
        if (m) options.push({ digit: m[1], label: m[2].trim() });
        else if (line && !options.length) question = line;
      }
      const cwd = normalizedPath(workspaceFolder());
      const pinnedName = this.sessionCache[agent]?.name || '';
      const pinned = pinnedName ? await agentSessionInfo(agent, pinnedName) : null;
      const label = AGENTS[agent].label;
      const buttons = options.length >= 2 ? options.slice(0, 3).map((o) => `${o.digit}: ${o.label.slice(0, 25)}`) : [];
      const choice = await vscode.window.showWarningMessage(
        `${label} is asking: ${question || 'input required'}`, ...buttons, 'Open'
      );
      if (!choice) return;
      if (choice === 'Open') {
        vscode.commands.executeCommand('claudeTmux.view.focus');
        this.switchAgent(agent);
        return;
      }
      const digit = choice.split(':')[0];
      // Re-verify the exact pane identity and that the question is still open.
      const info = pinnedName ? await agentSessionInfo(agent, pinnedName) : null;
      if (!info?.ready || !pinned
        || info.created !== pinned.created || info.generation !== pinned.generation
        || this.agentState[agent].status !== 'needs-input') {
        vscode.window.showInformationMessage(`${label}'s prompt changed; answer it in the sidebar.`);
        return;
      }
      this.queueInput(agent, digit, true, true);
    } catch { /* notification is best-effort */ }
  }

  // Hook-reported state is authoritative for edges; the frame-diff heuristic
  // keeps handling decay (done -> idle) and acts as the fallback when hooks
  // are disabled or the agent version has no hook support.
  applyHookState(agent, hookState, hookTool) {
    const state = this.agentState[agent];
    state.lastTool = hookTool || '';
    if (hookState === 'working') {
      state.lastActivity = Date.now();
      this.setAgentStatus(agent, 'working');
    } else if (hookState === 'needs-input') {
      this.setAgentStatus(agent, 'needs-input');
    } else if (hookState === 'done' && ['working', 'needs-input'].includes(state.status)) {
      this.setAgentStatus(agent, 'done');
    }
  }

  // The pane title is read for every agent on every presence poll, whether the
  // view is visible or not and whether that pane's frame is being captured or
  // not, so a TUI that states its status there is seen in places the frame
  // diff never reaches. Hook reports still outrank it: this only runs when no
  // hook spoke for the pane.
  applyTitleState(agent) {
    const state = this.agentState[agent];
    if (!state.paneTitle) return;
    const detected = detectState(agent, detectionContext('', state.paneTitle));
    if (!detected.status) return;
    state.lastDetection = detected;
    if (detected.status === 'hold') { state.detectionHold = true; return; }
    state.detectionHold = false;
    if (detected.status === 'needs-input') {
      this.setAgentStatus(agent, 'needs-input');
      return;
    }
    if (detected.status === 'working') {
      state.lastActivity = Date.now();
      this.setAgentStatus(agent, 'working');
    }
  }

  updateActivity(agent, frame, changed) {
    const state = this.agentState[agent];
    const now = Date.now();
    if (changed) {
      const detected = detectState(agent, detectionContext(frame, state.paneTitle));
      state.lastDetection = detected; // surfaced by the Explain command
      // A viewer or picker is covering the pane: this frame describes the
      // chrome, not the agent. Freeze — and keep freezing once the user stops
      // scrolling, or the decay below would walk a working agent down to idle
      // behind an open transcript.
      if (detected.status === 'hold') {
        state.detectionHold = true;
        state.lastChange = now;
        return;
      }
      state.detectionHold = false;
      if (detected.status === 'needs-input') {
        this.setAgentStatus(agent, 'needs-input');
        return;
      }
      state.lastChange = now;
      if (detected.status === 'working') {
        state.lastActivity = now;
        this.setAgentStatus(agent, 'working');
        return;
      }
      if (state.status === 'working') {
        state.lastActivity = now;
      }
      return;
    }
    if (state.detectionHold) return; // frozen until the covering UI goes away
    if (state.status === 'working' && now - state.lastActivity > 4000) {
      this.setAgentStatus(agent, 'done');
    } else if (state.status === 'done' && now - state.statusSince > 3500) {
      this.setAgentStatus(agent, 'idle');
    }
  }

  startPresenceLoop() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => this.pollPresence(false), 900);
  }

  async pollPresence(force) {
    if (this._presenceRunning || !this.view) return;
    if (!force && !this.view.visible) {
      this._presenceHiddenSkips = (this._presenceHiddenSkips + 1) % 3;
      if (this._presenceHiddenSkips !== 0) return;
    } else {
      this._presenceHiddenSkips = 0;
    }
    this._presenceRunning = true;
    let changed = false;
    try {
      if (!workspaceFolder()) {
        for (const state of Object.values(this.agentState)) state.present = false;
        this.postAgents();
        return;
      }
      const cwd = normalizedPath(workspaceFolder());
      const agentList = Object.keys(AGENTS);
      const sessionInfos = await Promise.all(agentList.map(async (agent) => {
        const cached = this.sessionCache[agent];
        const name = cached?.cwd === cwd ? cached.name : await sessionName(agent);
        const info = await agentSessionInfo(agent, name);
        return { agent, name, info };
      }));
      for (const { agent, name, info } of sessionInfos) {
        const state = this.agentState[agent];
        // The server was too slow to answer: keep everything as it was and let
        // the next pass re-verify. Marking the session absent here is what used
        // to flash "no session" overlays and drop tabs under multi-window load.
        if (info.transient) continue;
        this.rememberSession(agent, cwd, name, info.ready);
        const present = info.ready;
        // The pane title came free with the presence read. Hosts that never set
        // one leave it at the machine name, which is noise, not a summary.
        const paneTitle = present && info.title && info.title !== os.hostname() ? info.title.slice(0, 120) : '';
        if (paneTitle !== state.paneTitle) { state.paneTitle = paneTitle; changed = true; }
        const paneMode = present ? (info.paneMode || '') : '';
        if (paneMode !== state.paneMode) { state.paneMode = paneMode; changed = true; }
        if (present && info.hookState && cfg().get('stateHooks') !== false) {
          this.applyHookState(agent, info.hookState, info.hookTool);
        } else if (present) {
          this.applyTitleState(agent);
        }
        if (present && cfg().get('telemetry') !== false) {
          const stats = await this.tails[agent].poll(cwd);
          state.telemetry = stats;
          const sig = stats ? `${stats.turns}|${stats.inTokens}|${stats.outTokens}|${stats.lastTool}|${stats.model}` : '';
          if (sig !== state._telemetrySig) { state._telemetrySig = sig; changed = true; }
        }
        if (state.present !== present) {
          const stopped = state.present && !present;
          state.present = present;
          state.lastFrame = null;
          this.resetLiveFrame(agent);
          state.historyMode = false;
          state.historyPending = false;
          changed = true;
          if (!present) this.setAgentStatus(agent, 'idle');
          if (stopped) {
            this.eventLog.append({ type: 'session', agent, action: 'stopped' });
            vscode.window.showInformationMessage(`${AGENTS[agent].label} stopped in this workspace.`, 'Start again')
              .then((choice) => { if (choice === 'Start again') this.startSession(agent); });
          } else if (present) {
            this.eventLog.append({ type: 'session', agent, action: 'detected' });
          }
        }
        const now = Date.now();
        const backgroundDue = state.status === 'working' || now - state.backgroundPollAt >= 1800;
        if (this.view.visible && present && agent !== this.activeAgent && backgroundDue) {
          state.backgroundPollAt = now;
          const tail = await tmux([
            'capture-pane', '-p', '-e', '-t', tmuxPaneTarget(name),
            ';', 'display-message', '-p', '-t', tmuxPaneTarget(name), META_SENTINEL + META_FORMAT,
          ]);
          if (tail.ok) {
            const { frame: bgFrame, meta: bgMeta } = splitFusedCapture(tail.out);
            const frameChanged = bgFrame !== state.backgroundFrame;
            state.backgroundFrame = bgFrame;
            this.updateActivity(agent, bgFrame, frameChanged);
            // This capture is already paid for — ship it, with its cursor meta,
            // to the webview's tab cache so switching paints an at-most-
            // seconds-old frame with a correctly placed cursor instantly.
            state.lastFrame = bgFrame;
            if (bgMeta != null) state.lastMeta = bgMeta;
            if (frameChanged && this.view?.visible) {
              this.view.webview.postMessage({ type: 'bgFrame', agent, frame: bgFrame, meta: bgMeta });
            }
          }
        }
      }

      if (this.writerAgent && !this.agentState[this.writerAgent].present) {
        this.writerAgent = null;
        this.context.workspaceState.update('claudeTmux.pairWriter', undefined);
        changed = true;
      }

      if (this.lastCompletedHandoff) {
        const { source, target } = this.lastCompletedHandoff;
        if (!this.agentState[source].present || !this.agentState[target].present) {
          this.lastCompletedHandoff = null;
          changed = true;
        }
      }

      if (!this.agentState[this.activeAgent].present) {
        const fallback = Object.keys(AGENTS).find((agent) => this.agentState[agent].present);
        if (fallback) {
          this.activeAgent = fallback;
          this.context.workspaceState.update('claudeTmux.activeAgent', fallback);
          this.postActiveAgent();
          changed = true;
        }
      }
      if (force || changed) this.postAgents();
      if (changed && this.agentState[this.activeAgent].present) this.tick(true);
      await this.ensureEventSources();
    } finally {
      this._presenceRunning = false;
    }
  }

  // ---- push-driven refresh (control-mode subscriptions or pipe tap) ---------

  onControlNotification(line) {
    if (!line.startsWith('%subscription-changed ')) return;
    const name = line.split(' ')[1] || '';
    if (!name.startsWith('agentmux-')) return;
    const agent = name.slice('agentmux-'.length);
    if (AGENTS[agent]) this.onPaneEvent(agent);
  }

  onPaneEvent(agent) {
    if (agent === this.activeAgent) {
      if (this._eventTickTimer) return;
      this._eventTickTimer = setTimeout(() => {
        this._eventTickTimer = null;
        this.tick(false);
      }, 16); // coalesce notification bursts into one capture
    } else {
      this.agentState[agent].backgroundPollAt = 0; // capture on the next presence pass
    }
  }

  // Watch the ACTIVE agent's pane via a control-mode format subscription.
  // Subscriptions are scoped to the client's attached session, so the client
  // rides along on the active session; the background agent stays covered by
  // the presence loop's existing capture cadence.
  async syncSubscriptions() {
    const agent = this.activeAgent;
    const state = this.agentState[agent];
    const name = this.sessionCache[agent]?.name || null;
    const key = state.present && name ? name : null;
    if (this._subscribed.agent === agent && this._subscribed.name === key) return !!key;
    if (this._subscribed.agent) {
      await controlClient.exec(['refresh-client', '-B', `agentmux-${this._subscribed.agent}`]);
    }
    this._subscribed = { agent: null, name: null };
    if (!key) {
      await controlClient.attachTo(null);
      return false;
    }
    if (!await controlClient.attachTo(key)) return false;
    const pane = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(key), '#{pane_id}']);
    const paneId = pane.ok ? pane.out.trim() : '';
    if (!paneId.startsWith('%')) return false;
    const sub = await controlClient.exec([
      'refresh-client', '-B',
      `agentmux-${agent}:${paneId}:#{history_size},#{cursor_x},#{cursor_y},#{pane_width},#{pane_height}`,
    ]);
    if (!sub.ok) return false;
    this._subscribed = { agent, name: key };
    return true;
  }

  // Pick the best available push source for the current transport setting;
  // polling silently remains the watchdog (and the whole story on 'poll').
  async ensureEventSources() {
    const mode = transportMode();
    let live = false;
    if (['auto', 'control'].includes(mode) && controlClient.usable()) {
      controlClient.notificationHandler = (line) => this.onControlNotification(line);
      live = await this.syncSubscriptions();
    } else if (this._subscribed.name) {
      this._subscribed = { agent: null, name: null };
    }
    if (!live && ['auto', 'pipe'].includes(mode)) {
      const agent = this.activeAgent;
      const name = this.sessionCache[agent]?.name || null;
      if (this.agentState[agent].present && name && this.view?.visible) {
        this.pipeTap.onEvent = (a) => this.onPaneEvent(a);
        live = await this.pipeTap.arm(agent, name);
      } else if (this.pipeTap.live()) {
        await this.pipeTap.disarm();
      }
    } else if (this.pipeTap.live()) {
      await this.pipeTap.disarm();
    }
    this._eventSourceLive = live;
  }

  // Optionally resume the folder's most recent conversation on open.
  async maybeAutoResume() {
    if (this.activeAgent !== 'claude' || !cfg().get('autoResume')) return;
    const cwd = workspaceFolder();
    if (!cwd) return;
    const s = await sessionName('claude');
    const has = await tmux(['has-session', '-t', tmuxSessionTarget(s)]);
    if (has.ok) return; // already running
    const list = await listSessions(getProjectDir(cwd));
    if (list.length) await this.startResumed(list[0].id);
  }

  onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.postActiveAgent();
        this.postAgents();
        this.postHandoffState();
        this.pollPresence(true);
        return this.tick(true);
      case 'switchAgent': return this.switchAgent(m.agent);
      case 'input':   return this.queueInput(m.agent, m.data, !!m.immediate);
      case 'resize':  return this.setSize(m.cols, m.rows);
      case 'start':   return this.startSession(m.agent);
      case 'attach':  return this.attachExisting(m.agent);
      case 'addTmuxSession':   return this.addTmuxSession();
      case 'removeCustomAgent': return this.removeCustomAgent();
      case 'resume':  return this.startResumed(m.id, m.agent);
      case 'refresh': this.agentState[this.activeAgent].sessionsSent = false; return this.tick(true);
      case 'resync':  this.resetLiveFrame(this.activeAgent); return this.tick(true);
      case 'paste':   return this.queueInput(m.agent, m.data, true);
      case 'historyMode': return this.setHistoryMode(m.agent, m.enabled);
      case 'openFile': return this.openFileFromMirror(m);
      case 'promptHistory': return this.postPromptHistory();
      case 'preflightRecheck': return this.runPreflight(true);
      case 'timeline': return this.postTimeline();
      case 'timelineClear': return this.eventLog.clear().then(() => this.postTimeline());
      case 'prepareHandoff': return this.prepareHandoff(m.source);
      case 'createHandoff': return this.createHandoff(m);
      case 'confirmHandoff': return this.confirmHandoff(m);
      case 'updateHandoffDetails': return this.updateHandoffDetails(m);
      case 'updateHandoffDraft': return this.updateHandoffDraft(m);
      case 'acceptHandoff': return this.acceptHandoff(m.id);
      case 'cancelHandoff': return this.cancelHandoff(m.id);
      case 'cancelPair': return this.cancelPairMode();
      case 'requestFindings': return this.requestFindings();
      case 'prepareArbiter': return this.prepareArbiter();
      case 'createArbiter': return this.createArbiter(m);
      case 'arbiterPick': return this.arbiterPick(m);
      case 'arbiterCancel': return this.cancelArbiter(m.id);
      case 'deleteSession': return this.deleteConversation(m.agent, m.id);
    }
  }

  postActiveAgent() {
    if (!this.view) return;
    const state = this.agentState[this.activeAgent];
    this.view.webview.postMessage({
      type: 'activeAgent',
      agent: this.activeAgent,
      label: AGENTS[this.activeAgent].label,
      cachedFrame: state.lastFrame,
      cachedMeta: state.lastMeta,
      cachedName: state.lastName,
      historyMode: state.historyMode,
    });
  }

  switchAgent(agent) {
    if (!AGENTS[agent] || !this.agentState[agent].present || agent === this.activeAgent) return;
    this.focusHistory = [this.activeAgent, ...this.focusHistory.filter((a) => a !== this.activeAgent)].slice(0, 8);
    this.activeAgent = agent;
    const state = this.agentState[agent];
    state.attention = null;
    state.historyMode = false;
    state.historyPending = false;
    this.resetLiveFrame(agent);
    this.context.workspaceState.update('claudeTmux.activeAgent', agent);
    this.clearBadge();
    this.postActiveAgent();
    this.postAgents();
    this.maybeAutoResume();
    this.setSize(this.cols, this.rows);
    this.ensureEventSources();
  }

  // Push the folder's past conversations to the webview list (once per
  // disconnected state, to avoid re-reading JSONL every tick).
  async pushSessions(agent = this.activeAgent) {
    if (!this.view) return;
    const cwd = workspaceFolder();
    if (!cwd) return;
    const spec = AGENTS[agent];
    const list = spec?.listSessions ? await spec.listSessions(cwd) : [];
    this.view.webview.postMessage({
      type: 'sessions',
      agent,
      folder: cwd,
      list: list.map((s) => ({ id: s.id, name: s.name, lastTs: s.lastTs })),
      canResumeLatest: !!spec?.resumeLatest,
      canList: !!spec?.listSessions,
    });
  }

  // Create (or replace) the folder's tmux session resuming one conversation.
  async startResumed(id, agent = 'claude') {
    const spec = AGENTS[agent];
    if (!id || !spec?.resumeById || spec.attachSession) return;
    if (agent === 'codex') await this.warnCodexRuleConflict();
    await this.replaceSession(agent, spec.resumeById(id, launchArgs(agent), workspaceFolder()), 'Resume');
  }

  queueInput(agent, data, immediate = false, system = false) {
    if (!AGENTS[agent] || !data) return Promise.resolve();
    const queue = this.inputQueues[agent];
    if (!system && this.handoff && ['drafting', 'delivering', 'awaitingAck', 'ackTimeout'].includes(this.handoff.phase)) {
      if (this.view) this.view.webview.postMessage({ type: 'inputSuspended', agent, reason: 'handoff' });
      return Promise.resolve(false);
    }
    if (!system && this.arbiter && ['delivering', 'gathering'].includes(this.arbiter.phase)) {
      if (this.view) this.view.webview.postMessage({ type: 'inputSuspended', agent, reason: 'arbiter' });
      return Promise.resolve(false);
    }
    if (queue.suspended && !system) {
      if (this.view) this.view.webview.postMessage({ type: 'inputSuspended', agent });
      return Promise.resolve(false);
    }
    if (!system && this.writerAgent && agent !== this.writerAgent) {
      if (this.view) this.view.webview.postMessage({ type: 'inputLocked', agent, writerAgent: this.writerAgent });
      return Promise.resolve(false);
    }
    const cwd = normalizedPath(workspaceFolder());
    if (!cwd) return Promise.resolve(false);
    if (!system) {
      this._lastInputAt = Date.now();
      this.recordPromptInput(agent, data);
    }
    if (queue.data && queue.cwd !== cwd) {
      if (queue.timer) clearTimeout(queue.timer);
      // Workspace switched with keystrokes still debounced in the queue: the
      // bytes belong to the old session and can never be delivered to the new
      // one — say so instead of dropping silently.
      const droppedBytes = Buffer.byteLength(queue.data, 'utf8');
      queue.data = '';
      queue.paste = false;
      queue.timer = null;
      if (!system && droppedBytes > 0) this.reportInputIssue(agent, { reason: 'workspace', failedBytes: droppedBytes });
    }
    queue.cwd = cwd;
    queue.data += data;
    queue.paste = queue.paste || (immediate && (data.length > 256 || data.includes('\n')));
    if (data.includes('\r')) {
      const state = this.agentState[agent];
      state.lastActivity = Date.now();
      this.setAgentStatus(agent, 'working');
      this.armStallWatchdog(agent);
    }
    if (queue.timer) clearTimeout(queue.timer);
    if (immediate || queue.data.length >= 2048) return this.flushInput(agent);
    queue.timer = setTimeout(() => this.flushInput(agent), 12);
    return queue.chain;
  }

  // ---- prompt recall ---------------------------------------------------------
  // Reconstruct submitted prompt lines from the keystroke stream. O(1) string
  // work per event; any escape sequence or bulk paste bails the current line
  // (storing a wrong guess is worse than storing nothing).
  recordPromptInput(agent, data) {
    if (cfg().get('promptHistory') === false) return;
    const state = this.agentState[agent];
    if (data.includes('\x1b') || data.length > 200) {
      state.promptLine = null;
      return;
    }
    let line = state.promptLine;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r' || ch === '\n') {
        if (line != null) this.commitPrompt(line);
        line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (line != null) line = line.slice(0, -1);
      } else if (ch >= ' ') {
        if (line != null && line.length < 2000) line += ch;
      } else {
        line = null; // other control byte: the TUI is editing, stop guessing
      }
    }
    state.promptLine = line;
  }

  commitPrompt(line) {
    const trimmed = line.trim();
    if (trimmed.length < 3) return;
    const key = 'claudeTmux.promptHistory';
    const history = this.context.workspaceState.get(key) || [];
    if (history[history.length - 1] === trimmed) return;
    history.push(trimmed);
    if (history.length > 50) history.splice(0, history.length - 50);
    this.context.workspaceState.update(key, history);
  }

  postPromptHistory() {
    if (!this.view) return;
    const history = this.context.workspaceState.get('claudeTmux.promptHistory') || [];
    this.view.webview.postMessage({ type: 'promptHistory', list: history.slice().reverse() });
  }

  clearPromptHistory() {
    this.context.workspaceState.update('claudeTmux.promptHistory', []);
    vscode.window.showInformationMessage('AgentMux prompt history cleared for this workspace.');
  }

  // ---- clickable paths -------------------------------------------------------
  async openFileFromMirror(message) {
    const cwd = workspaceFolder();
    if (!cwd || typeof message.path !== 'string' || !message.path || message.path.length > 1024) return;
    const raw = message.path.replace(/^\.\//, '');
    let target = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
    let exists = false;
    try { exists = (await fs.promises.stat(target)).isFile(); } catch { exists = false; }
    if (!exists) {
      const base = path.basename(raw);
      const found = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 2);
      if (found.length !== 1) return; // missing or ambiguous: do nothing rather than guess
      target = found[0].fsPath;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const line = Math.min(Math.max(0, (parseInt(message.line, 10) || 1) - 1), doc.lineCount - 1);
      const col = Math.max(0, (parseInt(message.col, 10) || 1) - 1);
      const pos = new vscode.Position(line, col);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch { /* binary or unreadable file: ignore */ }
  }

  // ---- explain state -----------------------------------------------------------
  // Most of an agent's status is inferred, so when the dot is wrong the user
  // needs to see WHICH signal won: the hook, a screen rule, or decay.
  async explainState(agent = this.activeAgent) {
    const spec = AGENTS[agent];
    if (!spec) return;
    const state = this.agentState[agent];
    const cwd = normalizedPath(workspaceFolder());
    const name = this.cachedReadySession(agent, cwd) || await sessionName(agent);
    const info = await agentSessionInfo(agent, name);
    const hooksOn = cfg().get('stateHooks') !== false;
    const rules = detectionRules(agent);
    const lines = [
      `${spec.label} (${agent}) — ${new Date().toLocaleTimeString()}`,
      `  tmux session   : ${name}${info.exists ? '' : '  (not found for this workspace)'}`
        + (spec.attachSession ? '  [free mode: mirrored, not managed]' : ''),
      `  pane command   : ${info.command || '(none)'}`,
      `  pane title     : ${info.title || '(none)'}`,
      `  ready          : ${info.ready}`,
      `  pane identity  : ${paneIdentity(info)}  (created:generation:pane pid:tmux server pid)`,
      `  status shown   : ${state.status} (for ${fmtDurationShort(Date.now() - state.statusSince)})`,
      '',
      `  hook state     : ${info.hookState || '(none reported)'}${hooksOn ? '' : '  [stateHooks disabled]'}`,
      `  hook tool      : ${info.hookTool || '(none)'}`,
      `  hook session id: ${info.hookSessionId || '(none)'}`,
      `  authority      : ${hooksOn && info.hookState ? 'hook (authoritative)' : 'screen rules + decay (fallback)'}`,
      '',
      `  last rule hit  : ${state.lastDetection?.status
        ? `${state.lastDetection.status}  <-  [${state.lastDetection.region}] /${state.lastDetection.pattern}/`
        : '(no rule matched the last changed frame)'}`,
      `  frozen         : ${state.detectionHold ? 'yes — a hold rule matched (viewer/picker covering the pane)' : 'no'}`,
      '',
      ...explainLines(agent, detectionContext(state.lastFrame || '', state.paneTitle)),
      `  override these : claudeTmux.detectionRules -> "${agent}"`,
      '',
      `  last frame chg : ${state.lastChange ? fmtDurationShort(Date.now() - state.lastChange) + ' ago' : '(never)'}`,
      `  last activity  : ${state.lastActivity ? fmtDurationShort(Date.now() - state.lastActivity) + ' ago' : '(never)'}`,
      `  telemetry      : ${state.telemetry ? `${state.telemetry.turns} turns, model ${state.telemetry.model || '?'}` : '(none — this CLI has no readable transcript)'}`,
      `  transport      : ${transportMode()}${this._eventSourceLive ? ' (push source live)' : ' (polling)'}`,
    ];
    this.output().appendLine(lines.join('\n'));
    this.output().appendLine('');
    this.output().show(true);
  }

  // Explain a screen captured to a FILE instead of the live pane. A rule that
  // misfires is usually gone by the time anyone looks, so the useful loop is:
  //   tmux capture-pane -p -t =<session>: > screen.txt
  // and then run this against it. It reads no tmux state at all, so it works
  // for a screen captured on another machine, pasted into a bug report, or
  // committed as a fixture — which is exactly what test/screens holds.
  async explainScreen(args) {
    let agent = typeof args?.agent === 'string' ? args.agent : null;
    let file = typeof args?.file === 'string' ? args.file : null;
    const title = typeof args?.title === 'string' ? args.title : '';
    if (!agent) {
      const picked = await vscode.window.showQuickPick(
        AGENT_IDS.map((id) => ({ label: AGENTS[id].label, description: id, id })),
        { title: 'Explain a captured screen', placeHolder: 'Whose rules should be run against it?' }
      );
      if (!picked) return null;
      agent = picked.id;
    }
    if (!AGENTS[agent]) {
      vscode.window.showErrorMessage(`AgentMux: no agent "${agent}".`);
      return null;
    }
    if (!file) {
      const chosen = await vscode.window.showOpenDialog({
        title: 'Screen captured with: tmux capture-pane -p -t =<session>: > screen.txt',
        canSelectMany: false,
        openLabel: 'Explain',
      });
      if (!chosen?.length) return null;
      file = chosen[0].fsPath;
    }
    let frame;
    try {
      frame = fs.readFileSync(file, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`AgentMux: cannot read ${file} — ${err.message}`);
      return null;
    }
    const ctx = detectionContext(frame, title);
    const { winner } = explainDetection(agent, ctx);
    this.output().appendLine([
      `${AGENTS[agent].label} (${agent}) — ${file}`,
      `  pane title     : ${title || '(none supplied — pass { title } to include one)'}`,
      '',
      ...explainLines(agent, ctx),
    ].join('\n'));
    this.output().appendLine('');
    this.output().show(true);
    return {
      agent,
      file,
      status: winner ? winner.state : null,
      region: winner ? winner.region : null,
      priority: winner ? winner.priority : 0,
      pattern: winner ? winner.source : null,
    };
  }

  output() {
    if (!this._output) {
      this._output = vscode.window.createOutputChannel('AgentMux');
      this.context.subscriptions.push(this._output);
    }
    return this._output;
  }

  // ---- preflight -------------------------------------------------------------
  // One-shot environment check (never on the live path): are tmux and every
  // registered agent CLI actually reachable from a login shell on this
  // (possibly remote) host?
  async runPreflight(force = false) {
    if (!this._preflight || force) {
      const shell = process.env.SHELL || '/bin/sh';
      // One probe line per agent, keyed by index so agent ids stay out of the
      // shell string entirely. A free-mode agent that only mirrors an existing
      // session has no CLI to look for, and a custom command that is not a
      // plain program name is not built into a shell line at all — both simply
      // count as available.
      const probeable = (agent) => /^[A-Za-z0-9._/+-]+$/.test(AGENTS[agent].command || '');
      const probe = AGENT_IDS
        .map((agent, i) => (probeable(agent) ? `echo "${i}:$(command -v ${AGENTS[agent].command})"` : ''))
        .filter(Boolean)
        .join('; ');
      const [tmuxVersion, tools] = await Promise.all([
        runFile('tmux', ['-V']),
        runFile(shell, ['-lc', probe], undefined, 8000),
      ]);
      const seen = (out) => {
        const lines = (out || '').split('\n');
        return (prefix) => lines.some((l) => l.startsWith(prefix) && l.slice(prefix.length).trim());
      };
      let found = seen(tools.out);
      const agents = byAgent((agent) => (!probeable(agent) || found(`${AGENT_IDS.indexOf(agent)}:`)));
      // Installers commonly export PATH from ~/.bashrc, which a NON-interactive
      // login shell skips outright — while the interactive shell tmux starts
      // runs it in full. Without this re-probe an agent that launches perfectly
      // in the pane is reported "not on PATH". Interactive only as a fallback:
      // it is the slower, noisier shell, so the fast path stays the common one.
      if (AGENT_IDS.some((agent) => !agents[agent])) {
        const interactive = await runFile(shell, ['-lic', probe], undefined, 8000);
        found = seen(interactive.out);
        for (const agent of AGENT_IDS) {
          if (!agents[agent] && found(`${AGENT_IDS.indexOf(agent)}:`)) agents[agent] = true;
        }
      }
      this._preflight = {
        tmux: tmuxVersion.ok ? tmuxVersion.out.trim() : null,
        agents,
      };
    }
    if (this.view) this.view.webview.postMessage({ type: 'preflight', ...this._preflight });
  }

  flushInput(agent) {
    const queue = this.inputQueues[agent];
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (!queue.data || queue.inFlight) return queue.chain;
    // No external watchdog mutating inFlight/data here: every tmux call below
    // is time-bounded (tmuxExecFile timeout / control-client watchdog), so this
    // block always settles. A timer clearing flags from the outside would race
    // with a late-resolving send and let two flushes interleave on one pane.
    queue.inFlight = true;
    queue.chain = (async () => {
      while (queue.data) {
        const data = queue.data;
        const cwd = queue.cwd;
        const paste = queue.paste;
        queue.data = '';
        queue.cwd = null;
        queue.paste = false;
        const result = await this.sendInputData(agent, data, cwd, paste);
        if (!result.ok) {
          // A timeout or a dead transport means delivery is UNKNOWN, and
          // unknown is not "not delivered": the tmux client hands its command
          // to the server the moment it connects, so a server that answers
          // late still runs the send-keys after the client was killed.
          // Replaying the bytes would then type them twice — and a replayed
          // Enter submits whatever sits in the agent's prompt. So failed input
          // is reported with its reason and never re-sent (see the transport
          // rules at the top of this file); the user retypes what the hint
          // says was lost.
          const pendingBytes = Buffer.byteLength(queue.data, 'utf8');
          queue.data = '';
          queue.cwd = null;
          queue.paste = false;
          this.reportInputIssue(agent, {
            reason: result.reason || 'tmux',
            failedBytes: Buffer.byteLength(result.unsent || data, 'utf8'), pendingBytes,
          });
          return false;
        }
        this.noteInputSuccess(agent);
      }
      return true;
    })().finally(() => { queue.inFlight = false; });
    return queue.chain;
  }

  // Failed input is reported three ways — the hint line, the ledger (Timeline)
  // and the Output channel — with the reason ('timeout', 'transport',
  // 'no-session', 'workspace', 'tmux') so a bug report says which branch failed.
  reportInputIssue(agent, { reason, failedBytes = 0, pendingBytes = 0 }) {
    const state = this.agentState[agent];
    state.inputErrorCount = (state.inputErrorCount || 0) + 1;
    const count = state.inputErrorCount;
    if (this.view) this.view.webview.postMessage({
      type: 'inputError', agent, reason, failedBytes, pendingBytes, pendingDiscarded: pendingBytes > 0,
    });
    this.eventLog.append({ type: 'input-discarded', agent, reason, failedBytes, pendingBytes });
    // Throttled so a sustained outage logs the first failure and then one line in ten.
    if (count === 1 || count % 10 === 0) {
      const label = AGENTS[agent]?.label || agent;
      this.output().appendLine(
        `[${new Date().toLocaleTimeString()}] AgentMux: input to ${label} not delivered (${reason}): `
        + `${failedBytes} bytes discarded${pendingBytes ? `, ${pendingBytes} pending discarded` : ''} (#${count}).`
      );
    }
  }

  noteInputSuccess(agent) {
    const state = this.agentState[agent];
    if (state) state.inputErrorCount = 0;
  }

  // Text queued for a pane that no longer exists must never fire into whatever
  // reuses the session name next: drop it when the pane is destroyed.
  dropQueuedInput(agent) {
    const queue = this.inputQueues[agent];
    if (!queue) return;
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    queue.data = '';
    queue.cwd = null;
    queue.paste = false;
  }

  // Delivery result: { ok, transient, reason, unsent }. transient means "the
  // bytes may or may not have reached the pane" (timeout, dead transport);
  // unsent is the suffix that was definitely never handed to tmux, for the
  // report. Nothing is ever replayed either way (see flushInput).
  async sendInputData(agent, data, cwd = normalizedPath(workspaceFolder()), paste = false) {
    if (!cwd || normalizedPath(workspaceFolder()) !== cwd) return { ok: false, reason: 'workspace' };
    // Hot path: reuse the session identity the presence loop verified moments
    // ago, so a keystroke flush costs one tmux process instead of four. When
    // the cache is cold, a recent presence-verified name is re-verified with a
    // single probe (cheaper than the full disambiguation) but never trusted
    // blindly — a pane recycled under the same name by another project must
    // never receive these keystrokes.
    let s = this.cachedReadySession(agent, cwd);
    if (!s) {
      const lastName = this.agentState[agent]?.present ? this.agentState[agent]?.lastName : null;
      if (lastName) {
        const verify = await agentSessionInfo(agent, lastName);
        if (verify.transient) return { ok: false, transient: true, reason: 'timeout', unsent: data };
        if (verify.ready) {
          s = lastName;
          this.rememberSession(agent, cwd, s, true);
        }
      }
      if (!s) {
        s = await sessionName(agent);
        const info = await agentSessionInfo(agent, s);
        if (info.transient) return { ok: false, transient: true, reason: 'timeout', unsent: data };
        if (!s || !info.ready) {
          this.invalidateSessionCache(agent);
          return { ok: false, reason: 'no-session' };
        }
        this.rememberSession(agent, cwd, s, true);
      }
    }
    const left = await this.leavePaneMode(agent, s);
    if (!left.ok) return { ok: false, transient: true, reason: 'timeout', unsent: data };
    const fail = (reason, unsent, invalidate = true) => {
      if (invalidate) this.invalidateSessionCache(agent);
      const transient = reason === 'timeout' || reason === 'transport';
      return { ok: false, transient, reason, unsent: transient ? unsent : undefined };
    };
    const classify = (result) => {
      if (result.ok) return null;
      if (result.timedOut || result.transportFailed) return 'timeout';
      return 'tmux';
    };
    const bytes = Buffer.from(data, 'utf8');
    if (paste && !data.includes('\0')) {
      const bufferName = `claude-tmux-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const loaded = await tmuxInput(['set-buffer', '-b', bufferName, '--', data]);
      const loadedErr = classify(loaded);
      if (loadedErr) return fail(loadedErr === 'timeout' ? 'timeout' : 'tmux', data);
      const pasted = await tmuxInput(['paste-buffer', '-dpr', '-b', bufferName, '-t', tmuxPaneTarget(s)]);
      const pastedErr = classify(pasted);
      if (pastedErr) {
        await tmuxInput(['delete-buffer', '-b', bufferName]);
        return fail(pastedErr === 'timeout' ? 'timeout' : 'tmux', data);
      }
      this.tick(false);
      return { ok: true };
    }
    let sentBytes = 0;
    for (let start = 0; start < bytes.length; start += 1024) {
      const chunk = bytes.subarray(start, start + 1024);
      const hex = new Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) hex[i] = HEX_BYTE_TABLE[chunk[i]];
      const sent = await tmuxInput(['send-keys', '-t', tmuxPaneTarget(s), '-H', ...hex]);
      const err = classify(sent);
      if (err) {
        sentBytes = start;
        // Backtrack to a UTF-8 boundary so the preserved suffix decodes
        // cleanly (the sent prefix may end mid-character; that one char can
        // render oddly in the pane, which beats losing the whole suffix).
        while (sentBytes > 0 && (bytes[sentBytes] & 0xC0) === 0x80) sentBytes--;
        return fail(err === 'timeout' ? 'timeout' : 'tmux', bytes.subarray(sentBytes).toString('utf8'));
      }
    }
    this.tick(false);
    return { ok: true };
  }

  // copy-mode (and its view-mode twin) eats every key send-keys delivers —
  // typing "hello" scrolls and selects instead of reaching the agent, and
  // capture-pane never shows it. The presence probe reports the mode; when it
  // does, cancel it before the keys go in. Only these modes take -X commands,
  // and a stale flag costs one harmless "not in a mode" reply; anything else
  // (clock, tree) ends on its own with the first key.
  // Runs only while a mode is reported, so the ordinary keystroke path stays
  // one tmux command. Returns { ok }: a hard "not in a mode" error still means
  // "proceed" (best effort), while a timeout means "unknown" and the caller
  // must preserve the keys instead of typing into a possibly-modal pane.
  async leavePaneMode(agent, name) {
    const state = this.agentState[agent];
    if (!state || !state.paneMode) return { ok: true };
    const mode = state.paneMode;
    if (!['copy-mode', 'view-mode'].includes(mode)) {
      state.paneMode = '';
      return { ok: true };
    }
    const cancelled = await tmuxInput(['send-keys', '-t', tmuxPaneTarget(name), '-X', 'cancel']);
    if (cancelled.timedOut || cancelled.transportFailed) return { ok: false };
    state.paneMode = ''; // one cancel per reported mode: a repeat would only error
    return { ok: true };
  }

  async withInputSuspended(agent, action, requireFlush = false) {
    const queue = this.inputQueues[agent];
    // Depth-counted so overlapping suspends can't re-enable input early, and
    // watchdog-released so a wedged tmux call inside `action` can never leave
    // typing silently swallowed forever.
    queue.suspendDepth = (queue.suspendDepth || 0) + 1;
    queue.suspended = true;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      queue.suspendDepth = Math.max(0, (queue.suspendDepth || 1) - 1);
      if (queue.suspendDepth === 0) queue.suspended = false;
    };
    const watchdog = setTimeout(release, 20000);
    try {
      this.flushInput(agent);
      const flushed = await queue.chain;
      if (requireFlush && flushed === false) return false;
      return await action();
    } finally {
      clearTimeout(watchdog);
      release();
    }
  }

  resetInputQueues() {
    for (const queue of Object.values(this.inputQueues)) {
      if (queue.timer) clearTimeout(queue.timer);
      queue.data = '';
      queue.cwd = null;
      queue.paste = false;
      queue.timer = null;
      queue.suspended = true;
    }
    this.inputQueues = byAgent(() => this.newInputQueue());
  }

  async setSize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this._resizeRunning) {
      this._resizeQueued = true;
      return this._resizePromise;
    }
    this._resizeRunning = true;
    this._resizePromise = (async () => {
      do {
        this._resizeQueued = false;
        const requestedCols = this.cols;
        const requestedRows = this.rows;
        const agent = this.activeAgent;
        const cwd = normalizedPath(workspaceFolder());
        if (!cwd) break;
        let s = this.cachedReadySession(agent, cwd);
        if (!s) {
          s = await sessionName(agent);
          const info = await agentSessionInfo(agent, s);
          if (!info.ready) break;
          this.rememberSession(agent, cwd, s, true);
        }
        await tmux(['set-window-option', '-t', tmuxPaneTarget(s), 'window-size', 'manual']);
        await tmux(['resize-window', '-t', tmuxPaneTarget(s), '-x', String(requestedCols), '-y', String(requestedRows)]);
      } while (this._resizeQueued);
    })().finally(() => {
      this._resizeRunning = false;
      this.tick(true);
    });
    return this._resizePromise;
  }

  async startSession(agent = this.activeAgent) {
    if (!AGENTS[agent]) return;
    // Free mode never starts anything: the session is the user's, and it either
    // exists (mirror it) or it does not (say so).
    const mirrored = AGENTS[agent].attachSession;
    if (mirrored) {
      const info = await agentSessionInfo(agent, mirrored);
      if (!info.exists) {
        vscode.window.showWarningMessage(
          `tmux session "${mirrored}" is not running. ${AGENTS[agent].label} mirrors a session you start yourself.`
        );
        return;
      }
      this.agentState[agent].present = true;
      return this.activateSession(agent);
    }
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const args = launchArgs(agent);
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
    const s = await sessionName(agent);
    const existing = await agentSessionInfo(agent, s);
    if (existing.ready) {
      this.agentState[agent].present = true;
      return this.activateSession(agent);
    }
    if (existing.exists) {
      if (!existing.shell) {
        vscode.window.showWarningMessage(`The workspace tmux "${s}" is busy with ${existing.command || 'another process'}.`);
        return;
      }
      const launched = await this.withInputSuspended(agent, () => this.runAgentCommand(agent, s, command));
      if (!launched) {
        await this.reportLaunchFailure(agent, s);
        return;
      }
      return this.activateSession(agent);
    }
    await this.createSession(agent, command);
  }

  async ensureAgentWorktree(agent, cwd) {
    try {
      const isGit = await runFile('git', ['rev-parse', '--is-inside-work-tree'], cwd);
      if (!isGit.ok || isGit.out.trim() !== 'true') return null;
      const wtDir = path.join(cwd, '.agentmux', 'worktrees', agent);
      if (fs.existsSync(wtDir)) return wtDir;
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });
      const branch = `agent/${agent}`;
      const addRes = await runFile('git', ['worktree', 'add', '-B', branch, wtDir, 'HEAD'], cwd);
      if (!addRes.ok) return null;
      const gitDirRes = await runFile('git', ['rev-parse', '--git-dir'], cwd);
      if (gitDirRes.ok) {
        const excludeFile = path.join(gitDirRes.out.trim(), 'info', 'exclude');
        try {
          if (fs.existsSync(excludeFile)) {
            const content = fs.readFileSync(excludeFile, 'utf8');
            if (!content.includes('.agentmux')) {
              fs.appendFileSync(excludeFile, '\n.agentmux/\n');
            }
          }
        } catch {}
      }
      return wtDir;
    } catch {
      return null;
    }
  }

  async mergeAgentWorktree(agent = this.activeAgent) {
    const cwd = workspaceFolder();
    if (!cwd) return;
    const branch = `agent/${agent}`;
    const res = await runFile('git', ['merge', branch], cwd);
    if (res.ok) {
      vscode.window.showInformationMessage(`Merged branch "${branch}" into current branch.`);
    } else {
      vscode.window.showErrorMessage(`Merge conflict or error while merging "${branch}": ${res.out || res.err}`);
    }
  }

  async removeAgentWorktree(agent = this.activeAgent) {
    const cwd = workspaceFolder();
    if (!cwd) return;
    const wtDir = path.join(cwd, '.agentmux', 'worktrees', agent);
    if (!fs.existsSync(wtDir)) {
      vscode.window.showInformationMessage(`No dedicated worktree found for ${AGENTS[agent]?.label || agent}.`);
      return;
    }
    const res = await runFile('git', ['worktree', 'remove', wtDir, '--force'], cwd);
    if (res.ok) {
      vscode.window.showInformationMessage(`Removed dedicated worktree for ${AGENTS[agent]?.label || agent}.`);
    } else {
      vscode.window.showErrorMessage(`Failed to remove worktree: ${res.out || res.err}`);
    }
  }

  async createSession(agent, command) {
    let cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder before starting a tmux agent.');
      return;
    }
    if (cfg().get('worktrees')) {
      const wt = await this.ensureAgentWorktree(agent, cwd);
      if (wt) cwd = wt;
    }
    const s = await sessionName(agent);
    const created = await tmux([
      'new-session', '-d', '-s', s,
      '-x', String(this.cols || 80), '-y', String(this.rows || 24), '-c', cwd,
    ]);
    if (!created.ok) {
      if (await sessionBelongsToWorkspace(s)) return this.tick(true);
      vscode.window.showErrorMessage(`Cannot create tmux session "${s}" for this workspace.`);
      return;
    }
    // Give the login shell time to install its prompt/key bindings before keys
    // are injected; otherwise fast local starts can race shell initialization.
    await delay(250);
    await tmux(['set-window-option', '-t', tmuxPaneTarget(s), 'window-size', 'manual']);
    if (!await this.runAgentCommand(agent, s, command)) {
      await tmux(['kill-session', '-t', tmuxSessionTarget(s)]);
      await this.reportLaunchFailure(agent, s);
      return;
    }
    // Fresh pane: anything still debounced in the queue belonged to the
    // previous incarnation and must not fire here.
    this.dropQueuedInput(agent);
    this.activateSession(agent);
  }

  // A launch fails for one overwhelmingly common reason: the CLI is not on PATH.
  // Naming only the tmux session left the user to guess, so the preflight probe
  // is consulted and the install command offered.
  async reportLaunchFailure(agent, name) {
    const spec = AGENTS[agent];
    await this.runPreflight(true);
    if (this._preflight?.agents?.[agent] !== false) {
      vscode.window.showErrorMessage(`Cannot start ${spec.label} in tmux session "${name}".`);
      return;
    }
    const install = spec.installCmd || '';
    const choice = await vscode.window.showErrorMessage(
      `${spec.label} is not on PATH, so it could not start in "${name}".`
      + (install ? ` Install it with:  ${install}` : ''),
      ...(install ? ['Copy install command'] : [])
    );
    if (choice === 'Copy install command') {
      try {
        await vscode.env.clipboard.writeText(install);
        vscode.window.showInformationMessage('Install command copied to the clipboard.');
      } catch { /* no clipboard in this host */ }
    }
  }

  async runAgentCommand(agent, name, command) {
    const generation = crypto.randomBytes(12).toString('hex');
    const generationSet = await tmux([
      'set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_generation', generation,
    ]);
    if (!generationSet.ok) return false;
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_agent', agent]);
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_running', 'starting']);
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@agentmux_state', '']);
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@agentmux_tool', '']);
    if (cfg().get('tmuxStatusBar') !== false) {
      // Only useful, extension-related facts on the tmux status line for anyone
      // attached in a real terminal. Session options: plain name (set-option
      // does not accept '='-exact session targets); zero live-path cost.
      await tmux(['set-option', '-t', name, 'status-interval', '5']);
      await tmux(['set-option', '-t', name, 'status-right-length', '60']);
      await tmux(['set-option', '-t', name, 'status-right',
        ` AgentMux · ${AGENTS[agent].label}#{?@agentmux_state, · #{@agentmux_state},}#{?@agentmux_tool, · #{@agentmux_tool},} `]);
    }
    const cleanup = `tmux set-option -p -t ${shellQuote(tmuxPaneTarget(name))} @claude_tmux_running 0`;
    // AGENTMUX=1 marks this pane as ours. Integrations that live in a tool's
    // own config (the OpenCode plugin) check it before touching anything, so an
    // agent you start yourself is never affected by AgentMux's presence.
    // Hermes launches additionally carry the per-project profile env (created
    // on first use), so each project gets its own isolated Hermes profile.
    const envPrefix = await launchEnvPrefix(agent);
    const sent = await tmux([
      'send-keys', '-t', tmuxPaneTarget(name), `${envPrefix}AGENTMUX=1 ${command}; ${cleanup}`, 'Enter',
    ]);
    if (!sent.ok) return false;
    return this.waitForAgentReady(agent, name, 8000);
  }

  async waitForAgentReady(agent, name, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await agentSessionInfo(agent, name);
      if (info.ready) return true;
      if (info.exists && info.shell) {
        const marker = await tmux(['show-option', '-pqv', '-t', tmuxPaneTarget(name), '@claude_tmux_running']);
        if (marker.ok && marker.out.trim() === '0') return false;
      }
      await delay(160);
    }
    return false;
  }

  activateSession(agent) {
    this.eventLog.append({ type: 'session', agent, action: 'started' });
    const state = this.agentState[agent];
    state.lastFrame = null;
    this.resetLiveFrame(agent);
    state.sessionsSent = false;
    state.present = true;
    state.historyMode = false;
    state.historyPending = false;
    this.activeAgent = agent;
    this.context.workspaceState.update('claudeTmux.activeAgent', agent);
    this.postActiveAgent();
    this.postAgents();
    this.pollPresence(true);
    this.tick(true);
  }

  async replaceSession(agent, command, action) {
    const cwd = workspaceFolder();
    if (!cwd) return;
    const s = await sessionName(agent);
    if (await sessionBelongsToWorkspace(s)) {
      const go = await vscode.window.showWarningMessage(
        `Replace this workspace's "${s}" session? The running ${AGENTS[agent].label} process will stop.`,
        { modal: true }, action
      );
      if (go !== action) return;
      return this.withInputSuspended(agent, async () => {
        await tmux(['kill-session', '-t', tmuxSessionTarget(s)]);
        this.invalidateSessionCache(agent);
        await this.createSession(agent, command);
      });
    }
    await this.createSession(agent, command);
  }

  // Adaptive cadence: run hot while the user is typing or output is streaming,
  // at the configured rate normally, and decay when the pane has been static.
  // When a push source (control mode / pipe tap) reports output itself, the
  // loop is only a slow watchdog for repaints the push signal cannot see.
  nextTickDelay() {
    const base = Math.max(80, cfg().get('refreshMs') || 120);
    const sinceActive = Date.now() - Math.max(this._lastInputAt, this._lastFrameChangeAt);
    if (this._eventSourceLive) return sinceActive < 10000 ? Math.max(base, 500) : 1500;
    if (sinceActive < 2000) return Math.max(80, Math.min(120, base));
    if (sinceActive < 10000) return base;
    return Math.max(400, base);
  }

  startLoop() {
    this.stopLoop();
    const generation = ++this._loopGeneration;
    const schedule = () => {
      if (generation !== this._loopGeneration) return;
      this.timer = setTimeout(async () => {
        this.timer = null;
        try { await this.tick(false); } finally { schedule(); }
      }, this.nextTickDelay());
    };
    schedule();
  }

  stopLoop() {
    this._loopGeneration++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  stopLoops() {
    this.stopLoop();
    if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = null; }
    if (this._eventTickTimer) { clearTimeout(this._eventTickTimer); this._eventTickTimer = null; }
    this.pipeTap.disarm();
    this._eventSourceLive = false;
    this.resetInputQueues();
  }

  setHistoryMode(agent, enabled) {
    if (!AGENTS[agent]) return;
    const state = this.agentState[agent];
    if (state.historyMode === !!enabled) return;
    const limit = Math.max(0, Math.min(5000, cfg().get('scrollbackLines') ?? 1000));
    if (enabled && limit === 0) return;
    state.historyMode = !!enabled;
    state.historyPending = !!enabled;
    if (!enabled) this.resetLiveFrame(agent);
    if (agent === this.activeAgent) this.tick(true);
  }

  async tick(force) {
    if (this._tickRunning) {
      this._tickQueued = true;
      this._tickForce = this._tickForce || force;
      return;
    }
    this._tickRunning = true;
    try {
      await this.tickOnce(force);
    } finally {
      this._tickRunning = false;
      if (this._tickQueued) {
        const queuedForce = this._tickForce;
        this._tickQueued = false;
        this._tickForce = false;
        setTimeout(() => this.tick(queuedForce), 0);
      }
    }
  }

  async tickOnce(force) {
    if (!this.view) return;
    const visible = this.view.visible;

    // When hidden, poll slowly just to drive the "unread activity" badge.
    if (!visible) {
      const now = Date.now();
      if (now - this._lastHiddenTickAt < 2000) return;
      this._lastHiddenTickAt = now;
    } else {
      this._lastHiddenTickAt = 0;
    }

    const cwd = workspaceFolder();
    const agent = this.activeAgent;
    if (!cwd) {
      if (visible) this.view.webview.postMessage({ type: 'noWorkspace', agent });
      return;
    }
    const state = this.agentState[agent];
    const cwdNorm = normalizedPath(cwd);
    const cachedEntry = this.cachedSessionEntry(agent, cwdNorm);
    const s = cachedEntry ? cachedEntry.name : await sessionName(agent);
    const configuredScrollback = cfg().get('scrollbackLines');
    const scrollback = Math.trunc(Math.max(0, Math.min(5000, configuredScrollback == null ? 1000 : configuredScrollback)));
    const historyMode = state.historyMode;
    const historyPending = state.historyPending;
    const captureHistory = historyMode && historyPending;
    const captureArgs = ['capture-pane', '-p', '-e'];
    if (captureHistory) captureArgs.push('-S', `-${scrollback}`);
    captureArgs.push('-t', tmuxPaneTarget(s));
    // One process per tick: frame + cursor/size meta, fused and atomic.
    captureArgs.push(';', 'display-message', '-p', '-t', tmuxPaneTarget(s), META_SENTINEL + META_FORMAT);
    const captureStartedAt = Date.now();
    const frame = await tmux(captureArgs, TMUX_CAPTURE_TIMEOUT_MS);
    const latencyMs = Date.now() - captureStartedAt;
    if (agent !== this.activeAgent) return;
    if (state.historyMode !== historyMode || state.historyPending !== historyPending) return;

    // Slow server, not a dead session: keep the last frame and presence as
    // they were. Invalidating here is what used to hide live tabs and flash
    // the launcher whenever several windows hammered one tmux server.
    if (frame.timedOut || frame.transportFailed) return;

    if (!frame.ok) {
      this.invalidateSessionCache(agent);
      state.lastFrame = null;
      state.present = false;
      this.postAgents();
      if (!visible) return;
      this.view.webview.postMessage({ type: 'nosession', agent, name: s, folder: cwd });
      if (!state.sessionsSent) { state.sessionsSent = true; this.pushSessions(agent); }
      return;
    }
    // The presence loop re-verifies readiness every ~900ms; only fall back to a
    // direct check when the cache has nothing fresh for this pane.
    let sessionReady = this.cachedReadySession(agent, cwdNorm) === s;
    if (!sessionReady) {
      sessionReady = (await agentSessionInfo(agent, s)).ready;
      if (sessionReady) this.rememberSession(agent, cwdNorm, s, true);
    }
    if (!sessionReady) {
      state.lastFrame = null;
      this.resetLiveFrame(agent);
      state.present = false;
      this.postAgents();
      if (visible) this.view.webview.postMessage({ type: 'nosession', agent, name: s, folder: cwd });
      if (!state.sessionsSent) { state.sessionsSent = true; this.pushSessions(agent); }
      return;
    }
    state.sessionsSent = false;

    const { frame: frameOut, meta: fusedMeta } = splitFusedCapture(frame.out);
    const frameChanged = frameOut !== state.lastLiveFrame;
    const changed = force || frameChanged;
    state.present = true;
    let delta = null;
    if (captureHistory) {
      state.historyPending = false;
    } else {
      if (frameChanged) {
        this._lastFrameChangeAt = Date.now();
        const newLines = frameOut.split('\n');
        if (visible && !force && !historyMode && state.lastFrameLines) {
          const changes = diffFrameLines(state.lastFrameLines, newLines, frameOut.length);
          if (changes) delta = { baseSeq: state.frameSeq, seq: state.frameSeq + 1, changes };
        }
        state.frameSeq++;
        state.lastFrameLines = newLines;
      }
      state.lastLiveFrame = frameOut;
      state.lastFrame = frameOut;
      this.updateActivity(agent, frameOut, frameChanged);
    }
    if (fusedMeta != null) state.lastMeta = fusedMeta; // keep the switch cache fresh even when hidden

    if (!visible) {
      if (changed) {
        this.unseen = 1;
        this.updateBadge();
      }
      return;
    }

    let metaText = state.lastMeta;
    if (agent !== this.activeAgent) return;
    const metaParts = metaText.split(',');
    state.historySize = parseInt(metaParts[5], 10) || 0;
    state.lastName = s;
    // Our own control client rides on the active session; don't count it in
    // the footer's "clients" number.
    if (controlClient.attachedSession === s && metaParts.length >= 7) {
      metaParts[6] = String(Math.max(0, (parseInt(metaParts[6], 10) || 0) - 1));
      metaText = metaParts.join(',');
    }

    // Always send a tiny status (keeps the live dot + cursor + footer fresh even
    // on a static screen). Content travels as changed lines when the change is
    // small, as the full frame otherwise; meta is always frame-fresh.
    const fullFrame = captureHistory ? frameOut : (!historyMode && changed && !delta ? frameOut : null);
    this.view.webview.postMessage({
      type: 'frame',
      agent,
      frame: fullFrame,
      delta: fullFrame == null ? delta : null,
      seq: state.frameSeq,
      meta: metaText,
      name: s,
      historyMode,
      historyAvailable: Math.min(state.historySize, scrollback),
      latencyMs,
      paneMode: state.paneMode,
    });
  }

  // public actions used by commands
  async restart() {
    const agent = this.activeAgent;
    if (AGENTS[agent]?.attachSession) {
      vscode.window.showInformationMessage(
        `${AGENTS[agent].label} mirrors the existing tmux session "${AGENTS[agent].attachSession}". AgentMux never restarts a session it did not create.`
      );
      return;
    }
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) return this.startSession();
    const args = launchArgs(agent);
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
    await this.replaceSession(agent, command, 'Restart');
  }

  async kill() {
    const agent = this.activeAgent;
    const s = await sessionName(agent);
    // A mirrored session belongs to the user, so it is not gated on the
    // workspace root — but the confirmation says plainly that AgentMux did not
    // create it, because killing it is not "cleaning up after ourselves".
    const mirrored = !!AGENTS[agent]?.attachSession;
    const alive = mirrored
      ? (await tmux(['has-session', '-t', tmuxSessionTarget(s)])).ok
      : await sessionBelongsToWorkspace(s);
    if (!alive) {
      vscode.window.showInformationMessage(mirrored
        ? `tmux session "${s}" is not running.`
        : `No ${AGENTS[agent].label} tmux session for this workspace.`);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      mirrored
        ? `Kill tmux session "${s}"? AgentMux did not create it — it is only mirrored here, and anything running in it will stop.`
        : `Kill tmux session "${s}"? ${AGENTS[agent].label} and anything running in it will stop.`,
      { modal: true }, 'Kill'
    );
    if (pick !== 'Kill') return;
    await this.withInputSuspended(agent, () => tmux(['kill-session', '-t', tmuxSessionTarget(s)]));
    this.invalidateSessionCache(agent);
    this.dropQueuedInput(agent);
    this.agentState[agent] = this.newAgentState();
    if (this.writerAgent === agent) {
      this.writerAgent = null;
      this.context.workspaceState.update('claudeTmux.pairWriter', undefined);
    }
    this.postAgents();
    this.pollPresence(true);
    this.tick(true);
  }

  // ---- housekeeping ------------------------------------------------------------
  // Leftovers accumulate in a project: sessions from a renamed prefix, or an
  // agent replaced by a restart. This clears them — and ONLY them.
  //
  // Hard rule: a session is a candidate only when its tmux session_path IS this
  // workspace root. Another project's sessions can never appear here, not even
  // when their folder is gone, because "their folder is gone" is precisely what
  // we cannot verify as ours. Same for the control clients, whose path is the
  // extension host's cwd: they are excluded outright (they already carry
  // destroy-unattached, so they collect themselves).
  async cleanupSessions() {
    const cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder first — cleanup only ever touches the current project.');
      return;
    }
    const listed = await tmux(['list-sessions', '-F',
      '#{session_name}\t#{session_path}\t#{session_created}\t#{session_attached}\t#{session_windows}']);
    if (!listed.ok) {
      vscode.window.showInformationMessage('No tmux server is running — nothing to clean up.');
      return;
    }
    // Current prefixes plus the pre-0.10.2 defaults, so this project's sessions
    // from an older AgentMux are still recognizable as ours.
    const prefixes = [
      ...AGENT_IDS.map((agent) => (AGENTS[agent].prefixSetting ? cfg().get(AGENTS[agent].prefixSetting) : '')
        || AGENTS[agent].defaultPrefix),
      ...AGENT_IDS.map((agent) => AGENTS[agent].defaultPrefix),
      'tmux_', 'codex_',
    ].filter(Boolean);
    // Free-mode sessions are the user's own; AgentMux never created them, so
    // they are never leftovers of ours and can never appear in this list.
    const mirrored = mirroredSessionNames();
    const here = normalizedPath(cwd);
    // Names currently in use, so a live agent is never mistaken for a leftover.
    const live = new Set();
    for (const agent of AGENT_IDS) {
      if (this.agentState[agent]?.present) live.add(await sessionName(agent));
    }
    const items = [];
    for (const line of listed.out.split('\n')) {
      if (!line.trim()) continue;
      const [name, sessionPath = '', created = '', attached = '', windows = ''] = line.split('\t');
      // The only gate that matters: is this session rooted in THIS project?
      const isProjectSession = normalizedPath(sessionPath) === here
        || !!(sessionPath && here && normalizedPath(sessionPath).startsWith(here + '/.agentmux/worktrees/'));
      if (!sessionPath || !isProjectSession) continue;
      if (mirrored.has(name)) continue; // mirrored in free mode, not ours to kill
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue; // not created by us
      const age = created ? fmtDurationShort(Date.now() - Number(created) * 1000) : '?';
      const isLive = live.has(name);
      items.push({
        label: name,
        description: [
          isLive ? 'running agent for this project' : 'leftover',
          attached === '1' ? 'attached' : '',
        ].filter(Boolean).join(' · '),
        detail: `${windows || 1} window(s) · up ${age}`,
        session: name,
        // Nothing is pre-selected: everything here belongs to the project you
        // have open, so the choice is always explicit.
        picked: false,
      });
    }
    if (!items.length) {
      vscode.window.showInformationMessage('No AgentMux tmux sessions for this project.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Select tmux sessions to kill — ${path.basename(cwd)} only`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || !picked.length) return;
    const go = await vscode.window.showWarningMessage(
      `Kill ${picked.length} tmux session(s)? Anything still running in them stops.`,
      { modal: true }, 'Kill'
    );
    if (go !== 'Kill') return;
    let killed = 0;
    for (const item of picked) {
      // Re-verify ownership immediately before killing: the list is a snapshot,
      // and nothing may be killed on the strength of a stale reading.
      if (!await sessionBelongsToWorkspace(item.session)) continue;
      await tmux(['kill-session', '-t', tmuxSessionTarget(item.session)]);
      killed++;
    }
    this.invalidateSessionCache();
    for (const state of Object.values(this.agentState)) {
      state.lastFrame = null;
      state.sessionsSent = false;
    }
    vscode.window.showInformationMessage(killed === picked.length
      ? `Killed ${killed} tmux session(s).`
      : `Killed ${killed} of ${picked.length} — the rest no longer belong to this project.`);
    this.pollPresence(true);
    this.tick(true);
  }

  // ---- navigation -----------------------------------------------------------------
  // With six or more tabs, "next agent" is rarely what you want — "take me to
  // whichever agent needs me" is. These commands are the keyboard half of the
  // information the status bar already carries.

  presentAgents() {
    return AGENT_IDS.filter((agent) => this.agentState[agent]?.present);
  }

  async focusAgentTab(agent) {
    if (!AGENTS[agent]) return false;
    await vscode.commands.executeCommand('claudeTmux.view.focus');
    if (agent !== this.activeAgent) this.switchAgent(agent);
    return true;
  }

  // The agent most worth going to: one that is blocked on you first, then the
  // most recent completion. Ties break on how long the status has been held.
  pickAttentionAgent() {
    const rank = (agent) => (this.agentState[agent].status === 'needs-input' ? 1 : 0);
    return this.presentAgents()
      .filter((agent) => ['needs-input', 'done'].includes(this.agentState[agent].status))
      .sort((a, b) => rank(b) - rank(a) || this.agentState[b].statusSince - this.agentState[a].statusSince)[0]
      || null;
  }

  async gotoAttention() {
    const agent = this.pickAttentionAgent();
    if (!agent) {
      vscode.window.showInformationMessage('No agent is waiting for you or has just finished.');
      return null;
    }
    await this.focusAgentTab(agent);
    return agent;
  }

  // Toggle back to the agent you were on before this one.
  async gotoLastAgent() {
    const previous = (this.focusHistory || [])
      .find((agent) => agent !== this.activeAgent && this.agentState[agent]?.present);
    if (!previous) {
      vscode.window.showInformationMessage('No other agent has been focused in this workspace yet.');
      return null;
    }
    await this.focusAgentTab(previous);
    return previous;
  }

  async cycleAgent(step) {
    const present = this.presentAgents();
    if (present.length < 2) return null;
    const at = present.indexOf(this.activeAgent);
    const next = present[((at < 0 ? 0 : at) + step + present.length) % present.length];
    await this.focusAgentTab(next);
    return next;
  }

  // 1-indexed over the agents currently running, matching what the tabs show.
  async jumpToAgent(args = {}) {
    const index = Number(typeof args === 'number' ? args : args?.index);
    const present = this.presentAgents();
    if (!Number.isFinite(index) || index < 1 || index > present.length) return null;
    await this.focusAgentTab(present[index - 1]);
    return present[index - 1];
  }

  // ---- scriptable surface --------------------------------------------------------
  // Commands that take arguments and RETURN values, so AgentMux can be driven
  // from a keybinding, a task or another extension instead of only by hand.
  // They are ordinary commands, held to the same rules as the side bar: the
  // workspace check, the Pair Mode lock and the handoff/arbiter freeze all
  // apply, and the reason for a refusal is returned rather than swallowed.

  agentFromArgs(args, fallback = this.activeAgent) {
    const id = typeof args === 'string' ? args : args?.agent;
    return AGENTS[id] ? id : fallback;
  }

  // Live status without depending on the side bar being open: the presence loop
  // only runs while the view exists, so with no view the pane is read directly.
  async currentStatus(agent) {
    const state = this.agentState[agent];
    if (this.view) return { present: !!state?.present, status: state?.status || 'idle' };
    const cwd = normalizedPath(workspaceFolder());
    if (!cwd) return { present: false, status: 'idle' };
    const name = this.cachedReadySession(agent, cwd) || await sessionName(agent);
    const info = await agentSessionInfo(agent, name);
    if (!info.ready) return { present: false, status: 'idle' };
    const hooked = cfg().get('stateHooks') !== false ? info.hookState : '';
    return { present: true, status: hooked || state?.status || 'idle' };
  }

  async sendToAgent(args = {}) {
    const agent = this.agentFromArgs(args);
    let text = typeof args === 'string' ? undefined : args?.text;
    if (typeof text !== 'string') {
      text = await vscode.window.showInputBox({
        prompt: `Send to ${AGENTS[agent].label}`,
        placeHolder: 'Text to type into the agent, then submit',
      });
      if (text === undefined) return { ok: false, agent, reason: 'cancelled' };
    }
    if (!text.trim()) return { ok: false, agent, reason: 'empty' };
    if (text.length > 30000) return { ok: false, agent, reason: 'too-long' };
    const live = await this.currentStatus(agent);
    if (!live.present) return { ok: false, agent, reason: 'not-running' };
    if (live.status === 'needs-input' && args?.protectDialog !== false) {
      return { ok: false, agent, reason: 'agent_blocked', message: 'Target agent is awaiting input on a dialog' };
    }
    if (this.handoff || this.arbiter) return { ok: false, agent, reason: 'transaction-in-progress' };
    if (this.writerAgent && agent !== this.writerAgent) {
      return { ok: false, agent, reason: 'pair-locked', writer: this.writerAgent };
    }
    const submit = args?.submit !== false;
    const delivered = await this.queueInput(agent, submit ? `${text}\r` : text, true);
    return { ok: delivered !== false, agent, submitted: submit };
  }

  async captureAgent(args = {}) {
    const agent = this.agentFromArgs(args);
    const cwd = normalizedPath(workspaceFolder());
    if (!cwd) return { ok: false, agent, reason: 'no-workspace' };
    const name = this.cachedReadySession(agent, cwd) || await sessionName(agent);
    const info = await agentSessionInfo(agent, name);
    if (!info.ready) return { ok: false, agent, reason: 'not-running' };
    const lines = Math.max(1, Math.min(10000, Number(args?.lines) || this.rows || 24));
    const captured = await tmux(['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', tmuxPaneTarget(name)]);
    if (!captured.ok) return { ok: false, agent, reason: 'capture-failed' };
    const text = stripAnsi(captured.out).replace(/\s+$/, '');
    // Called from the palette there is no caller to hand the text to, so show it.
    if (args?.quiet !== true) {
      this.output().appendLine(`--- ${AGENTS[agent].label} (${name}), last ${lines} line(s) ---`);
      this.output().appendLine(text);
      this.output().appendLine('');
      this.output().show(true);
    }
    return { ok: true, agent, session: name, text };
  }

  agentStatus(args = {}) {
    const wanted = typeof args === 'string' ? args : args?.agent;
    const ids = AGENTS[wanted] ? [wanted] : AGENT_IDS;
    const report = {};
    for (const agent of ids) {
      const state = this.agentState[agent] || {};
      report[agent] = {
        present: !!state.present,
        status: state.status || 'idle',
        forMs: state.statusSince ? Date.now() - state.statusSince : 0,
        tool: state.lastTool || '',
        title: state.paneTitle || '',
        writer: this.writerAgent === agent,
        mirrored: !!AGENTS[agent].attachSession,
      };
    }
    if (args?.quiet !== true && !this.view) {
      this.output().appendLine(JSON.stringify(report, null, 2));
      this.output().show(true);
    }
    return report;
  }

  // Resolves once the agent reaches one of the wanted statuses, so a script can
  // do "send, wait for done, capture" without polling the pane itself.
  async waitForAgent(args = {}) {
    const agent = this.agentFromArgs(args);
    const wanted = new Set([].concat(args?.status || ['done', 'needs-input']).filter(Boolean));
    const timeoutMs = Math.max(1000, Math.min(3600000, Number(args?.timeoutMs) || 300000));
    const deadline = Date.now() + timeoutMs;
    // A status already held when the wait starts counts: the caller asked where
    // the agent IS, not for the next transition.
    while (Date.now() < deadline) {
      const live = await this.currentStatus(agent);
      if (live.present && wanted.has(live.status)) return { ok: true, agent, status: live.status };
      await delay(250);
    }
    const last = await this.currentStatus(agent);
    return { ok: false, agent, reason: 'timeout', status: last.status };
  }

  // ---- free mode ---------------------------------------------------------------
  // Point a tab at a tmux session you already have. This is the whole reason
  // free mode exists: a new agent (or any long-running tmux) becomes usable in
  // the side bar by editing settings, never by shipping a new AgentMux.
  async addTmuxSession() {
    const listed = await tmux(['list-sessions', '-F',
      '#{session_name}\t#{session_path}\t#{session_windows}\t#{?session_attached,attached,detached}']);
    if (!listed.ok) {
      vscode.window.showInformationMessage('No tmux server is running — start a session first.');
      return;
    }
    // Sessions AgentMux already drives (managed or mirrored) are not offered.
    const taken = new Set();
    for (const agent of AGENT_IDS) {
      const name = await sessionName(agent);
      if (name) taken.add(name);
    }
    const items = [];
    for (const line of listed.out.split('\n')) {
      if (!line.trim()) continue;
      const [name, sessionPath = '', windows = '', attached = ''] = line.split('\t');
      if (!name || taken.has(name)) continue;
      if (name.startsWith('_agentmux_ctl_')) continue; // our own control client
      if (!validSessionName(name)) continue;
      items.push({
        label: name,
        description: sessionPath,
        detail: `${windows || 1} window(s) · ${attached}`,
        session: name,
      });
    }
    if (!items.length) {
      vscode.window.showInformationMessage('Every running tmux session is already shown in AgentMux.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Mirror which existing tmux session in the side bar?',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    const label = await vscode.window.showInputBox({
      prompt: 'Tab label for this session',
      value: picked.session.slice(0, 24),
      validateInput: (value) => (value.trim() ? null : 'Enter a label.'),
    });
    if (label === undefined) return;
    const target = customAgentsTarget();
    const list = [...customAgentsAt(target)];
    list.push({ id: freeAgentId(picked.session, list), label: label.trim().slice(0, 24), session: picked.session });
    await cfg().update('customAgents', list, target);
    this.offerReload(`"${picked.session}" is now a free-mode agent.`);
  }

  async removeCustomAgent() {
    const target = customAgentsTarget();
    const list = customAgentsAt(target);
    if (!list.length) {
      vscode.window.showInformationMessage('No custom agents are configured.');
      return;
    }
    const items = list.map((entry, index) => ({
      label: String(entry?.label || entry?.id || '(unnamed)'),
      description: entry?.session ? `mirrors tmux "${entry.session}"` : `runs ${entry?.command || '?'}`,
      index,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Remove which custom agents? Their tmux sessions keep running.',
      matchOnDescription: true,
    });
    if (!picked || !picked.length) return;
    const drop = new Set(picked.map((item) => item.index));
    await cfg().update('customAgents', list.filter((_, index) => !drop.has(index)), target);
    this.offerReload(`Removed ${picked.length} custom agent(s).`);
  }

  // The registry is built once at activation, so a roster change needs a
  // window reload to take effect. Say so instead of half-applying it.
  async offerReload(message) {
    const go = await vscode.window.showInformationMessage(
      `${message} Reload the window to apply the change.`, 'Reload Window'
    );
    if (go === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  // ---- integrations ----------------------------------------------------------------
  // Everything AgentMux can write outside its own storage, in one inspectable
  // list: where each file lives, whether it is installed and up to date, and
  // what it is for. Writing them silently at launch with removal as the only
  // visible control asked the user to trust something they could not see.
  integrationCatalog() {
    const hookPaths = stateHookPaths();
    const entries = [
      {
        id: 'hook-script',
        label: 'Shared state hook script',
        detail: 'Stamps agent state into tmux pane options. Used by Claude and Codex.',
        file: hookPaths?.script || null,
        expected: STATE_HOOK_SCRIPT,
        install: () => !!ensureStateHookAssets(),
      },
      {
        id: 'claude-settings',
        label: 'Claude Code hook settings',
        detail: 'Passed per launch with --settings; your own ~/.claude/settings.json is never touched.',
        file: hookPaths?.settings || null,
        expected: null, // generated from the script path, compared by existence
        install: () => !!ensureStateHookAssets(),
      },
      {
        id: 'opencode-plugin',
        label: 'OpenCode plugin',
        detail: 'Reports OpenCode lifecycle state. Inert unless AGENTMUX=1 is set on the pane.',
        file: opencodePluginPath(),
        expected: OPENCODE_PLUGIN,
        install: () => ensureOpencodePlugin(),
        remove: () => removeOpencodePlugin(),
      },
      {
        id: 'pi-extension',
        label: 'pi extension',
        detail: 'Reports pi lifecycle state. Inert unless AGENTMUX=1 is set on the pane.',
        file: piExtensionPath(),
        expected: PI_EXTENSION,
        install: () => ensurePiExtension(),
        remove: () => removePiExtension(),
      },
    ];
    for (const entry of entries) {
      entry.exists = !!(entry.file && fs.existsSync(entry.file));
      let current = null;
      if (entry.exists) {
        try { current = fs.readFileSync(entry.file, 'utf8'); } catch { current = null; }
      }
      entry.current = !entry.exists ? false
        : (entry.expected == null ? true : current === entry.expected);
      entry.state = !entry.exists ? 'not installed' : entry.current ? 'installed' : 'out of date';
    }
    // Codex's hooks are not a file at all — they are -c overrides on the launch
    // command line — so they are listed for honesty, not for management.
    entries.push({
      id: 'codex-hooks',
      label: 'Codex lifecycle hooks',
      detail: cfg().get('codexHooks') === false
        ? 'Disabled by claudeTmux.codexHooks.'
        : 'Passed per launch with -c, never written to your config.toml. Codex asks once to trust them.',
      file: null,
      exists: cfg().get('codexHooks') !== false && cfg().get('stateHooks') !== false,
      current: true,
      state: cfg().get('codexHooks') !== false && cfg().get('stateHooks') !== false
        ? 'passed at launch' : 'off',
    });
    return entries;
  }

  async manageIntegrations() {
    const entries = this.integrationCatalog();
    const hooksOff = cfg().get('stateHooks') === false;
    const items = entries.map((entry) => ({
      label: `${entry.state === 'installed' || entry.state === 'passed at launch' ? '$(check)' : entry.state === 'out of date' ? '$(warning)' : '$(circle-outline)'} ${entry.label}`,
      description: entry.state,
      detail: `${entry.detail}${entry.file ? `\n${entry.file}` : ''}`,
      entry,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: hooksOff
        ? 'Agent integrations — claudeTmux.stateHooks is off, so nothing is installed'
        : 'Agent integrations — pick one to install, refresh or remove',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    const entry = picked.entry;
    if (!entry.file) {
      vscode.window.showInformationMessage(`${entry.label}: ${entry.detail}`);
      return;
    }
    const actions = [];
    if (entry.install) actions.push(entry.exists ? 'Reinstall' : 'Install');
    if (entry.remove && entry.exists) actions.push('Remove');
    actions.push('Reveal');
    const action = await vscode.window.showQuickPick(actions, { placeHolder: entry.file });
    if (!action) return;
    if (action === 'Reveal') {
      try {
        const doc = await vscode.workspace.openTextDocument(entry.file);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`Cannot open ${entry.file}.`);
      }
      return;
    }
    if (action === 'Remove') {
      const ok = entry.remove();
      vscode.window.showInformationMessage(ok ? `Removed ${entry.label}.` : `${entry.label} was not present.`);
      return;
    }
    if (hooksOff) {
      vscode.window.showWarningMessage('claudeTmux.stateHooks is off, so integrations are not written. Turn it on first.');
      return;
    }
    const ok = entry.install();
    vscode.window.showInformationMessage(ok
      ? `${entry.label} installed at ${entry.file}.`
      : `Could not write ${entry.label} — is its config directory writable?`);
  }

  // Everything AgentMux writes outside its own storage, removable in one step.
  async removeIntegrations() {
    const go = await vscode.window.showWarningMessage(
      'Remove AgentMux integration files? This deletes the OpenCode plugin, the pi extension and the generated hook assets. Agent state falls back to screen detection.',
      { modal: true }, 'Remove'
    );
    if (go !== 'Remove') return;
    const removed = [];
    if (removeOpencodePlugin()) removed.push(opencodePluginPath());
    if (removePiExtension()) removed.push(piExtensionPath());
    const paths = stateHookPaths();
    for (const file of [paths?.script, paths?.settings]) {
      if (!file) continue;
      try { fs.unlinkSync(file); removed.push(file); } catch { /* already gone */ }
    }
    vscode.window.showInformationMessage(removed.length
      ? `Removed ${removed.length} integration file(s).`
      : 'No integration files were present.');
    if (removed.length) this.output().appendLine(`Removed integrations:\n  ${removed.join('\n  ')}\n`);
  }

  // Delete a past conversation from the resume list, using whatever the agent
  // supports: its own delete command (opencode, hermes) or removing the
  // transcript (claude, codex). The per-agent action lives in the registry.
  async deleteConversation(agent, id) {
    const spec = AGENTS[agent];
    if (!spec?.deleteConversation || !id) return;
    const go = await vscode.window.showWarningMessage(
      `Delete this ${spec.label} conversation? This removes it from disk and cannot be undone.`,
      { modal: true }, 'Delete'
    );
    if (go !== 'Delete') return;
    const ok = await spec.deleteConversation(id, workspaceFolder());
    if (!ok) {
      vscode.window.showWarningMessage(`Could not delete that ${spec.label} conversation.`);
      return;
    }
    this.tails[agent]?.reset();
    this.pushSessions(agent);
  }

  // Manage only this workspace's agent sessions (session_path === this root).
  async killPick() {
    const items = [];
    for (const agent of Object.keys(AGENTS)) {
      // Free-mode sessions are not this workspace's to manage in bulk; the
      // single-session Kill command still offers them, with its own warning.
      if (AGENTS[agent].attachSession) continue;
      const name = await sessionName(agent);
      if (!await sessionBelongsToWorkspace(name)) continue;
      const info = await tmux([
        'display-message', '-p', '-t', tmuxPaneTarget(name),
        '#{session_windows}\t#{?session_attached,attached,detached}',
      ]);
      const [wins, state] = (info.out || '').trim().split('\t');
      items.push({
        label: `${AGENTS[agent].label}: ${name}`,
        description: `${wins || 1} window(s) · ${state || 'detached'}`,
        session: name,
        agent,
      });
    }
    if (!items.length) {
      vscode.window.showInformationMessage('No agent tmux sessions for this workspace.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select this workspace\'s tmux session(s) to kill',
    });
    if (!picked || !picked.length) return;
    const go = await vscode.window.showWarningMessage(
      `Kill ${picked.length} tmux session(s)? Anything running in them will stop.`,
      { modal: true }, 'Kill'
    );
    if (go !== 'Kill') return;
    for (const it of picked) {
      if (await sessionBelongsToWorkspace(it.session)) {
        await this.withInputSuspended(it.agent, () => tmux(['kill-session', '-t', tmuxSessionTarget(it.session)]));
        this.invalidateSessionCache(it.agent);
      }
    }
    vscode.window.showInformationMessage(`Killed ${picked.length} tmux session(s).`);
    for (const state of Object.values(this.agentState)) {
      state.lastFrame = null;
      state.sessionsSent = false;
    }
    this.pollPresence(true);
    this.tick(true);
  }

  // Agents with readable local transcripts (Claude) get the extension's picker;
  // the others hand off to their own resume mechanism — Codex's cwd-filtered
  // native picker, Antigravity's --continue.
  async attachExisting(agent = this.activeAgent) {
    const cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder before resuming an agent session.');
      return;
    }
    const spec = AGENTS[agent];
    if (!spec) return;
    // Resuming replaces the tmux session, which free mode must never do.
    if (spec.attachSession) {
      vscode.window.showInformationMessage(
        `${spec.label} mirrors the existing tmux session "${spec.attachSession}". Resume it from inside that session.`
      );
      return;
    }
    if (!spec.listSessions) {
      if (!spec.resumeLatest) {
        vscode.window.showInformationMessage(`${spec.label} does not support resuming a previous session.`);
        return;
      }
      if (agent === 'codex') await this.warnCodexRuleConflict();
      await this.replaceSession(agent, spec.resumeLatest(launchArgs(agent), workspaceFolder()), 'Resume');
      return;
    }
    const sessions = await vscode.window.withProgress(
      { location: { viewId: 'claudeTmux.view' }, title: `Loading ${spec.label} sessions…` },
      () => spec.listSessions(cwd)
    );
    if (!sessions.length) {
      vscode.window.showInformationMessage(`No existing ${spec.label} sessions found for this folder.`);
      return;
    }

    const items = sessions.map((s) => ({
      label: s.name,
      description: s.id.substring(0, 8),
      detail: s.lastTs ? new Date(s.lastTs).toLocaleString() : undefined,
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Resume which ${spec.label} session in the side bar?`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this.startResumed(picked.sessionId, agent);
  }

  async warnCodexRuleConflict() {
    if (!cfg().get('codexReadClaudeRules') || !codexArgsHaveDeveloperOverride()) return;
    const key = 'claudeTmux.codexRuleConflictWarned';
    if (this.context.workspaceState.get(key)) return;
    await this.context.workspaceState.update(key, true);
    vscode.window.showWarningMessage(
      'Codex .claude rule loading was skipped because claudeTmux.codexArgs already defines developer_instructions. Merge the .claude directive there or remove that override.'
    );
  }

  // ---- .claude/agentmux file channel ------------------------------------------
  // The agents' only coordination medium is the workspace .claude directory:
  // briefings, deliveries, ACKs and arbiter answers travel as files there, with
  // the pane-scrape block as automatic fallback for write-restricted agents.
  channelFile(name) {
    if (cfg().get('fileChannel') === false) return null;
    const cwd = workspaceFolder();
    return cwd ? path.join(cwd, '.claude', 'agentmux', name) : null;
  }

  cleanupChannel(id) {
    const cwd = workspaceFolder();
    if (!cwd || !id) return;
    const names = [`draft-${id}.md`, `handoff-${id}.md`, `ack-${id}`,
      ...AGENT_IDS.map((agent) => `answer-${id}-${agent}.md`)];
    for (const name of names) {
      fs.promises.unlink(path.join(cwd, '.claude', 'agentmux', name)).catch(() => {});
    }
  }

  sweepChannel() {
    try {
      const cwd = workspaceFolder();
      if (!cwd) return;
      const dir = path.join(cwd, '.claude', 'agentmux');
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const f of fs.readdirSync(dir)) {
        if (!/^(draft-|handoff-|ack-|answer-)/.test(f)) continue;
        const full = path.join(dir, f);
        try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch { /* raced */ }
      }
    } catch { /* best-effort */ }
  }

  // Wait for a marked block either as a channel file (end marker on its last
  // line) or in the pane's recent output — whichever appears first.
  async waitForMarkedBlock({ prefix, id, file, paneName, timeoutMs, active }) {
    const deadline = Date.now() + timeoutMs;
    const endMarker = `${prefix}_END:${id}`;
    const beginMarker = `${prefix}_BEGIN:${id}`;
    while (Date.now() < deadline && active()) {
      if (file) {
        try {
          const raw = await fs.promises.readFile(file, 'utf8');
          const lines = raw.trimEnd().split('\n');
          if (lines.length && lines[lines.length - 1].trim() === endMarker) {
            let content = lines.slice(0, -1);
            if (content.length && content[0].trim() === beginMarker) content = content.slice(1);
            const text = content.join('\n').trim();
            if (text) return text;
          }
        } catch { /* not written yet */ }
      }
      const captured = await tmux(['capture-pane', '-p', '-J', '-S', '-220', '-t', tmuxPaneTarget(paneName)]);
      if (captured.ok) {
        const block = extractMarkedBlock(stripAnsi(captured.out), prefix, id);
        if (block) return block;
      }
      await delay(450);
    }
    return null;
  }

  requestFindings() {
    const last = this.lastCompletedHandoff;
    if (!last || this.handoff) return;
    if (!this.agentState[last.target].present || !this.agentState[last.source].present) return;
    this.prepareHandoff(last.target, { target: last.source, parentId: last.id, findings: true });
    if (this.handoff) {
      this.lastCompletedHandoff = null;
      this.postAgents();
    }
  }

  prepareHandoff(source = this.activeAgent, opts = {}) {
    if (!AGENTS[source] || !this.agentState[source].present) return;
    if (this.handoff) {
      vscode.window.showInformationMessage('A handoff is already in progress.');
      return;
    }
    if (this.arbiter) {
      vscode.window.showInformationMessage('Finish or cancel the arbiter round first.');
      return;
    }
    if (this.writerAgent && this.writerAgent !== source) {
      vscode.window.showInformationMessage(`Pair Mode writer is ${AGENTS[this.writerAgent].label}. Switch to that tab to hand off.`);
      return;
    }
    // With more than two agents the peer is a real choice: offer every other
    // agent, running ones first, and let the details step confirm it.
    const candidates = this.handoffCandidates(source);
    const target = opts.target && AGENTS[opts.target] && opts.target !== source
      ? opts.target
      : candidates[0];
    if (!target) {
      vscode.window.showInformationMessage('Start another agent to hand work off to.');
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    this.handoff = {
      id, source, target, phase: 'collecting', details: '', createdAt: Date.now(),
      ackToken: crypto.randomBytes(12).toString('hex'),
      findings: !!opts.findings,
      parentId: opts.parentId || undefined,
      lockedTarget: !!(opts.target && AGENTS[opts.target]), // findings round-trip
    };
    this.postAgents();
    if (this.view) this.view.webview.postMessage({
      type: 'handoffDetails', id, source, target, details: '', findings: !!opts.findings,
      targets: this.handoff.lockedTarget ? [target] : candidates,
    });
  }

  // Handoff peers for `source`: present agents first (the realistic targets),
  // then the rest, so a handoff can still start one that is not running yet.
  handoffCandidates(source) {
    const others = AGENT_IDS.filter((agent) => agent !== source);
    return [
      ...others.filter((agent) => this.agentState[agent].present),
      ...others.filter((agent) => !this.agentState[agent].present),
    ];
  }

  updateHandoffDetails(message) {
    const transaction = this.handoff;
    const { id, details } = message;
    if (!transaction || transaction.id !== id || transaction.phase !== 'collecting'
      || typeof details !== 'string' || details.length > 4000) return;
    transaction.details = details;
  }

  returnHandoffToDetails(transaction, error) {
    if (this.handoff !== transaction) return;
    transaction.phase = 'collecting';
    this.postAgents();
    if (this.view) this.view.webview.postMessage({
      type: 'handoffCreateError', id: transaction.id, details: transaction.details || '', error,
      source: transaction.source, target: transaction.target,
      targets: transaction.lockedTarget ? [transaction.target] : this.handoffCandidates(transaction.source),
    });
  }

  async createHandoff(message) {
    const transaction = this.handoff;
    const details = typeof message.details === 'string' ? message.details : '';
    if (!transaction || transaction.id !== message.id || transaction.phase !== 'collecting') return;
    if (details.length > 4000) {
      return this.returnHandoffToDetails(transaction, 'Optional details must be 4,000 characters or fewer.');
    }
    const beginMarker = `HANDOFF_BEGIN:${transaction.id}`;
    const endMarker = `HANDOFF_END:${transaction.id}`;
    if (details.includes(beginMarker) || details.includes(endMarker)) {
      return this.returnHandoffToDetails(transaction, 'Remove transaction markers from the optional details.');
    }
    // The details step may have re-pointed the handoff at another agent.
    if (!transaction.lockedTarget && message.target && message.target !== transaction.target) {
      if (!AGENTS[message.target] || message.target === transaction.source) {
        return this.returnHandoffToDetails(transaction, 'Pick a valid agent to hand off to.');
      }
      transaction.target = message.target;
    }
    transaction.details = details;
    transaction.phase = 'checking';
    this.postAgents();
    if (this.view) this.view.webview.postMessage({
      type: 'handoffChecking', id: transaction.id, source: transaction.source, target: transaction.target,
    });

    const { source, target, id } = transaction;
    if (!this.agentState[source].present || ['working', 'needs-input'].includes(this.agentState[source].status)) {
      return this.returnHandoffToDetails(transaction, `${AGENTS[source].label} must be back at its prompt before creating the handoff.`);
    }
    if (!this.agentState[target].present) {
      const choice = await vscode.window.showInformationMessage(
        `Start ${AGENTS[target].label} before preparing the handoff?`,
        { modal: true }, 'Start and continue'
      );
      if (this.handoff !== transaction) return;
      if (choice !== 'Start and continue') {
        return this.returnHandoffToDetails(transaction, `Start ${AGENTS[target].label} to create this handoff.`);
      }
      await this.startSession(target);
      if (this.handoff !== transaction) return;
      if (!this.agentState[target].present) {
        return this.returnHandoffToDetails(transaction, `${AGENTS[target].label} could not be started.`);
      }
      this.switchAgent(source);
    }
    if (['working', 'needs-input'].includes(this.agentState[target].status)) {
      return this.returnHandoffToDetails(transaction, `${AGENTS[target].label} must be back at its prompt before creating the handoff.`);
    }

    const cwd = normalizedPath(workspaceFolder());
    const sourceName = this.cachedReadySession(source, cwd) || await sessionName(source);
    transaction.phase = 'drafting';
    this.postAgents();
    const draftFile = this.channelFile(`draft-${id}.md`);
    if (draftFile) fs.promises.unlink(draftFile).catch(() => {});
    const prompt = (transaction.findings ? findingsPrompt : sourceHandoffPrompt)(source, target, id, transaction.details);
    let sourceReady = false;
    const requested = await this.withInputSuspended(source, async () => {
      const sourceInfo = await agentSessionInfo(source, sourceName);
      if (this.handoff !== transaction) return false;
      if (!sourceInfo.ready || ['working', 'needs-input'].includes(this.agentState[source].status)) {
        this.invalidateSessionCache(source);
        return false;
      }
      sourceReady = true;
      this.rememberSession(source, cwd, sourceName, true);
      if (this.view) this.view.webview.postMessage({ type: 'handoffPreparing', id, source, target });
      return (await this.sendInputData(source, prompt, cwd, true)).ok
        && (await this.sendInputData(source, '\r', cwd, false)).ok;
    }, true);
    if (!sourceReady) {
      return this.returnHandoffToDetails(transaction, `${AGENTS[source].label} must be running and back at its prompt before creating the handoff.`);
    }
    if (!requested) {
      this.handoff = null;
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'handoffDraftError', id, error: `Could not ask ${AGENTS[source].label} to prepare the handoff.` });
      return;
    }
    this.agentState[source].lastActivity = Date.now();
    this.setAgentStatus(source, 'working');
    const authored = await this.waitForHandoffDraft(transaction, sourceName, 90000);
    if (this.handoff !== transaction) return;
    if (!authored) {
      this.handoff = null;
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'handoffDraftError', id, error: `${AGENTS[source].label} did not return a complete handoff block.` });
      return;
    }

    const diffChars = Math.max(0, Math.min(60000, cfg().get('handoffDiffChars') ?? 6000));
    const [branch, head, status, diff, staged, log, hunks] = await Promise.all([
      runFile('git', ['branch', '--show-current'], cwd),
      runFile('git', ['rev-parse', '--short', 'HEAD'], cwd),
      runFile('git', ['status', '--short'], cwd),
      runFile('git', ['diff', '--stat'], cwd),
      runFile('git', ['diff', '--cached', '--stat'], cwd),
      runFile('git', ['log', '--oneline', '-n', '10'], cwd),
      diffChars ? runFile('git', ['diff', '--unified=1'], cwd) : Promise.resolve({ ok: false, out: '' }),
    ]);
    if (this.handoff !== transaction) return;
    transaction.phase = 'review';
    transaction.authored = authored.slice(0, 12000);
    let hunksText = '';
    if (hunks.ok && hunks.out.trim()) {
      hunksText = hunks.out.trim();
      if (hunksText.length > diffChars) hunksText = hunksText.slice(0, diffChars) + '\n… (truncated)';
    }
    const todoFile = String(cfg().get('handoffTodoFile') ?? 'tasks/todo.md').trim();
    let todoText = '';
    if (todoFile && !todoFile.includes('..')) {
      try { todoText = fs.readFileSync(path.join(cwd, todoFile), 'utf8').slice(0, 2000).trim(); } catch { /* absent */ }
    }
    const resumePointers = [];
    for (const agent of AGENT_IDS) {
      const file = this.tails[agent]?.file;
      if (!file) continue; // no readable transcript for this CLI
      resumePointers.push(`${AGENTS[agent].label} ${path.basename(file, '.jsonl').replace(/^rollout-/, '')}`);
    }
    transaction.repository = {
      branch: branch.ok && branch.out.trim() ? branch.out.trim() : '(unavailable)',
      head: head.ok && head.out.trim() ? head.out.trim() : '(unavailable)',
      status: status.ok && status.out.trim() ? status.out.trim() : '(clean or unavailable)',
      diff: diff.ok && diff.out.trim() ? diff.out.trim() : '(none)',
      staged: staged.ok && staged.out.trim() ? staged.out.trim() : '(none)',
      log: log.ok ? log.out.trim() : '',
      hunks: hunksText,
      todo: todoText,
      todoFile,
      verify: await this.runHandoffVerify(cwd),
      resume: resumePointers.join(', '),
    };
    transaction.texts = {
      continue: this.composeHandoffText(transaction, 'continue'),
      reviewOnly: this.composeHandoffText(transaction, 'reviewOnly'),
      reviewFix: this.composeHandoffText(transaction, 'reviewFix'),
    };
    this.eventLog.append({ type: 'handoff', id, phase: 'drafted', source, target, parentId: transaction.parentId });
    this.setAgentStatus(source, 'done');
    this.postAgents();
    if (this.view) {
      this.view.webview.postMessage({
        type: 'handoffDraft', id, source, target, sourceAuthored: true,
        continue: transaction.texts.continue,
        reviewOnly: transaction.texts.reviewOnly,
        reviewFix: transaction.texts.reviewFix,
      });
    }
  }

  async waitForHandoffDraft(transaction, sourceName, timeoutMs) {
    return this.waitForMarkedBlock({
      prefix: 'HANDOFF',
      id: transaction.id,
      file: this.channelFile(`draft-${transaction.id}.md`),
      paneName: sourceName,
      timeoutMs,
      active: () => this.handoff === transaction && transaction.phase === 'drafting',
    });
  }

  composeHandoffText(transaction, mode) {
    const repo = transaction.repository;
    const details = String(transaction.details || '');
    const ackMiddle = Math.floor(transaction.ackToken.length / 2);
    const ackLeft = transaction.ackToken.slice(0, ackMiddle);
    const ackRight = transaction.ackToken.slice(ackMiddle);
    const modeInstruction = {
      continue: 'Continue task: take ownership of the next action, preserve valid work, implement only what remains, and verify it.',
      reviewOnly: 'Review only: inspect changes and run read-only checks, then report concrete findings. Do not modify files.',
      reviewFix: 'Review & Fix: inspect changes, run relevant tests, fix confirmed issues without undoing valid work, and verify the result.',
    }[mode];
    return [
      `Handoff from ${AGENTS[transaction.source].label} to ${AGENTS[transaction.target].label}.`,
      `Transaction ID: ${transaction.id}`,
      '',
      `Briefing authored by ${AGENTS[transaction.source].label} specifically for ${AGENTS[transaction.target].label}:`,
      transaction.authored,
      ...(details.trim() ? [
        '',
        'Additional details supplied by the user before generation:',
        details,
      ] : []),
      '',
      'Repository facts added by AgentMux:',
      `Branch / HEAD: ${repo.branch} / ${repo.head}`,
      'Git status:', repo.status,
      'Unstaged diff summary:', repo.diff,
      'Staged diff summary:', repo.staged,
      ...(repo.log ? ['Recent commits:', repo.log] : []),
      ...(repo.hunks ? ['Diff hunks (unified=1):', repo.hunks] : []),
      ...(repo.todo ? [`Task list (${repo.todoFile}):`, repo.todo] : []),
      ...(repo.verify ? [`Verification output (${repo.verify.cmd}, exit ${repo.verify.exit}):`, repo.verify.tail] : []),
      ...(repo.resume ? [`Conversation resume pointers (best-effort): ${repo.resume}`] : []),
      '',
      'Before doing any work, recursively read and follow every Markdown instruction under .claude/ (except .claude/agentmux/, the transient coordination channel).',
      modeInstruction,
      '',
      `Acknowledgement token halves: ${ackLeft} and ${ackRight}.`,
      cfg().get('fileChannel') !== false
        ? `First, acknowledge receipt: create the workspace file .claude/agentmux/ack-${transaction.id} whose entire content is the two token halves joined with no separator. If you cannot write files, output one line made from the prefix HANDOFF_ACK, a colon, then the joined halves. Do not reproduce an example marker. Then continue with the requested mode.`
        : 'In your first response, output one line made from the prefix HANDOFF_ACK, a colon, then the two token halves joined with no separator. Do not reproduce an example marker. Then continue with the requested mode.',
    ].join('\n');
  }

  // Optional, workspace-trust-gated verify command whose tail lands in the
  // briefing; runs once at draft time, never on any live path.
  async runHandoffVerify(cwd) {
    const command = (cfg().get('handoffVerifyCommand') || '').trim();
    if (!command || vscode.workspace.isTrusted === false) return null;
    const parts = command.split(/\s+/);
    return new Promise((resolve) => {
      execFile(parts[0], parts.slice(1), { cwd, timeout: 60000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        const tail = `${stdout || ''}\n${stderr || ''}`.trim().slice(-2000);
        resolve({ cmd: command, exit: err ? (typeof err.code === 'number' ? err.code : 1) : 0, tail: tail || '(no output)' });
      });
    });
  }

  async confirmHandoff(message) {
    const { id, source, target, text, mode } = message;
    const transaction = this.handoff;
    if (!transaction || transaction.phase !== 'review' || transaction.id !== id
      || transaction.source !== source || transaction.target !== target
      || !['continue', 'reviewOnly', 'reviewFix'].includes(mode) || typeof text !== 'string') {
      return this.postHandoffResult(false, 'Invalid handoff request. Prepare a fresh handoff and try again.');
    }
    if (!text.trim() || text.length > 30000) {
      return this.postHandoffResult(false, 'Handoff text must contain 1–30,000 characters.');
    }
    const ackMarker = `HANDOFF_ACK:${transaction.ackToken}`;
    if (text.split(/\r?\n/).some((line) => line.trim() === ackMarker)) {
      return this.postHandoffResult(false, 'Remove the acknowledgement marker from the handoff text and try again.');
    }
    if (['working', 'needs-input'].includes(this.agentState[source].status)
      || ['working', 'needs-input'].includes(this.agentState[target].status)) {
      return this.postHandoffResult(false, 'An agent is no longer ready. Return both agents to their prompts, then send again.');
    }
    transaction.phase = 'delivering';
    transaction.mode = mode;
    transaction.text = text;
    transaction.texts[mode] = text;
    transaction.previewMode = mode;
    this.postAgents();
    const cwd = normalizedPath(workspaceFolder());
    const targetName = this.cachedReadySession(target, cwd) || await sessionName(target);
    // Preferred delivery: the briefing goes into the .claude/agentmux channel
    // and only a short pointer is pasted into the TUI — no capture-window or
    // giant-paste limits. Falls back to pasting the full text.
    const handoffFile = this.channelFile(`handoff-${id}.md`);
    transaction.usedFile = false;
    if (handoffFile) {
      try {
        this.eventLog.ensureDir();
        fs.promises.unlink(this.channelFile(`ack-${id}`)).catch(() => {});
        await fs.promises.writeFile(handoffFile, text);
        transaction.usedFile = true;
      } catch { transaction.usedFile = false; }
    }
    const payload = transaction.usedFile
      ? [
          `AgentMux handoff from ${AGENTS[source].label} to ${AGENTS[target].label}.`,
          `Read the workspace file .claude/agentmux/handoff-${id}.md now and follow it completely,`,
          'including its acknowledgement step, before doing anything else.',
        ].join('\n')
      : text;
    let targetInfo = null;
    const sent = await this.withInputSuspended(target, async () => {
      targetInfo = await agentSessionInfo(target, targetName);
      if (!targetInfo.ready) {
        this.invalidateSessionCache(target);
        return false;
      }
      this.rememberSession(target, cwd, targetName, true);
      return (await this.sendInputData(target, payload, cwd, true)).ok
        && (await this.sendInputData(target, '\r', cwd, false)).ok;
    }, true);
    if (!targetInfo?.ready) {
      transaction.phase = 'review';
      this.postAgents();
      this.pollPresence(true);
      return this.postHandoffResult(false, `${AGENTS[target].label} is no longer running in this workspace tmux.`);
    }
    if (!sent) {
      transaction.phase = 'review';
      this.postAgents();
      return this.postHandoffResult(false, `The handoff could not be delivered to ${AGENTS[target].label}. Your edited text is still available.`);
    }
    transaction.phase = 'awaitingAck';
    transaction.targetName = targetName;
    transaction.targetCreated = targetInfo.created;
    transaction.targetGeneration = targetInfo.generation;
    transaction.targetIdentity = paneIdentity(targetInfo);
    transaction.sentAt = Date.now();
    this.eventLog.append({
      type: 'handoff', id, phase: 'delivered', source, target, mode,
      parentId: transaction.parentId,
      text: text.slice(0, 30000),
      targetName, targetCreated: targetInfo.created, targetGeneration: targetInfo.generation,
      targetIdentity: transaction.targetIdentity,
    });
    this.activeAgent = target;
    this.context.workspaceState.update('claudeTmux.activeAgent', target);
    const state = this.agentState[target];
    state.lastActivity = Date.now();
    this.setAgentStatus(target, 'working');
    this.postActiveAgent();
    this.postAgents();
    this.setSize(this.cols, this.rows);
    if (this.view) this.view.webview.postMessage({ type: 'handoffAwaitingAck', id, target });
    this.waitForHandoffAck(transaction, 30000);
  }

  async waitForHandoffAck(transaction, timeoutMs) {
    const marker = `HANDOFF_ACK:${transaction.ackToken}`;
    const deadline = Date.now() + timeoutMs;
    const ackFile = transaction.usedFile ? this.channelFile(`ack-${transaction.id}`) : null;
    while (Date.now() < deadline && this.handoff === transaction && transaction.phase === 'awaitingAck') {
      let acknowledged = false;
      if (ackFile) {
        try {
          acknowledged = (await fs.promises.readFile(ackFile, 'utf8')).trim() === transaction.ackToken;
        } catch { /* not written yet */ }
      }
      if (!acknowledged) {
        const captured = await tmux(['capture-pane', '-p', '-J', '-S', '-160', '-t', tmuxPaneTarget(transaction.targetName)]);
        acknowledged = captured.ok && stripAnsi(captured.out).split('\n').some((line) => line.trim() === marker);
      }
      if (acknowledged) {
        const info = await agentSessionInfo(transaction.target, transaction.targetName);
        if (info.ready && identityMatches(info, transaction)) {
          return this.completeHandoff(transaction, false);
        }
        if (this.handoff === transaction) {
          this.handoff = null;
          this.eventLog.append({ type: 'handoff', id: transaction.id, phase: 'stale' });
          this.postAgents();
          if (this.view) this.view.webview.postMessage({
            type: 'handoffManualError', id: transaction.id, stale: true,
            error: `${AGENTS[transaction.target].label}'s tmux session changed. Prepare a fresh handoff.`,
          });
        }
        return;
      }
      await delay(450);
    }
    if (this.handoff === transaction && transaction.phase === 'awaitingAck') {
      transaction.phase = 'ackTimeout';
      this.eventLog.append({ type: 'handoff', id: transaction.id, phase: 'ack-timeout' });
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'handoffAckTimeout', id: transaction.id, target: transaction.target });
    }
  }

  async acceptHandoff(id) {
    const transaction = this.handoff;
    if (!transaction || transaction.id !== id || transaction.phase !== 'ackTimeout') return;
    const cwd = normalizedPath(workspaceFolder());
    const targetName = transaction.targetName || this.cachedReadySession(transaction.target, cwd) || await sessionName(transaction.target);
    const info = await agentSessionInfo(transaction.target, targetName);
    if (this.handoff !== transaction || transaction.phase !== 'ackTimeout') return;
    if (!info.ready) {
      if (this.view) this.view.webview.postMessage({
        type: 'handoffManualError', id,
        error: `${AGENTS[transaction.target].label} is no longer running in this workspace.`,
      });
      return;
    }
    if (!identityMatches(info, transaction)) {
      this.handoff = null;
      this.postAgents();
      if (this.view) this.view.webview.postMessage({
        type: 'handoffManualError', id, stale: true,
        error: `${AGENTS[transaction.target].label}'s tmux session changed. Prepare a fresh handoff.`,
      });
      return;
    }
    this.completeHandoff(transaction, true);
  }

  completeHandoff(transaction, manual) {
    if (this.handoff !== transaction || !['awaitingAck', 'ackTimeout'].includes(transaction.phase)) return;
    this.writerAgent = transaction.target;
    this.context.workspaceState.update('claudeTmux.pairWriter', transaction.target);
    this.handoff = null;
    this.cleanupChannel(transaction.id);
    this.eventLog.append({
      type: 'handoff', id: transaction.id, phase: manual ? 'accepted-manual' : 'acknowledged',
      source: transaction.source, target: transaction.target, mode: transaction.mode,
      parentId: transaction.parentId,
    });
    this.rememberCompletedHandoff(transaction);
    this.postAgents();
    this.postHandoffResult(true);
    vscode.window.showInformationMessage(
      `AgentMux: ${AGENTS[transaction.target].label} accepted the handoff${manual ? ' (manually confirmed)' : ''}.`
    );
  }

  cancelHandoff(id) {
    if (!this.handoff || (id && this.handoff.id !== id)) return;
    // ackTimeout may be dismissed too: the text was already delivered, ownership
    // simply doesn't transfer, and nothing is ever resent.
    if (!['collecting', 'checking', 'drafting', 'review', 'ackTimeout'].includes(this.handoff.phase)) return;
    this.eventLog.append({ type: 'handoff', id: this.handoff.id, phase: 'cancelled' });
    this.cleanupChannel(this.handoff.id);
    this.handoff = null;
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'handoffCancelled' });
  }

  // After a review-mode handoff completes, remember it so the UI can offer a
  // findings round-trip back to the original author.
  rememberCompletedHandoff(transaction) {
    if (['reviewOnly', 'reviewFix'].includes(transaction.mode)) {
      this.lastCompletedHandoff = {
        id: transaction.id, source: transaction.source, target: transaction.target,
        mode: transaction.mode, at: Date.now(),
      };
    } else {
      this.lastCompletedHandoff = null;
    }
  }

  // A delivered handoff must survive an extension-host restart: rehydrate it
  // from the ledger as manual-accept only (never resent), and only when the
  // target pane identity still matches what delivery pinned.
  async rehydrateHandoff() {
    if (this.handoff || this._rehydrated) return;
    this._rehydrated = true;
    try {
      const events = await this.eventLog.tail(200);
      const open = new Map();
      for (const e of events) {
        if (e.type !== 'handoff' || !e.id) continue;
        if (e.phase === 'delivered') open.set(e.id, e);
        else if (['acknowledged', 'accepted-manual', 'cancelled', 'stale'].includes(e.phase)) open.delete(e.id);
      }
      const last = [...open.values()].pop();
      if (!last || !last.targetName || Date.now() - last.ts > 24 * 3600 * 1000) return;
      const info = await agentSessionInfo(last.target, last.targetName);
      // A rehydrated handoff is only revived when the ledger's pinned identity
      // still matches; a tmux server restart or a recreated pane makes it stale.
      if (!info.ready || !identityMatches(info, last)) {
        this.eventLog.append({ type: 'handoff', id: last.id, phase: 'stale' });
        return;
      }
      if (this.handoff) return;
      this.handoff = {
        id: last.id, source: last.source, target: last.target, phase: 'ackTimeout',
        mode: last.mode, previewMode: last.mode,
        texts: { continue: '', reviewOnly: '', reviewFix: '', [last.mode]: last.text || '' },
        targetName: last.targetName, targetCreated: last.targetCreated, targetGeneration: last.targetGeneration,
        targetIdentity: last.targetIdentity || paneIdentity(info),
        parentId: last.parentId,
        ackToken: crypto.randomBytes(12).toString('hex'), // unusable on purpose: manual path only
        createdAt: last.ts, rehydrated: true,
      };
      this.postAgents();
      this.postHandoffState();
    } catch { /* rehydration is best-effort */ }
  }

  updateHandoffDraft(message) {
    const transaction = this.handoff;
    const { id, mode, text } = message;
    if (!transaction || transaction.id !== id || transaction.phase !== 'review'
      || !['continue', 'reviewOnly', 'reviewFix'].includes(mode)
      || typeof text !== 'string' || text.length > 30000) return;
    transaction.texts[mode] = text;
    transaction.previewMode = mode;
  }

  postHandoffState() {
    if (!this.view || !this.handoff) return;
    const transaction = this.handoff;
    if (transaction.phase === 'collecting') {
      this.view.webview.postMessage({
        type: 'handoffDetails', id: transaction.id,
        source: transaction.source, target: transaction.target,
        details: transaction.details || '',
        findings: !!transaction.findings,
        targets: transaction.lockedTarget ? [transaction.target] : this.handoffCandidates(transaction.source),
      });
      return;
    }
    if (transaction.phase === 'checking') {
      this.view.webview.postMessage({
        type: 'handoffChecking', id: transaction.id,
        source: transaction.source, target: transaction.target,
      });
      return;
    }
    if (transaction.phase === 'drafting') {
      this.view.webview.postMessage({
        type: 'handoffPreparing', id: transaction.id,
        source: transaction.source, target: transaction.target,
      });
      return;
    }
    if (!transaction.texts) return;
    this.view.webview.postMessage({
      type: 'handoffDraft', id: transaction.id,
      source: transaction.source, target: transaction.target,
      sourceAuthored: true, mode: transaction.mode || transaction.previewMode || 'continue',
      continue: transaction.texts.continue,
      reviewOnly: transaction.texts.reviewOnly,
      reviewFix: transaction.texts.reviewFix,
    });
    if (transaction.phase === 'delivering') {
      this.view.webview.postMessage({ type: 'handoffDelivering', id: transaction.id });
    } else if (transaction.phase === 'awaitingAck') {
      this.view.webview.postMessage({ type: 'handoffAwaitingAck', id: transaction.id, target: transaction.target });
    } else if (transaction.phase === 'ackTimeout') {
      this.view.webview.postMessage({ type: 'handoffAckTimeout', id: transaction.id, target: transaction.target });
    }
  }

  postHandoffResult(ok, error = '') {
    if (this.view) this.view.webview.postMessage({ type: 'handoffResult', ok, error });
  }

  // ---- arbiter mode --------------------------------------------------------------
  // One question, every running agent in parallel, answers gathered through the
  // .claude channel (pane markers as fallback), verdict picked by the user; the
  // winner becomes the Pair-Mode writer.
  // Every RUNNING agent takes part; agents that are not started simply sit the
  // round out, so a third agent never blocks a two-way arbiter.
  // A free-mode mirror is excluded: the round demands a marked answer from every
  // participant and fails as a whole if one cannot deliver, and what is running
  // in a session you started yourself may not be an agent at all. Handoffs stay
  // available to it — those pick a target explicitly.
  arbiterParticipants() {
    return AGENT_IDS.filter((agent) => this.agentState[agent].present && !AGENTS[agent].attachSession);
  }

  prepareArbiter() {
    if (this.handoff) {
      vscode.window.showInformationMessage('Finish or cancel the current handoff first.');
      return;
    }
    if (this.arbiter) {
      vscode.window.showInformationMessage('An arbiter round is already in progress.');
      return;
    }
    const participants = this.arbiterParticipants();
    if (participants.length < 2) {
      vscode.window.showInformationMessage('At least two agents must be running for an arbiter round.');
      return;
    }
    // A mid-turn agent cannot take a parallel question, so the round waits.
    if (participants.some((agent) => ['working', 'needs-input'].includes(this.agentState[agent].status))) {
      vscode.window.showInformationMessage('Every running agent must be back at its prompt for an arbiter round.');
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    this.arbiter = { id, phase: 'collecting', createdAt: Date.now(), participants };
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'arbiterPrompt', id, participants });
  }

  arbiterPrompt(agent, id, question) {
    const fileMode = cfg().get('fileChannel') !== false;
    return [
      `Answer the following question with analysis only. Do not modify any project files${fileMode ? ' other than the answer file described below' : ''}.`,
      '',
      question,
      '',
      ...(fileMode ? [
        `Write your answer to the workspace file .claude/agentmux/answer-${id}-${agent}.md (create directories if needed).`,
        'The very last line of that file must be the end marker described below.',
        'If you cannot write files, print the answer in your reply as one delimited block using both markers.',
      ] : ['Return only one delimited block.']),
      'Build each marker by joining the prefix, a colon, and the ID.',
      'Begin prefix: ARBITER_BEGIN',
      'End prefix: ARBITER_END',
      `ID: ${id}-${agent}`,
    ].join('\n');
  }

  async createArbiter(message) {
    const arb = this.arbiter;
    if (!arb || arb.id !== message.id || arb.phase !== 'collecting') return;
    const question = typeof message.question === 'string' ? message.question.trim() : '';
    if (!question || question.length > 4000) {
      if (this.view) this.view.webview.postMessage({ type: 'arbiterError', id: arb.id, error: 'The question must contain 1–4,000 characters.' });
      return;
    }
    arb.question = question;
    arb.phase = 'delivering';
    this.postAgents();
    const cwd = normalizedPath(workspaceFolder());
    const deliver = async (agent) => {
      const name = this.cachedReadySession(agent, cwd) || await sessionName(agent);
      const prompt = this.arbiterPrompt(agent, arb.id, question);
      const answerFile = this.channelFile(`answer-${arb.id}-${agent}.md`);
      if (answerFile) fs.promises.unlink(answerFile).catch(() => {});
      const ok = await this.withInputSuspended(agent, async () => {
        const info = await agentSessionInfo(agent, name);
        if (!info.ready || ['working', 'needs-input'].includes(this.agentState[agent].status)) {
          this.invalidateSessionCache(agent);
          return false;
        }
        this.rememberSession(agent, cwd, name, true);
        return (await this.sendInputData(agent, prompt, cwd, true)).ok
          && (await this.sendInputData(agent, '\r', cwd, false)).ok;
      }, true);
      if (ok) {
        this.agentState[agent].lastActivity = Date.now();
        this.setAgentStatus(agent, 'working');
      }
      return ok ? name : null;
    };
    const participants = (arb.participants || []).filter((agent) => AGENTS[agent]);
    const names = await Promise.all(participants.map((agent) => deliver(agent)));
    if (this.arbiter !== arb) return;
    if (names.some((name) => !name)) {
      this.arbiter = null;
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'arbiterError', id: arb.id, error: 'The question could not be delivered to every participating agent.' });
      return;
    }
    arb.phase = 'gathering';
    this.postAgents();
    this.eventLog.append({ type: 'arbiter', id: arb.id, phase: 'delivered' });
    if (this.view) this.view.webview.postMessage({ type: 'arbiterGathering', id: arb.id });
    const gather = (agent, name) => this.waitForMarkedBlock({
      prefix: 'ARBITER',
      id: `${arb.id}-${agent}`,
      file: this.channelFile(`answer-${arb.id}-${agent}.md`),
      paneName: name,
      timeoutMs: 180000,
      active: () => this.arbiter === arb && arb.phase === 'gathering',
    });
    const gathered = await Promise.all(participants.map((agent, i) => gather(agent, names[i])));
    if (this.arbiter !== arb || arb.phase !== 'gathering') return;
    const answers = {};
    participants.forEach((agent, i) => { answers[agent] = gathered[i]; });
    if (!participants.some((agent) => answers[agent])) {
      this.arbiter = null;
      this.cleanupChannel(arb.id);
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'arbiterError', id: arb.id, error: 'No agent returned a marked answer in time.' });
      return;
    }
    arb.phase = 'verdict';
    arb.answers = answers;
    this.postAgents();
    if (this.view) {
      this.view.webview.postMessage({
        type: 'arbiterVerdict', id: arb.id, question, participants,
        answers: byAgent((agent) => (answers[agent] ? answers[agent].slice(0, 20000) : null)),
      });
    }
  }

  arbiterPick(message) {
    const arb = this.arbiter;
    if (!arb || arb.id !== message.id || arb.phase !== 'verdict') return;
    const winner = message.winner;
    if (!AGENTS[winner] || !arb.answers?.[winner]) return;
    this.writerAgent = winner;
    this.context.workspaceState.update('claudeTmux.pairWriter', winner);
    this.eventLog.append({ type: 'arbiter', id: arb.id, phase: 'decided', winner });
    this.cleanupChannel(arb.id);
    this.arbiter = null;
    this.queueInput(winner, 'Your answer to the arbiter question was selected by the user. Proceed accordingly.\r', true, true);
    this.switchAgent(winner);
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'arbiterDone', id: arb.id, winner });
    vscode.window.showInformationMessage(`AgentMux: ${AGENTS[winner].label} won the arbiter round and is now the Pair Mode writer.`);
  }

  cancelArbiter(id) {
    const arb = this.arbiter;
    if (!arb || (id && arb.id !== id)) return;
    this.eventLog.append({ type: 'arbiter', id: arb.id, phase: 'cancelled' });
    this.cleanupChannel(arb.id);
    this.arbiter = null;
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'arbiterCancelled' });
  }

  cancelPairMode() {
    if (this.handoff) {
      vscode.window.showInformationMessage('Finish or cancel the current handoff first.');
      return;
    }
    this.writerAgent = null;
    this.context.workspaceState.update('claudeTmux.pairWriter', undefined);
    this.postAgents();
    vscode.window.showInformationMessage('Pair Mode lock released. Both tabs accept input again.');
  }

  html(webview) {
    const asset = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('hex');

    // Match the official terminal's font so Nerd Font / Powerline glyphs render.
    const termCfg = vscode.workspace.getConfiguration('terminal.integrated');
    const fallback = 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
    let fontFamily = (cfg().get('fontFamily') || '').trim() || (termCfg.get('fontFamily') || '').trim() || fallback;
    if (!/monospace\s*$/.test(fontFamily)) fontFamily += ', monospace';
    const fontSize = (cfg().get('fontSize') || 0) || termCfg.get('fontSize') || 12;
    const cursorStyle = cfg().get('cursorStyle') || 'block';
    const flag = (key) => (cfg().get(key) === false ? '0' : '1');
    const palette = cfg().get('ansiPalette') === 'terminal' ? 'terminal' : 'theme';

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    // Everything agent-shaped in the markup is generated from the registry, so
    // the webview never hardcodes a roster. Ids/labels are registry constants
    // (no user input), and the roster also travels as a data attribute the
    // script parses to build its per-agent state.
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // canStart is false for a free-mode agent: its session is the user's, so
    // there is nothing for AgentMux to launch or resume — the tab simply
    // appears once that session is running.
    const roster = AGENT_IDS.map((agent) => ({
      id: agent,
      label: AGENTS[agent].label,
      mark: AGENTS[agent].mark || derivedMark(AGENTS[agent].label, agent),
      accent: AGENTS[agent].accent || derivedAccent(agent),
      // JSON-encoded into the data attribute: the escape byte travels as the
      // six characters of its \u escape, so no control character reaches the markup.
      modEnter: AGENTS[agent].modEnter || '',
      canStart: !AGENTS[agent].attachSession,
      canList: !!AGENTS[agent].listSessions,
      canResumeLatest: !!AGENTS[agent].resumeLatest && !AGENTS[agent].attachSession,
      installCmd: AGENTS[agent].installCmd || '',
      custom: !!AGENTS[agent].custom,
    }));
    // The accent travels as channels so the stylesheet can build any alpha from
    // it; container queries then swap the label for the mark once a tab is too
    // narrow to say anything useful.
    const tabsHtml = roster.map((a) => `
      <button id="tab-${esc(a.id)}" class="agent-tab hidden" role="tab" data-agent="${esc(a.id)}" aria-selected="false" aria-controls="screen" style="--agent-accent: ${esc(accentChannels(a.accent))}">
        <span class="agent-mark" aria-hidden="true">${esc(a.mark)}</span><span class="agent-label">${esc(a.label)}</span><span class="writer-mark" aria-hidden="true">◆</span><span class="agent-state" aria-hidden="true"></span>
      </button>`).join('');
    // The same accent leads every entry that names an agent, so the launcher
    // and the tabs teach the same colour.
    const swatch = (a) => `<i class="agent-swatch" aria-hidden="true" style="--agent-accent: ${esc(accentChannels(a.accent))}"></i>`;
    const launchMenuHtml = roster.filter((a) => a.canStart).map((a) => `
        <button role="menuitem" data-action="start" data-agent="${esc(a.id)}">${swatch(a)}Start ${esc(a.label)}</button>`
      + (a.canList || a.canResumeLatest
        ? `\n        <button role="menuitem" data-action="attach" data-agent="${esc(a.id)}">${swatch(a)}Resume ${esc(a.label)}…</button>`
        : '')).join('');
    // Free mode belongs in this menu, not only in the command palette: "add a
    // tab for a tmux session I already have" is the same intent as "start an
    // agent", and until now the only way to reach it was knowing the command's
    // name. The Remove entry appears only once there is something to remove.
    const freeMenuHtml = `
        <div class="launch-sep" role="separator"></div>
        <button role="menuitem" data-action="addTmuxSession"><i class="agent-swatch swatch-none" aria-hidden="true"></i>Mirror a tmux session…</button>`
      + (roster.some((a) => a.custom)
        ? `
        <button role="menuitem" data-action="removeCustomAgent"><i class="agent-swatch swatch-none" aria-hidden="true"></i>Remove a custom agent…</button>`
        : '');
    const launcherHtml = roster.filter((a) => a.canStart).map((a) =>
      `\n            <button data-launch-agent="${esc(a.id)}">${swatch(a)}Start ${esc(a.label)}</button>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('main.css')}">
<style nonce="${nonce}">
  #screen, #status-name, .card-sub, .sess-name { font-family: ${fontFamily}; }
  #screen { font-size: ${fontSize}px; }
</style>
</head>
<body>
  <div id="app" data-cursor="${cursorStyle}" data-links="${flag('fileLinks')}" data-palette="${palette}" data-agents="${esc(JSON.stringify(roster))}">
    <div id="agent-tabs" role="tablist" aria-label="Tmux agent">${tabsHtml}
      <button id="tab-add" class="tab-add" type="button" aria-label="Start an agent, or mirror a tmux session" title="Start an agent, or mirror a tmux session" aria-expanded="false" aria-controls="agent-launch-menu">＋</button>
      <div id="agent-launch-menu" class="launch-menu hidden" role="menu">${launchMenuHtml}${freeMenuHtml}
      </div>
    </div>
    <div id="screen-wrap">
      <div id="terminal">
        <div id="screen" tabindex="0" role="tabpanel" aria-label="Tmux terminal mirror"></div>
        <div id="cursor"></div>
      </div>
      <div id="hint">click to type</div>

      <div id="prompt-recall" class="hidden" role="dialog" aria-label="Prompt history">
        <input id="recall-filter" type="text" placeholder="Recall a prompt… (Esc to close)" aria-label="Filter prompt history" />
        <div id="recall-list"></div>
      </div>

      <div id="timeline" class="hidden" role="dialog" aria-label="Session timeline">
        <div id="timeline-head">
          <span class="tl-title">Timeline</span>
          <span class="tl-actions"><button id="timeline-clear">Clear</button><button id="timeline-close" aria-label="Close timeline">✕</button></span>
        </div>
        <div id="timeline-list"></div>
      </div>

      <div id="overlay" class="hidden">
        <div class="card">
          <div class="card-logo">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="currentColor" stroke-width="1.6"/>
              <path fill="currentColor" fill-rule="evenodd" d="M13.8 5.2 H18.6 A2.6 2.6 0 0 1 21.2 7.8 V16.2 A2.6 2.6 0 0 1 18.6 18.8 H13.8 Z M17.5 10 L18 11.5 L19.5 12 L18 12.5 L17.5 14 L17 12.5 L15.5 12 L17 11.5 Z"/>
            </svg>
          </div>
          <div class="card-title" id="overlay-title">Attach to an agent session</div>
          <div class="card-sub" id="overlay-folder"></div>
          <div id="preflight" class="hidden" aria-label="Environment check"></div>
          <input id="session-filter" class="hidden" type="text" placeholder="Filter sessions…" aria-label="Filter sessions" />
          <div id="session-list" aria-label="Existing agent sessions"></div>
          <div id="launcher-actions" class="card-actions hidden">${launcherHtml}
          </div>
          <div class="card-actions">
            <button id="btn-start" class="primary">＋ Start new session</button>
            <button id="btn-resume" class="hidden">↩ Resume previous session</button>
          </div>
        </div>
      </div>
    </div>

    <div id="statusbar">
      <span id="status-name" title="tmux session"></span>
      <span id="status-right">
        <button id="btn-timeline" class="footer-action" title="Session timeline" aria-label="Session timeline">◷</button>
        <button id="btn-arbiter" class="footer-action" title="Ask both agents (arbiter)" aria-label="Ask both agents">⚖</button>
        <button id="btn-findings" class="footer-action hidden" title="Request findings and hand back" aria-label="Request findings and hand back">↩</button>
        <button id="btn-pair" class="footer-action" title="Hand off to the other agent" aria-label="Hand off to the other agent">⇄</button>
        <button id="btn-unlock" class="footer-action hidden" title="Release Pair Mode lock" aria-label="Release Pair Mode lock">◇</button>
        <span id="status-meta"></span>
        <span id="status-state" role="status" aria-live="polite"><span class="dot" id="status-dot"></span><span id="status-label">connecting…</span></span>
      </span>
    </div>

    <div id="arbiter-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="arbiter-title">
      <div class="modal-card">
        <div class="modal-title" id="arbiter-title">Ask both agents</div>
        <div class="modal-meta" id="arbiter-meta">One question, two independent answers, no file changes. The winner becomes Pair Mode writer.</div>
        <div id="arbiter-body">
          <textarea id="arbiter-text" spellcheck="false" placeholder="Design question, bug diagnosis, 'which approach is right'…"></textarea>
        </div>
        <div id="arbiter-error" class="modal-error hidden" role="alert"></div>
        <div class="modal-actions">
          <button id="arbiter-cancel">Cancel</button>
          <button id="arbiter-send" class="primary">Ask both</button>
        </div>
      </div>
    </div>

    <div id="handoff-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <div class="modal-card">
        <div class="modal-title" id="handoff-title">AgentMux handoff</div>
        <div class="modal-meta" id="handoff-meta"></div>
        <label id="handoff-target-label" for="handoff-target" class="hidden">Hand off to</label>
        <select id="handoff-target" class="hidden"></select>
        <label id="handoff-mode-label" for="handoff-mode">Mode</label>
        <select id="handoff-mode">
          <option value="continue">Continue task</option>
          <option value="reviewFix">Review &amp; Fix</option>
          <option value="reviewOnly">Review only</option>
        </select>
        <label id="handoff-text-label" for="handoff-text">Message — fully editable before sending</label>
        <textarea id="handoff-text" spellcheck="false"></textarea>
        <div id="handoff-error" class="modal-error hidden" role="alert"></div>
        <div class="modal-actions">
          <button id="handoff-cancel">Cancel</button>
          <button id="handoff-send" class="primary">Send handoff</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

// ---- activation ------------------------------------------------------------

let activeProvider = null;

function activate(context) {
  try { setStateHookDir(context.globalStorageUri?.fsPath); } catch { setStateHookDir(null); }
  // Free-mode agents join the registry BEFORE anything reads the roster, so
  // every per-agent structure (state, queues, tabs, subscriptions) is built for
  // the full roster exactly once.
  registerCustomAgents();
  const provider = new ClaudeTmuxView(context);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeTmux.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeTmux.restart', () => provider.restart()),
    vscode.commands.registerCommand('claudeTmux.attach', () => provider.attachExisting()),
    vscode.commands.registerCommand('claudeTmux.kill', () => provider.kill()),
    vscode.commands.registerCommand('claudeTmux.killPick', () => provider.killPick()),
    vscode.commands.registerCommand('claudeTmux.handoff', () => provider.prepareHandoff(provider.activeAgent)),
    vscode.commands.registerCommand('claudeTmux.focusAgent', async (agent) => {
      await vscode.commands.executeCommand('claudeTmux.view.focus');
      if (AGENTS[agent]) provider.switchAgent(agent);
    }),
    // The status bar already says which agent wants you; clicking it should
    // take you there rather than to whatever is merely next in the roster.
    vscode.commands.registerCommand('claudeTmux.statusBarCycle', async () => {
      if (provider.pickAttentionAgent()) return provider.gotoAttention();
      const present = provider.presentAgents();
      if (!present.length) return;
      const next = present[(present.indexOf(provider.activeAgent) + 1) % present.length];
      if (next === provider.activeAgent) vscode.commands.executeCommand('claudeTmux.view.focus');
      else provider.switchAgent(next);
    }),
    vscode.commands.registerCommand('claudeTmux.gotoAttention', () => provider.gotoAttention()),
    vscode.commands.registerCommand('claudeTmux.lastAgent', () => provider.gotoLastAgent()),
    vscode.commands.registerCommand('claudeTmux.nextAgent', () => provider.cycleAgent(1)),
    vscode.commands.registerCommand('claudeTmux.prevAgent', () => provider.cycleAgent(-1)),
    vscode.commands.registerCommand('claudeTmux.jumpAgent', (args) => provider.jumpToAgent(args)),
    vscode.commands.registerCommand('claudeTmux.send', (args) => provider.sendToAgent(args)),
    vscode.commands.registerCommand('claudeTmux.capture', (args) => provider.captureAgent(args)),
    vscode.commands.registerCommand('claudeTmux.status', (args) => provider.agentStatus(args)),
    vscode.commands.registerCommand('claudeTmux.waitFor', (args) => provider.waitForAgent(args)),
    vscode.commands.registerCommand('claudeTmux.clearPromptHistory', () => provider.clearPromptHistory()),
    vscode.commands.registerCommand('claudeTmux.explainState', () => provider.explainState()),
    vscode.commands.registerCommand('claudeTmux.explainScreen', (args) => provider.explainScreen(args)),
    vscode.commands.registerCommand('claudeTmux.cleanupSessions', () => provider.cleanupSessions()),
    vscode.commands.registerCommand('claudeTmux.removeIntegrations', () => provider.removeIntegrations()),
    vscode.commands.registerCommand('claudeTmux.manageIntegrations', () => provider.manageIntegrations()),
    vscode.commands.registerCommand('claudeTmux.addTmuxSession', () => provider.addTmuxSession()),
    vscode.commands.registerCommand('claudeTmux.removeCustomAgent', () => provider.removeCustomAgent()),
    vscode.commands.registerCommand('claudeTmux.addAgentFromPreset', () => promptAddAgentPreset()),
    vscode.commands.registerCommand('claudeTmux.mergeWorktree', () => provider.mergeAgentWorktree()),
    vscode.commands.registerCommand('claudeTmux.removeWorktree', () => provider.removeAgentWorktree()),
    vscode.commands.registerCommand('claudeTmux.arbiter', () => provider.prepareArbiter()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTmux.refreshMs')) provider.startLoop();
      // The roster is fixed at activation; a hand-edited list needs a reload.
      if (e.affectsConfiguration('claudeTmux.customAgents') && customAgentsChanged()) {
        provider.offerReload('The AgentMux custom agent list changed.');
      }
      if (e.affectsConfiguration('claudeTmux.transport')) {
        if (!['auto', 'control'].includes(transportMode())) controlClient.destroy(false);
        provider.ensureEventSources();
      }
      if (e.affectsConfiguration('claudeTmux')) {
        provider.invalidateSessionCache();
        for (const state of Object.values(provider.agentState)) state.lastFrame = null;
        provider.tick(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (provider.handoff && provider.view) {
        provider.view.webview.postMessage({ type: 'handoffCancelled' });
      }
      for (const agent of Object.keys(AGENTS)) provider.agentState[agent] = provider.newAgentState();
      provider.resetInputQueues();
      provider.invalidateSessionCache();
      provider.writerAgent = null;
      provider.handoff = null;
      provider.context.workspaceState.update('claudeTmux.pairWriter', undefined);
      provider.postAgents();
      provider.pollPresence(true);
      provider.tick(true);
    }),
  );
}

function deactivate() {
  controlClient.destroy(false);
  if (activeProvider) {
    activeProvider.pipeTap.disarm();
    activeProvider.closeIpcServer();
  }
}

module.exports = { activate, deactivate };
