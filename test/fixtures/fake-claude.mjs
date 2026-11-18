// A slow claude CLI: streams "one two three four five six", asking to run a command half way when the
// prompt says "ask". Waits for the answer like the real CLI's stdio permission prompt. Messages sent in
// mid-turn (steering) are echoed back (--replay-user-messages) after "three " and answered in the reply;
// one that comes after its result runs as one more round, as the real CLI does.
import { createInterface } from 'node:readline'

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const queue = []
let wake = null
let ended = false
createInterface({ input: process.stdin })
  .on('line', (l) => { queue.push(l); wake?.() })
  .on('close', () => { ended = true; wake?.() })
/** The next line, or null when stdin has ended (or after `ms`, when given). */
const next = (ms) => new Promise((r) => {
  const take = () => {
    if (queue.length) return r(queue.shift())
    if (ended) return r(null)
    wake = () => { wake = null; clearTimeout(t); take() }
    const t = ms ? setTimeout(() => { wake = null; r(null) }, ms) : undefined
  }
  take()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const delta = (text) => out({ type: 'stream_event', session_id: 'fake-sess', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const text = (m) => (typeof m.message.content === 'string' ? m.message.content : m.message.content.map((b) => b.text ?? '').join(''))
/** Messages sent in so far: echoed back, their words returned. */
const takeSteers = () => {
  const got = []
  for (let i = 0; i < queue.length;) {
    const m = JSON.parse(queue[i])
    if (m.type !== 'user') { i++; continue }
    queue.splice(i, 1)
    out({ type: 'user', isReplay: true, uuid: m.uuid, session_id: 'fake-sess', message: m.message })
    got.push(text(m))
  }
  return got
}

const first = JSON.parse(await next())
const prompt = typeof first.message.content === 'string' ? first.message.content : ''
const step = Number(process.env.FAKE_STEP_MS || 150)
out({ type: 'system', subtype: 'init', session_id: 'fake-sess', model: 'claude-fake-1' })
for (const w of ['one ', 'two ', 'three ']) { delta(w); await sleep(step) }
const steered = takeSteers()
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
const tail = steered.map((s) => ` [${s}]`).join('')
for (const w of ['four ', 'five ', `six${tail}`]) { delta(w); await sleep(step) }
out({ type: 'result', session_id: 'fake-sess', result: `one two three ${extra}four five six${tail}${answer ? ` (${answer})` : ''}`, is_error: false })
// A message that came too late for this round starts another, until stdin ends.
for (;;) {
  const line = await next(400)
  if (line === null) break
  const m = JSON.parse(line)
  if (m.type !== 'user') continue
  out({ type: 'system', subtype: 'init', session_id: 'fake-sess', model: 'claude-fake-1' })
  out({ type: 'user', isReplay: true, uuid: m.uuid, session_id: 'fake-sess', message: m.message })
  out({ type: 'stream_event', session_id: 'fake-sess', event: { type: 'message_start' } })
  delta(`late: ${text(m)}`)
  out({ type: 'result', session_id: 'fake-sess', result: `late: ${text(m)}`, is_error: false })
}
process.exit(0)
