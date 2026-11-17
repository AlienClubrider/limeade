// Runs one Claude turn through ACP with the official Claude ACP adapter (@agentclientprotocol/claude-agent-acp),
// which drives the installed Claude Code. Same sessions as the CLI path (claude-cli.ts): an ACP session id
// is the Claude Code session id, so a chat moves between the two without losing its conversation. The
// turn itself runs in acp-turns.ts; this file is what's Claude's own.

import type { Mode } from '../domain/chat.ts'
import type { TurnRequest } from '../ports.ts'
import type { AcpTurnSpec } from './acp-keeper.ts'
import { AcpReplyReader as Reader, AcpTurns, approvalFor as approvalWith, packageEntry, type AcpAgent, type AcpTool, type AcpTurnsOptions } from './acp-turns.ts'
import { endpointEnv, endpointModel, type LocalEndpoint } from './claude-cli.ts'

export { acpPrompt, onPath, optionFor } from './acp-turns.ts'

/** Claude's ACP turns' handles (and folders) start with this, so a switch knows which engine a kept turn is. */
export const ACP_HANDLE_PREFIX = 'acp-'

export interface ClaudeAcpOptions extends AcpTurnsOptions {
  /** The Claude Code binary the adapter drives (an absolute path). */
  claudeBin: string
  /** Another Anthropic-compatible endpoint (LiteLLM, for local models); photos then go by path only. */
  endpoint?: LocalEndpoint
}

/** The adapter's own entry point, from the installed package. */
export function adapterEntry(): string {
  return packageEntry('@agentclientprotocol/claude-agent-acp')
}

/** The app's mode chip as an ACP session mode. */
export function acpMode(mode: Mode): string {
  return mode === 'ask' ? 'default' : mode
}

/** The session/new (and session/resume) params for a turn. Options go to Claude Code as the CLI's flags would. */
export function sessionParams(
  req: Pick<TurnRequest, 'model' | 'effort' | 'agent' | 'appendSystemPrompt' | 'cwd'>,
  o: { cwd: string; addDirs?: readonly string[] },
): AcpTurnSpec['session'] {
  return {
    cwd: req.cwd ?? o.cwd,
    mcpServers: [],
    ...(o.addDirs?.length ? { additionalDirectories: [...o.addDirs] } : {}),
    _meta: {
      claudeCode: {
        options: {
          model: req.model,
          effort: req.effort,
          // A predicted next prompt per turn: the hub doesn't show it, so don't spend on it.
          promptSuggestions: false,
          ...(req.agent ? { agent: req.agent } : {}),
        },
      },
      ...(req.appendSystemPrompt ? { systemPrompt: { append: req.appendSystemPrompt } } : {}),
    },
  }
}

/** Claude Code names its tools itself (in _meta); a subagent's own calls carry their parent. */
export function claudeTool(call: any): AcpTool {
  const meta = call?._meta?.claudeCode ?? {}
  const input = call?.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}
  return { name: String(meta.toolName ?? call?.name ?? call?.title ?? 'Tool'), input, ...(meta.parentToolUseId ? { child: true } : {}) }
}

const claudeModel = (update: any): string | undefined => update?._meta?.['_claude/model']

/** A permission request as the app's approval card. */
export function approvalFor(params: any) {
  return approvalWith(params, claudeTool)
}

/** Claude's reply reader (see acp-turns.ts). */
export class AcpReplyReader extends Reader {
  constructor(o: { alias: string; reportModel: boolean }) {
    super({ ...o, agent: { tool: claudeTool, modelOf: claudeModel } })
  }
}

function claudeAgent(o: ClaudeAcpOptions): AcpAgent {
  return {
    name: 'Claude',
    handlePrefix: ACP_HANDLE_PREFIX,
    turn: async (req) => ({
      env: { CLAUDE_CODE_EXECUTABLE: o.claudeBin, ...(o.endpoint ? endpointEnv(req.model, o.endpoint) : {}) },
      spec: { session: sessionParams({ ...req, model: endpointModel(req.model, o.endpoint) }, { cwd: o.cwd, addDirs: o.addDirs }), modeId: acpMode(req.mode) },
      inlinePhotos: !o.endpoint,
    }),
    tool: claudeTool,
    modelOf: claudeModel,
  }
}

export class ClaudeAcp extends AcpTurns {
  private local: boolean
  constructor(o: ClaudeAcpOptions) {
    super(o, claudeAgent(o))
    this.local = !!o.endpoint
  }

  /** A local model's name says nothing about Claude versions. */
  protected override reportsModel(): boolean {
    return !this.local
  }
}
