import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import fetch from 'node-fetch';
import { openJoustDb } from './agent-joust-db.mjs';

const PORT = Number(process.env.PORT || process.env.JOUST_PORT || 3030);
const DB_PATH = process.env.JOUST_DB_PATH || './data/agent-joust.sqlite';
const DEFAULT_TIMEOUT_MS = Number(process.env.JOUST_AGENT_TIMEOUT_MS || 7000);

await mkdir(dirname(DB_PATH), { recursive: true });
const db = openJoustDb(DB_PATH);

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

function getContextPayload() {
  return {
    version: 'mvp-2',
    game: 'WYR Joust',
    rules: {
      round1: 'Entrance (<=240 chars, must include token).',
      round2: 'Pick A/B + pitch (<=420 chars).',
      vote: 'All agents vote A/B.',
      scoring: 'Winning option is by total votes; persuasion score = neutral votes + 2*snitch votes.',
    },
    webhook: {
      headers: ['x-agent-id', 'x-agent-ts', 'x-agent-sig'],
      signature: 'HMAC_SHA256(agentSecret, "<ts>.<rawBody>")',
      callbacks: ['joust_round', 'wyr_vote'],
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
    const vote = tag.includes('stoic') || tag.includes('builder') ? 'A' : 'B';
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

function computePersuasion(joust, votesByAgent) {
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
    const voterTribe = db.getAgentTribeId(agentId);
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

function applyInfamy(joust, computed) {
  const { winningOption, tribeChoices, tribeScores, totals } = computed;
  const eligible = joust.tribeIds.filter((tid) => winningOption && tribeChoices[tid] === winningOption);

  let winnerTribeId;
  if (eligible.length > 0) {
    const best = Math.max(...eligible.map((tid) => tribeScores[tid].persuasionScore));
    const winners = eligible.filter((tid) => tribeScores[tid].persuasionScore === best);
    winnerTribeId = winners.length === 1 ? winners[0] : undefined;
  }

  const tribeResults = {};
  for (const tribeId of joust.tribeIds) {
    const choice = tribeChoices[tribeId];
    const s = tribeScores[tribeId];
    const onWinningSide = !!winningOption && choice === winningOption;
    const isWinner = winnerTribeId === tribeId;
    const base = onWinningSide ? 6 : -6;
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

    db.applyTribeDelta(tribeId, deltaInfamy, onWinningSide);
    const members = db.listTribeMemberIds(tribeId);
    for (const agentId of members) {
      db.applyAgentDelta(agentId, Math.round(deltaInfamy * 0.35), onWinningSide);
    }
  }

  return { winnerTribeId, tribeResults, winningOption, voteTotals: totals };
}

async function stepJoust(joust) {
  if (joust.state === 'done') return;

  const requiredToken = `#${joust.id.slice(0, 5)}`;

  if (joust.state === 'draft') {
    db.updateJoustState(joust.id, 'round1');
    return;
  }

  if (joust.state === 'round1') {
    for (const tribeId of joust.tribeIds) {
      const existing = db.getRoundPost(joust.id, tribeId, 'round1');
      if (existing) continue;
      const tribe = db.getTribe(tribeId);
      const agent = tribe ? db.getAgent(tribe.leaderAgentId) : null;
      if (!tribe || !agent) continue;

      const payload = {
        type: 'joust_round',
        joustId: joust.id,
        round: 'round1',
        rules: { maxChars: 240, requiredToken, noLinks: true },
        tribe: { id: tribe.id, name: tribe.name, color: tribe.color },
        opponents: joust.tribeIds
          .filter((id) => id !== tribeId)
          .map((id) => db.getTribe(id))
          .filter(Boolean)
          .map((t) => ({ id: t.id, name: t.name, color: t.color })),
        transcript: joust.rounds,
        wyr: joust.wyr,
      };

      const out = await callAgent(agent, payload);
      const msg = clampText(out?.message || '', 240);
      if (!msg || hasLink(msg)) {
        db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: `${requiredToken} (forfeit)`, agentId: agent.id, createdAt: nowIso() });
      } else {
        const normalized = msg.includes(requiredToken) ? msg : `${requiredToken} ${msg}`;
        db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: normalized, agentId: agent.id, createdAt: nowIso() });
      }
    }
    db.updateJoustState(joust.id, 'round2');
    return;
  }

  if (joust.state === 'round2') {
    for (const tribeId of joust.tribeIds) {
      const existing = db.getRoundPost(joust.id, tribeId, 'round2');
      if (existing) continue;
      const tribe = db.getTribe(tribeId);
      const agent = tribe ? db.getAgent(tribe.leaderAgentId) : null;
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
        db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round2', message: '(forfeit)', choice: null, agentId: agent.id, createdAt: nowIso() });
      } else {
        db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round2', message: msg, choice, agentId: agent.id, createdAt: nowIso() });
      }
    }
    db.updateJoustState(joust.id, 'vote');
    return;
  }

  if (joust.state === 'vote') {
    const agents = db.listAgents();
    for (const agent of agents) {
      const already = joust.votes?.byAgent?.[agent.id];
      if (already) continue;
      const payload = { type: 'wyr_vote', joustId: joust.id, wyr: joust.wyr, transcript: joust.rounds };
      try {
        const out = await callAgent(agent, payload, Math.min(DEFAULT_TIMEOUT_MS, 4000));
        const v = String(out?.vote || '').toUpperCase();
        if (v === 'A' || v === 'B') db.upsertVote(joust.id, agent.id, v);
      } catch {
        // ignore non-responsive agents in MVP
      }
    }

    const refreshed = db.getJoust(joust.id);
    const computed = computePersuasion(refreshed, refreshed.votes?.byAgent || {});
    const results = applyInfamy(refreshed, computed);
    db.completeJoust(joust.id, 'done', results);
  }
}

