import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexCannot, fromCodexMcp, frontmatter, keysUsed, liftKeys, pairUp, personaFromMarkdown, personaMarkdown, sameMcp, samePersona, stepFor, toCodexMcp,
} from '../src/domain/shared-config.ts'
import { mcpTableString, readCodexAgent, withMcpTable, withoutMcpTable, writeCodexAgent } from '../src/adapters/codex-toml.ts'
import { Bin, ClaudeShelf, CodexShelf } from '../src/adapters/agent-shelves.ts'
import { KeyFile } from '../src/adapters/agent-keys.ts'
import { McpKeys } from '../src/adapters/mcp-keys.ts'
import { SharedConfig } from '../src/app/shared-config.ts'
import { KEPT_UP_TO_DATE, launcherScript, renderSkill, shellWord, shouldWriteSkill } from '../src/domain/bundled-skills.ts'
import { onPath } from '../src/adapters/acp-turns.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'sc3b-test-'))
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url))
const CODEX = onPath('codex')
const hasCodex = CODEX.includes('/') && existsSync(CODEX)

// ---------- domain ----------

test('frontmatter reads plain, quoted, folded and block values', () => {
  const fm = frontmatter('---\nname: "Mi \\"ka\\""\ndescription: You are my\n  executive assistant.\nmodel: opus\nblock: |\n  one\n  two\n---\nbody')
  assert.equal(fm.name, 'Mi "ka"')
  assert.equal(fm.description, 'You are my executive assistant.')
  assert.equal(fm.model, 'opus')
  assert.equal(fm.block, 'one two')
})

test('a persona survives the trip through a Claude agent file', () => {
  const p = { name: 'Sam', description: 'Notes: "short" answers', instructions: 'Line one.\n\nLine two.' }
  const back = personaFromMarkdown('sam', personaMarkdown(p))
  assert.deepEqual(back, p)
  assert.ok(samePersona(p, { ...p, instructions: 'Line one.  \n\nLine two.\n' }))
  assert.ok(!samePersona(p, { ...p, description: 'other' }))
})

