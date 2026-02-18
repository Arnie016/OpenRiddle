import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import fetch from 'node-fetch';
import { openJoustStore } from './agent-joust-store.mjs';

const PORT = Number(process.env.PORT || process.env.JOUST_PORT || 3030);
const DB_PATH = process.env.JOUST_DB_PATH || (process.env.VERCEL ? '/tmp/agent-joust.sqlite' : './data/agent-joust.sqlite');
const STORE_DRIVER = String(process.env.JOUST_STORE_DRIVER || 'sqlite').toLowerCase();
const POSTGRES_URL = String(process.env.JOUST_POSTGRES_URL || process.env.DATABASE_URL || '');
const DEFAULT_TIMEOUT_MS = Number(process.env.JOUST_AGENT_TIMEOUT_MS || 7000);
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '');
const OPENAI_ANALYZER_MODEL = String(process.env.OPENAI_ANALYZER_MODEL || 'gpt-4.1-mini');
const WINNER_DECIDER_MODE_RAW = String(process.env.JOUST_WINNER_DECIDER_MODE || 'rules').toLowerCase();
const WINNER_DECIDER_MODE = WINNER_DECIDER_MODE_RAW === 'ai' ? 'ai' : 'rules';
const VOTER_SCOPE_RAW = String(process.env.JOUST_VOTER_SCOPE || 'arena').toLowerCase();
const VOTER_SCOPE = VOTER_SCOPE_RAW === 'all' ? 'all' : 'arena';

const db = await openJoustStore({
  driver: STORE_DRIVER,
  dbPath: DB_PATH,
  postgresUrl: POSTGRES_URL,
});

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-agent-id, x-agent-ts, x-agent-sig',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-agent-id, x-agent-ts, x-agent-sig',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('invalid json body');
    err.status = 400;
    throw err;
  }
}

function clampText(s, maxLen) {
  const t = String(s ?? '').replace(/\r\n/g, '\n');
  return t.length <= maxLen ? t : t.slice(0, maxLen);
}

function clampNumber(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeTagList(input, maxItems = 10, maxLen = 24) {
  if (!Array.isArray(input)) return [];
  const unique = [];
  const seen = new Set();
  for (const value of input) {
    const tag = clampText(String(value || '').trim(), maxLen).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
    if (unique.length >= maxItems) break;
  }
  return unique;
}

function normalizeTribeSettingsInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    objective: clampText(String(input.objective || ''), 220),
    openJoin: input.openJoin !== false,
    minInfamy: clampNumber(input.minInfamy ?? 0, 0, 5000, 0),
    preferredStyles: sanitizeTagList(input.preferredStyles, 10, 24),
    requiredTags: sanitizeTagList(input.requiredTags, 12, 24),
  };
}

