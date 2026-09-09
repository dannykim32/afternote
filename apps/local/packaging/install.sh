#!/bin/sh
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

version="__AFTERNOTE_VERSION__"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
application_path=${AFTERNOTE_APPLICATION_PATH:-"$script_dir/Afternote.app"}
install_root=${AFTERNOTE_INSTALL_ROOT:-"$HOME/Library/Application Support/Afternote"}
bin_root=${AFTERNOTE_BIN_ROOT:-"$HOME/.local/bin"}
versions_root="$install_root/versions"
version_root="$versions_root/$version"
marker="$install_root/.afternote-local-install"
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

if [ -L "$install_root" ] || [ -L "$marker" ]; then
  printf 'Refusing a symlinked Afternote install root or marker.\n' >&2
  exit 1
fi

if [ -e "$install_root" ] && [ ! -f "$marker" ]; then
  printf 'Refusing an install root not owned by Afternote: %s\n' "$install_root" >&2
  exit 1
fi

broker_validate_lifecycle

install_root_created=0
bin_root_created=0
launch_agent_root_created=0
if [ ! -e "$install_root" ]; then install_root_created=1; fi
if [ ! -e "$bin_root" ]; then bin_root_created=1; fi
if [ ! -e "$launch_agent_root" ]; then launch_agent_root_created=1; fi

