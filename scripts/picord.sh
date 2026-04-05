#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="picord"
SERVICE_NAME="picord"
PI_BIN="/home/kytusdevenn/.npm-global/bin/pi"

cd "$ROOT_DIR"

require_env() {
  if [[ ! -f .env ]]; then
    echo "Missing .env in $ROOT_DIR" >&2
    exit 1
  fi
}

has_tmux_session() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

stop_systemd_if_running() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      sudo systemctl stop "$SERVICE_NAME"
    fi
  fi
}

start_tmux() {
  tmux new-session -d -s "$SESSION_NAME" "cd '$ROOT_DIR' && set -a && source .env && set +a && exec '$PI_BIN' -e ./src/index.ts --no-session"
}

cmd_start() {
  require_env
  stop_systemd_if_running
  if has_tmux_session; then
    tmux kill-session -t "$SESSION_NAME"
  fi
  set -a
  source .env
  set +a
  npm run sync:discord-commands
  start_tmux
  sleep 2
  cmd_status
}

cmd_stop() {
  stop_systemd_if_running
  if has_tmux_session; then
    tmux kill-session -t "$SESSION_NAME"
    echo "Stopped tmux session: $SESSION_NAME"
  else
    echo "No tmux session named $SESSION_NAME is running"
  fi
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  echo "== tmux =="
  if has_tmux_session; then
    tmux list-panes -t "$SESSION_NAME" -F '#{session_name} #{pane_pid} #{pane_current_command} dead=#{pane_dead}'
  else
    echo "No tmux session named $SESSION_NAME"
  fi

  echo
  echo "== systemd =="
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active "$SERVICE_NAME" 2>/dev/null || true
  else
    echo "systemctl unavailable"
  fi
}

cmd_logs() {
  if ! has_tmux_session; then
    echo "No tmux session named $SESSION_NAME" >&2
    exit 1
  fi
  tmux capture-pane -pt "$SESSION_NAME" | tail -n 200
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
