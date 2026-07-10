#!/bin/sh

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | grep -oE '"toolName"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"toolName"[[:space:]]*:[[:space:]]*"//;s/"$//')
COMMAND=$(echo "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//')

case "$TOOL_NAME" in
  execute_command|run_command) ;;
  *) exit 0 ;;
esac

if [ -z "$COMMAND" ]; then
  exit 0
fi

if echo "$COMMAND" | grep -qE '^git[[:space:]]+push([[:space:]].*)?[[:space:]]+--force'; then
  printf '{"decision":"block","reason":"Game Studio guard blocked a force-push command."}\n'
  exit 0
fi

if echo "$COMMAND" | grep -qE '^git[[:space:]]+reset[[:space:]]+--hard'; then
  printf '{"decision":"block","reason":"Game Studio guard blocked git reset --hard."}\n'
  exit 0
fi

if echo "$COMMAND" | grep -qE '^git[[:space:]]+push'; then
  printf '{"additionalContext":"Game Studio reminder: run /release-checklist or /gate-check before pushing a milestone branch."}\n'
  exit 0
fi

exit 0
