#!/bin/sh

CONFIG_PATH=".MAIN/game-studio/studio.config.json"

echo "=== MAIN Game Studio ==="

if [ -f "$CONFIG_PATH" ]; then
  ENGINE=$(grep -oE '"engine"[[:space:]]*:[[:space:]]*"[^"]+"' "$CONFIG_PATH" | head -1 | sed 's/.*"engine"[[:space:]]*:[[:space:]]*"//;s/"$//')
  REVIEW=$(grep -oE '"reviewMode"[[:space:]]*:[[:space:]]*"[^"]+"' "$CONFIG_PATH" | head -1 | sed 's/.*"reviewMode"[[:space:]]*:[[:space:]]*"//;s/"$//')
  AGENT=$(grep -oE '"activeStudioAgent"[[:space:]]*:[[:space:]]*"[^"]+"' "$CONFIG_PATH" | head -1 | sed 's/.*"activeStudioAgent"[[:space:]]*:[[:space:]]*"//;s/"$//')

  echo "Pack: Game Studio"
  echo "Engine: ${ENGINE:-unconfigured}"
  echo "Review mode: ${REVIEW:-lean}"
  echo "Active specialist: ${AGENT:-studio_auto}"
else
  echo "Game Studio pack not initialized yet."
  echo "Use the UI action or run /start in Game Studio mode."
fi
