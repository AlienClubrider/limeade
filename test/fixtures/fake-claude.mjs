// A slow claude CLI: streams "one two three four five six", asking to run a command half way when the
// prompt says "ask". Waits for the answer like the real CLI's stdio permission prompt.
import { createInterface } from 'node:readline'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const lines = createInterface({ input: process.stdin })
const next = () => new Promise((r) => lines.once('line', r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const delta = (text) => out({ type: 'stream_event', session_id: 'fake-sess', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

const first = JSON.parse(await next())
const prompt = typeof first.message.content === 'string' ? first.message.content : ''
const step = Number(process.env.FAKE_STEP_MS || 150)
out({ type: 'system', subtype: 'init', session_id: 'fake-sess', model: 'claude-fake-1' })
for (const w of ['one ', 'two ', 'three ']) { delta(w); await sleep(step) }
// FAKE_LONG=n: a long markdown reply in the middle, n small pieces (for the app's streaming checks).
const long = Number(process.env.FAKE_LONG || 0)
let extra = ''
for (let i = 0; i < long; i++) {
  const piece = i % 40 === 39 ? `**word ${i}**\n\n- item ${i}\n\n` : `word${i} `
  extra += piece
  delta(piece)
  await sleep(step)
}
let answer = ''
if (prompt.includes('ask')) {
  out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } })
  for (;;) {
    const msg = JSON.parse(await next())
    if (msg.type === 'control_response' && msg.response.request_id === 'r1') { answer = msg.response.response.behavior; break }
  }
  out({ type: 'assistant', session_id: 'fake-sess', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
}
for (const w of ['four ', 'five ', 'six']) { delta(w); await sleep(step) }
out({ type: 'result', session_id: 'fake-sess', result: `one two three ${extra}four five six${answer ? ` (${answer})` : ''}`, is_error: false })
lines.close()
process.stdin.destroy()
