// A hub that starts an ACP turn and is then killed by the test. Prints what it sees as JSON lines.
import { fileURLToPath } from 'node:url'
import { ClaudeAcp } from '../../src/adapters/claude-acp.ts'

const [turnsDir, prompt] = process.argv.slice(2)
const fake = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))
const acp = new ClaudeAcp({ adapter: { bin: process.execPath, args: [fake] }, claudeBin: '/bin/true', cwd: '/tmp', turnsDir: turnsDir!, turnTimeoutMs: 60_000 })
const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
void acp.run({
  prompt: prompt!, history: [], model: 'opus', effort: 'low', mode: 'auto', sessionId: null,
  signal: new AbortController().signal,
  onStart: (handle) => say({ handle }),
  onEvent: (e) => {
    if (e.type === 'text') say({ text: e.text })
    if (e.type === 'approval') say({ approval: e.request.text })
  },
}).then((r) => say({ result: r }))
