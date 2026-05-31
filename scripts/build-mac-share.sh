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
cargo clean -p tauri-app --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml"
npm run tauri build -- --bundles app --no-sign

BUNDLE_EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_PATH/Contents/Info.plist")"
BUNDLE_EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$BUNDLE_EXECUTABLE_NAME"

# Tauri's macOS bundler can leave the built desktop binary under its Cargo target
# name while Info.plist points at mainBinaryName. Rename the bundled binary in
# place so we keep Tauri's embedded frontend assets and signing metadata.
bundled_bins=()
while IFS= read -r bundled_bin; do
  bundled_bins+=("$bundled_bin")
done < <(find "$APP_PATH/Contents/MacOS" -mindepth 1 -maxdepth 1 -type f -perm +111 | sort)

if [[ "${#bundled_bins[@]}" -ne 1 ]]; then
  printf "Expected exactly one bundled executable in %s, found %s\n" "$APP_PATH/Contents/MacOS" "${#bundled_bins[@]}" >&2
  exit 1
fi

BUNDLED_EXECUTABLE_PATH="${bundled_bins[0]}"
BUNDLED_EXECUTABLE_NAME="$(basename "$BUNDLED_EXECUTABLE_PATH")"
if [[ "$BUNDLED_EXECUTABLE_NAME" != "$BUNDLE_EXECUTABLE_NAME" ]]; then
  TEMP_EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/.${BUNDLE_EXECUTABLE_NAME}.rename-tmp"
  rm -f "$TEMP_EXECUTABLE_PATH"
  mv "$BUNDLED_EXECUTABLE_PATH" "$TEMP_EXECUTABLE_PATH"
  mv "$TEMP_EXECUTABLE_PATH" "$BUNDLE_EXECUTABLE_PATH"
fi
chmod 755 "$BUNDLE_EXECUTABLE_PATH"

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
