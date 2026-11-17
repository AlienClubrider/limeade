// A local-model turn: Claude Code on the model (tools, the chat's folder, approvals) when the model can
// call tools, a plain chat when it's marked chat only. Turns go through the restart gate, so LiteLLM only
// restarts (for a new model list) between them.

import type { RestartGate } from '../domain/restart-gate.ts'
import type { TurnEngine, TurnRequest, TurnResult } from '../ports.ts'

export class LocalTurns implements TurnEngine {
  private o: { withTools: TurnEngine; chatOnly: TurnEngine; usesTools: (model: string) => Promise<boolean>; gate?: RestartGate }
  constructor(o: LocalTurns['o']) {
    this.o = o
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const turn = async () => ((await this.o.usesTools(req.model)) ? this.o.withTools : this.o.chatOnly).run(req)
    return this.o.gate ? this.o.gate.through(turn) : turn()
  }

  /** Only Claude Code turns outlive the hub; a plain chat's request died with it. */
  reattach(handle: string, req: TurnRequest): Promise<TurnResult | null> {
    const turn = async () => (await this.o.withTools.reattach?.(handle, req)) ?? null
    return this.o.gate ? this.o.gate.through(turn) : turn()
  }
}
