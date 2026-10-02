#!/usr/bin/env node
// mcp/src/genesis-mcp.ts
// genesis-mcp, the command's name before Genesis was renamed Tabi. Kept for
// one release so existing setups keep working: it runs the same server, and
// says how to switch.

import { main, renameNote } from './server.js';

console.error(`[tabi-mcp] ${renameNote()}`);
main().catch((err) => {
  console.error(`[tabi-mcp] ${err?.stack ?? err}`);
  process.exit(1);
});
