// The files in a kept turn's folder, shared by the hub (claude-cli.ts) and the keeper (turn-keeper.ts).
export const KEEPER_FILES = {
  first: 'first.json',
  out: 'out.jsonl',
  answered: 'answered.jsonl',
  err: 'err.log',
  exit: 'exit.json',
  collected: 'collected',
  socket: 'in.sock',
  /** Settings for a local model's turn (claude-cli.ts). */
  settings: 'settings.json',
} as const
