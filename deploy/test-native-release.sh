#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temp_dir=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
sandbox=$(mktemp -d "$temp_dir/fieldledger-release-test.XXXXXXXX")
[[ $(realpath "$sandbox") == "$temp_dir"/fieldledger-release-test.* ]]
trap 'rm -rf -- "$sandbox"' EXIT
export MSYS=winsymlinks:native
export REAL_FLOCK
REAL_FLOCK=$(command -v flock || true)
bin=$sandbox/bin
fixture=$sandbox/fixture
mkdir -p "$bin" "$fixture/deploy" "$fixture/server"

cat > "$bin/mock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case ${0##*/} in
  sudo) shift; exec "$@" ;;
  npm)
    if [[ $* == 'run build' ]]; then
      mkdir -p dist/assets node_modules
      printf 'compiled %s\n' "$BUILD_ASSET" > "dist/assets/index-$BUILD_ASSET.js"
      printf 'style %s\n' "$BUILD_ASSET" > "dist/assets/index-$BUILD_ASSET.css"
      printf 'private build metadata\n' > "dist/assets/debug_$BUILD_ASSET.txt"
      printf '<script src="/assets/index-%s.js"></script>\n<link href="/assets/index-%s.css" rel="stylesheet">\n' \
        "$BUILD_ASSET" "$BUILD_ASSET" > dist/index.html
    fi
    ;;
  systemd-analyze) [[ $FAIL_PHASE != validation ]] ;;
  sleep) : ;;
  flock)
    [[ $* == '--exclusive 9' ]]
    printf 'lock\n' >> "$TEST_STATE/events"
    if [[ -n $REAL_FLOCK ]]; then exec "$REAL_FLOCK" "$@"; fi
    ;;
  systemctl)
    if [[ -n $REAL_FLOCK ]] && "$REAL_FLOCK" --nonblock "$TEST_APP/deploy.lock" true; then
      echo 'systemctl called outside the deploy lock' >&2
      exit 90
    fi
    case $1 in
      is-active) [[ -f "$TEST_STATE/active" ]] ;;
      daemon-reload) : ;;
      stop) rm -f "$TEST_STATE/active" ;;
      restart)
        printf 'restart\n' >> "$TEST_STATE/events"
        if [[ $FAIL_PHASE == restart ]] && grep -q 'candidate' "$TEST_UNIT"; then exit 1; fi
        touch "$TEST_STATE/active"
        ;;
      enable) touch "$TEST_STATE/enabled"; [[ $FAIL_PHASE != enable ]] ;;
      disable) rm -f "$TEST_STATE/enabled" ;;
      *) exit 99 ;;
    esac
    ;;
  curl)
    url=${*: -1}
    case $url in
      */api/health)
        if [[ $FAIL_PHASE == health ]] && grep -q 'candidate' "$TEST_UNIT"; then
          "$0" http://127.0.0.1:3088/ > "$TEST_STATE/browser.html"
          exit 22
        fi
        ;;
      */assets/*)
        asset=${url##*/}
        if [[ -f "$TEST_APP/current/dist/assets/$asset" ]]; then
          cat "$TEST_APP/current/dist/assets/$asset"
        elif [[ -f "$TEST_APP/current/previous-assets/$asset" ]]; then
          cat "$TEST_APP/current/previous-assets/$asset"
        else
          exit 22
        fi
        ;;
      */)
        if [[ $FAIL_PHASE == page ]] && grep -q 'candidate' "$TEST_UNIT"; then exit 22; fi
        cat "$TEST_APP/current/dist/index.html"
        ;;
    esac
    ;;
  *) exit 99 ;;
esac
EOF
for command in sudo npm systemd-analyze sleep flock systemctl curl; do
  cp "$bin/mock" "$bin/$command"
  chmod +x "$bin/$command"
done

printf '[Unit]\nDescription=candidate\n' > "$fixture/deploy/fieldledger.service"
touch "$fixture/server/index.ts" "$fixture/package.json" "$fixture/tsconfig.json"
git -C "$fixture" init --quiet
git -C "$fixture" -c core.autocrlf=false add .
git -C "$fixture" -c user.name=DeployTest -c user.email=deploy@example.invalid commit -qm fixture

export TEST_STATE TEST_APP TEST_UNIT FAIL_PHASE BUILD_ASSET
run_release() {
  local scenario=$1
  FAIL_PHASE=$2
  BUILD_ASSET=${3:-failed000}
  TEST_STATE=$sandbox/$scenario
  TEST_APP=$TEST_STATE/app
  TEST_UNIT=$TEST_STATE/fieldledger.service
  mkdir -p "$TEST_STATE"
  sed -e "s|^app_root=/opt/fieldledger$|app_root='$TEST_APP'|" \
    -e "s|^unit=/etc/systemd/system/fieldledger.service$|unit='$TEST_UNIT'|" \
    -e "s|/tmp/fieldledger-release\.XXXXXXXX|$sandbox/stage.XXXXXXXX|" \
    "$source_dir/native-release.sh" > "$TEST_STATE/deploy.sh"
  if grep -qE '^app_root=/opt/|^unit=/etc/|/tmp/fieldledger-release\.XXXXXXXX' "$TEST_STATE/deploy.sh"; then
    echo 'The deployment test could not isolate the target paths.' >&2
    exit 1
  fi
  (cd "$fixture" && PATH="$bin:$PATH" bash "$TEST_STATE/deploy.sh" HEAD)
}

