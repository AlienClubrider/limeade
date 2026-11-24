// A monitor's run as one agent turn: the agent and model the Assistant is on (the same ones its workers
// get), in auto mode, in the monitor's folder, as the monitor's agent. On Claude's own models it gets the
// long-lived token when there is one, so an unattended run doesn't hang on the login's refresh. The handle remembers which engine
// and model it ran on, so a restarted hub can follow it to the end.

import { parseModelId, turnEngine, type Agent, type TurnEngineKey } from '../domain/models.ts'
import type { Effort } from '../domain/chat.ts'
import type { MonitorTurn, MonitorTurns, TurnEngine, TurnRequest, TurnResult } from '../ports.ts'

interface Deps {
  engines: Partial<Record<TurnEngineKey, TurnEngine>>
  /** What the Assistant runs on now. */
  assistant: () => { agent?: Agent; model: string; effort: Effort }
  /** Extra environment for runs on Claude's own models (its long-lived token, when there is one). */
  claudeEnv?: () => Record<string, string>
}

interface Handle {
  engine: TurnEngineKey
  model: string
  effort: Effort
  handle: string
}

export class AgentMonitorTurns implements MonitorTurns {
  private d: Deps
  constructor(d: Deps) {
    this.d = d
  }

  private request(t: MonitorTurn, key: TurnEngineKey, model: string, effort: Effort): TurnRequest {
    const env = key === 'claude' ? this.d.claudeEnv?.() : undefined
    return {
      ...(env && Object.keys(env).length ? { env } : {}),
      prompt: t.prompt,
      history: [],
      model,
      effort,
      mode: 'auto',
      sessionId: null,
      cwd: t.cwd,
      ...(t.agent ? { agent: t.agent } : {}),
      appendSystemPrompt: t.note,
      signal: t.signal,
      onEvent: t.onEvent,
    }
  }

  async run(t: MonitorTurn): Promise<TurnResult> {
    const a = this.d.assistant()
    const parsed = parseModelId(a.model)
    if (!parsed) throw new Error(`Unknown model ${a.model}`)
    const key = turnEngine(a.agent ?? 'claude', parsed.engine)
    const engine = key ? this.d.engines[key] : undefined
    if (!key || !engine) throw new Error(`The Assistant's agent can't run ${a.model} here`)
    return engine.run({
      ...this.request(t, key, parsed.name, a.effort),
      onStart: (handle) => t.onStart?.(JSON.stringify({ engine: key, model: parsed.name, effort: a.effort, handle } satisfies Handle)),
    })
  }

  async reattach(raw: string, t: MonitorTurn): Promise<TurnResult | null> {
    let h: Handle
    try {
      h = JSON.parse(raw)
    } catch {
      return null
    }
    const engine = this.d.engines[h.engine]
    if (!engine?.reattach) return null
    return engine.reattach(h.handle, this.request(t, h.engine, h.model, h.effort))
  }
}
