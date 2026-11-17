// "Change it…" for Toolbox items with a model the user picks. Same prompt and reply shape as Toolbox's own
// /api/draft (~/dev/toolbox/server.mjs), so a draft saves through Toolbox unchanged.

export type ToolKind = 'skill' | 'agent' | 'mcp'
const HIDDEN = '<hidden>' // Toolbox's mask for secrets

const FORMAT: Record<ToolKind, string> = {
  skill: `a Claude Code skill: a SKILL.md file. It starts with YAML frontmatter between --- lines containing
"name" (lowercase-hyphenated) and "description" (what it does AND when to use it — this is what makes Claude pick it).
Then the markdown body with the instructions.`,
  agent: `a Claude Code subagent: a markdown file with YAML frontmatter between --- lines containing "name" and
"description" (when Claude should delegate to it), optionally "tools" and "model". Then the agent's system prompt as the body.
Keep any frontmatter keys you don't need to change exactly as they are.`,
  mcp: `an MCP server config (used by both Claude Code and Codex) as a JSON object, e.g. {"type":"http","url":"https://…","headers":{…}} or
{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{…}}. Values like "\${NAME}" are keys kept in a key store,
not in the config — leave them exactly as they are. Values shown as "${HIDDEN}" are secrets too — leave them as they are.
If a new key is needed, put "PASTE-HERE" as its value. For a stdio server, an env key's value is "\${SAME_NAME}".`,
}

export function isToolKind(v: unknown): v is ToolKind {
  return v === 'skill' || v === 'agent' || v === 'mcp'
}

export function draftPrompt(req: { kind: ToolKind; current?: string; request: string; id?: string }): { system: string; prompt: string } {
  const system = `You write ${FORMAT[req.kind]}
${req.current ? 'You are given the current version and a change request. Apply the change and nothing else.' : 'You are given a description of something new to create.'}
Reply with ONLY a JSON object, no code fences: {"id": "<short-lowercase-hyphenated-name>", "summary": "<one or two plain sentences on what you made or changed>", "content": "<the complete new file text>"}`
  const prompt = (req.current ? `Name: ${req.id}\n\nCurrent version:\n<<<\n${req.current}\n>>>\n\n` : '') + `Request: ${req.request}`
  return { system, prompt }
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/** The model's reply -> { id, summary, content }. Throws a plain sentence when it isn't usable. */
export function parseDraft(text: string, kind: ToolKind, id?: string): { id: string; summary: string; content: string } {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let out: any
  try {
    out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    throw new Error("That model didn't return a usable draft. Try again or pick another model.")
  }
  if (kind === 'mcp' && out && typeof out.content !== 'string') out.content = JSON.stringify(out.content, null, 2)
  if (!out || typeof out.content !== 'string' || !out.content.trim()) {
    throw new Error("That model didn't return a usable draft. Try again or pick another model.")
  }
  return { id: slug(String(out.id || id || 'new')) || 'new', summary: String(out.summary ?? ''), content: out.content }
}
