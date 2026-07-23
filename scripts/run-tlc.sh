#!/bin/bash
# TLC Model Checking Script
# Runs TLC model checker for all TLA+ specifications
#
# Prerequisites:
#   - Java 11+
#   - tla2tools.jar (download from https://github.com/tlaplus/tlaplap)
#
# Usage: ./scripts/run-tlc.sh

set -euo pipefail

TLA_DIR="tla"
TLC_JAR="${TLC_JAR:-./tools/tla2tools.jar}"
OUTPUT_DIR=".swarm/tlc-results"

mkdir -p "$OUTPUT_DIR"

echo "============================================"
echo "TLC Model Checking — DjimFlo"
echo "============================================"

if [ ! -f "$TLC_JAR" ]; then
    echo "⚠️  tla2tools.jar not found. Downloading..."
    mkdir -p ./tools
    curl -L -o "$TLC_JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.7.3/tla2tools.jar
    echo "✅ Downloaded tla2tools.jar"
fi

run_check() {
    local spec=$1
    local config=$2
    local output="${OUTPUT_DIR}/${spec}.txt"

    echo ""
    echo "Checking ${spec}..."
    echo "  Config: ${config}"

    java -XX:+UseParallelGC -cp "$TLC_JAR" tlc2.TLC \
        -config "$config" \
        -model \
        -workers auto \
        "${TLA_DIR}/${spec}.tla" \
        > "$output" 2>&1 || true

    # Check results
    if grep -q "No error has been found" "$output"; then
        echo "  ✅ PASSED — No invariant violations"
    elif grep -q "Error" "$output"; then
        echo "  ❌ FAILED — Invariant violation found"
        grep -A5 "Error" "$output" | head -10
    else
        echo "  ⚠️  UNKNOWN — Check ${output}"
    fi

    # Extract statistics
    local states=$(grep "states generated" "$output" | tail -1 || echo "unknown")
    echo "  States: ${states}"
}

# Run all specifications
run_check "ToolBroker" "ToolBroker.cfg"
run_check "AuditChain" "AuditChain.cfg"
run_check "Recovery" "Recovery.cfg"
run_check "RBAC" "RBAC.cfg"

echo ""
echo "============================================"
echo "TLC Model Checking Complete"
echo "Results: ${OUTPUT_DIR}/"
echo "============================================"
