#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="MAIN"
APP_VERSION="$(node -e "process.stdout.write(require('$ROOT_DIR/package.json').version)")"
APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
ZIP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/${APP_NAME}-${APP_VERSION}-macOS-unsigned-share.zip"

clean_xattrs() {
  for path in "$@"; do
    if [[ -e "$path" ]]; then
      xattr -cr "$path" || true
    fi
  done
}

# Keep quarantined source assets out of the generated app bundle.
clean_xattrs \
  "$ROOT_DIR/public/LogoM.png" \
  "$ROOT_DIR/public/LogoM_app.svg" \
  "$ROOT_DIR/public/logoM_black.svg" \
  "$ROOT_DIR/src-tauri/icons"

npm run icon:app
npm run tauri build -- --bundles app --no-sign

clean_xattrs "$APP_PATH"

# Re-sign the finished app with an ad-hoc signature so the bundle is internally consistent.
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

if [[ -f "$ZIP_PATH" ]]; then
  rm -f "$ZIP_PATH"
fi

ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

cat <<EOF
Created unsigned share package:
  $ZIP_PATH

Notes:
- This build is ad-hoc signed, not Developer ID signed.
- Friends should unzip it first and move MAIN.app into /Applications.
- If macOS still blocks launch, they may need:
  xattr -dr com.apple.quarantine /Applications/MAIN.app
EOF
