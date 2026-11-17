// A hub that starts a turn and is then killed by the test. Prints what it sees as JSON lines.
import { ClaudeCli } from '../../src/adapters/claude-cli.ts'

const [turnsDir, bin, prompt] = process.argv.slice(2)
const cli = new ClaudeCli({ bin: bin!, cwd: '/tmp', turnsDir: turnsDir!, turnTimeoutMs: 60_000, env: { FAKE_NODE: process.execPath } })
const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
void cli.run({
  prompt: prompt!, history: [], model: 'opus', effort: 'low', mode: 'auto', sessionId: null,
  signal: new AbortController().signal,
  onStart: (handle) => say({ handle }),
  onEvent: (e) => {
    if (e.type === 'text') say({ text: e.text })
    if (e.type === 'approval') say({ approval: e.request.text })
  },
}).then((r) => say({ result: r }))
