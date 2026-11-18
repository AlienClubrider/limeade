# Limeade

Your assistant, its workers and your chats, in the browser on your own computer. Limeade drives
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex)
(through the Agent Client Protocol) and local models in [Ollama](https://ollama.com). It runs as a small
background service on your Mac or Linux computer, on `http://localhost:8797`, and installs as an app from the
browser.

- **Assistant**: one long-running conversation that takes your requests, does small things itself and
  hands bigger jobs to workers, then tells you what happened. It learns how you like things done (with your
  OK).
- **Workers**: agent sessions the Assistant starts, each in its own folder. They report back
  (`fleet status …`), and the Assistant hears when one is done, stuck or needs you.
- **Chat**: your own chats with any model, each in a folder you pick.
- **Notifications**: Web Push to this computer's browser (and your phone, if you set that up). Approvals
  can be answered from the notification.
- **Local models**: chat with Ollama models, add and remove them from the library.
- **MCP servers, skills and agents**: configured once, shared by Claude Code and Codex. Keys MCP servers
  need are kept in the macOS Keychain (on Linux, a private file) and never written into either agent's config.

## Install

You need **Node.js 24 or newer** ([nodejs.org](https://nodejs.org); `node -v` to check). Then, in Terminal:

```
npx -y github:AlienClubrider/limeade
```

That's all. It:

1. copies Limeade to `~/.local/share/limeade/app` and installs its three packages there (no install
   scripts run, no audit or update checks);
2. makes `~/.config/limeade/` with its settings (`limeade.env`) and a private key for scripts;
3. starts it as a background service that comes back after a restart (launchd on macOS,
   `systemd --user` on Linux);
4. opens `http://localhost:8797`.

To install it as an app: in Chrome, the install icon in the address bar; in Safari, File › Add to Dock.
Run the same command again to update; your chats and settings stay.

Nothing in Limeade phones home. The service runs with `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1`; Claude
Code runs with its telemetry, error reports and auto-updates off; a Codex that Limeade installs gets a config
with its telemetry off (a Codex you already set up keeps your config).

## First run

Open **Settings** (the gear). **Get started** lists what's left:

1. **Set up Claude Code or Codex**: Settings › Agents finds them if they're installed, installs a missing
   one in one tap, and signs in with a link (your subscription) or an API key. Limeade never copies their
   sign-ins; each agent keeps its own.
2. **Connect Ollama** (optional): Limeade looks for Ollama at `http://localhost:11434`. Change the address
   in Settings › Local models if it runs elsewhere. The **Local models** page lists what's installed and adds
   models from the Ollama library.
3. **Add your MCP servers and keys** (optional): on the **MCP** page. Keys go to the Keychain.
4. **Turn on notifications** for this browser.

A new install also gets a default **Assistant** persona in both agents (`~/.claude/agents/assistant.md` and
`~/.codex/agents/assistant.toml`), unless you already have one. Pick its model with the chip under the message
box: a Claude or Codex model, or a local model that can use tools.

Local models that use tools run in Claude Code (or Codex) pointed at Ollama, so they can read and change files
in the chat's folder. Claude Code sends long prompts; give Ollama a context of at least 32k tokens
(`OLLAMA_CONTEXT_LENGTH=32768` where Ollama runs) if your machine doesn't already.

## Workers

The Assistant starts workers with the bundled `fleet` command, which every agent Limeade runs has on its
`PATH`:

```
fleet start <agent|-> "<Title>" <folder> <brief-file> [--model <id>] [--on claude|codex]
fleet list | show <name> | send <name> "<text>" | stop <name>
fleet digest | events | ack | task add|set|list
fleet status <working|paused|needs-decision|blocked|done|failed> "<one line>"   (workers)
```

A worker is a chat: it shows on the Chat page, where you can read along or answer it, and on the Workers page.
When a worker reports needs-decision, blocked, done or failed, ends a turn without reporting, fails, or waits
on an approval, the Assistant gets a message about it and decides what to tell you.

The Assistant is told to hand off every job you'd follow to a worker, and to say a job has started only once
`fleet start` succeeded. Its agent's own subagents (helpers inside one of its turns) don't show on the Workers
page; they only show as steps in the Assistant's chat.

## Use it from your phone (optional)

Limeade only listens on this computer. To reach it from your phone, use [Tailscale](https://tailscale.com):

1. Install Tailscale on the computer and the phone, signed in to the same account.
2. On the computer: `tailscale serve --bg 8797`. It prints an address like `https://my-mac.tail1234.ts.net`.
3. `limeade phone my-mac.tail1234.ts.net` so Limeade answers to that name.
4. Open that address on the phone and add it to the Home Screen; turn on notifications there.

Anyone on your tailnet can open it, so keep the tailnet to your own devices.

## Commands

```
limeade status | start | stop | restart | logs | open
limeade phone <name>          let Limeade answer to another name (see above)
limeade uninstall [--all]     remove the service and app (--all: chats, settings and keys too)
```

The `limeade` command is linked into `~/.local/bin`. If that isn't on your `PATH`, use
`~/.local/bin/limeade`.

## Settings

`~/.config/limeade/limeade.env` (then `limeade restart`):

| Setting | Default | |
|---|---|---|
| `PORT` | `8797` | The page and API, on `127.0.0.1` only |
| `WORK_DIR` | your home folder | Where the Assistant and new chats work |
| `OLLAMA_URL` | `http://localhost:11434` | First value of Settings › Local models |
| `TRUSTED_HOSTS` | none | Other names the page is reached by (`limeade phone`) |
| `MACHINE_NAME` | `This computer` | How this computer is named in the app |

Anything else in the file (an agent's API key, a custom provider's key) reaches the agents too. A value set in
`limeade.env` wins over the same name in the environment the service or shell started with.

Where things are:

| | |
|---|---|
| `~/.local/share/limeade/app` | the app |
| `~/.config/limeade/` | settings, the script key, push keys, MCP key names |
| `~/.local/state/limeade/` | chats, uploads, worker records (`fleet/`), notifications |
| `~/Library/Logs/Limeade/` (macOS) or `journalctl --user -u limeade` (Linux) | logs |

Requests from this computer's browser (to `localhost`) are let in; changes must come from Limeade's own page.
Scripts use the key in `~/.config/limeade/key` as `Authorization: Bearer <key>`.

## Develop

```
npm install
npm run check        # typecheck, web syntax check, tests
DEV_LOGIN=1 PORT=8798 STATE_DIR=/tmp/limeade-dev CONFIG_DIR=/tmp/limeade-dev node src/main.ts
```

Node runs the TypeScript directly; there is no build step. Rules in `src/domain`, the conversation core in
`src/app`, I/O behind the ports in `src/ports.ts`, adapters in `src/adapters`, the web app in `public/`.

## License

MIT (LICENSE). The bundled fonts, Inter Tight and IBM Plex Mono, are under the SIL Open Font
License 1.1 (public/fonts/OFL.txt).