test('keys leave the config: env under their own name, a bearer token and other headers under the server', () => {
  const { server, keys } = liftKeys('my-dd', {
    command: 'npx', args: ['dd'], env: { DD_API_KEY: 'abc', SITE: '${SITE}' },
  }, {})
  assert.deepEqual(server.env, { DD_API_KEY: '${DD_API_KEY}', SITE: '${SITE}' })
  assert.deepEqual(keys, { DD_API_KEY: 'abc' })
  const http = liftKeys('obsidian', { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer t0k', 'X-Team': 'blue' } }, {})
  assert.deepEqual(http.server.headers, { Authorization: 'Bearer ${OBSIDIAN_TOKEN}', 'X-Team': '${OBSIDIAN_X_TEAM}' })
  assert.deepEqual(http.keys, { OBSIDIAN_TOKEN: 't0k', OBSIDIAN_X_TEAM: 'blue' })
  // Same value already stored: reused. Another value: a stdio key can't be renamed for Codex, so it says so.
  assert.deepEqual(liftKeys('a', { command: 'x', env: { DD_API_KEY: 'abc' } }, { DD_API_KEY: 'abc' }).keys, { DD_API_KEY: 'abc' })
  assert.throws(() => liftKeys('a', { command: 'x', env: { DD_API_KEY: 'zzz' } }, { DD_API_KEY: 'abc' }), /already set/)
  // A header clash gets a numbered name instead.
  assert.deepEqual(Object.keys(liftKeys('obsidian', { url: 'u', headers: { Authorization: 'Bearer new' } }, { OBSIDIAN_TOKEN: 'old' }).keys), ['OBSIDIAN_TOKEN_2'])
  assert.deepEqual(keysUsed(http.server), ['OBSIDIAN_TOKEN', 'OBSIDIAN_X_TEAM'])
})

test("servers in Codex's shape and back, with keys as environment variable names", () => {
  const stdio = { type: 'stdio' as const, command: 'npx', args: ['-y', 'dd'], env: { DD_API_KEY: '${DD_API_KEY}', SITE: 'us5' } }
  assert.deepEqual(toCodexMcp(stdio), { command: 'npx', args: ['-y', 'dd'], env: { SITE: 'us5' }, env_vars: ['DD_API_KEY'] })
  const http = { type: 'http' as const, url: 'https://gh/mcp', headers: { Authorization: 'Bearer ${GH_TOKEN}', 'X-Org': '${GH_ORG}', 'X-Plain': 'p' }, headersHelper: '/bin/h' }
  assert.deepEqual(toCodexMcp(http), { url: 'https://gh/mcp', bearer_token_env_var: 'GH_TOKEN', http_headers: { 'X-Plain': 'p' }, env_http_headers: { 'X-Org': 'GH_ORG' }, http_headers_helper: '/bin/h' })
  const fromStdio = fromCodexMcp({ transport: { type: 'stdio', command: 'npx', args: ['-y', 'dd'], env: { SITE: 'us5' }, env_vars: ['DD_API_KEY'] } })
  assert.ok(sameMcp(fromStdio, stdio, {}))
  const fromHttp = fromCodexMcp({ transport: { type: 'streamable_http', url: 'https://gh/mcp', bearer_token_env_var: 'GH_TOKEN', http_headers: { 'X-Plain': 'p' }, env_http_headers: { 'X-Org': 'GH_ORG' }, http_headers_helper: '/bin/h' } })
  assert.ok(sameMcp(fromHttp, http, {}))
  // A literal on one side equals a key with that value on the other.
  assert.ok(sameMcp({ url: 'u', headers: { Authorization: 'Bearer t' } }, { type: 'http', url: 'u', headers: { authorization: 'Bearer ${T}' } }, { T: 't' }))
  assert.ok(!sameMcp({ url: 'u', headers: { Authorization: 'Bearer t' } }, { url: 'u', headers: { Authorization: 'Bearer ${T}' } }, { T: 'other' }))
})

test("what Codex can't take is said, not written", () => {
  assert.match(codexCannot({ type: 'sse', url: 'u' })!, /SSE/)
  assert.match(codexCannot({ command: 'x', env: { A: '${B}' } })!, /own name/)
  assert.match(codexCannot({ url: 'u', headers: { 'X-K': 'pre-${K}' } })!, /X-K/)
  assert.equal(codexCannot({ url: 'u', headers: { Authorization: 'Bearer ${K}' } }), null)
  assert.throws(() => toCodexMcp({ type: 'sse', url: 'u' }), /SSE/)
})

test('mirror steps: same, copy to the side without it, choose when they differ, or cannot', () => {
  const same = (a: { description: string }, b: { description: string }) => a.description === b.description
  const it = (id: string, description: string, extra = {}) => ({ id, name: id, description, ...extra })
  const pairs = pairUp([it('a', '1'), it('b', '1'), it('c', '1')], [it('a', '1'), it('b', '2'), it('d', '1'), it('c', '1', { notLoaded: 'md' })])
  assert.deepEqual(pairs.map((p) => p.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(pairs.map((p) => stepFor(p, same)), [
    { action: 'same' },
    { action: 'choose', why: 'They differ' },
    { action: 'copy', from: 'claude' }, // Codex's copy is markdown it doesn't load
    { action: 'copy', from: 'codex' },
  ])
  assert.deepEqual(stepFor({ id: 'p', claude: it('p', '1') }, same, () => 'plugin'), { action: 'cannot', why: 'plugin' })
})

// ---------- Codex's TOML ----------

const CONFIG = `# Codex settings for this box.
check_for_update_on_startup = false

[analytics]
enabled = false

[mcp_servers.dd]
command = "old"

[mcp_servers.dd.env]
A = "1"

[mcp_servers."other one"]
url = "https://o"
`

test('one [mcp_servers.<id>] table is replaced and everything else stays', () => {
  const out = withMcpTable(CONFIG, 'dd', { command: 'npx', args: ['-y', 'dd'], env_vars: ['DD_API_KEY'] })
  assert.match(out, /^# Codex settings for this box\.\ncheck_for_update_on_startup = false\n\n\[analytics\]\nenabled = false\n/)
  assert.ok(!out.includes('command = "old"') && !out.includes('A = "1"'))
  assert.ok(out.includes('[mcp_servers."other one"]\nurl = "https://o"'))
  assert.ok(out.endsWith('[mcp_servers.dd]\ncommand = "npx"\nargs = ["-y", "dd"]\nenv_vars = ["DD_API_KEY"]\n'))
  assert.equal(withoutMcpTable(out, 'other one').includes('other one'), false)
  assert.equal(withMcpTable('', 'x', { url: 'u' }), '[mcp_servers.x]\nurl = "u"\n')
  assert.equal(mcpTableString(withMcpTable(CONFIG, 'sb', { url: 'u', http_headers_helper: '/bin/h' }), 'sb', 'http_headers_helper'), '/bin/h')
  assert.equal(mcpTableString(CONFIG, 'other one', 'url'), 'https://o')
})

test('a Codex agent file: read its three fields, rewrite them, keep its other settings', () => {
  const old = `# mine\nname = "Reviewer"\nmodel = "gpt-6-luna"\ndescription = 'Reviews "PRs"'\ndeveloper_instructions = """\nBe kind.\n\\tTabbed.\n"""\nnickname_candidates = [\n  "Rev",\n]\n\n[features]\nweb = false\n`
  assert.deepEqual(readCodexAgent(old), { name: 'Reviewer', description: 'Reviews "PRs"', instructions: 'Be kind.\n\tTabbed.\n' })
  const out = writeCodexAgent(old, { name: 'Reviewer', description: 'New "desc"', instructions: "Line with ''' quotes\nand more" })
  assert.deepEqual(readCodexAgent(out), { name: 'Reviewer', description: 'New "desc"', instructions: "Line with ''' quotes\nand more\n" })
  assert.ok(out.includes('model = "gpt-6-luna"') && out.includes('nickname_candidates = [\n  "Rev",\n]') && out.includes('[features]\nweb = false') && out.includes('# mine'))
  const fresh = writeCodexAgent('', { name: 'Sam', description: 'd', instructions: "It's multi\nline" })
  assert.equal(fresh, `name = "Sam"\ndescription = "d"\ndeveloper_instructions = '''\nIt's multi\nline\n'''\n`)
  assert.deepEqual(readCodexAgent(fresh), { name: 'Sam', description: 'd', instructions: "It's multi\nline\n" })
})

// ---------- the key store ----------

test('MCP keys: kept in the secret store (a private file here), names remembered, back after a restart', async () => {
  const dir = tmp()
  const open = () => new McpKeys({ store: new KeyFile(join(dir, 'mcp-keys.json')), namesFile: join(dir, 'names.json') }).load()
  const store = await open()
  await store.set('DD_API_KEY', 'abc')
  assert.equal(statSync(join(dir, 'mcp-keys.json')).mode & 0o777, 0o600)
  assert.ok(!readFileSync(join(dir, 'names.json'), 'utf8').includes('abc'))
  assert.deepEqual((await open()).values(), { DD_API_KEY: 'abc' })
  await assert.rejects(store.set('bad name', 'x'), /capital letters/)
  await store.remove('DD_API_KEY')
  assert.deepEqual((await open()).values(), {})
})

// ---------- both agents on throwaway homes ----------

function fakeHome() {
  const home = tmp()
  const w = (p: string, text: string) => {
    mkdirSync(join(home, p, '..'), { recursive: true })
    writeFileSync(join(home, p), text)
  }
  w('.claude/skills/only-claude/SKILL.md', '---\nname: only-claude\ndescription: from Claude\n---\nC')
  w('.claude/skills/both-same/SKILL.md', '---\nname: both-same\ndescription: same\n---\nS')
  w('.agents/skills/both-same/SKILL.md', '---\nname: both-same\ndescription: same\n---\nS')
  w('.claude/skills/both-differ/SKILL.md', '---\nname: both-differ\ndescription: Claude version\n---\nC')
  w('.agents/skills/both-differ/SKILL.md', '---\nname: both-differ\ndescription: Codex version\n---\nX')
  w('.agents/skills/only-codex/SKILL.md', '---\nname: only-codex\ndescription: from Codex\n---\nX')
  w('.agents/skills/only-codex/refs/extra.md', 'more')
  // Already shared by a link: one skill.
  w('.agents/skills/linked/SKILL.md', '---\nname: linked\ndescription: shared\n---\nL')
  symlinkSync(join(home, '.agents/skills/linked'), join(home, '.claude/skills/linked'))
  w('.claude/agents/dev.md', '---\nname: dev\ndescription: Builds things\ntools: Read, Edit\n---\n\nYou build.')
  w('.codex/agents/reviewer.toml', 'name = "reviewer"\ndescription = "Reviews"\ndeveloper_instructions = """\nYou review.\n"""\n')
  w('.agents/agents/mikayla.md', '---\nname: Mikayla\ndescription: Assistant\nrafiki:\n  id: x\n---\n\nYou assist.')
  symlinkSync(join(home, '.agents/agents/mikayla.md'), join(home, '.codex/agents/mikayla.md'))
  w('.claude.json', JSON.stringify({ numStartups: 3, mcpServers: { obsidian: { type: 'http', url: 'http://127.0.0.1:27123/mcp/', headers: { Authorization: 'Bearer s3cret' } }, sb: { type: 'http', url: 'http://127.0.0.1:3847/mcp', headersHelper: '/bin/sb-header' } } }))
  w('.codex/config.toml', '# keep me\n[analytics]\nenabled = false\n\n[mcp_servers.dd]\ncommand = "npx"\nargs = ["-y", "dd"]\nenv_vars = ["DD_API_KEY"]\n')
  return home
}

async function both(home: string, codexBin = CODEX) {
  const trash = new Bin(join(home, 'limeade-bin'))
  const keys = await new McpKeys({ store: new KeyFile(join(home, 'mcp-keys.json')), namesFile: join(home, 'mcp-key-names.json') }).load()
  const sc = new SharedConfig({
    claude: new ClaudeShelf({ home, bin: FAKE_CLAUDE, trash }),
    codex: new CodexShelf({ home, bin: codexBin, trash }),
    keys,
  })
  return { sc, keys }
}

test('the lists show who has what, and plugin items stay read-only', { skip: !hasCodex && 'Codex CLI not installed' }, async () => {
  const home = fakeHome()
  const pluginRoot = join(home, 'plug')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'egm' }))
  mkdirSync(join(pluginRoot, 'skills/draft'), { recursive: true })
  writeFileSync(join(pluginRoot, 'skills/draft/SKILL.md'), '---\nname: egm-draft\ndescription: Drafts\n---\nD')
  mkdirSync(join(home, '.claude/plugins'), { recursive: true })
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'egm@egm': [{ scope: 'user', installPath: pluginRoot }] } }))
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'egm@egm': true } }))
  const { sc } = await both(home)
  const items = await sc.items()
  const tag = (l: any[]) => Object.fromEntries(l.map((i) => [i.id, i.has + (i.differs ? '≠' : '') + (i.readOnly ? ' ro' : '')]))
  assert.deepEqual(tag(items.skill), { 'both-differ': 'both≠', 'both-same': 'both', linked: 'both', 'only-claude': 'claude', 'only-codex': 'codex', 'egm:egm-draft': 'claude ro' })
  assert.deepEqual(tag(items.agent), { dev: 'claude', mikayla: 'codex', reviewer: 'codex' })
  assert.deepEqual(tag(items.mcp), { dd: 'codex', obsidian: 'claude', sb: 'claude' })
  const read = await sc.read('mcp', 'dd')
  assert.deepEqual(read.keys, [{ name: 'DD_API_KEY', set: false }])
  // A key still written in a config never shows; saving puts it back and moves it to the key store.
  const obs = await sc.read('mcp', 'obsidian')
  assert.ok(!obs.content.includes('s3cret'))
  assert.deepEqual(JSON.parse(obs.content).headers, { Authorization: '<hidden>' })
  assert.deepEqual(obs.inConfig, ['Authorization header'])
  await sc.save('mcp', 'obsidian', obs.content.replace('127.0.0.1', 'localhost'))
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.obsidian.headers, { Authorization: 'Bearer ${OBSIDIAN_TOKEN}' })
  await assert.rejects(sc.save('mcp', 'brand-new', JSON.stringify({ url: 'u', headers: { A: '<hidden>' } }), true), /No saved value/)
  // Plugin items aren't mirrored.
  assert.ok(!(await sc.plan()).some((x) => x.id.includes(':')))
  await assert.rejects(sc.save('skill', 'egm:egm-draft', 'x'), /plugin/)
})

