#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

install_root=${AFTERNOTE_INSTALL_ROOT:-"$HOME/Library/Application Support/Afternote"}
bin_root=${AFTERNOTE_BIN_ROOT:-"$HOME/.local/bin"}
marker="$install_root/.afternote-local-install"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version="__AFTERNOTE_VERSION__"
. "$script_dir/broker-lifecycle.sh"

case "$install_root" in
  ""|/|"$HOME")
    printf 'Refusing unsafe Afternote install root: %s\n' "$install_root" >&2
    exit 1
    ;;
esac

afternote_acquire_lifecycle_lock
cleanup_lifecycle_lock() {
  afternote_release_lifecycle_lock
}
trap cleanup_lifecycle_lock 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

if [ -L "$install_root" ] || [ -L "$marker" ] || [ ! -f "$marker" ] || [ "$(sed -n '1p' "$marker")" != "dev.afternote.local" ]; then
  printf 'Refusing an install root not owned by Afternote: %s\n' "$install_root" >&2
  exit 1
fi

broker_validate_lifecycle
versions_root="$install_root/versions"
if [ -L "$versions_root" ] || [ ! -d "$versions_root" ]; then
  printf 'Refusing invalid Afternote versions state.\n' >&2
  exit 1
fi

if [ ! -L "$install_root/current" ]; then
  printf 'Afternote cannot safely resolve its installed version. No files were removed.\n' >&2
  exit 1
