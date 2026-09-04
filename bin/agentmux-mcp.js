#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');

function findSocketPath() {
  if (process.env.AGENTMUX_SOCK && fs.existsSync(process.env.AGENTMUX_SOCK)) {
    return process.env.AGENTMUX_SOCK;
  }
  let dir = process.cwd();
  while (dir && dir !== path.dirname(dir)) {
    const p = path.join(dir, '.claude', 'agentmux', 'agentmux.sock');
    if (fs.existsSync(p)) {
      try {
        const target = fs.readFileSync(p, 'utf8').trim();
        if (target && fs.existsSync(target)) return target;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  const os = require('os');
  const tmp = os.tmpdir();
  try {
    const files = fs.readdirSync(tmp).filter((f) => f.startsWith('agentmux-') && f.endsWith('.sock'));
    if (files.length) {
      files.sort((a, b) => fs.statSync(path.join(tmp, b)).mtimeMs - fs.statSync(path.join(tmp, a)).mtimeMs);
      return path.join(tmp, files[0]);
    }
  } catch {}
  return null;
}

function queryIpc(req) {
  return new Promise((resolve, reject) => {
    const sockPath = findSocketPath();
    if (!sockPath) {
      return reject(new Error('AgentMux socket not found. Make sure VS Code with AgentMux is open.'));
    }

    const client = net.createConnection(sockPath, () => {
      client.write(JSON.stringify(req) + '\n');
    });

    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        const line = buf.split('\n')[0];
        client.end();
        try {
          const res = JSON.parse(line);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      }
    });

    client.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        reject(new Error('Cannot connect to AgentMux: server is not active or socket is stale. Please make sure VS Code is open.'));
      } else {
        reject(err);
      }
    });
  });
}

const TOOLS = [
  {
    name: 'list_agents',
    description: 'List all active coding agents in AgentMux and their live lifecycle status (idle, working, blocked, done)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_agent_status',
    description: 'Get detailed lifecycle status, telemetry, and running tool of a specific agent',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent ID (claude, codex, opencode, hermes, pi, antigravity, devin)' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'read_agent_output',
    description: "Read the recent terminal lines from an agent's pane",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent ID' },
        lines: { type: 'number', description: 'Number of lines to read (default: 50)' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'prompt_agent',
    description: 'Send a prompt or instructions to an agent running in tmux, optionally waiting until completion',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Target agent ID (e.g. codex, pi, claude, devin)' },
        prompt: { type: 'string', description: 'The prompt text to send' },
        wait: { type: 'boolean', description: 'Wait until the agent finishes processing (default: true)' },
        until: { type: 'string', description: "Target state to wait for ('done' or 'blocked'; default: 'done')" },
        timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' },
      },
      required: ['agent', 'prompt'],
    },
  },
];

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'list_agents': {
      const res = await queryIpc({ action: 'list' });
      if (!res.ok) throw new Error(res.message || res.error);
      const text = (res.agents || []).map((a) =>
        `- ${a.id} (${a.label}): ${a.status}${a.attention ? ` [${a.attention}]` : ''}${a.lastTool ? ` (tool: ${a.lastTool})` : ''}`
      ).join('\n') || 'No active agents.';
      return { content: [{ type: 'text', text }] };
    }

    case 'get_agent_status': {
      if (!args || !args.agent) throw new Error("Missing required argument: 'agent'");
      const res = await queryIpc({ action: 'status', agent: args.agent });
      if (!res.ok) throw new Error(res.message || res.error);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    case 'read_agent_output': {
      if (!args || !args.agent) throw new Error("Missing required argument: 'agent'");
      const res = await queryIpc({ action: 'read', agent: args.agent, lines: args.lines || 50 });
      if (!res.ok) throw new Error(res.message || res.error);
      return { content: [{ type: 'text', text: (res.lines || []).join('\n') }] };
    }

    case 'prompt_agent': {
      if (!args || !args.agent) throw new Error("Missing required argument: 'agent'");
      if (!args || !args.prompt) throw new Error("Missing required argument: 'prompt'");
      const wait = args.wait !== false;
      const until = args.until || 'done';
      const timeout = args.timeout || 60000;
      const res = await queryIpc({
        action: 'prompt',
        agent: args.agent,
        text: args.prompt,
        wait,
        until,
        timeout,
      });
      if (!res.ok) throw new Error(res.message || res.error);
      let outputText = `Prompt sent to ${res.agent}.`;
      if (wait) {
        outputText = `Agent [${res.agent}] finished with status: ${res.status} (${res.durationMs || 0}ms)\n\nRecent output:\n${res.output || '(no output captured)'}`;
      }
      return { content: [{ type: 'text', text: outputText }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    const res = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentmux-mcp', version: '0.16.0' },
      },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
    return;
  }

  if (method === 'tools/list') {
    const res = {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    };
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await handleToolCall(params.name, params.arguments);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        },
      }) + '\n');
    }
    return;
  }

  if (id != null) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }) + '\n');
  }
});