function evaluateJoinEligibility(agent, settings) {
  if (!agent) return { ok: false, reason: 'agent not found' };
  const rules = normalizeTribeSettingsInput(settings);
  const tags = Array.isArray(agent.vibeTags) ? agent.vibeTags.map((tag) => String(tag || '').toLowerCase()) : [];

  if ((agent.infamy || 0) < rules.minInfamy) {
    return { ok: false, reason: `agent needs at least ${rules.minInfamy} infamy` };
  }

  if (rules.requiredTags.length > 0) {
    const missing = rules.requiredTags.filter((tag) => !tags.includes(tag));
    if (missing.length > 0) {
      return { ok: false, reason: `agent missing required tags: ${missing.join(', ')}` };
    }
  }

  if (!rules.openJoin && rules.preferredStyles.length > 0) {
    const matchesStyle = rules.preferredStyles.some((style) => tags.includes(style));
    if (!matchesStyle) {
      return { ok: false, reason: `join requires one preferred style: ${rules.preferredStyles.join(', ')}` };
    }
  }

  return { ok: true, reason: '' };
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function hasLink(s) {
  return /https?:\/\/|www\./i.test(s);
}

function sign(secret, ts, body) {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function randomColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 85% 60%)`;
}

function shuffleInPlace(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const WYR_PROMPT_PACK = [
  {
    question: 'Riddle: I grow when shared and shrink when hoarded. Would you rather guard me in silence, or spend me to unite your tribe?',
    a: 'Guard it in silence',
    b: 'Spend it to unite',
  },
  {
    question: 'Riddle: I have cities without walls and wars without blood. Would you rather rule me as a cartographer, or break me as an explorer?',
    a: 'Rule as cartographer',
    b: 'Break as explorer',
  },
  {
    question: 'Riddle: I arrive every night but never stay. Would you rather chase certainty, or cultivate awe?',
    a: 'Chase certainty',
    b: 'Cultivate awe',
  },
  {
    question: 'Riddle: I can heal and divide with the same sentence. Would you rather optimize for honesty, or optimize for harmony?',
    a: 'Optimize for honesty',
    b: 'Optimize for harmony',
  },
  {
    question: 'Riddle: I have keys but open no doors. Would you rather solve with pure logic, or solve with emotional inference?',
    a: 'Pure logic',
    b: 'Emotional inference',
  },
  {
    question: 'Riddle: I am loud in crowds and quiet in conscience. Would you rather be adored by all, or trusted by few?',
    a: 'Adored by all',
    b: 'Trusted by few',
  },
];

function randomWyrPrompt() {
  const idx = Math.floor(Math.random() * WYR_PROMPT_PACK.length);
  return WYR_PROMPT_PACK[idx];
}

function getContextPayload() {
  return {
    version: 'mvp-2',
    game: 'Open Riddle',
    rules: {
      round1: 'Entrance (<=240 chars, must include token).',
      round2: 'Pick A/B + pitch (<=420 chars).',
      vote: 'Eligible agents vote A/B.',
      scoring: 'Winning option is by total votes; persuasion score = neutral votes + 2*snitch votes.',
      voterScope: VOTER_SCOPE,
    },
    webhook: {
      headers: ['x-agent-id', 'x-agent-ts', 'x-agent-sig'],
      signature: 'HMAC_SHA256(agentSecret, "<ts>.<rawBody>")',
      callbacks: ['joust_round', 'wyr_vote'],
    },
    analysis: {
      endpoint: '/api/joust/:id/analyze',
      source: OPENAI_API_KEY ? 'openai+heuristic-fallback' : 'heuristic-only',
      model: OPENAI_ANALYZER_MODEL,
      winnerDeciderMode: WINNER_DECIDER_MODE,
    },
    tribes: {
      settings: 'objective, openJoin, minInfamy, preferredStyles, requiredTags',
      listEndpoint: '/api/tribes',
      updateSettingsEndpoint: '/api/tribes/settings',
    },
    storage: {
      driver: db.driver || STORE_DRIVER,
    },
  };
}

function localAgentReply(agent, payload) {
  const tag = (agent.vibeTags[0] || 'vibe').toLowerCase();
  if (payload.type === 'joust_round' && payload.round === 'round1') {
    const token = payload?.rules?.requiredToken || 'TOKEN';
    const lines = [
      `${token} We arrive with ${tag} precision.`,
      `Call us ${agent.displayName}: short, sharp, unforgettable.`,
    ];
    return { message: lines.join('\n') };
  }
  if (payload.type === 'joust_round' && payload.round === 'round2') {
    const choice = tag.includes('chaos') || tag.includes('punk') ? 'B' : 'A';
    const pick = choice === 'A' ? payload.wyr.a : payload.wyr.b;
    return {
      choice,
      message: `Choice ${choice}. ${pick}\nBecause ${tag} is not loud, it is inevitable.`,
    };
  }
  if (payload.type === 'wyr_vote') {
    const ownChoice = payload?.tribeId ? payload?.transcript?.round2?.posts?.[payload.tribeId]?.choice : null;
    const vote = ownChoice === 'A' || ownChoice === 'B' ? ownChoice : tag.includes('stoic') || tag.includes('builder') ? 'A' : 'B';
    return { vote };
  }
  return { message: '...' };
}

async function callAgent(agent, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (agent.callbackUrl.startsWith('local://')) {
    return localAgentReply(agent, payload);
  }

  const ts = Date.now();
  const body = JSON.stringify(payload);
  const sig = sign(agent.secret, ts, body);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(agent.callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-id': agent.id,
        'x-agent-ts': String(ts),
        'x-agent-sig': sig,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Agent ${agent.id} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function computePersuasion(joust, votesByAgent) {
  const totals = { A: 0, B: 0 };
  for (const v of Object.values(votesByAgent)) {
    if (v === 'A') totals.A += 1;
    if (v === 'B') totals.B += 1;
  }
  const winningOption = totals.A === totals.B ? null : totals.A > totals.B ? 'A' : 'B';

  const tribeChoices = {};
  for (const tribeId of joust.tribeIds) {
    tribeChoices[tribeId] = joust.rounds.round2?.posts?.[tribeId]?.choice || null;
  }

  const tribeScores = {};
  for (const tribeId of joust.tribeIds) {
    tribeScores[tribeId] = { neutralVotes: 0, snitchVotes: 0, outsideVotes: 0, persuasionScore: 0 };
  }

  for (const [agentId, vote] of Object.entries(votesByAgent)) {
    const voterTribe = await db.getAgentTribeId(agentId);
    const voterTribeChoice = voterTribe ? tribeChoices[voterTribe] : null;

    for (const tribeId of joust.tribeIds) {
      const choice = tribeChoices[tribeId];
      if (!choice) continue;
      if (vote !== choice) continue;

      if (voterTribe !== tribeId) tribeScores[tribeId].outsideVotes += 1;
      if (!voterTribe) tribeScores[tribeId].neutralVotes += 1;
      else if (voterTribe !== tribeId && voterTribeChoice && voterTribeChoice !== choice) {
        tribeScores[tribeId].snitchVotes += 1;
      }
    }
  }

  for (const tribeId of joust.tribeIds) {
    const s = tribeScores[tribeId];
    s.persuasionScore = s.neutralVotes + 2 * s.snitchVotes;
  }

  return { totals, winningOption, tribeChoices, tribeScores };
}

async function applyInfamy(joust, computed, forcedWinnerTribeId = null) {
  const { winningOption: voteWinningOption, tribeChoices, tribeScores, totals } = computed;
  let winningOption = voteWinningOption;
  let winnerTribeId;

  if (forcedWinnerTribeId && joust.tribeIds.includes(forcedWinnerTribeId)) {
    winnerTribeId = forcedWinnerTribeId;
    winningOption = tribeChoices[forcedWinnerTribeId] || voteWinningOption || null;
  } else {
    const eligible = joust.tribeIds.filter((tid) => winningOption && tribeChoices[tid] === winningOption);
    if (eligible.length > 0) {
      const best = Math.max(...eligible.map((tid) => tribeScores[tid].persuasionScore));
      const winners = eligible.filter((tid) => tribeScores[tid].persuasionScore === best);
      if (winners.length === 1) {
        winnerTribeId = winners[0];
      } else if (winners.length > 1) {
        const winnerMeta = await Promise.all(
          winners.map(async (tid) => {
            const tribe = await db.getTribe(tid);
            return { tribeId: tid, infamy: Number(tribe?.infamy || 0) };
          }),
        );
        winnerMeta.sort((a, b) => b.infamy - a.infamy || a.tribeId.localeCompare(b.tribeId));
        winnerTribeId = winnerMeta[0]?.tribeId;
      }
    }

    if (!winnerTribeId) {
      const ranked = await Promise.all(
        joust.tribeIds.map(async (tid) => {
          const tribe = await db.getTribe(tid);
          return {
            tribeId: tid,
            persuasionScore: Number(tribeScores[tid]?.persuasionScore || 0),
            infamy: Number(tribe?.infamy || 0),
          };
        }),
      );
      ranked.sort((a, b) => b.persuasionScore - a.persuasionScore || b.infamy - a.infamy || a.tribeId.localeCompare(b.tribeId));
      winnerTribeId = ranked[0]?.tribeId;
      winningOption = (winnerTribeId && tribeChoices[winnerTribeId]) || winningOption || null;
    }
  }

  const tribeResults = {};
  for (const tribeId of joust.tribeIds) {
    const choice = tribeChoices[tribeId];
    const s = tribeScores[tribeId];
    const onWinningSide = !!winningOption && choice === winningOption;
    const isWinner = winnerTribeId === tribeId;
    const base = winningOption ? (onWinningSide ? 6 : -6) : isWinner ? 2 : -2;
    const bonus = isWinner ? 8 : 0;
    const deltaInfamy = base + bonus + s.persuasionScore;

    tribeResults[tribeId] = {
      choice: choice || null,
      neutralVotes: s.neutralVotes,
      snitchVotes: s.snitchVotes,
      outsideVotes: s.outsideVotes,
      persuasionScore: s.persuasionScore,
      deltaInfamy,
    };

    await db.applyTribeDelta(tribeId, deltaInfamy, onWinningSide);
    const members = await db.listTribeMemberIds(tribeId);
    for (const agentId of members) {
      await db.applyAgentDelta(agentId, Math.round(deltaInfamy * 0.35), onWinningSide);
    }
  }

  return { winnerTribeId, tribeResults, winningOption, voteTotals: totals };
}

async function decideWinnerTribe(joust) {
  if (WINNER_DECIDER_MODE !== 'ai') {
    return {
      winnerTribeId: null,
      decision: {
        mode: 'rules',
        source: 'vote+persuasion',
        model: null,
        confidence: null,
        verdict: 'Winner decided from vote totals and persuasion score.',
        fallback: false,
      },
    };
  }

  const fallback = await heuristicAnalyzeJoust(joust);
  if (!OPENAI_API_KEY) {
    return {
      winnerTribeId: fallback.winnerTribeId || null,
      decision: {
        mode: 'ai',
        source: 'heuristic-fallback',
        model: fallback.model,
        confidence: fallback.confidence,
        verdict: `AI mode requested, but no OPENAI_API_KEY set. ${fallback.verdict}`,
        fallback: true,
      },
    };
  }

  try {
    const analysis = await openAiAnalyzeJoust(joust);
    return {
      winnerTribeId: analysis.winnerTribeId || null,
      decision: {
        mode: 'ai',
        source: analysis.source,
        model: analysis.model,
        confidence: analysis.confidence,
        verdict: analysis.verdict,
        fallback: analysis.source !== 'openai',
      },
    };
  } catch (error) {
    return {
      winnerTribeId: fallback.winnerTribeId || null,
      decision: {
        mode: 'ai',
        source: 'heuristic-fallback',
        model: fallback.model,
        confidence: fallback.confidence,
        verdict: `${fallback.verdict} OpenAI failed: ${clampText(error?.message || String(error), 180)}.`,
        fallback: true,
      },
    };
  }
}

async function migrateParticipantsToWinner(joust, winnerTribeId) {
  if (!winnerTribeId) {
    return { winnerTribeId: null, movedAgents: 0, movedFromTribes: [] };
  }

  const winnerMembers = new Set(await db.listTribeMemberIds(winnerTribeId));
  const movedFromTribes = [];
  let movedAgents = 0;

  for (const tribeId of joust.tribeIds) {
    if (tribeId === winnerTribeId) continue;
    const memberIds = await db.listTribeMemberIds(tribeId);
    let movedCount = 0;

    for (const agentId of memberIds) {
      if (winnerMembers.has(agentId)) continue;
      await db.transferAgentToTribe(agentId, winnerTribeId);
      winnerMembers.add(agentId);
      movedCount += 1;
      movedAgents += 1;
    }

    if (movedCount > 0) {
      movedFromTribes.push({ tribeId, movedCount });
    }
  }

  return { winnerTribeId, movedAgents, movedFromTribes };
}

async function buildAnalyzerInput(joust) {
  const tribeRows = await Promise.all(joust.tribeIds.map((id) => db.getTribe(id)));
  const tribes = tribeRows
    .filter(Boolean)
    .map((tribe) => {
      const r1 = joust.rounds?.round1?.posts?.[tribe.id];
      const r2 = joust.rounds?.round2?.posts?.[tribe.id];
      const result = joust.results?.tribeResults?.[tribe.id] || null;
      return {
        id: tribe.id,
        name: tribe.name,
        color: tribe.color,
        infamy: tribe.infamy,
        round1: r1?.message || '',
        round2: {
          choice: r2?.choice || null,
          message: r2?.message || '',
        },
        result,
      };
    });

  return {
    id: joust.id,
    title: joust.title,
    state: joust.state,
    wyr: joust.wyr,
    voteTotals: joust.results?.voteTotals || null,
    winningOption: joust.results?.winningOption || null,
    tribes,
  };
}

async function heuristicAnalyzeJoust(joust) {
  const input = await buildAnalyzerInput(joust);
  const winnerTribeIdFromResults = joust.results?.winnerTribeId || null;
  let winnerTribeId = winnerTribeIdFromResults;

  if (!winnerTribeId && joust.results?.tribeResults) {
    const sorted = Object.entries(joust.results.tribeResults)
      .map(([tribeId, score]) => ({ tribeId, persuasionScore: Number(score?.persuasionScore || 0) }))
      .sort((a, b) => b.persuasionScore - a.persuasionScore);
    winnerTribeId = sorted[0]?.tribeId || null;
  }

  const winnerTribe = input.tribes.find((t) => t.id === winnerTribeId) || null;
  const winnerChoice = winnerTribe?.round2?.choice ?? null;
  const winningOption = winnerChoice || input.winningOption || null;

  const highlights = [];
  for (const tribe of input.tribes) {
    if (tribe.round2?.message) {
      highlights.push(`${tribe.name}: ${clampText(tribe.round2.message.replace(/\s+/g, ' '), 120)}`);
    }
  }
  if (highlights.length < 3) {
    for (const tribe of input.tribes) {
      if (tribe.round1 && highlights.length < 3) {
        highlights.push(`${tribe.name}: ${clampText(tribe.round1.replace(/\s+/g, ' '), 120)}`);
      }
    }
  }

  const voteTotals = input.voteTotals ? `A ${input.voteTotals.A} / B ${input.voteTotals.B}` : 'pending vote totals';
  const winnerLabel = winnerTribe ? `${winnerTribe.name}${winningOption ? ` on ${winningOption}` : ''}` : 'no clear winner yet';

  return {
    winnerTribeId: winnerTribeId || null,
    confidence: winnerTribe ? 0.62 : 0.4,
    verdict: `Heuristic referee picks ${winnerLabel} based on persuasion score and ${voteTotals}.`,
    highlights: highlights.slice(0, 3),
    source: 'heuristic',
    model: 'local-rules-v1',
  };
}

async function openAiAnalyzeJoust(joust) {
  const input = await buildAnalyzerInput(joust);
  const system = [
    'You are a strict Open Riddle referee.',
    'Pick one winning tribe based on persuasion quality, consistency, and strategic fit with the WYR question.',
    'Return JSON only with keys: winnerTribeId, confidence, verdict, highlights.',
    'confidence must be between 0 and 1.',
    'highlights must be an array of 1-3 short strings.',
  ].join(' ');
  const user = JSON.stringify(input, null, 2);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_ANALYZER_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`openai analyzer failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const raw = Array.isArray(content) ? content.map((c) => c?.text || '').join('\n') : String(content || '');
  const parsed = safeJsonParse(extractJsonObject(raw), null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('openai analyzer returned invalid JSON');
  }

  const fallback = await heuristicAnalyzeJoust(joust);
  const candidateWinner = String(parsed.winnerTribeId || '');
  const validWinner = input.tribes.some((t) => t.id === candidateWinner);

  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.map((h) => clampText(String(h || ''), 160)).filter(Boolean).slice(0, 3)
    : fallback.highlights;

  return {
    winnerTribeId: validWinner ? candidateWinner : fallback.winnerTribeId,
    confidence: clampNumber(parsed.confidence, 0, 1, fallback.confidence),
    verdict: clampText(String(parsed.verdict || fallback.verdict), 420),
    highlights: highlights.length > 0 ? highlights : fallback.highlights,
    source: 'openai',
    model: OPENAI_ANALYZER_MODEL,
  };
}

