#!/usr/bin/env bash
set -euo pipefail

if [[ ${RUNNER_ENVIRONMENT:-} != github-hosted || $(ps -p 1 -o comm=) != systemd ]]; then
  echo 'Run this systemd test on a disposable GitHub-hosted Linux runner.' >&2
  exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fixture=$(mktemp -d /tmp/fieldledger-systemd-test.XXXXXXXX)
app=fieldledger-test-app-$$.service
db=fieldledger-test-db-$$.service
unit_dir=/run/systemd/system
cleanup() {
  sudo -n systemctl stop "$app" "$db" || true
  sudo -n rm -f -- "$unit_dir/$app" "$unit_dir/$db"
  sudo -n systemctl daemon-reload
  rm -f -- "$fixture/$app" "$fixture/$db"
  rmdir "$fixture"
}
trap cleanup EXIT

sed -e "s/postgresql\.service/$db/g" \
  -e '/^\(User\|Group\|WorkingDirectory\|Environment\)=/d' \
  -e 's|^ExecStart=.*|ExecStart=/usr/bin/sleep infinity|' \
  "$source_dir/fieldledger.service" > "$fixture/$app"
printf '[Service]\nType=exec\nExecStart=/usr/bin/sleep infinity\n' > "$fixture/$db"
systemd-analyze verify "$fixture/$app" "$fixture/$db"
sudo -n install -m 0644 "$fixture/$app" "$fixture/$db" "$unit_dir/"
sudo -n systemctl daemon-reload

sudo -n systemctl start "$app"
systemctl is-active --quiet "$app"
systemctl is-active --quiet "$db"
app_start=$(systemctl show --property=ExecMainStartTimestampMonotonic --value "$app")
db_start=$(systemctl show --property=ExecMainStartTimestampMonotonic --value "$db")
(( db_start > 0 && app_start >= db_start ))
[[ $(systemctl show --property=Restart --value "$app") == on-failure ]]
[[ $(systemctl show --property=RestartUSec --value "$app") == 3s ]]

app_pid=$(systemctl show --property=MainPID --value "$app")
sudo -n systemctl stop "$db"
systemctl is-active --quiet "$app"
sudo -n systemctl start "$db"
systemctl is-active --quiet "$db"
[[ $(systemctl show --property=MainPID --value "$app") == "$app_pid" ]]
echo 'FieldLedger started after its database and stayed running through a database stop and start.'
