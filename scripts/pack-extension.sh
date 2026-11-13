#!/bin/sh
# Builds the Chrome Web Store zip from extension/, named after the manifest's version:
#   scripts/pack-extension.sh   ->   copperos-<version>.zip in the repo root
# Leaves out dev-stage.json (dev's settings, for unpacked copies only), its example and .DS_Store.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./extension/manifest.json").version')
out="$PWD/copperos-$version.zip"
rm -f "$out"
(cd extension && zip -qr "$out" . -x 'dev-stage.json' 'dev-stage.example.json' '*.DS_Store')
if unzip -Z1 "$out" | grep -q 'dev-stage'; then
  rm -f "$out"
  echo "dev-stage file got into the zip; nothing written" >&2
  exit 1
fi
echo "$out ($(unzip -Z1 "$out" | grep -vc '/$') files)"
