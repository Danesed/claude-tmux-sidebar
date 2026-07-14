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

function normalizedPath(value) {
  if (!value) return '';
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

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
    this.cols = 80;
    this.rows = 24;
    const savedAgent = context.workspaceState.get('claudeTmux.activeAgent');
    this.activeAgent = AGENTS[savedAgent] ? savedAgent : 'claude';
    this.agentState = {
      claude: { lastFrame: null, sessionsSent: false },
      codex: { lastFrame: null, sessionsSent: false },
    };
    this.unseen = 0;   // changes seen while the view was hidden (badge count)
    this._bg = 0;      // throttle counter for background polling
    this._tickRunning = false;
    this._tickQueued = false;
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
    view.onDidDispose(() => { this.stopLoop(); this.view = null; });

    this.startLoop();
    this.maybeAutoResume();
  }

  clearBadge() {
    this.unseen = 0;
    if (this.view) this.view.badge = undefined;
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
      case 'ready':   this.postActiveAgent(); return this.tick(true);
      case 'switchAgent': return this.switchAgent(m.agent);
      case 'input':   return this.sendKeys(m.data);
      case 'resize':  return this.setSize(m.cols, m.rows);
      case 'start':   return this.startSession();
      case 'attach':  return this.attachExisting();
      case 'resume':  return this.startResumed(m.id);
      case 'refresh': this.agentState[this.activeAgent].sessionsSent = false; return this.tick(true);
      case 'paste':   return this.sendKeys(m.data);
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
    if (!AGENTS[agent] || agent === this.activeAgent) return;
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
  async startResumed(id) {
    if (!id || this.activeAgent !== 'claude') return;
    const args = (cfg().get('claudeArgs') || '').trim();
    const command = `claude --resume ${shellQuote(id)}${args ? ' ' + args : ''}`;
    await this.replaceSession('claude', command, 'Resume');
  }

  async sendKeys(data) {
    if (!data) return;
    const agent = this.activeAgent;
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) return;
    const bytes = Buffer.from(data, 'utf8');
    if (!bytes.length) return;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    await tmux(['send-keys', '-t', tmuxPaneTarget(s), '-H', ...hex]);
    this.tick(true); // refresh immediately so typing feels responsive
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

  async startSession() {
    const agent = this.activeAgent;
    const argsSetting = agent === 'claude' ? 'claudeArgs' : 'codexArgs';
    const args = (cfg().get(argsSetting) || '').trim();
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
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
    await tmux(['set-window-option', '-t', tmuxPaneTarget(s), 'window-size', 'manual']);
    await tmux(['send-keys', '-t', tmuxPaneTarget(s), command, 'Enter']);
    this.agentState[agent].lastFrame = null;
    this.agentState[agent].sessionsSent = false;
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
      await tmux(['kill-session', '-t', tmuxSessionTarget(s)]);
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

  async tick(force) {
    if (this._tickRunning) {
      this._tickQueued = this._tickQueued || force;
      return;
    }
    this._tickRunning = true;
    try {
      await this.tickOnce(force);
    } finally {
      this._tickRunning = false;
      if (this._tickQueued) {
        this._tickQueued = false;
        setTimeout(() => this.tick(true), 0);
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
    const s = await sessionName(agent);
    const configuredScrollback = cfg().get('scrollbackLines');
    const scrollback = Math.trunc(Math.max(0, Math.min(5000, configuredScrollback == null ? 1000 : configuredScrollback)));
    const frame = await tmux([
      'capture-pane', '-p', '-e', '-S', `-${scrollback}`, '-t', tmuxPaneTarget(s),
    ]);
    if (agent !== this.activeAgent) return;

    if (!frame.ok) {
      state.lastFrame = null;
      if (!visible) return;
      this.view.webview.postMessage({ type: 'nosession', agent, name: s, folder: cwd });
      if (!state.sessionsSent) { state.sessionsSent = true; this.pushSessions(agent); }
      return;
    }
    if (!await sessionBelongsToWorkspace(s)) return;
    state.sessionsSent = false;

    const changed = force || frame.out !== state.lastFrame;
    state.lastFrame = frame.out;

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

    // Always send a tiny status (keeps the live dot + cursor + footer fresh even
    // on a static screen); send the heavy frame text only when it changed.
    this.view.webview.postMessage({
      type: 'frame',
      agent,
      frame: changed ? frame.out : null,
      meta: (meta.out || '').trim(),
      name: s,
    });
  }

  // public actions used by commands
  async restart() {
    const agent = this.activeAgent;
    const s = await sessionName(agent);
    if (!await sessionBelongsToWorkspace(s)) return this.startSession();
    await tmux(['send-keys', '-t', tmuxPaneTarget(s), 'C-c']);
    const argsSetting = agent === 'claude' ? 'claudeArgs' : 'codexArgs';
    const args = (cfg().get(argsSetting) || '').trim();
    const command = `${AGENTS[agent].command}${args ? ' ' + args : ''}`;
    await tmux(['send-keys', '-t', tmuxPaneTarget(s), command, 'Enter']);
    this.agentState[agent].lastFrame = null;
    this.tick(true);
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
    await tmux(['kill-session', '-t', tmuxSessionTarget(s)]);
    this.agentState[agent].lastFrame = null;
    this.agentState[agent].sessionsSent = false;
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
        await tmux(['kill-session', '-t', tmuxSessionTarget(it.session)]);
      }
    }
    vscode.window.showInformationMessage(`Killed ${picked.length} tmux session(s).`);
    for (const state of Object.values(this.agentState)) {
      state.lastFrame = null;
      state.sessionsSent = false;
    }
    this.tick(true);
  }

  // Claude uses the extension picker; Codex opens its cwd-filtered native picker.
  async attachExisting() {
    const cwd = workspaceFolder();
    if (!cwd) {
      vscode.window.showWarningMessage('Open a folder before resuming an agent session.');
      return;
    }
    if (this.activeAgent === 'codex') {
      const args = (cfg().get('codexArgs') || '').trim();
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
    await this.startResumed(picked.sessionId);
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
      <button id="tab-claude" class="agent-tab" role="tab" data-agent="claude" aria-selected="false">Claude</button>
      <button id="tab-codex" class="agent-tab" role="tab" data-agent="codex" aria-selected="false">Codex</button>
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
        <span id="status-meta"></span>
        <span id="status-state"><span class="dot" id="status-dot"></span><span id="status-label">connecting…</span></span>
      </span>
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeTmux.refreshMs')) provider.startLoop();
      if (e.affectsConfiguration('claudeTmux')) {
        for (const state of Object.values(provider.agentState)) state.lastFrame = null;
        provider.tick(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const state of Object.values(provider.agentState)) {
        state.lastFrame = null;
        state.sessionsSent = false;
      }
      provider.tick(true);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
