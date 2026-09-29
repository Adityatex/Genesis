# genesis-mcp

An MCP server that lets Claude Code, Claude Desktop, Codex or any other MCP app drive your real browser through the [Genesis](https://github.com/Adityatex/Genesis) extension. The model runs in your AI app, on your plan with it. Genesis supplies page snapshots with numbered elements (including iframes and Shadow DOM), real mouse and keyboard input, and screenshots with the numbers drawn on.

## Setup

```bash
npm install && npm run build
node dist/server.js token        # your pairing token, plus the commands below with the right path
```

1. In Chrome, open the Genesis popup. Under **AI apps (MCP)**, turn on **Let AI apps control this browser** and paste the token.
2. Add the server to your AI app:
   - Claude Code: `claude mcp add genesis -- node /path/to/mcp/dist/server.js`
   - Codex: `codex mcp add genesis -- node /path/to/mcp/dist/server.js`
   - Claude Desktop, in `claude_desktop_config.json`: `"mcpServers": { "genesis": { "command": "node", "args": ["/path/to/mcp/dist/server.js"] } }`

`node dist/server.js new-token` makes a new token; the old one stops working.

## Settings

| Variable | Default | |
|---|---|---|
| `GENESIS_MCP_PORT` | `17354` | Port on 127.0.0.1; set the same port in the extension |
| `GENESIS_MCP_TOKEN` | saved in `~/.genesis-mcp/token` | Use a token of your own (64 hex characters) |

Only one AI app can use Genesis at a time, since the port is shared.

## How it's secured

- Off until you turn it on in the extension; the toolbar icon shows **MCP** while connected.
- Listens on 127.0.0.1 only, and refuses WebSocket connections from web pages (only browser-extension origins may connect).
- Before any command, the server and the extension each prove they hold the pairing token (HMAC-SHA256 challenge and response), so the token is never sent, and another program listening on the port can't command the browser.
- Only `http(s)` URLs can be opened.
