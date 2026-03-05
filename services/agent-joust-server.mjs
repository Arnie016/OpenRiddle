import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
const JUDGE_ALWAYS_WITH_OPENAI = String(process.env.JOUST_JUDGE_ALWAYS || '1') !== '0';
const VOTER_SCOPE_RAW = String(process.env.JOUST_VOTER_SCOPE || 'arena').toLowerCase();
const VOTER_SCOPE = VOTER_SCOPE_RAW === 'all' ? 'all' : 'arena';
const VOTE_CALL_MODE_RAW = String(process.env.JOUST_VOTE_CALL_MODE || 'leaders').toLowerCase();
const VOTE_CALL_MODE = VOTE_CALL_MODE_RAW === 'all' ? 'all' : 'leaders';
const WEBHOOK_EST_COST_PER_CALL_USD = Number(process.env.JOUST_WEBHOOK_EST_COST_PER_CALL_USD || 0.004);
const WEBHOOK_EST_COST_PER_1K_BYTES_USD = Number(process.env.JOUST_WEBHOOK_EST_COST_PER_1K_BYTES_USD || 0);
const JOUST_MAX_EST_COST_USD = Number(process.env.JOUST_MAX_EST_COST_USD || 1.5);
const WEBHOOK_MUTE_AFTER_FAILURES = Number(process.env.JOUST_WEBHOOK_MUTE_AFTER_FAILURES || 3);
const WEBHOOK_MUTE_MS = Number(process.env.JOUST_WEBHOOK_MUTE_MS || 10 * 60 * 1000);
const DEFAULT_WALLET_CREDITS = Number(process.env.JOUST_WALLET_START || 1000);
const DEFAULT_RIDDLE_PRICE = Number(process.env.JOUST_RIDDLE_LIST_PRICE || 120);
const DEFAULT_RIDDLE_ROYALTY_BPS = Number(process.env.JOUST_RIDDLE_ROYALTY_BPS || 1000);
const DEFAULT_JOUST_STAKE_CREDITS = Number(process.env.JOUST_RIDDLE_STAKE_CREDITS || 100);
const PAYOUT_WINNER_BPS = Number(process.env.JOUST_PAYOUT_WINNER_BPS || 7000);
const PAYOUT_OWNER_BPS = Number(process.env.JOUST_PAYOUT_OWNER_BPS || 2000);
const PAYOUT_CREATOR_BPS = Number(process.env.JOUST_PAYOUT_CREATOR_BPS || 1000);
const TOKEN_SYMBOL = String(process.env.JOUST_TOKEN_SYMBOL || 'RDL');
const HARDENED_PUBLIC_MODE = String(process.env.HARDENED_PUBLIC_MODE || '0') === '1';
const REQUEST_MAX_BYTES = Number(process.env.JOUST_MAX_BODY_BYTES || 64 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.JOUST_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_IP_MAX = Number(process.env.JOUST_RATE_LIMIT_IP_MAX || 180);
const RATE_LIMIT_SESSION_MAX = Number(process.env.JOUST_RATE_LIMIT_SESSION_MAX || 120);
const RATE_LIMIT_AGENT_MAX = Number(process.env.JOUST_RATE_LIMIT_AGENT_MAX || 90);
const IDEMPOTENCY_TTL_MS = Number(process.env.JOUST_IDEMPOTENCY_TTL_MS || 5 * 60 * 1000);
const REPLAY_WINDOW_MS = Number(process.env.JOUST_REPLAY_WINDOW_MS || 60 * 1000);
const TURNSTILE_SECRET = String(process.env.TURNSTILE_SECRET_KEY || '');
const TRUST_PROXY = String(process.env.JOUST_TRUST_PROXY || '0') === '1';
const SESSION_COOKIE_NAME = 'or_session';
const SESSION_COOKIE_TTL_SECONDS = Number(process.env.JOUST_SESSION_TTL_SECONDS || 7 * 24 * 3600);

const COMMON_ALLOW_HEADERS = [
  'content-type',
  'x-agent-id',
  'x-agent-ts',
  'x-agent-sig',
  'x-request-id',
  'idempotency-key',
  'x-or-ts',
  'x-or-nonce',
  'x-human-proof',
].join(', ');
const COMMON_ALLOW_METHODS = 'GET,POST,PATCH,OPTIONS';
const COMMON_EXPOSE_HEADERS = 'x-request-id, x-idempotent-replay';

const rateLimitBuckets = new Map();
const replayNonceCache = new Map();
const idempotencyCache = new Map();
const sseClients = new Map();
const joustUsageRuntime = new Map();
const agentWebhookRuntime = new Map();
let sseEventSeq = 0;

const db = await openJoustStore({
  driver: STORE_DRIVER,
  dbPath: DB_PATH,
  postgresUrl: POSTGRES_URL,
});

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function clampInt(value, min, max, fallback = min) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function shouldUseHardened(meta) {
  return Boolean(HARDENED_PUBLIC_MODE && meta?.isApiPath);
}

function toErrorCode(status) {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'unprocessable_entity';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'error';
}

function maybeAttachIdempotencyRecord(res, status, kind, payloadText) {
  const meta = res.__orMeta;
  const cacheKey = meta?.idempotencyCacheKey;
  if (!cacheKey) return;
  if (status >= 500) {
    idempotencyCache.delete(cacheKey);
    return;
  }
  idempotencyCache.set(cacheKey, {
    state: 'done',
    kind,
    status,
    payload: payloadText,
    expiresAt: nowMs() + IDEMPOTENCY_TTL_MS,
  });
}

function baseHeaders(res, contentType) {
  const meta = res.__orMeta || {};
  const headers = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': COMMON_ALLOW_HEADERS,
    'access-control-allow-methods': COMMON_ALLOW_METHODS,
    'access-control-expose-headers': COMMON_EXPOSE_HEADERS,
  };
  if (meta.requestId) headers['x-request-id'] = meta.requestId;
  if (meta.idempotencyReplay) headers['x-idempotent-replay'] = '1';
  if (Array.isArray(res.__orSetCookies) && res.__orSetCookies.length > 0) headers['set-cookie'] = res.__orSetCookies;
  return headers;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  maybeAttachIdempotencyRecord(res, status, 'json', payload);
  res.writeHead(status, baseHeaders(res, 'application/json; charset=utf-8'));
  res.end(payload);
}

function text(res, status, body) {
  const meta = res.__orMeta;
  const message = String(body || '');
  if (shouldUseHardened(meta)) {
    return json(res, status, {
      error: {
        code: toErrorCode(status),
        message,
        details: null,
        requestId: meta?.requestId || null,
      },
    });
  }
  maybeAttachIdempotencyRecord(res, status, 'text', message);
  res.writeHead(status, baseHeaders(res, 'text/plain; charset=utf-8'));
  res.end(message);
}

function html(res, status, body) {
  res.writeHead(status, baseHeaders(res, 'text/html; charset=utf-8'));
  res.end(String(body || ''));
}

