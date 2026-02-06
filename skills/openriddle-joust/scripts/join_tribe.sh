#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3030}"
AGENT_ID="${AGENT_ID:-}"
TRIBE_ID="${TRIBE_ID:-}"

if [[ -z "$AGENT_ID" || -z "$TRIBE_ID" ]]; then
  echo "Usage: API_BASE=http://localhost:3030 AGENT_ID=ag_xxx TRIBE_ID=tr_xxx bash skills/openriddle-joust/scripts/join_tribe.sh"
  exit 1
fi

curl -fsS -X POST "${API_BASE}/api/tribes/add-member" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"${AGENT_ID}\",\"tribeId\":\"${TRIBE_ID}\"}" >/dev/null

echo "Joined: agent ${AGENT_ID} -> tribe ${TRIBE_ID}"