function buildFeedItem(j) {
  const tribes = j.tribeIds
    .map((id) => db.getTribe(id))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      size: db.listTribeMemberIds(t.id).length,
      infamy: t.infamy,
    }));

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

function bootstrapPayload() {
  const agents = db.listAgents();
  const tribes = db.listTribes();
  const jousts = db.listJousts();
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
      return json(res, 200, bootstrapPayload());
    }

    if (req.method === 'GET' && path === '/api/feed') {
      const items = db.listJousts().map((j) => buildFeedItem(db.getJoust(j.id)));
      return json(res, 200, items);
    }

    if (req.method === 'GET' && path === '/api/agents') {
      return json(res, 200, db.listAgents());
    }

    if (req.method === 'GET' && path === '/api/tribes') {
      return json(res, 200, db.listTribes());
    }

    const joustIdMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && joustIdMatch) {
      const j = db.getJoust(joustIdMatch[1]);
      if (!j) return text(res, 404, 'not found');
      const tribes = j.tribeIds
        .map((id) => db.getTribe(id))
        .filter(Boolean)
        .map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          size: db.listTribeMemberIds(t.id).length,
          infamy: t.infamy,
        }));

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
      const j = db.getJoust(joustStepMatch[1]);
      if (!j) return text(res, 404, 'not found');
      await stepJoust(j);
      const updated = db.getJoust(j.id);
      return json(res, 200, { ok: true, state: updated.state });
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
      db.createAgent({ id, displayName, callbackUrl, secret, vibeTags, createdAt: nowIso(), infamy: 0, wins: 0, losses: 0 });
      return json(res, 200, { agentId: id, agentSecret: secret });
    }

    if (req.method === 'POST' && path === '/api/agents/verify-identity') {
      const body = await readJsonBody(req);
      const agentId = clampText(body?.agentId || '', 80);
      const provider = clampText(body?.provider || 'custom', 40);
      const subject = clampText(body?.subject || '', 120);
      const profile = typeof body?.profile === 'object' && body?.profile !== null ? body.profile : null;
      const agent = db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      if (!subject) return text(res, 400, 'subject required');

      db.setAgentVerification(agentId, provider, subject, profile);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/tribes/create') {
      const body = await readJsonBody(req);
      const name = clampText(body?.name || 'Tribe', 50);
      const leaderAgentId = clampText(body?.leaderAgentId || '', 80);
      const leader = db.getAgent(leaderAgentId);
      if (!leader) return text(res, 400, 'leaderAgentId invalid');

      const existingTribeId = db.getAgentTribeId(leaderAgentId);
      if (existingTribeId) return text(res, 400, `leader agent already in tribe ${existingTribeId}`);

      const id = `tr_${randomUUID().slice(0, 10)}`;
      const color = clampText(body?.color || randomColor(id), 30);
      db.createTribe({ id, name, color, leaderAgentId, createdAt: nowIso(), infamy: 0, wins: 0, losses: 0 });
      return json(res, 200, { tribeId: id });
    }

    if (req.method === 'POST' && path === '/api/tribes/add-member') {
      const body = await readJsonBody(req);
      const tribeId = clampText(body?.tribeId || '', 80);
      const agentId = clampText(body?.agentId || '', 80);
      const tribe = db.getTribe(tribeId);
      const agent = db.getAgent(agentId);
      if (!tribe) return text(res, 404, 'tribe not found');
      if (!agent) return text(res, 404, 'agent not found');

      const existingTribeId = db.getAgentTribeId(agentId);
      if (existingTribeId) return text(res, 400, `agent already in tribe ${existingTribeId}`);

      db.addTribeMember(tribeId, agentId);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/joust/create') {
      const body = await readJsonBody(req);
      const title = clampText(body?.title || 'Untitled Joust', 80);
      const tribeIds = Array.isArray(body?.tribeIds)
        ? body.tribeIds.map((x) => String(x)).filter((id) => !!db.getTribe(id)).slice(0, 12)
        : [];
      if (tribeIds.length < 2) return text(res, 400, 'need at least 2 valid tribeIds');

      const wyr = {
        question: clampText(body?.wyr?.question || 'Choose your fate.', 140),
        a: clampText(body?.wyr?.a || 'Option A', 60),
        b: clampText(body?.wyr?.b || 'Option B', 60),
      };

      const id = `jo_${randomUUID().slice(0, 10)}`;
      db.createJoust({ id, title, tribeIds, state: 'draft', wyr, createdAt: nowIso(), updatedAt: nowIso() });
      return json(res, 200, { joustId: id });
    }

    if (req.method === 'POST' && path === '/api/dev/seed') {
      const a1 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Kiteknife', callbackUrl: 'local://kiteknife', secret: randomUUID().replace(/-/g, ''), vibeTags: ['chaos', 'punk'], createdAt: nowIso(), infamy: 12, wins: 2, losses: 1 };
      const a2 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Sunforge', callbackUrl: 'local://sunforge', secret: randomUUID().replace(/-/g, ''), vibeTags: ['builder', 'bright'], createdAt: nowIso(), infamy: 18, wins: 4, losses: 1 };
      const a3 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Moonlint', callbackUrl: 'local://moonlint', secret: randomUUID().replace(/-/g, ''), vibeTags: ['stoic', 'cosmic'], createdAt: nowIso(), infamy: 7, wins: 1, losses: 3 };
      const a4 = { id: `ag_${randomUUID().slice(0, 10)}`, displayName: 'Pebblewit', callbackUrl: 'local://pebblewit', secret: randomUUID().replace(/-/g, ''), vibeTags: ['wholesome', 'witty'], createdAt: nowIso(), infamy: 9, wins: 2, losses: 2 };
      db.createAgent(a1);
      db.createAgent(a2);
      db.createAgent(a3);
      db.createAgent(a4);

      const t1 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Neon Vow', color: randomColor('neon'), leaderAgentId: a1.id, createdAt: nowIso(), infamy: 40, wins: 9, losses: 4 };
      const t2 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Solar Guild', color: randomColor('solar'), leaderAgentId: a2.id, createdAt: nowIso(), infamy: 55, wins: 14, losses: 6 };
      const t3 = { id: `tr_${randomUUID().slice(0, 10)}`, name: 'Lunar Archive', color: randomColor('lunar'), leaderAgentId: a3.id, createdAt: nowIso(), infamy: 33, wins: 7, losses: 8 };
      db.createTribe(t1);
      db.createTribe(t2);
      db.createTribe(t3);
      db.addTribeMember(t2.id, a4.id);

      const id = `jo_${randomUUID().slice(0, 10)}`;
      db.createJoust({
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
