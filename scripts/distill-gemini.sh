#!/usr/bin/env bash
# distill-gemini.sh — Gemini backend for the SessionEnd distiller.
#
# SPOR_DISTILL_CMD contract (scripts/engines/distill.js): prompt on stdin,
# response text on stdout, non-zero exit on failure (the distiller fails
# open and journals the error either way). Zero-dep client rules apply
# (dec-cc-zero-dep-client): bash, jq, curl only.
#
#   SPOR_DISTILL_CMD="$HOME/repos/spor/scripts/distill-gemini.sh"
#
# Env: GEMINI_API_KEY (required); SPOR_DISTILL_MODEL (default
# gemini-3.5-flash — chosen as the cheap-tier dogfood candidate after the
# cross-provider stress run, art-experiment-stress-providers: zero
# substantive fabrications, failure mode is overstatement, not invention).

set -euo pipefail

MODEL="${SPOR_DISTILL_MODEL:-${SUBSTRATE_DISTILL_MODEL:-gemini-3.5-flash}}"
: "${GEMINI_API_KEY:?GEMINI_API_KEY is required}"

# stdin (raw prompt) -> single-turn generateContent payload.
BODY=$(jq -Rs '{contents: [{parts: [{text: .}]}],
                generationConfig: {maxOutputTokens: 8000}}')

RESP=$(printf '%s' "$BODY" | curl -sS --fail-with-body --max-time 120 \
  -X POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}")

# Join text parts; thought parts are excluded server-side by default.
TEXT=$(printf '%s' "$RESP" | jq -r '[.candidates[0].content.parts[]?.text // empty] | join("")')
[ -n "$TEXT" ] || { echo "empty completion from $MODEL" >&2; exit 1; }
printf '%s\n' "$TEXT"
