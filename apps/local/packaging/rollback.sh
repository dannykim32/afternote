#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

if [ "$#" -ne 1 ]; then
  printf 'Usage: rollback.sh <version>\n' >&2
  exit 2
fi

version=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_root=${AFTERNOTE_INSTALL_ROOT:-"$HOME/Library/Application Support/Afternote"}
version_root="$install_root/versions/$version"
marker="$install_root/.afternote-local-install"
. "$script_dir/broker-lifecycle.sh"

case "$version" in
  ""|*..*|*[!0-9A-Za-z.+-]*)
    printf 'Invalid Afternote version: %s\n' "$version" >&2
    exit 2
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
  printf 'Afternote does not own the requested install root.\n' >&2
  exit 1
fi

if [ -L "$install_root/versions" ] || [ -L "$version_root" ] || [ ! -d "$version_root" ] ||
  [ -L "$version_root/afternote" ] || [ ! -f "$version_root/afternote" ] || [ ! -x "$version_root/afternote" ] ||
  [ -L "$version_root/afternote-vault-broker" ] || [ ! -f "$version_root/afternote-vault-broker" ] || [ ! -x "$version_root/afternote-vault-broker" ]; then
  printf 'Afternote Local %s is not installed.\n' "$version" >&2
  exit 1
fi
application_path_file="$version_root/application-path"
if [ -L "$application_path_file" ] || [ ! -f "$application_path_file" ]; then
  printf 'Afternote Local %s has no valid application record.\n' "$version" >&2
  exit 1
fi
application_path=$(sed -n '1p' "$application_path_file")
case "$application_path" in
  /*) ;;
  *)
    printf 'Afternote Local %s has an invalid application path.\n' "$version" >&2
    exit 1
    ;;
esac
verify_release_version "$version_root" "$application_path"

broker_validate_lifecycle
if [ ! -L "$install_root/current" ] || [ ! -f "$launch_agent" ]; then
  printf 'Afternote broker lifecycle state is incomplete.\n' >&2
  exit 1
fi
previous_current=$(readlink "$install_root/current")
case "$previous_current" in
  versions/*) ;;
  *)
    printf 'Afternote current version link is invalid.\n' >&2
    exit 1
    ;;
esac
switch_started=0
rollback_complete=0
restore_rollback() {
  restore_failed=0
  broker_bootout
  ln -sfn "$previous_current" "$install_root/current" || restore_failed=1
  previous_version=${previous_current#versions/}
  broker_start "$previous_version" >/dev/null 2>&1 || restore_failed=1
  [ "$restore_failed" -eq 0 ]
}
cleanup_rollback() {
  if [ "$switch_started" -eq 1 ] && [ "$rollback_complete" -eq 0 ]; then
    if ! restore_rollback; then
      printf 'Afternote selected the previous version, but its broker restart also failed.\n' >&2
    fi
  fi
  afternote_release_lifecycle_lock
}
trap cleanup_rollback 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

perform_rollback() {
  switch_started=1
  legacy_runtime_binary="$install_root/$previous_current/afternote"
  broker_bootout
  ln -sfn "versions/$version" "$install_root/current" || return 1
  stop_legacy_runtime "$legacy_runtime_binary" || return 1
  verify_legacy_runtime_retired || return 1
  broker_start "$version" || return 1
}
if ! perform_rollback; then
  printf 'Afternote could not activate the rolled-back vault broker; the previous version will be restored.\n' >&2
  exit 1
fi
rollback_complete=1
printf 'Rolled Afternote Local back to %s.\n' "$version"