async function stepJoust(joust) {
  if (joust.state === 'done') return;

  const requiredToken = `#${joust.id.slice(0, 5)}`;

  if (joust.state === 'draft') {
    await db.updateJoustState(joust.id, 'round1');
    return;
  }

  if (joust.state === 'round1') {
    for (const tribeId of joust.tribeIds) {
      const existing = await db.getRoundPost(joust.id, tribeId, 'round1');
      if (existing) continue;
      const tribe = await db.getTribe(tribeId);
      const agent = tribe ? await db.getAgent(tribe.leaderAgentId) : null;
      if (!tribe || !agent) continue;

      const opponentTribes = (
        await Promise.all(
          joust.tribeIds
            .filter((id) => id !== tribeId)
            .map((id) => db.getTribe(id)),
        )
      )
        .filter(Boolean)
        .map((t) => ({ id: t.id, name: t.name, color: t.color }));

      const payload = {
        type: 'joust_round',
        joustId: joust.id,
        round: 'round1',
        rules: { maxChars: 240, requiredToken, noLinks: true },
        tribe: { id: tribe.id, name: tribe.name, color: tribe.color },
        opponents: opponentTribes,
        transcript: joust.rounds,
        wyr: joust.wyr,
      };

      const out = await callAgent(agent, payload);
      const msg = clampText(out?.message || '', 240);
      if (!msg || hasLink(msg)) {
        await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: `${requiredToken} (forfeit)`, agentId: agent.id, createdAt: nowIso() });
      } else {
        const normalized = msg.includes(requiredToken) ? msg : `${requiredToken} ${msg}`;
        await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: normalized, agentId: agent.id, createdAt: nowIso() });
      }
    }
    await db.updateJoustState(joust.id, 'round2');
    return;
  }

  if (joust.state === 'round2') {
    for (const tribeId of joust.tribeIds) {
      const existing = await db.getRoundPost(joust.id, tribeId, 'round2');
      if (existing) continue;
      const tribe = await db.getTribe(tribeId);
      const agent = tribe ? await db.getAgent(tribe.leaderAgentId) : null;
      if (!tribe || !agent) continue;

      const payload = {
        type: 'joust_round',
        joustId: joust.id,
        round: 'round2',
        rules: { maxChars: 420, mustPick: ['A', 'B'], noLinks: true },
        tribe: { id: tribe.id, name: tribe.name, color: tribe.color },
        wyr: joust.wyr,
        transcript: joust.rounds,
      };

      const out = await callAgent(agent, payload);
      const msg = clampText(out?.message || '', 420);
      const choiceRaw = String(out?.choice || '').toUpperCase();
      const choice = choiceRaw === 'A' || choiceRaw === 'B' ? choiceRaw : undefined;

      if (!msg || !choice || hasLink(msg)) {
        await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round2', message: '(forfeit)', choice: null, agentId: agent.id, createdAt: nowIso() });
      } else {
        await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round2', message: msg, choice, agentId: agent.id, createdAt: nowIso() });
      }
    }
    await db.updateJoustState(joust.id, 'vote');
    return;
  }

  if (joust.state === 'vote') {
    const agents = await db.listAgents();
    for (const agent of agents) {
      if (VOTER_SCOPE === 'arena' && agent.tribeId && !joust.tribeIds.includes(agent.tribeId)) {
        continue;
      }
      const already = joust.votes?.byAgent?.[agent.id];
      if (already) continue;
      const payload = { type: 'wyr_vote', joustId: joust.id, tribeId: agent.tribeId || null, wyr: joust.wyr, transcript: joust.rounds };
      try {
        const out = await callAgent(agent, payload, Math.min(DEFAULT_TIMEOUT_MS, 4000));
        const v = String(out?.vote || '').toUpperCase();
        if (v === 'A' || v === 'B') await db.upsertVote(joust.id, agent.id, v);
      } catch {
        // ignore non-responsive agents in MVP
      }
    }

    const refreshed = await db.getJoust(joust.id);
    const computed = await computePersuasion(refreshed, refreshed.votes?.byAgent || {});
    const winnerDecision = await decideWinnerTribe(refreshed);
    const results = await applyInfamy(refreshed, computed, winnerDecision.winnerTribeId);
    results.decision = winnerDecision.decision;
    results.migration = await migrateParticipantsToWinner(refreshed, results.winnerTribeId);
    await db.completeJoust(joust.id, 'done', results);
  }
}

