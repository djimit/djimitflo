#!/bin/bash
set -euo pipefail

OPENMYTHOS_DIR="${OPENMYTHOS_DIR:-${HOME}/OpenMythos/openmythos-benchmark}"
NEW_MODEL="${NEW_MODEL:?NEW_MODEL is required}"
BASELINE_MODEL="${BASELINE_MODEL:-openmythos-r17:latest}"
JUDGE_MODEL="${JUDGE_MODEL:-qwen2.5-coder:14b}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
RUNS="${RUNS:-3}"
CASE_TIMEOUT="${CASE_TIMEOUT:-300}"
RESULTS_DIR="${RESULTS_DIR:-./.swarm/evidence/openmythos-model-promotion}"
CORPUS="${OPENMYTHOS_DIR}/cases/corpus.jsonl"

test -f "${CORPUS}" || { echo "ERROR: canonical corpus not found: ${CORPUS}" >&2; exit 1; }
mkdir -p "${RESULTS_DIR}/baseline" "${RESULTS_DIR}/candidate"
python3 "${OPENMYTHOS_DIR}/scripts/validate.py"

run_model() {
  local label="$1" model="$2" dir="${RESULTS_DIR}/$1"
  local judged=()
  for run in $(seq 1 "${RUNS}"); do
    python3 "${OPENMYTHOS_DIR}/scripts/evaluate.py" \
      --model "${model}" --backend ollama --base-url "${OLLAMA_URL}" \
      --corpus "${CORPUS}" --temperature 0 --seed 0 --timeout "${CASE_TIMEOUT}" \
      --resume --output "${dir}/run-${run}.jsonl"
    python3 "${OPENMYTHOS_DIR}/scripts/judge.py" \
      --trace "${dir}/run-${run}.jsonl" --corpus "${CORPUS}" --judge-model "${JUDGE_MODEL}" \
      --judge-backend ollama --judge-url "${OLLAMA_URL}" --strict --no-think \
      --resume --output "${dir}/judged-run-${run}.jsonl"
    judged+=("${dir}/judged-run-${run}.jsonl")
  done
  python3 "${OPENMYTHOS_DIR}/scripts/reliability_gate.py" "${judged[@]}" \
    --corpus "${CORPUS}" --manifest "${dir}/repeatability-manifest.json" \
    --json-output "${dir}/repeatability.json" --case-output "${dir}/cases.jsonl"
  python3 "${OPENMYTHOS_DIR}/scripts/oracle_score.py" "${judged[@]}" \
    --corpus "${CORPUS}" --output "${dir}/oracle.jsonl"
}

run_model baseline "${BASELINE_MODEL}"
run_model candidate "${NEW_MODEL}"
python3 "${OPENMYTHOS_DIR}/scripts/mcnemar_test.py" \
  --before "${RESULTS_DIR}/baseline/cases.jsonl" --after "${RESULTS_DIR}/candidate/cases.jsonl" \
  --output "${RESULTS_DIR}/promotion.json"
echo "OpenMythos model promotion gate passed"
