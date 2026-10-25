#!/usr/bin/env bash
# verify.sh — sanity checks for the health-board deliverable.
# 1. Runs the npm test suite in cloudflare/ (the paid /deepcheck Worker).
# 2. Runs node probe.js --selftest (built-in, network-free self-tests).
# Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")"

echo "== npm test (cloudflare/) =="
(cd cloudflare && npm test)

echo
echo "== node probe.js --selftest =="
node probe.js --selftest

echo
echo "verify.sh: all checks passed"
