#!/bin/sh
set -eu

cache=$(realpath -e -- /app/asset-cache)
marker=/tmp/fieldledger-asset-snapshot

cache_build() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    target=$(realpath -e -- "$1")
    case $target in "$cache"/build.????????) ;; *) return 1 ;; esac
    [ -d "$target/assets" ] || return 1
    printf '%s\n' "$target"
  fi
}

if [ "${1:-}" = '--mark-healthy' ]; then
  exec 9>"$cache/.lock"
  flock -x 9
  snapshot=$(cat "$marker")
  current=$(cache_build "$cache/current")
  if [ -n "$current" ] && [ "$current" = "$snapshot" ] && [ "$(readlink "$cache/healthy" || true)" != "$snapshot" ]; then
    ln -sfn -- "$snapshot" "$snapshot/healthy.next"
    mv -Tf -- "$snapshot/healthy.next" "$cache/healthy"
  fi
  exit 0
fi

assets=$(realpath -e -- "${FIELDLEDGER_ASSET_SOURCE:-/app/dist/assets}")
[ -d "$assets" ]

rotate_assets() (
  exec 9>"$cache/.lock"
  flock -x 9

  previous=$(cache_build "$cache/current")
  healthy=$(cache_build "$cache/healthy")
  if [ -n "$previous" ]; then
    if diff -qr -- "$assets" "$previous/assets" >/dev/null; then
      printf '%s\n' "$previous"
      exit 0
    elif [ "$?" -ne 1 ]; then
      exit 1
    fi
  fi

  stage=$(mktemp -d "$cache/build.XXXXXXXX")
  case $stage in "$cache"/build.????????) ;; *) exit 1 ;; esac
  trap 'if [ "$(readlink "$cache/current" || true)" != "$stage" ]; then rm -rf --one-file-system -- "$stage"; fi' EXIT
  cp -R -- "$assets" "$stage/assets"
  fallback=${previous:-$healthy}
  if [ -n "$fallback" ]; then cp -al -- "$fallback/assets" "$stage/previous-assets"; fi
  if [ -n "$healthy" ] && [ "$healthy" != "$fallback" ]; then
    for file in "$healthy/assets"/*; do
      [ -f "$file" ] && [ ! -e "$stage/previous-assets/${file##*/}" ] || continue
      ln -- "$file" "$stage/previous-assets/${file##*/}"
    done
  fi
  ln -s -- "$stage" "$stage/current.next"
  mv -Tf -- "$stage/current.next" "$cache/current"

  for old in "$cache"/build.????????; do
    [ "$old" != "$stage" ] && [ "$old" != "$previous" ] && [ "$old" != "$healthy" ] && [ -d "$old" ] && [ ! -L "$old" ] || continue
    [ "$(realpath -e -- "$old")" = "$old" ] || continue
    rm -rf --one-file-system -- "$old"
  done
  printf '%s\n' "$stage"
)

asset_release=$(rotate_assets)
printf '%s\n' "$asset_release" > "$marker"
export PREVIOUS_ASSETS_DIRECTORY="$asset_release/previous-assets"
exec "$@"