test('mirroring: copies across, links skills, lifts keys out, asks about what differs', { skip: !hasCodex && 'Codex CLI not installed' }, async () => {
  const home = fakeHome()
  const { sc, keys } = await both(home)
  const plan = await sc.plan()
  const steps = Object.fromEntries(plan.map((s) => [`${s.kind}:${s.id}`, s.step.action === 'copy' ? `copy from ${s.step.from}` : s.step.action]))
  assert.deepEqual(steps, {
    'skill:both-differ': 'choose', 'skill:both-same': 'same', 'skill:linked': 'same', 'skill:only-claude': 'copy from claude', 'skill:only-codex': 'copy from codex',
    'agent:dev': 'copy from claude', 'agent:mikayla': 'copy from codex', 'agent:reviewer': 'copy from codex',
    'mcp:dd': 'copy from codex', 'mcp:obsidian': 'copy from claude', 'mcp:sb': 'copy from claude',
  })
  assert.deepEqual(plan.find((s) => s.id === 'obsidian')!.keys, ['OBSIDIAN_TOKEN'])

  // Planning wrote nothing.
  assert.ok(!existsSync(join(home, '.agents/skills/only-claude')))
  assert.ok(!existsSync(join(home, 'mcp-keys.json')))

  const res = await sc.mirror({ 'skill:both-differ': 'codex', 'mcp:sb': 'skip' })
  assert.deepEqual(res.failed, [])
  assert.equal(res.done.length, 8)
  assert.ok(!readFileSync(join(home, '.codex/config.toml'), 'utf8').includes('mcp_servers.sb'), 'skipped')

  // Skills: links to the one real folder, both ways; the losing copy is in the bin.
  assert.equal(readlinkSync(join(home, '.agents/skills/only-claude')), join(home, '.claude/skills/only-claude'))
  assert.equal(readlinkSync(join(home, '.claude/skills/only-codex')), join(home, '.agents/skills/only-codex'))
  assert.equal(readlinkSync(join(home, '.claude/skills/both-differ')), join(home, '.agents/skills/both-differ'))
  assert.ok(readdirSync(join(home, 'limeade-bin')).some((f) => f.endsWith('claude-skill-both-differ')))

  // Agents: native in both.
  assert.deepEqual(readCodexAgent(readFileSync(join(home, '.codex/agents/dev.toml'), 'utf8')), { name: 'dev', description: 'Builds things', instructions: 'You build.\n' })
  assert.deepEqual(personaFromMarkdown('reviewer', readFileSync(join(home, '.claude/agents/reviewer.md'), 'utf8')), { name: 'reviewer', description: 'Reviews', instructions: 'You review.' })
  assert.equal(readCodexAgent(readFileSync(join(home, '.codex/agents/mikayla.toml'), 'utf8')).instructions, 'You assist.\n')
  assert.ok(existsSync(join(home, '.claude/agents/mikayla.md')))
  assert.ok(lstatSync(join(home, '.codex/agents/mikayla.md')).isSymbolicLink(), "the other app's file is left alone")

  // MCP: the copy refers to the key store; the config it came from is left exactly as it was, so Claude
  // started outside Limeade keeps working.
  assert.deepEqual(keys.values(), { OBSIDIAN_TOKEN: 's3cret' })
  const claudeJson = readFileSync(join(home, '.claude.json'), 'utf8')
  const codexToml = readFileSync(join(home, '.codex/config.toml'), 'utf8')
  assert.ok(!codexToml.includes('s3cret'))
  assert.equal(JSON.parse(claudeJson).numStartups, 3)
  assert.deepEqual(JSON.parse(claudeJson).mcpServers.obsidian.headers, { Authorization: 'Bearer s3cret' })
  assert.deepEqual(JSON.parse(claudeJson).mcpServers.dd, { type: 'stdio', command: 'npx', args: ['-y', 'dd'], env: { DD_API_KEY: '${DD_API_KEY}' } })
  assert.ok(codexToml.startsWith('# keep me\n[analytics]\nenabled = false\n'))
  assert.ok(codexToml.includes('bearer_token_env_var = "OBSIDIAN_TOKEN"'))

  // Afterwards the two agree on everything but what was skipped.
  assert.deepEqual((await sc.plan()).filter((s) => s.step.action !== 'same').map((s) => s.id), ['sb'])
  const items = await sc.items()
  assert.ok([...items.skill, ...items.agent, ...items.mcp].every((i) => (i.has === 'both' && !i.differs) || i.id === 'sb'))
})

