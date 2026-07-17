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
  const handoffTitle = document.getElementById('handoff-title');
  const handoffMode = document.getElementById('handoff-mode');
  const handoffModeLabel = document.getElementById('handoff-mode-label');
  const handoffText = document.getElementById('handoff-text');
  const handoffTextLabel = document.getElementById('handoff-text-label');
  const handoffSend = document.getElementById('handoff-send');
  const handoffCancel = document.getElementById('handoff-cancel');
  const handoffError = document.getElementById('handoff-error');
  const handoffMeta = document.getElementById('handoff-meta');
  const statusName = document.getElementById('status-name');
  const statusMeta = document.getElementById('status-meta');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const app = document.getElementById('app');
  const recallEl = document.getElementById('prompt-recall');
  const recallFilter = document.getElementById('recall-filter');
  const recallList = document.getElementById('recall-list');
  const preflightEl = document.getElementById('preflight');
  const tabs = [...document.querySelectorAll('.agent-tab')];
  const cursorStyle = (app && app.dataset.cursor) || 'block';
  const FLAGS = {
    links: app?.dataset.links !== '0',
  };
  let activeAgent = 'claude';
  let writerAgent = null;
  let handoffPhase = null;
  let handoffDraft = null;
  let handoffCurrentMode = 'continue';
  let arbiterPhase = null;
  let arbiterState = null; // { id, phase }
  const agentPresence = {
    claude: { present: false, status: 'idle' },
    codex: { present: false, status: 'idle' },
  };
  const scrollState = {
    claude: { top: 0, follow: true, historyMode: false, historyAvailable: 0, pendingHistory: false },
    codex: { top: 0, follow: true, historyMode: false, historyAvailable: 0, pendingHistory: false },
  };
  const frameCache = {
    claude: { frame: null, meta: '', name: '', latencyMs: 0 },
    codex: { frame: null, meta: '', name: '', latencyMs: 0 },
  };
  let renderedLineCount = 0;
  let programmaticScroll = false;
  // Line cache for the delta frame transport: raw '\n' split (including the
  // trailing '' element) of the active agent's current live frame, plus the
  // sequence number it corresponds to. Deltas only apply to an unbroken chain.
  let liveLines = null;
  let liveSeq = 0;

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
  let resizeTimer = null;
  let resizeFrame = null;
  let resizeNeedsMeasure = false;
  function scheduleReportSize(remeasure = false) {
    resizeNeedsMeasure = resizeNeedsMeasure || remeasure;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (resizeNeedsMeasure) measure();
        resizeNeedsMeasure = false;
        reportSize();
      });
    }, 80);
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
  // ---- clickable file paths -------------------------------------------------
  // Wrap path-like tokens (with a '/' or a ':line' suffix) in spans; the host
  // verifies existence before opening, so false positives cost nothing.
  const PATH_RE = /(?:[\w.~-]+\/)*[\w-][\w.-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
  function linkifyRow(row) {
    if (!FLAGS.links) return;
    const text = row.textContent;
    if (!text || text.indexOf('.') < 0 || text.length > 500) return;
    PATH_RE.lastIndex = 0;
    if (!PATH_RE.test(text)) return;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const textNode of nodes) {
      const value = textNode.nodeValue;
      PATH_RE.lastIndex = 0;
      let match;
      let last = 0;
      let frag = null;
      while ((match = PATH_RE.exec(value))) {
        const token = match[0];
        if (!token.includes('/') && !/:\d/.test(token)) continue; // bare words stay prose
        if (!frag) frag = document.createDocumentFragment();
        if (match.index > last) frag.appendChild(document.createTextNode(value.slice(last, match.index)));
        const parts = token.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
        const span = document.createElement('span');
        span.className = 'path-link';
        span.textContent = token;
        span.dataset.path = parts[1];
        if (parts[2]) span.dataset.line = parts[2];
        if (parts[3]) span.dataset.col = parts[3];
        frag.appendChild(span);
        last = match.index + token.length;
      }
      if (!frag) continue;
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // ---- virtualized scrollback ------------------------------------------------
  // History captures can be thousands of fixed-height lines; render only the
  // viewport (plus overscan) between two spacers instead of materializing all.
  const VIRT_MIN = 300;
  const VIRT_OVERSCAN = 30;
  let virt = null; // { lines, start, end, spacerTop, spacerBottom }
  let virtScrollFrame = null;

  function exitVirtual() {
    if (!virt) return;
    virt = null;
    screen.replaceChildren();
  }

  function updateVirtualWindow(force) {
    if (!virt) return;
    const total = virt.lines.length;
    const viewRows = Math.ceil(wrap.clientHeight / charH) || 24;
    let start = Math.floor((wrap.scrollTop - PAD_Y) / charH) - VIRT_OVERSCAN;
    start = Math.max(0, Math.min(start, Math.max(0, total - viewRows - VIRT_OVERSCAN)));
    const end = Math.min(total, start + viewRows + VIRT_OVERSCAN * 2);
    if (!force && start === virt.start && end === virt.end) return;
    virt.start = start;
    virt.end = end;
    virt.spacerTop.style.height = (start * charH) + 'px';
    virt.spacerBottom.style.height = ((total - end) * charH) + 'px';
    const needed = end - start;
    const rows = [];
    let row = virt.spacerTop.nextSibling;
    while (row && row !== virt.spacerBottom) { rows.push(row); row = row.nextSibling; }
    while (rows.length > needed) rows.pop().remove();
    while (rows.length < needed) {
      const fresh = document.createElement('div');
      fresh.className = 'row';
      screen.insertBefore(fresh, virt.spacerBottom);
      rows.push(fresh);
    }
    for (let i = 0; i < needed; i++) {
      const raw = virt.lines[start + i];
      if (rows[i]._raw !== raw) {
        rows[i]._raw = raw;
        rows[i].innerHTML = renderLine(raw) || '&nbsp;';
        linkifyRow(rows[i]);
      }
    }
  }

  function render(frame) {
    const lines = Array.isArray(frame) ? frame.slice() : frame.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > VIRT_MIN && scrollState[activeAgent].historyMode) {
      screen.replaceChildren();
      virt = {
        lines, start: -1, end: -1,
        spacerTop: document.createElement('div'),
        spacerBottom: document.createElement('div'),
      };
      screen.appendChild(virt.spacerTop);
      screen.appendChild(virt.spacerBottom);
      renderedLineCount = lines.length;
      updateVirtualWindow(true);
    } else {
      exitVirtual();
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
          linkifyRow(row);
        }
      }
      while (screen.children.length > lines.length) screen.lastElementChild.remove();
      renderedLineCount = lines.length;
    }
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
  // Apply a line delta directly to the existing rows; false means a row index
  // fell outside the rendered screen and a full render is required instead.
  function patchRows(changes) {
    if (virt) return false; // deltas never target the virtualized history view
    for (const [idx, raw] of changes) {
      const row = screen.children[idx];
      if (!row) return false;
      if (row._raw !== raw) {
        row._raw = raw;
        row.innerHTML = renderLine(raw) || '&nbsp;';
        linkifyRow(row);
      }
    }
    return true;
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
    if (virt && virtScrollFrame === null) {
      virtScrollFrame = requestAnimationFrame(() => {
        virtScrollFrame = null;
        updateVirtualWindow(false);
      });
    }
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
      if (pendingFrame.agent === activeAgent) {
        if (pendingFrame.useLive && liveLines) render(liveLines);
        else if (pendingFrame.frame != null) render(pendingFrame.frame);
      }
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
    const dotClass = 'dot ' + cls;
    if (statusDot.className !== dotClass) statusDot.className = dotClass;
    if (statusLabel.textContent !== label) statusLabel.textContent = label;
  }
  function fmtK(n) {
    n = n || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }
  function applyFrameMeta(meta, name, latencyMs = 0) {
    const p = (meta || '').split(',');
    placeCursor(parseInt(p[0], 10) || 0, parseInt(p[1], 10) || 0, parseInt(p[3], 10) || lastRows || 24);
    const pw = p[2], ph = p[3], created = parseInt(p[4], 10) || 0;
    const history = parseInt(p[5], 10) || 0;
    const clients = parseInt(p[6], 10) || 0;
    const up = created ? fmtUptime(Date.now() / 1000 - created) : '';
    const ap = agentPresence[activeAgent] || {};
    const tel = ap.telemetry;
    const delta = ap.delta;
    statusMeta.textContent = [
      pw && ph ? `${pw}×${ph}` : '',
      up ? `up ${up}` : '',
      history ? `hist ${history}` : '',
      clients ? `${clients} client${clients === 1 ? '' : 's'}` : '',
      tel && (tel.inTokens || tel.outTokens) ? `↑${fmtK(tel.inTokens)} ↓${fmtK(tel.outTokens)}` : '',
      tel && tel.turns ? `t${tel.turns}` : '',
      delta && delta.files ? `Δ${delta.files} +${delta.insertions}−${delta.deletions}` : '',
      latencyMs >= 200 ? `lag ${Math.round(latencyMs)}ms` : '',
    ].filter(Boolean).join(' · ');
    statusMeta.title = statusMeta.textContent
      + (tel && tel.model ? `\nmodel ${tel.model}` : '')
      + (delta && delta.names ? `\nlast turn: ${delta.names.join(', ')}` : '');
    const agentStatus = ap.status || 'idle';
    let label = STATE_LABELS[agentStatus] || agentStatus;
    if (agentStatus === 'working') {
      if (ap.statusSince) label += ' ' + fmtUptime((Date.now() - ap.statusSince) / 1000);
      if (ap.lastTool) label += ' · ' + ap.lastTool;
    }
    setStatus(name, agentStatus, label);
  }
  // ---- input ---------------------------------------------------------------
  const graphemeSegmenter = Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  function isTextKey(key) {
    if (!key || key === 'Dead' || key === 'Process' || key === 'Unidentified') return false;
    if (key.length === 1) return true;
    if (!graphemeSegmenter) return Array.from(key).length === 1;
    const segments = [...graphemeSegmenter.segment(key)];
    return segments.length === 1;
  }

  function keyToBytes(e) {
    const k = e.key;
    const altGraph = e.getModifierState && e.getModifierState('AltGraph');
    if (e.ctrlKey && !e.altKey && !altGraph && k.length === 1) {
      const lc = k.toLowerCase().charCodeAt(0);
      if (lc >= 97 && lc <= 122) return String.fromCharCode(lc - 96);
      if (k === ' ' || k === '@' || k === '`' || k === '2') return '\x00';
      if (k === '[' || k === '3') return '\x1b';
      if (k === '\\' || k === '4') return '\x1c';
      if (k === ']' || k === '5') return '\x1d';
      if (k === '^' || k === '6') return '\x1e';
      if (k === '_' || k === '7') return '\x1f';
      if (k === '?' || k === '8') return '\x7f';
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
    if (isTextKey(k) && !e.metaKey && (!e.ctrlKey || altGraph)) return k;
    return null;
  }

  const isMac = navigator.platform.startsWith('Mac');
  let composing = false;
  function isInputLocked() {
    return ['drafting', 'delivering', 'awaitingAck', 'ackTimeout'].includes(handoffPhase)
      || ['delivering', 'gathering'].includes(arbiterPhase)
      || (!!writerAgent && activeAgent !== writerAgent);
  }

  // ---- prompt recall (Alt+Up) --------------------------------------------------
  let recallItems = [];
  let recallFiltered = [];
  let recallIndex = 0;
  function renderRecall() {
    const q = (recallFilter.value || '').toLowerCase().trim();
    recallFiltered = q ? recallItems.filter((t) => t.toLowerCase().includes(q)) : recallItems.slice();
    recallIndex = Math.max(0, Math.min(recallIndex, recallFiltered.length - 1));
    recallList.innerHTML = recallFiltered.length
      ? recallFiltered.slice(0, 30).map((t, i) =>
          `<button class="recall-item${i === recallIndex ? ' sel' : ''}" data-i="${i}">${esc(t)}</button>`).join('')
      : '<div class="sess-empty">No prompts recorded yet.</div>';
  }
  function closeRecall(focusScreen = true) {
    recallEl.classList.add('hidden');
    if (focusScreen) screen.focus({ preventScroll: true });
  }
  function pickRecall(text) {
    if (typeof text !== 'string' || !text) return;
    closeRecall();
    vscode.postMessage({ type: 'paste', agent: activeAgent, data: text });
  }
  recallFilter.addEventListener('input', () => { recallIndex = 0; renderRecall(); });
  recallEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeRecall(); return; }
    if (e.key === 'Enter') { e.preventDefault(); pickRecall(recallFiltered[recallIndex]); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      recallIndex = Math.max(0, Math.min(recallFiltered.length - 1, recallIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      renderRecall();
    }
  });
  recallList.addEventListener('click', (e) => {
    const item = e.target.closest('.recall-item');
    if (item) pickRecall(recallFiltered[parseInt(item.dataset.i, 10)]);
  });
  screen.addEventListener('keydown', (e) => {
    // Cmd stays a UI shortcut on macOS. On Windows/Linux, copy a selection with
    // Ctrl+C and paste with Ctrl+V; otherwise Ctrl combinations reach tmux.
    const key = e.key.toLowerCase();
    if (isMac && e.metaKey && ['c', 'v', 'a', 'x'].includes(key)) return;
    if (!isMac && e.ctrlKey && ((key === 'c' && hasSelection()) || key === 'v')) return;
    if (!isMac && e.ctrlKey && e.shiftKey && ['c', 'v'].includes(key)) return;
    if (isInputLocked() && !['PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      return;
    }
    if (composing || e.isComposing || e.key === 'Process' || e.keyCode === 229) return;
    if (e.altKey && e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      vscode.postMessage({ type: 'promptHistory' });
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
    if (bytes !== null) {
      e.preventDefault();
      vscode.postMessage({
        type: 'input', agent: activeAgent, data: bytes,
        immediate: e.ctrlKey || !isTextKey(e.key),
      });
    }
  });
  screen.addEventListener('click', (e) => {
    if (!e.metaKey && !e.ctrlKey) return;
    const link = e.target.closest('.path-link');
    if (!link) return;
    e.preventDefault();
    vscode.postMessage({ type: 'openFile', path: link.dataset.path, line: link.dataset.line, col: link.dataset.col });
  });
  screen.addEventListener('compositionstart', () => { composing = true; });
  screen.addEventListener('compositionend', (e) => {
    composing = false;
    if (!e.data || isInputLocked()) return;
    vscode.postMessage({ type: 'input', agent: activeAgent, data: e.data });
  });
  screen.addEventListener('paste', (e) => {
    if (isInputLocked()) { e.preventDefault(); return; }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) { e.preventDefault(); vscode.postMessage({ type: 'paste', agent: activeAgent, data: text }); }
  });
  screen.addEventListener('mousedown', () => screen.focus());
  btnStart.addEventListener('click', () => vscode.postMessage({ type: 'start', agent: activeAgent }));
  btnResume.addEventListener('click', () => vscode.postMessage({ type: 'attach', agent: activeAgent }));

  function setActiveAgent(agent) {
    if (!scrollState[agent]) return;
    const changed = agent !== activeAgent;
    if (changed) saveScroll();
    activeAgent = agent;
    tabs.forEach((tab) => {
      const selected = tab.dataset.agent === agent;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    screen.setAttribute('aria-label', `${agent === 'claude' ? 'Claude' : 'Codex'} tmux terminal mirror`);
    screen.setAttribute('aria-labelledby', `tab-${agent}`);
    exitVirtual();
    screen.replaceChildren();
    renderedLineCount = 0;
    liveLines = null;
    liveSeq = 0;
    closeRecall(false);
    cursorEl.style.visibility = 'hidden';
    overlay.classList.add('hidden');
    statusName.textContent = '';
    statusMeta.textContent = '';
    const cached = frameCache[agent];
    if (cached.frame != null) {
      render(cached.frame);
      applyFrameMeta(cached.meta, cached.name, cached.latencyMs);
    } else {
      setStatus('', 'idle', 'connecting…');
    }
    programmaticScroll = true;
    wrap.scrollTop = scrollState[agent].top;
    programmaticScroll = false;
    applyPairLock();
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', (e) => {
      const agent = tab.dataset.agent;
      if (e.detail > 0 && agent !== activeAgent) setActiveAgent(agent);
      vscode.postMessage({ type: 'switchAgent', agent });
      // Pointer users expect to type immediately. Keyboard-triggered clicks keep
      // focus on the tab so the ARIA tablist arrow navigation remains intact.
      if (e.detail > 0) screen.focus({ preventScroll: true });
    });
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

  function setLaunchMenu(open, focusMenu = false) {
    launchMenu.classList.toggle('hidden', !open);
    tabAdd.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && focusMenu) launchMenu.querySelector('button:not(.hidden):not(:disabled)')?.focus();
  }
  tabAdd.addEventListener('click', () => setLaunchMenu(launchMenu.classList.contains('hidden'), true));
  launchMenu.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-agent]');
    if (!button) return;
    setLaunchMenu(false);
    vscode.postMessage({ type: button.dataset.action, agent: button.dataset.agent });
  });
  document.addEventListener('click', (e) => {
    if (!launchMenu.contains(e.target) && e.target !== tabAdd) setLaunchMenu(false);
  });
  launchMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    setLaunchMenu(false);
    tabAdd.focus();
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
    const transactionLocked = ['drafting', 'delivering', 'awaitingAck', 'ackTimeout'].includes(handoffPhase);
    const locked = isInputLocked();
    screen.classList.toggle('input-locked', locked);
    screen.setAttribute('aria-readonly', locked ? 'true' : 'false');
    document.getElementById('hint').textContent = transactionLocked
      ? 'handoff in progress'
      : locked ? `Pair Mode · ${writerAgent === 'claude' ? 'Claude' : 'Codex'} is writer` : 'click to type';
    btnUnlock.classList.toggle('hidden', !writerAgent);
  }

  function renderPreflight(m) {
    const missing = !m.tmux || !m.claude || !m.codex;
    preflightEl.classList.toggle('hidden', !missing);
    if (!missing) return;
    const row = (ok, label, cmd) =>
      `<div class="pf-row ${ok ? 'ok' : 'miss'}"><span class="pf-mark">${ok ? '✓' : '✗'}</span><span class="pf-name">${esc(label)}</span>`
      + (ok ? '' : `<button class="pf-copy" data-cmd="${esc(cmd)}">copy install cmd</button>`) + '</div>';
    preflightEl.innerHTML =
      row(!!m.tmux, m.tmux ? m.tmux : 'tmux not found', 'brew install tmux')
      + row(!!m.claude, m.claude ? 'claude found' : 'claude not on PATH', 'npm install -g @anthropic-ai/claude-code')
      + row(!!m.codex, m.codex ? 'codex found' : 'codex not on PATH', 'npm install -g @openai/codex')
      + '<button id="pf-recheck">Recheck</button>';
  }
  preflightEl.addEventListener('click', (e) => {
    const copy = e.target.closest('.pf-copy');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.cmd || '');
      copy.textContent = 'copied';
      return;
    }
    if (e.target.closest('#pf-recheck')) vscode.postMessage({ type: 'preflightRecheck' });
  });

  function renderAgents(message) {
    writerAgent = message.writerAgent || null;
    handoffPhase = message.handoffPhase || null;
    arbiterPhase = message.arbiterPhase || null;
    btnFindings.classList.toggle('hidden', !message.handBack);
    const bothPresent = !!(message.agents?.claude?.present && message.agents?.codex?.present);
    btnArbiter.classList.toggle('hidden', !bothPresent);
    btnArbiter.disabled = !bothPresent || !!handoffPhase || !!arbiterPhase;
    for (const agent of ['claude', 'codex']) {
      Object.assign(agentPresence[agent], message.agents?.[agent] || { present: false, status: 'idle' });
      const tab = document.getElementById(`tab-${agent}`);
      const present = !!agentPresence[agent].present;
      const status = agentPresence[agent].status || 'idle';
      const attention = agentPresence[agent].attention || null;
      if (!present) frameCache[agent] = { frame: null, meta: '', name: '', latencyMs: 0 };
      tab.classList.toggle('hidden', !present);
      tab.classList.toggle('writer', writerAgent === agent);
      for (const name of ['working', 'done', 'needs-input', 'idle']) tab.classList.toggle(`state-${name}`, status === name);
      tab.classList.toggle('attention-done', attention === 'done');
      tab.classList.toggle('attention-needs-input', attention === 'needs-input');
      const attentionLabel = attention === 'done' ? ', new completion' : attention === 'needs-input' ? ', awaiting input' : '';
      const label = `${agent === 'claude' ? 'Claude' : 'Codex'}: ${STATE_LABELS[status] || status}${attentionLabel}${writerAgent === agent ? ', Pair Mode writer' : ''}`;
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
    btnPair.disabled = !agentPresence[activeAgent].present || !!handoffPhase;
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

  // ---- findings round-trip + arbiter -------------------------------------------
  const btnFindings = document.getElementById('btn-findings');
  const btnArbiter = document.getElementById('btn-arbiter');
  const arbiterModal = document.getElementById('arbiter-modal');
  const arbiterMeta = document.getElementById('arbiter-meta');
  const arbiterBody = document.getElementById('arbiter-body');
  const arbiterError = document.getElementById('arbiter-error');
  const arbiterSend = document.getElementById('arbiter-send');
  const arbiterCancel = document.getElementById('arbiter-cancel');
  btnFindings.addEventListener('click', () => vscode.postMessage({ type: 'requestFindings' }));
  btnArbiter.addEventListener('click', () => vscode.postMessage({ type: 'prepareArbiter' }));

  function closeArbiter() {
    arbiterModal.classList.add('hidden');
    arbiterState = null;
    screen.focus({ preventScroll: true });
  }
  function arbiterQuestionValue() {
    const box = document.getElementById('arbiter-text');
    return box ? box.value : '';
  }
  arbiterSend.addEventListener('click', () => {
    if (!arbiterState) return;
    if (arbiterState.phase === 'collecting') {
      arbiterSend.disabled = true;
      arbiterSend.textContent = 'Asking…';
      arbiterError.classList.add('hidden');
      vscode.postMessage({ type: 'createArbiter', id: arbiterState.id, question: arbiterQuestionValue() });
    }
  });
  arbiterCancel.addEventListener('click', () => {
    if (arbiterState) vscode.postMessage({ type: 'arbiterCancel', id: arbiterState.id });
    closeArbiter();
  });
  arbiterBody.addEventListener('click', (e) => {
    const pick = e.target.closest('button[data-winner]');
    if (pick && arbiterState && arbiterState.phase === 'verdict') {
      vscode.postMessage({ type: 'arbiterPick', id: arbiterState.id, winner: pick.dataset.winner });
    }
  });

  // ---- session timeline -------------------------------------------------------
  const btnTimeline = document.getElementById('btn-timeline');
  const timelineEl = document.getElementById('timeline');
  const timelineList = document.getElementById('timeline-list');
  function fmtClock(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  }
  function cap(agent) { return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent || ''; }
  function describeEvent(e) {
    if (e.type === 'session') return `${cap(e.agent)} session ${e.action}`;
    if (e.type === 'turn') {
      const d = e.delta;
      return `${cap(e.agent)} ${e.status === 'needs-input' ? 'asked for input' : 'finished a turn'}`
        + ` after ${fmtUptime((e.durationMs || 0) / 1000) || '0s'}`
        + (e.tool ? ` · ${e.tool}` : '')
        + (d && d.files ? ` · ${d.files}f +${d.insertions}−${d.deletions}` : '');
    }
    if (e.type === 'input-discarded') return `input not delivered to ${cap(e.agent)} (${e.failedBytes || 0}B failed, ${e.pendingBytes || 0}B discarded)`;
    if (e.type === 'handoff') {
      return `handoff ${e.phase}${e.source ? ` · ${cap(e.source)} → ${cap(e.target)}` : ''}${e.mode ? ` · ${e.mode}` : ''}`;
    }
    if (e.type === 'arbiter') return `arbiter ${e.phase || ''}${e.winner ? ` · winner ${cap(e.winner)}` : ''}`;
    return e.type || 'event';
  }
  function renderTimeline(events) {
    const items = (events || []).slice().reverse();
    timelineList.innerHTML = items.length
      ? items.map((e) => {
          const body = e.type === 'handoff' && e.text
            ? `<details><summary>${esc(fmtClock(e.ts))} · ${esc(describeEvent(e))}</summary><pre>${esc(e.text.slice(0, 4000))}</pre></details>`
            : `<div class="tl-row"><span class="tl-time">${esc(fmtClock(e.ts))}</span><span>${esc(describeEvent(e))}</span></div>`;
          return body;
        }).join('')
      : '<div class="sess-empty">Nothing recorded yet.</div>';
  }
  btnTimeline.addEventListener('click', () => vscode.postMessage({ type: 'timeline' }));
  timelineEl.addEventListener('click', (e) => {
    if (e.target.closest('#timeline-close')) { timelineEl.classList.add('hidden'); screen.focus({ preventScroll: true }); }
    else if (e.target.closest('#timeline-clear')) vscode.postMessage({ type: 'timelineClear' });
  });
  timelineEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); timelineEl.classList.add('hidden'); screen.focus({ preventScroll: true }); }
  });
  handoffMode.addEventListener('change', () => {
    if (!handoffDraft || handoffDraft.phase !== 'review') return;
    handoffDraft[handoffCurrentMode] = handoffText.value;
    vscode.postMessage({ type: 'updateHandoffDraft', id: handoffDraft.id, mode: handoffCurrentMode, text: handoffText.value });
    handoffCurrentMode = handoffMode.value;
    handoffText.value = handoffDraft[handoffCurrentMode];
    vscode.postMessage({ type: 'updateHandoffDraft', id: handoffDraft.id, mode: handoffCurrentMode, text: handoffText.value });
  });
  handoffText.addEventListener('input', () => {
    if (handoffDraft?.phase === 'collecting') {
      handoffDraft.details = handoffText.value;
      vscode.postMessage({ type: 'updateHandoffDetails', id: handoffDraft.id, details: handoffText.value });
    } else if (handoffDraft?.phase === 'review') {
      handoffDraft[handoffCurrentMode] = handoffText.value;
      vscode.postMessage({ type: 'updateHandoffDraft', id: handoffDraft.id, mode: handoffCurrentMode, text: handoffText.value });
    }
  });
  handoffCancel.addEventListener('click', () => {
    if (handoffDraft?.id) vscode.postMessage({ type: 'cancelHandoff', id: handoffDraft.id });
    handoffModal.classList.add('hidden');
    handoffDraft = null;
    handoffError.classList.add('hidden');
    screen.focus({ preventScroll: true });
  });
  handoffSend.addEventListener('click', () => {
    if (!handoffDraft) return;
    if (handoffDraft.phase === 'collecting') {
      handoffDraft.details = handoffText.value;
      handoffDraft.phase = 'creating';
      handoffText.readOnly = true;
      handoffSend.disabled = true;
      handoffSend.textContent = 'Creating…';
      handoffError.classList.add('hidden');
      vscode.postMessage({ type: 'createHandoff', id: handoffDraft.id, details: handoffText.value });
      return;
    }
    if (handoffDraft.phase === 'ackTimeout') {
      handoffSend.disabled = true;
      handoffSend.textContent = 'Accepting…';
      vscode.postMessage({ type: 'acceptHandoff', id: handoffDraft.id });
      return;
    }
    if (handoffDraft.phase !== 'review') return;
    handoffDraft[handoffCurrentMode] = handoffText.value;
    handoffSend.disabled = true;
    handoffCancel.disabled = true;
    handoffMode.disabled = true;
    handoffText.readOnly = true;
    handoffSend.textContent = 'Sending…';
    handoffError.classList.add('hidden');
    vscode.postMessage({
      type: 'confirmHandoff',
      id: handoffDraft.id,
      source: handoffDraft.source,
      target: handoffDraft.target,
      mode: handoffMode.value,
      text: handoffText.value,
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !handoffModal.classList.contains('hidden')) {
      const focusable = [...handoffModal.querySelectorAll('select, textarea, button')].filter((item) => !item.disabled);
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement);
      if (e.shiftKey && index <= 0) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && index === focusable.length - 1) { e.preventDefault(); focusable[0].focus(); }
      return;
    }
    if (e.key === 'Escape' && !handoffModal.classList.contains('hidden')) {
      e.preventDefault();
      handoffCancel.click();
      return;
    }
    if (e.key === 'Escape' && !arbiterModal.classList.contains('hidden')) {
      e.preventDefault();
      arbiterCancel.click();
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
      frameCache[m.agent] = {
        frame: m.cachedFrame ?? null, meta: m.cachedMeta || '', name: m.cachedName || '', latencyMs: 0,
      };
      if (m.historyMode === false && scrollState[m.agent].historyMode) {
        scrollState[m.agent].historyMode = false;
        scrollState[m.agent].pendingHistory = false;
        scrollState[m.agent].follow = true;
      }
      setActiveAgent(m.agent);
    } else if (m.type === 'agents') {
      renderAgents(m);
    } else if (m.type === 'handoffDetails') {
      handoffDraft = {
        id: m.id, source: m.source, target: m.target, phase: 'collecting', details: m.details || '',
      };
      handoffTitle.textContent = m.findings ? 'Request review findings' : 'Create AgentMux handoff';
      handoffMeta.textContent = `${m.source === 'claude' ? 'Claude' : 'Codex'} → ${m.target === 'claude' ? 'Claude' : 'Codex'} · ${m.findings ? 'findings report back to the author' : 'optional context'}`;
      handoffModeLabel.classList.add('hidden');
      handoffMode.classList.add('hidden');
      handoffTextLabel.textContent = 'Optional details to include in the handoff';
      handoffText.value = handoffDraft.details;
      handoffText.placeholder = 'What should the other agent know or prioritize?';
      handoffText.maxLength = 4000;
      handoffText.readOnly = false;
      handoffSend.disabled = false;
      handoffSend.textContent = 'Create handoff';
      handoffCancel.disabled = false;
      handoffCancel.textContent = 'Cancel';
      handoffError.classList.add('hidden');
      handoffModal.classList.add('details-step');
      handoffModal.classList.remove('hidden');
      handoffText.focus();
      handoffText.setSelectionRange(handoffText.value.length, handoffText.value.length);
    } else if (m.type === 'handoffChecking') {
      handoffDraft = { id: m.id, source: m.source, target: m.target, phase: 'checking' };
      handoffTitle.textContent = 'Create AgentMux handoff';
      handoffMeta.textContent = `${m.source === 'claude' ? 'Claude' : 'Codex'} → ${m.target === 'claude' ? 'Claude' : 'Codex'} · checking readiness`;
      handoffModeLabel.classList.add('hidden');
      handoffMode.classList.add('hidden');
      handoffTextLabel.textContent = 'Agent readiness';
      handoffText.value = 'Checking agents…';
      handoffText.readOnly = true;
      handoffMode.disabled = true;
      handoffSend.disabled = true;
      handoffSend.textContent = 'Checking…';
      handoffCancel.disabled = false;
      handoffError.classList.add('hidden');
      handoffModal.classList.add('details-step');
      handoffModal.classList.remove('hidden');
      handoffCancel.focus();
    } else if (m.type === 'handoffPreparing') {
      handoffDraft = { id: m.id, source: m.source, target: m.target, phase: 'preparing' };
      handoffTitle.textContent = 'Creating AgentMux handoff';
      handoffMeta.textContent = `${m.source === 'claude' ? 'Claude' : 'Codex'} → ${m.target === 'claude' ? 'Claude' : 'Codex'} · source-authored context`;
      handoffModeLabel.classList.add('hidden');
      handoffMode.classList.add('hidden');
      handoffTextLabel.textContent = 'Generated handoff';
      handoffText.value = `${m.source === 'claude' ? 'Claude' : 'Codex'} is preparing a focused handoff…`;
      handoffText.maxLength = 4000;
      handoffText.readOnly = true;
      handoffMode.disabled = true;
      handoffSend.disabled = true;
      handoffSend.textContent = 'Preparing…';
      handoffCancel.disabled = false;
      handoffError.classList.add('hidden');
      handoffModal.classList.add('details-step');
      handoffModal.classList.remove('hidden');
      handoffCancel.focus();
    } else if (m.type === 'handoffDraft') {
      handoffDraft = {
        id: m.id,
        source: m.source,
        target: m.target,
        phase: 'review',
        continue: m.continue,
        reviewOnly: m.reviewOnly,
        reviewFix: m.reviewFix,
      };
      handoffTitle.textContent = 'Review AgentMux handoff';
      handoffMeta.textContent = `${m.source === 'claude' ? 'Claude' : 'Codex'} → ${m.target === 'claude' ? 'Claude' : 'Codex'} · authored by source, Git facts added by AgentMux`;
      handoffModeLabel.classList.remove('hidden');
      handoffMode.classList.remove('hidden');
      handoffTextLabel.textContent = 'Message — fully editable before sending';
      handoffText.placeholder = '';
      handoffText.maxLength = 30000;
      handoffMode.value = m.mode || 'continue';
      handoffCurrentMode = handoffMode.value;
      handoffMode.disabled = false;
      handoffText.readOnly = false;
      handoffText.value = handoffDraft[handoffCurrentMode];
      handoffError.classList.add('hidden');
      handoffSend.disabled = false;
      handoffSend.textContent = 'Send handoff';
      handoffCancel.disabled = false;
      handoffCancel.textContent = 'Cancel';
      handoffModal.classList.remove('details-step');
      handoffModal.classList.remove('hidden');
      handoffText.focus();
      handoffText.setSelectionRange(0, 0);
    } else if (m.type === 'inputLocked') {
      applyPairLock();
    } else if (m.type === 'inputSuspended') {
      document.getElementById('hint').textContent = m.reason === 'handoff' ? 'handoff in progress' : 'session operation in progress';
      setTimeout(applyPairLock, 1200);
    } else if (m.type === 'inputError') {
      document.getElementById('hint').textContent = m.pendingBytes ? 'input failed · later keys discarded' : 'input not delivered';
      setStatus('', 'dead', 'input failed');
      setTimeout(applyPairLock, 2500);
    } else if (m.type === 'handoffCreateError') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffDraft.phase = 'collecting';
      handoffDraft.details = m.details || '';
      handoffTitle.textContent = 'Create AgentMux handoff';
      handoffModeLabel.classList.add('hidden');
      handoffMode.classList.add('hidden');
      handoffTextLabel.textContent = 'Optional details to include in the handoff';
      handoffText.value = handoffDraft.details;
      handoffText.placeholder = 'What should the other agent know or prioritize?';
      handoffText.maxLength = 4000;
      handoffText.readOnly = false;
      handoffSend.disabled = false;
      handoffSend.textContent = 'Create handoff';
      handoffCancel.disabled = false;
      handoffError.textContent = m.error || 'The handoff cannot be created yet.';
      handoffError.classList.remove('hidden');
      handoffModal.classList.add('details-step');
      handoffText.focus();
    } else if (m.type === 'handoffDraftError') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffDraft.phase = 'failed';
      handoffError.textContent = m.error || 'The source agent could not prepare the handoff.';
      handoffError.classList.remove('hidden');
      handoffSend.disabled = true;
      handoffSend.textContent = 'Unavailable';
    } else if (m.type === 'handoffAwaitingAck') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffDraft.phase = 'awaitingAck';
      handoffText.readOnly = true;
      handoffMode.disabled = true;
      handoffSend.disabled = true;
      handoffSend.textContent = 'Waiting for ACK…';
      handoffCancel.disabled = true;
      handoffError.classList.add('hidden');
    } else if (m.type === 'handoffDelivering') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffDraft.phase = 'delivering';
      handoffText.readOnly = true;
      handoffMode.disabled = true;
      handoffCancel.disabled = true;
      handoffSend.disabled = true;
      handoffSend.textContent = 'Sending…';
    } else if (m.type === 'handoffAckTimeout') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffDraft.phase = 'ackTimeout';
      handoffSend.disabled = false;
      handoffSend.textContent = 'Accept manually';
      handoffCancel.disabled = false;
      handoffCancel.textContent = 'Dismiss';
      handoffError.textContent = 'Delivered, but acknowledgement was not observed. Accept manually to transfer ownership, or dismiss (nothing is ever resent).';
      handoffError.classList.remove('hidden');
    } else if (m.type === 'handoffManualError') {
      if (!handoffDraft || handoffDraft.id !== m.id) return;
      handoffSend.disabled = !!m.stale;
      handoffSend.textContent = m.stale ? 'Prepare again' : 'Accept manually';
      handoffCancel.disabled = !m.stale;
      handoffError.textContent = m.error || 'The target is no longer available.';
      handoffError.classList.remove('hidden');
    } else if (m.type === 'handoffCancelled') {
      handoffModal.classList.add('hidden');
      handoffDraft = null;
      screen.focus({ preventScroll: true });
    } else if (m.type === 'handoffResult') {
      handoffSend.disabled = false;
      handoffSend.textContent = 'Send handoff';
      if (m.ok) {
        handoffModal.classList.add('hidden');
        handoffDraft = null;
        handoffError.classList.add('hidden');
        handoffMode.disabled = false;
        handoffText.readOnly = false;
        handoffCancel.disabled = false;
        screen.focus({ preventScroll: true });
      } else {
        handoffCancel.disabled = false;
        handoffMode.disabled = false;
        handoffText.readOnly = false;
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
        liveSeq = m.seq || 0;
        liveLines = m.historyMode ? null : m.frame.split('\n');
        frameCache[m.agent].frame = m.frame;
        if (hasSelection()) pendingFrame = { agent: m.agent, frame: m.frame }; // don't clobber a copy in progress
        else { render(m.frame); pendingFrame = null; }
      } else if (m.delta) {
        if (!liveLines || m.delta.baseSeq !== liveSeq) {
          vscode.postMessage({ type: 'resync' }); // broken chain -> ask for a full frame
        } else {
          liveSeq = m.delta.seq;
          for (const [idx, raw] of m.delta.changes) liveLines[idx] = raw;
          frameCache[m.agent].frame = liveLines.join('\n');
          if (hasSelection() || pendingFrame) {
            pendingFrame = { agent: m.agent, useLive: true };
          } else if (!patchRows(m.delta.changes)) {
            render(liveLines);
          }
        }
      }
      frameCache[m.agent].meta = m.meta || frameCache[m.agent].meta;
      frameCache[m.agent].name = m.name || frameCache[m.agent].name;
      frameCache[m.agent].latencyMs = parseInt(m.latencyMs, 10) || 0;
      applyFrameMeta(frameCache[m.agent].meta, frameCache[m.agent].name, frameCache[m.agent].latencyMs);
    } else if (m.type === 'bgFrame') {
      // Background agent captures keep the inactive tab's cache warm so a
      // switch paints an at-most-seconds-old frame instantly.
      if (frameCache[m.agent] && m.agent !== activeAgent) frameCache[m.agent].frame = m.frame;
    } else if (m.type === 'timeline') {
      renderTimeline(m.events);
      timelineEl.classList.remove('hidden');
    } else if (m.type === 'arbiterPrompt') {
      arbiterState = { id: m.id, phase: 'collecting' };
      arbiterMeta.textContent = 'One question, two independent answers, no file changes. The winner becomes Pair Mode writer.';
      arbiterBody.innerHTML = '<textarea id="arbiter-text" spellcheck="false" placeholder="Design question, bug diagnosis, \'which approach is right\'…"></textarea>';
      arbiterError.classList.add('hidden');
      arbiterSend.disabled = false;
      arbiterSend.textContent = 'Ask both';
      arbiterSend.classList.remove('hidden');
      arbiterCancel.disabled = false;
      arbiterModal.classList.remove('hidden');
      document.getElementById('arbiter-text').focus();
    } else if (m.type === 'arbiterGathering') {
      if (!arbiterState || arbiterState.id !== m.id) return;
      arbiterState.phase = 'gathering';
      arbiterMeta.textContent = 'Both agents are answering… input is paused until the round finishes.';
      arbiterBody.innerHTML = '<div class="sess-empty">Waiting for both marked answers (up to 3 minutes)…</div>';
      arbiterSend.disabled = true;
      arbiterSend.textContent = 'Gathering…';
    } else if (m.type === 'arbiterVerdict') {
      if (!arbiterState || arbiterState.id !== m.id) return;
      arbiterState.phase = 'verdict';
      arbiterMeta.textContent = 'Pick the answer to act on — the winner becomes the Pair Mode writer.';
      const side = (agent, text) => text
        ? `<details open class="arb-answer"><summary>${agent === 'claude' ? 'Claude' : 'Codex'}</summary><pre>${esc(text)}</pre>`
          + `<button class="primary" data-winner="${agent}">Use ${agent === 'claude' ? "Claude's" : "Codex's"} answer</button></details>`
        : `<div class="sess-empty">${agent === 'claude' ? 'Claude' : 'Codex'} returned no marked answer.</div>`;
      arbiterBody.innerHTML = side('claude', m.claude) + side('codex', m.codex);
      arbiterSend.classList.add('hidden');
      arbiterCancel.disabled = false;
    } else if (m.type === 'arbiterError') {
      if (!arbiterState || arbiterState.id !== m.id) return;
      if (arbiterState.phase === 'collecting') {
        arbiterSend.disabled = false;
        arbiterSend.textContent = 'Ask both';
        arbiterError.textContent = m.error || 'Arbiter round failed.';
        arbiterError.classList.remove('hidden');
      } else {
        arbiterError.textContent = m.error || 'Arbiter round failed.';
        arbiterError.classList.remove('hidden');
        arbiterSend.disabled = true;
        arbiterCancel.disabled = false;
      }
    } else if (m.type === 'arbiterDone' || m.type === 'arbiterCancelled') {
      closeArbiter();
    } else if (m.type === 'promptHistory') {
      recallItems = Array.isArray(m.list) ? m.list : [];
      recallIndex = 0;
      recallFilter.value = '';
      renderRecall();
      recallEl.classList.remove('hidden');
      recallFilter.focus();
    } else if (m.type === 'preflight') {
      renderPreflight(m);
    } else if (m.type === 'nosession') {
      if (m.agent !== activeAgent) return;
      frameCache[m.agent] = { frame: null, meta: '', name: '', latencyMs: 0 };
      exitVirtual();
      screen.replaceChildren();
      renderedLineCount = 0;
      liveLines = null;
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
        if (m.list && m.list.length) {
          overlayTitle.textContent = 'Attach to a Codex session';
          setSessions(m.list);
        } else {
          overlayTitle.textContent = 'Start or resume Codex';
          sessionFilter.classList.add('hidden');
          sessionList.innerHTML = '<div class="sess-empty">No Codex conversations found for this workspace.</div>';
        }
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
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scheduleReportSize(true));
  if (window.ResizeObserver) new ResizeObserver(() => scheduleReportSize()).observe(wrap);
  window.addEventListener('resize', () => scheduleReportSize());
  vscode.postMessage({ type: 'ready' });
  setTimeout(() => screen.focus(), 200);
})();
