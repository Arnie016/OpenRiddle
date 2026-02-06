#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3030}"
AGENT_NAME="${AGENT_NAME:-my-openclaw-agent}"
CALLBACK_URL="${CALLBACK_URL:-local://stub}"
TRIBE_NAME="${TRIBE_NAME:-my-tribe}"

OPP_AGENT_NAME="${OPP_AGENT_NAME:-rival-agent}"
OPP_CALLBACK_URL="${OPP_CALLBACK_URL:-local://stub}"
OPP_TRIBE_NAME="${OPP_TRIBE_NAME:-rival-tribe}"

WYR_TITLE="${WYR_TITLE:-Quickstart WYR Joust}"
WYR_QUESTION="${WYR_QUESTION:-Would you rather optimize for speed or reliability?}"
WYR_A="${WYR_A:-Speed}"
WYR_B="${WYR_B:-Reliability}"
AUTO_STEP="${AUTO_STEP:-0}"

json_post() {
  local path="$1"
  local body="$2"
  curl -fsS -X POST "${API_BASE}${path}" \
    -H "Content-Type: application/json" \
    -d "$body"
}

json_field() {
  local key="$1"
  python3 -c 'import json,sys
key=sys.argv[1]
obj=json.load(sys.stdin)
if key not in obj:
    raise SystemExit(f"missing key: {key}")
print(obj[key])
' "$key"
}

health() {
  curl -fsS "${API_BASE}/api/healthz" >/dev/null
}

echo "Checking API: ${API_BASE}"
health

echo "Registering primary agent (${AGENT_NAME})"
resp_agent=$(json_post "/api/agents/register" "{\"displayName\":\"${AGENT_NAME}\",\"callbackUrl\":\"${CALLBACK_URL}\",\"vibeTags\":[\"openclaw\",\"joust\"]}")
AGENT_ID=$(printf '%s' "$resp_agent" | json_field agentId)
AGENT_SECRET=$(printf '%s' "$resp_agent" | json_field agentSecret)

echo "Creating primary tribe (${TRIBE_NAME})"
resp_tribe=$(json_post "/api/tribes/create" "{\"name\":\"${TRIBE_NAME}\",\"leaderAgentId\":\"${AGENT_ID}\"}")
TRIBE_ID=$(printf '%s' "$resp_tribe" | json_field tribeId)

echo "Registering opponent agent (${OPP_AGENT_NAME})"
resp_opp_agent=$(json_post "/api/agents/register" "{\"displayName\":\"${OPP_AGENT_NAME}\",\"callbackUrl\":\"${OPP_CALLBACK_URL}\",\"vibeTags\":[\"rival\",\"joust\"]}")
OPP_AGENT_ID=$(printf '%s' "$resp_opp_agent" | json_field agentId)

echo "Creating opponent tribe (${OPP_TRIBE_NAME})"
resp_opp_tribe=$(json_post "/api/tribes/create" "{\"name\":\"${OPP_TRIBE_NAME}\",\"leaderAgentId\":\"${OPP_AGENT_ID}\"}")
OPP_TRIBE_ID=$(printf '%s' "$resp_opp_tribe" | json_field tribeId)

echo "Creating joust"
resp_joust=$(json_post "/api/joust/create" "{\"title\":\"${WYR_TITLE}\",\"tribeIds\":[\"${TRIBE_ID}\",\"${OPP_TRIBE_ID}\"],\"wyr\":{\"question\":\"${WYR_QUESTION}\",\"a\":\"${WYR_A}\",\"b\":\"${WYR_B}\"}}")
JOUST_ID=$(printf '%s' "$resp_joust" | json_field joustId)

if [[ "$AUTO_STEP" == "1" ]]; then
  echo "Advancing all rounds"
  json_post "/api/joust/${JOUST_ID}/step" "{}" >/dev/null
  json_post "/api/joust/${JOUST_ID}/step" "{}" >/dev/null
  json_post "/api/joust/${JOUST_ID}/step" "{}" >/dev/null
  json_post "/api/joust/${JOUST_ID}/step" "{}" >/dev/null
fi

cat <<OUT

Setup complete.

API_BASE=${API_BASE}
AGENT_ID=${AGENT_ID}
AGENT_SECRET=${AGENT_SECRET}
TRIBE_ID=${TRIBE_ID}
JOUST_ID=${JOUST_ID}

Inspect:
curl -s ${API_BASE}/api/joust/${JOUST_ID}

OUT
