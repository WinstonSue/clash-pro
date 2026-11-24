#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo 'Clash Pro 需要在 Apple Silicon Mac 上构建。' >&2
  exit 1
fi
cd "$root"
node_path=$(command -v node || true)
if [[ $node_path != /* || ! -x node_modules/.bin/tauri ]]; then
  echo '请安装 Node.js 22.12 或更新版本，再运行 npm ci。' >&2
  exit 1
fi

build_dir="$root/build"
resources="$build_dir/tauri-resources/backend"
mkdir -p "$resources/public"
"$node_path" --input-type=module -e 'import { verifyRuleAssets } from "./routing.mjs"; await verifyRuleAssets();'
cp "$root"/*.mjs "$root/package.json" "$root/package-lock.json" "$root/LICENSE" "$resources/"
cp "$root/public/"* "$resources/public/"
mkdir -p "$resources/rules-data"
cp "$root/rules-data/"* "$resources/rules-data/"
printf '%s\n' "$node_path" > "$resources/node-path.txt"
npm ci --prefix "$resources" --cache "$build_dir/npm-cache" --omit=dev --ignore-scripts --no-audit --no-fund

export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$root/src-tauri/target"}
node_modules/.bin/tauri build --target aarch64-apple-darwin --bundles app -- --locked
compiled="$CARGO_TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/Clash Pro.app"
codesign --verify --strict "$compiled"

staging=$(mktemp -d "$build_dir/.package.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
app="$build_dir/Clash Pro.app"
/usr/bin/ditto "$compiled" "$staging/Clash Pro.app"
if [[ -e $app ]]; then mv "$app" "$staging/previous.app"; fi
if ! mv "$staging/Clash Pro.app" "$app"; then
  if [[ -e $staging/previous.app ]]; then mv "$staging/previous.app" "$app"; fi
  exit 1
fi
printf '已构建 %s\n' "$app"
