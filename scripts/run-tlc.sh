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
TLC_SHA256="ae7a33bbe99e5a3783c28d826d20e0028fc87f5a8cc8f9520afab00eabbc0bb1"
OUTPUT_DIR=".swarm/tlc-results"
failed=0

mkdir -p "$OUTPUT_DIR"

if ! command -v java >/dev/null 2>&1; then
    echo "Java 11+ is required to run TLC." >&2
    exit 1
fi

echo "============================================"
echo "TLC Model Checking — DjimFlo"
echo "============================================"

if [ ! -f "$TLC_JAR" ]; then
    echo "⚠️  tla2tools.jar not found. Downloading..."
    mkdir -p ./tools
    curl -fsSL -o "$TLC_JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.7.3/tla2tools.jar
    echo "✅ Downloaded tla2tools.jar"
fi

echo "${TLC_SHA256}  ${TLC_JAR}" | shasum -a 256 -c -

run_check() {
    local spec=$1
    local config=$2
    local output="${OUTPUT_DIR}/${spec}.txt"

    echo ""
    echo "Checking ${spec}..."
    echo "  Config: ${config}"

    if ! java -XX:+UseParallelGC -cp "$TLC_JAR" tlc2.TLC \
        -config "$config" \
        -model \
        -workers auto \
        "${TLA_DIR}/${spec}.tla" \
        > "$output" 2>&1; then
        failed=1
    fi

    # Check results
    if grep -q "No error has been found" "$output"; then
        echo "  ✅ PASSED — No invariant violations"
    elif grep -q "Error" "$output"; then
        echo "  ❌ FAILED — Invariant violation found"
        grep -A5 "Error" "$output" | head -10
        failed=1
    else
        echo "  ⚠️  UNKNOWN — Check ${output}"
        failed=1
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
run_check "fleet" "fleet.cfg"

echo ""
echo "============================================"
exit "$failed"
echo "TLC Model Checking Complete"
echo "Results: ${OUTPUT_DIR}/"
echo "============================================"