fi
previous_current=$(readlink "$install_root/current")
case "$previous_current" in
  versions/*) ;;
  *)
    printf 'Afternote cannot safely resolve its installed version. No files were removed.\n' >&2
    exit 1
    ;;
esac
legacy_runtime_binary="$install_root/$previous_current/afternote"
if [ -L "$legacy_runtime_binary" ] || [ ! -f "$legacy_runtime_binary" ] ||
  [ ! -x "$legacy_runtime_binary" ]; then
  printf 'Afternote cannot safely inspect the installed runtime. No files were removed.\n' >&2
  exit 1
fi
management_binary="$versions_root/$version/afternote"

codex_was_managed=0
codex_config=${CODEX_HOME:-"$HOME/.codex"}/config.toml
codex_entry_present=0
if [ -f "$codex_config" ] && grep -q '^\[mcp_servers\.afternote\]$' "$codex_config"; then
  codex_entry_present=1
fi
if [ "$codex_entry_present" -eq 1 ]; then
  if [ -L "$management_binary" ] || [ ! -f "$management_binary" ] ||
    [ ! -x "$management_binary" ]; then
    printf 'Afternote cannot safely inspect connector ownership. No files were removed.\n' >&2
    exit 1
  fi
  if codex_status=$(PATH="$bin_root:$PATH" \
    AFTERNOTE_INSTALL_ROOT="$install_root" \
    AFTERNOTE_BIN_ROOT="$bin_root" \
    "$management_binary" codex status 2>/dev/null); then
    case "$codex_status" in
      *'"configHealthy": true'*) codex_was_managed=1 ;;
      *'"toolAvailable": false'*)
        printf 'Codex is unavailable or unverified; review its MCP settings for a stale Afternote entry.\n' >&2
        ;;
      *)
        printf 'Codex MCP settings contain an Afternote entry that this installation does not own.\n' >&2
        ;;
    esac
  else
    printf 'Codex connector status could not be inspected. No Afternote files were removed.\n' >&2
    exit 1
  fi
fi

claude_was_managed=0
claude_config="$HOME/.claude.json"
claude_entry_present=0
if [ -f "$claude_config" ] && grep -Eq '"afternote"[[:space:]]*:' "$claude_config"; then
  claude_entry_present=1
fi
if [ "$claude_entry_present" -eq 1 ]; then
  if [ -L "$management_binary" ] || [ ! -f "$management_binary" ] ||
    [ ! -x "$management_binary" ]; then
    printf 'Afternote cannot safely inspect connector ownership. No files were removed.\n' >&2
    exit 1
  fi
  if claude_status=$(PATH="$bin_root:$PATH" \
    AFTERNOTE_INSTALL_ROOT="$install_root" \
    AFTERNOTE_BIN_ROOT="$bin_root" \
    "$management_binary" claude-code status 2>/dev/null); then
    case "$claude_status" in
      *'"configHealthy": true'*) claude_was_managed=1 ;;
      *'"toolAvailable": false'*)
        printf 'Claude Code is unavailable or unverified; review its MCP settings for a stale Afternote entry.\n' >&2
        ;;
      *)
        printf 'Claude Code MCP settings contain an Afternote entry that this installation does not own.\n' >&2
        ;;
    esac
  else
    printf 'Claude Code connector status could not be inspected. No Afternote files were removed.\n' >&2
    exit 1
  fi
fi

previous_bin_link=""
if [ -L "$bin_root/afternote" ]; then
  candidate_bin_link=$(readlink "$bin_root/afternote")
  case "$candidate_bin_link" in
    "$install_root"/*)
      previous_bin_link=$candidate_bin_link
      ;;
  esac
fi

uninstall_started=0
uninstall_complete=0
restore_uninstall() {
  restore_failed=0
  ln -sfn "$previous_current" "$install_root/current" || restore_failed=1
  if [ -n "$previous_bin_link" ]; then
    ln -sfn "$previous_bin_link" "$bin_root/afternote" || restore_failed=1
  fi
  if [ -f "$launch_agent" ]; then
    broker_start >/dev/null 2>&1 || restore_failed=1
  fi
  if [ "$codex_was_managed" -eq 1 ]; then
    PATH="$bin_root:$PATH" \
      AFTERNOTE_INSTALL_ROOT="$install_root" \
      AFTERNOTE_BIN_ROOT="$bin_root" \
      "$management_binary" codex install >/dev/null 2>&1 || restore_failed=1
  fi
  if [ "$claude_was_managed" -eq 1 ]; then
    PATH="$bin_root:$PATH" \
      AFTERNOTE_INSTALL_ROOT="$install_root" \
      AFTERNOTE_BIN_ROOT="$bin_root" \
      "$management_binary" claude-code install >/dev/null 2>&1 || restore_failed=1
  fi
  [ "$restore_failed" -eq 0 ]
}
cleanup_uninstall() {
  if [ "$uninstall_started" -eq 1 ] && [ "$uninstall_complete" -eq 0 ]; then
    if ! restore_uninstall; then
      printf 'Afternote uninstall rollback was incomplete; reinstall this version before retrying.\n' >&2
    fi
  fi
  afternote_release_lifecycle_lock
}
trap cleanup_uninstall 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

uninstall_started=1
if [ "$codex_was_managed" -eq 1 ] && ! PATH="$bin_root:$PATH" \
  AFTERNOTE_INSTALL_ROOT="$install_root" \
  AFTERNOTE_BIN_ROOT="$bin_root" \
  "$management_binary" codex remove >/dev/null; then
  printf 'Codex connector cleanup failed. No Afternote files were removed.\n' >&2
  exit 1
fi
if [ "$claude_was_managed" -eq 1 ] && ! PATH="$bin_root:$PATH" \
  AFTERNOTE_INSTALL_ROOT="$install_root" \
  AFTERNOTE_BIN_ROOT="$bin_root" \
  "$management_binary" claude-code remove >/dev/null; then
  printf 'Claude Code connector cleanup failed. No Afternote files were removed.\n' >&2
  exit 1
fi
broker_bootout
if [ -n "$previous_bin_link" ]; then
  rm "$bin_root/afternote"
fi
rm "$install_root/current"
stop_legacy_runtime "$legacy_runtime_binary"
verify_legacy_runtime_retired
afternote_remove_legacy_telemetry_state

if [ -f "$launch_agent" ]; then
  rm "$launch_agent"
  rmdir "$launch_agent_root" 2>/dev/null || true
fi
rm -rf -- "$install_root"
uninstall_complete=1
printf 'Removed Afternote Local. Vault data under %s/.afternote was preserved.\n' "$HOME"
