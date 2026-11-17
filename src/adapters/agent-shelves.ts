// Claude Code's and Codex's own config files: their skills, agents and MCP servers.
// Claude Code: ~/.claude/skills/<id>/SKILL.md, ~/.claude/agents/<id>.md (plus read-only ones from enabled
// plugins), MCP servers in ~/.claude.json, changed through the `claude mcp` CLI because running sessions
// write that file too.
// Codex: skills in ~/.agents/skills (the shared folder; Codex also still reads ~/.codex/skills),
// agents in ~/.codex/agents/<id>.toml, MCP servers in ~/.codex/config.toml (read through `codex mcp`,
// written here and read back by Codex before the change counts).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { codexAgentName, frontmatter, fromCodexMcp, personaFromMarkdown, personaMarkdown, toCodexMcp, validId, type McpServer, type Persona, type Side } from '../domain/shared-config.ts'
import type { AgentShelf, FoundAgent, FoundSkill } from '../ports.ts'
import { mcpTableString, readCodexAgent, withMcpTable, withoutMcpTable, writeCodexAgent } from './codex-toml.ts'

const run = promisify(execFile)
const QUIET = { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_ERROR_REPORTING: '1', NO_COLOR: '1' }

function checkId(id: string) {
  if (!validId(id)) throw new Error('A name is letters, numbers, dots and dashes')
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/** Limeade's bin: everything removed or replaced goes here, never deleted. */
export class Bin {
  private dir: string
  constructor(dir: string) {
    this.dir = dir
  }
  async put(p: string, label: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await fs.rename(p, path.join(this.dir, `${stamp()}-${label}`)).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      await fs.cp(p, path.join(this.dir, `${stamp()}-${label}`), { recursive: true, verbatimSymlinks: true })
      await fs.rm(p, { recursive: true })
    })
  }
  async keep(label: string, text: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(this.dir, `${stamp()}-${label}`), text, { mode: 0o600 })
  }
}

/** A folder's contents as one hash (paths and bytes), following links. */
export async function hashFolder(dir: string): Promise<string> {
  const h = createHash('sha256')
  async function walk(d: string, rel: string) {
    for (const name of (await fs.readdir(d)).sort()) {
      const p = path.join(d, name)
      const st = await fs.stat(p).catch(() => null)
      if (!st) continue
      if (st.isDirectory()) await walk(p, `${rel}${name}/`)
      else if (st.isFile()) h.update(`${rel}${name}\0`).update(await fs.readFile(p)).update('\0')
    }
  }
  await walk(dir, '')
  return h.digest('hex')
}

async function readSkillDir(id: string, dir: string): Promise<FoundSkill | null> {
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null)
  if (text == null) return null // not a skill (e.g. a sync folder)
  const fm = frontmatter(text)
  const realPath = await fs.realpath(dir)
  return { id, name: fm.name || id, description: fm.description || '', realPath, hash: await hashFolder(realPath) }
}

async function skillsIn(root: string): Promise<FoundSkill[]> {
  const out: FoundSkill[] = []
  for (const id of await fs.readdir(root).catch(() => [] as string[])) {
    if (id.startsWith('.') || !validId(id)) continue
    const s = await readSkillDir(id, path.join(root, id))
    if (s) out.push(s)
  }
  return out
}

/** A link or folder at `entry` goes; a link's real folder goes to the bin first (it's that skill's content). */
async function removeEntry(entry: string, bin: Bin, label: string): Promise<void> {
  const st = await fs.lstat(entry).catch(() => null)
  if (!st) return
  if (st.isSymbolicLink()) {
    const real = await fs.realpath(entry).catch(() => null)
    if (real) await bin.put(real, label)
    await fs.unlink(entry)
  } else await bin.put(entry, label)
}

/** `entry` becomes a link to `target`; whatever was there goes to the bin (unless it already is that). */
async function linkTo(entry: string, target: string, bin: Bin, label: string): Promise<void> {
  const st = await fs.lstat(entry).catch(() => null)
  if (st) {
    if ((await fs.realpath(entry).catch(() => null)) === (await fs.realpath(target))) return
    if (st.isSymbolicLink()) await fs.unlink(entry)
    else await bin.put(entry, label)
  }
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.symlink(target, entry)
}

async function writeText(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Through a link, the real file changes (fs.writeFile follows links).
  await fs.writeFile(file, text.endsWith('\n') ? text : text + '\n')
}

// ---------- Claude Code ----------

export interface ClaudeShelfOptions {
  home: string
  /** The Claude Code CLI (an absolute path), for MCP changes. */
  bin: string
  trash: Bin
  env?: NodeJS.ProcessEnv
}