test('saving and deleting change both agents', { skip: !hasCodex && 'Codex CLI not installed' }, async () => {
  const home = fakeHome()
  const { sc, keys } = await both(home)
  // A new skill lives in the shared folder; Claude links to it.
  await sc.save('skill', 'fresh', '---\nname: fresh\ndescription: New\n---\nF', true)
  assert.ok(statSync(join(home, '.agents/skills/fresh')).isDirectory() && !lstatSync(join(home, '.agents/skills/fresh')).isSymbolicLink())
  assert.equal(readlinkSync(join(home, '.claude/skills/fresh')), join(home, '.agents/skills/fresh'))
  await assert.rejects(sc.save('skill', 'fresh', '---\nname: fresh\ndescription: New\n---\nF', true), /already/)
  // Two copies: both written.
  await sc.save('skill', 'both-same', '---\nname: both-same\ndescription: edited\n---\nE')
  assert.match(readFileSync(join(home, '.claude/skills/both-same/SKILL.md'), 'utf8'), /edited/)
  assert.match(readFileSync(join(home, '.agents/skills/both-same/SKILL.md'), 'utf8'), /edited/)

  await sc.save('agent', 'helper', '---\nname: helper\ndescription: Helps\nmodel: opus\n---\n\nHelp.', true)
  assert.match(readFileSync(join(home, '.claude/agents/helper.md'), 'utf8'), /model: opus/)
  assert.equal(readCodexAgent(readFileSync(join(home, '.codex/agents/helper.toml'), 'utf8')).description, 'Helps')

  // A pasted key goes to the store; the configs get a reference.
  const r = await sc.save('mcp', 'gh', JSON.stringify({ type: 'http', url: 'https://api.github.example/mcp', headers: { Authorization: 'Bearer ghp_x' } }), true)
  assert.deepEqual(r, {})
  assert.deepEqual(keys.values(), { GH_TOKEN: 'ghp_x' })
  assert.ok(readFileSync(join(home, '.codex/config.toml'), 'utf8').includes('[mcp_servers.gh]\nurl = "https://api.github.example/mcp"\nbearer_token_env_var = "GH_TOKEN"'))
  await assert.rejects(sc.save('mcp', 'x', '{"command":"a","env":{"K":"PASTE-HERE"}}', true), /PASTE-HERE/)
  // SSE: Claude only, and it says so.
  assert.match((await sc.save('mcp', 'old-sse', JSON.stringify({ type: 'sse', url: 'https://s' }), true)).note!, /Claude Code only.*SSE/)
  // Claude refusing leaves Codex untouched.
  await assert.rejects(sc.save('mcp', 'nope', JSON.stringify({ type: 'http', url: 'https://refuse.example' }), true), /didn't take it/)

  await sc.remove('skill', 'fresh')
  assert.ok(!existsSync(join(home, '.agents/skills/fresh')) && !lstatSync(join(home, '.claude/skills/fresh'), { throwIfNoEntry: false }))
  await sc.remove('agent', 'helper')
  assert.ok(!existsSync(join(home, '.claude/agents/helper.md')) && !existsSync(join(home, '.codex/agents/helper.toml')))
  await sc.remove('mcp', 'gh')
  assert.ok(!readFileSync(join(home, '.codex/config.toml'), 'utf8').includes('mcp_servers.gh'))
  assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.gh, undefined)
  assert.ok(readdirSync(join(home, 'limeade-bin')).length > 0)
})

