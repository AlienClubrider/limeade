// A slow ACP adapter (Claude's or Codex's): streams "one two three four five six" in one message, asking to run a command
// half way when the prompt says "ask". Answers session/resume of "gone" with "not found". Writes every
// request it gets to $FAKE_ACP_LOG (one JSON line each) so tests can check what the hub sent.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
const log = (o) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = Number(process.env.FAKE_STEP_MS || 150)
const SESSION = 'fake-acp-sess'
const update = (u) => out({ method: 'session/update', params: { sessionId: SESSION, update: u } })
const chunk = (text) => update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } })

const answers = new Map()
let cancelled = false
let steered = ''

async function prompt(msg) {
  const text = msg.params.prompt.map((b) => b.text ?? '').join('')
  update({ sessionUpdate: 'usage_update', used: 1, size: 2, _meta: { '_claude/model': 'claude-fake-1' } })
  for (const w of ['one ', 'two ', 'three ']) {
    if (cancelled) return out({ id: msg.id, result: { stopReason: 'cancelled' } })
    chunk(w)
    await sleep(step)
  }
  let answer = ''
  if (text.includes('ask')) {
    const call = { toolCallId: 't1', title: 'ls', kind: 'execute', rawInput: { command: 'ls', description: 'List files' }, _meta: { claudeCode: { toolName: 'Bash' } } }
    update({ sessionUpdate: 'tool_call', status: 'pending', ...call })
    const options = [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'allow-with-updates', name: "Yes, and don't ask again for ls commands", kind: 'allow_always' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ]
    out({ id: 7, method: 'session/request_permission', params: { sessionId: SESSION, toolCall: call, options } })
    const r = await new Promise((res) => answers.set(7, res))
    answer = r.outcome?.optionId ?? r.outcome?.outcome
    await sleep(step)
  }
  for (const w of ['four ', 'five ', 'six']) {
    if (cancelled) return out({ id: msg.id, result: { stopReason: 'cancelled' } })
    chunk(w)
    await sleep(step)
  }
  if (answer) chunk(` (${answer})`)
  if (steered) chunk(` [${steered}]`)
  out({ id: msg.id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  log(msg)
  if (!msg.method && answers.has(msg.id)) return answers.get(msg.id)(msg.result)
  if (msg.method === 'initialize') {
    // What the hub put in the adapter's environment (Codex's config, which binary it drives).
    log({ env: { CODEX_CONFIG: process.env.CODEX_CONFIG, CODEX_PATH: process.env.CODEX_PATH, CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE, DD_API_KEY: process.env.DD_API_KEY } })
    return out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  }
  if (msg.method === 'session/new') return out({ id: msg.id, result: { sessionId: SESSION } })
  if (msg.method === 'session/resume') {
    if (msg.params.sessionId === 'gone') return out({ id: msg.id, error: { code: -32002, message: 'Resource not found', data: { details: 'Session gone not found' } } })
    return out({ id: msg.id, result: {} })
  }
  if (msg.method === 'session/set_mode') return out({ id: msg.id, result: {} })
  if (msg.method === 'session/set_config_option') return out({ id: msg.id, result: { configOptions: [] } })
  if (msg.method === 'session/cancel') {
    cancelled = true
    return
  }
  if (msg.method === '_session/steering') {
    steered = msg.params.prompt[0].text
    return out({ id: msg.id, result: { outcome: 'injected' } })
  }
  if (msg.method === 'session/prompt') return void prompt(msg)
  if (msg.id !== undefined) out({ id: msg.id, error: { code: -32601, message: 'no' } })
})
