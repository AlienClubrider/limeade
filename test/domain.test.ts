import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterCut, cliPermissionMode, dropTags, notificationText, readQuiet, replySlot, statusLine, stepFor, titleFrom, cleanTitle } from '../src/domain/chat.ts'
import { eventMarker, eventsToWake, noticeKindFor, noticeTitle, parseEventLine, parseFleetMode, workerName } from '../src/domain/fleet.ts'
import { claudeGroup, claudeLabel, historyFor, LOCAL_HISTORY, localGroups, localLabel, parseModelId } from '../src/domain/models.ts'
import { alwaysLabel, claudeArgs, endpointEnv } from '../src/adapters/claude-cli.ts'
import { LocalTurns } from '../src/adapters/local-turns.ts'
import { LiteLlm } from '../src/adapters/litellm.ts'

test('mode chip maps to Claude Code permission modes', () => {
  assert.equal(cliPermissionMode('ask'), 'manual')
  assert.equal(cliPermissionMode('acceptEdits'), 'acceptEdits')
  assert.equal(cliPermissionMode('auto'), 'auto')
  assert.equal(cliPermissionMode('plan'), 'plan')
})

test('one quiet status line per turn', () => {
  assert.equal(statusLine([], true), 'Running')
  assert.equal(statusLine([], false), '')
  const bash = { tool: 'Bash', text: 'ls' }
  assert.equal(statusLine([bash, bash], false), 'Ran 2 commands')
  assert.equal(statusLine([bash, { tool: 'Edit', text: 'a' }, { tool: 'Read', text: 'b' }], false), 'Ran 1 command, edited 1 file, read 1 file')
  assert.equal(statusLine([{ tool: 'tracker · search', text: '' }], false), 'Used 1 tool')
})

test('steps are one plain line', () => {
  assert.deepEqual(stepFor('Bash', { command: 'npm  run\ntest' }), { tool: 'Bash', text: 'npm run test', label: 'Running a command' })
  assert.deepEqual(stepFor('mcp__tracker__execute', {}), { tool: 'tracker · execute', text: '', label: 'Using tracker' })
  assert.deepEqual(stepFor('Edit', { file_path: '/a/b.ts' }), { tool: 'Edit', text: '/a/b.ts', label: 'Editing b.ts' })
})

test('titles and notification text', () => {
  assert.equal(titleFrom('  Quick dinner\nmore'), 'Quick dinner')
  assert.equal(titleFrom(''), 'New chat')
  assert.equal(titleFrom('x'.repeat(60)).length, 48)
  assert.equal(notificationText('**TL;DR:** Notes app is `done`.\nmore'), 'Notes app is done.')
  assert.equal(notificationText('# Hello\nworld'), 'Hello')
  assert.deepEqual(readQuiet('[quiet] all fine'), { text: 'all fine', quiet: true })
  assert.deepEqual(readQuiet('hi'), { text: 'hi', quiet: false })
})

