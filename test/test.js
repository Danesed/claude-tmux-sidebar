const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const workspace = root;
const calls = [];
const messages = [];
let failPaste = false;
let agentInfoOutput = null;
let holdNextSend = false;
let heldSendCallback = null;
let captureOutput = 'terminal frame\n';
let opencodeSessionsJson = null;
let hermesSessionsTable = null;
let warningAnswer;
let quickPickAnswer;
let quickPickItems = null;
let sessionListOutput = null;
const outputLines = [];
const settings = new Map([
  ['codexArgs', '--no-alt-screen'],
  ['codexFullAccess', true],
  ['codexReadClaudeRules', true],
  ['sessionPrefix', 'tmux_'],
  ['codexSessionPrefix', 'codex_'],
  ['opencodeArgs', '--auto'],
  ['hermesArgs', '--cli --yolo'],
  ['hermesSessionPrefix', 'tmux_hermes_'],
  ['opencodeSessionPrefix', 'tmux_opencode_'],
  ['antigravityArgs', '--dangerously-skip-permissions'],
  ['antigravitySessionPrefix', 'tmux_agy_'],
  ['scrollbackLines', 1000],
  // Keep tests hermetic: no ledger writes into the repo, no real transports,
  // no hook assets, no telemetry reads.
  ['eventLog', false],
  ['transport', 'poll'],
  ['stateHooks', false],
  ['telemetry', false],
  ['notifyPrompts', false],
  ['promptHistory', false],
  ['tmuxStatusBar', false],
  // Legacy paste/scrape delivery keeps the historical contract assertions valid;
  // the file channel gets its own hermetic tests.
  ['fileChannel', false],
]);

function execFile(command, args, options, callback) {
  calls.push({ command, args: [...args] });
  if (command === 'opencode') {
    if (opencodeSessionsJson == null) return callback(new Error('opencode not installed'), '', '');
    return callback(null, opencodeSessionsJson, '');
  }
  if (command === 'hermes') {
    if (args[0] === 'sessions' && args[1] === 'list') return callback(null, hermesSessionsTable || '', '');
    if (args[0] === 'profile' && args[1] === 'create') {
      const root = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
      const dir = path.join(root, 'profiles', args[2]);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: {}\n');
      } catch { /* readonly */ }
      return callback(null, `Profile '${args[2]}' created\n`, '');
    }
    return callback(null, '', '');
  }
  if (command !== 'tmux') return callback(null, '', '');
  if (args[0] === 'display-message') {
    const format = args[args.length - 1];
    if (format === '#{session_path}') {
      const target = args[args.indexOf('-t') + 1] || '';
      // Sessions named *_other belong to a different project, so ownership
      // checks on them must fail exactly as they would in reality.
      if (target.includes('_other')) return callback(null, '/tmp/another-project\n', '');
      // tmux 3.4 answers a MISSING '=name:' target with exit 0 and an empty
      // line instead of an error, which is what *_missing reproduces here.
      // A *_legacy session exists ONLY under its path-hashed name, the way an
      // older AgentMux would have created it.
      if (target.includes('_legacy')) return callback(null, /-[0-9a-f]{8}:?$/.test(target) ? workspace + '\n' : '\n', '');
      if (target.includes('_missing')) return callback(null, '\n', '');
      return callback(null, workspace + '\n', '');
    }
    if (format.includes('@claude_tmux_agent')) {
      if (agentInfoOutput != null) return callback(null, workspace + '\t' + agentInfoOutput, '');
      const target = args[args.indexOf('-t') + 1];
      // Same conventions as #{session_path} above: a *_other session lives in a
      // different project, and a *_missing target does not exist at all (tmux
      // 3.4 still exits 0 for it, with every field empty).
      if (target.includes('_other')) return callback(null, '/tmp/another-project\tclaude\t1\tclaude\t1700000000\tgen-a\n', '');
      if (target.includes('_missing')) return callback(null, '\t\t\t\t\t\n', '');
      const agent = target.includes('tmux_hermes_') ? 'hermes'
        : target.includes('tmux_opencode_') ? 'opencode'
        : target.includes('tmux_agy_') ? 'antigravity'
          : target.includes('codex_') ? 'codex' : 'claude';
      return callback(null, `${workspace}\t${agent}\t1\t${agent}\t1700000000\tgen-a\n`, '');
    }
    return callback(null, '2,3,80,24,1700000000,240,0\n', '');
  }
  if (args[0] === 'list-sessions' && sessionListOutput != null) {
    return callback(null, sessionListOutput, '');
  }
  if (args[0] === 'capture-pane') {
    // Live ticks fuse the meta display-message into the same invocation.
    const fused = args.includes(';');
    return callback(null, captureOutput + (fused ? '\x1f2,3,80,24,1700000000,240,0\n' : ''), '');
  }
  if (args[0] === 'paste-buffer' && failPaste) return callback(new Error('simulated paste failure'), '', '');
  if (args[0] === 'send-keys' && args.includes('-H') && holdNextSend) {
    holdNextSend = false;
    heldSendCallback = callback;
    return;
  }
  callback(null, '', '');
}

// The presence loop posts 'agents' asynchronously, so "the last message" is not
// a stable way to assert about a specific one: look up the newest of a type.
function byAgentIds(make) {
  const out = {};
  for (const id of AGENT_IDS) out[id] = make(id);
  return out;
}

function lastOfType(type) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === type) return messages[i];
  }
  return null;
}

const state = new Map();
const executedCommands = [];
let inputBoxAnswer;
const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspace } }],
    getConfiguration(section) {
      if (section === 'terminal.integrated') return { get: () => undefined };
      return {
        get: (key) => settings.get(key),
        // The free-mode roster is read and written per scope; the test host
        // models a single (user-level) scope.
        inspect: (key) => ({ globalValue: settings.get(key) }),
        update: async (key, value) => settings.set(key, value),
      };
    },
  },
  window: {
    showWarningMessage: async () => warningAnswer,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => inputBoxAnswer,
    showQuickPick: async (items) => { quickPickItems = await items; return quickPickAnswer; },
    createOutputChannel: () => ({
      appendLine: (line) => outputLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
  },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async (name) => { executedCommands.push(name); } },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { joinPath: (...parts) => parts.join('/') },
};

const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8')
  + '\nmodule.exports.__test = { ClaudeTmuxView, sessionName, accentChannels, derivedAccent, derivedMark, decodeEscapes, AGENT_DETECTION, paneIdentity, identityMatches, STATE_HOOK_SCRIPT, setStateHookDir, codexHookArgs, tomlString, listPiSessions, piSessionDir, piExtensionPath, ensurePiExtension, removePiExtension, PI_EXTENSION, customAgentSpecs, registerCustomAgents, freeAgentId, mirroredSessionNames, baseSessionName, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo, extractMarkedBlock, sourceHandoffPrompt, findingsPrompt, splitFusedCapture, diffFrameLines, TmuxControlClient, listCodexSessions, listSessions, AGENTS, AGENT_IDS, launchArgs, paneLooksLikeAgent, listOpencodeSessions, listHermesSessions, hermesProfileSlug, hermesProfileHome, ensureHermesProfile, launchEnvPrefix, detectionRules, detectScreenState, OPENCODE_PLUGIN, ensureOpencodePlugin, removeOpencodePlugin, opencodePluginPath };';
const moduleUnderTest = { exports: {} };
const sandbox = {
  module: moduleUnderTest,
  exports: moduleUnderTest.exports,
  require(id) {
    if (id === 'vscode') return vscode;
    if (id === 'child_process') return { execFile };
    return require(id);
  },
  __dirname: root,
  __filename: path.join(root, 'extension.js'),
  Buffer,
  console,
  process,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
vm.runInNewContext(source, sandbox, { filename: 'extension.js' });
const { ClaudeTmuxView, sessionName, accentChannels, derivedAccent, derivedMark, decodeEscapes, AGENT_DETECTION, paneIdentity, identityMatches, STATE_HOOK_SCRIPT, setStateHookDir, codexHookArgs, tomlString, listPiSessions, piSessionDir, piExtensionPath, ensurePiExtension, removePiExtension, PI_EXTENSION, customAgentSpecs, registerCustomAgents, freeAgentId, mirroredSessionNames, baseSessionName, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo, extractMarkedBlock, sourceHandoffPrompt, findingsPrompt, splitFusedCapture, diffFrameLines, TmuxControlClient, listCodexSessions, listSessions, AGENTS, AGENT_IDS, launchArgs, paneLooksLikeAgent, listOpencodeSessions, listHermesSessions, hermesProfileSlug, hermesProfileHome, ensureHermesProfile, launchEnvPrefix, detectionRules, detectScreenState, OPENCODE_PLUGIN, ensureOpencodePlugin, removeOpencodePlugin, opencodePluginPath } = moduleUnderTest.exports.__test;

function makeProvider() {
  const provider = new ClaudeTmuxView({
    extensionUri: root,
    subscriptions: [],
    workspaceState: {
      get: (key) => state.get(key),
      update: async (key, value) => state.set(key, value),
    },
  });
  provider.view = {
    visible: true,
    webview: { postMessage: (message) => messages.push(message) },
  };
  return provider;
}

function sendCalls() {
  return calls.filter((call) => call.command === 'tmux' && call.args[0] === 'send-keys' && call.args.includes('-H'));
}

function decodeSendCalls(list) {
  const bytes = [];
  for (const call of list) {
    const index = call.args.indexOf('-H');
    for (const hex of call.args.slice(index + 1)) bytes.push(parseInt(hex, 16));
  }
  return Buffer.from(bytes).toString('utf8');
}

function deliveredInput() {
  let result = '';
  for (const call of calls) {
    if (call.args[0] === 'set-buffer') result += call.args.at(-1);
    if (call.args[0] === 'send-keys' && call.args.includes('-H')) result += decodeSendCalls([call]);
  }
  return result;
}

async function waitForFlush(provider, agent) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await provider.inputQueues[agent].chain;
}

