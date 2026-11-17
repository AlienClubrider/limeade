// Lets LiteLLM restart between local-model turns: a restart waits for running turns to finish, and turns
// that start meanwhile wait for the restart. Nothing is ever cut off mid-reply.

export class RestartGate {
  private active = 0
  private restarting: Promise<void> | null = null
  private idleWaiters: (() => void)[] = []

  /** Runs one turn through the gate (waits while a restart is under way). */
  async through<T>(turn: () => Promise<T>): Promise<T> {
    while (this.restarting) await this.restarting
    this.active++
    try {
      return await turn()
    } finally {
      this.active--
      if (this.active === 0) for (const w of this.idleWaiters.splice(0)) w()
    }
  }

  get busy(): number {
    return this.active
  }

  /** Waits until no turn is running, then holds new turns while `restart` runs. Restarts don't overlap. */
  async restart(restart: () => Promise<void>): Promise<void> {
    // No await between the last check and claiming the gate, so nothing slips in between.
    for (;;) {
      if (this.restarting) await this.restarting
      else if (this.active > 0) await new Promise<void>((r) => this.idleWaiters.push(r))
      else break
    }
    const run = restart()
    // Never rejects, so turns waiting on it go ahead whether or not the restart worked.
    this.restarting = run.catch(() => {}).then(() => {
      this.restarting = null
    })
    return run
  }
}
