---
name: limeade-monitors
description: Set up and manage Limeade monitors, jobs an agent runs by itself on a schedule or when something changes. Use when the user wants something done regularly or whenever something happens ("check every hour", "every morning", "each weekday", "remind me", "watch for", "let me know when", "schedule", "monitor"), or asks about, changes, pauses, runs or removes a monitor.
---
<!-- Limeade keeps this skill up to date. To keep your own changes instead, delete this line. -->

# Limeade monitors

A monitor is a job Limeade runs unattended: on a schedule, or whenever a cheap check's output changes. Each run is one fresh agent turn with no chat history, and nobody can answer it or approve anything while it runs.

## The command

Run every command below exactly like this. It works from any folder:

```
{{limeade}} monitor help
```

If it says Limeade isn't answering, Limeade isn't running: tell the user (it's started from their Limeade install). Don't create the monitor some other way (cron, launchd, a scheduled cloud agent).

## Commands

```
{{limeade}} monitor list                      # every monitor, its schedule, next and last run
{{limeade}} monitor show <id|name>            # its instructions and recent runs
{{limeade}} monitor log <id|name> [run-id]    # a run's full log (newest when no run-id)
{{limeade}} monitor add "<name>" --when "<schedule>" --description "<one line>" --file <file> [--agent <agent>] [--folder <dir>] [--paused]
{{limeade}} monitor add "<name>" --check "<command>" --every "10 min" --description "<one line>" --file <file> [...]
{{limeade}} monitor edit <id|name> [--name …] [--when … | --check … --every …] [--description …] [--file … | --text …] [--agent <agent>|-] [--folder …]
{{limeade}} monitor run <id|name>             # run once now
{{limeade}} monitor pause <id|name>  |  resume <id|name>  |  rm <id|name>
```

`--file -` reads the instructions from stdin, so a heredoc works: `--file - <<'BRIEF' … BRIEF`. Use `--text "…"` only for a one-liner.

## Setting one up

1. **Check first**: `monitor list`. If one already does this, edit it rather than adding a second.
2. **When**: `--when` takes "every 30 min", "every 2 hours", "daily 21:00", "weekdays 07:30", "mon,wed,fri 9am" (the computer's local time). Pick the least frequent schedule that does the job. For "tell me when X happens", use `--check "<command>"` with `--every`: a quick shell command whose output changes when X happens (e.g. `curl -s <url> | grep -c <word>`, `ls <folder>`). It runs every N minutes and the job runs only when the output changes, so no agent time is spent while nothing happens.
3. **Who**: `--agent <name>` runs it as one of the user's agents (use one whose expertise fits; your agents list shows them). Leave it off for a general job.
4. **Where**: `--folder <dir>` is the folder it works in, when the job is about one project or set of files.
5. **Description**: always give `--description`, one plain line for the user on what it does ("Checks the shop's open orders and flags any stuck over a day"). It isn't the brief.
6. **Instructions**: write a full brief (see below), save it with `--file`.
7. **Test it**: `monitor run <id>`, wait for it to finish, then read `monitor log <id>`. Fix the brief with `monitor edit` and run again until a run does the right thing. Only then tell the user it's set, with when it runs next.

## Writing the instructions

The run starts from nothing, so the brief must stand alone:
- **What to do**: exactly what to check or make, where (paths, URLs, commands, accounts it may use), and how.
- **What counts as worth telling**: the condition that means the user must know or act. Everything else is a quiet run.
- **What it must not do**: anything destructive or outward-facing (sending, posting, buying, deleting) unless the user asked for exactly that.
- **Where results go** if it makes something (a file path), so the user can find it.
- **How to end**: Limeade asks every run to finish with one last line, and the brief should say which to use when:
  - `SUMMARY: <one line>`: went fine, nothing for the user. Stays quiet.
  - `NEEDS-YOU: <what they must decide or do>`: only when something really needs them.
  - `FAILED: <why>`: it couldn't do the job.

Don't make every run "report": a monitor that pings when nothing happened gets ignored. Notify only when something needs the user.

## How results reach the user

- Every run, with its summary and log, is on Limeade's Monitors page.
- Fine runs stay quiet. A FAILED or NEEDS-YOU run reaches the Assistant as news from "monitor-<id>". The Assistant reads its log (`monitor log`) and tells the user or deals with it, like a helper's report.
- Removing a monitor (`rm`) can't be undone: ask the user before removing one you didn't just make. Pausing keeps it.