test('without Codex installed nothing is planned and Codex servers are not read', async () => {
  const home = fakeHome()
  const { sc } = await both(home, join(home, 'no-codex'))
  assert.deepEqual(await sc.plan(), [])
  assert.deepEqual((await sc.items()).mcp.map((i) => i.id), ['obsidian', 'sb'])
  assert.deepEqual(sc.installed(), { claude: true, codex: false })
})

test('a fresh install gets the default Assistant in every installed agent; one that is there is never replaced', async () => {
  const markdown = readFileSync(new URL('../defaults/assistant.md', import.meta.url), 'utf8')
  const home = fakeHome()
  const { sc } = await both(home, join(home, 'no-codex'))
  assert.equal(await sc.instructions('assistant'), null)
  assert.deepEqual(await sc.installDefault('assistant', markdown), ['claude'])
  assert.equal(readFileSync(join(home, '.claude/agents/assistant.md'), 'utf8'), markdown)
  assert.match((await sc.instructions('assistant'))!, /^You are the user's assistant/)
  // Already there: nothing is written again, even after it was changed.
  writeFileSync(join(home, '.claude/agents/assistant.md'), '---\nname: assistant\ndescription: mine\n---\n\nMy own rules.')
  assert.deepEqual(await sc.installDefault('assistant', markdown), [])
  assert.equal(await sc.instructions('assistant'), 'My own rules.')
  // Codex's own copy wins for Codex turns once it has one.
  mkdirSync(join(home, '.codex/agents'), { recursive: true })
  writeFileSync(join(home, '.codex/agents/assistant.toml'), 'name = "assistant"\ndescription = "x"\ndeveloper_instructions = """\nCodex rules.\n"""\n')
  assert.equal((await sc.instructions('assistant'))!.trim(), 'Codex rules.')
})

test('the default Assistant is generic: nothing about one person, box or homelab', () => {
  const text = readFileSync(new URL('../defaults/assistant.md', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /homelab|fleet|agent-session|\d+\.\d+\.\d+\.\d+|\.com\b/i)
  const p = personaFromMarkdown('assistant', text)
  assert.equal(p.name, 'assistant')
  assert.ok(p.description && p.instructions.length < 4000)
})

test('a bundled skill is added to both agents, kept up to date, and left alone once the user makes it theirs', async () => {
  const shipped = renderSkill(readFileSync(new URL('../defaults/skills/limeade-monitors/SKILL.md', import.meta.url), 'utf8'), '~/.config/limeade/bin/limeade')
  const home = fakeHome()
  const { sc } = await both(home, join(home, 'no-codex'))
  assert.equal(await sc.installSkill('limeade-monitors', shipped), true)
  const shared = join(home, '.agents/skills/limeade-monitors/SKILL.md')
  assert.equal(readFileSync(shared, 'utf8'), shipped)
  assert.equal(readFileSync(join(home, '.claude/skills/limeade-monitors/SKILL.md'), 'utf8'), shipped)
  // Same again: nothing written.
  assert.equal(await sc.installSkill('limeade-monitors', shipped), false)
  // A newer Limeade: brought up to date.
  const newer = shipped.replace('# Limeade monitors', '# Limeade monitors (newer)')
  assert.equal(await sc.installSkill('limeade-monitors', newer), true)
  assert.equal(readFileSync(shared, 'utf8'), newer)
  // The user's own version (Limeade's line taken out): never replaced.
  const mine = newer.replace(/^<!-- Limeade keeps.*\n/m, '') + '\nMy note.\n'
  writeFileSync(shared, mine)
  assert.equal(await sc.installSkill('limeade-monitors', shipped), false)
  assert.equal(readFileSync(shared, 'utf8'), mine)
})

test('the bundled skills are generic and fill in the command', () => {
  const dir = new URL('../defaults/skills/', import.meta.url)
  for (const id of readdirSync(dir)) {
    const text = readFileSync(new URL(`${id}/SKILL.md`, dir), 'utf8')
    assert.doesNotMatch(text, /homelab|\d+\.\d+\.\d+\.\d+|\.com\b|\/home\/|\/Users\//i)
    const fm = frontmatter(text)
    assert.equal(fm.name, id)
    assert.ok(fm.description && text.includes(KEPT_UP_TO_DATE))
    assert.doesNotMatch(renderSkill(text, 'L'), /\{\{/)
  }
})

test('the launcher runs this install’s CLI with its hub, and quotes paths with spaces', () => {
  const s = launcherScript({ node: '/opt/node/bin/node', cli: '/My Apps/limeade/bin/limeade.mjs', hub: 'http://127.0.0.1:8797', configDir: '/h/.config/limeade' })
  assert.match(s, /^#!\/bin\/sh\n/)
  assert.match(s, /LIMEADE_HUB=http:\/\/127\.0\.0\.1:8797 LIMEADE_CONFIG=\/h\/\.config\/limeade/)
  assert.match(s, /exec \/opt\/node\/bin\/node '\/My Apps\/limeade\/bin\/limeade\.mjs' "\$@"/)
  assert.equal(shellWord("it's"), `'it'\\''s'`)
  assert.ok(shouldWriteSkill(null, 'x'))
})
