#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Error: Please specify the version to release."
  echo "Example: ./release-mac.sh 2.1.9"
  exit 1
fi

VERSION="$1"
echo "Starting macOS release process for version $VERSION..."

if [ ! -d "node_modules" ]; then
  echo "node_modules not found, running npm install..."
  npm install
fi

npm run release:mac:upload -- "$VERSION"
