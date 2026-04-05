# Picord runtime script design

## Goal
Provide a single consistent operational entrypoint for running Picord in tmux.

## Chosen approach
Option 2: one shell CLI wrapper with subcommands.

## Commands
- `start`
- `stop`
- `restart`
- `status`
- `logs`

## Behavior
- `start`
  - resolve repo root consistently
  - require `.env`
  - stop `systemd` service if active to avoid duplicate bot processes
  - kill any existing tmux `picord` session
  - run `npm run sync:discord-commands`
  - start a fresh tmux session named `picord`
- `stop`
  - kill tmux `picord` session if present
  - stop `systemd` service if active
- `restart`
  - run `stop`, then `start`
- `status`
  - show tmux session state and systemd state
- `logs`
  - print the current tmux pane output for quick inspection

## UX goals
- make startup reproducible
- avoid duplicate runtime instances
- give one command surface for common VPS operations

## Files
- `scripts/picord.sh`
- `package.json`
- `README.md`
