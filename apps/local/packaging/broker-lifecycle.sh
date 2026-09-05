#!/bin/sh

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

broker_label="__AFTERNOTE_BROKER_IDENTIFIER__"
release_artifact="__AFTERNOTE_RELEASE_ARTIFACT__"
release_team_id="__AFTERNOTE_TEAM_ID__"
launchctl_bin=${AFTERNOTE_LAUNCHCTL:-/bin/launchctl}
broker_healthcheck=${AFTERNOTE_BROKER_HEALTHCHECK:-"$install_root/current/afternote"}
broker_health_attempts=${AFTERNOTE_BROKER_HEALTH_ATTEMPTS:-50}
launch_agent_root="$HOME/Library/LaunchAgents"
launch_agent="$launch_agent_root/$broker_label.plist"
launch_domain="gui/$(id -u)"
package_lifecycle_root=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)
package_lifecycle_lock="$package_lifecycle_root/dev.afternote.package-lifecycle.lock"

afternote_acquire_lifecycle_lock() {
  case "$package_lifecycle_root" in
    /*) ;;
    *)
      printf 'Afternote could not resolve its per-user lifecycle directory.\n' >&2
      return 1
      ;;
  esac
  if [ -L "$package_lifecycle_root" ] || [ ! -d "$package_lifecycle_root" ] ||
    [ "$(/usr/bin/stat -f %u "$package_lifecycle_root")" != "$(id -u)" ]; then
    printf 'Afternote per-user lifecycle directory is invalid.\n' >&2
    return 1
  fi
  if ! mkdir -m 700 "$package_lifecycle_lock" 2>/dev/null; then
    lock_pid_file="$package_lifecycle_lock/pid"
    if [ -L "$package_lifecycle_lock" ] || [ ! -d "$package_lifecycle_lock" ] ||
      [ "$(/usr/bin/stat -f %u "$package_lifecycle_lock")" != "$(id -u)" ] ||
      [ -L "$lock_pid_file" ] || [ ! -f "$lock_pid_file" ]; then
      printf 'Afternote lifecycle lock is invalid.\n' >&2
      return 1
    fi
    lock_pid=$(sed -n '1p' "$lock_pid_file")
    case "$lock_pid" in
      ""|*[!0-9]*)
        printf 'Afternote lifecycle lock owner is invalid.\n' >&2
        return 1
        ;;
    esac
    if /bin/kill -0 "$lock_pid" 2>/dev/null; then
      printf 'Another Afternote lifecycle operation is already in progress.\n' >&2
      return 1
    fi
    rm "$lock_pid_file" || return 1
    rmdir "$package_lifecycle_lock" || return 1
    if ! mkdir -m 700 "$package_lifecycle_lock" 2>/dev/null; then
      printf 'Another Afternote lifecycle operation started concurrently.\n' >&2
      return 1
    fi
  fi
  (umask 077 && printf '%s\n' "$$" > "$package_lifecycle_lock/pid") || {
    rm -f "$package_lifecycle_lock/pid" 2>/dev/null || true
    rmdir "$package_lifecycle_lock" 2>/dev/null || true
    return 1
  }
}

afternote_release_lifecycle_lock() {
  lock_pid_file="$package_lifecycle_lock/pid"
  if [ -f "$lock_pid_file" ] && [ ! -L "$lock_pid_file" ] &&
    [ "$(sed -n '1p' "$lock_pid_file")" = "$$" ]; then
    rm "$lock_pid_file" 2>/dev/null || true
    rmdir "$package_lifecycle_lock" 2>/dev/null || true
  fi
}

broker_validate_lifecycle() {
  case "$launchctl_bin" in
    /*) ;;
    *)
      printf 'AFTERNOTE_LAUNCHCTL must be an absolute path.\n' >&2
      return 1
      ;;
  esac
  if [ ! -x "$launchctl_bin" ]; then
    printf 'Afternote could not execute launchctl at %s.\n' "$launchctl_bin" >&2
    return 1
  fi
  case "$broker_healthcheck" in
    /*) ;;
    *)
      printf 'AFTERNOTE_BROKER_HEALTHCHECK must be an absolute path.\n' >&2
      return 1
      ;;
  esac
  case "$broker_health_attempts" in
    ""|*[!0-9]*|0)
      printf 'AFTERNOTE_BROKER_HEALTH_ATTEMPTS must be a positive integer.\n' >&2
      return 1
      ;;
  esac
  if [ -L "$launch_agent_root" ] || [ -L "$launch_agent" ]; then
    printf 'Refusing a symlinked Afternote broker lifecycle path.\n' >&2
    return 1
  fi
  if [ -e "$launch_agent_root" ] && [ ! -d "$launch_agent_root" ]; then
    printf 'Afternote LaunchAgents path must be a directory.\n' >&2
    return 1
  fi
  if [ -e "$launch_agent" ] && [ ! -f "$launch_agent" ]; then
    printf 'Afternote LaunchAgent path must be a regular file.\n' >&2
    return 1
  fi
}

release_code_requirement() {
  identifier=$1
  printf 'anchor apple generic and identifier "%s" and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "%s"' "$identifier" "$release_team_id"
}

verify_release_code() {
  code_path=$1
  identifier=$2
  if [ "$release_artifact" != "1" ]; then
    return 0
  fi
  if [ -L "$code_path" ] || { [ ! -f "$code_path" ] && [ ! -d "$code_path" ]; }; then
    printf 'Afternote release code path is missing or unsafe.\n' >&2
    return 1
  fi
  requirement=$(release_code_requirement "$identifier")
  if ! /usr/bin/codesign --verify --strict --verbose=2 "-R=$requirement" "$code_path" >/dev/null 2>&1; then
    printf 'Afternote release code signature verification failed.\n' >&2
    return 1
  fi
}

verify_release_app() {
  app_path=$1
  identifier=$2
  verify_release_code "$app_path" "$identifier" || return 1
  if [ "$release_artifact" != "1" ]; then
    return 0
  fi
  app_details=$(/usr/bin/codesign -d --verbose=4 "$app_path" 2>&1) || {
    printf 'Afternote application signature metadata is unavailable.\n' >&2
    return 1
  }
  if ! printf '%s\n' "$app_details" | grep -q '^Notarization Ticket=stapled$'; then
    printf 'Afternote application has no stapled notarization ticket.\n' >&2
    return 1
  fi
  if ! /usr/sbin/spctl --assess --type execute --verbose=2 "$app_path" >/dev/null 2>&1; then
    printf 'Gatekeeper rejected an Afternote application.\n' >&2
    return 1
  fi
}

verify_release_version() {
  release_root=$1
  application_path=$2
  if [ "$release_artifact" != "1" ]; then
    return 0
  fi
  verify_release_code "$release_root/afternote" "dev.afternote.local" || return 1
  verify_release_code "$release_root/afternote-vault-broker" "dev.afternote.vault-broker" || return 1
  verify_release_app "$release_root/AfternoteVaultWorker.app" "dev.afternote.vault-broker.worker" || return 1
  verify_release_app "$release_root/AfternoteClientSigner.app" "dev.afternote.client-signer" || return 1
  verify_release_code "$release_root/afternote_sqlcipher.node" "dev.afternote.sqlcipher.addon" || return 1
  verify_release_code "$release_root/libsqlcipher.3.dylib" "dev.afternote.sqlcipher.library" || return 1
  verify_release_code "$release_root/libcrypto.4.dylib" "dev.afternote.sqlcipher.crypto" || return 1
  if [ -e "$release_root/libonnxruntime.1.21.0.dylib" ]; then
    verify_release_code "$release_root/libonnxruntime.1.21.0.dylib" "dev.afternote.local.onnxruntime" || return 1
    verify_release_code "$release_root/onnxruntime_binding.node" "dev.afternote.local.onnxruntime-binding" || return 1
  fi
  verify_release_app "$application_path" "dev.afternote.owner-control" || return 1
}

broker_bootout() {
  if [ -f "$launch_agent" ]; then
    "$launchctl_bin" bootout "$launch_domain" "$launch_agent" >/dev/null 2>&1 || true
  else
    "$launchctl_bin" bootout "$launch_domain/$broker_label" >/dev/null 2>&1 || true
  fi
  broker_stop_attempt=1
  while [ "$broker_stop_attempt" -le "$broker_health_attempts" ]; do
    if ! "$launchctl_bin" print "$launch_domain/$broker_label" >/dev/null 2>&1; then
      return 0
    fi
    broker_stop_attempt=$((broker_stop_attempt + 1))
    if [ "$broker_stop_attempt" -le "$broker_health_attempts" ]; then
      sleep 0.1
    fi
  done
  printf 'Afternote broker is still running after launchd bootout.\n' >&2
  return 1
}

broker_start() {
  "$launchctl_bin" bootstrap "$launch_domain" "$launch_agent" &&
    "$launchctl_bin" kickstart -k "$launch_domain/$broker_label" || return 1
  broker_health_attempt=1
  while [ "$broker_health_attempt" -le "$broker_health_attempts" ]; do
    if "$broker_healthcheck" broker-health >/dev/null 2>&1; then
      return 0
    fi
    broker_health_attempt=$((broker_health_attempt + 1))
    if [ "$broker_health_attempt" -le "$broker_health_attempts" ]; then
      sleep 0.1
    fi
  done
  return 1
}

stop_legacy_runtime() {
  legacy_runtime_binary=$1
  legacy_runtime_path=${AFTERNOTE_RUNTIME_PATH:-"$HOME/.afternote/runtime"}
  case "$legacy_runtime_path" in
    /*) ;;
    *)
      printf 'AFTERNOTE_RUNTIME_PATH must be absolute while retiring legacy state.\n' >&2
      return 1
      ;;
  esac
  legacy_runtime_state="$legacy_runtime_path/runtime.json"
  legacy_runtime_token="$legacy_runtime_path/runtime.token"
  if [ ! -e "$legacy_runtime_state" ] && [ ! -L "$legacy_runtime_state" ] &&
    [ ! -e "$legacy_runtime_token" ] && [ ! -L "$legacy_runtime_token" ]; then
    return 0
  fi
  if [ -L "$legacy_runtime_path" ] || [ ! -d "$legacy_runtime_path" ]; then
    printf 'Refusing invalid legacy Afternote runtime state.\n' >&2
    return 1
  fi
  for legacy_runtime_file in "$legacy_runtime_state" "$legacy_runtime_token"; do
    if [ -L "$legacy_runtime_file" ] || { [ -e "$legacy_runtime_file" ] && [ ! -f "$legacy_runtime_file" ]; }; then
      printf 'Refusing invalid legacy Afternote runtime state.\n' >&2
      return 1
    fi
  done
  if [ -z "$legacy_runtime_binary" ] || [ ! -x "$legacy_runtime_binary" ] ||
    ! "$legacy_runtime_binary" stop >/dev/null; then
    printf 'Afternote could not stop its legacy loopback runtime.\n' >&2
    return 1
  fi
  if [ -e "$legacy_runtime_state" ] || [ -L "$legacy_runtime_state" ] ||
    [ -e "$legacy_runtime_token" ] || [ -L "$legacy_runtime_token" ]; then
    printf 'Afternote legacy loopback runtime state remained after shutdown.\n' >&2
    return 1
  fi
}

verify_legacy_runtime_retired() {
  "$script_dir/afternote" package-verify-legacy-runtime-retired >/dev/null
}
