#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo 'Usage: bash deploy/native-release.sh <reviewed revision>' >&2
  exit 2
fi

revision=$(git rev-parse --verify "$1^{commit}")
stage=$(mktemp -d /tmp/fieldledger-release.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
git archive "$revision" | tar -xf - -C "$stage"
(
  cd "$stage"
  npm ci --no-audit --no-fund
  npm run build
  npm prune --omit=dev --no-audit --no-fund
)

sudo -n install -d -m 0755 /opt/fieldledger/releases
release=$(sudo -n mktemp -d "/opt/fieldledger/releases/$revision.XXXXXXXX")
sudo -n cp -a --no-preserve=ownership "$stage"/{dist,node_modules,server,package.json,tsconfig.json} "$release/"
sudo -n chmod 0755 "$release"
sudo -n install -m 0644 "$stage/deploy/fieldledger.service" /etc/systemd/system/fieldledger.service
sudo -n systemctl daemon-reload

current=/opt/fieldledger/current
previous=$(readlink "$current" || true)
activate() {
  sudo -n ln -sfn "$1" "$current.next"
  sudo -n mv -Tf "$current.next" "$current"
}

activate "$release"
if sudo -n systemctl restart fieldledger.service; then
  for _ in {1..20}; do
    if curl --silent --fail --max-time 2 http://127.0.0.1:3088/api/health >/dev/null; then
      sudo -n systemctl enable fieldledger.service
      echo "FieldLedger is healthy at revision $revision"
      exit 0
    fi
    sleep 1
  done
fi

if [[ -n "$previous" ]]; then
  activate "$previous"
  sudo -n systemctl restart fieldledger.service
else
  sudo -n systemctl stop fieldledger.service
  sudo -n unlink "$current"
fi
echo 'FieldLedger did not become healthy. Check journalctl -u fieldledger.service.' >&2
exit 1