export class ClaudeShelf implements AgentShelf {
  readonly side: Side = 'claude'
  private dir: string
  private o: ClaudeShelfOptions
  constructor(o: ClaudeShelfOptions) {
    this.o = o
    this.dir = path.join(o.home, '.claude')
  }

  installed(): boolean {
    return this.o.bin.includes('/') && existsSync(this.o.bin)
  }

  private skillsDir() {
    return path.join(this.dir, 'skills')
  }

  async skills(): Promise<FoundSkill[]> {
    const own = await skillsIn(this.skillsDir())
    const plugins = (await this.plugins()).skills
    return [...own, ...plugins]
  }

  async readSkill(id: string): Promise<string> {
    const plugin = (await this.plugins()).skills.find((s) => s.id === id)
    if (plugin) return fs.readFile(path.join(plugin.realPath, 'SKILL.md'), 'utf8')
    checkId(id)
    return fs.readFile(path.join(this.skillsDir(), id, 'SKILL.md'), 'utf8')
  }

  async writeSkill(id: string, content: string): Promise<void> {
    checkId(id)
    const file = path.join(this.skillsDir(), id, 'SKILL.md')
    if (existsSync(file)) await this.o.trash.keep(`skill-${id}-SKILL.md`, await fs.readFile(file, 'utf8'))
    await writeText(file, content)
  }

  async linkSkill(id: string, realPath: string): Promise<void> {
    checkId(id)
    await linkTo(path.join(this.skillsDir(), id), realPath, this.o.trash, `claude-skill-${id}`)
  }

  async removeSkill(id: string): Promise<void> {
    checkId(id)
    await removeEntry(path.join(this.skillsDir(), id), this.o.trash, `claude-skill-${id}`)
  }

  async agents(): Promise<FoundAgent[]> {
    const out: FoundAgent[] = []
    const root = path.join(this.dir, 'agents')
    for (const file of await fs.readdir(root).catch(() => [] as string[])) {
      if (!file.endsWith('.md')) continue
      const id = file.slice(0, -3)
      if (!validId(id)) continue
      const markdown = await fs.readFile(path.join(root, file), 'utf8').catch(() => null)
      if (markdown == null) continue
      const persona = personaFromMarkdown(id, markdown)
      out.push({ id, name: persona.name, description: persona.description, persona, markdown })
    }
    return [...out, ...(await this.plugins()).agents]
  }

  async writeAgent(id: string, persona: Persona, markdown?: string): Promise<void> {
    checkId(id)
    const file = path.join(this.dir, 'agents', `${id}.md`)
    if (existsSync(file)) await this.o.trash.keep(`claude-agent-${id}.md`, await fs.readFile(file, 'utf8'))
    await writeText(file, markdown ?? personaMarkdown(persona))
  }

  async removeAgent(id: string): Promise<void> {
    checkId(id)
    const file = path.join(this.dir, 'agents', `${id}.md`)
    if (existsSync(file)) await this.o.trash.put(file, `claude-agent-${id}.md`)
  }

