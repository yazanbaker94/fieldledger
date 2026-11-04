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

restore_previous() {
  local failed=0
  if (( service_touched )); then
    sudo -n systemctl stop fieldledger.service || failed=1
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
