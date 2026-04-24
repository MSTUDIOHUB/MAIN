#!/bin/sh

INPUT=$(cat)
TARGET=$(echo "$INPUT" | grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"path"[[:space:]]*:[[:space:]]*"//;s/"$//')

if [ -z "$TARGET" ]; then
  exit 0
fi

NORMALIZED=$(echo "$TARGET" | sed 's|\\|/|g')

if ! echo "$NORMALIZED" | grep -qE '(^|/)assets/'; then
  exit 0
fi

if echo "$NORMALIZED" | grep -qE '(^|/)assets/data/.*\.json$' && [ -f "$NORMALIZED" ]; then
  PYTHON_CMD=""
  for cmd in python3 python py; do
    if command -v "$cmd" >/dev/null 2>&1; then
      PYTHON_CMD="$cmd"
      break
    fi
  done

  if [ -n "$PYTHON_CMD" ] && ! "$PYTHON_CMD" -m json.tool "$NORMALIZED" >/dev/null 2>&1; then
    printf '{"decision":"block","reason":"Asset validation failed: %s is not valid JSON."}\n' "$NORMALIZED"
    exit 0
  fi
fi

printf '{"additionalContext":"Game Studio asset check passed for %s."}\n' "$NORMALIZED"