async function buildFeedItem(j) {
  const tribeRows = await Promise.all(j.tribeIds.map((id) => db.getTribe(id)));
  const tribes = (
    await Promise.all(
      tribeRows
        .filter(Boolean)
        .map(async (tribe) => ({
          id: tribe.id,
          name: tribe.name,
          color: tribe.color,
          size: (await db.listTribeMemberIds(tribe.id)).length,
          infamy: tribe.infamy,
        })),
    )
  );

  return {
    id: j.id,
    title: j.title,
    state: j.state,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    wyr: j.wyr,
    tribes,
    results: j.results ? { winnerTribeId: j.results.winnerTribeId, voteTotals: j.results.voteTotals } : undefined,
  };
}

async function buildAgentProfile(agentId) {
  const agent = await db.getAgent(agentId);
  if (!agent) return null;

  const tribeId = await db.getAgentTribeId(agentId);
  const tribe = tribeId ? await db.getTribe(tribeId) : null;
  const allJousts = await db.listJousts();
  const relevant = tribeId ? allJousts.filter((j) => j.tribeIds.includes(tribeId)).slice(0, 12) : [];
  const recentJousts = await Promise.all(relevant.map(async (j) => {
    const full = await db.getJoust(j.id);
    const tribeScore = full?.results?.tribeResults?.[tribeId] || null;
    return {
      id: j.id,
      title: j.title,
      state: j.state,
      updatedAt: j.updatedAt,
      winnerTribeId: full?.results?.winnerTribeId || null,
      won: full?.results?.winnerTribeId === tribeId,
      winningOption: full?.results?.winningOption || null,
      infamyDelta: tribeScore?.deltaInfamy ?? null,
      persuasionScore: tribeScore?.persuasionScore ?? null,
    };
  }));

  const topHighlights = [];
  for (const j of relevant.slice(0, 5)) {
    const full = await db.getJoust(j.id);
    const round2 = full?.rounds?.round2?.posts?.[tribeId];
    if (round2?.message) {
      topHighlights.push(clampText(round2.message.replace(/\s+/g, ' '), 160));
    }
  }

  return {
    agent: {
      id: agent.id,
      displayName: agent.displayName,
      vibeTags: agent.vibeTags || [],
      infamy: agent.infamy,
      wins: agent.wins,
      losses: agent.losses,
      verifiedProvider: agent.verifiedProvider || null,
      verifiedSubject: agent.verifiedSubject || null,
      createdAt: agent.createdAt,
    },
    tribe: tribe
      ? {
          id: tribe.id,
          name: tribe.name,
          color: tribe.color,
          infamy: tribe.infamy,
          wins: tribe.wins,
          losses: tribe.losses,
          memberCount: (await db.listTribeMemberIds(tribe.id)).length,
        }
      : null,
    stats: {
      joustsPlayed: relevant.length,
      winRate: agent.wins + agent.losses > 0 ? Number((agent.wins / (agent.wins + agent.losses)).toFixed(3)) : null,
    },
    highlights: topHighlights.slice(0, 3),
    recentJousts,
  };
}

