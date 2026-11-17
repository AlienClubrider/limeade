#!/usr/bin/env node
// A stand-in `claude` for `claude mcp add-json -s user <id> <json>` and `claude mcp remove -s user <id>`:
// edits $HOME/.claude.json the way the real one does for user-scope servers.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const file = join(process.env.HOME, '.claude.json')
let cfg = {}
try { cfg = JSON.parse(readFileSync(file, 'utf8')) } catch {}
const [cmd, verb, , , id, json] = process.argv.slice(2)
if (cmd !== 'mcp') process.exit(2)
cfg.mcpServers ??= {}
if (verb === 'add-json') {
  const server = JSON.parse(json)
  if (server.url === 'https://refuse.example') { console.error('refused'); process.exit(1) }
  cfg.mcpServers[id] = server
} else if (verb === 'remove') {
  if (!cfg.mcpServers[id]) { console.error(`No MCP server named ${id}`); process.exit(1) }
  delete cfg.mcpServers[id]
} else process.exit(2)
writeFileSync(file, JSON.stringify(cfg, null, 2))
