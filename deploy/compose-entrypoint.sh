#!/bin/sh
set -eu

cache=$(realpath -e -- /app/asset-cache)
assets=$(realpath -e -- "${FIELDLEDGER_ASSET_SOURCE:-/app/dist/assets}")
[ -d "$assets" ]

rotate_assets() (
  exec 9>"$cache/.lock"
  flock -x 9

  previous=''
  if [ -e "$cache/current" ] || [ -L "$cache/current" ]; then
    previous=$(realpath -e -- "$cache/current")
    case $previous in "$cache"/build.????????) ;; *) exit 1 ;; esac
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
  if [ -n "$previous" ]; then cp -al -- "$previous/assets" "$stage/previous-assets"; fi
  ln -s -- "$stage" "$stage/current.next"
  mv -Tf -- "$stage/current.next" "$cache/current"

  for old in "$cache"/build.????????; do
    [ "$old" != "$stage" ] && [ "$old" != "$previous" ] && [ -d "$old" ] && [ ! -L "$old" ] || continue
    [ "$(realpath -e -- "$old")" = "$old" ] || continue
    rm -rf --one-file-system -- "$old"
  done
  printf '%s\n' "$stage"
)

asset_release=$(rotate_assets)
export PREVIOUS_ASSETS_DIRECTORY="$asset_release/previous-assets"
exec "$@"
