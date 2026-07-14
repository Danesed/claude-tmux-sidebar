(function () {
  const vscode = acquireVsCodeApi();
  const wrap = document.getElementById('screen-wrap');
  const screen = document.getElementById('screen');
  const cursorEl = document.getElementById('cursor');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayFolder = document.getElementById('overlay-folder');
  const sessionList = document.getElementById('session-list');
  const sessionFilter = document.getElementById('session-filter');
  const btnStart = document.getElementById('btn-start');
  const btnResume = document.getElementById('btn-resume');
  const launcherActions = document.getElementById('launcher-actions');
  const tabAdd = document.getElementById('tab-add');
  const launchMenu = document.getElementById('agent-launch-menu');
  const btnPair = document.getElementById('btn-pair');
  const btnUnlock = document.getElementById('btn-unlock');
  const handoffModal = document.getElementById('handoff-modal');
  const handoffMode = document.getElementById('handoff-mode');
  const handoffText = document.getElementById('handoff-text');
  const handoffSend = document.getElementById('handoff-send');
  const handoffCancel = document.getElementById('handoff-cancel');
  const handoffError = document.getElementById('handoff-error');
  const statusName = document.getElementById('status-name');
  const statusMeta = document.getElementById('status-meta');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const app = document.getElementById('app');
  const tabs = [...document.querySelectorAll('.agent-tab')];
  const cursorStyle = (app && app.dataset.cursor) || 'block';
  let activeAgent = 'claude';
  let writerAgent = null;
  let handoffDraft = null;
  let handoffCurrentMode = 'reviewFix';
  const agentPresence = {
    claude: { present: false, status: 'idle' },
    codex: { present: false, status: 'idle' },
  };
  const scrollState = {
    claude: { top: 0, follow: true, historyMode: false, historyAvailable: 0, pendingHistory: false },
    codex: { top: 0, follow: true, historyMode: false, historyAvailable: 0, pendingHistory: false },
  };
  let renderedLineCount = 0;
  let programmaticScroll = false;

  // ---- char metrics --------------------------------------------------------
  let charW = 7, charH = 14;
  const PAD_X = 8, PAD_Y = 6;

  function measure() {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    const cs = getComputedStyle(screen);
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.lineHeight = cs.lineHeight;
    probe.textContent = 'M'.repeat(40);
    document.body.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 40 || charW;
    probe.textContent = 'M';
    charH = probe.getBoundingClientRect().height || charH;
    document.body.removeChild(probe);
  }

  let lastCols = 0, lastRows = 0;
  function reportSize() {
    const w = wrap.clientWidth - PAD_X * 2;
    const h = wrap.clientHeight - PAD_Y * 2;
    const cols = Math.max(20, Math.floor(w / charW));
    const rows = Math.max(5, Math.floor(h / charH));
    if (cols !== lastCols || rows !== lastRows) {
      lastCols = cols; lastRows = rows;
      vscode.postMessage({ type: 'resize', cols, rows });
    }
  }

  // ---- ANSI colour palette (themed where possible) -------------------------
  const NAMES = ['Black','Red','Green','Yellow','Blue','Magenta','Cyan','White'];
  function basic(i, bright) { return `var(--vscode-terminal-ansi${bright ? 'Bright' : ''}${NAMES[i]})`; }
  function xterm256(n) {
    if (n < 16) return basic(n % 8, n >= 8);
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    const c = n - 16;
    const r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6;
    const conv = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${conv(r)},${conv(g)},${conv(b)})`;
  }

  function defaultStyle() {
    return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  }
  function applySGR(st, codes) {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(st, defaultStyle());
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = basic(c - 30, false);
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = basic(c - 40, false);
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = basic(c - 90, true);
      else if (c >= 100 && c <= 107) st.bg = basic(c - 100, true);
      else if (c === 38 || c === 48) {
        const isFg = c === 38, mode = codes[i + 1];
        if (mode === 5) { const col = xterm256(codes[i + 2] | 0); if (isFg) st.fg = col; else st.bg = col; i += 2; }
        else if (mode === 2) { const col = `rgb(${codes[i+2]|0},${codes[i+3]|0},${codes[i+4]|0})`; if (isFg) st.fg = col; else st.bg = col; i += 4; }
      }
    }
  }
  function styleToCss(st) {
    let fg = st.fg, bg = st.bg;
    if (st.inverse) {
      fg = st.bg || 'var(--vscode-editor-background)';
      bg = st.fg || 'var(--vscode-editor-foreground)';
    }
    let s = '';
    if (fg) s += `color:${fg};`;
    if (bg) s += `background:${bg};`;
    if (st.bold) s += 'font-weight:bold;';
    if (st.dim) s += 'opacity:0.7;';
    if (st.italic) s += 'font-style:italic;';
    if (st.underline) s += 'text-decoration:underline;';
    return s;
  }

  const ESC = '\x1b';
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function renderLine(line) {
    let html = '', buf = '';
    const st = defaultStyle();
    let openSpan = false;
    const flush = () => { if (buf) { html += esc(buf); buf = ''; } };
    const closeSpan = () => { if (openSpan) { flush(); html += '</span>'; openSpan = false; } };
    const openWith = () => { flush(); const css = styleToCss(st); html += css ? `<span style="${css}">` : '<span>'; openSpan = true; };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\r') continue;
      if (ch === ESC) {
        if (line[i + 1] === '[') {
          let j = i + 2;
          while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
          if (line[j] === 'm') {
            const codes = line.slice(i + 2, j).split(';').map((x) => (x === '' ? 0 : parseInt(x, 10)));
            closeSpan(); applySGR(st, codes); openWith();
          }
          i = j;
        } else { i += 1; }
        continue;
      }
      buf += ch;
    }
    closeSpan();
    if (!openSpan) flush();
    return html;
  }
  function render(frame) {
    const lines = frame.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      let row = screen.children[i];
      if (!row) {
        row = document.createElement('div');
        row.className = 'row';
        screen.appendChild(row);
      }
      if (row._raw !== lines[i]) {
        row._raw = lines[i];
        row.innerHTML = renderLine(lines[i]) || '&nbsp;';
      }
    }
    while (screen.children.length > lines.length) screen.lastElementChild.remove();
    renderedLineCount = lines.length;
    const agentAtRender = activeAgent;
    const state = scrollState[agentAtRender];
    programmaticScroll = true;
    requestAnimationFrame(() => {
      if (agentAtRender === activeAgent) {
        if (state.pendingHistory && state.historyMode) {
          state.pendingHistory = false;
          state.follow = false;
          wrap.scrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight * 1.8);
        } else {
          wrap.scrollTop = state.follow ? wrap.scrollHeight : Math.min(state.top, wrap.scrollHeight);
        }
        state.top = wrap.scrollTop;
      }
      programmaticScroll = false;
      updateCursorVisibility();
    });
  }
  function placeCursor(cx, cy, paneHeight) {
    const historyRows = Math.max(0, renderedLineCount - paneHeight);
    const left = PAD_X + cx * charW, top = PAD_Y + (historyRows + cy) * charH;
    let w = charW, h = charH, t = top;
    if (cursorStyle === 'bar') { w = Math.max(1, Math.round(charW * 0.15)); }
    else if (cursorStyle === 'underline') { h = Math.max(1, Math.round(charH * 0.14)); t = top + charH - h; }
    cursorEl.style.left = left + 'px';
    cursorEl.style.top = t + 'px';
    cursorEl.style.width = w + 'px';
    cursorEl.style.height = h + 'px';
  }

  function nearBottom() {
    return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop <= charH * 2;
  }
  function updateCursorVisibility() {
    cursorEl.style.visibility = scrollState[activeAgent].follow ? 'visible' : 'hidden';
  }
  function saveScroll() {
    const state = scrollState[activeAgent];
    state.top = wrap.scrollTop;
    state.follow = nearBottom();
  }
  wrap.addEventListener('scroll', () => {
    if (programmaticScroll) return;
    saveScroll();
    const state = scrollState[activeAgent];
    if (state.historyMode && state.follow) {
      state.historyMode = false;
      vscode.postMessage({ type: 'historyMode', agent: activeAgent, enabled: false });
    }
    updateCursorVisibility();
  });
  function requestHistory() {
    const state = scrollState[activeAgent];
    if (state.historyMode || state.historyAvailable <= 0) return false;
    state.historyMode = true;
    state.pendingHistory = true;
    state.follow = false;
    vscode.postMessage({ type: 'historyMode', agent: activeAgent, enabled: true });
    return true;
  }
  let lastForwardedWheel = 0;
  wrap.addEventListener('wheel', (e) => {
    if (!overlay.classList.contains('hidden')) return;
    if (wrap.scrollHeight > wrap.clientHeight + charH) return;
    const now = Date.now();
    if (Math.abs(e.deltaY) < 4 || now - lastForwardedWheel < 80) return;
    e.preventDefault();
    lastForwardedWheel = now;
    if (e.deltaY < 0 && requestHistory()) return;
    vscode.postMessage({ type: 'input', agent: activeAgent, data: e.deltaY < 0 ? '\x1b[5~' : '\x1b[6~' });
  }, { passive: false });

  // ---- selection-aware refresh (so you can copy text from the mirror) -------
  let pendingFrame = null;
  function hasSelection() {
    const sel = window.getSelection();
    return !!(sel && sel.toString().length > 0 && sel.anchorNode && screen.contains(sel.anchorNode));
  }
  document.addEventListener('selectionchange', () => {
    if (!hasSelection() && pendingFrame != null) {
      if (pendingFrame.agent === activeAgent) render(pendingFrame.frame);
      pendingFrame = null;
    }
  });

  function fmtUptime(sec) {
    if (!sec || sec < 0) return '';
    if (sec < 60) return Math.floor(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h + 'h' + (m ? ' ' + m + 'm' : ''); }
    return Math.floor(sec / 86400) + 'd';
  }

  // ---- status footer -------------------------------------------------------
  let lastSeen = 0;
  function setStatus(name, cls, label) {
    if (name) statusName.textContent = name;
    statusDot.className = 'dot ' + cls;
    statusLabel.textContent = label;
  }
  // ---- input ---------------------------------------------------------------
  function keyToBytes(e) {
    const k = e.key;
    if (e.ctrlKey && !e.altKey && k.length === 1) {
      const lc = k.toLowerCase().charCodeAt(0);
      if (lc >= 97 && lc <= 122) return String.fromCharCode(lc - 96);
      if (k === ' ') return '\x00';
    }
    switch (k) {
      case 'Enter': return '\r';
      case 'Backspace': return '\x7f';
      case 'Tab': return e.shiftKey ? '\x1b[Z' : '\t';
      case 'Escape': return '\x1b';
      case 'ArrowUp': return '\x1b[A';
      case 'ArrowDown': return '\x1b[B';
      case 'ArrowRight': return '\x1b[C';
      case 'ArrowLeft': return '\x1b[D';
      case 'Home': return '\x1b[H';
      case 'End': return '\x1b[F';
      case 'PageUp': return '\x1b[5~';
      case 'PageDown': return '\x1b[6~';
      case 'Delete': return '\x1b[3~';
    }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey) return k;
    return null;
  }

  const isMac = navigator.platform.startsWith('Mac');
  screen.addEventListener('keydown', (e) => {
    // Leave copy/paste/select-all to VS Code (Cmd on mac, Ctrl elsewhere).
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && ['c', 'v', 'a', 'x'].includes(e.key.toLowerCase())) return;
    if (writerAgent && activeAgent !== writerAgent && !['PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      if (e.key === 'PageUp' && wrap.scrollHeight <= wrap.clientHeight + charH && requestHistory()) return;
      scrollState[activeAgent].follow = false;
      wrap.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * wrap.clientHeight * 0.85 });
      return;
    }
    const bytes = keyToBytes(e);
    if (bytes !== null) { e.preventDefault(); vscode.postMessage({ type: 'input', agent: activeAgent, data: bytes }); }
  });
  screen.addEventListener('paste', (e) => {
    if (writerAgent && activeAgent !== writerAgent) { e.preventDefault(); return; }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) { e.preventDefault(); vscode.postMessage({ type: 'paste', agent: activeAgent, data: text }); }
  });
  screen.addEventListener('mousedown', () => screen.focus());
  btnStart.addEventListener('click', () => vscode.postMessage({ type: 'start', agent: activeAgent }));
  btnResume.addEventListener('click', () => vscode.postMessage({ type: 'attach', agent: activeAgent }));

  function setActiveAgent(agent) {
    if (!scrollState[agent]) return;
    if (agent !== activeAgent) saveScroll();
    activeAgent = agent;
    tabs.forEach((tab) => {
      const selected = tab.dataset.agent === agent;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    screen.setAttribute('aria-label', `${agent === 'claude' ? 'Claude' : 'Codex'} tmux terminal mirror`);
    screen.replaceChildren();
    renderedLineCount = 0;
    cursorEl.style.visibility = 'hidden';
    overlay.classList.add('hidden');
    statusName.textContent = '';
    statusMeta.textContent = '';
    setStatus('', 'idle', 'connecting…');
    programmaticScroll = true;
    wrap.scrollTop = scrollState[agent].top;
    programmaticScroll = false;
    applyPairLock();
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => vscode.postMessage({ type: 'switchAgent', agent: tab.dataset.agent }));
    tab.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const visibleTabs = tabs.filter((item) => !item.classList.contains('hidden'));
      if (visibleTabs.length < 2) return;
      const index = visibleTabs.indexOf(tab);
      const agent = visibleTabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length].dataset.agent;
      vscode.postMessage({ type: 'switchAgent', agent });
      document.getElementById(`tab-${agent}`).focus();
    });
  });

  tabAdd.addEventListener('click', () => launchMenu.classList.toggle('hidden'));
  launchMenu.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-agent]');
    if (!button) return;
    launchMenu.classList.add('hidden');
    vscode.postMessage({ type: button.dataset.action, agent: button.dataset.agent });
  });
  document.addEventListener('click', (e) => {
    if (!launchMenu.contains(e.target) && e.target !== tabAdd) launchMenu.classList.add('hidden');
  });
  launcherActions.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-launch-agent]');
    if (button) vscode.postMessage({ type: 'start', agent: button.dataset.launchAgent });
  });

  const STATE_LABELS = {
    working: 'working',
    done: 'finished',
    'needs-input': 'needs input',
    idle: 'idle',
  };

  function applyPairLock() {
    const locked = !!writerAgent && activeAgent !== writerAgent;
    screen.classList.toggle('input-locked', locked);
    screen.setAttribute('aria-readonly', locked ? 'true' : 'false');
    document.getElementById('hint').textContent = locked
      ? `Pair Mode · ${writerAgent === 'claude' ? 'Claude' : 'Codex'} is writer`
      : 'click to type';
    btnUnlock.classList.toggle('hidden', !writerAgent);
  }

  function renderAgents(message) {
    writerAgent = message.writerAgent || null;
    for (const agent of ['claude', 'codex']) {
      Object.assign(agentPresence[agent], message.agents?.[agent] || { present: false, status: 'idle' });
      const tab = document.getElementById(`tab-${agent}`);
      const present = !!agentPresence[agent].present;
      const status = agentPresence[agent].status || 'idle';
      tab.classList.toggle('hidden', !present);
      tab.classList.toggle('writer', writerAgent === agent);
      for (const name of ['working', 'done', 'needs-input', 'idle']) tab.classList.toggle(`state-${name}`, status === name);
      const label = `${agent === 'claude' ? 'Claude' : 'Codex'}: ${STATE_LABELS[status] || status}${writerAgent === agent ? ', Pair Mode writer' : ''}`;
      tab.title = label;
      tab.setAttribute('aria-label', label);
      for (const button of launchMenu.querySelectorAll(`button[data-agent="${agent}"]`)) {
        button.classList.toggle('hidden', present);
      }
    }
    const presentAgents = ['claude', 'codex'].filter((agent) => agentPresence[agent].present);
    const hasWorkspace = message.hasWorkspace !== false;
    tabAdd.classList.toggle('hidden', !hasWorkspace || presentAgents.length === 2);
    for (const button of launcherActions.querySelectorAll('button')) button.disabled = !hasWorkspace;
    for (const button of launchMenu.querySelectorAll('button')) button.disabled = !hasWorkspace;
    btnPair.disabled = !agentPresence[activeAgent].present;
    applyPairLock();
    if (!hasWorkspace) {
      screen.replaceChildren();
      overlay.classList.remove('hidden');
      overlayTitle.textContent = 'Open a workspace folder';
      overlayFolder.textContent = 'Claude and Codex tmux sessions are never created outside a workspace.';
      sessionFilter.classList.add('hidden');
      sessionList.innerHTML = '';
      launcherActions.classList.remove('hidden');
      btnStart.parentElement.classList.add('hidden');
      statusName.textContent = '';
      statusMeta.textContent = '';
      setStatus('', 'dead', 'no workspace');
      return;
    }
    if (!presentAgents.length) {
      screen.replaceChildren();
      overlay.classList.remove('hidden');
      overlayTitle.textContent = 'Start a workspace agent';
      overlayFolder.textContent = 'Tabs appear only after their tmux session exists.';
      sessionFilter.classList.add('hidden');
      sessionList.innerHTML = '';
      launcherActions.classList.remove('hidden');
      btnStart.parentElement.classList.add('hidden');
      statusName.textContent = '';
      statusMeta.textContent = '';
      setStatus('', 'dead', 'no sessions');
    } else {
      launcherActions.classList.add('hidden');
      btnStart.parentElement.classList.remove('hidden');
    }
    const activeStatus = agentPresence[activeAgent].status || 'idle';
    if (agentPresence[activeAgent].present) setStatus('', activeStatus, STATE_LABELS[activeStatus] || activeStatus);
  }

  btnPair.addEventListener('click', () => vscode.postMessage({ type: 'prepareHandoff', source: activeAgent }));
  btnUnlock.addEventListener('click', () => vscode.postMessage({ type: 'cancelPair' }));
  handoffMode.addEventListener('change', () => {
    if (!handoffDraft) return;
    handoffDraft[handoffCurrentMode] = handoffText.value;
    handoffCurrentMode = handoffMode.value;
    handoffText.value = handoffDraft[handoffCurrentMode];
  });
  handoffText.addEventListener('input', () => {
    if (handoffDraft) handoffDraft[handoffCurrentMode] = handoffText.value;
  });
  handoffCancel.addEventListener('click', () => {
    handoffModal.classList.add('hidden');
    handoffDraft = null;
    handoffError.classList.add('hidden');
  });
  handoffSend.addEventListener('click', () => {
    if (!handoffDraft) return;
    handoffDraft[handoffCurrentMode] = handoffText.value;
    handoffSend.disabled = true;
    handoffSend.textContent = 'Sending…';
    handoffError.classList.add('hidden');
    vscode.postMessage({
      type: 'confirmHandoff',
      source: handoffDraft.source,
      target: handoffDraft.target,
      mode: handoffMode.value,
      text: handoffText.value,
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !handoffModal.classList.contains('hidden')) {
      e.preventDefault();
      handoffCancel.click();
    }
  });

  // ---- session chooser (rendered inside the overlay) -----------------------
  let allSessions = [];
  function relTime(ts) {
    if (!ts) return '';
    const d = (Date.now() - new Date(ts).getTime()) / 1000;
    if (isNaN(d)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    if (d < 604800) return Math.floor(d / 86400) + 'd ago';
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
  }
  function renderSessions() {
    const q = (sessionFilter.value || '').toLowerCase().trim();
    const list = q ? allSessions.filter((s) => (s.name || s.id || '').toLowerCase().includes(q)) : allSessions;
    if (!allSessions.length) {
      sessionList.innerHTML = '<div class="sess-empty">No past conversations in this folder.</div>';
      return;
    }
    if (!list.length) { sessionList.innerHTML = '<div class="sess-empty">No match.</div>'; return; }
    let html = '';
    for (const s of list) {
      html += `<button class="sess-item" data-id="${esc(s.id)}" title="${esc(s.id)}">`
            + `<span class="sess-name">${esc(s.name || s.id)}</span>`
            + `<span class="sess-date">${esc(relTime(s.lastTs))} · ${esc((s.id || '').slice(0, 8))}</span>`
            + `</button>`;
    }
    sessionList.innerHTML = html;
  }
  function setSessions(list) {
    allSessions = list || [];
    sessionFilter.classList.toggle('hidden', allSessions.length < 6);
    renderSessions();
  }
  sessionFilter.addEventListener('input', renderSessions);
  sessionList.addEventListener('click', (e) => {
    const item = e.target.closest('.sess-item');
    if (item && item.dataset.id) vscode.postMessage({ type: 'resume', agent: activeAgent, id: item.dataset.id });
  });

  // ---- messages from the extension ----------------------------------------
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'activeAgent') {
      setActiveAgent(m.agent);
    } else if (m.type === 'agents') {
      renderAgents(m);
    } else if (m.type === 'handoffDraft') {
      handoffDraft = {
        source: m.source,
        target: m.target,
        reviewOnly: m.reviewOnly,
        reviewFix: m.reviewFix,
      };
      handoffMode.value = 'reviewFix';
      handoffCurrentMode = 'reviewFix';
      handoffText.value = m.reviewFix;
      handoffError.classList.add('hidden');
      handoffSend.disabled = false;
      handoffSend.textContent = 'Send handoff';
      handoffModal.classList.remove('hidden');
      handoffText.focus();
      handoffText.setSelectionRange(0, 0);
    } else if (m.type === 'inputLocked') {
      applyPairLock();
    } else if (m.type === 'inputSuspended') {
      document.getElementById('hint').textContent = 'session operation in progress';
      setTimeout(applyPairLock, 1200);
    } else if (m.type === 'handoffResult') {
      handoffSend.disabled = false;
      handoffSend.textContent = 'Send handoff';
      if (m.ok) {
        handoffModal.classList.add('hidden');
        handoffDraft = null;
        handoffError.classList.add('hidden');
      } else {
        handoffError.textContent = m.error || 'Handoff failed.';
        handoffError.classList.remove('hidden');
        handoffText.focus();
      }
    } else if (m.type === 'frame') {
      if (m.agent !== activeAgent) return;
      lastSeen = Date.now();
      overlay.classList.add('hidden');
      const state = scrollState[activeAgent];
      state.historyMode = !!m.historyMode;
      state.historyAvailable = parseInt(m.historyAvailable, 10) || 0;
      if (m.frame != null) {
        if (hasSelection()) pendingFrame = { agent: m.agent, frame: m.frame }; // don't clobber a copy in progress
        else { render(m.frame); pendingFrame = null; }
      }
      const p = (m.meta || '').split(',');
      placeCursor(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[3], 10) || lastRows || 24);
      const pw = p[2], ph = p[3], created = parseInt(p[4], 10) || 0;
      const up = created ? fmtUptime(Date.now() / 1000 - created) : '';
      statusMeta.textContent = [pw && ph ? `${pw}×${ph}` : '', up ? `up ${up}` : ''].filter(Boolean).join(' · ');
      const agentStatus = agentPresence[activeAgent].status || 'idle';
      setStatus(m.name, agentStatus, STATE_LABELS[agentStatus] || agentStatus);
    } else if (m.type === 'nosession') {
      if (m.agent !== activeAgent) return;
      screen.replaceChildren();
      renderedLineCount = 0;
      scrollState[activeAgent] = { top: 0, follow: true, historyMode: false, historyAvailable: 0, pendingHistory: false };
      wrap.scrollTop = 0;
      overlay.classList.remove('hidden');
      overlayFolder.textContent = m.folder || '';
      statusMeta.textContent = '';
      setStatus(m.name, 'dead', 'stopped');
      lastSeen = 0;
    } else if (m.type === 'sessions') {
      if (m.agent !== activeAgent) return;
      btnStart.disabled = false;
      btnStart.textContent = `＋ Start new ${m.agent === 'claude' ? 'Claude' : 'Codex'}`;
      if (m.agent === 'codex') {
        overlayTitle.textContent = 'Start or resume Codex';
        sessionFilter.classList.add('hidden');
        sessionList.innerHTML = '<div class="sess-empty">Codex resume is filtered to this workspace.</div>';
        btnResume.classList.remove('hidden');
      } else {
        overlayTitle.textContent = (m.list && m.list.length)
          ? 'Attach to a Claude session'
          : 'No Claude session here yet';
        btnResume.classList.add('hidden');
        setSessions(m.list);
      }
    } else if (m.type === 'noWorkspace') {
      if (m.agent !== activeAgent) return;
      screen.replaceChildren();
      overlay.classList.remove('hidden');
      overlayTitle.textContent = 'Open a workspace folder';
      overlayFolder.textContent = 'Claude and Codex tmux sessions are never created outside a workspace.';
      sessionFilter.classList.add('hidden');
      sessionList.innerHTML = '';
      btnResume.classList.add('hidden');
      btnStart.disabled = true;
      for (const button of launcherActions.querySelectorAll('button')) button.disabled = true;
      statusName.textContent = '';
      statusMeta.textContent = '';
      setStatus('', 'dead', 'no workspace');
    }
  });

  // ---- boot ----------------------------------------------------------------
  measure();
  reportSize();
  if (window.ResizeObserver) new ResizeObserver(() => { measure(); reportSize(); }).observe(wrap);
  window.addEventListener('resize', () => { measure(); reportSize(); });
  vscode.postMessage({ type: 'ready' });
  setTimeout(() => screen.focus(), 200);
})();
