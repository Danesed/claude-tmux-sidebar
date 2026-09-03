---
name: agentmux
description: "Control AgentMux, orchestrate coding agents running in tmux panes, and communicate with neighboring agents. Use when you need to inspect other agents, delegate subtasks, prompt another agent, or wait for another agent to finish."
---

# AgentMux

AgentMux connects coding agents running inside tmux panes with VS Code. It provides both a CLI (`agentmux`) and an MCP server (`bin/agentmux-mcp.js`) to allow agents to interact, monitor progress, and coordinate tasks.

## CLI Usage

Verify AgentMux is active and inspect running agents:

```bash
agentmux list
```

### Check Detailed Status
```bash
agentmux status codex
```

### Read Recent Terminal Output
Read the last 50 lines of an agent's terminal pane:
```bash
agentmux read claude --lines 50
```

### Prompt Another Agent (Atomic Wait)
Send instructions to a neighboring agent and optionally wait until it finishes processing (`done`) or reaches an approval prompt (`blocked`):

```bash
agentmux prompt codex "Run pytest and verify the new regression tests" --wait --until done --timeout 120000
```

If the target agent is currently paused on a dialog or question prompt (`needs-input`), AgentMux prevents collision and refuses to overwrite the dialog unless `--raw` is passed.

## MCP Server Integration

To use AgentMux via MCP (Model Context Protocol) in Claude Code, Codex, Cursor, or Antigravity, add to your MCP configuration:

```json
{
  "mcpServers": {
    "agentmux": {
      "command": "node",
      "args": ["<path-to-agentmux>/bin/agentmux-mcp.js"]
    }
  }
}
```

Exposed MCP tools:
- `list_agents`: list all running agents and their lifecycle states (`idle`, `working`, `needs-input`, `done`).
- `get_agent_status`: get detailed status, turns, model, and active tool.
- `read_agent_output`: read the latest terminal output lines from a pane.
- `prompt_agent`: send a prompt to an agent and wait for completion.
