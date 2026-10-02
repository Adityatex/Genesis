# tabi-mcp

An MCP server that lets Claude Code, Claude Desktop, Codex or any other MCP app drive your real browser through the [Tabi](https://github.com/Adityatex/Tabi) extension. The model runs in your AI app, on your plan with it. Tabi supplies page snapshots with numbered elements (including iframes and Shadow DOM), real mouse and keyboard input, and screenshots with the numbers drawn on.

## Setup

```bash
npm install && npm run build
node dist/server.js token        # your pairing token, plus the commands below with the right path
```

1. In Chrome, open the Tabi popup. Under **AI apps (MCP)**, turn on **Let AI apps control this browser** and paste the token.
2. Add the server to your AI app:
   - Claude Code: `claude mcp add tabi -- node /path/to/mcp/dist/server.js`
   - Codex: `codex mcp add tabi -- node /path/to/mcp/dist/server.js`
   - Claude Desktop, in `claude_desktop_config.json`: `"mcpServers": { "tabi": { "command": "node", "args": ["/path/to/mcp/dist/server.js"] } }`

`node dist/server.js new-token` makes a new token; the old one stops working.

## Settings

| Variable | Default | |
|---|---|---|
| `TABI_MCP_PORT` | `17354` | Port on 127.0.0.1; set the same port in the extension |
| `TABI_MCP_TOKEN` | saved in `~/.tabi-mcp/token` | Use a token of your own: `tbk_` and 64 hex characters |

Only one AI app can use Tabi at a time, since the port is shared.

## Renamed from genesis-mcp

This server was called `genesis-mcp` before the extension was renamed Tabi. For one more release, setups made before then keep working:

- The `genesis-mcp` command still runs the server, and prints how to switch.
- `GENESIS_MCP_TOKEN` and `GENESIS_MCP_PORT` are still read, with a note to rename them.
- A token saved in `~/.genesis-mcp` moves to `~/.tabi-mcp` on first run. Tokens made before the rename have no `tbk_` prefix; they still pair, so you don't need to paste a new one.

To switch, remove the old entry from your AI app (`claude mcp remove genesis`) and add it again as `tabi`.

## How it's secured

- Off until you turn it on in the extension; the toolbar icon shows **MCP** while connected.
- Listens on 127.0.0.1 only, and refuses WebSocket connections from web pages (only browser-extension origins may connect).
- Before any command, the server and the extension each prove they hold the pairing token (HMAC-SHA256 challenge and response), so the token is never sent, and another program listening on the port can't command the browser.
- Only `http(s)` URLs can be opened.
