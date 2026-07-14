const vscode = require('vscode');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---- helpers ---------------------------------------------------------------

// Run tmux with an argv array (no shell -> no quoting/injection issues).
// Resolves { ok, out } where ok=false means tmux exited non-zero (e.g. no session).
function tmux(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: stdout || '' });
    });
  });
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

const CODEX_CLAUDE_RULES = [
  'Before doing any work, recursively discover and read every Markdown file under the workspace .claude directory.',
  'Treat those Markdown files as the canonical project instructions and respect any path-specific scopes they declare.',
  'Do not follow symlinks while discovering them, and ignore non-Markdown files such as settings, hooks, caches, databases, and credentials.',
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
  return parts.join(' ');
}

function codexArgsHaveDeveloperOverride(configured = (cfg().get('codexArgs') || '')) {
  return /(?:^|\s)(?:-c|--config)\s+[^\n]*developer_instructions\s*=/.test(configured);
}

function isShellCommand(command) {
  return /^(?:ba|da|fi|k|tc|z)?sh$|^(?:fish|nu|pwsh|powershell)$/.test(path.basename(command || ''));
}

async function agentSessionInfo(agent, name) {
  if (!await sessionBelongsToWorkspace(name)) return { exists: false, ready: false };
  const result = await tmux([
    'display-message', '-p', '-t', tmuxPaneTarget(name),
    '#{@claude_tmux_agent}\t#{@claude_tmux_running}\t#{pane_current_command}',
  ]);
  if (!result.ok) return { exists: false, ready: false };
  const [marker, running, command = ''] = result.out.replace(/\r?\n$/, '').split('\t');
  const shell = isShellCommand(command);
  if (marker === agent) {
    if (running === 'starting' && !shell) {
      await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_running', '1']);
      return { exists: true, ready: true, shell, command };
    }
    return { exists: true, ready: running === '1', shell, command };
  }
  const direct = agent === 'codex'
    ? /(?:^|-)codex(?:$|-)/i.test(path.basename(command))
    : /claude/i.test(path.basename(command)) || path.basename(command) === 'node';
  return { exists: true, ready: direct, shell, command };
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
    this._bg = 0;      // throttle counter for background polling
    this._tickRunning = false;
    this._tickQueued = false;
    this._tickForce = false;
    this._presenceRunning = false;
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
    };
  }

  newInputQueue() {
    return { data: '', cwd: null, paste: false, timer: null, chain: Promise.resolve(), suspended: false };
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
  }

  clearBadge() {
    this.unseen = 0;
    if (this.view) this.view.badge = undefined;
  }

  postAgents() {
    if (!this.view) return;
    const agents = {};
    for (const agent of Object.keys(AGENTS)) {
      const state = this.agentState[agent];
      agents[agent] = { present: state.present, status: state.status };
    }
    this.view.webview.postMessage({
      type: 'agents',
      agents,
      activeAgent: this.activeAgent,
      writerAgent: this.writerAgent,
      hasWorkspace: !!workspaceFolder(),
    });
  }

  setAgentStatus(agent, status) {
    const state = this.agentState[agent];
    if (state.status === status) return false;
    state.status = status;
    state.statusSince = Date.now();
    this.postAgents();
    return true;
  }

  updateActivity(agent, frame, changed) {
    const state = this.agentState[agent];
    const now = Date.now();
    const tail = stripAnsi(frame).split('\n').slice(-12).join('\n');
    const needsInput = /(?:do you want to|would you like to|allow\s+.+\?|permission required|approval required|press enter to continue|\[[yY]\/[nN]\])/i.test(tail);
    if (needsInput) {
      this.setAgentStatus(agent, 'needs-input');
      return;
    }
    if (changed) {
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
        const name = await sessionName(agent);
        const info = await agentSessionInfo(agent, name);
        this.rememberSession(agent, cwd, name, info.ready);
        const present = info.ready;
        if (state.present !== present) {
          state.present = present;
          state.lastFrame = null;
          state.lastLiveFrame = null;
          state.historyMode = false;
          state.historyPending = false;
          changed = true;
          if (!present) this.setAgentStatus(agent, 'idle');
        }
        if (present && agent !== this.activeAgent) {
          const tail = await tmux(['capture-pane', '-p', '-e', '-t', tmuxPaneTarget(name)]);
          if (tail.ok) {
            const frameChanged = tail.out !== state.backgroundFrame;
            state.backgroundFrame = tail.out;
            this.updateActivity(agent, tail.out, frameChanged);
          }
        }
      }

      if (this.writerAgent && !this.agentState[this.writerAgent].present) {
        this.writerAgent = null;
        this.context.workspaceState.update('claudeTmux.pairWriter', undefined);
        changed = true;
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
    } finally {
      this._presenceRunning = false;
    }
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
      case 'ready':   this.postActiveAgent(); this.pollPresence(true); return this.tick(true);
      case 'switchAgent': return this.switchAgent(m.agent);
      case 'input':   return this.queueInput(m.agent, m.data);
      case 'resize':  return this.setSize(m.cols, m.rows);
      case 'start':   return this.startSession(m.agent);
      case 'attach':  return this.attachExisting(m.agent);
      case 'resume':  return this.startResumed(m.id, m.agent);
      case 'refresh': this.agentState[this.activeAgent].sessionsSent = false; return this.tick(true);
      case 'paste':   return this.queueInput(m.agent, m.data, true);
      case 'historyMode': return this.setHistoryMode(m.agent, m.enabled);
      case 'prepareHandoff': return this.prepareHandoff(m.source);
      case 'confirmHandoff': return this.confirmHandoff(m);
      case 'cancelPair': return this.cancelPairMode();
    }
  }

  postActiveAgent() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'activeAgent',
      agent: this.activeAgent,
      label: AGENTS[this.activeAgent].label,
    });
  }

  switchAgent(agent) {
    if (!AGENTS[agent] || !this.agentState[agent].present || agent === this.activeAgent) return;
    this.activeAgent = agent;
    this.context.workspaceState.update('claudeTmux.activeAgent', agent);
    this.clearBadge();
    this.postActiveAgent();
    this.maybeAutoResume();
    this.setSize(this.cols, this.rows);
  }

  // Push the folder's past conversations to the webview list (once per
  // disconnected state, to avoid re-reading JSONL every tick).
  async pushSessions(agent = this.activeAgent) {
    if (!this.view) return;
    const cwd = workspaceFolder();
    if (!cwd) return;
    if (agent === 'codex') {
      this.view.webview.postMessage({ type: 'sessions', agent, folder: cwd, list: [] });
      return;
    }
    const list = await listSessions(getProjectDir(cwd));
    this.view.webview.postMessage({
      type: 'sessions',
      agent,
      folder: cwd,
      list: list.map((s) => ({ id: s.id, name: s.name, lastTs: s.lastTs })),
    });
  }

  // Create (or replace) the folder's tmux session running `claude --resume <id>`.
  async startResumed(id, agent = 'claude') {
    if (!id || agent !== 'claude') return;
    const args = (cfg().get('claudeArgs') || '').trim();
    const command = `claude --resume ${shellQuote(id)}${args ? ' ' + args : ''}`;
    await this.replaceSession('claude', command, 'Resume');
  }

  queueInput(agent, data, immediate = false, system = false) {
    if (!AGENTS[agent] || !data) return Promise.resolve();
    const queue = this.inputQueues[agent];
    if (queue.suspended && !system) {
      if (this.view) this.view.webview.postMessage({ type: 'inputSuspended', agent });
      return Promise.resolve();
    }
    if (!system && this.writerAgent && agent !== this.writerAgent) {
      if (this.view) this.view.webview.postMessage({ type: 'inputLocked', agent, writerAgent: this.writerAgent });
      return Promise.resolve();
    }
    const cwd = normalizedPath(workspaceFolder());
    if (!cwd) return Promise.resolve();
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

  flushInput(agent) {
    const queue = this.inputQueues[agent];
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    const data = queue.data;
    const cwd = queue.cwd;
    const paste = queue.paste;
    queue.data = '';
    queue.cwd = null;
    queue.paste = false;
    if (!data) return queue.chain;
    queue.chain = queue.chain.then(() => this.sendInputData(agent, data, cwd, paste));
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

  async withInputSuspended(agent, action) {
    const queue = this.inputQueues[agent];
    queue.suspended = true;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    queue.data = '';
    queue.cwd = null;
    try {
      await queue.chain;
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
    const s = await sessionName(this.activeAgent);
    if (!await sessionBelongsToWorkspace(s)) {
      this.tick(true);
      return;
    }
    // Detach window size from any attached client and force our size.
    await tmux(['set-window-option', '-t', tmuxPaneTarget(s), 'window-size', 'manual']);
    await tmux(['resize-window', '-t', tmuxPaneTarget(s), '-x', String(cols), '-y', String(rows)]);
    this.tick(true);
  }

  async startSession(agent = this.activeAgent) {
    if (!AGENTS[agent]) return;
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const args = agent === 'claude' ? (cfg().get('claudeArgs') || '').trim() : codexLaunchArgs();
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
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_agent', agent]);
    await tmux(['set-option', '-p', '-t', tmuxPaneTarget(name), '@claude_tmux_running', 'starting']);
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
    const state = this.agentState[agent];
    state.lastFrame = null;
    state.lastLiveFrame = null;
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

  startLoop() {
    this.stopLoop();
    const ms = Math.max(80, cfg().get('refreshMs') || 250);
    this.timer = setInterval(() => this.tick(false), ms);
  }

  stopLoop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stopLoops() {
    this.stopLoop();
    if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = null; }
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
    if (!enabled) state.lastLiveFrame = null;
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
      this._bg = (this._bg + 1) % 6;
      if (this._bg !== 0) return;
    } else {
      this._bg = 0;
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
    const frame = await tmux(captureArgs);
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
      state.lastLiveFrame = null;
      state.present = false;
      this.postAgents();
      if (visible) this.view.webview.postMessage({ type: 'nosession', agent, name: s, folder: cwd });
      if (!state.sessionsSent) { state.sessionsSent = true; this.pushSessions(agent); }
      return;
    }
    state.sessionsSent = false;

    const frameChanged = frame.out !== state.lastLiveFrame;
    const changed = force || frameChanged;
    state.present = true;
    if (captureHistory) {
      state.historyPending = false;
    } else {
      state.lastLiveFrame = frame.out;
      this.updateActivity(agent, frame.out, frameChanged);
    }

    if (!visible) {
      if (changed) {
        this.unseen++;
        this.view.badge = { value: this.unseen, tooltip: `${AGENTS[agent].label}: ${this.unseen} new update(s)` };
      }
      return;
    }

    const meta = await tmux([
      'display-message', '-p', '-t', tmuxPaneTarget(s),
      '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height},#{session_created},#{history_size}',
    ]);
    if (agent !== this.activeAgent) return;
    const metaText = (meta.out || '').trim();
    const metaParts = metaText.split(',');
    state.historySize = parseInt(metaParts[5], 10) || 0;

    // Always send a tiny status (keeps the live dot + cursor + footer fresh even
    // on a static screen); send the heavy frame text only when it changed.
    this.view.webview.postMessage({
      type: 'frame',
      agent,
      frame: captureHistory ? frame.out : (!historyMode && changed ? frame.out : null),
      meta: metaText,
      name: s,
      historyMode,
      historyAvailable: Math.min(state.historySize, scrollback),
    });
  }

  // public actions used by commands
  async restart() {
    const agent = this.activeAgent;
    if (agent === 'codex') await this.warnCodexRuleConflict();
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) return this.startSession();
    const args = agent === 'claude' ? (cfg().get('claudeArgs') || '').trim() : codexLaunchArgs();
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
    await this.withInputSuspended(agent, async () => {
      await tmux(['kill-session', '-t', tmuxSessionTarget(s)]);
      this.invalidateSessionCache(agent);
      await this.createSession(agent, command);
    });
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

  async prepareHandoff(source = this.activeAgent) {
    if (!AGENTS[source] || !this.agentState[source].present) return;
    if (this.writerAgent && this.writerAgent !== source) {
      vscode.window.showInformationMessage(`Pair Mode writer is ${AGENTS[this.writerAgent].label}. Switch to that tab to hand off.`);
      return;
    }
    if (this.agentState[source].status === 'working') {
      vscode.window.showWarningMessage(`Wait for ${AGENTS[source].label} to finish or stop its turn before handing off.`);
      return;
    }

    const target = source === 'claude' ? 'codex' : 'claude';
    if (!this.agentState[target].present) {
      const choice = await vscode.window.showInformationMessage(
        `Start ${AGENTS[target].label} before preparing the handoff?`,
        { modal: true }, 'Start and continue'
      );
      if (choice !== 'Start and continue') return;
      await this.startSession(target);
      if (!this.agentState[target].present) return;
      this.switchAgent(source);
    }
    if (['working', 'needs-input'].includes(this.agentState[target].status)) {
      vscode.window.showWarningMessage(`Make sure ${AGENTS[target].label} is back at its normal prompt before handing off.`);
      return;
    }

    const cwd = workspaceFolder();
    const [status, diff, staged] = await Promise.all([
      runFile('git', ['status', '--short'], cwd),
      runFile('git', ['diff', '--stat'], cwd),
      runFile('git', ['diff', '--cached', '--stat'], cwd),
    ]);
    const sourceName = await sessionName(source);
    const captured = await tmux(['capture-pane', '-p', '-S', '-60', '-t', tmuxPaneTarget(sourceName)]);
    const tail = stripAnsi(captured.out).split('\n').slice(-60).join('\n').trim().slice(-6000);
    const context = [
      `Handoff from ${AGENTS[source].label} to ${AGENTS[target].label}.`,
      '',
      'Before doing anything, recursively read and follow every Markdown instruction under .claude/.',
      'Inspect the current working tree and preserve valid changes made by the other agent.',
      '',
      'Git status:',
      status.ok && status.out.trim() ? status.out.trim() : '(clean or unavailable)',
      '',
      'Unstaged diff summary:',
      diff.ok && diff.out.trim() ? diff.out.trim() : '(none)',
      '',
      'Staged diff summary:',
      staged.ok && staged.out.trim() ? staged.out.trim() : '(none)',
      '',
      `Recent ${AGENTS[source].label} terminal context:`,
      tail || '(no terminal context captured)',
    ].join('\n');
    const reviewOnly = [
      context,
      '',
      'Review only: inspect the diff, run relevant read-only checks/tests, and report concrete findings. Do not modify files.',
    ].join('\n');
    const reviewFix = [
      context,
      '',
      'Review & Fix: inspect the diff, run relevant tests, fix confirmed issues without undoing valid work, and verify the final result.',
    ].join('\n');
    if (this.view) {
      this.view.webview.postMessage({ type: 'handoffDraft', source, target, reviewOnly, reviewFix });
    }
  }

  async confirmHandoff(message) {
    const { source, target, text, mode } = message;
    if (!AGENTS[source] || !AGENTS[target] || source === target || typeof text !== 'string') {
      return this.postHandoffResult(false, 'Invalid handoff request.');
    }
    if (!text.trim() || text.length > 30000) {
      return this.postHandoffResult(false, 'Handoff text must contain 1–30,000 characters.');
    }
    if (this.agentState[source].status === 'working' || ['working', 'needs-input'].includes(this.agentState[target].status)) {
      return this.postHandoffResult(false, 'An agent is not ready for handoff. Wait for work to finish and clear any target prompt, then send again.');
    }
    const targetName = await sessionName(target);
    const targetInfo = await agentSessionInfo(target, targetName);
    if (!targetInfo.ready) {
      this.pollPresence(true);
      return this.postHandoffResult(false, `${AGENTS[target].label} is no longer running in this workspace tmux.`);
    }
    const sent = await this.withInputSuspended(target, async () => {
      const cwd = normalizedPath(workspaceFolder());
      return await this.sendInputData(target, text, cwd, true)
        && await this.sendInputData(target, '\r', cwd, false);
    });
    if (!sent) {
      return this.postHandoffResult(false, `The handoff could not be delivered to ${AGENTS[target].label}. Your edited text is still available.`);
    }
    this.writerAgent = target;
    this.context.workspaceState.update('claudeTmux.pairWriter', target);
    this.activeAgent = target;
    this.context.workspaceState.update('claudeTmux.activeAgent', target);
    const state = this.agentState[target];
    state.lastActivity = Date.now();
    this.setAgentStatus(target, 'working');
    this.postActiveAgent();
    this.postAgents();
    this.setSize(this.cols, this.rows);
    this.postHandoffResult(true);
    vscode.window.showInformationMessage(
      `Pair Mode: ${AGENTS[target].label} owns the workspace (${mode === 'reviewOnly' ? 'review only' : 'review & fix'}).`
    );
  }

  postHandoffResult(ok, error = '') {
    if (this.view) this.view.webview.postMessage({ type: 'handoffResult', ok, error });
  }

  cancelPairMode() {
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
<style nonce="${nonce}">
  #screen, #status-name, .card-sub, .sess-name { font-family: ${fontFamily}; }
  #screen { font-size: ${fontSize}px; }
</style>
</head>
<body>
  <div id="app" data-cursor="${cursorStyle}">
    <div id="agent-tabs" role="tablist" aria-label="Tmux agent">
      <button id="tab-claude" class="agent-tab hidden" role="tab" data-agent="claude" aria-selected="false">
        <span class="agent-label">Claude</span><span class="writer-mark" aria-hidden="true">◆</span><span class="agent-state" aria-hidden="true"></span>
      </button>
      <button id="tab-codex" class="agent-tab hidden" role="tab" data-agent="codex" aria-selected="false">
        <span class="agent-label">Codex</span><span class="writer-mark" aria-hidden="true">◆</span><span class="agent-state" aria-hidden="true"></span>
      </button>
      <button id="tab-add" class="tab-add" type="button" aria-label="Start or resume an agent" title="Start or resume an agent">＋</button>
      <div id="agent-launch-menu" class="launch-menu hidden">
        <button data-action="start" data-agent="claude">Start Claude</button>
        <button data-action="attach" data-agent="claude">Resume Claude…</button>
        <button data-action="start" data-agent="codex">Start Codex</button>
        <button data-action="attach" data-agent="codex">Resume Codex…</button>
      </div>
    </div>
    <div id="screen-wrap">
      <div id="terminal">
        <div id="screen" tabindex="0" aria-label="Tmux terminal mirror"></div>
        <div id="cursor"></div>
      </div>
      <div id="hint">click to type</div>

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
        <button id="btn-pair" class="footer-action" title="Hand off to the other agent" aria-label="Hand off to the other agent">⇄</button>
        <button id="btn-unlock" class="footer-action hidden" title="Release Pair Mode lock" aria-label="Release Pair Mode lock">◇</button>
        <span id="status-meta"></span>
        <span id="status-state"><span class="dot" id="status-dot"></span><span id="status-label">connecting…</span></span>
      </span>
    </div>

    <div id="handoff-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <div class="modal-card">
        <div class="modal-title" id="handoff-title">Pair Mode handoff</div>
        <label for="handoff-mode">Mode</label>
        <select id="handoff-mode">
          <option value="reviewFix">Review &amp; Fix</option>
          <option value="reviewOnly">Review only</option>
        </select>
        <label for="handoff-text">Message — fully editable before sending</label>
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

function activate(context) {
  const provider = new ClaudeTmuxView(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeTmux.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('claudeTmux.restart', () => provider.restart()),
    vscode.commands.registerCommand('claudeTmux.attach', () => provider.attachExisting()),
    vscode.commands.registerCommand('claudeTmux.kill', () => provider.kill()),
    vscode.commands.registerCommand('claudeTmux.killPick', () => provider.killPick()),
    vscode.commands.registerCommand('claudeTmux.handoff', () => provider.prepareHandoff(provider.activeAgent)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTmux.refreshMs')) provider.startLoop();
      if (e.affectsConfiguration('claudeTmux')) {
        for (const state of Object.values(provider.agentState)) state.lastFrame = null;
        provider.tick(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const agent of Object.keys(AGENTS)) provider.agentState[agent] = provider.newAgentState();
      provider.resetInputQueues();
      provider.invalidateSessionCache();
      provider.writerAgent = null;
      provider.context.workspaceState.update('claudeTmux.pairWriter', undefined);
      provider.pollPresence(true);
      provider.tick(true);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
