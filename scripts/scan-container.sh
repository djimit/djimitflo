#!/bin/bash
# Container image security scanning with Trivy.
# Run before pushing images to registry.
# Usage: ./scripts/scan-container.sh [image_tag]

set -euo pipefail

IMAGE_TAG="${1:-djimitflo:latest}"
SEVERITY_THRESHOLD="${SEVERITY_THRESHOLD:-HIGH}"
EXIT_ON_CRITICAL="${EXIT_ON_CRITICAL:-true}"

echo "🔍 Scanning container image: $IMAGE_TAG"
echo "   Severity threshold: $SEVERITY_THRESHOLD"

# Check if Trivy is installed
if ! command -v trivy &> /dev/null; then
    echo "⚠️  Trivy not found. Install with:"
    echo "   macOS: brew install trivy"
    echo "   Linux: aquasecurity.github.io/trivy/latest/getting-started/installation/"
    echo ""
    echo "   Falling back to basic Docker image inspection..."
    
    docker inspect "$IMAGE_TAG" --format='{{.RepoDigests}}' > /dev/null 2>&1 || {
        echo "❌ Image not found: $IMAGE_TAG"
        exit 1
    }
    
    echo "✅ Image exists (basic check only)"
    exit 0
fi

# Run Trivy vulnerability scan
echo "📊 Running vulnerability scan..."
trivy image \
    --severity "$SEVERITY_THRESHOLD,CRITICAL" \
    --format table \
    --ignore-unfixed \
    "$IMAGE_TAG"

VULN_EXIT=$?

# Run Trivy misconfiguration scan
echo "🔒 Running misconfiguration scan..."
trivy image \
    --severity "$SEVERITY_THRESHOLD,CRITICAL" \
    --format table \
    --scanners misconfig \
    "$IMAGE_TAG"

MISCONF_EXIT=$?

# Run Trivy secret scan
echo "🔑 Running secret scan..."
trivy image \
    --severity CRITICAL \
    --format table \
    --scanners secret \
    "$IMAGE_TAG"

SECRET_EXIT=$?

# Summary
echo ""
echo "============================================="
echo "Scan Summary"
echo "============================================="

if [ $VULN_EXIT -eq 0 ] && [ $MISCONF_EXIT -eq 0 ] && [ $SECRET_EXIT -eq 0 ]; then
    echo "✅ All scans passed"
    exit 0
else
    echo "⚠️  Issues found:"
    [ $VULN_EXIT -ne 0 ] && echo "   - Vulnerabilities detected"
    [ $MISCONF_EXIT -ne 0 ] && echo "   - Misconfigurations detected"
    [ $SECRET_EXIT -ne 0 ] && echo "   - Secrets detected"
    
    if [ "$EXIT_ON_CRITICAL" = "true" ]; then
        echo "❌ Failing build due to security findings"
        exit 1
    fi
    
    echo "⚠️  Continuing (EXIT_ON_CRITICAL=false)"
    exit 0
fi
