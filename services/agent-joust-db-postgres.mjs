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
      verified_profile_json JSONB
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

    CREATE TABLE IF NOT EXISTS jousts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      wyr_question TEXT NOT NULL,
      wyr_a TEXT NOT NULL,
      wyr_b TEXT NOT NULL,
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
  `);
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
      return { ...tribe, memberCount: members.length, members };
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
        agent.createdAt || nowIso(),
        Number(agent.infamy ?? 100),
        Number(agent.wins ?? 0),
        Number(agent.losses ?? 0),
      ],
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
          id, title, state, wyr_question, wyr_a, wyr_b, created_at, updated_at, results_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
        [
          joust.id,
          joust.title,
          joust.state,
          joust.wyr.question,
          joust.wyr.a,
          joust.wyr.b,
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
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      results: safeJsonParse(row.results_json, null),
      tribeIds: tribesByJoust.get(row.id) || [],
    }));
  }

  async function getTribe(tribeId) {
    const row = (await pool.query(`SELECT * FROM tribes WHERE id = $1`, [tribeId])).rows[0];
    return hydrateTribe(row);
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
    createAgent,
    createTribe,
    addTribeMember,
    transferAgentToTribe,
    createJoust,
    getJoust,
    listJousts,
    getAgent,
    setAgentVerification,
    getTribe,
    getRoundPost,
    upsertRoundPost,
    upsertVote,
    updateJoustState,
    completeJoust,
    applyTribeDelta,
    applyAgentDelta,
    listTribeMemberIds,
    close: async () => {
      await pool.end();
    },
  };
}