expect_failure() {
  if run_release "$@"; then
    echo "Expected deployment to fail at $2" >&2
    exit 1
  fi
}

run_release update none first000
[[ -f "$TEST_STATE/active" && -f "$TEST_STATE/enabled" ]]
[[ ! -e "$TEST_APP/current/previous-assets" ]]
first=$(readlink "$TEST_APP/current")
run_release update none second00
[[ -f "$TEST_STATE/active" && -f "$TEST_STATE/enabled" ]]
cmp "$first/dist/assets/index-first000.js" "$TEST_APP/current/previous-assets/index-first000.js"
second=$(readlink "$TEST_APP/current")
run_release update none second00
repeat=$(readlink "$TEST_APP/current")
[[ -d "$second" && ! -e "$first" ]]
printf 'compiled first000\n' | cmp - "$repeat/previous-assets/index-first000.js"
[[ ! -e "$repeat/previous-assets/index-second00.js" ]]
mkdir -p "$TEST_STATE/untouched" "$TEST_APP/releases/manual-backup"
ln -s "$TEST_STATE/untouched" "$first"
rm "$TEST_STATE/active" "$TEST_STATE/enabled"
run_release update none third000
[[ -f "$TEST_STATE/active" && ! -e "$TEST_STATE/enabled" ]]
[[ ! -e "$second" && -d "$repeat" ]]
[[ -L "$first" && -d "$TEST_STATE/untouched" && -d "$TEST_APP/releases/manual-backup" ]]
cmp "$repeat/dist/assets/index-second00.js" "$TEST_APP/current/previous-assets/index-second00.js"
[[ ! -e "$TEST_APP/current/previous-assets/index-first000.js" ]]
previous=$(readlink "$TEST_APP/current")
printf '[Unit]\nDescription=previous\n' > "$TEST_UNIT"
previous_failed=''
for phase in validation restart page health; do
  case $phase in
    validation) failed_asset=badbuild ;;
    restart) failed_asset=restart0 ;;
    page) failed_asset=badpage0 ;;
    health) failed_asset=badhlth0 ;;
  esac
  expect_failure update "$phase" "$failed_asset"
  [[ $(readlink "$TEST_APP/current") == "$previous" ]]
  grep -q 'Description=previous' "$TEST_UNIT"
  cmp "$repeat/dist/assets/index-second00.js" "$TEST_APP/current/previous-assets/index-second00.js"
  if [[ $phase == validation ]]; then
    [[ ! -e "$TEST_APP/current/previous-assets/index-$failed_asset.js" ]]
  else
    printf 'compiled %s\n' "$failed_asset" | cmp - "$TEST_APP/current/previous-assets/index-$failed_asset.js"
    printf 'style %s\n' "$failed_asset" | cmp - "$TEST_APP/current/previous-assets/index-$failed_asset.css"
    [[ ! -e "$TEST_APP/current/previous-assets/debug_$failed_asset.txt" ]]
    if [[ -n "$previous_failed" ]]; then
      [[ ! -e "$TEST_APP/current/previous-assets/index-$previous_failed.js" ]]
    fi
    previous_failed=$failed_asset
  fi
  [[ -f "$TEST_STATE/active" && ! -e "$TEST_STATE/enabled" ]]
  [[ $(find "$TEST_APP/releases" -mindepth 1 -maxdepth 1 -type d | wc -l) -eq 3 ]]
done

grep -q '/assets/index-badhlth0.js' "$TEST_STATE/browser.html"
grep -q '/assets/index-badhlth0.css' "$TEST_STATE/browser.html"
"$bin/curl" http://127.0.0.1:3088/ | grep -q '/assets/index-third000.js'
"$bin/curl" http://127.0.0.1:3088/assets/index-badhlth0.js | cmp - "$TEST_APP/current/previous-assets/index-badhlth0.js"
"$bin/curl" http://127.0.0.1:3088/assets/index-badhlth0.css | cmp - "$TEST_APP/current/previous-assets/index-badhlth0.css"
run_release update none third000
printf 'compiled second00\n' | cmp - "$TEST_APP/current/previous-assets/index-second00.js"
[[ ! -e "$TEST_APP/current/previous-assets/index-badhlth0.js" ]]

for phase in restart enable; do
  expect_failure "first-$phase" "$phase"
  [[ ! -e "$TEST_UNIT" && ! -e "$TEST_UNIT.next" && ! -L "$TEST_APP/current" && ! -L "$TEST_APP/current.next" ]]
  [[ ! -e "$TEST_STATE/active" && ! -e "$TEST_STATE/enabled" ]]
  [[ -z $(find "$TEST_APP/releases" -mindepth 1 -maxdepth 1 -print -quit) ]]
done

echo 'Native deployment tests passed.'
