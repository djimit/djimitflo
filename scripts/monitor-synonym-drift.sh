#!/bin/bash
# Synonym drift monitor — bash version
# Usage: monitor-synonym-drift.sh <specs_dir> <source_dir>

SPECS_DIR="${1:-specs}"
SOURCE_DIR="${2:-packages}"
VIOLATIONS=0
TERMS_CHECKED=0

echo "=== Synonym Drift Monitor ==="
echo "Specs: $SPECS_DIR"
echo "Source: $SOURCE_DIR"
echo ""

# Extract banned terms from all domain-terms.md files
for glossary in "$SPECS_DIR"/**/domain-terms.md; do
  [ -f "$glossary" ] || continue

  BC=$(basename "$(dirname "$glossary")")

  # Extract Aliases to AVOID
  BANNED=$(grep "Aliases to AVOID:" "$glossary" | sed 's/Aliases to AVOID://')

  IFS=',' read -ra TERMS <<< "$BANNED"
  for term in "${TERMS[@]}"; do
    term=$(echo "$term" | xargs)  # trim
    [ -z "$term" ] && continue
    TERMS_CHECKED=$((TERMS_CHECKED + 1))

    # Grep source for this term
    MATCHES=$(grep -rn "\b${term}\b" "$SOURCE_DIR/" --include="*.ts" 2>/dev/null || true)
    if [ -n "$MATCHES" ]; then
      echo "VIOLATION: '$term' (BC: $BC) found in:"
      echo "$MATCHES" | head -3
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
done

echo "=== Summary ==="
echo "Terms checked: $TERMS_CHECKED"
echo "Violations: $VIOLATIONS"

exit $VIOLATIONS
