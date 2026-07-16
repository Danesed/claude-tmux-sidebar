const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

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

function tmuxExecFile(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: stdout || '' });
    });
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
    if (!this.usable()) return Promise.resolve({ ok: false, out: '' });
    const parts = 1 + args.reduce((n, a) => n + (a === ';' ? 1 : 0), 0);
    return new Promise((resolve) => {
      const entry = {
        remaining: parts, ok: true, out: '', resolve,
        timer: setTimeout(() => this.destroy(true), 10000),
      };
      for (let i = 0; i < parts; i++) this.pending.push(entry);
      const line = args.map((a) => (a === ';' ? ';' : TmuxControlClient.quoteArg(a))).join(' ');
      try {
        this.proc.stdin.write(line + '\n');
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
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
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
    if (line.startsWith('%begin ')) {
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

  destroy(failed = false) {
    const proc = this.proc;
    this.proc = null;
    this.alive = false;
    const settled = new Set();
    const flush = (entry) => {
      if (!entry || settled.has(entry)) return;
      settled.add(entry);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ ok: false, out: '' });
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
function tmux(args) {
  if (['auto', 'control'].includes(transportMode())
    && TmuxControlClient.controlSafe(args) && controlClient.ensure()) {
    return controlClient.exec(args);
  }
  return tmuxExecFile(args);
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

function runFile(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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

const AGENTS = {
  claude: { label: 'Claude', command: 'claude', prefixSetting: 'sessionPrefix', defaultPrefix: 'tmux_' },
  codex: { label: 'Codex', command: 'codex', prefixSetting: 'codexSessionPrefix', defaultPrefix: 'codex_' },
};

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
  if (!cwd || !AGENTS[agent]) return '';
  const spec = AGENTS[agent];
  const prefix = cfg().get(spec.prefixSetting) || spec.defaultPrefix;
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
  const found = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(base), '#{session_path}']);
  if (!found.ok || normalizedPath(found.out.trim()) === normalizedPath(cwd)) return base;
  return `${base}-${pathHash(cwd)}`;
}

async function sessionBelongsToWorkspace(name) {
  const cwd = workspaceFolder();
  if (!name || !cwd) return false;
  const found = await tmux(['display-message', '-p', '-t', tmuxPaneTarget(name), '#{session_path}']);
  return found.ok && normalizedPath(found.out.trim()) === normalizedPath(cwd);
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
  return String(value || '')
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
const META_FORMAT = '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height},#{session_created},#{history_size},#{session_attached}';

function splitFusedCapture(out) {
  const text = String(out || '');
  const idx = text.lastIndexOf(META_SENTINEL);
  if (idx >= 0) {
    const metaText = text.slice(idx + 1).trim();
    if (/^\d+,\d+,\d+,\d+,\d+,\d+,\d+$/.test(metaText)) {
      return { frame: text.slice(0, idx), meta: metaText };
    }
  }
  return { frame: text, meta: null };
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

const STATE_HOOK_SCRIPT = `#!/bin/sh
# AgentMux: stamp agent state into tmux pane options. Generated file - do not edit.
[ -n "$TMUX_PANE" ] || exit 0
state="$1"
tool=""
if [ "$state" = "working" ] && [ ! -t 0 ]; then
  tool=$(head -c 2000 2>/dev/null | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"]\\{1,40\\}\\)".*/\\1/p' | head -n 1)
fi
tmux set-option -p -t "$TMUX_PANE" @agentmux_state "$state" 2>/dev/null
tmux set-option -p -t "$TMUX_PANE" @agentmux_tool "$tool" 2>/dev/null
exit 0
`;

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
    if (paths) parts.push(`-c ${shellQuote(`notify=${JSON.stringify([paths.script, 'done'])}`)}`);
  }
  return parts.join(' ');
}

function codexArgsHaveDeveloperOverride(configured = (cfg().get('codexArgs') || '')) {
  return /(?:^|\s)(?:-c|--config)\s+[^\n]*developer_instructions\s*=/.test(configured);
}

function isShellCommand(command) {
  return /^(?:ba|da|fi|k|tc|z)?sh$|^(?:fish|nu|pwsh|powershell)$/.test(path.basename(command || ''));
}

async function agentSessionInfo(agent, name) {
  const result = await tmux([
    'display-message', '-p', '-t', tmuxPaneTarget(name),
    '#{session_path}\t#{@claude_tmux_agent}\t#{@claude_tmux_running}\t#{pane_current_command}\t#{session_created}\t#{@claude_tmux_generation}\t#{@agentmux_state}\t#{@agentmux_tool}',
  ]);
  if (!result.ok) return { exists: false, ready: false };
  const [sessionPath, marker, running, command = '', created = '', generation = '', hookState = '', hookTool = '']
    = result.out.replace(/\r?\n$/, '').split('\t');
  if (normalizedPath(sessionPath) !== normalizedPath(workspaceFolder())) return { exists: false, ready: false };
  const shell = isShellCommand(command);
  if (marker === agent) {
    if (running === 'starting' && !shell) {
      await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_running', '1']);
      return { exists: true, ready: true, shell, command, created, generation, hookState, hookTool };
    }
    return { exists: true, ready: running === '1', shell, command, created, generation, hookState, hookTool };
  }
  const direct = agent === 'codex'
    ? /(?:^|-)codex(?:$|-)/i.test(path.basename(command))
    : /claude/i.test(path.basename(command)) || path.basename(command) === 'node';
  return { exists: true, ready: direct, shell, command, created, generation, hookState, hookTool };
}

// Claude stores per-folder transcripts at ~/.claude/projects/<encoded-cwd>/<id>.jsonl
// Encoding: EVERY non-alphanumeric char becomes '-' (so '/', '_', '.', spaces all
// collapse to '-'). Verified against real ~/.claude/projects names.
function getProjectDir(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(process.env.HOME, '.claude', 'projects', encoded);
}

// Parse the folder's JSONL transcripts into a resume list (most recent first).
async function listSessions(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  const sessions = [];
  for (const file of files) {
    const id = file.replace('.jsonl', '');
    let name = null, firstUserMsg = null, lastTs = null;
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(path.join(projectDir, file)),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        try {
          const obj = JSON.parse(line);
          if (obj.timestamp) lastTs = obj.timestamp;
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
        } catch { /* skip malformed line */ }
      }
    } catch { /* skip unreadable file */ }
    sessions.push({ id, name: name || firstUserMsg || id, lastTs });
  }
  sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  return sessions;
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
      sessions.push({ id, name: name || id, lastTs: new Date(mtime).toISOString() });
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
        const newest = this.agent === 'claude' ? this.newestClaude(cwd) : this.newestCodex(cwd);
        if (newest !== this.file) {
          this.reset();
          this.file = newest;
          if (this.file) {
            const size = fs.statSync(this.file).size;
            if (size > 2 * 1024 * 1024) {
              this.offset = size - 512 * 1024;
              this.carry = null; // skip the first partial line; stats become approximate
            }
          }
        }
      }
      if (this.file) this.readAppended();
    } catch { /* best-effort */ }
    finally { this._busy = false; }
    return this.stats;
  }

  newestClaude(cwd) {
    const dir = getProjectDir(cwd);
    if (!fs.existsSync(dir)) return null;
    let best = null;
    let bestM = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > bestM) { bestM = m; best = full; }
      } catch { /* removed mid-scan */ }
    }
    return best;
  }

  newestCodex(cwd) {
    const root = path.join(process.env.HOME || '', '.codex', 'sessions');
    if (!fs.existsSync(root)) return null;
    const dayDirs = [];
    try {
      for (const y of fs.readdirSync(root).sort().reverse().slice(0, 1)) {
        const yDir = path.join(root, y);
        for (const mo of fs.readdirSync(yDir).sort().reverse().slice(0, 2)) {
          const mDir = path.join(yDir, mo);
          for (const d of fs.readdirSync(mDir).sort().reverse().slice(0, 3)) {
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
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const full = path.join(dir, f);
          candidates.push([fs.statSync(full).mtimeMs, full]);
        }
      } catch { /* skip */ }
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const wanted = normalizedPath(cwd);
    for (const [, full] of candidates.slice(0, 10)) {
      if (this._cwdMismatch.has(full)) continue;
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(4096);
        const len = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const first = buf.toString('utf8', 0, len).split('\n')[0];
        const meta = JSON.parse(first);
        const sessionCwd = meta?.payload?.cwd || meta?.cwd || '';
        if (sessionCwd && normalizedPath(sessionCwd) === wanted) return full;
        this._cwdMismatch.add(full);
      } catch { this._cwdMismatch.add(full); }
    }
    return null;
  }

  readAppended() {
    const stat = fs.statSync(this.file);
    if (stat.size < this.offset) { this.offset = 0; this.carry = ''; this.stats = null; }
    if (stat.size === this.offset) return;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = Math.min(stat.size - this.offset, 1024 * 1024);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, this.offset);
      this.offset += read;
      let text = buf.toString('utf8', 0, read);
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
      fs.closeSync(fd);
    }
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
    this.agentState = {
      claude: this.newAgentState(),
      codex: this.newAgentState(),
    };
    this.inputQueues = {
      claude: this.newInputQueue(),
      codex: this.newInputQueue(),
    };
    this.sessionCache = { claude: null, codex: null };
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
    this.tails = { claude: new TranscriptTail('claude'), codex: new TranscriptTail('codex') };
    this._statusItems = null;
    this.arbiter = null;
    this.lastCompletedHandoff = null;
    this._presenceRunning = false;
    this._presenceHiddenSkips = 0;
    this._resizeRunning = false;
    this._resizeQueued = false;
    this._resizePromise = Promise.resolve();
    this.handoff = null;
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
      promptLine: '',          // reconstructed prompt for Alt+Up recall (null = bailed)
      spark: new Uint8Array(60), // ~2 minutes of activity, one slot per 2s
      sparkSlot: null,
    };
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
    else this.sessionCache = { claude: null, codex: null };
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
        spark: this.sparkSeries(agent),
        telemetry: state.telemetry || null,
        delta: state.lastTurnDelta || null,
        lastTool: state.lastTool || '',
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

  // Ambient per-agent status bar items: visible in every editor layout, updated
  // only from this choke point (no extra timers, no extra tmux processes).
  updateStatusBar() {
    if (typeof vscode.window.createStatusBarItem !== 'function') return; // test host
    if (cfg().get('statusBarItems') === false) {
      if (this._statusItems) for (const item of Object.values(this._statusItems)) item.hide();
      return;
    }
    if (!this._statusItems) {
      this._statusItems = {};
      let priority = 62;
      for (const agent of Object.keys(AGENTS)) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority--);
        item.name = `AgentMux ${AGENTS[agent].label}`;
        item.command = { command: 'claudeTmux.focusAgent', arguments: [agent], title: 'Focus agent' };
        this._statusItems[agent] = item;
        this.context.subscriptions.push(item);
      }
    }
    const icons = { working: '$(sync~spin)', done: '$(check)', 'needs-input': '$(report)', idle: '$(terminal)' };
    for (const agent of Object.keys(AGENTS)) {
      const item = this._statusItems[agent];
      const state = this.agentState[agent];
      if (!state.present) { item.hide(); continue; }
      const elapsed = state.status === 'working' ? ' ' + fmtDurationShort(Date.now() - state.statusSince) : '';
      item.text = `${icons[state.status] || icons.idle} ${AGENTS[agent].label}${elapsed}`;
      item.backgroundColor = state.status === 'needs-input'
        ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      const tel = state.telemetry;
      const delta = state.lastTurnDelta;
      item.tooltip = [
        `${AGENTS[agent].label}: ${state.status}${state.lastTool ? ` (${state.lastTool})` : ''}`,
        tel ? `↑${fmtTokens(tel.inTokens)} ↓${fmtTokens(tel.outTokens)} · turn ${tel.turns}${tel.model ? ` · ${tel.model}` : ''}` : '',
        delta ? `Last turn: ${delta.files} file(s) +${delta.insertions} −${delta.deletions}` : '',
        'State is partly heuristic. Click to focus this agent.',
      ].filter(Boolean).join('\n');
      item.show();
    }
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
    if (status === 'working') state.attention = null;
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
    this.postAgents();
    this.updateBadge();
    return true;
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

  // Activity sparkline ring buffer: 60 slots of 2s. Level 1 = output changed,
  // level 2 = the agent is asking for input.
  markSpark(agent, level) {
    const state = this.agentState[agent];
    const slot = Math.floor(Date.now() / 2000);
    if (state.sparkSlot == null || slot - state.sparkSlot >= 60) {
      state.spark.fill(0);
    } else {
      for (let s = state.sparkSlot + 1; s <= slot; s++) state.spark[s % 60] = 0;
    }
    state.spark[slot % 60] = Math.max(state.spark[slot % 60], level);
    state.sparkSlot = slot;
  }

  sparkSeries(agent) {
    const state = this.agentState[agent];
    if (state.sparkSlot == null) return [];
    const slot = Math.floor(Date.now() / 2000);
    if (slot - state.sparkSlot >= 60) return [];
    const series = new Array(60);
    for (let i = 0; i < 60; i++) {
      const s = slot - 59 + i;
      series[i] = s > state.sparkSlot ? 0 : state.spark[((s % 60) + 60) % 60];
    }
    return series;
  }

  updateActivity(agent, frame, changed) {
    const state = this.agentState[agent];
    const now = Date.now();
    if (changed) {
      const tail = stripAnsi(frame).split('\n').slice(-12).join('\n');
      const needsInput = /(?:do you want to|would you like to|allow\s+.+\?|permission required|approval required|press enter to continue|\[[yY]\/[nN]\])/i.test(tail);
      this.markSpark(agent, needsInput ? 2 : 1);
      if (needsInput) {
        this.setAgentStatus(agent, 'needs-input');
        return;
      }
      state.lastChange = now;
      if (state.status === 'working') {
        state.lastActivity = now;
      }
      return;
    }
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
      for (const agent of Object.keys(AGENTS)) {
        const state = this.agentState[agent];
        const cached = this.sessionCache[agent];
        const name = cached?.cwd === cwd ? cached.name : await sessionName(agent);
        const info = await agentSessionInfo(agent, name);
        this.rememberSession(agent, cwd, name, info.ready);
        const present = info.ready;
        if (present && info.hookState && cfg().get('stateHooks') !== false) {
          this.applyHookState(agent, info.hookState, info.hookTool);
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
          const tail = await tmux(['capture-pane', '-p', '-e', '-t', tmuxPaneTarget(name)]);
          if (tail.ok) {
            const frameChanged = tail.out !== state.backgroundFrame;
            state.backgroundFrame = tail.out;
            this.updateActivity(agent, tail.out, frameChanged);
            // This capture is already paid for — ship it to the webview's tab
            // cache so switching paints an at-most-seconds-old frame instantly.
            state.lastFrame = tail.out;
            if (frameChanged && this.view?.visible) {
              this.view.webview.postMessage({ type: 'bgFrame', agent, frame: tail.out });
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
    this.activeAgent = agent;
    const state = this.agentState[agent];
    state.historyMode = false;
    state.historyPending = false;
    this.resetLiveFrame(agent);
    this.context.workspaceState.update('claudeTmux.activeAgent', agent);
    this.clearBadge();
    this.postActiveAgent();
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
    const list = agent === 'codex'
      ? await listCodexSessions(cwd)
      : await listSessions(getProjectDir(cwd));
    this.view.webview.postMessage({
      type: 'sessions',
      agent,
      folder: cwd,
      list: list.map((s) => ({ id: s.id, name: s.name, lastTs: s.lastTs })),
    });
  }

  // Create (or replace) the folder's tmux session running `claude --resume <id>`.
  async startResumed(id, agent = 'claude') {
    if (!id) return;
    if (agent === 'codex') {
      await this.warnCodexRuleConflict();
      const codexArgs = codexLaunchArgs();
      await this.replaceSession('codex', `codex resume ${shellQuote(id)}${codexArgs ? ' ' + codexArgs : ''}`, 'Resume');
      return;
    }
    const args = claudeLaunchArgs();
    const command = `claude --resume ${shellQuote(id)}${args ? ' ' + args : ''}`;
    await this.replaceSession('claude', command, 'Resume');
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
      queue.data = '';
      queue.paste = false;
      queue.timer = null;
    }
    queue.cwd = cwd;
    queue.data += data;
    queue.paste = queue.paste || (immediate && (data.length > 256 || data.includes('\n')));
    if (data.includes('\r')) {
      const state = this.agentState[agent];
      state.lastActivity = Date.now();
      this.setAgentStatus(agent, 'working');
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

  // ---- preflight -------------------------------------------------------------
  // One-shot environment check (never on the live path): are tmux, claude and
  // codex actually reachable from a login shell on this (possibly remote) host?
  async runPreflight(force = false) {
    if (!this._preflight || force) {
      const shell = process.env.SHELL || '/bin/sh';
      const [tmuxVersion, tools] = await Promise.all([
        runFile('tmux', ['-V']),
        runFile(shell, ['-lc', 'echo "C:$(command -v claude)"; echo "X:$(command -v codex)"']),
      ]);
      const lines = (tools.out || '').split('\n');
      const found = (prefix) => lines.some((l) => l.startsWith(prefix) && l.slice(prefix.length).trim());
      this._preflight = {
        tmux: tmuxVersion.ok ? tmuxVersion.out.trim() : null,
        claude: found('C:'),
        codex: found('X:'),
      };
    }
    if (this.view) this.view.webview.postMessage({ type: 'preflight', ...this._preflight });
  }

  flushInput(agent) {
    const queue = this.inputQueues[agent];
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (!queue.data || queue.inFlight) return queue.chain;
    queue.inFlight = true;
    queue.chain = (async () => {
      while (queue.data) {
        const data = queue.data;
        const cwd = queue.cwd;
        const paste = queue.paste;
        queue.data = '';
        queue.cwd = null;
        queue.paste = false;
        const delivered = await this.sendInputData(agent, data, cwd, paste);
        if (!delivered) {
          const pendingBytes = Buffer.byteLength(queue.data, 'utf8');
          queue.data = '';
          queue.cwd = null;
          queue.paste = false;
          if (this.view) this.view.webview.postMessage({
            type: 'inputError', agent,
            failedBytes: Buffer.byteLength(data, 'utf8'),
            pendingBytes,
            pendingDiscarded: pendingBytes > 0,
          });
          this.eventLog.append({
            type: 'input-discarded', agent,
            failedBytes: Buffer.byteLength(data, 'utf8'), pendingBytes,
          });
          return false;
        }
      }
      return true;
    })().finally(() => { queue.inFlight = false; });
    return queue.chain;
  }

  async sendInputData(agent, data, cwd = normalizedPath(workspaceFolder()), paste = false) {
    if (!cwd || normalizedPath(workspaceFolder()) !== cwd) return false;
    // Hot path: reuse the session identity the presence loop verified moments
    // ago, so a keystroke flush costs one tmux process instead of four.
    let s = this.cachedReadySession(agent, cwd);
    if (!s) {
      s = await sessionName(agent);
      const info = await agentSessionInfo(agent, s);
      if (!info.ready) {
        this.invalidateSessionCache(agent);
        return false;
      }
      this.rememberSession(agent, cwd, s, true);
    }
    const bytes = Buffer.from(data, 'utf8');
    if (paste && !data.includes('\0')) {
      const bufferName = `claude-tmux-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const loaded = await tmux(['set-buffer', '-b', bufferName, '--', data]);
      if (!loaded.ok) return false;
      const pasted = await tmux(['paste-buffer', '-dpr', '-b', bufferName, '-t', tmuxPaneTarget(s)]);
      if (!pasted.ok) {
        await tmux(['delete-buffer', '-b', bufferName]);
        this.invalidateSessionCache(agent);
        return false;
      }
      this.tick(false);
      return true;
    }
    for (let start = 0; start < bytes.length; start += 1024) {
      const chunk = bytes.subarray(start, start + 1024);
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0'));
      const sent = await tmux(['send-keys', '-t', tmuxPaneTarget(s), '-H', ...hex]);
      if (!sent.ok) {
        this.invalidateSessionCache(agent);
        return false;
      }
    }
    this.tick(false);
    return true;
  }

  async withInputSuspended(agent, action, requireFlush = false) {
    const queue = this.inputQueues[agent];
    queue.suspended = true;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    try {
      this.flushInput(agent);
      const flushed = await queue.chain;
      if (requireFlush && flushed === false) return false;
      return await action();
    } finally {
      queue.suspended = false;
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
    this.inputQueues = { claude: this.newInputQueue(), codex: this.newInputQueue() };
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
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const args = agent === 'claude' ? claudeLaunchArgs() : codexLaunchArgs();
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
        vscode.window.showErrorMessage(`Cannot start ${AGENTS[agent].label} in tmux session "${s}".`);
        return;
      }
      return this.activateSession(agent);
    }
    await this.createSession(agent, command);
  }

  async createSession(agent, command) {
    const cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder before starting a tmux agent.');
      return;
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
      vscode.window.showErrorMessage(`Cannot start ${AGENTS[agent].label} in tmux session "${s}".`);
      return;
    }
    this.activateSession(agent);
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
    const sent = await tmux(['send-keys', '-t', tmuxPaneTarget(name), `${command}; ${cleanup}`, 'Enter']);
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
    const frame = await tmux(captureArgs);
    const latencyMs = Date.now() - captureStartedAt;
    if (agent !== this.activeAgent) return;
    if (state.historyMode !== historyMode || state.historyPending !== historyPending) return;

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
    });
  }

  // public actions used by commands
  async restart() {
    const agent = this.activeAgent;
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) return this.startSession();
    const args = agent === 'claude' ? claudeLaunchArgs() : codexLaunchArgs();
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
    await this.replaceSession(agent, command, 'Restart');
  }

  async kill() {
    const agent = this.activeAgent;
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) {
      vscode.window.showInformationMessage(`No ${AGENTS[agent].label} tmux session for this workspace.`);
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `Kill tmux session "${s}"? ${AGENTS[agent].label} and anything running in it will stop.`,
      { modal: true }, 'Kill'
    );
    if (pick !== 'Kill') return;
    await this.withInputSuspended(agent, () => tmux(['kill-session', '-t', tmuxSessionTarget(s)]));
    this.invalidateSessionCache(agent);
    this.agentState[agent] = this.newAgentState();
    if (this.writerAgent === agent) {
      this.writerAgent = null;
      this.context.workspaceState.update('claudeTmux.pairWriter', undefined);
    }
    this.postAgents();
    this.pollPresence(true);
    this.tick(true);
  }

  // Manage only the Claude and Codex sessions whose session_path is this root.
  async killPick() {
    const items = [];
    for (const agent of Object.keys(AGENTS)) {
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
      vscode.window.showInformationMessage('No Claude or Codex tmux sessions for this workspace.');
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

  // Claude uses the extension picker; Codex opens its cwd-filtered native picker.
  async attachExisting(agent = this.activeAgent) {
    const cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder before resuming an agent session.');
      return;
    }
    if (agent === 'codex') {
      await this.warnCodexRuleConflict();
      const args = codexLaunchArgs();
      await this.replaceSession('codex', `codex resume${args ? ' ' + args : ''}`, 'Resume');
      return;
    }
    const sessions = await vscode.window.withProgress(
      { location: { viewId: 'claudeTmux.view' }, title: 'Loading Claude sessions…' },
      () => listSessions(getProjectDir(cwd))
    );
    if (!sessions.length) {
      vscode.window.showInformationMessage('No existing Claude sessions found for this folder.');
      return;
    }

    const items = sessions.map((s) => ({
      label: s.name,
      description: s.id.substring(0, 8),
      detail: s.lastTs ? new Date(s.lastTs).toLocaleString() : undefined,
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Resume which Claude session in the side bar?',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    await this.startResumed(picked.sessionId, 'claude');
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
    for (const name of [`draft-${id}.md`, `handoff-${id}.md`, `ack-${id}`, `answer-${id}-claude.md`, `answer-${id}-codex.md`]) {
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
    const target = opts.target && AGENTS[opts.target] ? opts.target : (source === 'claude' ? 'codex' : 'claude');
    const id = crypto.randomBytes(8).toString('hex');
    this.handoff = {
      id, source, target, phase: 'collecting', details: '', createdAt: Date.now(),
      ackToken: crypto.randomBytes(12).toString('hex'),
      findings: !!opts.findings,
      parentId: opts.parentId || undefined,
    };
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'handoffDetails', id, source, target, details: '', findings: !!opts.findings });
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
      return await this.sendInputData(source, prompt, cwd, true)
        && await this.sendInputData(source, '\r', cwd, false);
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
    if (this.tails.claude.file) resumePointers.push(`Claude ${path.basename(this.tails.claude.file, '.jsonl')}`);
    if (this.tails.codex.file) resumePointers.push(`Codex ${path.basename(this.tails.codex.file, '.jsonl').replace(/^rollout-/, '')}`);
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
      return await this.sendInputData(target, payload, cwd, true)
        && await this.sendInputData(target, '\r', cwd, false);
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
    transaction.sentAt = Date.now();
    this.eventLog.append({
      type: 'handoff', id, phase: 'delivered', source, target, mode,
      parentId: transaction.parentId,
      text: text.slice(0, 30000),
      targetName, targetCreated: targetInfo.created, targetGeneration: targetInfo.generation,
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
        if (info.ready && info.created === transaction.targetCreated
          && info.generation === transaction.targetGeneration) return this.completeHandoff(transaction, false);
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
    if (info.created !== transaction.targetCreated || info.generation !== transaction.targetGeneration) {
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
      if (!info.ready || info.created !== last.targetCreated || info.generation !== last.targetGeneration) {
        this.eventLog.append({ type: 'handoff', id: last.id, phase: 'stale' });
        return;
      }
      if (this.handoff) return;
      this.handoff = {
        id: last.id, source: last.source, target: last.target, phase: 'ackTimeout',
        mode: last.mode, previewMode: last.mode,
        texts: { continue: '', reviewOnly: '', reviewFix: '', [last.mode]: last.text || '' },
        targetName: last.targetName, targetCreated: last.targetCreated, targetGeneration: last.targetGeneration,
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
  // One question, both agents in parallel, answers gathered through the .claude
  // channel (pane markers as fallback), verdict picked by the user; the winner
  // becomes the Pair-Mode writer.
  prepareArbiter() {
    if (this.handoff) {
      vscode.window.showInformationMessage('Finish or cancel the current handoff first.');
      return;
    }
    if (this.arbiter) {
      vscode.window.showInformationMessage('An arbiter round is already in progress.');
      return;
    }
    for (const agent of Object.keys(AGENTS)) {
      if (!this.agentState[agent].present || ['working', 'needs-input'].includes(this.agentState[agent].status)) {
        vscode.window.showInformationMessage('Both agents must be running and back at their prompts for an arbiter round.');
        return;
      }
    }
    const id = crypto.randomBytes(8).toString('hex');
    this.arbiter = { id, phase: 'collecting', createdAt: Date.now() };
    this.postAgents();
    if (this.view) this.view.webview.postMessage({ type: 'arbiterPrompt', id });
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
        return await this.sendInputData(agent, prompt, cwd, true)
          && await this.sendInputData(agent, '\r', cwd, false);
      }, true);
      if (ok) {
        this.agentState[agent].lastActivity = Date.now();
        this.setAgentStatus(agent, 'working');
      }
      return ok ? name : null;
    };
    const [claudeName, codexName] = await Promise.all([deliver('claude'), deliver('codex')]);
    if (this.arbiter !== arb) return;
    if (!claudeName || !codexName) {
      this.arbiter = null;
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'arbiterError', id: arb.id, error: 'The question could not be delivered to both agents.' });
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
    const [claudeAnswer, codexAnswer] = await Promise.all([gather('claude', claudeName), gather('codex', codexName)]);
    if (this.arbiter !== arb || arb.phase !== 'gathering') return;
    if (!claudeAnswer && !codexAnswer) {
      this.arbiter = null;
      this.cleanupChannel(arb.id);
      this.postAgents();
      if (this.view) this.view.webview.postMessage({ type: 'arbiterError', id: arb.id, error: 'Neither agent returned a marked answer in time.' });
      return;
    }
    arb.phase = 'verdict';
    arb.answers = { claude: claudeAnswer, codex: codexAnswer };
    this.postAgents();
    if (this.view) {
      this.view.webview.postMessage({
        type: 'arbiterVerdict', id: arb.id, question,
        claude: claudeAnswer ? claudeAnswer.slice(0, 20000) : null,
        codex: codexAnswer ? codexAnswer.slice(0, 20000) : null,
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
    // Optional vendored xterm.js renderer (no CDN: CSP allows only local assets).
    const useXterm = cfg().get('renderer') === 'xterm'
      && fs.existsSync(path.join(this.context.extensionUri.fsPath || String(this.context.extensionUri), 'media', 'vendor', 'xterm.js'));
    const xtermAssets = useXterm
      ? `<link rel="stylesheet" href="${asset('vendor/xterm.css')}">\n<script nonce="${nonce}" src="${asset('vendor/xterm.js')}"></script>`
      : '';

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('main.css')}">
${xtermAssets}
<style nonce="${nonce}">
  #screen, #status-name, .card-sub, .sess-name { font-family: ${fontFamily}; }
  #screen { font-size: ${fontSize}px; }
</style>
</head>
<body>
  <div id="app" data-cursor="${cursorStyle}" data-predict="${flag('predictiveEcho')}" data-links="${flag('fileLinks')}" data-sparks="${flag('showSparklines')}" data-renderer="${useXterm ? 'xterm' : 'dom'}">
    <div id="agent-tabs" role="tablist" aria-label="Tmux agent">
      <button id="tab-claude" class="agent-tab hidden" role="tab" data-agent="claude" aria-selected="false" aria-controls="screen">
        <span class="agent-label">Claude</span><canvas class="agent-spark" width="48" height="10" aria-hidden="true"></canvas><span class="writer-mark" aria-hidden="true">◆</span><span class="agent-state" aria-hidden="true"></span>
      </button>
      <button id="tab-codex" class="agent-tab hidden" role="tab" data-agent="codex" aria-selected="false" aria-controls="screen">
        <span class="agent-label">Codex</span><canvas class="agent-spark" width="48" height="10" aria-hidden="true"></canvas><span class="writer-mark" aria-hidden="true">◆</span><span class="agent-state" aria-hidden="true"></span>
      </button>
      <button id="tab-add" class="tab-add" type="button" aria-label="Start or resume an agent" title="Start or resume an agent" aria-expanded="false" aria-controls="agent-launch-menu">＋</button>
      <div id="agent-launch-menu" class="launch-menu hidden" role="menu">
        <button role="menuitem" data-action="start" data-agent="claude">Start Claude</button>
        <button role="menuitem" data-action="attach" data-agent="claude">Resume Claude…</button>
        <button role="menuitem" data-action="start" data-agent="codex">Start Codex</button>
        <button role="menuitem" data-action="attach" data-agent="codex">Resume Codex…</button>
      </div>
    </div>
    <div id="screen-wrap">
      <div id="terminal">
        <div id="screen" tabindex="0" role="tabpanel" aria-label="Tmux terminal mirror"></div>
        <div id="cursor"></div>
        <div id="predict" aria-hidden="true"></div>
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
          <div class="card-title" id="overlay-title">Attach to a Claude session</div>
          <div class="card-sub" id="overlay-folder"></div>
          <div id="preflight" class="hidden" aria-label="Environment check"></div>
          <input id="session-filter" class="hidden" type="text" placeholder="Filter sessions…" aria-label="Filter sessions" />
          <div id="session-list" aria-label="Existing Claude sessions"></div>
          <div id="launcher-actions" class="card-actions hidden">
            <button data-launch-agent="claude">Start Claude</button>
            <button data-launch-agent="codex">Start Codex</button>
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
  try { stateHookDir = context.globalStorageUri?.fsPath || null; } catch { stateHookDir = null; }
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
    vscode.commands.registerCommand('claudeTmux.clearPromptHistory', () => provider.clearPromptHistory()),
    vscode.commands.registerCommand('claudeTmux.arbiter', () => provider.prepareArbiter()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTmux.refreshMs')) provider.startLoop();
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
  if (activeProvider) activeProvider.pipeTap.disarm();
}

module.exports = { activate, deactivate };