  async mcps(): Promise<Record<string, McpServer>> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.o.home, '.claude.json'), 'utf8')).mcpServers ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw err
    }
  }

  private cli(args: string[]) {
    return run(this.o.bin, args, { env: { ...(this.o.env ?? process.env), HOME: this.o.home, ...QUIET }, cwd: this.o.home, timeout: 60_000 })
  }

  async writeMcp(id: string, server: McpServer): Promise<void> {
    checkId(id)
    const old = (await this.mcps())[id]
    if (old) {
      await this.o.trash.keep(`claude-mcp-${id}.json`, JSON.stringify(old, null, 2))
      await this.cli(['mcp', 'remove', '-s', 'user', id])
    }
    try {
      await this.cli(['mcp', 'add-json', '-s', 'user', id, JSON.stringify(server)])
    } catch (err) {
      if (old) await this.cli(['mcp', 'add-json', '-s', 'user', id, JSON.stringify(old)]).catch(() => {})
      throw new Error(`Claude Code didn't take it: ${String((err as any).stderr ?? (err as Error).message).trim()}`)
    }
  }

  async removeMcp(id: string): Promise<void> {
    checkId(id)
    const old = (await this.mcps())[id]
    if (!old) return
    await this.o.trash.keep(`claude-mcp-${id}.json`, JSON.stringify(old, null, 2))
    await this.cli(['mcp', 'remove', '-s', 'user', id])
  }

  /** Skills and agents from enabled plugins, named <plugin>:<name> the way Claude Code names them. */
  private async plugins(): Promise<{ skills: FoundSkill[]; agents: FoundAgent[] }> {
    const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8'))
    const installed = (await readJson(path.join(this.dir, 'plugins', 'installed_plugins.json')).catch(() => ({}))).plugins ?? {}
    const enabled = (await readJson(path.join(this.dir, 'settings.json')).catch(() => ({}))).enabledPlugins ?? {}
    const out = { skills: [] as FoundSkill[], agents: [] as FoundAgent[] }
    const asList = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v : [String(v)])
    for (const [key, installs] of Object.entries<any[]>(installed)) {
      if (enabled[key] !== true) continue
      const root = installs.find((i) => i.scope === 'user')?.installPath ?? installs[0]?.installPath
      if (!root) continue
      const manifest = await readJson(path.join(root, '.claude-plugin', 'plugin.json')).catch(() => ({}))
      const plugin: string = manifest.name || key.split('@')[0]
      for (const rel of asList(manifest.skills).length ? asList(manifest.skills) : ['skills']) {
        const p = path.resolve(root, rel)
        if (p !== root && !p.startsWith(root + path.sep)) continue
        const dirs = existsSync(path.join(p, 'SKILL.md')) ? [p] : (await fs.readdir(p).catch(() => [] as string[])).sort().map((n) => path.join(p, n))
        for (const d of dirs) {
          const s = await readSkillDir(path.basename(d), d)
          if (s) out.skills.push({ ...s, id: `${plugin}:${s.name}`, name: `${plugin}:${s.name}`, plugin })
        }
      }
      for (const rel of asList(manifest.agents).length ? asList(manifest.agents) : ['agents']) {
        const p = path.resolve(root, rel)
        if (p !== root && !p.startsWith(root + path.sep)) continue
        const st = await fs.stat(p).catch(() => null)
        if (!st) continue
        const files = st.isFile() ? [p] : (await fs.readdir(p)).sort().filter((f) => f.endsWith('.md')).map((f) => path.join(p, f))
        for (const f of files) {
          const markdown = await fs.readFile(f, 'utf8').catch(() => null)
          if (markdown == null) continue
          const persona = personaFromMarkdown(path.basename(f, '.md'), markdown)
          const id = `${plugin}:${persona.name}`
          out.agents.push({ id, name: id, description: persona.description, persona, markdown, plugin })
        }
      }
    }
    return out
  }
}

// ---------- Codex ----------

export interface CodexShelfOptions {
  home: string
  /** CODEX_HOME (default ~/.codex). */
  codexHome?: string
  /** The Codex CLI (an absolute path), to read MCP servers the way Codex does. */
  bin: string
  trash: Bin
  env?: NodeJS.ProcessEnv
}

export class CodexShelf implements AgentShelf {
  readonly side: Side = 'codex'
  private codexHome: string
  private shared: string
  private o: CodexShelfOptions
  constructor(o: CodexShelfOptions) {
    this.o = o
    this.codexHome = o.codexHome ?? path.join(o.home, '.codex')
    this.shared = path.join(o.home, '.agents', 'skills')
  }

  installed(): boolean {
    return this.o.bin.includes('/') && existsSync(this.o.bin)
  }

  /** Where Codex finds a skill: the shared folder first, then its own older one. */
  private entries(id: string): string[] {
    return [path.join(this.shared, id), path.join(this.codexHome, 'skills', id)]
  }

  async skills(): Promise<FoundSkill[]> {
    const seen = new Map<string, FoundSkill>()
    for (const s of [...(await skillsIn(this.shared)), ...(await skillsIn(path.join(this.codexHome, 'skills')))]) {
      if (!seen.has(s.id)) seen.set(s.id, s)
    }
    return [...seen.values()]
  }

  private async entry(id: string): Promise<string | null> {
    for (const e of this.entries(id)) if (existsSync(path.join(e, 'SKILL.md'))) return e
    return null
  }

  async readSkill(id: string): Promise<string> {
    checkId(id)
    const e = await this.entry(id)
    if (!e) throw new Error('No such skill')
    return fs.readFile(path.join(e, 'SKILL.md'), 'utf8')
  }

  async writeSkill(id: string, content: string): Promise<void> {
    checkId(id)
    const e = (await this.entry(id)) ?? path.join(this.shared, id)
    const file = path.join(e, 'SKILL.md')
    if (existsSync(file)) await this.o.trash.keep(`skill-${id}-SKILL.md`, await fs.readFile(file, 'utf8'))
    await writeText(file, content)
  }

  async linkSkill(id: string, realPath: string): Promise<void> {
    checkId(id)
    // Both places Codex looks get the link, so an older copy can't shadow the shared one.
    await linkTo(path.join(this.shared, id), realPath, this.o.trash, `codex-skill-${id}`)
    const legacy = path.join(this.codexHome, 'skills', id)
    if (await fs.lstat(legacy).catch(() => null)) await linkTo(legacy, realPath, this.o.trash, `codex-old-skill-${id}`)
  }

