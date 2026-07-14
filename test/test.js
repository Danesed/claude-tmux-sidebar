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
const settings = new Map([
  ['codexArgs', '--no-alt-screen'],
  ['codexFullAccess', true],
  ['codexReadClaudeRules', true],
  ['sessionPrefix', 'tmux_'],
  ['codexSessionPrefix', 'codex_'],
  ['scrollbackLines', 1000],
]);

function execFile(command, args, options, callback) {
  calls.push({ command, args: [...args] });
  if (command !== 'tmux') return callback(null, '', '');
  if (args[0] === 'display-message') {
    const format = args[args.length - 1];
    if (format === '#{session_path}') return callback(null, workspace + '\n', '');
    if (format.includes('@claude_tmux_agent')) {
      if (agentInfoOutput != null) return callback(null, agentInfoOutput, '');
      const target = args[args.indexOf('-t') + 1];
      const agent = target.includes('codex_') ? 'codex' : 'claude';
      return callback(null, `${agent}\t1\t${agent}\n`, '');
    }
    return callback(null, '2,3,80,24,1700000000,240\n', '');
  }
  if (args[0] === 'capture-pane') return callback(null, 'terminal frame\n', '');
  if (args[0] === 'paste-buffer' && failPaste) return callback(new Error('simulated paste failure'), '', '');
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
  + '\nmodule.exports.__test = { ClaudeTmuxView, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo };';
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
const { ClaudeTmuxView, codexLaunchArgs, CODEX_CLAUDE_RULES, agentSessionInfo } = moduleUnderTest.exports.__test;

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

  agentInfoOutput = '\t\tzsh\n';
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
  const burst = 'abcdefghij'.repeat(20);
  for (const char of burst) provider.queueInput('codex', char);
  provider.activeAgent = 'claude';
  await waitForFlush(provider, 'codex');
  assert.strictEqual(sendCalls().length, 1, 'a 200-character burst should use one tmux send');
  assert.strictEqual(decodeSendCalls(sendCalls()), burst, 'batched input must preserve bytes and target agent');

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
  const edited = 'Custom handoff\nkeep this trailing space ';
  failPaste = true;
  await provider.confirmHandoff({ source: 'claude', target: 'codex', mode: 'reviewFix', text: edited });
  assert.strictEqual(provider.writerAgent, null, 'failed delivery must not transfer Pair Mode ownership');
  assert.strictEqual(messages.at(-1).type, 'handoffResult');
  assert.strictEqual(messages.at(-1).ok, false);
  failPaste = false;
  calls.length = 0;
  await provider.confirmHandoff({ source: 'claude', target: 'codex', mode: 'reviewFix', text: edited });
  assert.strictEqual(provider.writerAgent, 'codex');
  assert.strictEqual(deliveredInput(), edited + '\r', 'handoff editor text must be sent unchanged, then submitted');

  const webviewSource = fs.readFileSync(path.join(root, 'media/main.js'), 'utf8');
  assert.match(webviewSource, /tab\.classList\.toggle\('hidden', !present\)/);
  assert.match(webviewSource, /handoffText\.value/);
  assert.match(webviewSource, /state-history|historyMode/);

  console.log('All extension tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