case "$application_path" in
  /*) ;;
  *)
    printf 'AFTERNOTE_APPLICATION_PATH must be absolute.\n' >&2
    exit 1
    ;;
esac
if [ -L "$application_path" ] || [ ! -d "$application_path" ] ||
  [ -L "$application_path/Contents/MacOS/Afternote" ] ||
  [ ! -x "$application_path/Contents/MacOS/Afternote" ]; then
  printf 'Afternote could not validate its application bundle at %s.\n' "$application_path" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

sed_replacement() {
  sed -e 's/[&|\\]/\\&/g'
}

if [ -L "$versions_root" ]; then
  printf 'Refusing a symlinked Afternote versions root.\n' >&2
  exit 1
fi

if [ -d "$version_root" ] && [ ! -L "$version_root" ] &&
  [ -L "$install_root/current" ] &&
  [ "$(readlink "$install_root/current")" = "versions/$version" ]; then
  if [ ! -f "$marker" ] || [ "$(sed -n '1p' "$marker")" != "dev.afternote.local" ]; then
    printf 'Refusing an install root not owned by Afternote: %s\n' "$install_root" >&2
    exit 1
  fi
  if [ -L "$bin_root" ] || { [ -e "$bin_root" ] && [ ! -d "$bin_root" ]; }; then
    printf 'Refusing an invalid Afternote command directory.\n' >&2
    exit 1
  fi
  if [ -e "$bin_root/afternote" ] && [ ! -L "$bin_root/afternote" ]; then
    printf 'Refusing to replace a non-symlinked afternote command.\n' >&2
    exit 1
  fi
  verify_release_version "$version_root" "$application_path"
  mkdir -p "$bin_root"
  if [ -L "$bin_root" ] || [ ! -d "$bin_root" ]; then
    printf 'Refusing an invalid Afternote command directory.\n' >&2
    exit 1
  fi
  ln -sfn "$install_root/current/afternote" "$bin_root/afternote"
  printf 'Repaired Afternote Local %s command link at %s\n' "$version" "$bin_root/afternote"
  exit 0
fi

if [ -e "$version_root" ] || [ -L "$version_root" ]; then
  printf 'Afternote Local %s is already installed; version directories are immutable.\n' "$version" >&2
  exit 1
fi

mkdir -p "$versions_root" "$bin_root" "$launch_agent_root"
if [ -L "$versions_root" ]; then
  printf 'Refusing a symlinked Afternote versions root.\n' >&2
  exit 1
fi
broker_validate_lifecycle
printf 'dev.afternote.local\n' > "$marker"
chmod 600 "$marker"
version_stage=""
launch_agent_temp=""
previous_launch_agent=""
previous_current=""
previous_bin_link=""
published_version=0
switch_started=0
installation_complete=0
restore_switch() {
  restore_failed=0
  broker_bootout
  if [ -n "$previous_current" ]; then
    ln -sfn "$previous_current" "$install_root/current" || restore_failed=1
  else
    rm -f "$install_root/current" || restore_failed=1
  fi
  if [ -n "$previous_bin_link" ]; then
    ln -sfn "$previous_bin_link" "$bin_root/afternote" || restore_failed=1
  elif [ -L "$bin_root/afternote" ]; then
    rm "$bin_root/afternote" || restore_failed=1
  fi
  if [ -n "$previous_launch_agent" ]; then
    cp -p "$previous_launch_agent" "$launch_agent" || restore_failed=1
  else
    rm -f "$launch_agent" || restore_failed=1
  fi
  if [ -n "$previous_current" ] && [ -n "$previous_launch_agent" ]; then
    broker_start >/dev/null 2>&1 || restore_failed=1
  fi
  [ "$restore_failed" -eq 0 ]
}
cleanup_stage() {
  if [ "$switch_started" -eq 1 ] && [ "$installation_complete" -eq 0 ]; then
    if ! restore_switch; then
      printf 'Afternote selected the previous version, but its broker restart also failed.\n' >&2
    fi
  fi
  if [ -n "$version_stage" ]; then
    rm -rf -- "$version_stage"
  fi
  if [ -n "$launch_agent_temp" ]; then
    rm -f -- "$launch_agent_temp"
  fi
  if [ -n "$previous_launch_agent" ]; then
    rm -f -- "$previous_launch_agent"
  fi
  if [ "$published_version" -eq 1 ] && [ "$installation_complete" -eq 0 ]; then
    rm -rf -- "$version_root"
  fi
  if [ "$installation_complete" -eq 0 ] && [ "$install_root_created" -eq 1 ]; then
    if [ -f "$marker" ] && [ ! -L "$marker" ] &&
      [ "$(sed -n '1p' "$marker")" = "dev.afternote.local" ]; then
      rm "$marker"
    fi
    rmdir "$versions_root" 2>/dev/null || true
    rmdir "$install_root" 2>/dev/null || true
  fi
  if [ "$installation_complete" -eq 0 ] && [ "$bin_root_created" -eq 1 ]; then
    rmdir "$bin_root" 2>/dev/null || true
  fi
  if [ "$installation_complete" -eq 0 ] && [ "$launch_agent_root_created" -eq 1 ]; then
    rmdir "$launch_agent_root" 2>/dev/null || true
  fi
  afternote_release_lifecycle_lock
}
trap cleanup_stage 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
version_stage=$(mktemp -d "$versions_root/.afternote-$version.XXXXXX")
install -m 755 "$script_dir/afternote" "$version_stage/afternote"
install -m 755 "$script_dir/afternote-vault-broker" "$version_stage/afternote-vault-broker"
if find "$script_dir/AfternoteVaultWorker.app" -type l -print -quit | grep -q .; then
  printf 'Refusing a vault worker app containing symlinks.\n' >&2
  exit 1
fi
cp -R "$script_dir/AfternoteVaultWorker.app" "$version_stage/AfternoteVaultWorker.app"
chmod 755 "$version_stage/AfternoteVaultWorker.app/Contents/MacOS/afternote-vault-worker"
if find "$script_dir/AfternoteClientSigner.app" -type l -print -quit | grep -q .; then
  printf 'Refusing a client signer app containing symlinks.\n' >&2
  exit 1
fi
cp -R "$script_dir/AfternoteClientSigner.app" "$version_stage/AfternoteClientSigner.app"
chmod 755 "$version_stage/AfternoteClientSigner.app/Contents/MacOS/afternote-client-signer"
if [ "$application_path" = "$script_dir/Afternote.app" ]; then
  if find "$application_path" -type l -print -quit | grep -q .; then
    printf 'Refusing an owner-control app containing symlinks.\n' >&2
    exit 1
  fi
  cp -R "$application_path" "$version_stage/Afternote.app"
  chmod 755 "$version_stage/Afternote.app/Contents/MacOS/Afternote"
  installed_application_path="$version_root/Afternote.app"
else
  installed_application_path="$application_path"
fi
printf '%s\n' "$installed_application_path" > "$version_stage/application-path"
chmod 600 "$version_stage/application-path"
install -m 755 "$script_dir/afternote_sqlcipher.node" "$version_stage/afternote_sqlcipher.node"
install -m 755 "$script_dir/libsqlcipher.3.dylib" "$version_stage/libsqlcipher.3.dylib"
install -m 755 "$script_dir/libcrypto.4.dylib" "$version_stage/libcrypto.4.dylib"
install -m 644 "$script_dir/THIRD_PARTY_NOTICES.md" "$version_stage/THIRD_PARTY_NOTICES.md"
install -m 644 "$script_dir/SBOM.spdx.json" "$version_stage/SBOM.spdx.json"
if [ -L "$script_dir/LICENSES" ] || [ ! -d "$script_dir/LICENSES" ] ||
  find "$script_dir/LICENSES" -mindepth 1 ! -type f -print -quit | grep -q . ||
  ! find "$script_dir/LICENSES" -type f -print -quit | grep -q .; then
  printf 'Refusing a missing, empty, or non-regular release license inventory.\n' >&2
  exit 1
fi
mkdir "$version_stage/LICENSES"
for license_path in "$script_dir"/LICENSES/*; do
  license_name=${license_path##*/}
  install -m 644 "$license_path" "$version_stage/LICENSES/$license_name"