  async removeSkill(id: string): Promise<void> {
    checkId(id)
    for (const e of this.entries(id)) await removeEntry(e, this.o.trash, `codex-skill-${id}`)
  }

  private agentsDir() {
    return path.join(this.codexHome, 'agents')
  }

  async agents(): Promise<FoundAgent[]> {
    const out = new Map<string, FoundAgent>()
    const files = (await fs.readdir(this.agentsDir()).catch(() => [] as string[])).sort()
    for (const file of files.filter((f) => f.endsWith('.toml'))) {
      const id = file.slice(0, -5)
      if (!validId(id)) continue
      const text = await fs.readFile(path.join(this.agentsDir(), file), 'utf8').catch(() => null)
      if (text == null) continue
      let persona: Persona
      try {
        persona = readCodexAgent(text)
      } catch {
        continue
      }
      out.set(id, { id, name: persona.name || id, description: persona.description, persona })
    }
    // Markdown here is another app's (Codex reads only .toml); shown so it can be made real.
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const id = file.slice(0, -3)
      if (!validId(id) || out.has(id)) continue
      const markdown = await fs.readFile(path.join(this.agentsDir(), file), 'utf8').catch(() => null)
      if (markdown == null) continue
      const persona = personaFromMarkdown(id, markdown)
      out.set(id, { id, name: persona.name, description: persona.description, persona, notLoaded: `${file} is markdown; Codex only loads .toml agents` })
    }
    return [...out.values()]
  }

  async writeAgent(id: string, persona: Persona): Promise<void> {
    checkId(id)
    const file = path.join(this.agentsDir(), `${id}.toml`)
    const old = await fs.readFile(file, 'utf8').catch(() => '')
    if (old) await this.o.trash.keep(`codex-agent-${id}.toml`, old)
    await writeText(file, writeCodexAgent(old, { ...persona, name: codexAgentName(persona.name, id) }))
  }

  async removeAgent(id: string): Promise<void> {
    checkId(id)
    for (const f of [`${id}.toml`, `${id}.md`]) {
      const file = path.join(this.agentsDir(), f)
      if (await fs.lstat(file).catch(() => null)) await this.o.trash.put(file, `codex-agent-${f}`)
    }
  }

  private cli(args: string[]) {
    return run(this.o.bin, args, { env: { ...(this.o.env ?? process.env), HOME: this.o.home, CODEX_HOME: this.codexHome, ...QUIET }, cwd: this.o.home, timeout: 60_000 })
  }

  async mcps(): Promise<Record<string, McpServer>> {
    if (!this.installed()) return {}
    const { stdout } = await this.cli(['mcp', 'list', '--json'])
    const out: Record<string, McpServer> = {}
    let text: string | null = null
    for (const e of JSON.parse(stdout.slice(stdout.indexOf('[')))) {
      out[e.name] = fromCodexMcp(e)
      // Codex's listing hides a headers helper; it's a command, not a key, so read it from the file.
      if (e.transport?.http_headers_helper === '<redacted>') {
        text ??= await fs.readFile(this.configFile(), 'utf8').catch(() => '')
        const helper = mcpTableString(text, e.name, 'http_headers_helper')
        if (helper) out[e.name]!.headersHelper = helper
      }
    }
    return out
  }

  private configFile() {
    return path.join(this.codexHome, 'config.toml')
  }

  private async rewrite(change: (text: string) => string, check: () => Promise<void>) {
    const file = this.configFile()
    const old = await fs.readFile(file, 'utf8').catch(() => '')
    await fs.mkdir(this.codexHome, { recursive: true })
    await fs.writeFile(file, change(old), { mode: 0o600 })
    try {
      await check()
    } catch (err) {
      await fs.writeFile(file, old, { mode: 0o600 })
      throw new Error(`Codex didn't accept the change, so it was undone: ${(err as Error).message}`)
    }
    if (old) await this.o.trash.keep('codex-config.toml', old)
  }

  async writeMcp(id: string, server: McpServer): Promise<void> {
    checkId(id)
    const table = toCodexMcp(server)
    await this.rewrite((t) => withMcpTable(t, id, table), async () => {
      await this.cli(['mcp', 'get', id, '--json'])
    })
  }

  async removeMcp(id: string): Promise<void> {
    checkId(id)
    if (!(id in (await this.mcps()))) return
    await this.rewrite((t) => withoutMcpTable(t, id), async () => {
      if (id in (await this.mcps())) throw new Error(`${id} is still there`)
    })
  }
}
