#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'Usage: bash deploy/native-release.sh <reviewed revision>' >&2
  exit 2
fi

revision=$(git rev-parse --verify --end-of-options "$1^{commit}")
stage=$(mktemp -d /tmp/fieldledger-release.XXXXXXXX)
app_root=/opt/fieldledger
unit=/etc/systemd/system/fieldledger.service
current=$app_root/current
previous_unit=''
release=''
previous=''
previous_release=''
changes_started=0
service_touched=0
was_active=0
enable_attempted=0

activate() {
  sudo -n ln -sfn "$1" "$current.next" && sudo -n mv -Tf "$current.next" "$current"
}

install_unit() {
  sudo -n install -m 0644 "$1" "$unit.next" && sudo -n mv -Tf "$unit.next" "$unit"
}

wait_for_health() {
  local attempt
  for attempt in {1..20}; do
    if systemctl is-active --quiet fieldledger.service &&
      curl --silent --fail --max-time 2 http://127.0.0.1:3088/api/health >/dev/null &&
      curl --silent --fail --max-time 2 http://127.0.0.1:3088/ >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

preserve_failed_assets() (
  local root assets baseline scratch file name cleanup=1
  [[ -n "$previous_release" && -d "$release/dist/assets" ]] || exit 0
  root=$(realpath -e -- "$app_root/releases") || exit 1
  [[ ${previous_release%/*} == "$root" ]] || exit 1
  assets=$previous_release/previous-assets
  baseline=$previous_release/previous-distinct-assets
  [[ ! -L "$assets" && ! -L "$baseline" ]] || exit 1
  scratch=$(sudo -n mktemp -d "$previous_release/.rollback-assets.XXXXXXXX") || exit 1
  [[ $(realpath -e -- "$scratch") == "$previous_release"/.rollback-assets.* ]] || exit 1
  trap 'if (( cleanup )); then sudo -n rm -rf --one-file-system -- "$scratch"; fi' EXIT

  # Keep the healthy fallback separately so another failed deployment can replace this one.
  if [[ ! -d "$baseline" ]]; then
    if [[ -d "$assets" ]]; then
      sudo -n cp -al -- "$assets" "$scratch/baseline" || exit 1
    else
      sudo -n install -d -m 0755 "$scratch/baseline" || exit 1
    fi
    sudo -n mv -T -- "$scratch/baseline" "$baseline" || exit 1
  fi
  sudo -n cp -al -- "$baseline" "$scratch/combined" || exit 1
  for file in "$release/dist/assets"/*; do
    name=${file##*/}
    [[ $name =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*-[a-zA-Z0-9_-]{8}\.[a-zA-Z0-9]+$ && -f "$file" && ! -L "$file" ]] || continue
    [[ ! -e "$scratch/combined/$name" ]] || continue
    sudo -n ln -- "$file" "$scratch/combined/$name" || exit 1
  done
  if [[ -d "$assets" ]]; then
    sudo -n mv -T -- "$assets" "$scratch/original" || exit 1
  fi
  if ! sudo -n mv -T -- "$scratch/combined" "$assets"; then
    if [[ -d "$scratch/original" ]] && ! sudo -n mv -T -- "$scratch/original" "$assets"; then
      echo "Could not restore the original asset fallback from $scratch/original." >&2
      cleanup=0
    fi
    exit 1
  fi
)

restore_previous() {
  local failed=0
  if (( service_touched )); then
    sudo -n systemctl stop fieldledger.service || failed=1
    if (( ! failed )) && ! preserve_failed_assets; then
      echo 'Could not preserve the failed release asset fallback.' >&2
    fi
  fi
  if (( enable_attempted )); then
    sudo -n systemctl disable fieldledger.service || failed=1
  fi
  if [[ -n "$previous_unit" ]]; then
    install_unit "$previous_unit" || failed=1
  else
    sudo -n rm -f -- "$unit" || failed=1
  fi
  if [[ -n "$previous" ]]; then
    activate "$previous" || failed=1
  else
    sudo -n rm -f -- "$current" || failed=1
  fi
  sudo -n rm -f -- "$unit.next" "$current.next" || failed=1
  sudo -n systemctl daemon-reload || failed=1
  if (( was_active && service_touched && ! failed )); then
    sudo -n systemctl restart fieldledger.service && wait_for_health || failed=1
  fi
  return "$failed"
}

prune_releases() {
  local root active candidate name resolved failed=0
  [[ ! -L "$app_root/releases" ]] || return 1
  root=$(realpath -e -- "$app_root/releases") || return 1
  active=$(realpath -e -- "$current") || return 1
  [[ $active == "$root/${release##*/}" ]] || return 1
  for candidate in "$root"/*; do
    name=${candidate##*/}
    [[ $name =~ ^([0-9a-f]{40}|[0-9a-f]{64})\.[a-zA-Z0-9]{8}$ && -d "$candidate" && ! -L "$candidate" ]] || continue
    resolved=$(realpath -e -- "$candidate") || return 1
    [[ $resolved == "$root/$name" ]] || continue
    [[ $resolved != "$active" && $resolved != "$previous_release" ]] || continue
    sudo -n rm -rf --one-file-system -- "$resolved" || failed=1
  done
  return "$failed"
}

finish() {
  local status=$? recovered=1
  trap - EXIT
  trap '' INT TERM
  if (( status != 0 && changes_started )); then
    if restore_previous; then
      echo 'Restored the previous FieldLedger service and release state.' >&2
    else
      echo "FieldLedger rollback failed. Recovery files remain in $stage." >&2
      recovered=0
    fi
  fi
  if (( status != 0 && recovered )) && [[ -n "$release" ]]; then
    sudo -n rm -rf -- "$release" || echo "Could not remove failed release $release." >&2
  fi
  if (( status == 0 )); then
    prune_releases || echo 'Could not clean up all older FieldLedger releases.' >&2
  fi
  if (( recovered )); then
    rm -rf -- "$stage" || true
  fi
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git archive "$revision" | tar -xf - -C "$stage"
(
  cd "$stage"
  npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
)
systemd-analyze verify "$stage/deploy/fieldledger.service"

sudo -n install -d -m 0755 "$app_root/releases"
sudo -n touch "$app_root/deploy.lock"
sudo -n chmod 0644 "$app_root/deploy.lock"
exec 9< "$app_root/deploy.lock"
flock --exclusive 9

if [[ -L "$unit" || ( -e "$unit" && ! -f "$unit" ) ]]; then
  echo 'The FieldLedger unit is not a regular file. Repair it before deploying.' >&2
  exit 1
fi
if [[ -e "$current" || -L "$current" ]]; then
  previous=$(readlink "$current")
  if [[ ! -d "$current" || ! -f "$unit" ]]; then
    echo 'The current FieldLedger release or service unit is missing. Repair it before deploying.' >&2
    exit 1
  fi
  previous_release=$(realpath -e -- "$current")
fi
if [[ -f "$unit" ]]; then
  recovery=$(mktemp -d "$stage/rollback.XXXXXXXX")
  previous_unit=$recovery/fieldledger.service
  sudo -n cp -- "$unit" "$previous_unit"
fi
if systemctl is-active --quiet fieldledger.service; then
  if [[ -z "$previous" || -z "$previous_unit" ]]; then
    echo 'The running FieldLedger service has no recoverable release. Repair it before deploying.' >&2
    exit 1
  fi
  was_active=1
fi

release=$(sudo -n mktemp -d "$app_root/releases/$revision.XXXXXXXX")
sudo -n cp -a --no-preserve=ownership "$stage"/{dist,node_modules,server,package.json,tsconfig.json} "$release/"
if [[ -d "$current/dist/assets" ]]; then
  previous_assets=$current/dist/assets
  if diff -qr -- "$stage/dist/assets" "$previous_assets" >/dev/null; then
    previous_assets=$current/previous-assets
    if [[ -d "$current/previous-distinct-assets" ]]; then
      previous_assets=$current/previous-distinct-assets
    fi
  elif [[ $? != 1 ]]; then
    echo 'Could not compare the FieldLedger builds.' >&2
    exit 1
  fi
  if [[ -d "$previous_assets" ]]; then
    sudo -n cp -al -- "$previous_assets" "$release/previous-assets"
  fi
fi
sudo -n chmod 0755 "$release"
changes_started=1
install_unit "$stage/deploy/fieldledger.service"
activate "$release"
sudo -n systemctl daemon-reload
service_touched=1
if ! sudo -n systemctl restart fieldledger.service || ! wait_for_health; then
  echo 'FieldLedger did not become healthy. Check journalctl -u fieldledger.service.' >&2
  exit 1
fi
if [[ -z "$previous_unit" ]]; then
  enable_attempted=1
  sudo -n systemctl enable fieldledger.service
fi
echo "FieldLedger is healthy at revision $revision"
