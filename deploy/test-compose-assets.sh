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
sed "s|/app/asset-cache|$cache|" "$source_dir/compose-entrypoint.sh" > "$sandbox/entrypoint.sh"
if grep -q /app/asset-cache "$sandbox/entrypoint.sh"; then
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

for build in first000 second00 third000; do
  mkdir "$sandbox/$build"
  printf 'compiled %s\n' "$build" > "$sandbox/$build/index-$build.js"
  printf 'style %s\n' "$build" > "$sandbox/$build/index-$build.css"
done

start() {
  PATH="$sandbox/bin:$PATH" FIELDLEDGER_ASSET_SOURCE="$sandbox/$1" sh "$sandbox/entrypoint.sh" sh -c 'printf "%s\n" "$PREVIOUS_ASSETS_DIRECTORY"'
}

first=$(start first000)
[[ ! -e "$first" ]]
if (( has_flock )); then
  start second00 > "$sandbox/started-a" &
  first_start=$!
  start second00 > "$sandbox/started-b" &
  second_start=$!
  wait "$first_start" "$second_start"
  cmp "$sandbox/started-a" "$sandbox/started-b"
  second=$(cat "$sandbox/started-a")
else
  second=$(start second00)
fi
cmp "$sandbox/first000/index-first000.js" "$second/index-first000.js"
cmp "$sandbox/first000/index-first000.css" "$second/index-first000.css"
[[ $(start second00) == "$second" ]]
if start missing; then
  echo 'Expected a missing asset source to fail.' >&2
  exit 1
fi
[[ $(realpath "$cache/current") == "${second%/*}" ]]
third=$(start third000)
cmp "$sandbox/second00/index-second00.js" "$third/index-second00.js"
[[ ! -e "${first%/*}" && -d "${second%/*}" && ! -e "$third/index-first000.js" ]]

echo 'Compose asset cache tests passed.'