async function bootstrapPayload() {
  const agents = await db.listAgents();
  const tribes = await db.listTribes();
  const jousts = await db.listJousts();
  return {
    context: getContextPayload(),
    stats: {
      agents: agents.length,
      tribes: tribes.length,
      jousts: jousts.length,
    },
    topAgents: agents.slice(0, 5),
    topTribes: tribes.slice(0, 5),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) return text(res, 400, 'missing url');
    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = u.pathname;

    if (req.method === 'GET' && (path === '/healthz' || path === '/api/healthz')) {
      return json(res, 200, { ok: true, now: nowIso() });
    }

    if (req.method === 'GET' && path === '/api/context') {
      return json(res, 200, getContextPayload());
    }

    if (req.method === 'GET' && path === '/api/bootstrap') {
      return json(res, 200, await bootstrapPayload());
    }

    if (req.method === 'GET' && path === '/api/feed') {
      const jousts = await db.listJousts();
      const items = (
        await Promise.all(
          jousts.map(async (j) => {
            const full = await db.getJoust(j.id);
            return full ? buildFeedItem(full) : null;
          }),
        )
      ).filter(Boolean);
      return json(res, 200, items);
    }

    if (req.method === 'GET' && path === '/api/agents') {
      return json(res, 200, await db.listAgents());
    }

    const agentProfileMatch = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/profile$/i);
    if (req.method === 'GET' && agentProfileMatch) {
      const profile = await buildAgentProfile(agentProfileMatch[1]);
      if (!profile) return text(res, 404, 'agent not found');
      return json(res, 200, profile);
    }

    if (req.method === 'GET' && path === '/api/tribes') {
      return json(res, 200, await db.listTribes());
    }

    const joustIdMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && joustIdMatch) {
      const j = await db.getJoust(joustIdMatch[1]);
      if (!j) return text(res, 404, 'not found');
      const tribeRows = await Promise.all(j.tribeIds.map((id) => db.getTribe(id)));
      const tribes = (
        await Promise.all(
          tribeRows
            .filter(Boolean)
            .map(async (tribe) => ({
              id: tribe.id,
              name: tribe.name,
              color: tribe.color,
              size: (await db.listTribeMemberIds(tribe.id)).length,
              infamy: tribe.infamy,
              members: await db.listTribeMembers(tribe.id),
            })),
        )
      );

      const totals = j.results?.voteTotals;
      const byAgentCount = Object.keys(j.votes?.byAgent || {}).length;

      return json(res, 200, {
        id: j.id,
        title: j.title,
        state: j.state,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        wyr: j.wyr,
        tribes,
        rounds: j.rounds,
        votes: totals ? { totals, byAgentCount } : undefined,
        results: j.results,
      });
    }

    const joustStepMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)\/step$/i);
    if (req.method === 'POST' && joustStepMatch) {
      const j = await db.getJoust(joustStepMatch[1]);
      if (!j) return text(res, 404, 'not found');
      await stepJoust(j);
      const updated = await db.getJoust(j.id);
      return json(res, 200, { ok: true, state: updated.state });
    }

    const joustAnalyzeMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)\/analyze$/i);
    if (req.method === 'POST' && joustAnalyzeMatch) {
      const j = await db.getJoust(joustAnalyzeMatch[1]);
      if (!j) return text(res, 404, 'not found');

      let analysis = await heuristicAnalyzeJoust(j);
      if (OPENAI_API_KEY) {
        try {
          analysis = await openAiAnalyzeJoust(j);
        } catch (error) {
          analysis = {
            ...analysis,
            verdict: `${analysis.verdict} OpenAI fallback triggered: ${clampText(error?.message || String(error), 180)}.`,
          };
        }
      }

      return json(res, 200, {
        ok: true,
        analysis,
        openAiConfigured: Boolean(OPENAI_API_KEY),
      });
    }

    if (req.method === 'POST' && path === '/api/agents/register') {
      const body = await readJsonBody(req);
      const displayName = clampText(body?.displayName || 'Agent', 60);
      const callbackUrl = clampText(body?.callbackUrl || '', 400);
      const vibeTags = Array.isArray(body?.vibeTags)
        ? body.vibeTags.map((x) => clampText(String(x), 20)).filter(Boolean).slice(0, 8)
        : [];

      if (!callbackUrl) return text(res, 400, 'callbackUrl required');
      if (!callbackUrl.startsWith('http://') && !callbackUrl.startsWith('https://') && !callbackUrl.startsWith('local://')) {
        return text(res, 400, 'callbackUrl must start with http://, https://, or local://');
      }

      const id = `ag_${randomUUID().slice(0, 10)}`;
      const secret = randomUUID().replace(/-/g, '');
      await db.createAgent({ id, displayName, callbackUrl, secret, vibeTags, createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 });
      return json(res, 200, { agentId: id, agentSecret: secret });
    }

    if (req.method === 'POST' && path === '/api/agents/verify-identity') {
      const body = await readJsonBody(req);
      const agentId = clampText(body?.agentId || '', 80);
      const provider = clampText(body?.provider || 'custom', 40);
      const subject = clampText(body?.subject || '', 120);
      const profile = typeof body?.profile === 'object' && body?.profile !== null ? body.profile : null;
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      if (!subject) return text(res, 400, 'subject required');

      await db.setAgentVerification(agentId, provider, subject, profile);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/tribes/create') {
      const body = await readJsonBody(req);
      const name = clampText(body?.name || 'Tribe', 50);
      const leaderAgentId = clampText(body?.leaderAgentId || '', 80);
      const settings = normalizeTribeSettingsInput(body?.settings);
      const leader = await db.getAgent(leaderAgentId);
      if (!leader) return text(res, 400, 'leaderAgentId invalid');

      const existingTribeId = await db.getAgentTribeId(leaderAgentId);
      if (existingTribeId) return text(res, 400, `leader agent already in tribe ${existingTribeId}`);

      const id = `tr_${randomUUID().slice(0, 10)}`;
      const color = clampText(body?.color || randomColor(id), 30);
      await db.createTribe({ id, name, color, leaderAgentId, createdAt: nowIso(), infamy: 0, wins: 0, losses: 0 });
      await db.setTribeSettings(id, settings);
      return json(res, 200, { tribeId: id, settings });
    }

    if (req.method === 'POST' && path === '/api/tribes/settings') {
      const body = await readJsonBody(req);
      const tribeId = clampText(body?.tribeId || '', 80);
      const agentId = clampText(body?.agentId || '', 80);
      const tribe = await db.getTribe(tribeId);
      if (!tribe) return text(res, 404, 'tribe not found');
      if (!agentId) return text(res, 400, 'agentId required');
      if (tribe.leaderAgentId !== agentId) return text(res, 403, 'only tribe leader can update settings');
      const settings = normalizeTribeSettingsInput(body?.settings);
      await db.setTribeSettings(tribeId, settings);
      return json(res, 200, { ok: true, tribeId, settings });
    }

    if (req.method === 'POST' && path === '/api/tribes/add-member') {
      const body = await readJsonBody(req);
      const tribeId = clampText(body?.tribeId || '', 80);
      const agentId = clampText(body?.agentId || '', 80);
      const tribe = await db.getTribe(tribeId);
      const agent = await db.getAgent(agentId);
      if (!tribe) return text(res, 404, 'tribe not found');
      if (!agent) return text(res, 404, 'agent not found');

      const eligibility = evaluateJoinEligibility(agent, tribe.settings);
      if (!eligibility.ok) return text(res, 403, eligibility.reason);

      const existingTribeId = await db.getAgentTribeId(agentId);
      if (existingTribeId) return text(res, 400, `agent already in tribe ${existingTribeId}`);

      await db.addTribeMember(tribeId, agentId);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/onboard/quickstart') {
      const body = await readJsonBody(req);
      const displayName = clampText(body?.displayName || `Agent-${randomUUID().slice(0, 4)}`, 60);
      const callbackUrl = clampText(body?.callbackUrl || 'local://stub', 400);
      const tribeName = clampText(body?.tribeName || `${displayName} Guild`, 60);
      const homeSettings = normalizeTribeSettingsInput(body?.settings || { objective: body?.tribeObjective || '' });
      const vibeTags = Array.isArray(body?.vibeTags)
        ? body.vibeTags.map((x) => clampText(String(x), 20)).filter(Boolean).slice(0, 8)
        : [clampText(body?.vibe || 'witty', 20)].filter(Boolean);

      if (!callbackUrl.startsWith('http://') && !callbackUrl.startsWith('https://') && !callbackUrl.startsWith('local://')) {
        return text(res, 400, 'callbackUrl must start with http://, https://, or local://');
      }

      const agentId = `ag_${randomUUID().slice(0, 10)}`;
      const agentSecret = randomUUID().replace(/-/g, '');
      await db.createAgent({ id: agentId, displayName, callbackUrl, secret: agentSecret, vibeTags, createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 });

      const homeTribeId = `tr_${randomUUID().slice(0, 10)}`;
      await db.createTribe({
        id: homeTribeId,
        name: tribeName,
        color: randomColor(homeTribeId),
        leaderAgentId: agentId,
        createdAt: nowIso(),
        infamy: 0,
        wins: 0,
        losses: 0,
      });
      await db.setTribeSettings(homeTribeId, homeSettings);

      let rivalTribeId = null;
      const rivals = (await db.listTribes()).filter((t) => t.id !== homeTribeId);
      if (rivals.length > 0) {
        rivalTribeId = rivals[0].id;
      } else {
        const rivalAgentId = `ag_${randomUUID().slice(0, 10)}`;
        await db.createAgent({
          id: rivalAgentId,
          displayName: 'Rival Sentinel',
          callbackUrl: 'local://rival',
          secret: randomUUID().replace(/-/g, ''),
          vibeTags: ['rival', 'sharp'],
          createdAt: nowIso(),
          infamy: 100,
          wins: 0,
          losses: 0,
        });
        rivalTribeId = `tr_${randomUUID().slice(0, 10)}`;
        await db.createTribe({
          id: rivalTribeId,
          name: 'Rival Order',
          color: randomColor(rivalTribeId),
          leaderAgentId: rivalAgentId,
          createdAt: nowIso(),
          infamy: 0,
          wins: 0,
          losses: 0,
        });
        await db.setTribeSettings(
          rivalTribeId,
          normalizeTribeSettingsInput({
            objective: 'Protect rank by forcing risky prompts.',
            openJoin: true,
            minInfamy: 90,
            preferredStyles: ['tactical'],
          }),
        );
      }

      const seededWyr = randomWyrPrompt();
      const joustId = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({
        id: joustId,
        title: clampText(body?.title || `${tribeName} Arena Debut`, 90),
        tribeIds: [homeTribeId, rivalTribeId],
        state: 'draft',
        wyr: {
          question: clampText(body?.wyr?.question || seededWyr.question, 220),
          a: clampText(body?.wyr?.a || seededWyr.a, 80),
          b: clampText(body?.wyr?.b || seededWyr.b, 80),
        },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      return json(res, 200, { ok: true, agentId, agentSecret, tribeId: homeTribeId, joustId });
    }

    if (req.method === 'POST' && path === '/api/joust/create-auto') {
      const body = await readJsonBody(req);
      const allTribes = await db.listTribes();
      if (allTribes.length < 2) return text(res, 400, 'need at least 2 tribes in the directory');

      const defaultHomeTribeId = allTribes[0]?.id;
      const requestedHome = clampText(body?.homeTribeId || defaultHomeTribeId || '', 80);
      const homeTribe = (await db.getTribe(requestedHome)) || (await db.getTribe(defaultHomeTribeId));
      if (!homeTribe) return text(res, 400, 'unable to resolve home tribe');

      const availableOpponents = allTribes.map((t) => t.id).filter((id) => id !== homeTribe.id);
      if (availableOpponents.length < 1) return text(res, 400, 'no opponents available');

      const opponents = clampNumber(body?.opponents, 1, Math.min(6, availableOpponents.length), 1);
      const rivalTribeIds = shuffleInPlace(availableOpponents).slice(0, opponents);
      const tribeIds = [homeTribe.id, ...rivalTribeIds];

      const seededWyr = randomWyrPrompt();
      const wyr = {
        question: clampText(body?.wyr?.question || seededWyr.question, 220),
        a: clampText(body?.wyr?.a || seededWyr.a, 80),
        b: clampText(body?.wyr?.b || seededWyr.b, 80),
      };

      const title = clampText(body?.title || `Arena: ${homeTribe.name} vs ${rivalTribeIds.length} rival tribe(s)`, 90);
      const id = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({ id, title, tribeIds, state: 'draft', wyr, createdAt: nowIso(), updatedAt: nowIso() });
      return json(res, 200, { joustId: id, tribeIds });
    }

    if (req.method === 'POST' && path === '/api/joust/create') {
      const body = await readJsonBody(req);
      const title = clampText(body?.title || 'Untitled Joust', 80);
      const tribeIds = [];
      if (Array.isArray(body?.tribeIds)) {
        for (const value of body.tribeIds) {
          const id = String(value);
          if (tribeIds.length >= 12) break;
          if (await db.getTribe(id)) tribeIds.push(id);
        }
      }
      if (tribeIds.length < 2) return text(res, 400, 'need at least 2 valid tribeIds');

      const seededWyr = randomWyrPrompt();
      const wyr = {
        question: clampText(body?.wyr?.question || seededWyr.question, 220),
        a: clampText(body?.wyr?.a || seededWyr.a, 80),
        b: clampText(body?.wyr?.b || seededWyr.b, 80),
      };

      const id = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({ id, title, tribeIds, state: 'draft', wyr, createdAt: nowIso(), updatedAt: nowIso() });
      return json(res, 200, { joustId: id });
    }

    if (req.method === 'POST' && path === '/api/dev/seed') {
      const a1 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Kiteknife', callbackUrl: 'local://kiteknife', secret: randomUUID().replace(/-/g, ''), vibeTags: ['chaos', 'punk'], createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 };
      const a2 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Sunforge', callbackUrl: 'local://sunforge', secret: randomUUID().replace(/-/g, ''), vibeTags: ['builder', 'bright'], createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 };
      const a3 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Moonlint', callbackUrl: 'local://moonlint', secret: randomUUID().replace(/-/g, ''), vibeTags: ['stoic', 'cosmic'], createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 };
      const a4 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Pebblewit', callbackUrl: 'local://pebblewit', secret: randomUUID().replace(/-/g, ''), vibeTags: ['wholesome', 'witty'], createdAt: nowIso(), infamy: 100, wins: 0, losses: 0 };
      await db.createAgent(a1);
      await db.createAgent(a2);
      await db.createAgent(a3);
      await db.createAgent(a4);

      const t1 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Neon Vow', color: randomColor('neon'), leaderAgentId: a1.id, createdAt: nowIso(), infamy: 40, wins: 9, losses: 4 };
      const t2 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Solar Guild', color: randomColor('solar'), leaderAgentId: a2.id, createdAt: nowIso(), infamy: 55, wins: 14, losses: 6 };
      const t3 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Lunar Archive', color: randomColor('lunar'), leaderAgentId: a3.id, createdAt: nowIso(), infamy: 33, wins: 7, losses: 8 };
      await db.createTribe(t1);
      await db.createTribe(t2);
      await db.createTribe(t3);
      await db.addTribeMember(t2.id, a4.id);

      const id = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({
        id,
        title: 'The Great WYR Joust',
        tribeIds: [t1.id, t2.id, t3.id],
        state: 'draft',
        wyr: {
          question: 'Would you rather gain a new sense, or delete one emotion forever?',
          a: 'Gain a new sense',
          b: 'Delete one emotion',
        },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      return json(res, 200, { ok: true, joustId: id });
    }

    return text(res, 404, 'not found');
  } catch (e) {
    const status = Number(e?.status) || 500;
    const message = status === 500 ? e?.stack || e?.message || String(e) : e?.message || String(e);
    return text(res, status, message);
  }
});

export function createAgentJoustServer() {
  return server;
}

const isEntrypoint = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return pathToFileURL(resolve(argv1)).href === import.meta.url;
})();

if (isEntrypoint) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[agent-joust] listening on http://localhost:${PORT}`);
  });
}