test('models: ids, labels and groups', () => {
  assert.deepEqual(parseModelId('claude:opus'), { engine: 'claude', name: 'opus' })
  assert.equal(parseModelId('claude:gpt'), null)
  assert.deepEqual(parseModelId('local:llama3.1-8b'), { engine: 'local', name: 'llama3.1-8b' })
  assert.equal(parseModelId('nope'), null)
  assert.equal(claudeLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(claudeLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(claudeLabel('claude-opus-5'), 'Opus 5')
  assert.equal(claudeLabel('gpt-4'), null)
  assert.equal(claudeLabel('claude-fable-5-2'), 'Fable 5.2')
  assert.equal(claudeLabel('claude-fable-5'), 'Fable 5')
  assert.deepEqual(parseModelId('claude:claude-fable-5-2'), { engine: 'claude', name: 'claude-fable-5-2' })
  assert.deepEqual(parseModelId('claude:claude-fable-5'), { engine: 'claude', name: 'claude-fable-5' })
  const long = Array.from({ length: LOCAL_HISTORY + 10 }, (_, i) => i)
  assert.deepEqual(historyFor('local', long), long.slice(10))
  assert.equal(historyFor('claude', long).length, LOCAL_HISTORY + 10)
  assert.equal(historyFor('local', [1, 2]).length, 2)
  const g = claudeGroup({ opus: 'claude-opus-5-5' })
  assert.equal(g.models[0]!.label, 'Opus 5.5')
  assert.deepEqual(g.models.map((m) => m.id), ['claude:opus', 'claude:claude-fable-5-2', 'claude:claude-fable-5', 'claude:sonnet', 'claude:haiku'])
  assert.deepEqual(g.models.map((m) => m.label), ['Opus 5.5', 'Fable 5.2', 'Fable 5', 'Sonnet', 'Haiku'])
  assert.ok(g.models.every((m) => m.efforts))
  const groups = localGroups([
    { name: 'a', machine: 'GPU', hint: '', online: true, tools: true },
    { name: 'b', machine: 'Mac', hint: '', online: false, tools: false },
    { name: 'c', machine: 'GPU', hint: '', online: true, tools: true },
  ])
  assert.deepEqual(groups.map((x) => [x.title, x.online, x.models.length]), [['GPU', true, 2], ['Mac', false, 1]])
  // "Chat only" is per model, not per machine.
  assert.equal(groups[0]!.models[0]!.chatOnly, undefined)
  assert.equal(groups[1]!.models[0]!.chatOnly, true)
})

test('local models get friendly names', () => {
  assert.equal(localLabel('llama3.1-8b'), 'Llama 3.1 8B')
  assert.equal(localLabel('qwen2.5-7b'), 'Qwen 2.5 7B')
  assert.equal(localLabel('llama3.2-3b'), 'Llama 3.2 3B')
  assert.equal(localLabel('mac-llama3.1-8b'), 'Llama 3.1 8B · Mac')
  assert.equal(localLabel('gemma2:9b'), 'Gemma 2 9B')
  assert.equal(localLabel('weird/model@x'), 'weird/model@x')
  assert.equal(localGroups([{ name: 'qwen2.5-7b', machine: 'GPU', hint: '', online: true, tools: true }])[0]!.models[0]!.label, 'Qwen 2.5 7B')
})

test('auto titles are tidied to a few words', () => {
  assert.equal(cleanTitle('"Static Site With Nginx."'), 'Static Site With Nginx')
  assert.equal(cleanTitle('Title: Dinner ideas\nmore'), 'Dinner ideas')
  assert.equal(cleanTitle('one two three four five six seven'), 'one two three four five')
  assert.equal(cleanTitle('  \n'), null)
})

test('fleet events: parse, wake rule, notification kind', () => {
  const lines = [
    '5 2026-11-14T01:00:00Z cc-shop-pack-sizes reported: done: shipped',
    '6 2026-11-14T01:01:00Z cc-recipes-dark-theme reported: needs-decision: which theme?',
    'garbage',
  ]
  const e = parseEventLine(lines[0]!)!
  assert.equal(e.slug, 'cc-shop-pack-sizes')
  assert.equal(eventMarker(e), 'Shop pack sizes · done')
  assert.equal(workerName('cc-notes-app'), 'Notes app')
  assert.deepEqual(eventsToWake(lines, 4, 5).map((x) => x.seq), [6])
  assert.deepEqual(eventsToWake(lines, 6, 0), [])
  const all = eventsToWake(lines, 0, 0)
  assert.equal(noticeKindFor([all[0]!]), 'done')
  assert.equal(noticeKindFor(all), 'needs')
  assert.equal(noticeTitle(all), 'Recipes dark theme needs you (+1)')
  assert.equal(noticeTitle([all[0]!]), 'Shop pack sizes is done')
  assert.equal(parseFleetMode('app\n'), 'app')
  assert.equal(parseFleetMode('lemonade'), 'claude-app')
  assert.equal(parseFleetMode(null), 'claude-app')
})

test('claude args never bypass permissions and resume the session', () => {
  const args = claudeArgs({ model: 'opus', effort: 'high', mode: 'ask', sessionId: 's1', agent: 'assistant', appendSystemPrompt: 'x' })
  assert.ok(!args.join(' ').includes('bypass'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  const at = (f: string) => args[args.indexOf(f) + 1]
  assert.equal(at('--permission-mode'), 'manual')
  assert.equal(at('--resume'), 's1')
  assert.equal(at('--agent'), 'assistant')
  assert.equal(at('--effort'), 'high')
  assert.equal(at('--permission-prompt-tool'), 'stdio')
  assert.ok(!claudeArgs({ model: 'haiku', effort: 'low', mode: 'auto', sessionId: null }).includes('--resume'))
})

test('an Assistant turn on the CLI has no subagent tool; other turns keep it', () => {
  const args = claudeArgs({ model: 'opus', effort: 'high', mode: 'auto', sessionId: null, agent: 'assistant', noSubagents: true })
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Agent,Task')
  assert.ok(!claudeArgs({ model: 'opus', effort: 'high', mode: 'auto', sessionId: null, agent: 'developer' }).includes('--disallowedTools'))
})

test('"don\'t ask again" label comes from the CLI suggestion', () => {
  assert.equal(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }] }]), 'npm run test:*')
  assert.equal(alwaysLabel([{ type: 'addDirectories', directories: ['/tmp/x'] }]), 'files in /tmp/x')
  assert.equal(alwaysLabel(undefined), '')
})

