// Claude runs through the Claude Code CLI or through ACP, picked per turn by a setting (Settings › Claude).
// A kept turn is picked up by the engine that started it, whatever the setting says now.

import type { TurnEngine, TurnRequest, TurnResult } from '../ports.ts'
import { ACP_HANDLE_PREFIX } from './claude-acp.ts'

export class ChosenEngine implements TurnEngine {
  private o: { cli: TurnEngine; acp: TurnEngine; useAcp: () => boolean }
  constructor(o: ChosenEngine['o']) {
    this.o = o
  }

  run(req: TurnRequest): Promise<TurnResult> {
    return (this.o.useAcp() ? this.o.acp : this.o.cli).run(req)
  }

  async reattach(handle: string, req: TurnRequest): Promise<TurnResult | null> {
    const engine = handle.startsWith(ACP_HANDLE_PREFIX) ? this.o.acp : this.o.cli
    return (await engine.reattach?.(handle, req)) ?? null
  }
}