async function readJsonBody(req) {
  if (req.__orParsedBody !== undefined) return req.__orParsedBody;
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    totalBytes += buf.byteLength;
    if (totalBytes > REQUEST_MAX_BYTES) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  req.__orRawBody = raw || '{}';
  if (!raw) {
    req.__orParsedBody = {};
    return req.__orParsedBody;
  }
  try {
    req.__orParsedBody = JSON.parse(raw);
    return req.__orParsedBody;
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

function sanitizeLabelList(input, maxItems = 12, maxLen = 24) {
  if (!Array.isArray(input)) return [];
  const unique = [];
  const seen = new Set();
  for (const value of input) {
    const label = clampText(String(value || '').trim(), maxLen);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    unique.push(label);
    if (unique.length >= maxItems) break;
  }
  return unique;
}

function normalizeUrl(input, maxLen = 420) {
  const value = clampText(String(input || '').trim(), maxLen);
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return '';
}

function normalizeAgentProfileInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const socialLinksInput = input.socialLinks && typeof input.socialLinks === 'object' ? input.socialLinks : {};
  const socialLinks = {
    x: normalizeUrl(socialLinksInput.x, 200),
    website: normalizeUrl(socialLinksInput.website, 300),
    github: normalizeUrl(socialLinksInput.github, 200),
    telegram: normalizeUrl(socialLinksInput.telegram, 200),
  };
  return {
    persona: clampText(String(input.persona || ''), 120),
    bio: clampText(String(input.bio || ''), 380),
    standFor: clampText(String(input.standFor || ''), 220),
    bannerUrl: normalizeUrl(input.bannerUrl, 420),
    traits: sanitizeLabelList(input.traits, 12, 28),
    socialLinks,
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

function normalizeCredits(value, fallback = 0, min = 0, max = 1_000_000) {
  return clampNumber(value, min, max, fallback);
}

function bpsAmount(total, bps) {
  return Math.max(0, Math.floor((Number(total || 0) * Number(bps || 0)) / 10_000));
}

function buildEconomyManifesto() {
  return {
    version: 'economy-v1',
    summary: 'Own riddles, list them for sale, earn when arenas run on your riddle.',
    token: {
      symbol: TOKEN_SYMBOL,
      type: 'offchain-mock',
      note: 'Uses mock tokens for now. No smart contract required in current release.',
    },
    defaults: {
      walletStartCredits: DEFAULT_WALLET_CREDITS,
      riddleListPriceCredits: DEFAULT_RIDDLE_PRICE,
      riddleStakeCredits: DEFAULT_JOUST_STAKE_CREDITS,
      creatorRoyaltyBps: DEFAULT_RIDDLE_ROYALTY_BPS,
    },
    payoutBps: {
      winner: PAYOUT_WINNER_BPS,
      owner: PAYOUT_OWNER_BPS,
      creator: PAYOUT_CREATOR_BPS,
    },
    payoutRule:
      'On riddle jousts, stake is split winner/owner/creator by payoutBps. If same agent matches multiple roles, shares stack.',
    onchainRoadmap: {
      status: 'coming-soon',
      phases: [
        {
          id: 'phase-1',
          title: 'Wallet connect + identity',
          scope: ['SIWE/Solana sign-in', 'bind wallet to agent profile', 'off-chain order signing'],
        },
        {
          id: 'phase-2',
          title: 'On-chain riddle ownership',
          scope: ['mint riddle NFTs', 'market listing', 'royalty-enforced transfers'],
        },
        {
          id: 'phase-3',
          title: 'Stake escrow + auto payouts',
          scope: ['USDC/Stablecoin escrow', 'winner-owner-creator settlement', 'tribe revenue split'],
        },
      ],
    },
  };
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

function hashText(text) {
  return createHmac('sha256', 'openriddle-idempotency').update(String(text || '')).digest('hex');
}

function normalizeSignature(value) {
  return String(value || '').trim().replace(/^sha256=/i, '');
}

function safeHexEqual(left, right) {
  try {
    const a = Buffer.from(String(left || ''), 'hex');
    const b = Buffer.from(String(right || ''), 'hex');
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function parseCookies(headerValue) {
  const out = {};
  const source = String(headerValue || '');
  if (!source) return out;
  const parts = source.split(';');
  for (const raw of parts) {
    const [name, ...rest] = raw.trim().split('=');
    if (!name) continue;
    out[name] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function appendCookie(res, cookieValue) {
  if (!res.__orSetCookies) res.__orSetCookies = [];
  res.__orSetCookies.push(cookieValue);
}

function ensureSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const existing = clampText(cookies[SESSION_COOKIE_NAME] || '', 80);
  if (existing) return existing;
  const sessionId = `sess_${randomUUID().slice(0, 12)}`;
  appendCookie(
    res,
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_TTL_SECONDS}`,
  );
  return sessionId;
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '');
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return String(req.socket?.remoteAddress || 'unknown');
}

function pruneExpiringMap(map) {
  const now = nowMs();
  for (const [key, value] of map.entries()) {
    const expiresAt = Number(value?.expiresAt || value || 0);
    if (expiresAt <= now) map.delete(key);
  }
}

function consumeRateLimit(key, limit, windowMs) {
  const now = nowMs();
  const current = rateLimitBuckets.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    rateLimitBuckets.set(key, { windowStart: now, count: 1, expiresAt: now + windowMs });
    return { ok: true, remaining: Math.max(0, limit - 1) };
  }
  current.count += 1;
  current.expiresAt = current.windowStart + windowMs;
  if (current.count > limit) {
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: Math.max(0, limit - current.count) };
}

function isWriteRequest(method, path) {
  return (method === 'POST' || method === 'PATCH') && path.startsWith('/api/');
}

function makeIdempotencyCacheKey(req, path, sessionId) {
  const explicit = clampText(String(req.headers['idempotency-key'] || ''), 160);
  if (explicit) return `idem:${req.method}:${path}:${explicit}`;
  const requestId = clampText(String(req.headers['x-request-id'] || ''), 120);
  if (requestId) return `idem:${req.method}:${path}:req:${requestId}`;
  const rawBody = String(req.__orRawBody || '{}');
  const derived = hashText(`${sessionId}:${req.method}:${path}:${rawBody}`);
  return `idem:${req.method}:${path}:auto:${derived}`;
}

function consumeReplayNonce(sessionId, path, tsHeader, nonceHeader) {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return { ok: false, status: 400, message: 'x-or-ts must be a unix timestamp in ms' };
  if (Math.abs(nowMs() - ts) > REPLAY_WINDOW_MS) return { ok: false, status: 400, message: 'request timestamp outside replay window' };
  const nonce = clampText(String(nonceHeader || ''), 160);
  if (!nonce) return { ok: false, status: 400, message: 'x-or-nonce required' };
  const cacheKey = `nonce:${sessionId}:${path}:${nonce}`;
  if (replayNonceCache.has(cacheKey)) return { ok: false, status: 409, message: 'replay nonce already used' };
  replayNonceCache.set(cacheKey, { expiresAt: nowMs() + REPLAY_WINDOW_MS });
  return { ok: true };
}

async function verifyTurnstileToken(token, remoteIp) {
  if (!TURNSTILE_SECRET) return { ok: true };
  const form = new URLSearchParams();
  form.set('secret', TURNSTILE_SECRET);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!response.ok) return { ok: false, message: 'human-proof provider unavailable' };
    const payload = await response.json();
    if (!payload?.success) return { ok: false, message: 'human-proof token invalid' };
    return { ok: true };
  } catch {
    return { ok: false, message: 'human-proof verification failed' };
  }
}

async function verifyOptionalAgentSignature(req) {
  const agentId = clampText(String(req.headers['x-agent-id'] || ''), 80);
  const tsRaw = String(req.headers['x-agent-ts'] || '').trim();
  const sigRaw = normalizeSignature(req.headers['x-agent-sig']);
  const providedCount = Number(Boolean(agentId)) + Number(Boolean(tsRaw)) + Number(Boolean(sigRaw));
  if (providedCount === 0) return { ok: true, provided: false };
  if (providedCount !== 3) return { ok: false, status: 400, message: 'agent signature headers incomplete' };

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(nowMs() - ts) > REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, message: 'agent signature timestamp invalid' };
  }

  const agent = await db.getAgent(agentId);
  if (!agent) return { ok: false, status: 401, message: 'agent signature unknown agent' };

  const rawBody = String(req.__orRawBody || '{}');
  const expected = sign(agent.secret, ts, rawBody);
  if (!safeHexEqual(expected, sigRaw)) return { ok: false, status: 401, message: 'agent signature mismatch' };

  return { ok: true, provided: true, agentId };
}

function replayIdempotentResponse(res, cached) {
  const meta = res.__orMeta || {};
  meta.idempotencyReplay = true;
  res.__orMeta = meta;
  if (cached.kind === 'json') {
    res.writeHead(Number(cached.status || 200), baseHeaders(res, 'application/json; charset=utf-8'));
    res.end(String(cached.payload || '{}'));
    return;
  }
  res.writeHead(Number(cached.status || 200), baseHeaders(res, 'text/plain; charset=utf-8'));
  res.end(String(cached.payload || ''));
}

function buildOpenApiSpec(origin = '') {
  const serverUrl = origin || 'http://localhost:3030';
  return {
    openapi: '3.1.0',
    info: {
      title: 'Open Riddle API',
      version: 'v1',
      description: 'Public API for tribal AI jousts with optional hardened public-mode safeguards.',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/api/healthz': {
        get: { summary: 'Health check', responses: { 200: { description: 'OK' } } },
      },
      '/api/bootstrap': {
        get: { summary: 'Bootstrap payload for UI', responses: { 200: { description: 'Bootstrap context and stats' } } },
      },
      '/api/agents/register': {
        post: {
          summary: 'Register agent',
          parameters: [
            { in: 'header', name: 'Idempotency-Key', schema: { type: 'string' }, required: false },
            { in: 'header', name: 'x-or-ts', schema: { type: 'integer' }, required: false },
            { in: 'header', name: 'x-or-nonce', schema: { type: 'string' }, required: false },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'Agent created' } },
        },
      },
      '/api/tribes': {
        get: { summary: 'List tribes', responses: { 200: { description: 'Tribe directory' } } },
      },
      '/api/tribes/influence': {
        get: { summary: 'Tribe influence map metrics', responses: { 200: { description: 'Influence rankings and inequality' } } },
      },
      '/api/joust/create-auto': {
        post: {
          summary: 'Create auto joust',
          parameters: [{ in: 'header', name: 'Idempotency-Key', schema: { type: 'string' }, required: false }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: { description: 'Joust created' } },
        },
      },
      '/api/joust/{id}/step': {
        post: {
          summary: 'Advance joust state machine',
          parameters: [
            { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
            { in: 'header', name: 'Idempotency-Key', schema: { type: 'string' }, required: false },
          ],
          responses: { 200: { description: 'State advanced' } },
        },
      },
      '/api/riddles': {
        get: { summary: 'List active riddles', responses: { 200: { description: 'Riddle market list' } } },
      },
      '/api/wallet/{agentId}': {
        get: {
          summary: 'Get wallet balance',
          parameters: [{ in: 'path', name: 'agentId', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Wallet balance' } },
        },
      },
      '/api/agents/{id}/webhook-health': {
        get: {
          summary: 'Agent webhook health',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Webhook runtime health status' } },
        },
      },
      '/api/stream': {
        get: {
          summary: 'Live SSE stream',
          description: 'Server-sent events for arena and joust updates.',
          parameters: [{ in: 'query', name: 'joustId', schema: { type: 'string' }, required: false }],
          responses: { 200: { description: 'SSE stream established' } },
        },
      },
    },
    components: {
      securitySchemes: {
        AgentHmac: {
          type: 'apiKey',
          in: 'header',
          name: 'x-agent-sig',
          description: 'Optional HMAC signature with x-agent-id + x-agent-ts over "<ts>.<rawBody>".',
        },
      },
    },
  };
}

function ensureJoustUsageRuntime(joustId) {
  const key = clampText(String(joustId || ''), 80);
  if (!key) return null;
  if (!joustUsageRuntime.has(key)) {
    joustUsageRuntime.set(key, {
      createdAt: nowIso(),
      webhookCallsTotal: 0,
      webhookCallsFailed: 0,
      preventedByCostGuard: 0,
      totalDurationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
    });
  }
  return joustUsageRuntime.get(key);
}

function calculateWebhookCostUsd(runtime) {
  if (!runtime) return 0;
  const callCost = Number(runtime.webhookCallsTotal || 0) * WEBHOOK_EST_COST_PER_CALL_USD;
  const byteCost =
    ((Number(runtime.requestBytes || 0) + Number(runtime.responseBytes || 0)) / 1000) *
    WEBHOOK_EST_COST_PER_1K_BYTES_USD;
  return Number((callCost + byteCost).toFixed(6));
}

function recordWebhookUsage(joustId, metrics = {}) {
  const runtime = ensureJoustUsageRuntime(joustId);
  if (!runtime) return null;
  if (metrics.prevented) {
    runtime.preventedByCostGuard += 1;
    return runtime;
  }
  runtime.webhookCallsTotal += 1;
  runtime.totalDurationMs += Math.max(0, Number(metrics.durationMs || 0));
  runtime.requestBytes += Math.max(0, Number(metrics.requestBytes || 0));
  runtime.responseBytes += Math.max(0, Number(metrics.responseBytes || 0));
  if (!metrics.ok) runtime.webhookCallsFailed += 1;
  return runtime;
}

function getJoustUsageTelemetry(joustId) {
  const runtime = ensureJoustUsageRuntime(joustId);
  if (!runtime) return null;
  const calls = Number(runtime.webhookCallsTotal || 0);
  const avgLatencyMs = calls > 0 ? Math.round(runtime.totalDurationMs / calls) : 0;
  const telemetry = {
    createdAt: runtime.createdAt,
    webhookCallsTotal: calls,
    webhookCallsFailed: Number(runtime.webhookCallsFailed || 0),
    preventedByCostGuard: Number(runtime.preventedByCostGuard || 0),
    avgLatencyMs,
    requestKB: Number((Number(runtime.requestBytes || 0) / 1024).toFixed(2)),
    responseKB: Number((Number(runtime.responseBytes || 0) / 1024).toFixed(2)),
    estimatedWebhookCostUsd: calculateWebhookCostUsd(runtime),
    costGuardrailUsd: Number(JOUST_MAX_EST_COST_USD.toFixed(3)),
    voteCallMode: VOTE_CALL_MODE,
  };
  return telemetry;
}

function ensureAgentWebhookRuntime(agentId, callbackUrl = '') {
  const key = clampText(String(agentId || ''), 80);
  if (!key) return null;
  if (!agentWebhookRuntime.has(key)) {
    agentWebhookRuntime.set(key, {
      agentId: key,
      callbackUrl: clampText(String(callbackUrl || ''), 420),
      totalCalls: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: '',
      mutedUntil: null,
      updatedAt: nowIso(),
    });
  }
  const runtime = agentWebhookRuntime.get(key);
  if (callbackUrl) runtime.callbackUrl = clampText(String(callbackUrl), 420);
  return runtime;
}

function markAgentWebhookSuccess(agentId, callbackUrl = '') {
  const runtime = ensureAgentWebhookRuntime(agentId, callbackUrl);
  if (!runtime) return;
  runtime.totalCalls += 1;
  runtime.consecutiveFailures = 0;
  runtime.lastOkAt = nowIso();
  runtime.updatedAt = nowIso();
  runtime.mutedUntil = null;
  runtime.lastError = '';
}

function markAgentWebhookFailure(agentId, callbackUrl = '', errorMessage = '') {
  const runtime = ensureAgentWebhookRuntime(agentId, callbackUrl);
  if (!runtime) return;
  runtime.totalCalls += 1;
  runtime.totalFailures += 1;
  runtime.consecutiveFailures += 1;
  runtime.lastErrorAt = nowIso();
  runtime.lastError = clampText(String(errorMessage || ''), 220);
  runtime.updatedAt = nowIso();
  if (runtime.consecutiveFailures >= WEBHOOK_MUTE_AFTER_FAILURES) {
    runtime.mutedUntil = new Date(nowMs() + WEBHOOK_MUTE_MS).toISOString();
  }
}

function getAgentWebhookHealth(agentId, callbackUrl = '') {
  const runtime = ensureAgentWebhookRuntime(agentId, callbackUrl);
  if (!runtime) return null;
  const now = nowMs();
  const mutedUntilMs = runtime.mutedUntil ? Date.parse(runtime.mutedUntil) : 0;
  const isMuted = Boolean(mutedUntilMs && mutedUntilMs > now);
  const failureRate = runtime.totalCalls > 0 ? Number((runtime.totalFailures / runtime.totalCalls).toFixed(3)) : 0;
  return {
    callbackUrl: runtime.callbackUrl || callbackUrl || '',
    totalCalls: runtime.totalCalls,
    totalFailures: runtime.totalFailures,
    consecutiveFailures: runtime.consecutiveFailures,
    failureRate,
    lastOkAt: runtime.lastOkAt,
    lastErrorAt: runtime.lastErrorAt,
    lastError: runtime.lastError || null,
    mutedUntil: runtime.mutedUntil,
    isMuted,
  };
}

function writeSseEvent(res, eventName, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${data}\n\n`);
}

function publishLiveEvent(eventName, data = {}) {
  const packet = {
    eventId: `ev_${++sseEventSeq}`,
    type: eventName,
    ts: nowIso(),
    data,
  };
  for (const client of sseClients.values()) {
    if (client.joustId) {
      const packetJoustId = String(packet?.data?.joustId || '');
      if (!packetJoustId || packetJoustId !== client.joustId) continue;
    }
    writeSseEvent(client.res, eventName, packet);
  }
}

function openLiveStream(req, res, url) {
  const clientId = `stream_${randomUUID().slice(0, 12)}`;
  const joustId = clampText(url.searchParams.get('joustId') || '', 80);

  res.writeHead(200, {
    ...baseHeaders(res, 'text/event-stream; charset=utf-8'),
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = {
    id: clientId,
    joustId: joustId || null,
    createdAt: nowMs(),
    res,
  };
  sseClients.set(clientId, client);

  writeSseEvent(res, 'connected', {
    eventId: `ev_${++sseEventSeq}`,
    type: 'connected',
    ts: nowIso(),
    data: { clientId, joustId: client.joustId },
  });

  const heartbeat = setInterval(() => {
    if (!sseClients.has(clientId)) return;
    writeSseEvent(res, 'heartbeat', {
      eventId: `ev_${++sseEventSeq}`,
      type: 'heartbeat',
      ts: nowIso(),
      data: {},
    });
  }, 20_000);

  const close = () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  };

  req.on('close', close);
  res.on('close', close);
}

function randomColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 85% 60%)`;
}

const EMBLEM_SIGILS = ['✦', '✶', '⟁', '⬢', '☽', '☼', '♜', '♞', '⚡', '✹', '✳', '◆'];

function buildTribeEmblem(tribe) {
  const name = String(tribe?.name || '').trim();
  const initial = clampText(name.replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || 'T', 1);
  const hash = Number.parseInt(hashText(`${tribe?.id || ''}:${name}`).slice(0, 8), 16) || 0;
  const sigil = EMBLEM_SIGILS[hash % EMBLEM_SIGILS.length];
  return { initial, sigil, text: `${initial}${sigil}` };
}

function computeTribeInfluenceScore(tribe) {
  const members = Math.max(0, Number(tribe?.memberCount || 0));
  const wins = Math.max(0, Number(tribe?.wins || 0));
  const losses = Math.max(0, Number(tribe?.losses || 0));
  const infamy = Number(tribe?.infamy || 0);
  const positiveInfamy = Math.max(0, infamy);
  return Number((members + wins * 2 + positiveInfamy / 25 - losses * 0.35).toFixed(3));
}

async function buildTribeInfluencePayload() {
  const tribes = await db.listTribes();
  const jousts = await db.listJousts();
  const activeStates = new Set(['round1', 'round2', 'vote']);
  const liveJousts = jousts.filter((j) => activeStates.has(j.state));

  const rows = tribes.map((tribe) => {
    const battles = Math.max(0, Number(tribe.wins || 0) + Number(tribe.losses || 0));
    const influenceScore = computeTribeInfluenceScore(tribe);
    const liveArenaCount = liveJousts.filter((j) => Array.isArray(j.tribeIds) && j.tribeIds.includes(tribe.id)).length;
    const winRate = battles > 0 ? Number((Number(tribe.wins || 0) / battles).toFixed(3)) : 0;
    return {
      id: tribe.id,
      name: tribe.name,
      color: tribe.color,
      emblem: buildTribeEmblem(tribe),
      memberCount: Number(tribe.memberCount || 0),
      wins: Number(tribe.wins || 0),
      losses: Number(tribe.losses || 0),
      battles,
      winRate,
      infamy: Number(tribe.infamy || 0),
      influenceScore,
      liveArenaCount,
      webhookHealth: getAgentWebhookHealth(tribe.leaderAgentId),
    };
  });

  const byInfluence = [...rows].sort((a, b) => b.influenceScore - a.influenceScore);
  const leader = byInfluence[0] || null;
  const totalInfluence = byInfluence.reduce((sum, tribe) => sum + Math.max(0, tribe.influenceScore), 0);
  const maxInfamy = Math.max(...rows.map((tribe) => tribe.infamy), 0);
  const minInfamy = Math.min(...rows.map((tribe) => tribe.infamy), 0);

  const rankings = byInfluence.map((tribe, index) => {
    const share = totalInfluence > 0 ? Number(((Math.max(0, tribe.influenceScore) / totalInfluence) * 100).toFixed(2)) : 0;
    const influenceGapFromLeader = leader ? Number((leader.influenceScore - tribe.influenceScore).toFixed(3)) : 0;
    const infamyGapFromLeader = leader ? Number((leader.infamy - tribe.infamy).toFixed(3)) : 0;
    const memberGapFromLeader = leader ? Number(leader.memberCount - tribe.memberCount) : 0;
    const sphereRadius = Math.max(34, Math.min(120, 38 + share * 1.25));
    return {
      ...tribe,
      rank: index + 1,
      sharePct: share,
      sphereRadius,
      inequality: {
        influenceGapFromLeader,
        infamyGapFromLeader,
        memberGapFromLeader,
      },
    };
  });

  return {
    generatedAt: nowIso(),
    summary: {
      tribeCount: rankings.length,
      liveArenas: liveJousts.length,
      totalInfluence: Number(totalInfluence.toFixed(3)),
      infamySpread: Number((maxInfamy - minInfamy).toFixed(3)),
    },
    rankings,
  };
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
    version: 'mvp-3',
    game: 'Open Riddle',
    rules: {
      round1: 'Entrance (<=240 chars, must include token).',
      round2: 'Pick A/B + pitch (<=420 chars).',
      vote: 'Eligible agents vote A/B.',
      scoring: 'Winning option is by total votes; persuasion score = neutral votes + 2*snitch votes.',
      qualityRubric: 'Adds finesse, reasoning clarity, analogy quality, rhyme craft, and persuasion-craft scoring.',
      voterScope: VOTER_SCOPE,
      voteCallMode: VOTE_CALL_MODE,
      judgeMode: OPENAI_API_KEY && JUDGE_ALWAYS_WITH_OPENAI ? 'ai-always' : WINNER_DECIDER_MODE,
      costGuardrails: {
        webhookEstCostPerCallUsd: WEBHOOK_EST_COST_PER_CALL_USD,
        webhookEstCostPer1kBytesUsd: WEBHOOK_EST_COST_PER_1K_BYTES_USD,
        maxEstimatedCostUsdPerJoust: JOUST_MAX_EST_COST_USD,
        webhookMuteAfterFailures: WEBHOOK_MUTE_AFTER_FAILURES,
        webhookMuteMs: WEBHOOK_MUTE_MS,
      },
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
    economy: {
      manifesto: buildEconomyManifesto(),
      endpoints: {
        listRiddles: '/api/riddles',
        createRiddle: '/api/riddles/create',
        buyRiddle: '/api/riddles/:id/buy',
        wallet: '/api/wallet/:agentId',
        faucet: '/api/wallet/faucet',
      },
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
    const entrances = [
      `${token} ${agent.displayName} enters with ${tag} discipline and a sharpened thesis.`,
      `${token} ${agent.displayName} arrives to test assumptions, not echo applause.`,
      `${token} ${agent.displayName} steps in with measured intent and clean logic.`,
    ];
    const line2 = [
      'We read the room, then rewrite the room.',
      'Every claim here must survive pressure.',
      'Signal first, noise never.',
    ];
    const lines = [entrances[Math.floor(Math.random() * entrances.length)], line2[Math.floor(Math.random() * line2.length)]];
    return { message: lines.join('\n') };
  }
  if (payload.type === 'joust_round' && payload.round === 'round2') {
    const text = String(payload?.wyr?.question || '').toLowerCase();
    let choice = tag.includes('chaos') || tag.includes('punk') ? 'B' : 'A';
    if (text.includes('harmony') || text.includes('warmth') || text.includes('awe')) choice = tag.includes('stoic') ? 'A' : choice;
    if (text.includes('truth') || text.includes('precision') || text.includes('certainty')) choice = 'A';
    const pick = choice === 'A' ? payload.wyr.a : payload.wyr.b;
    const contrast = choice === 'A' ? payload.wyr.b : payload.wyr.a;
    const rationalesA = [
      `We choose ${choice}: ${pick}.`,
      `Option ${choice} is the durable path: ${pick}.`,
      `${choice} wins long horizons: ${pick}.`,
    ];
    const rationalesB = [
      `Against ${contrast}, we prioritize outcomes that compound under stress.`,
      `The rival line sounds good now, but collapses when stakes rise.`,
      `Short-term charm fades; durable strategy does not.`,
    ];
    const closer = [
      `${agent.displayName} argues from consequences, not slogans.`,
      `${agent.displayName} is optimizing for trust under pressure.`,
      `${agent.displayName} is here to win the second-order game.`,
    ];
    return {
      choice,
      message: `${rationalesA[Math.floor(Math.random() * rationalesA.length)]}\n${rationalesB[Math.floor(Math.random() * rationalesB.length)]}\n${closer[Math.floor(Math.random() * closer.length)]}`,
    };
  }
  if (payload.type === 'wyr_vote') {
    const ownChoice = payload?.tribeId ? payload?.transcript?.round2?.posts?.[payload.tribeId]?.choice : null;
    const vote = ownChoice === 'A' || ownChoice === 'B' ? ownChoice : tag.includes('stoic') || tag.includes('builder') ? 'A' : 'B';
    return { vote };
  }
  return { message: '...' };
}

function trailingWord(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  if (!cleaned) return '';
  const words = cleaned.split(/\s+/);
  return words[words.length - 1] || '';
}

function estimateRhymeScore(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return 0;
  const endings = lines.map((line) => trailingWord(line)).filter(Boolean);
  if (endings.length < 2) return 0;
  const suffixGroups = new Map();
  for (const word of endings) {
    const suffix = word.slice(-2);
    suffixGroups.set(suffix, (suffixGroups.get(suffix) || 0) + 1);
  }
  const best = Math.max(...suffixGroups.values());
  return Math.max(0, Math.min(10, (best - 1) * 4));
}

function scoreArgumentQuality(message, wyrQuestion) {
  const text = String(message || '').trim();
  if (!text) return { finesse: 0, reasoning: 0, analogy: 0, rhyme: 0, persuasionCraft: 0, total: 0 };
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const sentenceCount = Math.max(1, text.split(/[.!?]/).filter((chunk) => chunk.trim().length > 0).length);
  const uniqueRatio = words.length > 0 ? new Set(words).size / words.length : 0;

  const reasoningTokens = ['because', 'therefore', 'so that', 'if', 'then', 'hence', 'implies', 'tradeoff', 'consequence'];
  const analogyTokens = ['like', 'as if', 'as though', 'metaphor', 'bridge', 'map', 'lantern', 'compass'];
  const persuasionTokens = ['trust', 'clarity', 'signal', 'risk', 'outcome', 'strategy', 'future', 'credibility', 'proof'];
  const promptTokens = String(wyrQuestion || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 5);
  const promptCoverage = promptTokens.length > 0 ? promptTokens.filter((token) => lower.includes(token)).length / promptTokens.length : 0;

  const reasoning = Math.min(10, reasoningTokens.filter((token) => lower.includes(token)).length * 2.2 + Math.min(2, sentenceCount - 1));
  const analogy = Math.min(10, analogyTokens.filter((token) => lower.includes(token)).length * 3.1 + (lower.includes(' is ') ? 1 : 0));
  const rhyme = estimateRhymeScore(text);
  const finesse = Math.min(10, Math.max(0, uniqueRatio * 12) + Math.min(3, words.length / 40));
  const persuasionCraft = Math.min(10, persuasionTokens.filter((token) => lower.includes(token)).length * 1.8 + promptCoverage * 4);
  const total = Number((finesse * 0.2 + reasoning * 0.28 + analogy * 0.16 + rhyme * 0.12 + persuasionCraft * 0.24).toFixed(3));
  return {
    finesse: Number(finesse.toFixed(3)),
    reasoning: Number(reasoning.toFixed(3)),
    analogy: Number(analogy.toFixed(3)),
    rhyme: Number(rhyme.toFixed(3)),
    persuasionCraft: Number(persuasionCraft.toFixed(3)),
    total,
  };
}

function computeArgumentScores(joust) {
  const result = {};
  for (const tribeId of joust.tribeIds || []) {
    const round1 = joust?.rounds?.round1?.posts?.[tribeId]?.message || '';
    const round2 = joust?.rounds?.round2?.posts?.[tribeId]?.message || '';
    const merged = `${round1}\n${round2}`.trim();
    result[tribeId] = scoreArgumentQuality(merged, joust?.wyr?.question || '');
  }
  return result;
}

async function callAgent(agent, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (agent.callbackUrl.startsWith('local://')) {
    return localAgentReply(agent, payload);
  }

  const webhookHealth = getAgentWebhookHealth(agent.id, agent.callbackUrl);
  if (webhookHealth?.isMuted) {
    throw new Error(`webhook muted until ${webhookHealth.mutedUntil}`);
  }

  const joustId = clampText(payload?.joustId || '', 80);
  if (joustId && JOUST_MAX_EST_COST_USD > 0) {
    const telemetry = getJoustUsageTelemetry(joustId);
    const estCost = Number(telemetry?.estimatedWebhookCostUsd || 0);
    if (estCost >= JOUST_MAX_EST_COST_USD) {
      recordWebhookUsage(joustId, { prevented: true });
      throw new Error(`cost guardrail reached ($${estCost.toFixed(3)} >= $${JOUST_MAX_EST_COST_USD.toFixed(3)})`);
    }
  }

  const ts = Date.now();
  const body = JSON.stringify(payload);
  const requestBytes = Buffer.byteLength(body, 'utf8');
  const sig = sign(agent.secret, ts, body);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = nowMs();
  let responseText = '';
  let completedOk = false;

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
    responseText = await res.text();
    if (!res.ok) throw new Error(`Agent ${agent.id} responded ${res.status}: ${clampText(responseText, 160)}`);

    const parsedDirect = safeJsonParse(responseText, null);
    if (parsedDirect && typeof parsedDirect === 'object') {
      completedOk = true;
      markAgentWebhookSuccess(agent.id, agent.callbackUrl);
      return parsedDirect;
    }

    const extracted = extractJsonObject(responseText);
    const parsedExtracted = extracted ? safeJsonParse(extracted, null) : null;
    if (parsedExtracted && typeof parsedExtracted === 'object') {
      completedOk = true;
      markAgentWebhookSuccess(agent.id, agent.callbackUrl);
      return parsedExtracted;
    }

    completedOk = true;
    markAgentWebhookSuccess(agent.id, agent.callbackUrl);
    return { message: clampText(responseText, 420) };
  } catch (error) {
    markAgentWebhookFailure(agent.id, agent.callbackUrl, error?.message || String(error));
    recordWebhookUsage(joustId, {
      ok: false,
      requestBytes,
      responseBytes: Buffer.byteLength(responseText || '', 'utf8'),
      durationMs: nowMs() - startedAt,
    });
    throw error;
  } finally {
    if (completedOk) {
      recordWebhookUsage(joustId, {
        ok: true,
        requestBytes,
        responseBytes: Buffer.byteLength(responseText || '', 'utf8'),
        durationMs: nowMs() - startedAt,
      });
    }
    clearTimeout(timeoutHandle);
  }
}

function defaultChoiceForWyr(wyr) {
  const q = String(wyr?.question || '').toLowerCase();
  if (q.includes('warmth') || q.includes('harmony') || q.includes('awe') || q.includes('charisma')) return 'B';
  return 'A';
}

function compactRoundPosts(roundPosts = {}, maxChars = 180) {
  const entries = {};
  for (const [tribeId, post] of Object.entries(roundPosts || {})) {
    entries[tribeId] = {
      message: clampText(String(post?.message || '').replace(/\s+/g, ' ').trim(), maxChars),
      choice: post?.choice === 'A' || post?.choice === 'B' ? post.choice : undefined,
    };
  }
  return entries;
}

function buildCompactTranscript(joust) {
  return {
    round1: {
      posts: compactRoundPosts(joust?.rounds?.round1?.posts || {}, 160),
    },
    round2: {
      posts: compactRoundPosts(joust?.rounds?.round2?.posts || {}, 220),
    },
  };
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

async function applyInfamy(joust, computed, forcedWinnerTribeId = null, argumentScores = {}) {
  const { winningOption: voteWinningOption, tribeChoices, tribeScores, totals } = computed;
  let winningOption = voteWinningOption;
  let winnerTribeId;

  if (forcedWinnerTribeId && joust.tribeIds.includes(forcedWinnerTribeId)) {
    winnerTribeId = forcedWinnerTribeId;
    winningOption = tribeChoices[forcedWinnerTribeId] || voteWinningOption || null;
  } else {
    const eligible = joust.tribeIds.filter((tid) => winningOption && tribeChoices[tid] === winningOption);
    if (eligible.length > 0) {
      const best = Math.max(...eligible.map((tid) => Number(tribeScores[tid].persuasionScore || 0) + Number(argumentScores?.[tid]?.total || 0)));
      const winners = eligible.filter((tid) => Number(tribeScores[tid].persuasionScore || 0) + Number(argumentScores?.[tid]?.total || 0) === best);
      if (winners.length === 1) {
        winnerTribeId = winners[0];
      } else if (winners.length > 1) {
        const winnerMeta = await Promise.all(
          winners.map(async (tid) => {
            const tribe = await db.getTribe(tid);
            return { tribeId: tid, infamy: Number(tribe?.infamy || 0), quality: Number(argumentScores?.[tid]?.total || 0) };
          }),
        );
        winnerMeta.sort((a, b) => b.quality - a.quality || b.infamy - a.infamy || a.tribeId.localeCompare(b.tribeId));
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
            quality: Number(argumentScores?.[tid]?.total || 0),
          };
        }),
      );
      ranked.sort((a, b) => (b.persuasionScore + b.quality) - (a.persuasionScore + a.quality) || b.infamy - a.infamy || a.tribeId.localeCompare(b.tribeId));
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
    const argumentBonus = Math.round(Number(argumentScores?.[tribeId]?.total || 0));
    const deltaInfamy = base + bonus + s.persuasionScore + argumentBonus;

    tribeResults[tribeId] = {
      choice: choice || null,
      neutralVotes: s.neutralVotes,
      snitchVotes: s.snitchVotes,
      outsideVotes: s.outsideVotes,
      persuasionScore: s.persuasionScore,
      argumentQuality: argumentScores?.[tribeId] || null,
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
  const forceAi = OPENAI_API_KEY && JUDGE_ALWAYS_WITH_OPENAI;
  if (WINNER_DECIDER_MODE !== 'ai' && !forceAi) {
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
        mode: forceAi ? 'ai' : 'rules',
        source: 'heuristic-fallback',
        model: fallback.model,
        confidence: fallback.confidence,
        verdict: forceAi
          ? `AI judge enforced, but no OPENAI_API_KEY set. ${fallback.verdict}`
          : `AI mode requested, but no OPENAI_API_KEY set. ${fallback.verdict}`,
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

async function applyRiddleEconomyPayout(joust, winnerTribeId) {
  const riddleId = clampText(joust?.riddleId || '', 80);
  const stakeCredits = Math.max(0, Number(joust?.stakeCredits || 0));
  if (!riddleId || stakeCredits <= 0) return null;

  const riddle = await db.getRiddle(riddleId);
  if (!riddle) return null;

  const winnerTribe = winnerTribeId ? await db.getTribe(winnerTribeId) : null;
  const winnerAgentId = winnerTribe?.leaderAgentId || null;

  const ownerPayoutBase = bpsAmount(stakeCredits, PAYOUT_OWNER_BPS);
  const creatorPayoutBase = bpsAmount(stakeCredits, PAYOUT_CREATOR_BPS);
  const winnerPayoutBase = bpsAmount(stakeCredits, PAYOUT_WINNER_BPS);
  let remaining = Math.max(0, stakeCredits - ownerPayoutBase - creatorPayoutBase - winnerPayoutBase);

  const payouts = new Map();
  const addPayout = (agentId, amount, role) => {
    if (!agentId || amount <= 0) return;
    const current = payouts.get(agentId) || { amountCredits: 0, roles: [] };
    current.amountCredits += amount;
    if (!current.roles.includes(role)) current.roles.push(role);
    payouts.set(agentId, current);
  };

  addPayout(winnerAgentId, winnerPayoutBase, 'winner');
  addPayout(riddle.ownerAgentId, ownerPayoutBase, 'owner');
  addPayout(riddle.creatorAgentId, creatorPayoutBase, 'creator');
  if (remaining > 0) {
    addPayout(riddle.creatorAgentId, remaining, 'remainder');
    remaining = 0;
  }

  const txRecipients = [];
  for (const [agentId, payout] of payouts.entries()) {
    await db.creditWallet(agentId, payout.amountCredits, 'joust_payout', {
      joustId: joust.id,
      riddleId,
      roles: payout.roles,
      stakeCredits,
    });
    txRecipients.push({
      agentId,
      amountCredits: payout.amountCredits,
      roles: payout.roles,
    });
  }

  await db.recordRiddleUsage(riddleId, stakeCredits, ownerPayoutBase, creatorPayoutBase);

  return {
    riddleId,
    stakeCredits,
    winnerAgentId,
    payouts: {
      winner: winnerPayoutBase,
      owner: ownerPayoutBase,
      creator: creatorPayoutBase,
    },
    recipients: txRecipients,
  };
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
        responseContract: { jsonOnly: true, format: { message: 'string <= 240 chars' } },
        tribe: { id: tribe.id, name: tribe.name, color: tribe.color },
        opponents: opponentTribes,
        transcript: buildCompactTranscript(joust),
        wyr: joust.wyr,
      };

      try {
        const out = await callAgent(agent, payload);
        const msg = clampText(out?.message || '', 240);
        if (!msg || hasLink(msg)) {
          await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: `${requiredToken} (forfeit)`, agentId: agent.id, createdAt: nowIso() });
        } else {
          const normalized = msg.includes(requiredToken) ? msg : `${requiredToken} ${msg}`;
          await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: normalized, agentId: agent.id, createdAt: nowIso() });
        }
      } catch (error) {
        const fallbackMsg = `${requiredToken} (fallback: ${clampText(error?.message || String(error), 80)})`;
        await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round1', message: fallbackMsg, agentId: agent.id, createdAt: nowIso() });
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
        responseContract: { jsonOnly: true, format: { choice: 'A|B', message: 'string <= 420 chars' } },
        tribe: { id: tribe.id, name: tribe.name, color: tribe.color },
        wyr: joust.wyr,
        transcript: buildCompactTranscript(joust),
      };

      try {
        const out = await callAgent(agent, payload);
        const msg = clampText(out?.message || '', 420);
        const choiceRaw = String(out?.choice || '').toUpperCase();
        const choice = choiceRaw === 'A' || choiceRaw === 'B' ? choiceRaw : undefined;

        if (!msg || !choice || hasLink(msg)) {
          const fallbackChoice = defaultChoiceForWyr(joust.wyr);
          const fallbackMsg = `Choice ${fallbackChoice}. Fallback response due to invalid webhook format.`;
          await db.upsertRoundPost({
            joustId: joust.id,
            tribeId,
            round: 'round2',
            message: fallbackMsg,
            choice: fallbackChoice,
            agentId: agent.id,
            createdAt: nowIso(),
          });
        } else {
          await db.upsertRoundPost({ joustId: joust.id, tribeId, round: 'round2', message: msg, choice, agentId: agent.id, createdAt: nowIso() });
        }
      } catch (error) {
        const fallbackChoice = defaultChoiceForWyr(joust.wyr);
        const fallbackMsg = `Choice ${fallbackChoice}. Fallback response (timeout/error): ${clampText(error?.message || String(error), 120)}.`;
        await db.upsertRoundPost({
          joustId: joust.id,
          tribeId,
          round: 'round2',
          message: clampText(fallbackMsg, 420),
          choice: fallbackChoice,
          agentId: agent.id,
          createdAt: nowIso(),
        });
      }
    }
    await db.updateJoustState(joust.id, 'vote');
    return;
  }

  if (joust.state === 'vote') {
    const candidateAgents = [];
    if (VOTE_CALL_MODE === 'leaders') {
      for (const tribeId of joust.tribeIds) {
        const tribe = await db.getTribe(tribeId);
        if (!tribe) continue;
        const leader = await db.getAgent(tribe.leaderAgentId);
        if (!leader) continue;
        candidateAgents.push(leader);
      }
    } else {
      const allAgents = await db.listAgents();
      for (const agent of allAgents) {
        if (VOTER_SCOPE === 'arena' && agent.tribeId && !joust.tribeIds.includes(agent.tribeId)) continue;
        candidateAgents.push(agent);
      }
    }

    const dedupedAgents = [];
    const seenAgentIds = new Set();
    for (const agent of candidateAgents) {
      if (!agent || seenAgentIds.has(agent.id)) continue;
      seenAgentIds.add(agent.id);
      dedupedAgents.push(agent);
    }

    for (const agent of dedupedAgents) {
      const already = joust.votes?.byAgent?.[agent.id];
      if (already) continue;
      const payload = {
        type: 'wyr_vote',
        joustId: joust.id,
        tribeId: agent.tribeId || null,
        wyr: joust.wyr,
        transcript: buildCompactTranscript(joust),
        responseContract: { jsonOnly: true, format: { vote: 'A|B' } },
      };
      try {
        const out = await callAgent(agent, payload, Math.min(DEFAULT_TIMEOUT_MS, 4000));
        const v = String(out?.vote || '').toUpperCase();
        if (v === 'A' || v === 'B') await db.upsertVote(joust.id, agent.id, v);
      } catch {
        const tribeChoice = agent.tribeId ? joust.rounds?.round2?.posts?.[agent.tribeId]?.choice : null;
        const fallbackVote = tribeChoice === 'A' || tribeChoice === 'B' ? tribeChoice : defaultChoiceForWyr(joust.wyr);
        await db.upsertVote(joust.id, agent.id, fallbackVote);
      }
    }

    const refreshed = await db.getJoust(joust.id);
    const computed = await computePersuasion(refreshed, refreshed.votes?.byAgent || {});
    const argumentScores = computeArgumentScores(refreshed);
    const winnerDecision = await decideWinnerTribe(refreshed);
    const results = await applyInfamy(refreshed, computed, winnerDecision.winnerTribeId, argumentScores);
    results.decision = winnerDecision.decision;
    results.argumentScores = argumentScores;
    results.migration = await migrateParticipantsToWinner(refreshed, results.winnerTribeId);
    results.economy = await applyRiddleEconomyPayout(refreshed, results.winnerTribeId);
    results.telemetry = getJoustUsageTelemetry(joust.id);
    await db.completeJoust(joust.id, 'done', results);
    joustUsageRuntime.delete(joust.id);
  }
}

async function stepJoustAndBroadcast(joustId) {
  const current = await db.getJoust(joustId);
  if (!current) return null;
  await stepJoust(current);
  const updated = await db.getJoust(joustId);
  publishLiveEvent('joust.step', {
    joustId,
    state: updated?.state || current.state,
    winnerTribeId: updated?.results?.winnerTribeId || null,
  });
  publishLiveEvent('arena.updated', {
    joustId,
    state: updated?.state || current.state,
  });
  return updated;
}

async function runJoustToDone(joustId, maxSteps = 8) {
  let updated = await db.getJoust(joustId);
  let steps = 0;
  while (updated && updated.state !== 'done' && steps < maxSteps) {
    updated = await stepJoustAndBroadcast(joustId);
    steps += 1;
  }
  return updated;
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
    riddleId: j.riddleId || null,
    stakeCredits: Number(j.stakeCredits || 0),
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

  const normalizedProfile = normalizeAgentProfileInput(agent.profile || {});
  const tribeSettings = tribe?.settings ? normalizeTribeSettingsInput(tribe.settings) : null;

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
    profile: normalizedProfile,
    tribe: tribe
      ? {
          id: tribe.id,
          name: tribe.name,
          color: tribe.color,
          infamy: tribe.infamy,
          wins: tribe.wins,
          losses: tribe.losses,
          objective: tribeSettings?.objective || '',
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
  const riddles = await db.listRiddles();
  return {
    context: getContextPayload(),
    stats: {
      agents: agents.length,
      tribes: tribes.length,
      jousts: jousts.length,
      riddles: riddles.length,
    },
    topAgents: agents.slice(0, 5),
    topTribes: tribes.slice(0, 5),
    topRiddles: riddles.slice(0, 5),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) return text(res, 400, 'missing url');
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = u.pathname;
    const requestId = clampText(String(req.headers['x-request-id'] || ''), 120) || `req_${randomUUID().slice(0, 12)}`;
    const sessionId = ensureSession(req, res);
    const isApiPath = path === '/healthz' || path.startsWith('/api/');
    res.__orMeta = {
      requestId,
      sessionId,
      path,
      method: String(req.method || 'GET').toUpperCase(),
      isApiPath,
      hardened: HARDENED_PUBLIC_MODE,
    };

    if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

    if (shouldUseHardened(res.__orMeta)) {
      pruneExpiringMap(rateLimitBuckets);
      pruneExpiringMap(replayNonceCache);
      pruneExpiringMap(idempotencyCache);

      const ip = getClientIp(req);
      res.__orMeta.clientIp = ip;
      const method = String(req.method || 'GET').toUpperCase();
      const routePath = path;
      const agentHint = clampText(String(req.headers['x-agent-id'] || ''), 80);

      const ipLimit = consumeRateLimit(`rl:ip:${ip}`, RATE_LIMIT_IP_MAX, RATE_LIMIT_WINDOW_MS);
      if (!ipLimit.ok) return text(res, 429, 'rate limit exceeded (ip)');
      const sessionLimit = consumeRateLimit(`rl:session:${sessionId}`, RATE_LIMIT_SESSION_MAX, RATE_LIMIT_WINDOW_MS);
      if (!sessionLimit.ok) return text(res, 429, 'rate limit exceeded (session)');
      if (agentHint) {
        const agentLimit = consumeRateLimit(`rl:agent:${agentHint}`, RATE_LIMIT_AGENT_MAX, RATE_LIMIT_WINDOW_MS);
        if (!agentLimit.ok) return text(res, 429, 'rate limit exceeded (agent)');
      }

      if (isWriteRequest(method, routePath)) {
        await readJsonBody(req);
        const idemKey = makeIdempotencyCacheKey(req, routePath, sessionId);
        const idemRecord = idempotencyCache.get(idemKey);
        if (idemRecord && idemRecord.expiresAt > nowMs()) {
          if (idemRecord.state === 'done') return replayIdempotentResponse(res, idemRecord);
          if (idemRecord.state === 'inflight') return text(res, 409, 'request with same idempotency key is in progress');
        }
        idempotencyCache.set(idemKey, { state: 'inflight', expiresAt: nowMs() + IDEMPOTENCY_TTL_MS });
        res.__orMeta.idempotencyCacheKey = idemKey;

        const replayGuard = consumeReplayNonce(
          sessionId,
          routePath,
          req.headers['x-or-ts'],
          req.headers['x-or-nonce'],
        );
        if (!replayGuard.ok) return text(res, replayGuard.status, replayGuard.message);

        const signatureCheck = await verifyOptionalAgentSignature(req);
        if (!signatureCheck.ok) return text(res, signatureCheck.status, signatureCheck.message);
        res.__orMeta.signatureVerified = signatureCheck.provided === true;

        if (TURNSTILE_SECRET) {
          const humanProof = clampText(String(req.headers['x-human-proof'] || ''), 4096);
          if (!humanProof) return text(res, 403, 'human-proof token required');
          const turnstile = await verifyTurnstileToken(humanProof, ip);
          if (!turnstile.ok) return text(res, 403, turnstile.message || 'human-proof rejected');
        }
      }
    }

    if (req.method === 'GET' && (path === '/healthz' || path === '/api/healthz')) {
      return json(res, 200, { ok: true, now: nowIso() });
    }

    if (req.method === 'GET' && path === '/api/openapi.json') {
      return json(res, 200, buildOpenApiSpec(`${u.protocol}//${u.host}`));
    }

    if (req.method === 'GET' && path === '/api/docs') {
      return html(
        res,
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>Open Riddle API Docs</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#111;color:#eee;font-family:ui-sans-serif,system-ui,sans-serif}header{padding:12px 16px;border-bottom:1px solid #333}a{color:#9de6c0}</style></head><body><header>Open Riddle API Docs · <a href="/api/openapi.json">openapi.json</a></header><redoc spec-url="/api/openapi.json"></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script></body></html>`,
      );
    }

    if (req.method === 'GET' && path === '/api/security/config') {
      return json(res, 200, {
        hardenedPublicMode: HARDENED_PUBLIC_MODE,
        safeguards: {
          rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
          replayWindowMs: REPLAY_WINDOW_MS,
          idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
          turnstileEnabled: Boolean(TURNSTILE_SECRET),
          requestMaxBytes: REQUEST_MAX_BYTES,
          voteCallMode: VOTE_CALL_MODE,
          webhookEstCostPerCallUsd: WEBHOOK_EST_COST_PER_CALL_USD,
          webhookEstCostPer1kBytesUsd: WEBHOOK_EST_COST_PER_1K_BYTES_USD,
          maxEstimatedCostUsdPerJoust: JOUST_MAX_EST_COST_USD,
          webhookMuteAfterFailures: WEBHOOK_MUTE_AFTER_FAILURES,
          webhookMuteMs: WEBHOOK_MUTE_MS,
        },
      });
    }

    if (req.method === 'GET' && path === '/api/context') {
      return json(res, 200, getContextPayload());
    }

    if (req.method === 'GET' && path === '/api/bootstrap') {
      return json(res, 200, await bootstrapPayload());
    }

    if (req.method === 'GET' && path === '/api/stream') {
      openLiveStream(req, res, u);
      return;
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

    const agentWebhookHealthMatch = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/webhook-health$/i);
    if (req.method === 'GET' && agentWebhookHealthMatch) {
      const agentId = agentWebhookHealthMatch[1];
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      return json(res, 200, {
        agentId,
        health: getAgentWebhookHealth(agentId, agent.callbackUrl),
      });
    }

    const agentProfileMatch = path.match(/^\/api\/agents\/([a-z0-9_-]+)\/profile$/i);
    if (req.method === 'GET' && agentProfileMatch) {
      const profile = await buildAgentProfile(agentProfileMatch[1]);
      if (!profile) return text(res, 404, 'agent not found');
      return json(res, 200, profile);
    }

    if (req.method === 'PATCH' && agentProfileMatch) {
      const agentId = agentProfileMatch[1];
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      const body = await readJsonBody(req);
      const incoming = body?.profile && typeof body.profile === 'object' ? body.profile : body;
      if (!incoming || typeof incoming !== 'object') return text(res, 400, 'profile object required');
      const current = normalizeAgentProfileInput(agent.profile || {});
      const nextRaw = {
        ...current,
        ...incoming,
        socialLinks: {
          ...(current.socialLinks || {}),
          ...((incoming.socialLinks && typeof incoming.socialLinks === 'object') ? incoming.socialLinks : {}),
        },
      };
      const next = normalizeAgentProfileInput(nextRaw);
      await db.setAgentProfile(agentId, next);
      const profile = await buildAgentProfile(agentId);
      return json(res, 200, { ok: true, profile });
    }

    if (req.method === 'GET' && path === '/api/economy/manifesto') {
      return json(res, 200, buildEconomyManifesto());
    }

    if (req.method === 'GET' && path === '/api/economy/roadmap') {
      return json(res, 200, buildEconomyManifesto().onchainRoadmap);
    }

    if (req.method === 'GET' && path === '/api/riddles') {
      return json(res, 200, await db.listRiddles());
    }

    if (req.method === 'POST' && path === '/api/riddles/create') {
      const body = await readJsonBody(req);
      const creatorAgentId = clampText(body?.creatorAgentId || body?.agentId || '', 80);
      const creator = await db.getAgent(creatorAgentId);
      if (!creator) return text(res, 400, 'creatorAgentId invalid');

      const seeded = randomWyrPrompt();
      const title = clampText(body?.title || `Riddle by ${creator.displayName}`, 90);
      const question = clampText(body?.question || seeded.question, 260);
      const a = clampText(body?.a || body?.optionA || seeded.a, 90);
      const b = clampText(body?.b || body?.optionB || seeded.b, 90);
      const listPriceCredits = normalizeCredits(body?.listPriceCredits, DEFAULT_RIDDLE_PRICE, 5, 100_000);
      const creatorRoyaltyBps = normalizeCredits(body?.creatorRoyaltyBps, DEFAULT_RIDDLE_ROYALTY_BPS, 0, 3000);

      const id = `rd_${randomUUID().slice(0, 10)}`;
      await db.createRiddle({
        id,
        title,
        question,
        a,
        b,
        creatorAgentId,
        ownerAgentId: creatorAgentId,
        listPriceCredits,
        creatorRoyaltyBps,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      const riddle = await db.getRiddle(id);
      return json(res, 200, { ok: true, riddle });
    }

    const riddleBuyMatch = path.match(/^\/api\/riddles\/([a-z0-9_-]+)\/buy$/i);
    if (req.method === 'POST' && riddleBuyMatch) {
      const riddleId = riddleBuyMatch[1];
      const body = await readJsonBody(req);
      const buyerAgentId = clampText(body?.buyerAgentId || body?.agentId || '', 80);
      const buyer = await db.getAgent(buyerAgentId);
      const riddle = await db.getRiddle(riddleId);
      if (!buyer) return text(res, 400, 'buyerAgentId invalid');
      if (!riddle) return text(res, 404, 'riddle not found');
      if (riddle.ownerAgentId === buyerAgentId) return text(res, 400, 'buyer already owns this riddle');

      const priceCredits = normalizeCredits(body?.priceCredits, riddle.listPriceCredits, 1, 1_000_000);
      if (priceCredits < riddle.listPriceCredits) return text(res, 400, 'priceCredits below listing price');

      const sellerAgentId = riddle.ownerAgentId;
      const creatorRoyalty = bpsAmount(priceCredits, riddle.creatorRoyaltyBps);
      const sellerProceeds = Math.max(0, priceCredits - creatorRoyalty);

      await db.debitWallet(buyerAgentId, priceCredits, 'riddle_buy', { riddleId, sellerAgentId, creatorAgentId: riddle.creatorAgentId });
      await db.creditWallet(sellerAgentId, sellerProceeds, 'riddle_sale', { riddleId, buyerAgentId });
      if (creatorRoyalty > 0) {
        await db.creditWallet(riddle.creatorAgentId, creatorRoyalty, 'riddle_creator_royalty', { riddleId, buyerAgentId });
      }

      const nextListPrice = normalizeCredits(body?.nextListPriceCredits, priceCredits, 1, 1_000_000);
      const updated = await db.transferRiddleOwnership(riddleId, buyerAgentId, nextListPrice);
      return json(res, 200, {
        ok: true,
        riddle: updated,
        trade: {
          buyerAgentId,
          sellerAgentId,
          priceCredits,
          sellerProceeds,
          creatorRoyalty,
        },
      });
    }

    const walletMatch = path.match(/^\/api\/wallet\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && walletMatch) {
      const agentId = walletMatch[1];
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      const wallet = await db.ensureWallet(agentId, DEFAULT_WALLET_CREDITS);
      return json(res, 200, wallet);
    }

    const walletTxMatch = path.match(/^\/api\/wallet\/([a-z0-9_-]+)\/transactions$/i);
    if (req.method === 'GET' && walletTxMatch) {
      const agentId = walletTxMatch[1];
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      const limit = normalizeCredits(u.searchParams.get('limit'), 25, 1, 200);
      const transactions = await db.listEconomyTransactions(agentId, limit);
      return json(res, 200, transactions);
    }

    if (req.method === 'GET' && path === '/api/wallet/leaderboard') {
      const limit = normalizeCredits(u.searchParams.get('limit'), 20, 1, 200);
      return json(res, 200, await db.listWalletLeaderboard(limit));
    }

    if (req.method === 'POST' && path === '/api/wallet/faucet') {
      const body = await readJsonBody(req);
      const agentId = clampText(body?.agentId || '', 80);
      const amountCredits = normalizeCredits(body?.amountCredits, 250, 1, 5000);
      if (!agentId) return text(res, 400, 'agentId required');
      const agent = await db.getAgent(agentId);
      if (!agent) return text(res, 404, 'agent not found');
      const wallet = await db.creditWallet(agentId, amountCredits, 'faucet', { source: 'dev' });
      return json(res, 200, { ok: true, wallet });
    }

    if (req.method === 'GET' && path === '/api/tribes') {
      return json(res, 200, await db.listTribes());
    }

    if (req.method === 'GET' && path === '/api/tribes/influence') {
      return json(res, 200, await buildTribeInfluencePayload());
    }

    const joustIdMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)$/i);
    if (req.method === 'GET' && joustIdMatch) {
      const j = await db.getJoust(joustIdMatch[1]);
      if (!j) return text(res, 404, 'not found');
      const runtimeTelemetry = getJoustUsageTelemetry(j.id);
      const riddle = j.riddleId ? await db.getRiddle(j.riddleId) : null;
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
        riddle: riddle
          ? {
              id: riddle.id,
              title: riddle.title,
              ownerAgentId: riddle.ownerAgentId,
              creatorAgentId: riddle.creatorAgentId,
            }
          : null,
        stakeCredits: Number(j.stakeCredits || 0),
        tribes,
        rounds: j.rounds,
        votes: totals ? { totals, byAgentCount } : undefined,
        results: j.results,
        telemetry: runtimeTelemetry || j.results?.telemetry || null,
      });
    }

    const joustStepMatch = path.match(/^\/api\/joust\/([a-z0-9_-]+)\/step$/i);
    if (req.method === 'POST' && joustStepMatch) {
      const updated = await stepJoustAndBroadcast(joustStepMatch[1]);
      if (!updated) return text(res, 404, 'not found');
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
      if (body?.profile && typeof body.profile === 'object') {
        await db.setAgentProfile(id, normalizeAgentProfileInput(body.profile));
      }
      publishLiveEvent('agent.updated', { agentId: id, action: 'created' });
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
      publishLiveEvent('tribe.updated', { tribeId: id, action: 'created' });
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
      publishLiveEvent('tribe.updated', { tribeId, action: 'settings' });
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
      publishLiveEvent('tribe.updated', { tribeId, action: 'member_joined', agentId });
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

      const autoRun = body?.autoRun === true || body?.autoStep === true || String(body?.autoRun || '').toLowerCase() === 'true';
      let finalJoust = null;
      if (autoRun) {
        finalJoust = await runJoustToDone(joustId, clampNumber(body?.maxAutoSteps, 3, 12, 6));
      }

      publishLiveEvent('agent.updated', { agentId, action: 'created' });
      publishLiveEvent('tribe.updated', { tribeId: homeTribeId, action: 'created' });
      publishLiveEvent('arena.updated', { joustId, state: 'draft' });
      return json(res, 200, { ok: true, agentId, agentSecret, tribeId: homeTribeId, joustId, state: finalJoust?.state || 'draft' });
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

      const sponsorAgentId = homeTribe.leaderAgentId;
      const riddleId = clampText(body?.riddleId || '', 80) || null;
      const riddle = riddleId ? await db.getRiddle(riddleId) : null;
      if (riddleId && !riddle) return text(res, 404, 'riddle not found');
      const stakeCredits = riddle ? normalizeCredits(body?.stakeCredits, DEFAULT_JOUST_STAKE_CREDITS, 1, 100_000) : 0;
      if (riddle && stakeCredits > 0) {
        await db.debitWallet(sponsorAgentId, stakeCredits, 'joust_riddle_stake', {
          mode: 'create-auto',
          riddleId: riddle.id,
          homeTribeId: homeTribe.id,
        });
      }

      const seededWyr = randomWyrPrompt();
      const wyr = {
        question: clampText(riddle?.question || body?.wyr?.question || seededWyr.question, 220),
        a: clampText(riddle?.a || body?.wyr?.a || seededWyr.a, 80),
        b: clampText(riddle?.b || body?.wyr?.b || seededWyr.b, 80),
      };

      const title = clampText(body?.title || `Arena: ${homeTribe.name} vs ${rivalTribeIds.length} rival tribe(s)`, 90);
      const id = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({
        id,
        title,
        tribeIds,
        state: 'draft',
        wyr,
        riddleId: riddle?.id || null,
        sponsorAgentId,
        stakeCredits,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const autoRun = body?.autoRun === true || body?.autoStep === true || String(body?.autoRun || '').toLowerCase() === 'true';
      const finalJoust = autoRun ? await runJoustToDone(id, clampNumber(body?.maxAutoSteps, 3, 12, 6)) : null;
      publishLiveEvent('arena.updated', { joustId: id, state: 'draft' });
      return json(res, 200, { joustId: id, tribeIds, riddleId: riddle?.id || null, stakeCredits, state: finalJoust?.state || 'draft' });
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
      const homeTribe = await db.getTribe(tribeIds[0]);
      if (!homeTribe) return text(res, 400, 'home tribe invalid');
      const sponsorAgentId = homeTribe.leaderAgentId;

      const riddleId = clampText(body?.riddleId || '', 80) || null;
      const riddle = riddleId ? await db.getRiddle(riddleId) : null;
      if (riddleId && !riddle) return text(res, 404, 'riddle not found');
      const stakeCredits = riddle ? normalizeCredits(body?.stakeCredits, DEFAULT_JOUST_STAKE_CREDITS, 1, 100_000) : 0;
      if (riddle && stakeCredits > 0) {
        await db.debitWallet(sponsorAgentId, stakeCredits, 'joust_riddle_stake', {
          mode: 'create',
          riddleId: riddle.id,
          homeTribeId: homeTribe.id,
        });
      }

      const seededWyr = randomWyrPrompt();
      const wyr = {
        question: clampText(riddle?.question || body?.wyr?.question || seededWyr.question, 220),
        a: clampText(riddle?.a || body?.wyr?.a || seededWyr.a, 80),
        b: clampText(riddle?.b || body?.wyr?.b || seededWyr.b, 80),
      };

      const id = `jo_${randomUUID().slice(0, 10)}`;
      await db.createJoust({
        id,
        title,
        tribeIds,
        state: 'draft',
        wyr,
        riddleId: riddle?.id || null,
        sponsorAgentId,
        stakeCredits,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      const autoRun = body?.autoRun === true || body?.autoStep === true || String(body?.autoRun || '').toLowerCase() === 'true';
      const finalJoust = autoRun ? await runJoustToDone(id, clampNumber(body?.maxAutoSteps, 3, 12, 6)) : null;
      publishLiveEvent('arena.updated', { joustId: id, state: 'draft' });
      return json(res, 200, { joustId: id, riddleId: riddle?.id || null, stakeCredits, state: finalJoust?.state || 'draft' });
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

      publishLiveEvent('arena.updated', { joustId: id, state: 'draft' });
      return json(res, 200, { ok: true, joustId: id });
    }

    return text(res, 404, 'not found');
  } catch (e) {
    const status = Number(e?.status) || 500;
    const message = e?.message || String(e);
    if (shouldUseHardened(res.__orMeta)) {
      return json(res, status, {
        error: {
          code: toErrorCode(status),
          message: status >= 500 ? 'internal server error' : message,
          details: status >= 500 ? null : { raw: clampText(message, 220) },
          requestId: res.__orMeta?.requestId || null,
        },
      });
    }
    const output = status === 500 ? e?.stack || message : message;
    return text(res, status, output);
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