import { draftPrompt, parseDraft } from '../src/domain/toolbox-draft.ts'

test('toolbox drafts: same prompt as Toolbox, forgiving parse', () => {
  const p = draftPrompt({ kind: 'skill', current: 'old', request: 'shorter', id: 'x' })
  assert.match(p.system, /Apply the change and nothing else/)
  assert.match(p.prompt, /Current version:\n<<<\nold\n>>>/)
  assert.match(draftPrompt({ kind: 'agent', request: 'new one' }).system, /something new/)
  assert.deepEqual(parseDraft('Sure! {"id":"My Skill","summary":"s","content":"c"}', 'skill'), { id: 'my-skill', summary: 's', content: 'c' })
  assert.equal(parseDraft('{"content":{"type":"http"}}', 'mcp', 'sb').content, '{\n  "type": "http"\n}')
  assert.throws(() => parseDraft('nope', 'skill'), /usable draft/)
  assert.throws(() => parseDraft('{"id":"x"}', 'skill'), /usable draft/)
})

import { activityLabel } from '../src/domain/chat.ts'
import { endsWithQuestion, questionLine, readNeeds, reaskPrompt } from '../src/domain/inbox.ts'

test('activity labels read like Claude Code', () => {
  assert.equal(activityLabel('Bash', { command: 'cd ~/dev/x && npm test', description: 'Run the tests' }), 'Run the tests')
  assert.equal(activityLabel('Bash', { command: 'i=0; for s in cc-x; do ~/bin/x "$s"; done' }), 'Running a command')
  assert.equal(activityLabel('Bash', { command: 'ls', description: '  ' }), 'Running a command')
  assert.equal(activityLabel('Grep', { pattern: 'activityLabel\\(' }), 'Searching files')
  assert.equal(activityLabel('Glob', { pattern: 'src/**/*.ts' }), 'Finding files')
  assert.equal(activityLabel('Bash', { command: '~/bin/agent-session developer "X" ~/dev p.md' }), 'Starting a worker')
  assert.equal(activityLabel('Bash', { command: '~/bin/agent-session-forget s1' }), 'Stopping a worker')
  assert.equal(activityLabel('Read', { file_path: '/home/h/notes.md' }), 'Reading notes.md')
  assert.equal(activityLabel('Write', { file_path: '/a/app.js' }), 'Editing app.js')
  assert.equal(activityLabel('WebFetch', { url: 'https://preview-48.example.com/x' }), 'Reading preview-48.example.com')
  assert.equal(activityLabel('Skill', { skill: 'catch-up' }), 'Using the catch-up skill')
  assert.match(activityLabel('Bash', { command: 'ls', description: 'x'.repeat(100) }), /…$/)
})

