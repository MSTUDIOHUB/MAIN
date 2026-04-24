#!/bin/sh

INPUT=$(cat)
TARGET=$(echo "$INPUT" | grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/"$//')

if [ -z "$TARGET" ]; then
  exit 0
fi

NORMALIZED=$(echo "$TARGET" | sed 's|\\|/|g')

if echo "$NORMALIZED" | grep -qE '(^|/)\.MAIN/templates/game-studio/'; then
  printf '{"additionalContext":"Game Studio reminder: template changes usually deserve a quick /design-review or /gate-check pass."}\n'
  exit 0
fi

if echo "$NORMALIZED" | grep -qE '(^|/)\.protocols/game-studio/'; then
  printf '{"additionalContext":"Game Studio reminder: protocol edits can affect command behavior. Consider /skill-test or /consistency-check."}\n'
  exit 0
fi

exit 0
