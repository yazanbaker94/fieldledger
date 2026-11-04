#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
temp_dir=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
sandbox=$(mktemp -d "$temp_dir/fieldledger-compose-assets-test.XXXXXXXX")
[[ $(realpath "$sandbox") == "$temp_dir"/fieldledger-compose-assets-test.* ]]
trap 'rm -rf -- "$sandbox"' EXIT
export MSYS=winsymlinks:native

cache=$sandbox/cache
mkdir -p "$cache" "$sandbox/bin"
sed -e "s|/app/asset-cache|$cache|" -e "s|/tmp/fieldledger-asset-snapshot|$sandbox/snapshot|" \
  "$source_dir/compose-entrypoint.sh" > "$sandbox/entrypoint.sh"
if grep -qE '/app/asset-cache|/tmp/fieldledger-asset-snapshot' "$sandbox/entrypoint.sh"; then
  echo 'The Compose asset test could not isolate its cache.' >&2
  exit 1
fi
if command -v flock >/dev/null; then
  has_flock=1
else
  has_flock=0
  printf '#!/bin/sh\nexit 0\n' > "$sandbox/bin/flock"
  chmod +x "$sandbox/bin/flock"
fi
export PATH="$sandbox/bin:$PATH"

for build in first000 second00 third000 fourth00; do
  mkdir "$sandbox/$build"
  printf 'compiled %s\n' "$build" > "$sandbox/$build/index-$build.js"
  printf 'style %s\n' "$build" > "$sandbox/$build/index-$build.css"
done

start() {
  local build=$1
  shift
  FIELDLEDGER_ASSET_SOURCE="$sandbox/$build" sh "$sandbox/entrypoint.sh" "$@"
}

snapshot() {
  start "$1" sh -c 'printf "%s\n" "$PREVIOUS_ASSETS_DIRECTORY"'
}

mark_healthy() {
  sh "$sandbox/entrypoint.sh" --mark-healthy
}

first=$(snapshot first000)
[[ ! -e "$first" ]]
mark_healthy
[[ $(realpath "$cache/healthy") == "${first%/*}" ]]
if start second00 false; then
  echo 'Expected candidate startup to fail.' >&2
  exit 1
fi
[[ $(realpath "$cache/healthy") == "${first%/*}" ]]
if (( has_flock )); then
  snapshot second00 > "$sandbox/started-a" &
  first_start=$!
  snapshot second00 > "$sandbox/started-b" &
  second_start=$!
  wait "$first_start" "$second_start"
  cmp "$sandbox/started-a" "$sandbox/started-b"
  second=$(cat "$sandbox/started-a")
else
  second=$(snapshot second00)
fi
cmp "$sandbox/first000/index-first000.js" "$second/index-first000.js"
cmp "$sandbox/first000/index-first000.css" "$second/index-first000.css"
[[ $(snapshot second00) == "$second" ]]
if snapshot missing; then
  echo 'Expected a missing asset source to fail.' >&2
  exit 1
fi
[[ $(realpath "$cache/current") == "${second%/*}" ]]
third=$(snapshot third000)
cmp "$sandbox/second00/index-second00.js" "$third/index-second00.js"
cmp "$sandbox/first000/index-first000.js" "$third/index-first000.js"
mark_healthy
printf '%s\n' "${second%/*}" > "$sandbox/snapshot"
mark_healthy
[[ $(realpath "$cache/healthy") == "${third%/*}" ]]
fourth=$(snapshot fourth00)
cmp "$sandbox/third000/index-third000.js" "$fourth/index-third000.js"
[[ ! -e "${first%/*}" && ! -e "${second%/*}" && -d "${third%/*}" && ! -e "$fourth/index-first000.js" ]]

echo 'Compose asset cache tests passed.'
