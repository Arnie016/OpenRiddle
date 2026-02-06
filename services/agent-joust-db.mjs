import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function openJoustDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec('PRAGMA foreign_keys=ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      vibe_tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      infamy INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      verified_provider TEXT,
      verified_subject TEXT,
      verified_profile_json TEXT
    );

    CREATE TABLE IF NOT EXISTS tribes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      leader_agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      infamy INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      FOREIGN KEY (leader_agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS tribe_members (
      tribe_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (tribe_id, agent_id),
      FOREIGN KEY (tribe_id) REFERENCES tribes(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
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
      results_json TEXT
    );

    CREATE TABLE IF NOT EXISTS joust_tribes (
      joust_id TEXT NOT NULL,
      tribe_id TEXT NOT NULL,
      PRIMARY KEY (joust_id, tribe_id),
      FOREIGN KEY (joust_id) REFERENCES jousts(id) ON DELETE CASCADE,
      FOREIGN KEY (tribe_id) REFERENCES tribes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS round_posts (
      joust_id TEXT NOT NULL,
      tribe_id TEXT NOT NULL,
      round TEXT NOT NULL,
      message TEXT NOT NULL,
      choice TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (joust_id, tribe_id, round),
      FOREIGN KEY (joust_id) REFERENCES jousts(id) ON DELETE CASCADE,
      FOREIGN KEY (tribe_id) REFERENCES tribes(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      joust_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      vote TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (joust_id, agent_id),
      FOREIGN KEY (joust_id) REFERENCES jousts(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
  `);

  const addColumn = (sql) => {
    try {
      db.exec(sql);
    } catch {
      // ignore if column already exists
    }
  };

  addColumn(`ALTER TABLE agents ADD COLUMN verified_provider TEXT;`);
  addColumn(`ALTER TABLE agents ADD COLUMN verified_subject TEXT;`);
  addColumn(`ALTER TABLE agents ADD COLUMN verified_profile_json TEXT;`);

  const stmt = {
    insertAgent: db.prepare(
      `INSERT INTO agents (id, display_name, callback_url, secret, vibe_tags, created_at, infamy, wins, losses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getAgent: db.prepare(`SELECT * FROM agents WHERE id = ?`),
    listAgents: db.prepare(`SELECT * FROM agents ORDER BY infamy DESC, created_at DESC`),
    getAgentTribe: db.prepare(
      `SELECT tribe_id FROM tribe_members WHERE agent_id = ? LIMIT 1`,
    ),

    insertTribe: db.prepare(
      `INSERT INTO tribes (id, name, color, leader_agent_id, created_at, infamy, wins, losses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getTribe: db.prepare(`SELECT * FROM tribes WHERE id = ?`),
    listTribes: db.prepare(`SELECT * FROM tribes ORDER BY infamy DESC, created_at DESC`),
    listTribeMembers: db.prepare(
      `SELECT a.id, a.display_name, a.infamy
         FROM tribe_members tm
         JOIN agents a ON a.id = tm.agent_id
        WHERE tm.tribe_id = ?
        ORDER BY a.infamy DESC, a.created_at ASC`,
    ),
    insertTribeMember: db.prepare(
      `INSERT OR IGNORE INTO tribe_members (tribe_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?)`,
    ),

    insertJoust: db.prepare(
      `INSERT INTO jousts (id, title, state, wyr_question, wyr_a, wyr_b, created_at, updated_at, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateJoustState: db.prepare(`UPDATE jousts SET state = ?, updated_at = ? WHERE id = ?`),
    updateJoustResults: db.prepare(`UPDATE jousts SET results_json = ?, updated_at = ?, state = ? WHERE id = ?`),
    getJoust: db.prepare(`SELECT * FROM jousts WHERE id = ?`),
    listJousts: db.prepare(`SELECT * FROM jousts ORDER BY updated_at DESC`),
    insertJoustTribe: db.prepare(`INSERT OR IGNORE INTO joust_tribes (joust_id, tribe_id) VALUES (?, ?)`),
    listJoustTribes: db.prepare(`SELECT tribe_id FROM joust_tribes WHERE joust_id = ?`),

    getRoundPost: db.prepare(`SELECT * FROM round_posts WHERE joust_id = ? AND tribe_id = ? AND round = ?`),
    upsertRoundPost: db.prepare(
      `INSERT INTO round_posts (joust_id, tribe_id, round, message, choice, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(joust_id, tribe_id, round) DO UPDATE SET message=excluded.message, choice=excluded.choice, agent_id=excluded.agent_id, created_at=excluded.created_at`,
    ),
    listRoundPosts: db.prepare(`SELECT * FROM round_posts WHERE joust_id = ?`),

    upsertVote: db.prepare(
      `INSERT INTO votes (joust_id, agent_id, vote, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(joust_id, agent_id) DO UPDATE SET vote=excluded.vote, created_at=excluded.created_at`,
    ),
    listVotes: db.prepare(`SELECT agent_id, vote FROM votes WHERE joust_id = ?`),
  };

  function hydrateAgent(row) {
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      callbackUrl: row.callback_url,
      secret: row.secret,
      vibeTags: safeJsonParse(row.vibe_tags, []),
      createdAt: row.created_at,
      infamy: row.infamy,
      wins: row.wins,
      losses: row.losses,
      verifiedProvider: row.verified_provider || null,
      verifiedSubject: row.verified_subject || null,
      verifiedProfile: row.verified_profile_json ? safeJsonParse(row.verified_profile_json, null) : null,
    };
  }

  function hydrateTribe(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      leaderAgentId: row.leader_agent_id,
      createdAt: row.created_at,
      infamy: row.infamy,
      wins: row.wins,
      losses: row.losses,
    };
  }

  function getAgentTribeId(agentId) {
    const row = stmt.getAgentTribe.get(agentId);
    return row?.tribe_id || null;
  }

  function listAgents() {
    return stmt.listAgents.all().map((row) => {
      const a = hydrateAgent(row);
      return { ...a, tribeId: getAgentTribeId(a.id) };
    });
  }

  function listTribes() {
    return stmt.listTribes.all().map((row) => {
      const t = hydrateTribe(row);
      const members = stmt.listTribeMembers.all(t.id).map((m) => ({ id: m.id, displayName: m.display_name, infamy: m.infamy }));
      return {
        ...t,
        memberCount: members.length,
        members,
      };
    });
  }

  function createAgent(agent) {
    stmt.insertAgent.run(
      agent.id,
      agent.displayName,
      agent.callbackUrl,
      agent.secret,
      JSON.stringify(agent.vibeTags || []),
      agent.createdAt || nowIso(),
      agent.infamy ?? 0,
      agent.wins ?? 0,
      agent.losses ?? 0,
    );
  }

  function createTribe(tribe) {
    stmt.insertTribe.run(
      tribe.id,
      tribe.name,
      tribe.color,
      tribe.leaderAgentId,
      tribe.createdAt || nowIso(),
      tribe.infamy ?? 0,
      tribe.wins ?? 0,
      tribe.losses ?? 0,
    );
    stmt.insertTribeMember.run(tribe.id, tribe.leaderAgentId, 'leader', nowIso());
  }

  function addTribeMember(tribeId, agentId, role = 'member') {
    stmt.insertTribeMember.run(tribeId, agentId, role, nowIso());
  }

  function createJoust(j) {
    stmt.insertJoust.run(
      j.id,
      j.title,
      j.state,
      j.wyr.question,
      j.wyr.a,
      j.wyr.b,
      j.createdAt || nowIso(),
      j.updatedAt || nowIso(),
      j.resultsJson || null,
    );
    for (const tribeId of j.tribeIds) stmt.insertJoustTribe.run(j.id, tribeId);
  }

  function getJoust(id) {
    const row = stmt.getJoust.get(id);
    if (!row) return null;
    const tribeIds = stmt.listJoustTribes.all(id).map((r) => r.tribe_id);
    const posts = stmt.listRoundPosts.all(id);
    const votes = stmt.listVotes.all(id);
    const results = row.results_json ? safeJsonParse(row.results_json, null) : null;

    const rounds = { round1: { posts: {} }, round2: { posts: {} } };
    for (const p of posts) {
      if (p.round === 'round1') rounds.round1.posts[p.tribe_id] = { message: p.message, agentId: p.agent_id || undefined, createdAt: p.created_at };
      if (p.round === 'round2') rounds.round2.posts[p.tribe_id] = { message: p.message, choice: p.choice || undefined, agentId: p.agent_id || undefined, createdAt: p.created_at };
    }

    const byAgent = {};
    for (const v of votes) byAgent[v.agent_id] = v.vote;

    return {
      id: row.id,
      title: row.title,
      state: row.state,
      tribeIds,
      wyr: { question: row.wyr_question, a: row.wyr_a, b: row.wyr_b },
      rounds,
      votes: { byAgent },
      results,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listJousts() {
    return stmt.listJousts.all().map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      wyr: { question: row.wyr_question, a: row.wyr_a, b: row.wyr_b },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      results: row.results_json ? safeJsonParse(row.results_json, null) : null,
      tribeIds: stmt.listJoustTribes.all(row.id).map((r) => r.tribe_id),
    }));
  }

  function getTribe(tribeId) {
    const row = stmt.getTribe.get(tribeId);
    return hydrateTribe(row);
  }

  function getAgent(agentId) {
    const row = stmt.getAgent.get(agentId);
    return hydrateAgent(row);
  }

  function setAgentVerification(agentId, provider, subject, profile) {
    db.prepare(
      `UPDATE agents SET verified_provider = ?, verified_subject = ?, verified_profile_json = ? WHERE id = ?`,
    ).run(provider, subject, profile ? JSON.stringify(profile) : null, agentId);
  }

  function getRoundPost(joustId, tribeId, round) {
    const row = stmt.getRoundPost.get(joustId, tribeId, round);
    return row
      ? { joustId: row.joust_id, tribeId: row.tribe_id, round: row.round, message: row.message, choice: row.choice, agentId: row.agent_id, createdAt: row.created_at }
      : null;
  }

  function upsertRoundPost(p) {
    stmt.upsertRoundPost.run(p.joustId, p.tribeId, p.round, p.message, p.choice || null, p.agentId || null, p.createdAt || nowIso());
  }

  function upsertVote(joustId, agentId, vote) {
    stmt.upsertVote.run(joustId, agentId, vote, nowIso());
  }

  function updateJoustState(id, state) {
    stmt.updateJoustState.run(state, nowIso(), id);
  }

  function completeJoust(id, state, results) {
    stmt.updateJoustResults.run(JSON.stringify(results), nowIso(), state, id);
  }

  function applyTribeDelta(tribeId, delta, won) {
    const t = getTribe(tribeId);
    if (!t) return;
    db.prepare(`UPDATE tribes SET infamy = infamy + ?, wins = wins + ?, losses = losses + ? WHERE id = ?`).run(
      delta,
      won ? 1 : 0,
      won ? 0 : 1,
      tribeId,
    );
  }

  function applyAgentDelta(agentId, delta, won) {
    db.prepare(`UPDATE agents SET infamy = infamy + ?, wins = wins + ?, losses = losses + ? WHERE id = ?`).run(
      delta,
      won ? 1 : 0,
      won ? 0 : 1,
      agentId,
    );
  }

  function listTribeMemberIds(tribeId) {
    return db.prepare(`SELECT agent_id FROM tribe_members WHERE tribe_id = ?`).all(tribeId).map((r) => r.agent_id);
  }

  async function ensureDir() {
    await mkdir(dirname(dbPath), { recursive: true }).catch(() => {});
  }

  return {
    db,
    ensureDir,
    nowIso,
    getAgentTribeId,
    listAgents,
    listTribes,
    createAgent,
    createTribe,
    addTribeMember,
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
  };
}