test('bell: questions and [needs you] replies need the user', () => {
  assert.deepEqual(readNeeds('Notes app is done. Merge?'), { text: 'Notes app is done. Merge?', needs: 'question' })
  assert.deepEqual(readNeeds('[needs you] Preview is up: https://x'), { text: 'Preview is up: https://x', needs: 'look' })
  assert.deepEqual(readNeeds('All done, nothing to do.'), { text: 'All done, nothing to do.', needs: null })
  assert.equal(endsWithQuestion('Is this right?\n\nI went ahead.'), false)
  assert.equal(endsWithQuestion('Which one, **A** or **B?**'), true)
  assert.equal(endsWithQuestion('Ok.\n\n```\nwhat?\n```'), false)
  assert.equal(questionLine('**TL;DR:** Done. Preview: [link](https://x). Merge it now?'), 'Merge it now?')
  assert.match(reaskPrompt({ id: 'i', kind: 'question', title: 'Merge?', body: 'Notes is done. Merge?', at: 't' }), /Ask it again now, briefly, with the context/)
})

test('a local model in Claude Code: every model slot is that model, on LiteLLM, nothing phoned home', () => {
  const env = endpointEnv('qwen2.5-7b', { url: 'http://127.0.0.1:4000', key: 'k' })
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k')
  for (const slot of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(env[slot], 'qwen2.5-7b', slot)
  }
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.DISABLE_ERROR_REPORTING, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1')
})

test('local turns: Claude Code for models with tools, a plain chat for chat-only ones', async () => {
  const ran: string[] = []
  const engine = (name: string) => ({ run: async () => (ran.push(name), { text: name, sessionId: null }) })
  const turns = new LocalTurns({ withTools: engine('cli'), chatOnly: engine('chat'), usesTools: async (m) => m !== 'tiny' })
  const req = { prompt: 'hi', history: [], effort: 'low', mode: 'auto', sessionId: null, signal: new AbortController().signal, onEvent: () => {} } as const
  await turns.run({ ...req, model: 'qwen2.5-7b' })
  await turns.run({ ...req, model: 'tiny' })
  assert.deepEqual(ran, ['cli', 'chat'])
})