done
if [ -e "$script_dir/libonnxruntime.1.21.0.dylib" ]; then
  if [ -L "$script_dir/libonnxruntime.1.21.0.dylib" ] ||
    [ ! -f "$script_dir/libonnxruntime.1.21.0.dylib" ]; then
    printf 'Refusing an invalid or symlinked semantic runtime payload.\n' >&2
    exit 1
  fi
  install -m 755 "$script_dir/libonnxruntime.1.21.0.dylib" "$version_stage/libonnxruntime.1.21.0.dylib"
  if [ -L "$script_dir/onnxruntime_binding.node" ] ||
    [ ! -f "$script_dir/onnxruntime_binding.node" ]; then
    printf 'Refusing a missing, invalid, or symlinked semantic native binding.\n' >&2
    exit 1
  fi
  install -m 755 "$script_dir/onnxruntime_binding.node" "$version_stage/onnxruntime_binding.node"
fi
verify_release_version "$version_stage" "$installed_application_path"

broker_path_xml=$(xml_escape "$install_root/current/afternote-vault-broker" | sed_replacement)
home_xml=$(xml_escape "$HOME" | sed_replacement)
launch_agent_temp=$(mktemp "$launch_agent.tmp.XXXXXX")
sed \
  -e "s|__AFTERNOTE_BROKER_PATH__|$broker_path_xml|g" \
  -e "s|__AFTERNOTE_HOME__|$home_xml|g" \
  "$script_dir/launch-agent.plist" > "$launch_agent_temp"
chmod 600 "$launch_agent_temp"

if [ -L "$install_root/current" ]; then
  previous_current=$(readlink "$install_root/current")
fi
if [ -L "$bin_root/afternote" ]; then
  previous_bin_link=$(readlink "$bin_root/afternote")
elif [ -e "$bin_root/afternote" ]; then
  printf 'Refusing to replace a non-symlinked afternote command.\n' >&2
  exit 1
fi
if [ -e "$install_root/current" ] && [ ! -L "$install_root/current" ]; then
  printf 'Refusing a non-symlinked Afternote current path.\n' >&2
  exit 1
fi
if [ -f "$launch_agent" ]; then
  previous_launch_agent=$(mktemp "$launch_agent.previous.XXXXXX")
  cp -p "$launch_agent" "$previous_launch_agent"
fi

if [ -e "$version_root" ] || [ -L "$version_root" ]; then
  printf 'Afternote Local %s is already installed; version directories are immutable.\n' "$version" >&2
  exit 1
fi
mv -n "$version_stage" "$version_root"
if [ -e "$version_stage" ]; then
  printf 'Afternote Local %s could not claim its immutable version directory.\n' "$version" >&2
  exit 1
fi
version_stage=""
published_version=1

perform_switch() {
  switch_started=1
  legacy_runtime_binary=""
  if [ -n "$previous_current" ]; then
    legacy_runtime_binary="$install_root/$previous_current/afternote"
  fi
  broker_bootout
  ln -sfn "versions/$version" "$install_root/current" || return 1
  ln -sfn "$install_root/current/afternote" "$bin_root/afternote" || return 1
  stop_legacy_runtime "$legacy_runtime_binary" || return 1
  verify_legacy_runtime_retired || return 1
  mv "$launch_agent_temp" "$launch_agent" || return 1
  launch_agent_temp=""
  broker_start || return 1
}
if ! perform_switch; then
  printf 'Afternote could not activate the new vault broker; the previous version will be restored.\n' >&2
  exit 1
fi
installation_complete=1
launch_agent_temp=""
if [ -n "$previous_launch_agent" ]; then
  rm -f "$previous_launch_agent"
  previous_launch_agent=""
fi
afternote_remove_legacy_telemetry_state

printf 'Installed Afternote Local %s at %s\n' "$version" "$version_root"
