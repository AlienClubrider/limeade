// A claude CLI that answers with its arguments and the --settings file it was given (if any).
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
await new Promise((r) => lines.once('line', r))
const args = process.argv.slice(2)
const at = args.indexOf('--settings')
const settings = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : null
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fake-sess', result: JSON.stringify({ args, settings }), is_error: false }) + '\n')
lines.close()
process.stdin.destroy()
