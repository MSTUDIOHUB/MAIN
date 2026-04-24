#!/bin/sh

SOURCE_COUNT=0
DESIGN_COUNT=0

if [ -d "src" ]; then
  SOURCE_COUNT=$(find src -type f \( -name "*.gd" -o -name "*.cs" -o -name "*.cpp" -o -name "*.c" -o -name "*.h" -o -name "*.hpp" -o -name "*.rs" -o -name "*.py" -o -name "*.js" -o -name "*.ts" \) 2>/dev/null | wc -l | tr -d ' ')
fi

if [ -d "design" ]; then
  DESIGN_COUNT=$(find design -type f -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
fi

echo "=== Game Studio Gap Scan ==="

if [ "$SOURCE_COUNT" -eq 0 ] && [ "$DESIGN_COUNT" -eq 0 ]; then
  echo "Fresh workspace detected. Recommended first step: /start"
  exit 0
fi

if [ "$SOURCE_COUNT" -gt 20 ] && [ "$DESIGN_COUNT" -lt 3 ]; then
  echo "Large codebase with sparse design docs detected."
  echo "Consider /project-stage-detect or /reverse-document."
fi

if [ -d "prototypes" ]; then
  PROTOTYPE_COUNT=$(find prototypes -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PROTOTYPE_COUNT" -gt 0 ]; then
    echo "Prototype folders found: $PROTOTYPE_COUNT"
  fi
fi
