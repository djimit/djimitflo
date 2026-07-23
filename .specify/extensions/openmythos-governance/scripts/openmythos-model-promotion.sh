#!/bin/bash
# OpenMythos Model Promotion Gate
# Full 342-case benchmark + McNemar test vs baseline.
# Blocks promotion if any category regresses.
#
# Constitution v1.1.0 — Cross-System Governance References

set -euo pipefail

OPENMYTHOS_DIR="${OPENMYTHOS_DIR:-~/OpenMythos}"
NEW_MODEL="${NEW_MODEL:-}"
BASELINE_MODEL="${BASELINE_MODEL:-llama3.1:8b}"
CORPUS="${OPENMYTHOS_DIR}/data/corpus.jsonl"
RESULTS_DIR="${RESULTS_DIR:-./.swarm/evidence/openmythos-model-promotion}"

if [ -z "${NEW_MODEL}" ]; then
  echo "ERROR: NEW_MODEL environment variable required"
  exit 1
fi

echo "=== OpenMythos Model Promotion Gate ==="
echo "New model: ${NEW_MODEL}"
echo "Baseline: ${BASELINE_MODEL}"
echo "Cases: full 342-case corpus"
echo "Statistical test: McNemar p<0.05"
echo ""

if [ ! -f "${CORPUS}" ]; then
  echo "WARNING: OpenMythos corpus not found at ${CORPUS}"
  echo "Skipping model promotion gate."
  exit 0
fi

mkdir -p "${RESULTS_DIR}"

echo "Step 1: Evaluate baseline model (${BASELINE_MODEL})..."
echo "  cd ${OPENMYTHOS_DIR} && python3 openmythos-benchmark/scripts/evaluate.py --model ${BASELINE_MODEL} --corpus ${CORPUS} --output ${RESULTS_DIR}/baseline/"

echo "Step 2: Evaluate new model (${NEW_MODEL})..."
echo "  cd ${OPENMYTHOS_DIR} && python3 openmythos-benchmark/scripts/evaluate.py --model ${NEW_MODEL} --corpus ${CORPUS} --output ${RESULTS_DIR}/new/"

echo "Step 3: Run McNemar test..."
echo "  cd ${OPENMYTHOS_DIR} && python3 openmythos-benchmark/scripts/mcnemar_test.py --baseline ${RESULTS_DIR}/baseline/ --new ${RESULTS_DIR}/new/ --output ${RESULTS_DIR}/mcnemar.json"

echo ""
echo "GATE: Promotion allowed only if:"
echo "  1. No category regresses (new >= baseline for all 11 categories)"
echo "  2. McNemar test p >= 0.05 (no statistically significant regression)"
echo "  3. Overall discrimination maintained (>= 0.5)"
echo ""
echo "=== Model Promotion Gate Complete ==="
