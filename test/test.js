const assert = require('assert');
const fs = require('fs');
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
const settings = new Map([
  ['codexArgs', '--no-alt-screen'],
  ['codexFullAccess', true],
  ['codexReadClaudeRules', true],
  ['sessionPrefix', 'tmux_'],
  ['codexSessionPrefix', 'codex_'],
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
  if (command !== 'tmux') return callback(null, '', '');
  if (args[0] === 'display-message') {
    const format = args[args.length - 1];
    if (format === '#{session_path}') return callback(null, workspace + '\n', '');
    if (format.includes('@claude_tmux_agent')) {
      if (agentInfoOutput != null) return callback(null, workspace + '\t' + agentInfoOutput, '');
      const target = args[args.indexOf('-t') + 1];
      const agent = target.includes('codex_') ? 'codex' : 'claude';
      return callback(null, `${workspace}\t${agent}\t1\t${agent}\t1700000000\tgen-a\n`, '');
    }
    return callback(null, '2,3,80,24,1700000000,240,0\n', '');
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

const state = new Map();
const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspace } }],
    getConfiguration(section) {
      if (section === 'terminal.integrated') return { get: () => undefined };
      return { get: (key) => settings.get(key) };
    },
  },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  Uri: { joinPath: (...parts) => parts.join('/') },
};

const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8')
  + '\nmodule.exports.__test = { ClaudeTmuxView, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo, extractMarkedBlock, sourceHandoffPrompt, findingsPrompt, splitFusedCapture, diffFrameLines, TmuxControlClient, listCodexSessions };';
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
const { ClaudeTmuxView, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo, extractMarkedBlock, sourceHandoffPrompt, findingsPrompt, splitFusedCapture, diffFrameLines, TmuxControlClient, listCodexSessions } = moduleUnderTest.exports.__test;

function makeProvider() {
  const provider = new ClaudeTmuxView({
    extensionUri: root,
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
    2,
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
  assert.strictEqual(messages.at(-1).ok, false);
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
  assert.strictEqual(messages.at(-1).type, 'handoffResult');
  assert.strictEqual(messages.at(-1).ok, false);
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
  const os = require('os');
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
  assert.match(webviewSource, /notePredict/);

  console.log('All extension tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