test('LiteLLM: model_info.tools false marks a model chat only; chat-only models refuse files', async () => {
  const info = { data: [
    { model_name: 'qwen2.5-7b', model_info: { machine: 'GPU' }, litellm_params: {} },
    { model_name: 'tiny', model_info: { machine: 'GPU', tools: false }, litellm_params: {} },
  ] }
  const fake = (async () => new Response(JSON.stringify(info))) as unknown as typeof fetch
  const l = new LiteLlm({ url: 'http://x', fetch: fake })
  assert.equal(await l.usesTools('qwen2.5-7b'), true)
  assert.equal(await l.usesTools('tiny'), false)
  assert.equal(await l.usesTools('unknown'), true)
  const groups = await l.groups()
  assert.deepEqual(groups[0]!.models.map((m) => [m.label, Boolean(m.chatOnly)]), [['Qwen 2.5 7B', false], ['Tiny', true]])
  const r = await l.run({
    prompt: 'hi', history: [], model: 'tiny', effort: 'low', mode: 'auto', sessionId: null, signal: new AbortController().signal, onEvent: () => {},
    attachments: [{ id: 'a', name: 'a.txt', type: 'text/plain', size: 1, path: '/u/a.txt' }],
  })
  assert.match(r.error ?? '', /can't take files/)
})

test('Codex models parse, and each agent runs its own models and local ones', async () => {
  const { turnEngine, agentOfEngine, codexGroup, isAgent } = await import('../src/domain/models.ts')
  assert.deepEqual(parseModelId('codex:gpt-6.1-sol'), { engine: 'codex', name: 'gpt-6.1-sol' })
  assert.equal(parseModelId('codex:gpt-1'), null)
  assert.equal(turnEngine('claude', 'claude'), 'claude')
  assert.equal(turnEngine('claude', 'local'), 'local')
  assert.equal(turnEngine('claude', 'codex'), null)
  assert.equal(turnEngine('codex', 'codex'), 'codex')
  assert.equal(turnEngine('codex', 'local'), 'codexLocal')
  assert.equal(turnEngine('codex', 'claude'), null)
  assert.equal(agentOfEngine('codexLocal'), 'codex')
  assert.equal(agentOfEngine('local'), 'claude')
  assert.ok(isAgent('codex') && !isAgent('gpt'))
  const off = codexGroup({ installed: true, signedIn: false })
  assert.equal(off.title, 'Codex · not signed in')
  assert.equal(off.online, false)
  assert.ok(off.models.every((m) => m.id.startsWith('codex:') && m.efforts))
  assert.equal(codexGroup({ installed: true, signedIn: true }).online, true)
})

test('a handover tells the new agent what was said, newest last, cut to fit', async () => {
  const { handoverPrompt } = await import('../src/domain/chat.ts')
  const m = (role: 'user' | 'assistant' | 'event', text: string) => ({ id: text, at: '', role, source: 'chat' as const, text })
  assert.equal(handoverPrompt([], 'hi', 'Claude Code'), 'hi')
  const p = handoverPrompt([m('user', 'one'), m('event', 'noise'), m('assistant', 'x'.repeat(10)), m('user', 'three')], 'four', 'Claude Code', 2, 5)
  assert.equal(p, [
    "(This conversation was with Claude Code until now; you're taking over. What was said so far:)",
    'Claude Code: xxxxx…',
    'User: three',
    '(End of the conversation so far. The new message:)',
    'four',
  ].join('\n\n'))
})

test("LiteLLM says which Ollama machine and model a local model's name is", async () => {
  const fetch = (async () => new Response(JSON.stringify({ data: [
    { model_name: 'mac-gemma4-26b', litellm_params: { model: 'ollama_chat/gemma4:26b', api_base: 'http://mac:11434' }, model_info: { machine: 'MacBook Pro', probe: 'http://mac:11434', ollama: 'gemma4:26b' } },
    { model_name: 'old', litellm_params: { model: 'ollama_chat/qwen2.5:7b', api_base: 'http://gpu:11434' }, model_info: {} },
  ] }))) as typeof globalThis.fetch
  const l = new LiteLlm({ url: 'http://litellm', fetch })
  assert.deepEqual(await l.ollamaModel('mac-gemma4-26b'), { url: 'http://mac:11434', tag: 'gemma4:26b', machine: 'MacBook Pro' })
  assert.deepEqual(await l.ollamaModel('old'), { url: 'http://gpu:11434', tag: 'qwen2.5:7b', machine: 'this server' })
  assert.equal(await l.ollamaModel('nope'), null)
})

test('dropTags: tags opening any paragraph go; tags in a sentence or in code stay', () => {
  assert.equal(dropTags('Initial update\n\n[quiet] Second update\n\n[quiet] Third update'), 'Initial update\n\nSecond update\n\nThird update')
  assert.equal(dropTags('One\n\n[QUIET] [needs you] Two'), 'One\n\nTwo')
  assert.equal(dropTags('One\n\n[quiet]\nTwo'), 'One\n\nTwo')
  assert.equal(dropTags('Start a reply with [quiet] when\n[quiet] mid-paragraph stays'), 'Start a reply with [quiet] when\n[quiet] mid-paragraph stays')
  assert.equal(dropTags('Example:\n\n```\n[quiet] Routine\n\n[quiet] Done\n```'), 'Example:\n\n```\n[quiet] Routine\n\n[quiet] Done\n```')
  assert.equal(dropTags('> [quiet] quoted'), '> [quiet] quoted')
})

test('replySlot: a running turn\'s reply goes above the messages still waiting, else at the end', () => {
  const m = (id: string) => ({ id, at: '', role: 'user' as const, source: 'chat' as const, text: id })
  assert.equal(replySlot([m('a'), m('b'), m('c')], ['b', 'c']), 1)
  assert.equal(replySlot([m('a')], []), 1)
  assert.equal(replySlot([m('a')], ['gone']), 1)
})

test('after a message he sent into a turn, its reply is the text and steps from the cut on', () => {
  const steps = [{ tool: 'Bash', text: 'ls' }, { tool: 'Read', text: 'a.md' }, { tool: 'Edit', text: 'b.md' }]
  assert.deepEqual(afterCut('Done. Next bit.', steps, { text: 6, steps: 1 }), {
    text: 'Next bit.',
    steps: [{ tool: 'Read', text: 'a.md' }, { tool: 'Edit', text: 'b.md' }],
  })
  assert.deepEqual(afterCut('All of it.', steps, undefined), { text: 'All of it.', steps })
})