async function run() {
  const args = codexLaunchArgs();
  assert.match(args, /--no-alt-screen/);
  assert.match(args, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(args, /developer_instructions=/);
  assert.match(CODEX_CLAUDE_RULES, /every Markdown file under the workspace \.claude directory/);

  settings.set('codexArgs', '--sandbox read-only');
  assert.doesNotMatch(codexLaunchArgs(), /--dangerously-bypass-approvals-and-sandbox/);
  settings.set('codexArgs', '--no-alt-screen');

  agentInfoOutput = '\t\tzsh\t1700000000\tgen-a\n';
  const shellOnly = await agentSessionInfo('codex', 'codex_claude-tmux-sidebar');
  assert.deepStrictEqual(
    { exists: shellOnly.exists, ready: shellOnly.ready, shell: shellOnly.shell, command: shellOnly.command },
    { exists: true, ready: false, shell: true, command: 'zsh' },
    'an existing shell must not be mistaken for a running agent'
  );
  agentInfoOutput = null;

  settings.set('codexArgs', `--no-alt-screen -c 'developer_instructions="custom"'`);
  assert.doesNotMatch(codexLaunchArgs(), /workspace \.claude directory/);
  settings.set('codexArgs', '--no-alt-screen');

  // ---- Codex native lifecycle hooks -----------------------------------------------------
  // notify could only ever report `done`; the hook set reports the whole
  // lifecycle, PermissionRequest included (real approval detection, not a guess
  // at prompt wording). Verified against the CLI, which prints "hook: <Event>"
  // for each one as it runs.
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-hooks-'));
  setStateHookDir(hookDir);
  settings.set('stateHooks', true);
  const hooked = codexLaunchArgs();
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']) {
    assert.ok(hooked.includes(`hooks.${event}=[`), `codex launch must register the ${event} hook`);
  }
  assert.match(hooked, /notify=/, 'notify stays as the fallback for a user who declines the hook trust prompt');
  assert.ok(hooked.includes('-c '), 'hooks travel per launch as -c overrides, never into the user\'s config.toml');

  // Assert the generated TOML on its own, where the outer shell quoting of the
  // -c argument does not obscure it. The script path is shell-quoted INSIDE the
  // TOML string because Codex runs a hook `command` as a shell command line —
  // an unquoted macOS path ("Application Support") would otherwise split.
  const hookArgs = codexHookArgs('/opt/Application Support/agentmux-state.sh');
  const byEvent = {};
  for (const arg of hookArgs) {
    const m = /^-c '(hooks\.([A-Za-z]+)=.*)'$/s.exec(arg.replace(/'"'"'/g, "'"));
    assert.ok(m, `each hook is one -c override: ${arg}`);
    byEvent[m[2]] = m[1];
  }
  assert.strictEqual(
    byEvent.PermissionRequest,
    `hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command="'/opt/Application Support/agentmux-state.sh' needs-input"}]}]`,
    'PermissionRequest stamps needs-input, with a path safe to hand to a shell');
  assert.ok(byEvent.SessionStart.includes('matcher="startup|resume|clear"')
    && byEvent.SessionStart.includes(' register"'),
    'SessionStart only registers the conversation id — a session that just started has not finished');
  assert.ok(byEvent.Stop.includes(' done"') && !byEvent.Stop.includes('matcher'));

  settings.set('codexHooks', false);
  assert.doesNotMatch(codexLaunchArgs(), /hooks\./, 'claudeTmux.codexHooks=false drops the hook set');
  assert.match(codexLaunchArgs(), /notify=/, '…but notify still reports done');
  settings.set('codexHooks', true);

  settings.set('codexArgs', `--no-alt-screen -c 'hooks.Stop=[]'`);
  assert.doesNotMatch(codexLaunchArgs(), /hooks\.PermissionRequest/,
    'an explicit hooks override in codexArgs wins outright');
  settings.set('codexArgs', '--no-alt-screen');

  // Codex's one-time "trust these hook commands" prompt genuinely waits for a key.
  assert.strictEqual(detectScreenState('codex', '⚠ 2 hooks need review before they can run.').status,
    'needs-input', 'the hook trust prompt is waiting for the user');
  assert.strictEqual(detectScreenState('codex', 'Press t to trust all; enter to review hooks; esc to close').status,
    'needs-input');

  // The shared hook script reads its JSON payload once and serves both CLIs.
  assert.match(STATE_HOOK_SCRIPT, /head -c 4000/, 'the payload is read once, bounded');
  assert.match(STATE_HOOK_SCRIPT, /"session_id"/, 'the conversation id is captured for exact resume');
  assert.match(STATE_HOOK_SCRIPT, /if \[ "\$state" != "register" \]/,
    'register records identity without claiming a state');
  assert.strictEqual(fs.readFileSync(path.join(hookDir, 'agentmux-state.sh'), 'utf8'), STATE_HOOK_SCRIPT,
    'the shared script is materialized before it is referenced');
  // A path with a quote must not break out of the TOML string it travels in.
  assert.strictEqual(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  settings.set('stateHooks', false);
  setStateHookDir(null);
  fs.rmSync(hookDir, { recursive: true, force: true });

  const provider = makeProvider();
  calls.length = 0;
  await provider.runAgentCommand('codex', 'codex_claude-tmux-sidebar', 'codex');
  await provider.runAgentCommand('codex', 'codex_claude-tmux-sidebar', 'codex');
  const generations = calls
    .filter((call) => call.args.includes('@claude_tmux_generation'))
    .map((call) => call.args.at(-1));
  assert.strictEqual(new Set(generations).size, 2, 'each managed agent launch must receive a new generation identity');
  calls.length = 0;
  const burst = 'abcdefghij'.repeat(20);
  for (const char of burst) provider.queueInput('codex', char);
  provider.activeAgent = 'claude';
  await waitForFlush(provider, 'codex');
  assert.strictEqual(sendCalls().length, 1, 'a 200-character burst should use one tmux send');
  assert.strictEqual(decodeSendCalls(sendCalls()), burst, 'batched input must preserve bytes and target agent');

  calls.length = 0;
  provider.queueInput('codex', 'y');
  await waitForFlush(provider, 'codex');
  assert.strictEqual(sendCalls().length, 1, 'a warm-cache keystroke must still be delivered');
  assert.strictEqual(calls[0].args[0], 'send-keys', 'a keystroke with a warm session cache must go straight to tmux send-keys, with no per-key session lookups');

  calls.length = 0;
  holdNextSend = true;
  provider.queueInput('codex', 'a', true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(heldSendCallback, 'the first send should be in flight');
  provider.queueInput('codex', 'b');
  provider.queueInput('codex', 'c');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(sendCalls().length, 1, 'pending input must merge while one tmux send is in flight');
  const releaseSend = heldSendCallback;
  heldSendCallback = null;
  releaseSend(null, '', '');
  await provider.inputQueues.codex.chain;
  assert.strictEqual(sendCalls().length, 2, 'merged pending input should use one follow-up send');
  assert.strictEqual(decodeSendCalls(sendCalls()), 'abc', 'the input pump must preserve byte order');

  calls.length = 0;
  provider.queueInput('codex', 'flush-before-operation');
  await provider.withInputSuspended('codex', async () => true);
  assert.strictEqual(decodeSendCalls(sendCalls()), 'flush-before-operation', 'session operations must flush pending input instead of dropping it');

  calls.length = 0;
  holdNextSend = true;
  provider.queueInput('codex', 'x', true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  provider.queueInput('codex', 'y');
  provider.queueInput('codex', 'z');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failHeldSend = heldSendCallback;
  heldSendCallback = null;
  failHeldSend(new Error('simulated send failure'), '', '');
  await provider.inputQueues.codex.chain;
  assert.strictEqual(provider.inputQueues.codex.data, '', 'unattempted input must be discarded explicitly after a failed send');
  assert.strictEqual(messages.at(-1).pendingBytes, 2, 'the UI must report how much later input was discarded');
  calls.length = 0;
  await provider.queueInput('codex', 'w', true);
  assert.strictEqual(decodeSendCalls(sendCalls()), 'w', 'discarded input must not be replayed into a restarted session');

  calls.length = 0;
  provider.queueInput('codex', 'must-not-cross-workspaces');
  vscode.workspace.workspaceFolders[0].uri.fsPath = workspace + '-other';
  await waitForFlush(provider, 'codex');
  assert.strictEqual(sendCalls().length, 0, 'queued input must be dropped after a workspace change');
  vscode.workspace.workspaceFolders[0].uri.fsPath = workspace;

  calls.length = 0;
  const paste = 'à🙂0123456789\n'.repeat(700);
  await provider.queueInput('codex', paste, true);
  assert.strictEqual(deliveredInput(), paste, 'large UTF-8 paste must preserve exact content');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'paste-buffer').length, 1, 'large paste should use one bracketed tmux paste');

  calls.length = 0;
  provider.activeAgent = 'codex';
  provider.agentState.codex.historyMode = false;
  await provider.tickOnce(true);
  let captures = calls.filter((call) => call.args[0] === 'capture-pane');
  assert.ok(!captures[0].args.includes('-S'), 'live polling must not capture scrollback');
  calls.length = 0;
  provider.agentState.codex.historyMode = true;
  provider.agentState.codex.historyPending = true;
  await provider.tickOnce(true);
  captures = calls.filter((call) => call.args[0] === 'capture-pane');
  assert.deepStrictEqual(captures[0].args.slice(0, 5), ['capture-pane', '-p', '-e', '-S', '-1000']);
  calls.length = 0;
  await provider.tickOnce(false);
  captures = calls.filter((call) => call.args[0] === 'capture-pane');
  assert.ok(!captures[0].args.includes('-S'), 'history must be captured once, not on every refresh');

  provider.agentState.codex.historyMode = false;
  provider.agentState.codex.lastLiveFrame = 'terminal frame\n';
  provider.agentState.codex.lastMeta = '2,3,80,24,1700000000,240';
  calls.length = 0;
  await provider.tickOnce(false);
  assert.strictEqual(calls.length, 1, 'an unchanged warm live tick must cost exactly one tmux process (fused capture+meta)');

  // ---- fused capture + line-delta transport ---------------------------------
  const fusedSplit = splitFusedCapture('line1\nline2\n\x1f1,2,80,24,1700000000,240,0\n');
  assert.strictEqual(fusedSplit.frame, 'line1\nline2\n');
  assert.strictEqual(fusedSplit.meta, '1,2,80,24,1700000000,240,0');
  const trickySplit = splitFusedCapture('pane text with \x1f inside\n');
  assert.strictEqual(trickySplit.frame, 'pane text with \x1f inside\n', 'pane bytes must never be mistaken for the meta sentinel');
  assert.strictEqual(trickySplit.meta, null);
  // tmux 3.4 (Ubuntu 24.04) octal-escapes control characters in display-message
  // output: the sentinel arrives as the literal text "\037". Without this the
  // cursor meta never parses over Remote-SSH hosts running such tmux, and the
  // meta line renders as an extra pane row that jitters the follow scroll.
  const escapedSplit = splitFusedCapture('line1\nline2\n\\0371,2,80,24,1700000000,240,0\n');
  assert.strictEqual(escapedSplit.meta, '1,2,80,24,1700000000,240,0', 'octal-escaped sentinels must still yield cursor meta');
  assert.strictEqual(escapedSplit.frame, 'line1\nline2\n', 'the escaped meta line must never render as pane text');
  const escapedTricky = splitFusedCapture('pane text with a literal \\037 inside\n');
  assert.strictEqual(escapedTricky.meta, null, 'a bare escaped sentinel in pane text must not be mistaken for meta');
  const leakedEscaped = splitFusedCapture('line1\nstale\\0379,9,99,99,1700000000,5,0\nline2\n\\0371,2,80,24,1700000000,240,0\n');
  assert.strictEqual(leakedEscaped.meta, '1,2,80,24,1700000000,240,0');
  assert.strictEqual(leakedEscaped.frame, 'line1\nline2\n', 'leaked escaped meta lines must be stripped like raw ones');
  assert.strictEqual(diffFrameLines(['a', 'b', 'c', ''], ['a', 'X', 'c', ''], 100).length, 1);
  assert.strictEqual(diffFrameLines(['a', 'b'], ['a', 'b', 'c'], 100), null, 'row-count changes require a full frame');

  captureOutput = Array.from({ length: 20 }, (_, i) => 'row ' + i).join('\n') + '\n';
  provider.resetLiveFrame('codex');
  messages.length = 0;
  await provider.tickOnce(true);
  const fullFrameMsg = messages.filter((msg) => msg.type === 'frame').at(-1);
  assert.ok(fullFrameMsg.frame && !fullFrameMsg.delta, 'a forced tick sends the full frame');
  assert.strictEqual(fullFrameMsg.meta, '2,3,80,24,1700000000,240,0', 'cursor meta must ride fused with the frame it describes');
  captureOutput = captureOutput.replace('row 7', 'row 7 CHANGED');
  messages.length = 0;
  await provider.tickOnce(false);
  const deltaMsg = messages.filter((msg) => msg.type === 'frame').at(-1);
  assert.strictEqual(deltaMsg.frame, null, 'small changes must travel as line deltas');
  assert.strictEqual(JSON.stringify(deltaMsg.delta.changes), '[[7,"row 7 CHANGED"]]');
  assert.strictEqual(deltaMsg.delta.baseSeq + 1, deltaMsg.delta.seq, 'deltas must chain by sequence number');
  captureOutput = 'terminal frame\n';
  provider.resetLiveFrame('codex');

  // ---- adaptive cadence -------------------------------------------------------
  provider._lastInputAt = Date.now();
  assert.ok(provider.nextTickDelay() <= 120, 'typing must run the loop hot');
  provider._lastInputAt = 0;
  provider._lastFrameChangeAt = 0;
  assert.ok(provider.nextTickDelay() >= 400, 'a static pane must decay the loop');
  provider._eventSourceLive = true;
  assert.ok(provider.nextTickDelay() >= 500, 'a live push source demotes polling to a watchdog');
  provider._eventSourceLive = false;

  // ---- control-mode client fundamentals ----------------------------------------
  assert.strictEqual(TmuxControlClient.quoteArg("it's"), "'it'\\''s'");
  assert.ok(TmuxControlClient.controlSafe(['display-message', '-p', '#{pane_id}']));
  assert.ok(!TmuxControlClient.controlSafe(['set-buffer', '--', 'multi\nline']), 'multiline payloads must stay on execFile');

  // A ';'-fused argv must be written as ONE CONTROL LINE PER COMMAND: a line
  // always yields exactly one %begin/%end block on every tmux version, while
  // ';'-fused lines yield a version-dependent block count that desynchronized
  // the reply queue (stuck input, meta lines leaking into rendered frames).
  const ctl = new TmuxControlClient();
  const written = [];
  ctl.proc = { exitCode: null, stdin: { write: (s) => written.push(s) } };
  ctl.alive = true;
  const fusedExec = ctl.exec(['capture-pane', '-p', ';', 'display-message', '-p', 'x']);
  assert.deepStrictEqual(
    written.join('').split('\n').filter(Boolean),
    ["'capture-pane' '-p'", "'display-message' '-p' 'x'"],
    'fused argv must become one control line per command'
  );
  assert.strictEqual(ctl.pending.length, 2, 'one reply slot per control line');
  ctl.onLine('%begin 1 1 1');
  ctl.onLine('frame');
  ctl.onLine('%end 1 1 1');
  ctl.onLine('%begin 1 2 1');
  ctl.onLine('\x1f1,2,80,24,1,0,0');
  ctl.onLine('%end 1 2 1');
  const fusedReply = await fusedExec;
  assert.strictEqual(fusedReply.ok, true);
  assert.strictEqual(fusedReply.out, 'frame\n\x1f1,2,80,24,1,0,0\n', 'both blocks must resolve the single fused call in order');
  assert.strictEqual(ctl.pending.length, 0);

  // A dead control client must mark failures as transport-level, so idempotent
  // commands can fail over to execFile instead of reading as "no session".
  const dyingCtl = new TmuxControlClient();
  dyingCtl.proc = { exitCode: null, stdin: { write: () => {} }, kill: () => {} };
  dyingCtl.alive = true;
  const inflight = dyingCtl.exec(['capture-pane', '-p']);
  dyingCtl.destroy(true);
  const flushed = await inflight;
  assert.strictEqual(flushed.ok, false);
  assert.strictEqual(flushed.transportFailed, true, 'control-client death must be distinguishable from a tmux error reply');

  // Defense in depth: a meta line that ever leaks into pane text is stripped.
  const leaked = splitFusedCapture('line1\nstale\x1f9,9,99,99,1700000000,5,0\nline2\n\x1f1,2,80,24,1700000000,240,0\n');
  assert.strictEqual(leaked.meta, '1,2,80,24,1700000000,240,0');
  assert.strictEqual(leaked.frame, 'line1\nline2\n', 'leaked meta lines must never render as pane text');

  const cwd = workspace;
  provider.rememberSession('claude', cwd, 'tmux_claude-tmux-sidebar', true);
  provider.rememberSession('codex', cwd, 'codex_claude-tmux-sidebar', true);
  provider.agentState.claude.present = true;
  provider.agentState.codex.present = true;
  provider.agentState.claude.backgroundPollAt = Date.now();
  calls.length = 0;
  await provider.pollPresence(true);
  assert.strictEqual(
    calls.filter((call) => call.args[0] === 'display-message' && call.args.at(-1).includes('@claude_tmux_agent')).length,
    AGENT_IDS.length,
    'warm presence polling should verify each agent with one tmux process'
  );

  calls.length = 0;
  const resize = provider.setSize(80, 24);
  provider.setSize(90, 30);
  provider.setSize(110, 36);
  await resize;
  const resizeCalls = calls.filter((call) => call.args[0] === 'resize-window');
  assert.ok(resizeCalls.length <= 2, 'concurrent resize requests should coalesce to current plus latest');
  assert.deepStrictEqual(resizeCalls.at(-1).args.slice(-4), ['-x', '110', '-y', '36']);

  provider.activeAgent = 'claude';
  provider.agentState.codex.historyMode = true;
  provider.agentState.codex.historyPending = false;
  provider.agentState.codex.lastFrame = 'cached live frame\n';
  messages.length = 0;
  provider.switchAgent('codex');
  await provider._resizePromise;
  assert.strictEqual(provider.agentState.codex.historyMode, false, 'switching back from history must return to live mode');
  assert.strictEqual(messages.find((message) => message.type === 'activeAgent').cachedFrame, 'cached live frame\n');

  provider.agentState.codex.status = 'working';
  provider.agentState.codex.lastActivity = Date.now() - 5000;
  provider.updateActivity('codex', 'unchanged frame', false);
  assert.strictEqual(provider.agentState.codex.status, 'done');
  provider.updateActivity('codex', 'Approval required\n[y/n]', true);
  assert.strictEqual(provider.agentState.codex.status, 'needs-input');
  provider.agentState.claude.status = 'idle';
  provider.updateActivity('claude', 'typed a', true);
  provider.updateActivity('claude', 'typed ab', true);
  assert.strictEqual(provider.agentState.claude.status, 'idle', 'echoed typing must not claim the agent is working');

  calls.length = 0;
  provider.agentState.claude.present = true;
  provider.agentState.codex.present = true;
  provider.agentState.claude.status = 'idle';
  provider.agentState.codex.status = 'idle';
  messages.length = 0;
  provider.prepareHandoff('claude');
  const collectingId = provider.handoff.id;
  assert.strictEqual(provider.handoff.phase, 'collecting', 'the first click must only open the optional-details phase');
  assert.strictEqual(calls.length, 0, 'opening handoff details must not contact tmux or either agent');
  assert.strictEqual(messages.at(-1).type, 'handoffDetails');
  provider.updateHandoffDetails({ id: collectingId, details: 'Prioritize the SSH regression.' });
  messages.length = 0;
  provider.postHandoffState();
  assert.strictEqual(messages.at(-1).details, 'Prioritize the SSH regression.', 'optional details must survive webview rehydration');
  provider.cancelHandoff(collectingId);
  assert.strictEqual(provider.handoff, null, 'Cancel from optional details must discard the local transaction');
  assert.strictEqual(calls.length, 0, 'Cancel from optional details must not contact an agent');

  provider.prepareHandoff('claude');
  const createId = provider.handoff.id;
  await provider.createHandoff({ id: 'stale-create-id', details: 'must be ignored' });
  assert.strictEqual(provider.handoff.phase, 'collecting', 'a stale Create request must not advance the transaction');
  assert.strictEqual(calls.length, 0, 'a stale Create request must not contact an agent');
  messages.length = 0;
  await provider.createHandoff({ id: createId, details: 'x'.repeat(4001) });
  assert.strictEqual(provider.handoff.phase, 'collecting', 'oversized details must return to the editable first step');
  assert.strictEqual(messages.at(-1).type, 'handoffCreateError');
  assert.strictEqual(calls.length, 0, 'invalid details must not contact an agent');
  const userDetails = 'Preserve the exact public API; prioritize the SSH regression.';
  holdNextSend = true;
  provider.queueInput('claude', '\x04', true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(heldSendCallback, 'source control input should be held before Create');
  const createAfterQueuedInput = provider.createHandoff({ id: createId, details: userDetails });
  await new Promise((resolve) => setTimeout(resolve, 0));
  agentInfoOutput = '\t\tzsh\t1700000000\tgen-a\n';
  const releaseSourceInput = heldSendCallback;
  heldSendCallback = null;
  releaseSourceInput(null, '', '');
  await createAfterQueuedInput;
  assert.strictEqual(provider.handoff.phase, 'collecting', 'Create must return to details when the source TUI exited');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'set-buffer').length, 0, 'source verification after queued input must prevent a prompt paste into the shell');
  agentInfoOutput = null;
  const originalWaitForHandoffDraftGeneration = provider.waitForHandoffDraft.bind(provider);
  provider.waitForHandoffDraft = async () => 'source-authored briefing';
  calls.length = 0;
  await provider.createHandoff({ id: createId, details: userDetails });
  assert.strictEqual(provider.handoff.phase, 'review', 'Create handoff must generate a reviewable draft');
  assert.strictEqual(provider.handoff.details, userDetails, 'Create must use the exact details carried by its own message');
  assert.match(deliveredInput(), /Preserve the exact public API; prioritize the SSH regression\./);
  assert.match(provider.handoff.texts.continue, /Additional details supplied by the user before generation:/);
  assert.match(provider.handoff.texts.continue, /Preserve the exact public API; prioritize the SSH regression\./);
  provider.waitForHandoffDraft = originalWaitForHandoffDraftGeneration;

  const edited = 'Custom handoff\nkeep this trailing space ';
  const id = 'tx-current';
  const prompt = sourceHandoffPrompt('claude', 'codex', id, 'Keep the public command stable.');
  assert.match(prompt, /specifically from Claude to Codex/);
  assert.match(prompt, /Files and symbols involved/);
  assert.match(prompt, /<USER_HANDOFF_DETAILS>\nKeep the public command stable\.\n<\/USER_HANDOFF_DETAILS>/);
  assert.ok(!prompt.includes(`HANDOFF_BEGIN:${id}`), 'the echoed source prompt must not contain the complete response marker');
  assert.doesNotMatch(sourceHandoffPrompt('claude', 'codex', id), /USER_HANDOFF_DETAILS/, 'empty optional details must remain valid and add no empty prompt section');
  assert.strictEqual(
    extractMarkedBlock(`HANDOFF_BEGIN:tx-old\nstale\nHANDOFF_END:tx-old\nHANDOFF_BEGIN:${id}\nfocused context\nHANDOFF_END:${id}`, 'HANDOFF', id),
    'focused context',
    'only the current complete transaction block should be extracted'
  );
  const preview = provider.composeHandoffText({
    id, source: 'claude', target: 'codex', authored: 'focused context', ackToken: 'abcdefghijklmnopqrstuvwx',
    repository: { branch: 'main', head: 'abc123', status: '(clean)', diff: '(none)', staged: '(none)' },
  }, 'continue');
  assert.ok(!preview.includes('HANDOFF_ACK:abcdefghijklmnopqrstuvwx'), 'the delivered prompt must not contain the complete ACK marker that the pane echo could spoof');

  provider.handoff = {
    id: 'tx-rehydrate', source: 'claude', target: 'codex', phase: 'review',
    texts: { continue: 'original', reviewOnly: 'review', reviewFix: 'fix' },
  };
  provider.updateHandoffDraft({ id: 'tx-rehydrate', mode: 'continue', text: 'edited and persisted' });
  messages.length = 0;
  provider.postHandoffState();
  assert.strictEqual(messages.at(-1).continue, 'edited and persisted', 'a recreated webview must receive the latest editable handoff draft');

  const originalWaitForHandoffAck = provider.waitForHandoffAck.bind(provider);
  provider.waitForHandoffAck = async () => {};
  provider.handoff = {
    id, source: 'claude', target: 'codex', phase: 'review',
    ackToken: 'current-secret-token',
    texts: { continue: edited, reviewOnly: edited, reviewFix: edited },
  };
  await provider.confirmHandoff({
    id, source: 'claude', target: 'codex', mode: 'continue',
    text: 'Custom handoff\nHANDOFF_ACK:current-secret-token',
  });
  assert.strictEqual(provider.handoff.phase, 'review', 'a draft containing the current ACK marker must be rejected');
  assert.strictEqual(lastOfType('handoffResult').ok, false);
  calls.length = 0;
  holdNextSend = true;
  provider.queueInput('codex', '\x04', true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(heldSendCallback, 'target control input should be held before Send handoff');
  const confirmAfterQueuedInput = provider.confirmHandoff({ id, source: 'claude', target: 'codex', mode: 'continue', text: edited });
  await new Promise((resolve) => setTimeout(resolve, 0));
  agentInfoOutput = '\t\tzsh\t1700000000\tgen-a\n';
  const releaseTargetInput = heldSendCallback;
  heldSendCallback = null;
  releaseTargetInput(null, '', '');
  await confirmAfterQueuedInput;
  assert.strictEqual(provider.handoff.phase, 'review', 'target validation must run after queued input is flushed');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'set-buffer').length, 0, 'target validation after queued input must prevent a handoff paste into the shell');
  agentInfoOutput = null;
  calls.length = 0;
  failPaste = true;
  await provider.confirmHandoff({ id, source: 'claude', target: 'codex', mode: 'continue', text: edited });
  assert.strictEqual(provider.writerAgent, null, 'failed delivery must not transfer Pair Mode ownership');
  assert.strictEqual(provider.handoff.phase, 'review', 'failed delivery must return to the editable review phase');
  assert.ok(lastOfType('handoffResult'), 'a failed delivery must report a handoff result');
  assert.strictEqual(lastOfType('handoffResult').ok, false);
  failPaste = false;
  calls.length = 0;
  await provider.confirmHandoff({ id, source: 'claude', target: 'codex', mode: 'continue', text: edited });
  assert.strictEqual(provider.writerAgent, null, 'delivery alone must not transfer Pair Mode ownership');
  assert.strictEqual(provider.handoff.phase, 'awaitingAck');
  assert.strictEqual(provider.handoff.targetCreated, '1700000000', 'handoff delivery must pin the target tmux session identity');
  assert.strictEqual(provider.handoff.targetGeneration, 'gen-a', 'handoff delivery must pin the target agent generation');
  assert.strictEqual(deliveredInput(), edited + '\r', 'handoff editor text must be sent unchanged, then submitted');
  const transaction = provider.handoff;
  provider.completeHandoff(transaction, false);
  assert.strictEqual(provider.writerAgent, 'codex', 'the current ACK transaction transfers ownership');

  provider.writerAgent = 'claude';
  provider.handoff = {
    id: 'tx-manual', source: 'claude', target: 'codex', phase: 'ackTimeout',
    targetName: 'codex_claude-tmux-sidebar', targetCreated: '1700000000', targetGeneration: 'gen-a',
  };
  await provider.acceptHandoff('tx-stale');
  assert.strictEqual(provider.writerAgent, 'claude', 'a stale manual acceptance must be ignored');
  agentInfoOutput = '\t\tzsh\t1700000000\tgen-a\n';
  await provider.acceptHandoff('tx-manual');
  assert.strictEqual(provider.writerAgent, 'claude', 'manual acceptance must not target a stopped agent');
  assert.strictEqual(messages.at(-1).type, 'handoffManualError');
  agentInfoOutput = 'codex\t1\tcodex\t1700000000\tgen-b\n';
  await provider.acceptHandoff('tx-manual');
  assert.strictEqual(provider.writerAgent, 'claude', 'manual acceptance must reject a relaunched agent in the same tmux session');
  assert.strictEqual(provider.handoff, null, 'a stale target identity must require a fresh handoff');
  assert.strictEqual(messages.at(-1).stale, true);
  agentInfoOutput = null;
  provider.handoff = {
    id: 'tx-manual-2', source: 'claude', target: 'codex', phase: 'ackTimeout',
    targetName: 'codex_claude-tmux-sidebar', targetCreated: '1700000000', targetGeneration: 'gen-a',
  };
  await provider.acceptHandoff('tx-manual-2');
  assert.strictEqual(provider.writerAgent, 'codex', 'manual acceptance after timeout transfers ownership once');

  provider.waitForHandoffAck = originalWaitForHandoffAck;
  provider.writerAgent = 'claude';
  const ackTransaction = {
    id: 'tx-ack', source: 'claude', target: 'codex', phase: 'awaitingAck',
    targetName: 'codex_claude-tmux-sidebar', targetCreated: '1700000000', targetGeneration: 'gen-a', ackToken: 'ack-secret-token',
  };
  provider.handoff = ackTransaction;
  captureOutput = 'Codex response\nHANDOFF_ACK:ack-secret-token\n';
  await provider.waitForHandoffAck(ackTransaction, 100);
  assert.strictEqual(provider.writerAgent, 'codex', 'only an observed current target ACK transfers ownership automatically');
  captureOutput = 'terminal frame\n';

  // ---- prompt recall reconstruction ---------------------------------------------
  settings.set('promptHistory', true);
  state.delete('claudeTmux.promptHistory');
  provider.agentState.codex.promptLine = '';
  provider.recordPromptInput('codex', 'fix the bug');
  provider.recordPromptInput('codex', '\x7f\x7f\x7fissue\r');
  assert.strictEqual(JSON.stringify(state.get('claudeTmux.promptHistory')), '["fix the issue"]', 'submitted lines must be reconstructed byte-for-byte');
  provider.recordPromptInput('codex', 'abc\x1b[A');
  assert.strictEqual(provider.agentState.codex.promptLine, null, 'escape sequences must bail reconstruction, not guess');
  settings.set('promptHistory', false);

  // ---- .claude/agentmux file channel ---------------------------------------------
  const channelWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-test-'));
  vscode.workspace.workspaceFolders[0].uri.fsPath = channelWorkspace;
  settings.set('fileChannel', true);
  const channelProvider = makeProvider();
  const draftPath = channelProvider.channelFile('draft-tx1.md');
  assert.ok(draftPath.includes(path.join('.claude', 'agentmux')), 'agents communicate only through .claude');
  fs.mkdirSync(path.dirname(draftPath), { recursive: true });
  fs.writeFileSync(draftPath, 'HANDOFF_BEGIN:tx1\nfile-authored briefing\nHANDOFF_END:tx1\n');
  const fileBlock = await channelProvider.waitForMarkedBlock({
    prefix: 'HANDOFF', id: 'tx1', file: draftPath, paneName: 'codex_x', timeoutMs: 2000, active: () => true,
  });
  assert.strictEqual(fileBlock, 'file-authored briefing', 'the channel file must win over pane scraping');

  settings.set('eventLog', true);
  channelProvider.eventLog.append({
    type: 'handoff', id: 'tx1', phase: 'delivered', source: 'claude', target: 'codex', mode: 'continue',
    text: 'briefing', targetName: 'codex_x', targetCreated: '1700000000', targetGeneration: 'gen-a',
  });
  const ledgerTail = await channelProvider.eventLog.tail(10);
  assert.strictEqual(ledgerTail.at(-1).phase, 'delivered', 'the ledger must record handoff transitions');
  settings.set('eventLog', false);
  settings.set('fileChannel', false);
  vscode.workspace.workspaceFolders[0].uri.fsPath = workspace;
  fs.rmSync(channelWorkspace, { recursive: true, force: true });

  // ---- channel-aware prompts -------------------------------------------------------
  settings.set('fileChannel', true);
  assert.match(sourceHandoffPrompt('claude', 'codex', 'tx9'), /\.claude\/agentmux\/draft-tx9\.md/);
  assert.match(findingsPrompt('codex', 'claude', 'tx9'), /Confirmed issues/);
  assert.ok(!sourceHandoffPrompt('claude', 'codex', 'tx9').includes('HANDOFF_BEGIN:tx9'), 'the echoed prompt must never contain a complete marker');
  settings.set('fileChannel', false);
  assert.doesNotMatch(sourceHandoffPrompt('claude', 'codex', 'tx9'), /agentmux/);
  assert.match(CODEX_CLAUDE_RULES, /Skip the \.claude\/agentmux directory/);

  // ---- codex rollout listing ---------------------------------------------------------
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-home-'));
  const dayDir = path.join(fakeHome, '.codex', 'sessions', '2026', '07', '16');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'rollout-abc.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-abc', cwd: workspace } }) + '\n'
    + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'refactor the tick loop' } }) + '\n');
  fs.writeFileSync(path.join(dayDir, 'rollout-other.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-other', cwd: '/somewhere/else' } }) + '\n');
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const codexSessions = await listCodexSessions(workspace);
  process.env.HOME = oldHome;
  assert.strictEqual(codexSessions.length, 1, 'codex listing must be cwd-scoped');
  assert.strictEqual(codexSessions[0].id, 'sess-abc');
  assert.strictEqual(codexSessions[0].name, 'refactor the tick loop');
  fs.rmSync(fakeHome, { recursive: true, force: true });

  // ---- claude transcript listing (chunked reads) ---------------------------------------
  const claudeProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-claude-'));
  const fillerLine = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(400) }, timestamp: '2026-01-01T00:00:00Z' });
  fs.writeFileSync(path.join(claudeProjectDir, 'sess-1.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'first user prompt here' }, timestamp: '2026-01-01T00:00:00Z' }) + '\n'
    + Array.from({ length: 800 }, () => fillerLine).join('\n') + '\n' // ~350KB: forces the head+tail chunk path
    + JSON.stringify({ type: 'system', content: '<command-name>/rename</command-name><command-args>picked name</command-args>' }) + '\n');
  fs.writeFileSync(path.join(claudeProjectDir, 'sess-2.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'small session prompt' }, timestamp: '2026-01-02T00:00:00Z' }) + '\n');
  const claudeSessions = await listSessions(claudeProjectDir);
  assert.strictEqual(claudeSessions.length, 2);
  const bigSession = claudeSessions.find((s) => s.id === 'sess-1');
  assert.strictEqual(bigSession.name, 'picked name', 'a late /rename must be found without reading the whole transcript');
  assert.ok(bigSession.lastTs, 'file mtime must stand in for last activity');
  assert.strictEqual(claudeSessions.find((s) => s.id === 'sess-2').name, 'small session prompt');
  fs.rmSync(claudeProjectDir, { recursive: true, force: true });

  // ---- arbiter gates -------------------------------------------------------------------
  provider.handoff = null;
  provider.agentState.claude.present = true;
  provider.agentState.codex.present = true;
  provider.agentState.claude.status = 'working';
  provider.agentState.codex.status = 'idle';
  provider.prepareArbiter();
  assert.strictEqual(provider.arbiter, null, 'arbiter must refuse while an agent is working');
  provider.agentState.claude.status = 'idle';
  provider.prepareArbiter();
  assert.strictEqual(provider.arbiter.phase, 'collecting');
  await provider.createArbiter({ id: 'stale-arbiter', question: 'x' });
  assert.strictEqual(provider.arbiter.phase, 'collecting', 'a stale arbiter id must not advance the round');
  provider.prepareHandoff('claude');
  assert.strictEqual(provider.handoff, null, 'handoffs must be blocked while an arbiter round is open');
  provider.cancelArbiter(provider.arbiter.id);
  assert.strictEqual(provider.arbiter, null);

  // ---- Antigravity as a first-class third agent --------------------------------------
  assert.ok(AGENT_IDS.includes('antigravity'), 'Antigravity must be a registered agent');
  assert.strictEqual(AGENTS.antigravity.command, 'agy', 'Antigravity is driven by the agy CLI');
  assert.strictEqual(AGENTS.antigravity.defaultPrefix, 'tmux_agy_');
  assert.strictEqual(launchArgs('antigravity'), '--dangerously-skip-permissions');
  assert.strictEqual(AGENTS.antigravity.resumeById('abc-1', '--x'), "agy --conversation 'abc-1' --x");
  assert.strictEqual(AGENTS.antigravity.resumeLatest('--x'), 'agy --continue --x');
  assert.strictEqual(AGENTS.antigravity.listSessions, null, 'Antigravity keeps no readable per-folder transcripts');

  // Recognizing an agent started outside the extension must not cross the wires.
  assert.ok(paneLooksLikeAgent('antigravity', '/home/u/.local/bin/agy'));
  assert.ok(!paneLooksLikeAgent('claude', 'agy'), 'agy must never be mistaken for Claude');
  assert.ok(!paneLooksLikeAgent('antigravity', 'codex'));
  // ---- pane identity: the command names an interpreter, not an agent --------------------
  // 'node' was a Claude alias until 0.13.0, which made every Node process in
  // the workspace read as Claude — `npm run dev` would have become an agent tab
  // AgentMux types into. An interpreter is now unidentified unless the pane
  // TITLE, which a TUI sets deliberately, resolves it.
  assert.ok(!paneLooksLikeAgent('claude', 'node'),
    'a bare node process is no longer claimed as Claude');
  assert.ok(paneLooksLikeAgent('claude', 'node', 'Claude Code — refactor the tick loop'),
    'a node pane whose title names Claude is adopted');
  assert.ok(!paneLooksLikeAgent('claude', 'node', 'npm run dev'),
    'an unrelated node pane stays unclaimed whatever its title says');
  assert.ok(!paneLooksLikeAgent('claude', 'vite', 'Claude Code'),
    'the title is consulted ONLY for an interpreter, never to override a real command name');
  // Some Claude builds report their own version as the pane command.
  assert.ok(paneLooksLikeAgent('claude', '2.1.118'), 'a bare version string is Claude');
  assert.ok(!paneLooksLikeAgent('codex', '2.1.118'), 'and only Claude');
  assert.ok(!paneLooksLikeAgent('claude', '2'), 'a lone number is not a version string');
  assert.ok(paneLooksLikeAgent('pi', 'node', 'π — pi v0.84.4'),
    'pi is resolved from its product mark when it runs as node');
  // Measured live: Hermes runs as python AND leaves the tmux title at the
  // hostname, so neither signal identifies it. Claiming `python` anyway would
  // hand every Python process an agent tab.
  assert.ok(!paneLooksLikeAgent('hermes', 'python', 'oracle'),
    'Hermes started outside AgentMux is still not adopted, by design');

  // A title-derived identity has to be sticky: Claude rewrites that title with
  // the conversation summary, and re-deriving it every poll would make an
  // adopted agent blink out of the side bar mid-session.
  // Fields after the workspace path:
  // marker, running, command, created, generation, hookState, hookTool,
  // hookSessionId, panePid, serverPid, title.
  const paneInfo = (command, title, panePid = '4242', serverPid = '999') =>
    `\t\t${command}\t1700000000\tgen-a\t\t\t\t${panePid}\t${serverPid}\t${title}\n`;

  agentInfoOutput = paneInfo('node', 'Claude Code — refactor the tick loop');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, true,
    'the title identifies the interpreter on the first look');
  agentInfoOutput = paneInfo('node', '⠂ Debug the SSH rendering issue');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, true,
    'the agent survives the title drifting away from the pattern');
  assert.strictEqual((await agentSessionInfo('codex', 'adopted_pane')).ready, false,
    'the sticky identity belongs to the agent that earned it, not to any agent');
  // A recreated pane or a restarted tmux server is a different process, whatever
  // the session name and creation second say.
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, true);
  agentInfoOutput = paneInfo('node', '⠂ Debug the SSH rendering issue', '5555', '999');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, false,
    'a new pane shell pid is a different pane, so the sticky identity does not carry over');
  agentInfoOutput = paneInfo('node', '⠂ Debug the SSH rendering issue', '4242', '1000');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, false,
    'a restarted tmux server invalidates it too');
  agentInfoOutput = paneInfo('node', 'Claude Code — refactor the tick loop');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, true);
  agentInfoOutput = paneInfo('zsh', '⠂ Debug the SSH rendering issue');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, false,
    'falling back to a shell means the agent exited, and the identity is dropped');
  agentInfoOutput = paneInfo('node', '⠂ Debug the SSH rendering issue');
  assert.strictEqual((await agentSessionInfo('claude', 'adopted_pane')).ready, false,
    'and it is not resurrected without a fresh identifying signal');

  // What a handoff pins, and what invalidates it.
  const pinned = await (async () => {
    agentInfoOutput = paneInfo('claude', 'Claude Code');
    const info = await agentSessionInfo('claude', 'pinned_pane');
    return { targetIdentity: paneIdentity(info) };
  })();
  assert.strictEqual(pinned.targetIdentity, '1700000000:gen-a:4242:999');
  assert.strictEqual(identityMatches(await agentSessionInfo('claude', 'pinned_pane'), pinned), true);
  agentInfoOutput = paneInfo('claude', 'Claude Code', '4242', '1000');
  assert.strictEqual(identityMatches(await agentSessionInfo('claude', 'pinned_pane'), pinned), false,
    'a tmux server restart must never let a briefing land in a look-alike pane');
  // A transaction pinned by an older AgentMux recorded only created+generation.
  const legacyPin = { targetCreated: '1700000000', targetGeneration: 'gen-a' };
  assert.strictEqual(identityMatches(await agentSessionInfo('claude', 'pinned_pane'), legacyPin), true,
    'a pre-0.13.0 pin is still honoured on the pair it actually recorded');
  agentInfoOutput = null;
  agentInfoOutput = 'codex\t1\tcodex\t1700000000\tgen-a\n';
  const claimed = await agentSessionInfo('antigravity', 'tmux_agy_claude-tmux-sidebar');
  assert.strictEqual(claimed.ready, false, 'a pane already claimed by another agent must not read as this one');
  agentInfoOutput = null;

  // The overlay learns what this CLI supports instead of assuming Claude's shape.
  messages.length = 0;
  await provider.pushSessions('antigravity');
  const antigravitySessions = messages.filter((msg) => msg.type === 'sessions').at(-1);
  assert.strictEqual(antigravitySessions.canList, false);
  assert.strictEqual(antigravitySessions.canResumeLatest, true);
  assert.strictEqual(antigravitySessions.list.length, 0);
  assert.strictEqual(await provider.tails.antigravity.poll(workspace), null, 'no transcript tail means no telemetry, not a crash');

  // Handoff peers: a third agent turns the target into a real choice.
  provider.handoff = null;
  provider.arbiter = null;
  provider.writerAgent = null;
  for (const agent of AGENT_IDS) {
    provider.agentState[agent].present = true;
    provider.agentState[agent].status = 'idle';
  }
  const othersOf = (source) => AGENT_IDS.filter((agent) => agent !== source);
  assert.strictEqual(provider.handoffCandidates('claude').join(','), othersOf('claude').join(','));
  provider.agentState.codex.present = false;
  assert.strictEqual(
    provider.handoffCandidates('claude').join(','),
    othersOf('claude').filter((agent) => agent !== 'codex').concat('codex').join(','),
    'running agents are offered first'
  );
  provider.agentState.codex.present = true;

  messages.length = 0;
  provider.prepareHandoff('claude');
  const multiId = provider.handoff.id;
  assert.strictEqual(messages.at(-1).targets.join(','), othersOf('claude').join(','), 'the details step offers every peer');
  messages.length = 0;
  await provider.createHandoff({ id: multiId, details: '', target: 'claude' });
  assert.strictEqual(provider.handoff.phase, 'collecting', 'handing off to yourself must return to the editable step');
  assert.strictEqual(messages.at(-1).type, 'handoffCreateError');
  const realWaitForDraft = provider.waitForHandoffDraft.bind(provider);
  provider.waitForHandoffDraft = async () => 'briefing for the third agent';
  const retargetTx = provider.handoff;
  await provider.createHandoff({ id: multiId, details: '', target: 'antigravity' });
  assert.strictEqual(retargetTx.phase, 'review');
  assert.strictEqual(retargetTx.target, 'antigravity', 'the details step can re-point the handoff at another agent');
  provider.handoff = null;

  // A findings round-trip pins its target and must ignore a re-point attempt.
  provider.prepareHandoff('codex', { target: 'claude', findings: true });
  const findingsTx = provider.handoff;
  assert.strictEqual(findingsTx.lockedTarget, true);
  await provider.createHandoff({ id: findingsTx.id, details: '', target: 'antigravity' });
  assert.strictEqual(findingsTx.target, 'claude', 'a pinned findings target must ignore a re-point attempt');
  provider.waitForHandoffDraft = realWaitForDraft;
  provider.handoff = null;

  // Arbiter rounds scale to every running agent.
  for (const agent of AGENT_IDS) {
    provider.agentState[agent].present = true;
    provider.agentState[agent].status = 'idle';
  }
  provider.prepareArbiter();
  assert.strictEqual(provider.arbiter.participants.join(','), AGENT_IDS.join(','), 'every running agent joins the round');
  provider.cancelArbiter(provider.arbiter.id);
  provider.agentState.antigravity.present = false;
  provider.prepareArbiter();
  assert.strictEqual(
    provider.arbiter.participants.join(','),
    AGENT_IDS.filter((agent) => agent !== 'antigravity').join(','),
    'a stopped agent sits the round out'
  );
  provider.cancelArbiter(provider.arbiter.id);
  provider.agentState.antigravity.present = true;
  provider.agentState.antigravity.status = 'working';
  provider.prepareArbiter();
  assert.strictEqual(provider.arbiter, null, 'a mid-turn running agent still blocks the round');
  provider.agentState.antigravity.status = 'idle';

  // ---- OpenCode as a fourth agent ------------------------------------------------------
  assert.ok(AGENT_IDS.includes('opencode'), 'OpenCode must be a registered agent');
  assert.strictEqual(AGENTS.opencode.command, 'opencode');
  assert.strictEqual(AGENTS.opencode.defaultPrefix, 'tmux_opencode_');
  assert.strictEqual(launchArgs('opencode'), '--auto');
  assert.strictEqual(AGENTS.opencode.resumeById('s7', '--auto'), "opencode --session 's7' --auto");
  assert.strictEqual(AGENTS.opencode.resumeLatest('--auto'), 'opencode --continue --auto');
  assert.ok(paneLooksLikeAgent('opencode', '/home/u/.opencode/bin/opencode'));
  assert.ok(!paneLooksLikeAgent('opencode', 'codex'));
  assert.ok(!paneLooksLikeAgent('claude', 'opencode'), 'opencode must never be mistaken for Claude');

  // Unlike the others, OpenCode's session index comes from the CLI itself. The
  // parser must tolerate the schema drifting rather than break the overlay.
  opencodeSessionsJson = JSON.stringify([
    { id: 's1', title: 'refactor the tick loop', time: { updated: 1767225600000 }, directory: workspace },
    { sessionID: 's2', summary: 'fix the scroll jump', updated: '2026-02-02T03:04:05Z', directory: workspace },
    { id: 's3' },
    { id: 's4', title: 'another project', updated: 1769999999000, directory: '/elsewhere/other-project' },
    { noIdHere: true },
    'garbage',
  ]);
  const ocSessions = await listOpencodeSessions(workspace);
  assert.strictEqual(ocSessions.length, 3, 'rows without an id are skipped, the rest survive');
  assert.strictEqual(ocSessions[0].id, 's2', 'sessions are newest first');
  assert.strictEqual(ocSessions[0].name, 'fix the scroll jump');
  assert.strictEqual(ocSessions[1].name, 'refactor the tick loop', 'a millisecond stamp is understood too');
  assert.strictEqual(ocSessions[2].name, 's3', 'a titleless session falls back to its id');
  assert.ok(!ocSessions.some((s) => s.id === 's4'),
    'a session rooted in another folder is never offered: opencode binds the resumed session to its stored directory');
  opencodeSessionsJson = 'this is not json';
  assert.strictEqual((await listOpencodeSessions(workspace)).length, 0, 'unparseable output degrades to no list');
  opencodeSessionsJson = null;
  assert.strictEqual((await listOpencodeSessions(workspace)).length, 0, 'a missing CLI degrades to no list');

  // Preflight must re-probe with an interactive shell: installers routinely export
  // PATH from ~/.bashrc, which a non-interactive login shell (-lc) skips entirely.
  calls.length = 0;
  provider._preflight = null;
  await provider.runPreflight(true);
  assert.ok(calls.some((call) => call.args?.[0] === '-lc'), 'the fast non-interactive probe runs first');
  assert.ok(calls.some((call) => call.args?.[0] === '-lic'), 'a CLI that looks absent triggers an interactive re-probe');
  assert.ok('opencode' in (messages.at(-1).agents || {}), 'preflight reports every registered agent');

  // ---- per-agent screen detection rules ------------------------------------------------
  // The old code applied one shared regex to every agent; rules are now per-agent
  // and user-overridable, and report which pattern won.
  assert.strictEqual(detectScreenState('codex', 'Approval required\n[y/n]').status, 'needs-input');
  assert.ok(detectScreenState('codex', 'Approval required').pattern, 'the matched rule is named for Explain');
  assert.strictEqual(detectScreenState('claude', 'thinking… (esc to interrupt)').status, 'working',
    'a per-agent working rule is applied');
  assert.strictEqual(detectScreenState('claude', 'just some output').status, null);
  assert.strictEqual(detectScreenState('antigravity', 'Do you trust the contents of this project?').status,
    'needs-input', 'Antigravity has its own observed prompt rules');

  settings.set('detectionRules', { claude: { needsInput: ['^ready to deploy'], working: [] } });
  assert.strictEqual(detectScreenState('claude', 'ready to deploy?').status, 'needs-input', 'an override adds rules');
  assert.strictEqual(detectScreenState('claude', 'Do you want to proceed?').status, null,
    'an override REPLACES the built-in list, so a noisy rule can be removed');
  assert.strictEqual(detectScreenState('codex', 'Do you want to proceed?').status, 'needs-input',
    'overriding one agent must not touch the others');
  settings.set('detectionRules', { claude: { needsInput: ['([unclosed'] } });
  assert.doesNotThrow(() => detectScreenState('claude', 'anything'), 'a malformed user regex is skipped, not thrown');
  settings.set('detectionRules', {});
  assert.ok(detectionRules('claude').needsInput.length > 0, 'built-ins return once the override is cleared');

  // Hook state still wins over screen rules.
  provider.agentState.claude.status = 'idle';
  provider.applyHookState('claude', 'working', 'Bash');
  assert.strictEqual(provider.agentState.claude.status, 'working');
  assert.strictEqual(provider.agentState.claude.lastTool, 'Bash');

  // ---- OpenCode plugin integration -----------------------------------------------------
  assert.match(OPENCODE_PLUGIN, /AGENTMUX/, 'the plugin is inert unless AgentMux launched the pane');
  assert.match(OPENCODE_PLUGIN, /session\.idle/);
  assert.match(OPENCODE_PLUGIN, /permission\.asked/);
  assert.match(OPENCODE_PLUGIN, /@agentmux_session_id/, 'session identity is captured for exact resume');

  // Run the real plugin source against an event sequence. opencode runs
  // subagents as CHILD sessions with their own idle events, so the aggregate is
  // the whole point: the first idle must not mark the pane done.
  {
    const pluginCalls = [];
    const pluginSandbox = {
      module: { exports: {} },
      process: { env: { TMUX_PANE: '%7', AGENTMUX: '1' } },
      __exec: (cmd, args, cb) => { pluginCalls.push(args); cb(); },
      console,
      setTimeout,
    };
    pluginSandbox.exports = pluginSandbox.module.exports;
    const pluginSource = OPENCODE_PLUGIN
      .replace("await import('node:child_process')", '({ execFile: __exec })')
      .replace('export const AgentMuxState', 'const AgentMuxState')
      + '\nmodule.exports = { AgentMuxState };';
    vm.runInNewContext(pluginSource, pluginSandbox, { filename: 'agentmux-state.js' });
    const plugin = await pluginSandbox.module.exports.AgentMuxState();
    const fire = async (type, properties) => { await plugin.event({ event: { type, properties } }); };
    const stamped = () => pluginCalls
      .filter((a) => a[4] === '@agentmux_state')
      .map((a) => a[5]);
    const optionFor = (name) => (pluginCalls.filter((a) => a[4] === name).at(-1) || [])[5];

    await fire('session.created', { sessionID: 'parent' });
    assert.strictEqual(optionFor('@agentmux_session_id'), 'parent', 'the session id is recorded on creation');

    await fire('message.updated', { sessionID: 'parent', info: { role: 'user' } });
    assert.strictEqual(stamped().at(-1), 'working');

    await fire('session.status', { sessionID: 'child', status: { type: 'busy' } });
    await fire('session.idle', { sessionID: 'child' });
    assert.strictEqual(stamped().at(-1), 'working',
      'a subagent going idle must NOT mark the pane done while the parent still works');

    await fire('session.idle', { sessionID: 'parent' });
    assert.strictEqual(stamped().at(-1), 'done', 'the pane is done only once every session is');

    await fire('session.status', { sessionID: 'parent', status: { type: 'busy' } });
    assert.strictEqual(stamped().at(-1), 'done',
      'the stale trailing busy opencode emits after idle is ignored');

    await fire('message.updated', { sessionID: 'parent', info: { role: 'user' } });
    assert.strictEqual(stamped().at(-1), 'working', 'a new user message re-arms the session');

    await fire('tool.execute.before', { sessionID: 'parent', tool: 'bash' });
    assert.strictEqual(optionFor('@agentmux_tool'), 'bash', 'the running tool is reported');

    await fire('permission.asked', { sessionID: 'parent' });
    assert.strictEqual(stamped().at(-1), 'needs-input');
    assert.strictEqual(optionFor('@agentmux_tool'), '', 'the tool chip clears when work stops');
    await fire('question.replied', { sessionID: 'parent' });
    assert.strictEqual(stamped().at(-1), 'working');

    const before = stamped().length;
    await fire('message.part.updated', { sessionID: 'parent' });
    assert.strictEqual(stamped().length, before, 'an unchanged aggregate is not re-written');

    await fire('session.deleted', { info: { id: 'parent' } });
    assert.strictEqual(stamped().at(-1), 'done', 'deleting the last live session settles the pane');
  }
  const fakeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-cfg-'));
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fakeConfig;
  settings.set('stateHooks', true);
  try {
    assert.strictEqual(ensureOpencodePlugin(), true);
    const pluginFile = opencodePluginPath();
    assert.ok(pluginFile.includes(path.join('opencode', 'plugins')), 'the plugin lands in OpenCode\'s plugin directory');
    assert.strictEqual(fs.readFileSync(pluginFile, 'utf8'), OPENCODE_PLUGIN);
    assert.strictEqual(removeOpencodePlugin(), true);
    assert.strictEqual(fs.existsSync(pluginFile), false, 'the integration is fully removable');
    settings.set('stateHooks', false);
    assert.strictEqual(ensureOpencodePlugin(), false, 'stateHooks=false must not write into another tool\'s config');
  } finally {
    if (priorXdg == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
    fs.rmSync(fakeConfig, { recursive: true, force: true });
  }

  // Every launch marks its pane as AgentMux-owned, which is what the plugin checks.
  calls.length = 0;
  await provider.runAgentCommand('opencode', 'tmux_opencode_x', 'opencode --auto');
  const launchKeys = calls.find((call) => call.args[0] === 'send-keys' && call.args.includes('Enter'));
  assert.match(launchKeys.args[3], /^AGENTMUX=1 opencode --auto;/, 'the launch command carries the ownership guard');

  // ---- leftover session cleanup ---------------------------------------------------------
  // Cleanup must NEVER reach outside the open project: another window may be
  // driving those agents. Only session_path === this workspace qualifies.
  sessionListOutput = [
    `tmux_claude_other\t/tmp/another-project\t1700000000\t0\t1`,     // another project
    `tmux_claude_gone\t/tmp/deleted-project\t1700000000\t0\t1`,      // another project, folder gone
    `_agentmux_ctl_9999\t/\t1700000000\t1\t1`,                       // control client, not this project
    `my-own-work\t${workspace}\t1700000000\t0\t3`,                   // here, but not ours
    `tmux_claude_claude-tmux-sidebar\t${workspace}\t1700000000\t1\t1`,
    `tmux_claude-tmux-sidebar\t${workspace}\t1700000000\t0\t1`,      // pre-0.10.2 prefix, same project
  ].join('\n');
  quickPickAnswer = undefined; // user cancels: nothing may be killed
  quickPickItems = null;
  calls.length = 0;
  await provider.cleanupSessions();
  const offered = (quickPickItems || []).map((item) => item.session).sort();
  assert.strictEqual(offered.join(','), 'tmux_claude-tmux-sidebar,tmux_claude_claude-tmux-sidebar',
    'only this project\'s AgentMux sessions may ever be offered');
  for (const forbidden of ['tmux_claude_other', 'tmux_claude_gone', '_agentmux_ctl_9999']) {
    assert.ok(!offered.includes(forbidden), `${forbidden} belongs to another project and must never be listed`);
  }
  assert.ok(!offered.includes('my-own-work'), 'a session AgentMux did not create is never offered');
  assert.strictEqual((quickPickItems || []).filter((item) => item.picked).length, 0,
    'nothing is pre-selected: every kill in the open project is an explicit choice');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'kill-session').length, 0, 'cancelling kills nothing');

  // Belt and braces: even if a foreign session reached the kill list (a stale
  // snapshot, a crafted message), the kill path re-verifies and refuses.
  quickPickAnswer = [{ session: 'tmux_claude_other' }, { session: 'tmux_claude_claude-tmux-sidebar' }];
  warningAnswer = 'Kill';
  calls.length = 0;
  await provider.cleanupSessions();
  const killedNames = calls.filter((call) => call.args[0] === 'kill-session').map((call) => call.args.at(-1));
  assert.strictEqual(killedNames.join(','), '=tmux_claude_claude-tmux-sidebar',
    'a foreign session survives the kill path even when explicitly selected');
  warningAnswer = undefined;
  quickPickAnswer = undefined;
  sessionListOutput = null;
  quickPickItems = null;

  // ---- Hermes as a fifth agent ----------------------------------------------------------
  assert.ok(AGENT_IDS.includes('hermes'), 'Hermes must be a registered agent');
  assert.strictEqual(AGENTS.hermes.command, 'hermes');
  assert.strictEqual(AGENTS.hermes.defaultPrefix, 'tmux_hermes_');
  assert.strictEqual(launchArgs('hermes'), '--cli --yolo');
  assert.strictEqual(AGENTS.hermes.resumeById('ses-9', '--cli --yolo'), "hermes --resume 'ses-9' --cli --yolo");
  assert.strictEqual(AGENTS.hermes.resumeLatest('--cli --yolo'), 'hermes --continue --cli --yolo');
  assert.strictEqual(
    AGENTS.hermes.resumeById('ses-9', '--cli --yolo', '/home/u/work/proj'),
    "hermes --resume 'ses-9' --in '/home/u/work/proj' --cli --yolo",
    'resume pins the session to the open project with --in (Hermes would otherwise cd into the session\'s recorded dir)');
  assert.strictEqual(
    AGENTS.hermes.resumeLatest('--cli --yolo', '/home/u/work/proj'),
    "hermes --continue --in '/home/u/work/proj' --cli --yolo",
    'Resume previous session is workspace-scoped via --in');
  assert.strictEqual(typeof AGENTS.hermes.listSessions, 'function',
    'Hermes lists past sessions through its own CLI store');
  assert.ok(paneLooksLikeAgent('hermes', '/home/u/.local/bin/hermes'));
  assert.ok(!paneLooksLikeAgent('hermes', 'opencode'));
  assert.ok(!paneLooksLikeAgent('claude', 'hermes'), 'hermes must never be mistaken for Claude');

  // The resume list is parsed from the CLI's fixed-width table; column
  // boundaries come from the header line, so titles containing spaces are safe.
  const hermesHeader = 'Title'.padEnd(29) + 'Workspace'.padEnd(10) + 'Last Active'.padEnd(12) + 'ID';
  const hermesRow = (title, ws, rel, id) => title.padEnd(29) + ws.padEnd(10) + rel.padEnd(12) + id;
  hermesSessionsTable = [
    hermesHeader,
    hermesRow('', '', '', '─'.repeat(hermesHeader.length)),
    hermesRow('Fix the login bug', 'my-project', 'just now', '20260812_090310_348b8f'),
    hermesRow('Add OpenCode agent support', 'proj2', '2h ago', '20260811_150412_9f3a2c'),
    hermesRow('multi word title with  spaces', 'proj3', '3d ago', '20260809_080000_000001'),
  ].join('\n');
  const hermesList = await listHermesSessions(workspace);
  assert.strictEqual(hermesList.length, 3, 'rows are parsed from the hermes table');
  assert.strictEqual(hermesList[0].id, '20260812_090310_348b8f', 'the ID column is read');
  assert.strictEqual(hermesList[0].name, 'Fix the login bug', 'titles are trimmed to the Workspace column');
  assert.strictEqual(hermesList[2].name, 'multi word title with  spaces', 'titles with spaces are sliced by column, not by word');
  assert.ok(hermesList[1].lastTs && hermesList[1].lastTs < new Date().toISOString(), 'relative times become timestamps');
  hermesSessionsTable = null;
  assert.strictEqual((await listHermesSessions(workspace)).length, 0, 'an unparseable or missing table degrades to no list');

  messages.length = 0;
  await provider.pushSessions('hermes');
  const hermesSessions = messages.filter((msg) => msg.type === 'sessions').at(-1);
  assert.strictEqual(hermesSessions.canList, true, 'Hermes now gets a real resume list from its CLI');
  assert.strictEqual(hermesSessions.list.length, 0, 'no table output means an empty list, not a broken overlay');
  assert.strictEqual(hermesSessions.canResumeLatest, true, 'Resume runs the CLI\'s own --continue');
  assert.strictEqual(await provider.tails.hermes.poll(workspace), null, 'no readable transcript means no telemetry, not a crash');

  // Rules taken from a live --cli pane: the running turn advertises how to
  // interrupt it, the idle prompt is a bare chevron.
  assert.strictEqual(
    detectScreenState('hermes', '⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel').status,
    'working', 'a running Hermes turn is recognised from its interrupt affordance');
  assert.strictEqual(detectScreenState('hermes', '❯').status, null,
    'the idle prompt must not read as working');
  assert.strictEqual(
    detectScreenState('hermes', ' ⚕ deepseek-v4-flash │ 20.7K/1M │ 1m │ ⏲ 3s │ ✓ 0s │ ⚠ YOLO').status,
    null, 'the finished status bar must not read as working');
  assert.strictEqual(detectScreenState('hermes', 'Do you want to proceed?').status, 'needs-input',
    'the shared baseline still applies');

  // ---- naming a session tmux 3.4 says nothing about --------------------------------------
  // The <base>-<hash> name exists only to avoid attaching to a session another
  // project already owns. tmux 3.4 answers a missing '=name:' target with exit 0
  // and an empty line rather than an error, so "not ok" alone did not mean
  // "free" and every new session was needlessly named <base>-<hash>.
  settings.set('piSessionPrefix', 'tmux_missing_');
  assert.strictEqual(await sessionName('pi'), `tmux_missing_${path.basename(workspace)}`,
    'a name no session holds is used as-is, not disambiguated with a path hash');
  assert.strictEqual((await agentSessionInfo('pi', 'tmux_missing_x')).exists, false,
    'an empty session_path means the target does not exist');
  settings.set('piSessionPrefix', 'tmux_other_');
  assert.match(await sessionName('pi'), /^tmux_other_.+-[0-9a-f]{8}$/,
    'a name another project already holds still falls back to the path-hashed variant');
  // Sessions an affected tmux already named <base>-<hash> must be adopted, not
  // orphaned by starting a second agent under the now-free clean name.
  settings.set('piSessionPrefix', 'tmux_legacy_');
  assert.match(await sessionName('pi'), /^tmux_legacy_.+-[0-9a-f]{8}$/,
    'a hashed session that belongs to this workspace is adopted when the plain name is free');
  settings.delete('piSessionPrefix');

  // ---- pi as a sixth agent --------------------------------------------------------------
  assert.ok(AGENT_IDS.includes('pi'), 'pi must be a registered agent');
  assert.strictEqual(AGENTS.pi.command, 'pi');
  assert.strictEqual(AGENTS.pi.defaultPrefix, 'tmux_pi_');
  settings.set('piArgs', '');
  assert.strictEqual(launchArgs('pi'), '', 'pi has no permission flag to add: it ships no approval prompts');
  settings.set('piArgs', '-a');
  assert.strictEqual(launchArgs('pi'), '-a', 'configured pi arguments are passed through');
  assert.strictEqual(AGENTS.pi.resumeById('01H8-abc', '-a'), "pi --session '01H8-abc' -a");
  assert.strictEqual(AGENTS.pi.resumeLatest('-a'), 'pi --continue -a');
  // Verified live: pi sets its own process title, so the pane really reads "pi"
  // and an externally started instance is adopted without aliasing "node"
  // (which Claude already owns).
  assert.ok(paneLooksLikeAgent('pi', '/usr/local/bin/pi'));
  assert.ok(!paneLooksLikeAgent('pi', 'node'), 'pi must not claim every node process');
  assert.ok(!paneLooksLikeAgent('pi', 'pip'), 'the pane rule is anchored, not a substring match');
  assert.ok(!paneLooksLikeAgent('claude', 'pi'), 'pi must never be mistaken for Claude');

  // The resume list is read from pi's own per-directory transcripts. Layout and
  // cwd encoding are the CLI's (verified in its core/session-manager.js).
  const fakePiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-pi-'));
  const priorPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fakePiDir;
  try {
    assert.strictEqual(
      piSessionDir('/home/u/work/proj'),
      path.join(fakePiDir, 'sessions', '--home-u-work-proj--'),
      'the cwd encoding matches pi: leading separator stripped, separators become dashes');
    const dir = piSessionDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const transcript = (id, cwd, entries) => [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-30T10:00:00.000Z', cwd }),
      ...entries.map((e) => JSON.stringify(e)),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, '2026-08-30T10-00-00-000Z_aaa.jsonl'), transcript('aaa', workspace, [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'refactor the tick loop please' }] } },
    ]));
    fs.writeFileSync(path.join(dir, '2026-08-30T11-00-00-000Z_bbb.jsonl'), transcript('bbb', workspace, [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'the first prompt' }] } },
      { type: 'session_info', name: 'Renamed later' },
    ]));
    // A transcript filed under this directory but recorded elsewhere: resuming
    // it would move pi out of the project, so it is never offered.
    fs.writeFileSync(path.join(dir, '2026-08-30T12-00-00-000Z_ccc.jsonl'), transcript('ccc', '/elsewhere/other', []));
    fs.writeFileSync(path.join(dir, 'not-a-session.jsonl'), 'garbage\n');
    const piList = await listPiSessions(workspace);
    assert.strictEqual(piList.length, 2, 'malformed and foreign-cwd transcripts are skipped');
    assert.ok(!piList.some((s) => s.id === 'ccc'), 'a session recorded in another folder is never offered');
    const renamed = piList.find((s) => s.id === 'bbb');
    assert.strictEqual(renamed.name, 'Renamed later', 'a /name entry wins over the first user message');
    assert.strictEqual(piList.find((s) => s.id === 'aaa').name, 'refactor the tick loop please',
      'the first user message is the fallback title');
    assert.ok(piList.every((s) => s.lastTs), 'every entry carries a timestamp for the overlay');
    assert.strictEqual(await AGENTS.pi.deleteConversation('aaa', workspace), true);
    assert.strictEqual((await listPiSessions(workspace)).length, 1, 'deleting removes the transcript from disk');
    assert.strictEqual(await AGENTS.pi.deleteConversation('nope', workspace), false, 'an unknown id is a no-op');

    // pi discovers extensions from its own config dir; the file is inert unless
    // AGENTMUX=1, exactly like the OpenCode plugin.
    settings.set('stateHooks', true);
    assert.match(PI_EXTENSION, /AGENTMUX/, 'the extension is inert unless AgentMux launched the pane');
    assert.match(PI_EXTENSION, /agent_settled/, 'settled, not agent_end, is what "done" means for pi');
    assert.match(PI_EXTENSION, /ui_prompt_start/, 'blocking prompts report as needs-input');
    assert.match(PI_EXTENSION, /@agentmux_session_id/, 'session identity is captured for exact resume');
    assert.strictEqual(ensurePiExtension(), true);
    const piFile = piExtensionPath();
    assert.strictEqual(piFile, path.join(fakePiDir, 'extensions', 'agentmux-state.ts'),
      'the extension lands in pi\'s auto-discovered extension directory');
    assert.strictEqual(fs.readFileSync(piFile, 'utf8'), PI_EXTENSION);
    assert.strictEqual(removePiExtension(), true);
    assert.strictEqual(fs.existsSync(piFile), false, 'the integration is fully removable');
    settings.set('stateHooks', false);
    assert.strictEqual(ensurePiExtension(), false, 'stateHooks=false must not write into another tool\'s config');
  } finally {
    if (priorPiDir == null) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorPiDir;
    fs.rmSync(fakePiDir, { recursive: true, force: true });
  }

  // Rules taken from a live pane. The startup banner is the trap: it prints
  // "escape interrupt · …" and stays on screen until the chat scrolls it away.
  assert.strictEqual(detectScreenState('pi', 'Working... (escape to interrupt)').status, 'working');
  assert.strictEqual(
    detectScreenState('pi', ' escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more').status,
    null, 'pi\'s startup banner must never read as a running turn');
  assert.strictEqual(detectScreenState('pi', ' Trust project folder?').status, 'needs-input',
    'the first-run project-trust prompt is waiting for the user');
  assert.strictEqual(detectScreenState('pi', ' ↑↓ navigate  enter select  escape/ctrl+c cancel').status, 'needs-input',
    'the trust prompt footer is waiting for the user');
  assert.strictEqual(
    detectScreenState('pi', '  Enter to select · Ctrl+S to set as default · Esc to cancel').status,
    'needs-input',
    'pi\'s built-in pickers are not extension UI, so the hook never sees them: the screen rule must');
  assert.strictEqual(detectScreenState('pi', 'the idle prompt with nothing to answer').status, null);

  // ---- free mode: agents declared in settings --------------------------------------------
  settings.set('customAgents', [
    { id: 'aider', label: 'Aider', command: 'aider', args: '--yes', resume: { latest: 'aider --restore {args}', byId: 'aider --session {id} {args}' } },
    { id: 'build', label: 'Build loop', session: 'my-build-loop' },
    { id: 'claude', label: 'Impostor', command: 'evil' },     // shadows a built-in
    { id: 'Bad Id', command: 'x' },                            // invalid id
    { id: 'aider', command: 'twice' },                         // duplicate
    { id: 'empty' },                                           // neither command nor session
    { id: 'colon', session: 'has:colon' },                     // unaddressable tmux target
    { id: 'spacey', session: 'has space' },
  ]);
  const specs = customAgentSpecs();
  assert.strictEqual(specs.map((s) => s.id).join(','), 'aider,build',
    'invalid, duplicate and built-in-shadowing entries are dropped');
  assert.strictEqual(specs[0].defaultPrefix, 'tmux_aider_', 'a launch-mode agent gets a derived session prefix');
  assert.strictEqual(specs[0].launchArgs(), '--yes');
  assert.strictEqual(specs[0].resumeLatest('--yes'), 'aider --restore --yes', '{args} expands in a resume template');
  assert.strictEqual(specs[0].resumeById('s7', '--yes'), "aider --session 's7' --yes", '{id} is shell-quoted');
  assert.strictEqual(specs[1].attachSession, 'my-build-loop');
  assert.strictEqual(specs[1].command, null, 'a mirror entry has nothing to launch');
  assert.ok(!specs[1].resumeLatest, 'a mirror entry offers no resume');

  assert.strictEqual(freeAgentId('my-build-loop', []), 'my-build-loop');
  assert.strictEqual(freeAgentId('9-build', []), 's-9-build', 'an id must start with a letter');
  assert.strictEqual(freeAgentId('claude', []), 'claude-2', 'a built-in id is never reused');
  assert.strictEqual(freeAgentId('x', [{ id: 'x' }]), 'x-2', 'an id already in the list is never reused');

  registerCustomAgents();
  assert.ok(AGENT_IDS.includes('aider') && AGENT_IDS.includes('build'), 'custom agents join the roster');
  assert.strictEqual(AGENTS.claude.command, 'claude', 'a built-in agent can never be shadowed');
  assert.strictEqual(baseSessionName('aider', '/home/u/work/proj'), 'tmux_aider_proj',
    'a launch-mode agent gets a workspace session like any built-in');
  assert.strictEqual(baseSessionName('build', '/home/u/work/proj'), 'my-build-loop',
    'a mirrored agent uses the session name the user gave, not a derived one');
  assert.strictEqual(mirroredSessionNames().has('my-build-loop'), true);

  // A mirrored session is deliberately exempt from the workspace-root gate —
  // that is the point of the mode — while a managed one is not.
  const foreign = await agentSessionInfo('build', 'my-build-loop_other');
  assert.strictEqual(foreign.ready, true, 'a mirrored session is shown wherever it lives');
  const foreignManaged = await agentSessionInfo('claude', 'tmux_claude_other');
  assert.strictEqual(foreignManaged.exists, false, 'a managed session outside the workspace is still invisible');

  // …but nothing destructive may reach it.
  const freeProvider = makeProvider();
  sessionListOutput = [
    `my-build-loop\t${workspace}\t1700000000\t0\t1`,               // mirrored, in this project
    `tmux_aider_claude-tmux-sidebar\t${workspace}\t1700000000\t0\t1`,
  ].join('\n');
  quickPickAnswer = undefined;
  quickPickItems = null;
  await freeProvider.cleanupSessions();
  const freeOffered = (quickPickItems || []).map((item) => item.session);
  assert.ok(!freeOffered.includes('my-build-loop'),
    'a session AgentMux only mirrors is never a leftover of ours, even inside the project');
  assert.ok(freeOffered.includes('tmux_aider_claude-tmux-sidebar'),
    'a custom agent AgentMux does launch is cleaned up like any other');
  sessionListOutput = null;
  quickPickItems = null;

  quickPickAnswer = undefined;
  quickPickItems = null;
  await freeProvider.killPick();
  assert.ok(!(quickPickItems || []).some((item) => item.agent === 'build'),
    'bulk kill never offers a mirrored session');

  // An arbiter round needs a marked answer from every participant and fails as
  // a whole if one cannot give it — and a mirrored session may be a plain shell.
  for (const agent of AGENT_IDS) freeProvider.agentState[agent].present = true;
  assert.ok(!freeProvider.arbiterParticipants().includes('build'),
    'a mirrored session never joins an arbiter round');
  assert.ok(freeProvider.arbiterParticipants().includes('aider'),
    'a custom agent AgentMux launches does take part');
  for (const agent of AGENT_IDS) freeProvider.agentState[agent].present = false;

  // Free mode never launches: a missing mirrored session is reported, not created.
  agentInfoOutput = null;
  calls.length = 0;
  await freeProvider.startSession('build');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'new-session').length, 0,
    'free mode never creates a tmux session');
  calls.length = 0;
  freeProvider.activeAgent = 'build';
  await freeProvider.restart();
  assert.strictEqual(calls.filter((call) => call.args[0] === 'kill-session').length, 0,
    'free mode never restarts a session it did not create');
  await freeProvider.attachExisting('build');
  assert.strictEqual(calls.filter((call) => call.args[0] === 'kill-session').length, 0,
    'free mode never replaces a session to resume it');
  freeProvider.activeAgent = 'claude';

  settings.set('customAgents', []);
  settings.set('piArgs', '');

  // The generated markup carries the whole roster, tabs included.
  const markup = provider.html({ asWebviewUri: (u) => u, cspSource: 'vscode-resource:' });
  assert.strictEqual((markup.match(/class="agent-tab/g) || []).length, AGENT_IDS.length, 'one tab per registered agent');
  assert.match(markup, /data-agent="antigravity"/);
  assert.match(markup, /Start Antigravity/);
  assert.match(markup, /data-agents="/, 'the webview receives the roster');
  assert.match(markup, /id="handoff-target"/);
  assert.match(markup, /data-palette="theme"/, 'the mirror is told which ANSI palette to use');

  const webviewSource = fs.readFileSync(path.join(root, 'media/main.js'), 'utf8');
  assert.match(webviewSource, /tab\.classList\.toggle\('hidden', !present\)/);
  assert.match(webviewSource, /handoffText\.value/);
  assert.match(webviewSource, /type: 'createHandoff'/);
  assert.match(webviewSource, /m\.type === 'handoffDetails'/);
  assert.match(webviewSource, /m\.type === 'handoffChecking'/);
  assert.match(webviewSource, /hist \$\{history\}/);
  assert.match(webviewSource, /lag \$\{Math\.round\(latencyMs\)\}ms/);
  assert.match(webviewSource, /state-history|historyMode/);
  assert.match(source, /value="continue">Continue task/);
  assert.match(webviewSource, /compositionend/);
  assert.match(webviewSource, /scheduleReportSize/);
  assert.match(webviewSource, /type: 'resync'/);
  assert.match(webviewSource, /bgFrame/);
  assert.match(webviewSource, /arbiterVerdict/);
  assert.match(webviewSource, /path-link/);
  assert.match(webviewSource, /promptHistory/);
  assert.match(webviewSource, /updateVirtualWindow/);
  assert.match(webviewSource, /dataset\.agents/, 'the webview builds its roster from the host registry');
  assert.match(webviewSource, /setHandoffTargets/, 'the details step must offer a handoff peer');
  assert.doesNotMatch(webviewSource, /\['claude', 'codex'\]/, 'no hardcoded two-agent roster may remain');
  assert.match(webviewSource, /XTERM/, 'the original-terminal palette is available');
  assert.match(webviewSource, /deleteSession/, 'conversations can be deleted from the resume list');
  assert.doesNotMatch(webviewSource, /notePredict|drawSpark|xtermWriteFull/, 'removed features must not linger in the webview');

  // ---- navigation: go to the agent that needs you ---------------------------------------
  {
    const nav = makeProvider();
    for (const agent of AGENT_IDS) nav.agentState[agent].present = false;
    nav.activeAgent = 'claude';
    for (const agent of ['claude', 'codex', 'opencode']) nav.agentState[agent].present = true;
    const at = (agent, status, since) => {
      nav.agentState[agent].status = status;
      nav.agentState[agent].statusSince = since;
    };
    at('claude', 'working', 1000);
    at('codex', 'done', 2000);
    at('opencode', 'done', 3000);
    assert.strictEqual(nav.pickAttentionAgent(), 'opencode', 'the most recent completion wins among equals');
    at('codex', 'needs-input', 500);
    assert.strictEqual(nav.pickAttentionAgent(), 'codex',
      'an agent BLOCKED on you outranks a newer completion — it cannot make progress');
    at('codex', 'working', 500);
    at('opencode', 'working', 3000);
    assert.strictEqual(nav.pickAttentionAgent(), null, 'nothing to go to while everyone works');

    // Cycling walks only the agents that are actually running.
    at('claude', 'idle', 0); at('codex', 'idle', 0); at('opencode', 'idle', 0);
    assert.deepStrictEqual(nav.presentAgents().join(','), 'claude,codex,opencode');
    assert.strictEqual(await nav.cycleAgent(1), 'codex');
    assert.strictEqual(await nav.cycleAgent(-1), 'claude');
    assert.strictEqual(await nav.jumpToAgent({ index: 3 }), 'opencode');
    assert.strictEqual(await nav.jumpToAgent({ index: 9 }), null, 'an out-of-range jump does nothing');
    // …and the toggle returns to where you came from, not to the roster order.
    assert.strictEqual(nav.activeAgent, 'opencode');
    assert.strictEqual(await nav.gotoLastAgent(), 'claude');
    assert.strictEqual(await nav.gotoLastAgent(), 'opencode', 'the toggle alternates between two agents');
    nav.agentState.opencode.present = false;
    nav.activeAgent = 'claude';
    assert.notStrictEqual(await nav.gotoLastAgent(), 'opencode', 'a stopped agent is never a toggle target');
  }

  // ---- scriptable surface ----------------------------------------------------------------
  {
    const api = makeProvider();
    for (const agent of AGENT_IDS) api.agentState[agent].present = false;
    api.agentState.claude.present = true;
    api.agentState.claude.status = 'done';
    api.activeAgent = 'claude';

    assert.strictEqual((await api.sendToAgent({ agent: 'codex', text: 'hi' })).reason, 'not-running',
      'a script is told why, instead of the input vanishing');
    assert.strictEqual((await api.sendToAgent({ agent: 'claude', text: '   ' })).reason, 'empty');
    assert.strictEqual((await api.sendToAgent({ agent: 'claude', text: 'x'.repeat(30001) })).reason, 'too-long');

    api.writerAgent = 'codex';
    const locked = await api.sendToAgent({ agent: 'claude', text: 'hi' });
    assert.deepStrictEqual({ ok: locked.ok, reason: locked.reason, writer: locked.writer },
      { ok: false, reason: 'pair-locked', writer: 'codex' },
      'the scripted path obeys the Pair Mode lock exactly like the side bar');
    api.writerAgent = null;

    api.handoff = { phase: 'awaitingAck' };
    assert.strictEqual((await api.sendToAgent({ agent: 'claude', text: 'hi' })).reason, 'transaction-in-progress');
    api.handoff = null;

    calls.length = 0;
    const sent = await api.sendToAgent({ agent: 'claude', text: 'run the tests' });
    assert.strictEqual(sent.ok, true);
    await waitForFlush(api, 'claude');
    assert.match(deliveredInput(), /run the tests\r$/, 'the text is typed and submitted');
    calls.length = 0;
    await api.sendToAgent({ agent: 'claude', text: 'no newline', submit: false });
    await waitForFlush(api, 'claude');
    assert.strictEqual(deliveredInput(), 'no newline', 'submit:false types without submitting');

    // status is a plain object a caller can branch on.
    const report = api.agentStatus({ quiet: true });
    assert.strictEqual(Object.keys(report).length, AGENT_IDS.length, 'every agent is reported');
    assert.strictEqual(report.claude.present, true);
    assert.strictEqual(api.agentStatus({ agent: 'claude', quiet: true }).codex, undefined,
      'asking about one agent returns only that agent');

    captureOutput = 'tail of the pane\n';
    const captured = await api.captureAgent({ agent: 'claude', lines: 40, quiet: true });
    assert.strictEqual(captured.ok, true);
    assert.match(captured.text, /tail of the pane/);
    // Capture asks the pane, not the cached presence, so it reports what is
    // really on screen — but it still refuses outside a workspace.
    const priorFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = undefined;
    assert.strictEqual((await api.captureAgent({ agent: 'claude', quiet: true })).reason, 'no-workspace');
    vscode.workspace.workspaceFolders = priorFolders;

    // wait resolves on a status the agent ALREADY holds; the caller asked where
    // it is, not for the next transition. (Submitting a prompt above moved it
    // to working, which is exactly the state a real script would wait out.)
    assert.strictEqual(api.agentState.claude.status, 'working', 'submitting marks the agent working');
    api.setAgentStatus('claude', 'done');
    // (Objects the extension builds live in the vm realm, so compare fields.)
    const waited = await api.waitForAgent({ agent: 'claude', status: 'done', timeoutMs: 1000 });
    assert.strictEqual(waited.ok, true);
    assert.strictEqual(waited.agent, 'claude');
    assert.strictEqual(waited.status, 'done');
    const timedOut = await api.waitForAgent({ agent: 'claude', status: 'needs-input', timeoutMs: 1000 });
    assert.strictEqual(timedOut.ok, false);
    assert.strictEqual(timedOut.reason, 'timeout');
  }

  // ---- Shift+Enter is a newline, per agent ------------------------------------------------
  // Measured in live panes, one candidate at a time: Claude, Codex and OpenCode
  // read CSI-u; Hermes, pi and Antigravity read xterm modifyOtherKeys. There is
  // no universal encoding, and the wrong one types visible garbage into the
  // input box — so this table is data, not a guess.
  assert.strictEqual(AGENTS.claude.modEnter, '\x1b[13;2u');
  assert.strictEqual(AGENTS.codex.modEnter, '\x1b[13;2u');
  assert.strictEqual(AGENTS.opencode.modEnter, '\x1b[13;2u');
  assert.strictEqual(AGENTS.hermes.modEnter, '\x1b[27;2;13~');
  assert.strictEqual(AGENTS.pi.modEnter, '\x1b[27;2;13~');
  assert.strictEqual(AGENTS.antigravity.modEnter, '\x1b[27;2;13~');
  {
    const markup = provider.html({ asWebviewUri: (u) => u, cspSource: 'x:' });
    const shipped = JSON.parse(/data-agents="([^"]*)"/.exec(markup)[1].replace(/&quot;/g, '"'));
    const claude = shipped.find((a) => a.id === 'claude');
    assert.strictEqual(claude.modEnter, '\x1b[13;2u', 'the sequence reaches the webview');
    assert.ok(!/\x1b/.test(markup), 'and never as a raw control byte in the markup');
  }
  assert.match(webviewSource, /e\.shiftKey \? \(AGENT_META\[activeAgent\]\?\.modEnter \|\| '\\r'\)/,
    'plain Enter still submits; only Shift+Enter consults the table');

  // A free-mode agent writes the sequence as readable text, since JSON cannot
  // hold the byte. Only escape sequences are accepted — never literal text that
  // would simply be typed into the agent.
  settings.set('customAgents', [
    { id: 'kb1', command: 'x', modEnter: '\\x1b[13;2u' },
    { id: 'kb2', command: 'x', modEnter: '\\e[27;2;13~' },
    { id: 'kb3', command: 'x', modEnter: 'rm -rf /' },
    { id: 'kb4', command: 'x' },
  ]);
  const kb = Object.fromEntries(customAgentSpecs().map((s) => [s.id, s]));
  assert.strictEqual(kb.kb1.modEnter, '\x1b[13;2u', '\\xNN is decoded');
  assert.strictEqual(kb.kb2.modEnter, '\x1b[27;2;13~', '\\e is decoded');
  assert.strictEqual(kb.kb3.modEnter, '', 'a non-escape value is refused rather than typed');
  assert.strictEqual(kb.kb4.modEnter, '', 'no value means Shift+Enter keeps submitting, as before');

  // ---- per-agent tab identity --------------------------------------------------------------
  assert.strictEqual(accentChannels('#d97757'), '217, 119, 87');
  assert.strictEqual(accentChannels('nonsense'), '128, 128, 128', 'a bad colour degrades to grey');
  assert.strictEqual(derivedAccent('build'), derivedAccent('build'), 'the same id always gets the same hue');
  assert.notStrictEqual(derivedAccent('build'), derivedAccent('deploy'));
  assert.match(derivedAccent('build'), /^#[0-9a-f]{6}$/);
  assert.strictEqual(derivedMark('Build loop', 'build'), 'BU');
  assert.strictEqual(derivedMark('', 'x9'), 'X9');
  assert.strictEqual(kb.kb1.accent, derivedAccent('kb1'), 'a custom agent gets a derived accent');
  assert.strictEqual(kb.kb1.mark, 'KB', 'and a mark from its label');
  settings.set('customAgents', [{ id: 'kb5', command: 'x', label: 'Ship', accent: '#123456', mark: '⚓' }]);
  const kb5 = customAgentSpecs()[0];
  assert.strictEqual(kb5.accent, '#123456', 'both are overridable per entry');
  assert.strictEqual(kb5.mark, '⚓');
  settings.set('customAgents', []);

  {
    const markup = provider.html({ asWebviewUri: (u) => u, cspSource: 'x:' });
    assert.match(markup, /--agent-accent: 217, 119, 87/, 'the accent travels as channels, for any alpha');
    assert.match(markup, /class="agent-mark" aria-hidden="true">CC</, 'each tab carries its mark');
    assert.match(markup, /class="agent-swatch"[^>]*--agent-accent: 16, 163, 127/,
      'the launch menu leads with the same colour');
    const css = fs.readFileSync(path.join(root, 'media/main.css'), 'utf8');
    assert.match(css, /@container \(max-width: 78px\)/,
      'the mark replaces the label once a tab is too narrow to say anything');
    assert.match(css, /border-bottom: 2px solid rgba\(var\(--agent-accent/,
      'the colour rides the underline the tab already had — no new horizontal space');
  }

  // ---- a failed launch names the real cause ----------------------------------------------
  // "Cannot start Pi in tmux session tmux_pi_x" left the user to guess; the
  // overwhelmingly common cause is that the CLI is simply not installed.
  {
    const failing = makeProvider();
    let shown = '';
    const priorError = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = async (message) => { shown = message; return undefined; };
    // The real method re-probes PATH; here the probe result is the fixture.
    failing.runPreflight = async () => {};
    try {
      failing._preflight = { tmux: 'tmux 3.4', agents: byAgentIds(() => true) };
      failing._preflight.agents.pi = false;
      await failing.reportLaunchFailure('pi', 'tmux_pi_x');
      assert.match(shown, /Pi is not on PATH/, 'a missing CLI is reported as a missing CLI');
      assert.match(shown, /@earendil-works\/pi-coding-agent/, 'with the command that installs it');
      failing._preflight.agents.pi = true;
      await failing.reportLaunchFailure('pi', 'tmux_pi_x');
      assert.match(shown, /Cannot start Pi in tmux session/,
        'an installed CLI that still fails keeps the original message');
    } finally {
      vscode.window.showErrorMessage = priorError;
    }
  }

  // ---- integrations are inspectable, not just removable ----------------------------------
  {
    const integrations = makeProvider();
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmux-int-'));
    const priorXdg2 = process.env.XDG_CONFIG_HOME;
    const priorPi2 = process.env.PI_CODING_AGENT_DIR;
    process.env.XDG_CONFIG_HOME = path.join(fakeHome, 'config');
    process.env.PI_CODING_AGENT_DIR = path.join(fakeHome, 'pi');
    setStateHookDir(path.join(fakeHome, 'hooks'));
    settings.set('stateHooks', true);
    try {
      const before = integrations.integrationCatalog();
      const byId = Object.fromEntries(before.map((e) => [e.id, e]));
      assert.strictEqual(byId['opencode-plugin'].state, 'not installed');
      assert.strictEqual(byId['pi-extension'].state, 'not installed');
      assert.strictEqual(byId['codex-hooks'].state, 'passed at launch',
        'the Codex hooks are launch arguments, not a file, and say so');
      assert.strictEqual(byId['codex-hooks'].file, null);

      assert.strictEqual(byId['pi-extension'].install(), true);
      assert.strictEqual(byId['opencode-plugin'].install(), true);
      const after = Object.fromEntries(integrations.integrationCatalog().map((e) => [e.id, e]));
      assert.strictEqual(after['pi-extension'].state, 'installed');
      assert.strictEqual(after['opencode-plugin'].state, 'installed');

      // A file left behind by an older AgentMux must read as stale, not as fine.
      fs.writeFileSync(after['pi-extension'].file, '// an older version\n');
      const stale = Object.fromEntries(integrations.integrationCatalog().map((e) => [e.id, e]));
      assert.strictEqual(stale['pi-extension'].state, 'out of date',
        'content is compared, so a stale integration is visible instead of silently wrong');
      assert.strictEqual(stale['pi-extension'].install(), true);
      assert.strictEqual(
        integrations.integrationCatalog().find((e) => e.id === 'pi-extension').state, 'installed');

      assert.strictEqual(after['pi-extension'].remove(), true);
      assert.strictEqual(
        integrations.integrationCatalog().find((e) => e.id === 'pi-extension').state, 'not installed');

      settings.set('codexHooks', false);
      assert.strictEqual(
        integrations.integrationCatalog().find((e) => e.id === 'codex-hooks').state, 'off');
      settings.set('codexHooks', true);
    } finally {
      if (priorXdg2 == null) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg2;
      if (priorPi2 == null) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorPi2;
      setStateHookDir(null);
      settings.set('stateHooks', false);
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  console.log('All extension tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
