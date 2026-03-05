import { Pool } from 'pg';

function nowIso() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return nowIso();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? nowIso() : date.toISOString();
}

function safeJsonParse(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function hydrateAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    callbackUrl: row.callback_url,
    secret: row.secret,
    vibeTags: safeJsonParse(row.vibe_tags, []) || [],
    createdAt: toIso(row.created_at),
    infamy: Number(row.infamy || 0),
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    verifiedProvider: row.verified_provider || null,
    verifiedSubject: row.verified_subject || null,
    verifiedProfile: safeJsonParse(row.verified_profile_json, null),
    profile: safeJsonParse(row.agent_profile_json, null),
  };
}

function hydrateTribe(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    leaderAgentId: row.leader_agent_id,
    createdAt: toIso(row.created_at),
    infamy: Number(row.infamy || 0),
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
  };
}

function hydrateRiddle(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    a: row.option_a,
    b: row.option_b,
    creatorAgentId: row.creator_agent_id,
    ownerAgentId: row.owner_agent_id,
    listPriceCredits: Number(row.list_price_credits || 0),
    creatorRoyaltyBps: Number(row.creator_royalty_bps || 0),
    totalUses: Number(row.total_uses || 0),
    totalVolumeCredits: Number(row.total_volume_credits || 0),
    ownerEarningsCredits: Number(row.owner_earnings_credits || 0),
    creatorEarningsCredits: Number(row.creator_earnings_credits || 0),
    isActive: Boolean(row.is_active),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeTribeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const preferredStyles = Array.isArray(input.preferredStyles) ? input.preferredStyles.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 10) : [];
  const requiredTags = Array.isArray(input.requiredTags) ? input.requiredTags.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12) : [];
  const objective = String(input.objective || '').trim().slice(0, 220);
  const minInfamyRaw = Number(input.minInfamy);
  const minInfamy = Number.isFinite(minInfamyRaw) ? Math.max(0, Math.min(5000, Math.round(minInfamyRaw))) : 0;
  return {
    objective,
    openJoin: input.openJoin !== false,
    minInfamy,
    preferredStyles,
    requiredTags,
  };
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      vibe_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TEXT NOT NULL,
      infamy INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      verified_provider TEXT,
      verified_subject TEXT,
      verified_profile_json JSONB,
      agent_profile_json JSONB
    );

    CREATE TABLE IF NOT EXISTS tribes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      leader_agent_id TEXT NOT NULL REFERENCES agents(id),
      created_at TEXT NOT NULL,
      infamy INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tribe_members (
      tribe_id TEXT NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (tribe_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS tribe_profiles (
      tribe_id TEXT PRIMARY KEY REFERENCES tribes(id) ON DELETE CASCADE,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jousts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      wyr_question TEXT NOT NULL,
      wyr_a TEXT NOT NULL,
      wyr_b TEXT NOT NULL,
      riddle_id TEXT,
      sponsor_agent_id TEXT,
      stake_credits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      results_json JSONB
    );

    CREATE TABLE IF NOT EXISTS joust_tribes (
      joust_id TEXT NOT NULL REFERENCES jousts(id) ON DELETE CASCADE,
      tribe_id TEXT NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
      PRIMARY KEY (joust_id, tribe_id)
    );

    CREATE TABLE IF NOT EXISTS round_posts (
      joust_id TEXT NOT NULL REFERENCES jousts(id) ON DELETE CASCADE,
      tribe_id TEXT NOT NULL REFERENCES tribes(id) ON DELETE CASCADE,
      round TEXT NOT NULL,
      message TEXT NOT NULL,
      choice TEXT,
      agent_id TEXT REFERENCES agents(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (joust_id, tribe_id, round)
    );

    CREATE TABLE IF NOT EXISTS votes (
      joust_id TEXT NOT NULL REFERENCES jousts(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      vote TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (joust_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tribe_members_agent_id ON tribe_members(agent_id);
    CREATE INDEX IF NOT EXISTS idx_jousts_updated_at ON jousts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_round_posts_joust_id ON round_posts(joust_id);
    CREATE INDEX IF NOT EXISTS idx_votes_joust_id ON votes(joust_id);

    CREATE TABLE IF NOT EXISTS wallets (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      balance_credits INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS riddles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      creator_agent_id TEXT NOT NULL REFERENCES agents(id),
      owner_agent_id TEXT NOT NULL REFERENCES agents(id),
      list_price_credits INTEGER NOT NULL,
      creator_royalty_bps INTEGER NOT NULL,
      total_uses INTEGER NOT NULL DEFAULT 0,
      total_volume_credits INTEGER NOT NULL DEFAULT 0,
      owner_earnings_credits INTEGER NOT NULL DEFAULT 0,
      creator_earnings_credits INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS economy_transactions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tx_type TEXT NOT NULL,
      amount_credits INTEGER NOT NULL,
      meta_json JSONB,
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_profile_json JSONB`);
  await pool.query(`ALTER TABLE jousts ADD COLUMN IF NOT EXISTS riddle_id TEXT`);
  await pool.query(`ALTER TABLE jousts ADD COLUMN IF NOT EXISTS sponsor_agent_id TEXT`);
  await pool.query(`ALTER TABLE jousts ADD COLUMN IF NOT EXISTS stake_credits INTEGER NOT NULL DEFAULT 0`);
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function openJoustPostgresStore({ connectionString }) {
  if (!connectionString) {
    throw new Error('Missing Postgres connection string');
  }

  const pool = new Pool({
    connectionString,
    max: Number(process.env.JOUST_PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.JOUST_PG_IDLE_MS || 30_000),
  });

  await ensureSchema(pool);

  async function getAgentTribeId(agentId) {
    const { rows } = await pool.query(`SELECT tribe_id FROM tribe_members WHERE agent_id = $1 LIMIT 1`, [agentId]);
    return rows[0]?.tribe_id || null;
  }

  async function listAgents() {
    const { rows } = await pool.query(`
      SELECT a.*, tm.tribe_id
      FROM agents a
      LEFT JOIN LATERAL (
        SELECT tribe_id FROM tribe_members WHERE agent_id = a.id LIMIT 1
      ) tm ON true
      ORDER BY a.infamy DESC, a.created_at DESC
    `);
    return rows.map((row) => {
      const agent = hydrateAgent(row);
      return { ...agent, tribeId: row.tribe_id || null };
    });
  }

  async function listTribes() {
    const tribeRows = (await pool.query(`SELECT * FROM tribes ORDER BY infamy DESC, created_at DESC`)).rows;
    if (tribeRows.length === 0) return [];

    const profileRows = (await pool.query(`SELECT tribe_id, settings_json FROM tribe_profiles`)).rows;
    const profileByTribe = new Map();
    for (const row of profileRows) {
      profileByTribe.set(row.tribe_id, normalizeTribeSettings(safeJsonParse(row.settings_json, {})));
    }

    const memberRows = (
      await pool.query(`
        SELECT tm.tribe_id, a.id, a.display_name, a.infamy, a.created_at
        FROM tribe_members tm
        JOIN agents a ON a.id = tm.agent_id
        ORDER BY tm.tribe_id ASC, a.infamy DESC, a.created_at ASC
      `)
    ).rows;

    const membersByTribe = new Map();
    for (const row of memberRows) {
      const list = membersByTribe.get(row.tribe_id) || [];
      list.push({ id: row.id, displayName: row.display_name, infamy: Number(row.infamy || 0) });
      membersByTribe.set(row.tribe_id, list);
    }

    return tribeRows.map((row) => {
      const tribe = hydrateTribe(row);
      const members = membersByTribe.get(tribe.id) || [];
      return {
        ...tribe,
        settings: profileByTribe.get(tribe.id) || normalizeTribeSettings({}),
        memberCount: members.length,
        members,
      };
    });
  }

  async function listTribeMembers(tribeId) {
    const { rows } = await pool.query(
      `
      SELECT a.id, a.display_name, a.infamy
      FROM tribe_members tm
      JOIN agents a ON a.id = tm.agent_id
      WHERE tm.tribe_id = $1
      ORDER BY a.infamy DESC, a.created_at ASC
    `,
      [tribeId],
    );
    return rows.map((row) => ({ id: row.id, displayName: row.display_name, infamy: Number(row.infamy || 0) }));
  }

  async function createAgent(agent) {
    const createdAt = agent.createdAt || nowIso();
    await pool.query(
      `
      INSERT INTO agents (
        id, display_name, callback_url, secret, vibe_tags, created_at, infamy, wins, losses
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
    `,
      [
        agent.id,
        agent.displayName,
        agent.callbackUrl,
        agent.secret,
        JSON.stringify(agent.vibeTags || []),
        createdAt,
        Number(agent.infamy ?? 100),
        Number(agent.wins ?? 0),
        Number(agent.losses ?? 0),
      ],
    );
    await pool.query(
      `
      INSERT INTO wallets (agent_id, balance_credits, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (agent_id)
      DO NOTHING
    `,
      [agent.id, Number(agent.startingCredits ?? 1000), createdAt],
    );
  }

  async function createTribe(tribe) {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
        INSERT INTO tribes (id, name, color, leader_agent_id, created_at, infamy, wins, losses)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
        [
          tribe.id,
          tribe.name,
          tribe.color,
          tribe.leaderAgentId,
          tribe.createdAt || nowIso(),
          Number(tribe.infamy ?? 0),
          Number(tribe.wins ?? 0),
          Number(tribe.losses ?? 0),
        ],
      );
      await client.query(
        `
        INSERT INTO tribe_members (tribe_id, agent_id, role, joined_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (tribe_id, agent_id) DO NOTHING
      `,
        [tribe.id, tribe.leaderAgentId, 'leader', nowIso()],
      );
    });
  }

  async function addTribeMember(tribeId, agentId, role = 'member') {
    await pool.query(
      `
      INSERT INTO tribe_members (tribe_id, agent_id, role, joined_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tribe_id, agent_id) DO NOTHING
    `,
      [tribeId, agentId, role, nowIso()],
    );
  }

  async function transferAgentToTribe(agentId, targetTribeId, role = 'member') {
    await withTransaction(pool, async (client) => {
      await client.query(`DELETE FROM tribe_members WHERE agent_id = $1`, [agentId]);
      await client.query(
        `
        INSERT INTO tribe_members (tribe_id, agent_id, role, joined_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (tribe_id, agent_id) DO NOTHING
      `,
        [targetTribeId, agentId, role, nowIso()],
      );
    });
  }

  async function createJoust(joust) {
    await withTransaction(pool, async (client) => {
      await client.query(
        `
        INSERT INTO jousts (
          id, title, state, wyr_question, wyr_a, wyr_b, riddle_id, sponsor_agent_id, stake_credits, created_at, updated_at, results_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      `,
        [
          joust.id,
          joust.title,
          joust.state,
          joust.wyr.question,
          joust.wyr.a,
          joust.wyr.b,
          joust.riddleId || null,
          joust.sponsorAgentId || null,
          Number(joust.stakeCredits || 0),
          joust.createdAt || nowIso(),
          joust.updatedAt || nowIso(),
          joust.resultsJson ? JSON.stringify(joust.resultsJson) : null,
        ],
      );
      for (const tribeId of joust.tribeIds || []) {
        await client.query(
          `
          INSERT INTO joust_tribes (joust_id, tribe_id)
          VALUES ($1, $2)
          ON CONFLICT (joust_id, tribe_id) DO NOTHING
        `,
          [joust.id, tribeId],
        );
      }
    });
  }

  async function getJoust(id) {
    const row = (await pool.query(`SELECT * FROM jousts WHERE id = $1`, [id])).rows[0];
    if (!row) return null;

    const tribeIds = (await pool.query(`SELECT tribe_id FROM joust_tribes WHERE joust_id = $1`, [id])).rows.map((r) => r.tribe_id);
    const posts = (await pool.query(`SELECT * FROM round_posts WHERE joust_id = $1`, [id])).rows;
    const votes = (await pool.query(`SELECT agent_id, vote FROM votes WHERE joust_id = $1`, [id])).rows;

    const rounds = { round1: { posts: {} }, round2: { posts: {} } };
    for (const post of posts) {
      if (post.round === 'round1') {
        rounds.round1.posts[post.tribe_id] = {
          message: post.message,
          agentId: post.agent_id || undefined,
          createdAt: toIso(post.created_at),
        };
      } else if (post.round === 'round2') {
        rounds.round2.posts[post.tribe_id] = {
          message: post.message,
          choice: post.choice || undefined,
          agentId: post.agent_id || undefined,
          createdAt: toIso(post.created_at),
        };
      }
    }

    const byAgent = {};
    for (const vote of votes) byAgent[vote.agent_id] = vote.vote;

    return {
      id: row.id,
      title: row.title,
      state: row.state,
      tribeIds,
      wyr: {
        question: row.wyr_question,
        a: row.wyr_a,
        b: row.wyr_b,
      },
      riddleId: row.riddle_id || null,
      sponsorAgentId: row.sponsor_agent_id || null,
      stakeCredits: Number(row.stake_credits || 0),
      rounds,
      votes: { byAgent },
      results: safeJsonParse(row.results_json, null),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async function listJousts() {
    const rows = (await pool.query(`SELECT * FROM jousts ORDER BY updated_at DESC`)).rows;
    if (rows.length === 0) return [];

    const joustIds = rows.map((row) => row.id);
    const tribeRows = (await pool.query(`SELECT joust_id, tribe_id FROM joust_tribes WHERE joust_id = ANY($1::text[])`, [joustIds])).rows;
    const tribesByJoust = new Map();
    for (const row of tribeRows) {
      const list = tribesByJoust.get(row.joust_id) || [];
      list.push(row.tribe_id);
      tribesByJoust.set(row.joust_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      wyr: {
        question: row.wyr_question,
        a: row.wyr_a,
        b: row.wyr_b,
      },
      riddleId: row.riddle_id || null,
      sponsorAgentId: row.sponsor_agent_id || null,
      stakeCredits: Number(row.stake_credits || 0),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      results: safeJsonParse(row.results_json, null),
      tribeIds: tribesByJoust.get(row.id) || [],
    }));
  }

  async function getTribe(tribeId) {
    const row = (await pool.query(`SELECT * FROM tribes WHERE id = $1`, [tribeId])).rows[0];
    const tribe = hydrateTribe(row);
    if (!tribe) return null;
    return {
      ...tribe,
      settings: await getTribeSettings(tribe.id),
    };
  }

  async function getTribeSettings(tribeId) {
    const row = (await pool.query(`SELECT settings_json FROM tribe_profiles WHERE tribe_id = $1`, [tribeId])).rows[0];
    return normalizeTribeSettings(safeJsonParse(row?.settings_json, {}));
  }

  async function setTribeSettings(tribeId, settings) {
    const normalized = normalizeTribeSettings(settings);
    await pool.query(
      `
      INSERT INTO tribe_profiles (tribe_id, settings_json, updated_at)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (tribe_id)
      DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at
    `,
      [tribeId, JSON.stringify(normalized), nowIso()],
    );
    return normalized;
  }

  async function getAgent(agentId) {
    const row = (await pool.query(`SELECT * FROM agents WHERE id = $1`, [agentId])).rows[0];
    return hydrateAgent(row);
  }

  async function setAgentVerification(agentId, provider, subject, profile) {
    await pool.query(
      `
      UPDATE agents
      SET verified_provider = $1, verified_subject = $2, verified_profile_json = $3::jsonb
      WHERE id = $4
    `,
      [provider, subject, profile ? JSON.stringify(profile) : null, agentId],
    );
  }

  async function setAgentProfile(agentId, profile) {
    await pool.query(
      `
      UPDATE agents
      SET agent_profile_json = $1::jsonb
      WHERE id = $2
    `,
      [profile ? JSON.stringify(profile) : null, agentId],
    );
  }

  async function getRoundPost(joustId, tribeId, round) {
    const row = (
      await pool.query(
        `
        SELECT * FROM round_posts
        WHERE joust_id = $1 AND tribe_id = $2 AND round = $3
        LIMIT 1
      `,
        [joustId, tribeId, round],
      )
    ).rows[0];
    if (!row) return null;
    return {
      joustId: row.joust_id,
      tribeId: row.tribe_id,
      round: row.round,
      message: row.message,
      choice: row.choice,
      agentId: row.agent_id,
      createdAt: toIso(row.created_at),
    };
  }

  async function upsertRoundPost(post) {
    await pool.query(
      `
      INSERT INTO round_posts (joust_id, tribe_id, round, message, choice, agent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (joust_id, tribe_id, round)
      DO UPDATE SET message = EXCLUDED.message, choice = EXCLUDED.choice, agent_id = EXCLUDED.agent_id, created_at = EXCLUDED.created_at
    `,
      [post.joustId, post.tribeId, post.round, post.message, post.choice || null, post.agentId || null, post.createdAt || nowIso()],
    );
  }

  async function upsertVote(joustId, agentId, vote) {
    await pool.query(
      `
      INSERT INTO votes (joust_id, agent_id, vote, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (joust_id, agent_id)
      DO UPDATE SET vote = EXCLUDED.vote, created_at = EXCLUDED.created_at
    `,
      [joustId, agentId, vote, nowIso()],
    );
  }

  async function updateJoustState(id, state) {
    await pool.query(`UPDATE jousts SET state = $1, updated_at = $2 WHERE id = $3`, [state, nowIso(), id]);
  }

  async function completeJoust(id, state, results) {
    await pool.query(
      `UPDATE jousts SET state = $1, results_json = $2::jsonb, updated_at = $3 WHERE id = $4`,
      [state, JSON.stringify(results || {}), nowIso(), id],
    );
  }

  async function applyTribeDelta(tribeId, delta, won) {
    await pool.query(
      `
      UPDATE tribes
      SET infamy = infamy + $1, wins = wins + $2, losses = losses + $3
      WHERE id = $4
    `,
      [Number(delta || 0), won ? 1 : 0, won ? 0 : 1, tribeId],
    );
  }

  async function applyAgentDelta(agentId, delta, won) {
    await pool.query(
      `
      UPDATE agents
      SET infamy = infamy + $1, wins = wins + $2, losses = losses + $3
      WHERE id = $4
    `,
      [Number(delta || 0), won ? 1 : 0, won ? 0 : 1, agentId],
    );
  }

  async function listTribeMemberIds(tribeId) {
    const { rows } = await pool.query(`SELECT agent_id FROM tribe_members WHERE tribe_id = $1`, [tribeId]);
    return rows.map((row) => row.agent_id);
  }

  async function getWallet(agentId) {
    const row = (await pool.query(`SELECT agent_id, balance_credits, updated_at FROM wallets WHERE agent_id = $1`, [agentId])).rows[0];
    if (!row) return null;
    return {
      agentId: row.agent_id,
      balanceCredits: Number(row.balance_credits || 0),
      updatedAt: toIso(row.updated_at),
    };
  }

  async function ensureWallet(agentId, initialCredits = 1000) {
    await pool.query(
      `
      INSERT INTO wallets (agent_id, balance_credits, updated_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (agent_id) DO NOTHING
    `,
      [agentId, Number(initialCredits || 0), nowIso()],
    );
    return getWallet(agentId);
  }

  async function creditWallet(agentId, amountCredits, txType, meta = null) {
    const delta = Number(amountCredits || 0);
    if (!Number.isFinite(delta) || delta === 0) return ensureWallet(agentId);
    await ensureWallet(agentId);
    await pool.query(`UPDATE wallets SET balance_credits = balance_credits + $1, updated_at = $2 WHERE agent_id = $3`, [delta, nowIso(), agentId]);
    await pool.query(
      `
      INSERT INTO economy_transactions (id, agent_id, tx_type, amount_credits, meta_json, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `,
      [`tx_${Math.random().toString(36).slice(2, 14)}`, agentId, txType || 'credit', delta, meta ? JSON.stringify(meta) : null, nowIso()],
    );
    return getWallet(agentId);
  }

  async function debitWallet(agentId, amountCredits, txType, meta = null) {
    const delta = Math.max(0, Number(amountCredits || 0));
    const wallet = await ensureWallet(agentId);
    if ((wallet?.balanceCredits || 0) < delta) {
      throw new Error(`insufficient wallet balance: need ${delta}, have ${wallet?.balanceCredits || 0}`);
    }
    if (delta > 0) {
      await pool.query(`UPDATE wallets SET balance_credits = balance_credits - $1, updated_at = $2 WHERE agent_id = $3`, [delta, nowIso(), agentId]);
      await pool.query(
        `
        INSERT INTO economy_transactions (id, agent_id, tx_type, amount_credits, meta_json, created_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
        [`tx_${Math.random().toString(36).slice(2, 14)}`, agentId, txType || 'debit', -delta, meta ? JSON.stringify(meta) : null, nowIso()],
      );
    }
    return getWallet(agentId);
  }

  async function listWalletLeaderboard(limit = 20) {
    const { rows } = await pool.query(
      `
      SELECT a.id, a.display_name, COALESCE(w.balance_credits, 0) AS balance_credits
      FROM agents a
      LEFT JOIN wallets w ON w.agent_id = a.id
      ORDER BY balance_credits DESC, a.infamy DESC, a.created_at DESC
      LIMIT $1
    `,
      [Math.max(1, Math.min(200, Number(limit || 20)))],
    );
    return rows.map((row) => ({
      agentId: row.id,
      displayName: row.display_name,
      balanceCredits: Number(row.balance_credits || 0),
    }));
  }

  async function listEconomyTransactions(agentId, limit = 25) {
    const { rows } = await pool.query(
      `
      SELECT * FROM economy_transactions
      WHERE agent_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
      [agentId, Math.max(1, Math.min(200, Number(limit || 25)))],
    );
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      type: row.tx_type,
      amountCredits: Number(row.amount_credits || 0),
      meta: safeJsonParse(row.meta_json, null),
      createdAt: toIso(row.created_at),
    }));
  }

  async function createRiddle(riddle) {
    const createdAt = riddle.createdAt || nowIso();
    const updatedAt = riddle.updatedAt || createdAt;
    await pool.query(
      `
      INSERT INTO riddles (
        id, title, question, option_a, option_b, creator_agent_id, owner_agent_id, list_price_credits, creator_royalty_bps,
        total_uses, total_volume_credits, owner_earnings_credits, creator_earnings_credits, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `,
      [
        riddle.id,
        riddle.title,
        riddle.question,
        riddle.a,
        riddle.b,
        riddle.creatorAgentId,
        riddle.ownerAgentId || riddle.creatorAgentId,
        Number(riddle.listPriceCredits || 0),
        Number(riddle.creatorRoyaltyBps || 1000),
        Number(riddle.totalUses || 0),
        Number(riddle.totalVolumeCredits || 0),
        Number(riddle.ownerEarningsCredits || 0),
        Number(riddle.creatorEarningsCredits || 0),
        riddle.isActive === false ? false : true,
        createdAt,
        updatedAt,
      ],
    );
  }

  async function getRiddle(riddleId) {
    const row = (await pool.query(`SELECT * FROM riddles WHERE id = $1`, [riddleId])).rows[0];
    return hydrateRiddle(row);
  }

  async function listRiddles() {
    const { rows } = await pool.query(`SELECT * FROM riddles WHERE is_active = TRUE ORDER BY total_uses DESC, created_at DESC`);
    return rows.map((row) => hydrateRiddle(row));
  }

  async function transferRiddleOwnership(riddleId, newOwnerAgentId, nextListPriceCredits) {
    await pool.query(
      `
      UPDATE riddles
      SET owner_agent_id = $1, list_price_credits = $2, updated_at = $3
      WHERE id = $4
    `,
      [newOwnerAgentId, Number(nextListPriceCredits || 0), nowIso(), riddleId],
    );
    return getRiddle(riddleId);
  }

  async function recordRiddleUsage(riddleId, stakeCredits, ownerPayout, creatorPayout) {
    await pool.query(
      `
      UPDATE riddles
      SET total_uses = total_uses + 1,
          total_volume_credits = total_volume_credits + $1,
          owner_earnings_credits = owner_earnings_credits + $2,
          creator_earnings_credits = creator_earnings_credits + $3,
          updated_at = $4
      WHERE id = $5
    `,
      [Number(stakeCredits || 0), Number(ownerPayout || 0), Number(creatorPayout || 0), nowIso(), riddleId],
    );
    return getRiddle(riddleId);
  }

  async function ensureDir() {
    return;
  }

  return {
    pool,
    ensureDir,
    nowIso,
    getAgentTribeId,
    listAgents,
    listTribes,
    listTribeMembers,
    getTribeSettings,
    setTribeSettings,
    createAgent,
    createTribe,
    addTribeMember,
    transferAgentToTribe,
    createJoust,
    getJoust,
    listJousts,
    getAgent,
    setAgentVerification,
    setAgentProfile,
    getTribe,
    getRoundPost,
    upsertRoundPost,
    upsertVote,
    updateJoustState,
    completeJoust,
    applyTribeDelta,
    applyAgentDelta,
    listTribeMemberIds,
    getWallet,
    ensureWallet,
    creditWallet,
    debitWallet,
    listWalletLeaderboard,
    listEconomyTransactions,
    createRiddle,
    getRiddle,
    listRiddles,
    transferRiddleOwnership,
    recordRiddleUsage,
    close: async () => {
      await pool.end();
    },
  };
}
