// Skills that ship with Limeade (defaults/skills): how this install's command is filled in, and which
// installed copies Limeade may bring up to date. Pure rules, no I/O.

/** The line that says Limeade keeps a skill up to date; deleting it keeps the user's own changes. */
export const KEPT_UP_TO_DATE = '<!-- Limeade keeps this skill up to date.'

/** A shipped skill with this install's `limeade` command in place of {{limeade}}. */
export function renderSkill(text: string, command: string): string {
  return text.replaceAll('{{limeade}}', command)
}

/** Whether to write the shipped skill: none installed yet, or Limeade's own copy that's out of date. */
export function shouldWriteSkill(installed: string | null, shipped: string): boolean {
  if (installed === null) return true
  return installed.includes(KEPT_UP_TO_DATE) && installed !== shipped
}

/** A path as a shell word: as is when it's plain, else single-quoted. */
export function shellWord(s: string): string {
  return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * The `limeade` launcher for this install: its Node, its CLI and how to reach this hub, so any agent
 * (in Limeade or not) can run it from anywhere with nothing set up.
 */
export function launcherScript(o: { node: string; cli: string; hub: string; configDir: string }): string {
  return [
    '#!/bin/sh',
    "# This install's `limeade` command, written by Limeade each time it starts.",
    `LIMEADE_HUB=${shellWord(o.hub)} LIMEADE_CONFIG=${shellWord(o.configDir)} LIMEADE_NODE=${shellWord(o.node)}`,
    'export LIMEADE_HUB LIMEADE_CONFIG LIMEADE_NODE',
    `exec ${shellWord(o.node)} ${shellWord(o.cli)} "$@"`,
    '',
  ].join('\n')
}
