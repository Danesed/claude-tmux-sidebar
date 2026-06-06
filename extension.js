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
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME;
}

// Session name == <prefix><basename(folder)>, identical to the ct CLI and the
// Focus extension, so all three drive the SAME tmux session.
function sessionName() {
  const prefix = cfg().get('sessionPrefix') || 'Claude_';
  return prefix + path.basename(workspaceFolder());
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
    this.lastFrame = null;
    this.sessionsSent = false;
    this.unseen = 0;   // changes seen while the view was hidden (badge count)
    this._bg = 0;      // throttle counter for background polling
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
    view.onDidDispose(() => this.stopLoop());

    this.startLoop();
    this.maybeAutoResume();
    this.tick(true);
  }

  clearBadge() {
    this.unseen = 0;
    if (this.view) this.view.badge = undefined;
  }

  // Optionally resume the folder's most recent conversation on open.
  async maybeAutoResume() {
    if (!cfg().get('autoResume')) return;
    const s = sessionName();
    const has = await tmux(['has-session', '-t', s]);
    if (has.ok) return; // already running
    const list = await listSessions(getProjectDir(workspaceFolder()));
    if (list.length) await this.startResumed(list[0].id);
  }

  onMessage(m) {
    switch (m.type) {
      case 'input':   return this.sendKeys(m.data);
      case 'resize':  return this.setSize(m.cols, m.rows);
      case 'start':   return this.startSession();
      case 'attach':  return this.attachExisting();
      case 'resume':  return this.startResumed(m.id);
      case 'refresh': this.sessionsSent = false; return this.tick(true);
      case 'paste':   return this.sendKeys(m.data);
    }
  }

  // Push the folder's past conversations to the webview list (once per
  // disconnected state, to avoid re-reading JSONL every tick).
  async pushSessions() {
    if (!this.view) return;
    const cwd = workspaceFolder();
    const list = await listSessions(getProjectDir(cwd));
    this.view.webview.postMessage({
      type: 'sessions',
      folder: cwd,
      list: list.map((s) => ({ id: s.id, name: s.name, lastTs: s.lastTs })),
    });
  }

  // Create (or replace) the folder's tmux session running `claude --resume <id>`.
  async startResumed(id) {
    if (!id) return;
    const s = sessionName();
    const cwd = workspaceFolder();
    const running = await tmux(['has-session', '-t', s]);
    if (running.ok) {
      const go = await vscode.window.showWarningMessage(
        `Replace the current "${s}" session with the selected conversation? The running one will stop.`,
        { modal: true }, 'Resume'
      );
      if (go !== 'Resume') return;
      await tmux(['kill-session', '-t', s]);
    }
    const args = (cfg().get('claudeArgs') || '').trim();
    await tmux(['new-session', '-d', '-s', s, '-x', String(this.cols || 80), '-y', String(this.rows || 24), '-c', cwd]);
    await tmux(['set-option', '-t', s, 'window-size', 'manual']);
    await tmux(['send-keys', '-t', s, `claude --resume ${id}${args ? ' ' + args : ''}`, 'Enter']);
    this.sessionsSent = false;
    this.tick(true);
  }

  async sendKeys(data) {
    if (!data) return;
    const bytes = Buffer.from(data, 'utf8');
    if (!bytes.length) return;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    await tmux(['send-keys', '-t', sessionName(), '-H', ...hex]);
    this.tick(true); // refresh immediately so typing feels responsive
  }

  async setSize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    const s = sessionName();
    // Detach window size from any attached client and force our size.
    await tmux(['set-option', '-t', s, 'window-size', 'manual']);
    await tmux(['resize-window', '-t', s, '-x', String(cols), '-y', String(rows)]);
    this.tick(true);
  }

  async startSession() {
    const s = sessionName();
    const cwd = workspaceFolder();
    await tmux(['new-session', '-d', '-s', s, '-x', String(this.cols || 80), '-y', String(this.rows || 24), '-c', cwd]);
    await tmux(['set-option', '-t', s, 'window-size', 'manual']);
    const args = (cfg().get('claudeArgs') || '').trim();
    await tmux(['send-keys', '-t', s, args ? `claude ${args}` : 'claude', 'Enter']);
    this.tick(true);
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
    if (!this.view) return;
    const visible = this.view.visible;

    // When hidden, poll slowly just to drive the "unread activity" badge.
    if (!visible) {
      this._bg = (this._bg + 1) % 6;
      if (this._bg !== 0) return;
    } else {
      this._bg = 0;
    }

    const s = sessionName();
    const frame = await tmux(['capture-pane', '-p', '-e', '-t', s]);

    if (!frame.ok) {
      this.lastFrame = null;
      if (!visible) return;
      this.view.webview.postMessage({ type: 'nosession', name: s, folder: workspaceFolder() });
      if (!this.sessionsSent) { this.sessionsSent = true; this.pushSessions(); }
      return;
    }
    this.sessionsSent = false;

    const changed = force || frame.out !== this.lastFrame;
    this.lastFrame = frame.out;

    if (!visible) {
      if (changed) {
        this.unseen++;
        this.view.badge = { value: this.unseen, tooltip: `Claude: ${this.unseen} new update(s)` };
      }
      return;
    }

    const meta = await tmux([
      'display-message', '-p', '-t', s,
      '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height},#{session_created}',
    ]);

    // Always send a tiny status (keeps the live dot + cursor + footer fresh even
    // on a static screen); send the heavy frame text only when it changed.
    this.view.webview.postMessage({
      type: 'frame',
      frame: changed ? frame.out : null,
      meta: (meta.out || '').trim(),
      name: s,
    });
  }

  // public actions used by commands
  async restart() {
    const s = sessionName();
    const has = await tmux(['has-session', '-t', s]);
    if (!has.ok) return this.startSession();
    await tmux(['send-keys', '-t', s, 'C-c']);
    const args = (cfg().get('claudeArgs') || '').trim();
    await tmux(['send-keys', '-t', s, args ? `claude ${args}` : 'claude', 'Enter']);
    this.tick(true);
  }

  async kill() {
    const s = sessionName();
    const pick = await vscode.window.showWarningMessage(
      `Kill tmux session "${s}"? Claude and anything running in it will stop.`,
      { modal: true }, 'Kill'
    );
    if (pick !== 'Kill') return;
    await tmux(['kill-session', '-t', s]);
    this.tick(true);
  }

  // Manage / delete ANY of your tmux sessions (multi-select). tmux is per-user,
  // so this can only ever list and kill your own sessions.
  async killPick() {
    const list = await tmux(['ls', '-F', '#{session_name}\t#{session_windows}\t#{?session_attached,attached,detached}']);
    if (!list.ok || !list.out.trim()) {
      vscode.window.showInformationMessage('No tmux sessions for your user.');
      return;
    }
    const mine = sessionName();
    const items = list.out.trim().split('\n').map((line) => {
      const [name, wins, state] = line.split('\t');
      return {
        label: name === mine ? `$(star-full) ${name}` : name,
        description: `${wins} window(s) · ${state}`,
        session: name,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select tmux session(s) to kill (only yours are listed)',
    });
    if (!picked || !picked.length) return;
    const go = await vscode.window.showWarningMessage(
      `Kill ${picked.length} tmux session(s)? Anything running in them will stop.`,
      { modal: true }, 'Kill'
    );
    if (go !== 'Kill') return;
    for (const it of picked) await tmux(['kill-session', '-t', it.session]);
    vscode.window.showInformationMessage(`Killed ${picked.length} tmux session(s).`);
    this.tick(true);
  }

  // Pick one of the folder's past Claude conversations and resume it here.
  async attachExisting() {
    const cwd = workspaceFolder();
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
    <div id="screen-wrap">
      <div id="screen" tabindex="0" aria-label="Claude terminal mirror"></div>
      <div id="cursor"></div>
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
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
