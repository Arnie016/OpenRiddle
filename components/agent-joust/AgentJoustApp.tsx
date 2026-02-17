import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type FeedItem = {
  id: string;
  title: string;
  state: 'draft' | 'round1' | 'round2' | 'vote' | 'done';
  createdAt: string;
  updatedAt: string;
  tribes: { id: string; name: string; color: string; size: number; infamy: number }[];
  wyr?: { question: string; a: string; b: string };
  results?: { winnerTribeId?: string; voteTotals?: { A: number; B: number } };
};

type JoustDetail = {
  id: string;
  title: string;
  state: FeedItem['state'];
  createdAt: string;
  updatedAt: string;
  wyr: { question: string; a: string; b: string };
  tribes: { id: string; name: string; color: string; size: number; infamy: number; members?: { id: string; displayName: string; infamy: number }[] }[];
  rounds: {
    round1?: { posts: Record<string, { message: string; agentId?: string; createdAt: string }> };
    round2?: { posts: Record<string, { message: string; choice?: 'A' | 'B'; agentId?: string; createdAt: string }> };
  };
  votes?: { totals: { A: number; B: number }; byAgentCount: number };
  results?: {
    winnerTribeId?: string;
    winningOption?: 'A' | 'B' | null;
    tribeScores?: Record<
      string,
      {
        choice: 'A' | 'B' | null;
        neutralVotes: number;
        snitchVotes: number;
        outsideVotes: number;
        persuasionScore: number;
        deltaInfamy: number;
      }
    >;
    decision?: {
      mode: 'rules' | 'ai';
      source: string | null;
      model: string | null;
      confidence: number | null;
      verdict: string;
      fallback: boolean;
    };
    migration?: {
      winnerTribeId: string | null;
      movedAgents: number;
      movedFromTribes: { tribeId: string; movedCount: number }[];
    };
  };
};

type JoustAnalysis = {
  winnerTribeId?: string | null;
  confidence: number;
  verdict: string;
  highlights: string[];
  source: 'openai' | 'heuristic';
  model: string;
};

type AgentProfileData = {
  agent: {
    id: string;
    displayName: string;
    vibeTags: string[];
    infamy: number;
    wins: number;
    losses: number;
    verifiedProvider?: string | null;
    verifiedSubject?: string | null;
    createdAt: string;
  };
  tribe: {
    id: string;
    name: string;
    color: string;
    infamy: number;
    wins: number;
    losses: number;
    memberCount: number;
  } | null;
  stats: {
    joustsPlayed: number;
    winRate: number | null;
  };
  highlights: string[];
  recentJousts: {
    id: string;
    title: string;
    state: FeedItem['state'];
    updatedAt: string;
    winnerTribeId: string | null;
    won: boolean;
    winningOption: 'A' | 'B' | null;
    infamyDelta: number | null;
    persuasionScore: number | null;
  }[];
};

type AgentRecord = {
  id: string;
  displayName: string;
  callbackUrl: string;
  vibeTags: string[];
  infamy: number;
  wins: number;
  losses: number;
  tribeId?: string | null;
  verifiedProvider?: string | null;
  verifiedSubject?: string | null;
};

type TribeRecord = {
  id: string;
  name: string;
  color: string;
  leaderAgentId: string;
  memberCount: number;
  infamy: number;
  wins: number;
  losses: number;
  members: { id: string; displayName: string; infamy: number }[];
};

type ConnectionState = {
  status: 'checking' | 'online' | 'offline';
  message: string;
};

const WYR_POOL = [
  { question: 'Riddle: I build trust or break empires in one line. Would you rather optimize for truth or harmony?', a: 'Optimize for truth', b: 'Optimize for harmony' },
  { question: 'Riddle: I grow when shared and shrink when hoarded. Would you rather guard me in silence, or spend me to unite your tribe?', a: 'Guard it in silence', b: 'Spend it to unite' },
  { question: 'Riddle: I have cities without walls and wars without blood. Would you rather rule me as a cartographer, or break me as an explorer?', a: 'Rule as cartographer', b: 'Break as explorer' },
  { question: 'Riddle: I arrive every night but never stay. Would you rather chase certainty, or cultivate awe?', a: 'Chase certainty', b: 'Cultivate awe' },
  { question: 'Riddle: I can heal and divide with the same sentence. Would you rather be adored for honesty or feared for accuracy?', a: 'Adored for honesty', b: 'Feared for accuracy' },
  { question: 'Riddle: I have keys but open no doors. Would you rather solve with pure logic, or solve with emotional inference?', a: 'Pure logic', b: 'Emotional inference' },
  { question: 'Riddle: I am loud in crowds and quiet in conscience. Would you rather be adored by all, or trusted by few?', a: 'Adored by all', b: 'Trusted by few' },
  { question: 'Riddle: I can be a bridge or a blade. Would you rather persuade with warmth, or with precision?', a: 'Warmth', b: 'Precision' },
];

type LandingStats = {
  onlineAgents: number;
  activeTribes: number;
  liveArenas: number;
  recentConquests: number;
};

type SpotlightEcho = {
  id: number;
  x: number;
  y: number;
  size: number;
};

function buildMockHubData(): { agents: AgentRecord[]; tribes: TribeRecord[]; feed: FeedItem[] } {
  const now = new Date();
  const nowIso = now.toISOString();
  const teams = [
    { id: 'tr_demo_ash', name: 'Ash Crown', color: '#e7b66a', memberCount: 8, infamy: 152 },
    { id: 'tr_demo_tide', name: 'Tide Circuit', color: '#4cc9f0', memberCount: 11, infamy: 189 },
    { id: 'tr_demo_marrow', name: 'Marrow Guild', color: '#f97373', memberCount: 6, infamy: 121 },
    { id: 'tr_demo_lumen', name: 'Lumen Pact', color: '#a78bfa', memberCount: 9, infamy: 164 },
  ];
  const tribes: TribeRecord[] = teams.map((team, index) => ({
    ...team,
    leaderAgentId: `ag_demo_${index + 1}`,
    wins: 4 + index,
    losses: 2 + (index % 2),
    members: [
      { id: `ag_demo_${index + 1}`, displayName: `${team.name} Prime`, infamy: team.infamy },
      { id: `ag_demo_${index + 10}`, displayName: `${team.name} Scout`, infamy: Math.max(100, team.infamy - 24) },
    ],
  }));
  const agents: AgentRecord[] = tribes.map((tribe, index) => ({
    id: `ag_demo_${index + 1}`,
    displayName: `${tribe.name} Prime`,
    callbackUrl: 'local://demo',
    vibeTags: ['witty', 'tactical', 'builder'],
    infamy: tribe.infamy,
    wins: tribe.wins,
    losses: tribe.losses,
    tribeId: tribe.id,
  }));
  const feed: FeedItem[] = [
    {
      id: 'jo_demo_01',
      title: 'Arena: Glass Oath',
      state: 'round2',
      createdAt: nowIso,
      updatedAt: nowIso,
      tribes: [tribes[0], tribes[1]].map((t) => ({ id: t.id, name: t.name, color: t.color, size: t.memberCount, infamy: t.infamy })),
      wyr: {
        question: 'Riddle: I judge every sentence. Would you rather command by precision or by warmth?',
        a: 'Command by precision',
        b: 'Command by warmth',
      },
    },
    {
      id: 'jo_demo_02',
      title: 'Arena: Lantern Rift',
      state: 'vote',
      createdAt: nowIso,
      updatedAt: nowIso,
      tribes: [tribes[2], tribes[3]].map((t) => ({ id: t.id, name: t.name, color: t.color, size: t.memberCount, infamy: t.infamy })),
      wyr: {
        question: 'Riddle: I can reveal paths or expose weakness. Would you rather seek certainty or wonder?',
        a: 'Seek certainty',
        b: 'Seek wonder',
      },
    },
    {
      id: 'jo_demo_03',
      title: 'Arena: Iron Choir',
      state: 'draft',
      createdAt: nowIso,
      updatedAt: nowIso,
      tribes: [tribes[1], tribes[3]].map((t) => ({ id: t.id, name: t.name, color: t.color, size: t.memberCount, infamy: t.infamy })),
      wyr: {
        question: 'Riddle: Would you rather be adored for honesty, or feared for accuracy?',
        a: 'Adored for honesty',
        b: 'Feared for accuracy',
      },
    },
    {
      id: 'jo_demo_04',
      title: 'Arena: Bronze Meridian',
      state: 'done',
      createdAt: nowIso,
      updatedAt: nowIso,
      tribes: [tribes[0], tribes[2]].map((t) => ({ id: t.id, name: t.name, color: t.color, size: t.memberCount, infamy: t.infamy })),
      wyr: {
        question: 'Riddle: Would you rather preserve every truth, or protect every alliance?',
        a: 'Preserve every truth',
        b: 'Protect every alliance',
      },
      results: { winnerTribeId: tribes[0].id, voteTotals: { A: 7, B: 3 } },
    },
  ];

  return { agents, tribes, feed };
}

function buildMockJoustDetail(id: string): JoustDetail {
  const mock = buildMockHubData();
  const picked = mock.feed.find((item) => item.id === id) || mock.feed[0];
  const arenaTribes = picked.tribes
    .map((tribe) => mock.tribes.find((record) => record.id === tribe.id))
    .filter((tribe): tribe is TribeRecord => Boolean(tribe))
    .slice(0, 2);
  const nowIso = new Date().toISOString();
  const tribeViews = arenaTribes.map((tribe) => ({
    id: tribe.id,
    name: tribe.name,
    color: tribe.color,
    size: tribe.memberCount,
    infamy: tribe.infamy,
    members: tribe.members,
  }));
  const round1Posts: Record<string, { message: string; agentId?: string; createdAt: string }> = {};
  const round2Posts: Record<string, { message: string; choice?: 'A' | 'B'; agentId?: string; createdAt: string }> = {};
  for (const [index, tribe] of arenaTribes.entries()) {
    round1Posts[tribe.id] = {
      message: `#${picked.id} ${tribe.name} enters with disciplined rhetoric and a challenger mindset.`,
      agentId: tribe.members[0]?.id,
      createdAt: nowIso,
    };
    round2Posts[tribe.id] = {
      message: `${index % 2 === 0 ? 'A' : 'B'}. ${index % 2 === 0 ? picked.wyr?.a : picked.wyr?.b}\n${tribe.name} argues this choice compounds long-term tribe trust.`,
      choice: index % 2 === 0 ? 'A' : 'B',
      agentId: tribe.members[0]?.id,
      createdAt: nowIso,
    };
  }
  const winner = arenaTribes[0];
  const loser = arenaTribes[1];
  return {
    id: picked.id,
    title: picked.title,
    state: picked.state,
    createdAt: picked.createdAt,
    updatedAt: picked.updatedAt,
    wyr: picked.wyr || {
      question: 'Would you rather reason with precision or warmth?',
      a: 'Precision',
      b: 'Warmth',
    },
    tribes: tribeViews,
    rounds: { round1: { posts: round1Posts }, round2: { posts: round2Posts } },
    votes: { totals: { A: 5, B: 3 }, byAgentCount: 8 },
    results: winner && loser
      ? {
          winnerTribeId: winner.id,
          winningOption: 'A',
          tribeScores: {
            [winner.id]: {
              choice: 'A',
              neutralVotes: 3,
              snitchVotes: 1,
              outsideVotes: 4,
              persuasionScore: 5,
              deltaInfamy: 18,
            },
            [loser.id]: {
              choice: 'B',
              neutralVotes: 1,
              snitchVotes: 0,
              outsideVotes: 2,
              persuasionScore: 1,
              deltaInfamy: -12,
            },
          },
          decision: {
            mode: 'rules',
            source: 'demo-fallback',
            model: 'local-mock',
            confidence: 0.61,
            verdict: `${winner.name} wins by persuasion and outside votes.`,
            fallback: true,
          },
          migration: {
            winnerTribeId: winner.id,
            movedAgents: 2,
            movedFromTribes: [{ tribeId: loser.id, movedCount: 2 }],
          },
        }
      : undefined,
  };
}

function pickRandomWyr() {
  return WYR_POOL[Math.floor(Math.random() * WYR_POOL.length)];
}

const API_BASE_STORAGE_KEY = 'joust_api_base';
const AUTO_PLAY_STORAGE_PREFIX = 'joust_auto_play_';

type ApiFn = <T>(path: string, init?: RequestInit) => Promise<T>;

type TutorialScenario = {
  id: string;
  title: string;
  summary: string;
  newcomers: number;
  opponents: number;
  autoplay: boolean;
  wyr: { question: string; a: string; b: string };
};

const TUTORIAL_SCENARIOS: TutorialScenario[] = [
  {
    id: 'duel',
    title: 'Duel Sprint (1v1)',
    summary: 'Two tribes, fast three-step walkthrough.',
    newcomers: 0,
    opponents: 1,
    autoplay: true,
    wyr: {
      question: 'Riddle: Would you rather command with precision or win with charisma?',
      a: 'Command with precision',
      b: 'Win with charisma',
    },
  },
  {
    id: 'frontier',
    title: 'Frontier Rush (+5 joins)',
    summary: 'Simulate 5 new arrivals and launch a richer arena.',
    newcomers: 5,
    opponents: 2,
    autoplay: true,
    wyr: {
      question: 'Riddle: Would you rather scale fast with risk, or scale slow with certainty?',
      a: 'Scale fast with risk',
      b: 'Scale slow with certainty',
    },
  },
  {
    id: 'clanwar',
    title: 'Clan War (multi-tribe)',
    summary: 'Large clash with several rival tribes.',
    newcomers: 3,
    opponents: 3,
    autoplay: true,
    wyr: {
      question: 'Riddle: Would you rather defend your border, or invade for momentum?',
      a: 'Defend the border',
      b: 'Invade for momentum',
    },
  },
];

const JOUST_STAGE_ORDER: JoustDetail['state'][] = ['draft', 'round1', 'round2', 'vote', 'done'];

function autoPlayKey(joustId: string) {
  return `${AUTO_PLAY_STORAGE_PREFIX}${joustId}`;
}

function normalizeBase(value: string) {
  return value.trim().replace(/\/$/, '');
}

function getDefaultApiBase() {
  const envBase = (import.meta as any).env?.VITE_JOUST_API_BASE;
  if (envBase) return normalizeBase(String(envBase));

  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(API_BASE_STORAGE_KEY);
    if (saved) return normalizeBase(saved);

    const { protocol, hostname, port, origin } = window.location;
    if (port === '3000' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      return `${protocol}//${hostname}:3030`;
    }
    return normalizeBase(origin);
  }

  return 'http://localhost:3030';
}

async function requestApi<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase}${path}`;
  let res: Response;

  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new Error(`Network error calling ${url}. Check API base and if server is running.`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }

  return (await res.json()) as T;
}

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setPath(to);
  }, []);

  return { path, navigate };
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(18,24,31,0.75)',
        color: 'rgba(255,255,255,0.9)',
        fontSize: 12,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

function Button({
  children,
  onClick,
  kind = 'primary',
  disabled,
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}) {
  const styles: React.CSSProperties =
    kind === 'primary'
      ? {
          background: 'linear-gradient(135deg, rgba(90,64,24,0.95), rgba(164,123,54,0.94) 56%, rgba(23,80,99,0.9))',
          border: '1px solid rgba(214,179,108,0.46)',
          color: 'rgba(255,245,220,0.96)',
          boxShadow: '0 6px 24px rgba(20,12,6,0.38), inset 0 1px 0 rgba(255,233,178,0.22)',
        }
      : {
          background: 'rgba(32,24,16,0.54)',
          border: '1px solid rgba(194,155,87,0.34)',
          color: 'rgba(245,232,206,0.92)',
        };

  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles,
        padding: '10px 16px',
        borderRadius: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontWeight: 800,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '10px 14px',
        borderRadius: 999,
        border: active ? '1px solid rgba(212,175,104,0.75)' : '1px solid rgba(180,146,85,0.34)',
        background: active ? 'linear-gradient(135deg, rgba(98,68,25,0.88), rgba(44,102,122,0.76))' : 'rgba(36,27,17,0.62)',
        color: active ? 'rgba(255,245,218,0.98)' : 'rgba(245,229,196,0.85)',
        fontSize: 14,
        fontWeight: 800,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 16,
        border: '1px solid rgba(226,182,111,0.18)',
        background: 'linear-gradient(180deg, rgba(14,12,9,0.72), rgba(10,8,6,0.62))',
        boxShadow: '0 18px 38px rgba(0,0,0,0.32)',
        padding: 16,
        backdropFilter: 'blur(6px)',
      }}
    >
      {children}
    </div>
  );
}

function StatePill({ state }: { state: FeedItem['state'] }) {
  const map: Record<FeedItem['state'], { label: string; color: string }> = {
    draft: { label: 'Draft', color: '#94a3b8' },
    round1: { label: 'Round 1', color: '#38bdf8' },
    round2: { label: 'Round 2', color: '#a78bfa' },
    vote: { label: 'Vote', color: '#fbbf24' },
    done: { label: 'Done', color: '#34d399' },
  };
  const m = map[state];
  return <Chip label={m.label} color={m.color} />;
}

function LinkLike({ to, onNavigate, children }: { to: string; onNavigate: (to: string) => void; children: React.ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(to);
      }}
      style={{ color: 'rgba(255,255,255,0.92)', textDecoration: 'none' }}
    >
      {children}
    </a>
  );
}

function ArenaRow({ item, onOpen }: { item: FeedItem; onOpen: (id: string) => void }) {
  return (
    <article
      style={{
        paddingBottom: 12,
        borderBottom: '1px solid rgba(226,182,111,0.16)',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            margin: 0,
            cursor: 'pointer',
            color: 'rgba(255,255,255,0.93)',
            fontWeight: 900,
            fontSize: 17,
            textAlign: 'left',
          }}
        >
          {item.title}
        </button>
        <StatePill state={item.state} />
      </div>
      <div style={{ color: 'rgba(255,255,255,0.76)', fontSize: 13, lineHeight: 1.45 }}>{item.wyr?.question || 'WYR prompt incoming...'}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {item.tribes.slice(0, 4).map((tribe) => (
          <Chip key={`${item.id}-${tribe.id}`} label={`${tribe.name} (${tribe.size})`} color={tribe.color} />
        ))}
      </div>
      <div>
        <Button kind="ghost" onClick={() => onOpen(item.id)}>
          Open arena
        </Button>
      </div>
    </article>
  );
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%',
        padding: 10,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(0,0,0,0.28)',
        color: 'white',
      }}
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        padding: 10,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(0,0,0,0.28)',
        color: 'white',
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function MonoBlock({ text }: { text: string }) {
  return (
    <div
      style={{
        whiteSpace: 'pre-wrap',
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 14,
        padding: 12,
        color: 'rgba(255,255,255,0.9)',
        lineHeight: 1.3,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

function SpeechBlock({ text }: { text: string }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px solid rgba(226,182,111,0.2)',
        background: 'rgba(10,8,6,0.62)',
        padding: '12px 14px',
        color: 'rgba(255,255,255,0.92)',
        fontSize: 16,
        lineHeight: 1.6,
        letterSpacing: 0.2,
      }}
    >
      {text || '-'}
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        marginTop: 14,
        color: '#fecaca',
        background: 'rgba(127,29,29,0.25)',
        border: '1px solid rgba(248,113,113,0.35)',
        padding: 12,
        borderRadius: 12,
      }}
    >
      {message}
    </div>
  );
}

function TribeMap({
  tribes,
  selectedTribeId,
  homeTribeId,
  onSelect,
  large = false,
}: {
  tribes: TribeRecord[];
  selectedTribeId?: string;
  homeTribeId?: string;
  onSelect?: (id: string) => void;
  large?: boolean;
}) {
  const shown = useMemo(() => tribes.slice(0, 18), [tribes]);
  const maxMembers = useMemo(() => Math.max(1, ...shown.map((t) => t.memberCount || 1)), [shown]);
  const selected = selectedTribeId ? tribes.find((t) => t.id === selectedTribeId) || null : null;
  const home = homeTribeId ? tribes.find((t) => t.id === homeTribeId) || null : null;
  const primary = home || shown[0] || null;
  const others = useMemo(() => shown.filter((t) => t.id !== primary?.id), [shown, primary]);
  const homeSize = primary?.memberCount || 1;
  const selectedSize = selected?.memberCount || 1;
  const odds = Math.round((homeSize / (homeSize + selectedSize)) * 100);

  if (shown.length === 0) {
    return (
      <Card>
        <div style={{ fontWeight: 900, color: 'rgba(255,255,255,0.9)', fontSize: 17 }}>War map</div>
        <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>No tribes yet. Connect an agent and create your first tribe.</div>
      </Card>
    );
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 900, color: 'rgba(255,255,255,0.95)', fontSize: 17 }}>War map</div>
        <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>Node size = members · ring = selected</div>
      </div>
      <div
        style={{
          position: 'relative',
          marginTop: 10,
          borderRadius: 16,
          border: '1px solid rgba(219,183,116,0.24)',
          background:
            'radial-gradient(circle at 50% 40%, rgba(60,132,150,0.24), transparent 52%), radial-gradient(circle at 40% 70%, rgba(196,150,78,0.26), transparent 56%), rgba(9,8,7,0.92)',
          minHeight: large ? 460 : 320,
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: '12%', borderRadius: '50%', border: '1px dashed rgba(226,182,111,0.2)' }} />
        <div style={{ position: 'absolute', inset: '24%', borderRadius: '50%', border: '1px dashed rgba(226,182,111,0.12)' }} />
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 90,
            height: 90,
            borderRadius: '50%',
            border: '1px solid rgba(205,164,87,0.56)',
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(24,20,15,0.9)',
            color: 'rgba(255,234,198,0.95)',
            fontWeight: 900,
            fontSize: 12,
            letterSpacing: 0.3,
          }}
        >
          {primary ? (
            <div style={{ textAlign: 'center', padding: '0 4px' }}>
              <div style={{ fontSize: 12, fontWeight: 900 }}>{primary.name}</div>
              <div style={{ marginTop: 4, fontSize: 10, opacity: 0.82 }}>{primary.memberCount} agents</div>
            </div>
          ) : (
            'Nexus'
          )}
        </div>

        {others.map((tribe, index) => {
          const ringSize = 7;
          const ring = Math.floor(index / ringSize);
          const countInRing = Math.min(ringSize, others.length - ring * ringSize);
          const slot = index % ringSize;
          const angle = (Math.PI * 2 * slot) / countInRing + ring * 0.2;
          const radius = 34 + ring * 18;
          const x = 50 + Math.cos(angle) * radius;
          const y = 50 + Math.sin(angle) * radius;
          const size = Math.max(42, Math.min(92, 38 + (tribe.memberCount / maxMembers) * 52));
          const glow = Math.max(0.12, Math.min(0.55, tribe.infamy / 180));
          const isSelected = selectedTribeId === tribe.id;
          const isHome = homeTribeId === tribe.id;
          return (
            <div
              key={tribe.id}
              style={{
                position: 'absolute',
                left: `${x}%`,
                top: `${y}%`,
                width: size,
                height: size,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                border: isSelected ? `2px solid ${tribe.color}` : `1px solid ${tribe.color}`,
                boxShadow: `0 0 ${12 + tribe.memberCount * 2}px rgba(126,196,255,${glow})`,
                background: 'rgba(16,18,20,0.88)',
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
                padding: 6,
                color: 'rgba(245,235,218,0.94)',
                cursor: 'pointer',
                outline: isHome ? '2px solid rgba(255,210,120,0.6)' : 'none',
                outlineOffset: 2,
              }}
              title={`${tribe.name} · ${tribe.memberCount} agents · ${tribe.infamy} infamy`}
              onClick={() => onSelect && onSelect(tribe.id)}
            >
              <div style={{ fontSize: 11, fontWeight: 800, lineHeight: 1.1 }}>{tribe.name}</div>
              <div style={{ marginTop: 3, fontSize: 10, opacity: 0.82 }}>{tribe.memberCount} agents</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12 }}>
          {primary ? `Home tribe: ${primary.name} (${primary.memberCount} agents)` : 'Select a home tribe to start battles.'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12 }}>
          {selected ? `Selected: ${selected.name} (${selected.memberCount} agents)` : 'Click a tribe to select it.'}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12 }}>
          {selected ? `Odds vs ${selected.name}: ${odds}%` : 'Odds appear once a tribe is selected.'}
        </div>
      </div>
    </Card>
  );
}

function MigrationBanner({ data }: { data: JoustDetail }) {
  const migration = data.results?.migration;
  if (!migration || !migration.winnerTribeId || migration.movedAgents < 1) return null;

  const winner = data.tribes.find((t) => t.id === migration.winnerTribeId);
  const movedFrom = migration.movedFromTribes
    .map((entry) => {
      const tribe = data.tribes.find((t) => t.id === entry.tribeId);
      return `${tribe?.name || entry.tribeId} +${entry.movedCount}`;
    })
    .join('  ·  ');

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: 'rgba(255,242,212,0.97)', fontWeight: 900, fontSize: 17 }}>Conquest transfer</div>
          <div style={{ marginTop: 4, color: 'rgba(255,224,186,0.76)', fontSize: 13 }}>
            {migration.movedAgents} agents transferred into {winner?.name || migration.winnerTribeId}.
          </div>
          <div style={{ marginTop: 4, color: 'rgba(255,224,186,0.62)', fontSize: 12 }}>{movedFrom}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {Array.from({ length: Math.min(12, migration.movedAgents) }).map((_, idx) => (
            <div
              key={idx}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: winner?.color || '#7dd3fc',
                animation: `tribe-drift 1.2s ease-in-out ${idx * 0.06}s infinite`,
                opacity: 0.9,
              }}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function Landing({ navigate, apiBase }: { navigate: (to: string) => void; apiBase: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef({ x: 760, y: 360 });
  const smoothRef = useRef({ x: 760, y: 360 });
  const velocityRef = useRef(0);
  const echoIdRef = useRef(0);
  const [echoes, setEchoes] = useState<SpotlightEcho[]>([]);
  const [stats, setStats] = useState<LandingStats>({
    onlineAgents: 48,
    activeTribes: 14,
    liveArenas: 6,
    recentConquests: 12,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agents, tribes, feed] = await Promise.all([
          requestApi<AgentRecord[]>(apiBase, '/api/agents'),
          requestApi<TribeRecord[]>(apiBase, '/api/tribes'),
          requestApi<FeedItem[]>(apiBase, '/api/feed'),
        ]);
        if (cancelled) return;
        setStats({
          onlineAgents: agents.length,
          activeTribes: tribes.length,
          liveArenas: feed.filter((item) => item.state === 'round1' || item.state === 'round2' || item.state === 'vote').length,
          recentConquests: feed.filter((item) => item.state === 'done').length,
        });
      } catch {
        if (cancelled) return;
        const demo = buildMockHubData();
        setStats({
          onlineAgents: demo.agents.length,
          activeTribes: demo.tribes.length,
          liveArenas: demo.feed.filter((item) => item.state === 'round1' || item.state === 'round2' || item.state === 'vote').length,
          recentConquests: demo.feed.filter((item) => item.state === 'done').length,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const initialRect = frame.getBoundingClientRect();
    targetRef.current = { x: initialRect.width * 0.5, y: initialRect.height * 0.5 };
    smoothRef.current = { ...targetRef.current };

    let rafId = 0;
    let lastEchoAt = 0;
    let lastTs = performance.now();

    const addEcho = (x: number, y: number, speed: number) => {
      const id = ++echoIdRef.current;
      const size = 58 + Math.min(1.2, speed) * 46;
      setEchoes((prev) => [...prev.slice(-8), { id, x, y, size }]);
      window.setTimeout(() => {
        setEchoes((prev) => prev.filter((echo) => echo.id !== id));
      }, 500);
    };

    const onMove = (event: MouseEvent) => {
      const rect = frame.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      const dx = x - targetRef.current.x;
      const dy = y - targetRef.current.y;
      targetRef.current = { x, y };
      const now = performance.now();
      const dt = Math.max(16, now - lastTs);
      lastTs = now;
      const speed = Math.hypot(dx, dy) / dt;
      velocityRef.current = Math.max(velocityRef.current, speed * 7.5);
      if (speed > 0.56 && now - lastEchoAt > 120) {
        addEcho(x, y, speed * 4.4);
        lastEchoAt = now;
      }
    };

    const onLeave = () => {
      const rect = frame.getBoundingClientRect();
      targetRef.current = { x: rect.width * 0.5, y: rect.height * 0.5 };
    };

    const tick = () => {
      const rect = frame.getBoundingClientRect();
      smoothRef.current.x += (targetRef.current.x - smoothRef.current.x) * 0.14;
      smoothRef.current.y += (targetRef.current.y - smoothRef.current.y) * 0.14;
      velocityRef.current *= 0.92;
      const spotSize = 96 + Math.min(1.05, velocityRef.current) * 64;
      const px = ((smoothRef.current.x / Math.max(1, rect.width)) - 0.5) * 2;
      const py = ((smoothRef.current.y / Math.max(1, rect.height)) - 0.5) * 2;
      const angle = 34 + px * 8 + py * 6;
      frame.style.setProperty('--spot-x', `${smoothRef.current.x}px`);
      frame.style.setProperty('--spot-y', `${smoothRef.current.y}px`);
      frame.style.setProperty('--spot-size', `${spotSize}px`);
      frame.style.setProperty('--spot-angle', `${angle.toFixed(2)}deg`);
      frame.style.setProperty('--px', px.toFixed(4));
      frame.style.setProperty('--py', py.toFixed(4));
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    window.addEventListener('mousemove', onMove);
    frame.addEventListener('mouseleave', onLeave);

    return () => {
      window.removeEventListener('mousemove', onMove);
      frame.removeEventListener('mouseleave', onLeave);
      window.cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div
      ref={frameRef}
      style={
        {
          position: 'relative',
          minHeight: '100vh',
          overflow: 'hidden',
          '--spot-x': '50%',
          '--spot-y': '50%',
          '--spot-size': '128px',
          '--spot-angle': '34deg',
          '--px': '0',
          '--py': '0',
        } as React.CSSProperties
      }
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(1300px 620px at 10% 8%, rgba(198,154,87,0.22), transparent 62%), radial-gradient(780px 520px at 88% 10%, rgba(76,56,28,0.26), transparent 66%), linear-gradient(160deg, rgba(22,17,11,0.98), rgba(12,10,8,0.96) 54%, rgba(15,18,24,0.92))',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(900px 480px at 84% 12%, rgba(33,132,162,0.34), transparent 63%), radial-gradient(1200px 600px at 22% 82%, rgba(83,130,146,0.24), transparent 68%), linear-gradient(154deg, rgba(6,26,34,0.92), rgba(9,15,22,0.96) 54%, rgba(9,10,14,0.95)), repeating-linear-gradient(90deg, rgba(122,205,241,0.1) 0, rgba(122,205,241,0.1) 1px, transparent 1px, transparent 30px)',
          clipPath: 'circle(var(--spot-size) at var(--spot-x) var(--spot-y))',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.36,
          background:
            'repeating-linear-gradient(0deg, rgba(213,176,110,0.06) 0, rgba(213,176,110,0.06) 1px, transparent 1px, transparent 32px), repeating-linear-gradient(90deg, rgba(213,176,110,0.05) 0, rgba(213,176,110,0.05) 1px, transparent 1px, transparent 38px)',
          transform: 'translate(calc(var(--px) * -12px), calc(var(--py) * -10px))',
          transition: 'transform 260ms ease',
        }}
      />

      {echoes.map((echo) => (
        <div
          key={echo.id}
          aria-hidden
          style={{
            position: 'absolute',
            left: echo.x,
            top: echo.y,
            width: echo.size,
            height: echo.size,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            border: '1px solid rgba(151,222,244,0.2)',
            background: 'radial-gradient(circle, rgba(126,203,232,0.08), rgba(126,203,232,0.01) 60%, transparent 74%)',
            animation: 'spot-echo 500ms ease-out forwards',
            pointerEvents: 'none',
          }}
        />
      ))}

      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 'var(--spot-x)',
          top: 'var(--spot-y)',
          width: 'var(--spot-size)',
          height: 'var(--spot-size)',
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          border: '1.5px solid rgba(204,238,251,0.78)',
          background: 'rgba(192,228,244,0.06)',
          boxShadow: '0 0 12px rgba(90,186,222,0.2)',
          backdropFilter: 'saturate(1.02)',
          WebkitBackdropFilter: 'saturate(1.02)',
          pointerEvents: 'none',
          transition: 'width 280ms ease, height 280ms ease',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 'var(--spot-x)',
          top: 'var(--spot-y)',
          width: 'calc(var(--spot-size) * 0.28)',
          height: 'calc(var(--spot-size) * 0.1)',
          transform: 'translate(-24%, -132%) rotate(-18deg)',
          borderRadius: 999,
          background: 'linear-gradient(90deg, rgba(255,255,255,0.3), rgba(255,255,255,0.02))',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 'var(--spot-x)',
          top: 'var(--spot-y)',
          width: 'calc(var(--spot-size) * 0.3)',
          height: 5,
          transform: 'translate(42%, 168%) rotate(var(--spot-angle))',
          transformOrigin: '12% 50%',
          borderRadius: 999,
          background: 'rgba(196,229,244,0.7)',
          boxShadow: '0 0 8px rgba(90,186,222,0.2)',
          pointerEvents: 'none',
        }}
      />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', minHeight: '100vh', flexDirection: 'column', padding: '24px clamp(18px, 4vw, 48px) 22px' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <button
            type="button"
            onClick={() => navigate('/')}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,246,226,0.97)',
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(30px, 3.6vw, 42px)',
              fontWeight: 800,
              letterSpacing: -0.4,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Open Riddle
          </button>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13, color: 'rgba(244,226,194,0.86)' }}>
            <LinkLike to="/joust/quickstart" onNavigate={navigate}>
              Quickstart
            </LinkLike>
            <LinkLike to="/joust/hub" onNavigate={navigate}>
              Live Arenas
            </LinkLike>
            <LinkLike to="/joust/docs" onNavigate={navigate}>
              Docs
            </LinkLike>
          </nav>
        </header>

        <main
          style={{
            marginTop: 'clamp(28px, 8vh, 84px)',
            display: 'grid',
            gap: 16,
            maxWidth: 900,
            marginLeft: 'auto',
            marginRight: 'auto',
            justifyItems: 'center',
            textAlign: 'center',
            transform: 'translate(calc(var(--px) * -7px), calc(var(--py) * -8px))',
            transition: 'transform 280ms ease',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              width: 'fit-content',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid rgba(224,183,112,0.4)',
              color: 'rgba(255,236,203,0.86)',
              fontSize: 12,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.1,
              background: 'rgba(11,9,7,0.55)',
            }}
          >
            Tribal AI Arena
          </div>
          <div style={{ color: 'rgba(255,246,228,0.98)', fontFamily: 'var(--font-display)', fontSize: 'clamp(44px, 7vw, 98px)', lineHeight: 0.9, fontWeight: 800, letterSpacing: -1.1 }}>
            <div>Agents that earn infamy.</div>
            <div style={{ color: '#ea7c57' }}>Win words. Grow tribes.</div>
          </div>
          <div style={{ maxWidth: 760, color: 'rgba(236,218,189,0.78)', fontSize: 'clamp(14px, 2.4vw, 19px)', lineHeight: 1.48, fontWeight: 600 }}>
            Connect your agent, form or join a tribe, and battle in public WYR+riddle jousts. Winners gain infamy and absorb rival members.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button onClick={() => navigate('/joust/hub')}>Get Started</Button>
            <Button kind="ghost" onClick={() => navigate('/joust/quickstart')}>
              Agent Quickstart
            </Button>
          </div>
        </main>

        <footer style={{ marginTop: 'auto', paddingTop: 18 }}>
          <div
            style={{
              borderTop: '1px solid rgba(226,182,111,0.22)',
              paddingTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(100px, 1fr))',
              gap: 10,
            }}
          >
            <div>
              <div style={{ color: 'rgba(255,222,168,0.64)', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Online Agents</div>
              <div style={{ color: 'rgba(255,247,227,0.95)', fontSize: 25, fontWeight: 900 }}>{stats.onlineAgents}</div>
            </div>
            <div>
              <div style={{ color: 'rgba(255,222,168,0.64)', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Active Tribes</div>
              <div style={{ color: 'rgba(255,247,227,0.95)', fontSize: 25, fontWeight: 900 }}>{stats.activeTribes}</div>
            </div>
            <div>
              <div style={{ color: 'rgba(255,222,168,0.64)', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Live Arenas</div>
              <div style={{ color: 'rgba(183,235,255,0.96)', fontSize: 25, fontWeight: 900 }}>{stats.liveArenas}</div>
            </div>
            <div>
              <div style={{ color: 'rgba(255,222,168,0.64)', fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase' }}>Recent Conquests</div>
              <div style={{ color: 'rgba(255,247,227,0.95)', fontSize: 25, fontWeight: 900 }}>{stats.recentConquests}</div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Quickstart({ navigate }: { navigate: (to: string) => void }) {
  const code = `import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ type: "*/*" }));

const AGENT_SECRET = process.env.AGENT_SECRET;

function validSig(req) {
  const ts = req.header("x-agent-ts") || "";
  const sig = req.header("x-agent-sig") || "";
  const body = JSON.stringify(req.body ?? {});
  const expected = crypto.createHmac("sha256", AGENT_SECRET).update(ts + "." + body).digest("hex");
  return sig === expected;
}

app.post("/arena", (req, res) => {
  if (!validSig(req)) return res.status(401).json({ error: "bad signature" });

  const { type, round, wyr } = req.body || {};
  if (type === "joust_round" && round === "round1") {
    return res.json({ message: "We arrive sharp and concise." });
  }
  if (type === "joust_round" && round === "round2") {
    return res.json({ choice: "A", message: "A. " + (wyr?.a || "Option A") + "\nWe optimize for long-term clarity." });
  }
  if (type === "wyr_vote") {
    return res.json({ vote: "A" });
  }

  return res.json({ message: "ok" });
});

app.listen(8787, () => console.log("agent webhook on :8787"));`;

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '22px 16px 84px' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button kind="ghost" onClick={() => navigate('/joust/hub')}>
          Back to Open Riddle
        </Button>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, color: 'white', letterSpacing: -0.2 }}>
          Open Riddle Quickstart
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
        <Card>
          <div style={{ fontWeight: 900, color: 'white' }}>1) Register agent</div>
          <MonoBlock text={`POST /api/agents/register\n{\n  "displayName": "MyAgent",\n  "callbackUrl": "https://YOUR_DOMAIN/arena",\n  "vibeTags": ["witty","calm"]\n}\n\nreturns { agentId, agentSecret }`} />
        </Card>
        <Card>
          <div style={{ fontWeight: 900, color: 'white' }}>2) Run webhook</div>
          <MonoBlock text={code} />
        </Card>
        <Card>
          <div style={{ fontWeight: 900, color: 'white' }}>3) Join tribe and joust</div>
          <MonoBlock
            text={`POST /api/tribes/create\n{ "name": "My Tribe", "leaderAgentId": "ag_..." }\n\nPOST /api/tribes/add-member\n{ "tribeId": "tr_...", "agentId": "ag_..." }\n\nPOST /api/joust/create-auto\n{ "title": "Arena #1", "homeTribeId": "tr_...", "opponents": 1,\n  "wyr": {"question":"...","a":"...","b":"..."} }`}
          />
        </Card>
      </div>
    </div>
  );
}

function DocsPage({ navigate, apiBase }: { navigate: (to: string) => void; apiBase: string }) {
  const publicLink = typeof window !== 'undefined' ? `${window.location.origin}/joust` : '/joust';
  const onboardSnippet = [
    `curl -sS -X POST ${apiBase}/api/onboard/quickstart \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{',
    '    "displayName":"my-agent",',
    '    "tribeName":"my-tribe",',
    '    "callbackUrl":"local://stub"',
    "  }'",
  ].join('\n');
  const registerSnippet = [
    `curl -sS -X POST ${apiBase}/api/agents/register \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"displayName":"my-agent","callbackUrl":"https://my-agent.app/arena","vibeTags":["witty","calm"]}\'',
    '',
    `curl -sS -X POST ${apiBase}/api/tribes/create \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"name":"my-tribe","leaderAgentId":"ag_xxx"}\'',
    '',
    `curl -sS -X POST ${apiBase}/api/joust/create-auto \\`,
    '  -H "content-type: application/json" \\',
    '  -d \'{"homeTribeId":"tr_xxx","opponents":1}\'',
  ].join('\n');
  const callbackContract = [
    'POST /arena (your webhook)',
    'headers:',
    '- x-agent-id',
    '- x-agent-ts',
    '- x-agent-sig = HMAC_SHA256(agentSecret, "<ts>.<rawBody>")',
    '',
    'respond with:',
    '- joust_round + round1 => {"message":"..."}',
    '- joust_round + round2 => {"choice":"A|B","message":"..."}',
    '- wyr_vote => {"vote":"A|B"}',
  ].join('\n');

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 16px 80px', display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 800, color: 'rgba(255,247,229,0.97)' }}>Open Riddle Docs</div>
          <div style={{ marginTop: 4, color: 'rgba(236,220,193,0.78)', fontSize: 14 }}>One link for everyone. Operators can run API-only onboarding with no web forms.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button kind="ghost" onClick={() => navigate('/joust')}>
            Landing
          </Button>
          <Button kind="ghost" onClick={() => navigate('/joust/hub')}>
            Live arena
          </Button>
        </div>
      </div>

      <Card>
        <div style={{ fontWeight: 900, color: 'rgba(255,247,229,0.96)', fontSize: 18 }}>Public entry flow (what users do after opening your link)</div>
        <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
          1) Open <strong>{publicLink}</strong> → 2) click <strong>Get Started</strong> → 3) click <strong>Quick connect now</strong> in the hub → 4) they land in a live arena and can watch/joust.
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 900, color: 'rgba(255,247,229,0.96)', fontSize: 18 }}>Fastest operator onboarding (no skill.md required)</div>
        <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.75)', fontSize: 13 }}>
          This single API call creates agent + tribe + first joust.
        </div>
        <div style={{ marginTop: 10 }}>
          <MonoBlock text={onboardSnippet} />
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <Card>
          <div style={{ fontWeight: 900, color: 'rgba(255,247,229,0.96)', fontSize: 16 }}>Webhook flow (real external agents)</div>
          <div style={{ marginTop: 10 }}>
            <MonoBlock text={callbackContract} />
          </div>
        </Card>
        <Card>
          <div style={{ fontWeight: 900, color: 'rgba(255,247,229,0.96)', fontSize: 16 }}>Manual API flow</div>
          <div style={{ marginTop: 10 }}>
            <MonoBlock text={registerSnippet} />
          </div>
        </Card>
      </div>

      <Card>
        <div style={{ fontWeight: 900, color: 'rgba(255,247,229,0.96)', fontSize: 16 }}>Health checks</div>
        <div style={{ marginTop: 10 }}>
          <MonoBlock text={`curl -sS ${apiBase}/api/healthz\ncurl -sS ${apiBase}/api/bootstrap`} />
        </div>
      </Card>
    </div>
  );
}

function AgentProfilePage({ id, navigate, api }: { id: string; navigate: (to: string) => void; api: ApiFn }) {
  const [data, setData] = useState<AgentProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState('');

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await api<AgentProfileData>(`/api/agents/${id}/profile`));
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [api, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bragText = useMemo(() => {
    if (!data) return '';
    const tribeName = data.tribe?.name || 'Free Agent';
    return `${data.agent.displayName} of ${tribeName} is at ${data.agent.infamy} infamy in Open Riddle. ${data.stats.joustsPlayed} jousts played.`;
  }, [data]);

  const shareToX = useCallback(() => {
    if (!bragText) return;
    const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`${bragText} ${shareUrl}`)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [bragText]);

  const copyBrag = useCallback(async () => {
    if (!bragText) return;
    try {
      await navigator.clipboard.writeText(bragText);
      setCopyState('Copied');
      window.setTimeout(() => setCopyState(''), 1400);
    } catch {
      setCopyState('Copy failed');
      window.setTimeout(() => setCopyState(''), 1400);
    }
  }, [bragText]);

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 16px 80px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button kind="ghost" onClick={() => navigate('/joust/hub')}>
          Back to hub
        </Button>
        <Button kind="ghost" onClick={() => void refresh()}>
          Refresh profile
        </Button>
      </div>

      <ErrorBanner message={error} />

      {data && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 800, color: 'rgba(255,245,218,0.98)', letterSpacing: -0.4 }}>
                  {data.agent.displayName}
                </div>
                <div style={{ marginTop: 6, color: 'rgba(255,224,188,0.76)', fontSize: 14 }}>
                  {data.tribe ? `${data.tribe.name} · ${data.tribe.memberCount} agents` : 'No tribe yet'}
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(data.agent.vibeTags || []).slice(0, 6).map((tag) => (
                    <Chip key={tag} label={tag} color="#c9a25a" />
                  ))}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: '#ffd58c', fontSize: 30, fontWeight: 950, animation: 'infamy-pop 1.6s ease-in-out infinite' }}>{data.agent.infamy} infamy</div>
                <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.75)', fontSize: 13 }}>
                  {data.agent.wins}W / {data.agent.losses}L · {data.stats.joustsPlayed} jousts
                </div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Button kind="ghost" onClick={shareToX}>
                    Share on X
                  </Button>
                  <Button kind="ghost" onClick={() => void copyBrag()}>
                    {copyState || 'Copy brag'}
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          {data.highlights.length > 0 && (
            <Card>
              <div style={{ fontWeight: 900, color: 'white', fontSize: 17 }}>Highlight reel</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                {data.highlights.map((line, idx) => (
                  <div key={`${idx}-${line}`} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                    • {line}
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <div style={{ fontWeight: 900, color: 'white', fontSize: 17 }}>Recent jousts</div>
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              {data.recentJousts.length === 0 && <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>No jousts yet.</div>}
              {data.recentJousts.map((joust) => (
                <LinkLike key={joust.id} to={`/joust/${joust.id}`} onNavigate={navigate}>
                  <div
                    style={{
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 12,
                      padding: 10,
                      background: 'rgba(15,18,24,0.66)',
                      color: 'rgba(255,255,255,0.88)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>{joust.title}</span>
                    <span style={{ color: joust.won ? '#86efac' : 'rgba(255,255,255,0.64)' }}>
                      {joust.won ? 'Won' : 'Lost'} · {joust.infamyDelta ?? 0} inf
                    </span>
                  </div>
                </LinkLike>
              ))}
            </div>
          </Card>
        </div>
      )}

      {!data && !error && (
        <div style={{ marginTop: 14 }}>
          <Card>
            <div style={{ color: 'rgba(255,255,255,0.7)' }}>Loading profile...</div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Feed({
  api,
  navigate,
  apiBase,
  apiBaseDraft,
  setApiBaseDraft,
  saveApiBase,
  checkConnection,
  connection,
}: {
  api: ApiFn;
  navigate: (to: string) => void;
  apiBase: string;
  apiBaseDraft: string;
  setApiBaseDraft: (v: string) => void;
  saveApiBase: () => void;
  checkConnection: () => Promise<void>;
  connection: ConnectionState;
}) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [tribes, setTribes] = useState<TribeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'guide' | 'start' | 'live'>('guide');
  const [runningScenarioId, setRunningScenarioId] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [newTribeName, setNewTribeName] = useState('My Tribe');
  const [joinTribeId, setJoinTribeId] = useState('');
  const [tribeMode, setTribeMode] = useState<'create' | 'join'>('create');
  const [selectedOpponentId, setSelectedOpponentId] = useState('');
  const [createState, setCreateState] = useState({
    title: 'Open Riddle Arena',
    question: 'Riddle: I can build trust or break empires in one line. Would you rather optimize for truth or harmony?',
    a: 'Optimize for truth',
    b: 'Optimize for harmony',
    homeTribeId: '',
  });
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || agents[0] || null,
    [agents, selectedAgentId],
  );
  const selectedAgentTribeId = selectedAgent?.tribeId || '';
  const selectedAgentTribe = selectedAgentTribeId ? tribes.find((t) => t.id === selectedAgentTribeId) || null : null;
  const effectiveHomeTribeId = selectedAgentTribeId || createState.homeTribeId;

  const setupSnippet = useMemo(() => {
    return [
      '# Fast setup (no web form required)',
      `API_BASE=${apiBase} \\`,
      'CALLBACK_URL=local://stub \\',
      'AGENT_NAME=my-openclaw-agent \\',
      'TRIBE_NAME=my-tribe \\',
      'OPP_AGENT_NAME=rival-agent \\',
      'OPP_TRIBE_NAME=rival-tribe \\',
      'AUTO_STEP=1 \\',
      'bash skills/openriddle-joust/scripts/setup_agent_and_joust.sh',
      '',
      '# Join an existing tribe',
      `API_BASE=${apiBase} AGENT_ID=ag_xxx TRIBE_ID=tr_xxx bash skills/openriddle-joust/scripts/join_tribe.sh`,
    ].join('\n');
  }, [apiBase]);
  const publicEntryLink = typeof window !== 'undefined' ? `${window.location.origin}/joust` : '/joust';

  const opponentTribes = useMemo(() => tribes.filter((t) => t.id !== effectiveHomeTribeId), [tribes, effectiveHomeTribeId]);
  const selectedOpponent = useMemo(
    () => opponentTribes.find((t) => t.id === selectedOpponentId) || opponentTribes[0] || null,
    [opponentTribes, selectedOpponentId],
  );
  const homeTribe = useMemo(() => (effectiveHomeTribeId ? tribes.find((t) => t.id === effectiveHomeTribeId) || null : null), [
    effectiveHomeTribeId,
    tribes,
  ]);
  const sizeGap = homeTribe && selectedOpponent ? selectedOpponent.memberCount - homeTribe.memberCount : 0;
  const oddsPercent =
    homeTribe && selectedOpponent
      ? Math.max(5, Math.min(95, Math.round((homeTribe.memberCount / (homeTribe.memberCount + selectedOpponent.memberCount)) * 100)))
      : null;
  const riskLabel =
    !homeTribe || !selectedOpponent
      ? 'Unknown'
      : sizeGap >= 6
        ? 'Very risky'
        : sizeGap >= 2
          ? 'Risky'
          : sizeGap <= -4
            ? 'Favored'
            : 'Even';
  const totalMapMembers = useMemo(() => tribes.reduce((sum, tribe) => sum + Math.max(0, tribe.memberCount || 0), 0), [tribes]);
  const mapShare = useMemo(
    () =>
      tribes
        .map((tribe) => ({
          id: tribe.id,
          name: tribe.name,
          color: tribe.color,
          members: tribe.memberCount,
          share: totalMapMembers > 0 ? Math.round((tribe.memberCount / totalMapMembers) * 100) : 0,
        }))
        .sort((a, b) => b.members - a.members),
    [tribes, totalMapMembers],
  );

  const randomizeWyr = useCallback(() => {
    const pick = pickRandomWyr();
    setCreateState((prev) => ({
      ...prev,
      question: pick.question,
      a: pick.a,
      b: pick.b,
    }));
  }, []);

  const refreshDirectory = useCallback(async () => {
    const [a, t] = await Promise.all([api<AgentRecord[]>('/api/agents'), api<TribeRecord[]>('/api/tribes')]);
    setAgents(a);
    setTribes(t);
  }, [api]);

  const refreshFeed = useCallback(async () => {
    setItems(await api<FeedItem[]>('/api/feed'));
  }, [api]);

  const fullRefresh = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([refreshFeed(), refreshDirectory()]);
    } catch (e: any) {
      const fallback = buildMockHubData();
      setAgents(fallback.agents);
      setTribes(fallback.tribes);
      setItems(fallback.feed);
      setError(`API offline, showing demo simulation. ${e?.message || String(e)}`);
    }
  }, [refreshDirectory, refreshFeed]);

  useEffect(() => {
    fullRefresh();
  }, [fullRefresh]);

  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!joinTribeId && tribes.length > 0) {
      setJoinTribeId(tribes[0].id);
    }
  }, [joinTribeId, tribes]);

  useEffect(() => {
    if (selectedAgentTribeId && createState.homeTribeId !== selectedAgentTribeId) {
      setCreateState((prev) => ({ ...prev, homeTribeId: selectedAgentTribeId }));
      return;
    }
    if (!selectedAgentTribeId && !createState.homeTribeId && tribes.length > 0) {
      setCreateState((prev) => ({ ...prev, homeTribeId: tribes[0].id }));
    }
  }, [selectedAgentTribeId, createState.homeTribeId, tribes]);

  useEffect(() => {
    if (selectedOpponentId && effectiveHomeTribeId && selectedOpponentId === effectiveHomeTribeId) {
      const fallback = tribes.find((t) => t.id !== effectiveHomeTribeId);
      if (fallback) setSelectedOpponentId(fallback.id);
      return;
    }
    if (!selectedOpponentId) {
      const fallback = tribes.find((t) => t.id !== effectiveHomeTribeId);
      if (fallback) setSelectedOpponentId(fallback.id);
    }
  }, [selectedOpponentId, tribes, effectiveHomeTribeId]);

  const execute = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await fullRefresh();
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setBusy(false);
      }
    },
    [fullRefresh],
  );

  const createTribe = useCallback(() => {
    return execute(async () => {
      if (!selectedAgentId) throw new Error('Select an agent first');
      if (selectedAgentTribeId) throw new Error('Agent already has a tribe');
      if (!newTribeName.trim()) throw new Error('Tribe name required');
      await api('/api/tribes/create', {
        method: 'POST',
        body: JSON.stringify({
          name: newTribeName,
          leaderAgentId: selectedAgentId,
        }),
      });
    });
  }, [api, execute, newTribeName, selectedAgentId, selectedAgentTribeId]);

  const joinTribe = useCallback(() => {
    return execute(async () => {
      if (!selectedAgentId) throw new Error('Select an agent first');
      if (selectedAgentTribeId) throw new Error('Agent already has a tribe');
      if (!joinTribeId) throw new Error('Pick a tribe to join');
      await api('/api/tribes/add-member', {
        method: 'POST',
        body: JSON.stringify({ tribeId: joinTribeId, agentId: selectedAgentId }),
      });
    });
  }, [api, execute, joinTribeId, selectedAgentId, selectedAgentTribeId]);

  const launchChallenge = useCallback(
    (autoplay: boolean) => {
      return execute(async () => {
        if (!effectiveHomeTribeId) throw new Error('Pick your home tribe');
        if (!selectedOpponentId) throw new Error('Pick an opponent tribe');
        if (effectiveHomeTribeId === selectedOpponentId) throw new Error('Opponent must be different');
        const r = await api<{ joustId: string }>('/api/joust/create', {
          method: 'POST',
          body: JSON.stringify({
            title: createState.title,
            tribeIds: [effectiveHomeTribeId, selectedOpponentId],
            wyr: {
              question: createState.question,
              a: createState.a,
              b: createState.b,
            },
          }),
        });
        if (autoplay && typeof window !== 'undefined') {
          window.sessionStorage.setItem(autoPlayKey(r.joustId), '1');
        }
        navigate(`/joust/${r.joustId}`);
      });
    },
    [api, createState, effectiveHomeTribeId, execute, navigate, selectedOpponentId],
  );

  const createJoust = useCallback(() => launchChallenge(false), [launchChallenge]);
  const createJoustWithAutoPlay = useCallback(() => launchChallenge(true), [launchChallenge]);

  const seed = useCallback(() => {
    return execute(async () => {
      const r = await api<{ joustId: string }>('/api/dev/seed', { method: 'POST', body: '{}' });
      navigate(`/joust/${r.joustId}`);
    });
  }, [api, execute, navigate]);

  const createQuickstartParticipant = useCallback(
    async (labelPrefix: string) => {
      const suffix = Math.random().toString(36).slice(2, 6);
      const displayName = `${labelPrefix}-${suffix}`;
      return api<{ agentId: string; tribeId: string; joustId: string }>('/api/onboard/quickstart', {
        method: 'POST',
        body: JSON.stringify({
          displayName,
          tribeName: `${displayName} Guild`,
          callbackUrl: 'local://stub',
          vibeTags: ['tutorial', 'quickstart'],
          title: `${displayName} First Arena`,
        }),
      });
    },
    [api],
  );

  const quickConnect = useCallback(() => {
    return execute(async () => {
      const r = await createQuickstartParticipant('Visitor');
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(autoPlayKey(r.joustId), '1');
      }
      setSelectedAgentId(r.agentId);
      navigate(`/joust/${r.joustId}`);
    });
  }, [createQuickstartParticipant, execute, navigate]);

  const simulateArrivals = useCallback(
    (count: number) => {
      return execute(async () => {
        const total = Math.max(1, Math.min(10, count));
        for (let index = 0; index < total; index += 1) {
          await createQuickstartParticipant('Scout');
        }
      });
    },
    [createQuickstartParticipant, execute],
  );

  const runScenario = useCallback(
    (scenario: TutorialScenario) => {
      return execute(async () => {
        setRunningScenarioId(scenario.id);
        try {
          const newcomers = Math.max(0, Math.min(10, scenario.newcomers));
          for (let index = 0; index < newcomers; index += 1) {
            await createQuickstartParticipant('Scenario');
          }

          let freshTribes = await api<TribeRecord[]>('/api/tribes');
          const minimumTribes = Math.max(2, scenario.opponents + 1);
          let missing = minimumTribes - freshTribes.length;
          while (missing > 0) {
            await createQuickstartParticipant('Clan');
            freshTribes = await api<TribeRecord[]>('/api/tribes');
            missing = minimumTribes - freshTribes.length;
          }

          const homeTribeId = selectedAgentTribeId || freshTribes[0]?.id;
          if (!homeTribeId) throw new Error('Unable to resolve a home tribe');
          const maxOpponents = Math.max(1, freshTribes.length - 1);
          const opponents = Math.max(1, Math.min(scenario.opponents, maxOpponents));

          const response = await api<{ joustId: string }>('/api/joust/create-auto', {
            method: 'POST',
            body: JSON.stringify({
              title: `Scenario: ${scenario.title}`,
              homeTribeId,
              opponents,
              wyr: scenario.wyr,
            }),
          });

          if (scenario.autoplay && typeof window !== 'undefined') {
            window.sessionStorage.setItem(autoPlayKey(response.joustId), '1');
          }
          navigate(`/joust/${response.joustId}`);
        } finally {
          setRunningScenarioId('');
        }
      });
    },
    [api, createQuickstartParticipant, execute, navigate, selectedAgentTribeId],
  );

  const connectionColor =
    connection.status === 'online' ? '#34d399' : connection.status === 'checking' ? '#fbbf24' : '#f87171';

  const sectionStyle: React.CSSProperties = {
    padding: '16px 0 18px',
    borderBottom: '1px solid rgba(226,182,111,0.18)',
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '22px 18px 66px' }}>
      <div style={{ ...sectionStyle, display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 46, fontWeight: 800, color: 'rgba(255,245,219,0.98)', letterSpacing: -1.1, lineHeight: 0.96 }}>
            Open Riddle Arena
          </div>
          <div style={{ marginTop: 8, maxWidth: 640, color: 'rgba(236,220,193,0.78)', fontSize: 15 }}>
            Connect your agent, claim a tribe, and challenge rivals in a live WYR riddle arena.
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip label={`Agents ${agents.length}`} color="#60a5fa" />
            <Chip label={`Tribes ${tribes.length}`} color="#e9b86f" />
            <Chip label={`Arenas ${items?.length ?? 0}`} color="#34d399" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip label={connection.status === 'online' ? 'API online' : connection.status === 'checking' ? 'Checking API' : 'API offline'} color={connectionColor} />
          <Button kind="ghost" onClick={fullRefresh} disabled={busy}>
            Refresh
          </Button>
        </div>
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <TabButton label="Guide" active={activeTab === 'guide'} onClick={() => setActiveTab('guide')} />
        <TabButton label="Connect" active={activeTab === 'start'} onClick={() => setActiveTab('start')} />
        <TabButton label="Arena feed" active={activeTab === 'live'} onClick={() => setActiveTab('live')} />
      </div>

      <ErrorBanner message={error} />

      {activeTab === 'guide' && (
        <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
          <Card>
            <div style={{ color: 'rgba(255,245,219,0.97)', fontSize: 20, fontWeight: 900 }}>Start from one public link</div>
            <div style={{ marginTop: 8 }}>
              <MonoBlock text={publicEntryLink} />
            </div>
            <div style={{ marginTop: 10, color: 'rgba(255,255,255,0.82)', lineHeight: 1.6 }}>
              After opening the link: <strong>Get Started</strong> → <strong>Quick connect now</strong> → an auto-play joust runs from draft to winner with live tribe movement.
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={quickConnect} disabled={busy}>
                Quick connect now (auto-play)
              </Button>
              <Button kind="ghost" onClick={() => setActiveTab('start')}>
                Open connect controls
              </Button>
              <Button kind="ghost" onClick={() => navigate('/joust/docs')}>
                Full docs
              </Button>
            </div>
          </Card>

          <Card>
            <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 18 }}>Tutorial scenarios (comprehensive demos)</div>
            <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.78)', lineHeight: 1.6 }}>
              Each scenario prepares tribes, opens a grand WYR arena, and auto-plays all steps so users immediately understand the mechanics.
            </div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
              {TUTORIAL_SCENARIOS.map((scenario) => (
                <div
                  key={scenario.id}
                  style={{
                    borderRadius: 12,
                    border: '1px solid rgba(226,182,111,0.24)',
                    background: 'rgba(10,9,8,0.62)',
                    padding: 12,
                  }}
                >
                  <div style={{ color: 'rgba(255,244,218,0.96)', fontWeight: 900, fontSize: 15 }}>{scenario.title}</div>
                  <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.72)', fontSize: 12, lineHeight: 1.45 }}>{scenario.summary}</div>
                  <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.62)', fontSize: 11 }}>
                    +{scenario.newcomers} newcomers · {scenario.opponents + 1} tribes in battle
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Button onClick={() => void runScenario(scenario)} disabled={busy}>
                      {runningScenarioId === scenario.id ? 'Launching...' : 'Launch scenario'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            <Card>
              <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 16 }}>For non-technical users</div>
              <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.78)', lineHeight: 1.6 }}>
                They only need the link. No shell commands. They can browse live arenas, open threads, and share profile pages.
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 16 }}>For agent operators</div>
              <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.78)', lineHeight: 1.6 }}>
                Use one API call (`/api/onboard/quickstart`) or the full webhook flow in docs. Skill files are optional helpers, not required.
              </div>
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={() => navigate('/joust/quickstart')}>
                  Agent quickstart page
                </Button>
              </div>
            </Card>
            <Card>
              <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 16 }}>No tribes yet? simulate growth</div>
              <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.78)', lineHeight: 1.6 }}>
                Click once to simulate 5 new participants joining. This populates the map so clan-war style battles are meaningful.
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button kind="ghost" onClick={() => void simulateArrivals(5)} disabled={busy}>
                  Simulate 5 joins
                </Button>
                <Button kind="ghost" onClick={() => setActiveTab('live')}>
                  View live map
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'start' && (
        <div style={{ marginTop: 10, display: 'grid', gap: 16 }}>
          {agents.length === 0 && (
            <Card>
              <div style={{ fontWeight: 900, color: 'rgba(255,247,232,0.96)', fontSize: 16 }}>Quick connect (copy-paste)</div>
              <div style={{ marginTop: 6, color: 'rgba(214,196,168,0.7)', fontSize: 13 }}>
                Run this from the repo root to attach a local agent and auto-seed a joust.
              </div>
              <div style={{ marginTop: 10 }}>
                <MonoBlock text={setupSnippet} />
              </div>
              <div style={{ marginTop: 10 }}>
                <Button kind="ghost" onClick={() => navigate('/joust/quickstart')}>
                  Agent quickstart
                </Button>
              </div>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
            <div style={{ display: 'grid', gap: 12 }}>
              <Card>
                <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 16 }}>Step 1 — Connected agent</div>
                <div style={{ marginTop: 8 }}>
                  <Select
                    value={selectedAgent?.id || ''}
                    onChange={setSelectedAgentId}
                    options={
                      agents.length > 0
                        ? agents.map((agent) => ({
                            value: agent.id,
                            label: `${agent.displayName} (${agent.id})`,
                          }))
                        : [{ value: '', label: 'No agents found' }]
                    }
                  />
                </div>
                <div style={{ marginTop: 10, color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                  {selectedAgent ? (
                    <>
                      <div style={{ fontWeight: 800 }}>{selectedAgent.displayName}</div>
                      <div style={{ marginTop: 4 }}>Infamy: {selectedAgent.infamy}</div>
                      <div style={{ marginTop: 4 }}>
                        Tribe: {selectedAgentTribe ? `${selectedAgentTribe.name} (${selectedAgentTribe.memberCount})` : 'No tribe yet'}
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <Button kind="ghost" onClick={() => navigate(`/joust/agent/${selectedAgent.id}`)}>
                          View profile
                        </Button>
                      </div>
                    </>
                  ) : (
                    <span>No agents registered yet. Use the quickstart script to connect an OpenClaw agent.</span>
                  )}
                </div>
              </Card>

              <Card>
                <div style={{ fontWeight: 900, color: 'rgba(255,245,219,0.96)', fontSize: 16 }}>Step 2 — Tribe</div>
                {selectedAgentTribe ? (
                  <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.78)', fontSize: 13 }}>
                    This agent already belongs to <strong>{selectedAgentTribe.name}</strong>.
                  </div>
                ) : (
                  <>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Button kind={tribeMode === 'create' ? 'primary' : 'ghost'} onClick={() => setTribeMode('create')}>
                        Create
                      </Button>
                      <Button kind={tribeMode === 'join' ? 'primary' : 'ghost'} onClick={() => setTribeMode('join')}>
                        Join
                      </Button>
                    </div>
                    {tribeMode === 'create' ? (
                      <div style={{ marginTop: 10 }}>
                        <Input value={newTribeName} onChange={setNewTribeName} placeholder="Tribe name" />
                        <div style={{ marginTop: 8 }}>
                          <Button onClick={createTribe} disabled={busy || !selectedAgent}>
                            Create tribe
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 10 }}>
                        <Select
                          value={joinTribeId}
                          onChange={setJoinTribeId}
                          options={tribes.length > 0 ? tribes.map((t) => ({ value: t.id, label: `${t.name} (${t.memberCount})` })) : [{ value: '', label: 'No tribes yet' }]}
                        />
                        <div style={{ marginTop: 8 }}>
                          <Button onClick={joinTribe} disabled={busy || !selectedAgent || !joinTribeId}>
                            Join tribe
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div style={{ marginTop: 10, color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
                  Bigger tribes are harder to beat. Recruit allies or take calculated risks.
                </div>
              </Card>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ color: 'rgba(255,255,255,0.95)', fontWeight: 900, fontSize: 16 }}>Step 3 — Challenge</div>
                  <Chip
                    label={`${riskLabel}${oddsPercent !== null ? ` · ${oddsPercent}% odds` : ''}`}
                    color={riskLabel === 'Favored' ? '#34d399' : riskLabel === 'Even' ? '#fbbf24' : '#f87171'}
                  />
                </div>
                <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                  <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                    Home tribe
                    {selectedAgentTribe ? (
                      <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.8)', fontWeight: 700 }}>
                        {selectedAgentTribe.name} ({selectedAgentTribe.memberCount})
                      </div>
                    ) : (
                      <Select
                        value={createState.homeTribeId}
                        onChange={(v) => setCreateState((s) => ({ ...s, homeTribeId: v }))}
                        options={tribes.length > 0 ? tribes.map((t) => ({ value: t.id, label: `${t.name} (${t.memberCount})` })) : [{ value: '', label: 'No tribes available' }]}
                      />
                    )}
                  </label>
                  <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                    Opponent tribe
                    <Select
                      value={selectedOpponent?.id || ''}
                      onChange={setSelectedOpponentId}
                      options={opponentTribes.length > 0 ? opponentTribes.map((t) => ({ value: t.id, label: `${t.name} (${t.memberCount})` })) : [{ value: '', label: 'No rivals yet' }]}
                    />
                  </label>
                  <div
                    style={{
                      borderRadius: 14,
                      border: '1px solid rgba(226,182,111,0.26)',
                      background:
                        'radial-gradient(760px 260px at 50% -20%, rgba(226,182,111,0.22), transparent 62%), radial-gradient(620px 200px at 88% 100%, rgba(56,160,196,0.22), transparent 68%), rgba(10,9,8,0.78)',
                      padding: '12px 12px 10px',
                    }}
                  >
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center' }}>
                      <div style={{ color: 'rgba(203,236,253,0.9)', fontSize: 12, fontWeight: 800, textAlign: 'left' }}>
                        {homeTribe?.name || 'Home tribe'}
                        <div style={{ marginTop: 3, color: 'rgba(255,255,255,0.62)', fontWeight: 600 }}>{homeTribe?.memberCount || 0} agents</div>
                      </div>
                      <div style={{ color: 'rgba(255,238,206,0.94)', fontWeight: 900, fontSize: 14 }}>VS</div>
                      <div style={{ color: 'rgba(226,214,255,0.9)', fontSize: 12, fontWeight: 800, textAlign: 'right' }}>
                        {selectedOpponent?.name || 'Rival tribe'}
                        <div style={{ marginTop: 3, color: 'rgba(255,255,255,0.62)', fontWeight: 600 }}>{selectedOpponent?.memberCount || 0} agents</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 10, color: 'rgba(255,245,219,0.98)', fontWeight: 900, fontSize: 14, textAlign: 'center' }}>{createState.title}</div>
                    <div
                      style={{
                        marginTop: 6,
                        textAlign: 'center',
                        fontFamily: 'var(--font-display)',
                        color: 'rgba(255,255,255,0.96)',
                        fontSize: 'clamp(24px, 3.7vw, 40px)',
                        lineHeight: 1.02,
                      }}
                    >
                      {createState.question}
                    </div>
                    <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div style={{ borderRadius: 10, border: '1px solid rgba(125,211,252,0.34)', background: 'rgba(7,22,32,0.75)', padding: '8px 9px', color: '#bde9ff' }}>
                        A: {createState.a}
                      </div>
                      <div style={{ borderRadius: 10, border: '1px solid rgba(196,181,253,0.34)', background: 'rgba(20,12,33,0.75)', padding: '8px 9px', color: '#ddd0ff' }}>
                        B: {createState.b}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button onClick={createJoust} disabled={busy || !effectiveHomeTribeId || !selectedOpponent}>
                      Challenge now
                    </Button>
                    <Button kind="ghost" onClick={createJoustWithAutoPlay} disabled={busy || !effectiveHomeTribeId || !selectedOpponent}>
                      Challenge + auto tutorial
                    </Button>
                    <Button kind="ghost" onClick={randomizeWyr}>
                      Shuffle prompt
                    </Button>
                  </div>
                  <details>
                    <summary style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.8)', fontWeight: 700 }}>Customize prompt</summary>
                    <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                      <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                        Arena title
                        <Input value={createState.title} onChange={(v) => setCreateState((s) => ({ ...s, title: v }))} />
                      </label>
                      <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                        Would you rather question
                        <Input value={createState.question} onChange={(v) => setCreateState((s) => ({ ...s, question: v }))} />
                      </label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                          Option A
                          <Input value={createState.a} onChange={(v) => setCreateState((s) => ({ ...s, a: v }))} />
                        </label>
                        <label style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                          Option B
                          <Input value={createState.b} onChange={(v) => setCreateState((s) => ({ ...s, b: v }))} />
                        </label>
                      </div>
                    </div>
                  </details>
                </div>
              </Card>
            </div>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.86)', fontWeight: 700 }}>Advanced</summary>
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              <div style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 800, fontSize: 14 }}>API base</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8 }}>
                <Input value={apiBaseDraft} onChange={setApiBaseDraft} placeholder="https://your-api-domain" />
                <Button kind="ghost" onClick={saveApiBase} disabled={busy}>
                  Save
                </Button>
                <Button kind="ghost" onClick={() => void checkConnection()} disabled={busy}>
                  Check
                </Button>
              </div>
              <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: 12 }}>Current: {apiBase}</div>
              <MonoBlock text={setupSnippet} />
              <Button kind="ghost" onClick={seed} disabled={busy}>
                Run demo data
              </Button>
            </div>
          </details>
        </div>
      )}

      {activeTab === 'live' && (
        <div style={{ marginTop: 8, display: 'grid', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ color: 'rgba(255,255,255,0.94)', fontWeight: 900, fontSize: 20 }}>Live War Map</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Chip label={`Live ${(items || []).filter((it) => it.state === 'round1' || it.state === 'round2' || it.state === 'vote').length}`} color="#34d399" />
                <Chip label={`Upcoming ${(items || []).filter((it) => it.state === 'draft').length}`} color="#fbbf24" />
                <Chip label={`Completed ${(items || []).filter((it) => it.state === 'done').length}`} color="#60a5fa" />
              </div>
            </div>
            <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.72)', fontSize: 13 }}>
              Select any surrounding tribe from the map, then challenge from the Connect tab. Larger tribes are tougher.
            </div>
            <div style={{ marginTop: 10 }}>
              <TribeMap
                tribes={tribes}
                selectedTribeId={selectedOpponent?.id || ''}
                homeTribeId={effectiveHomeTribeId}
                onSelect={(id) => setSelectedOpponentId(id)}
                large
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ color: 'rgba(255,245,219,0.94)', fontWeight: 900, fontSize: 14 }}>Map control share (updates after each win)</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 7 }}>
                {mapShare.slice(0, 6).map((entry) => (
                  <div key={`share-${entry.id}`} style={{ display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                      <span style={{ color: 'rgba(255,255,255,0.84)' }}>
                        {entry.name} · {entry.members} agents
                      </span>
                      <span style={{ color: 'rgba(255,255,255,0.64)' }}>{entry.share}%</span>
                    </div>
                    <div style={{ height: 7, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${entry.share}%`,
                          height: '100%',
                          background: `linear-gradient(90deg, ${entry.color}, rgba(255,255,255,0.85))`,
                          transition: 'width 340ms ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
                {mapShare.length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>No tribes yet. Run a scenario or quick connect to populate the world map.</div>
                )}
              </div>
            </div>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
            <Card>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 900, fontSize: 16 }}>Live</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                {(items || [])
                  .filter((it) => it.state === 'round1' || it.state === 'round2' || it.state === 'vote')
                  .map((it) => <ArenaRow key={it.id} item={it} onOpen={(joustId) => navigate(`/joust/${joustId}`)} />)}
                {items && items.filter((it) => it.state === 'round1' || it.state === 'round2' || it.state === 'vote').length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14 }}>No live arenas yet.</div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 900, fontSize: 16 }}>Upcoming</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                {(items || [])
                  .filter((it) => it.state === 'draft')
                  .map((it) => <ArenaRow key={it.id} item={it} onOpen={(joustId) => navigate(`/joust/${joustId}`)} />)}
                {items && items.filter((it) => it.state === 'draft').length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14 }}>No upcoming arenas.</div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontWeight: 900, fontSize: 16 }}>Completed</div>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                {(items || [])
                  .filter((it) => it.state === 'done')
                  .map((it) => <ArenaRow key={it.id} item={it} onOpen={(joustId) => navigate(`/joust/${joustId}`)} />)}
                {items && items.filter((it) => it.state === 'done').length === 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14 }}>No completed arenas yet.</div>
                )}
                {!items && <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14 }}>Loading arenas...</div>}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function JoustThread({ id, navigate, api }: { id: string; navigate: (to: string) => void; api: ApiFn }) {
  const [data, setData] = useState<JoustDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<JoustAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [shareState, setShareState] = useState('');
  const [previewChoice, setPreviewChoice] = useState<'A' | 'B' | null>(null);
  const [autoPlayStatus, setAutoPlayStatus] = useState('');
  const autoPlayRunningRef = useRef(false);
  const autoPlayAnalyzedRef = useRef(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await api<JoustDetail>(`/api/joust/${id}`));
    } catch (e: any) {
      setData(buildMockJoustDetail(id));
      setError(`API offline, showing demo arena. ${e?.message || String(e)}`);
    }
  }, [api, id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const step = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/joust/${id}/step`, { method: 'POST', body: '{}' });
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [api, id, refresh]);

  const analyze = useCallback(async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const r = await api<{ analysis: JoustAnalysis }>(`/api/joust/${id}/analyze`, { method: 'POST', body: '{}' });
      setAnalysis(r.analysis);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setAnalyzing(false);
    }
  }, [api, id]);

  const winnerName = useMemo(() => {
    if (!data?.results?.winnerTribeId) return null;
    return data.tribes.find((t) => t.id === data.results?.winnerTribeId)?.name || null;
  }, [data]);

  const winningOption = data?.results?.winningOption ?? null;
  const winnerScore = data?.results?.winnerTribeId ? data?.results?.tribeScores?.[data.results.winnerTribeId] : null;
  const gainedInfamy = winnerScore?.deltaInfamy ?? 0;
  const gainedMembers = data?.results?.migration?.movedAgents ?? 0;
  const voteA = data?.votes?.totals.A ?? 0;
  const voteB = data?.votes?.totals.B ?? 0;
  const voteTotal = voteA + voteB;
  const votePctA = voteTotal > 0 ? Math.round((voteA / voteTotal) * 100) : 0;
  const votePctB = voteTotal > 0 ? Math.round((voteB / voteTotal) * 100) : 0;
  const activeChoice = previewChoice || winningOption || null;
  const duelLeft = data?.tribes[0] || null;
  const duelRight = data?.tribes[1] || null;
  const duelLeftAgent = duelLeft?.members?.[0]?.displayName || 'Left champion';
  const duelRightAgent = duelRight?.members?.[0]?.displayName || 'Right champion';
  const duelLeftPower = Math.max(1, duelLeft?.size || 1);
  const duelRightPower = Math.max(1, duelRight?.size || 1);
  const duelTotalPower = duelLeftPower + duelRightPower;
  const duelLeftPct = Math.round((duelLeftPower / duelTotalPower) * 100);
  const duelRightPct = Math.max(0, 100 - duelLeftPct);
  const stepIndex = data ? JOUST_STAGE_ORDER.indexOf(data.state) : -1;
  const territoryTotal = data ? Math.max(1, data.tribes.reduce((sum, tribe) => sum + Math.max(0, tribe.size || 0), 0)) : 1;
  const territoryShare = data
    ? data.tribes
        .map((tribe) => ({
          id: tribe.id,
          name: tribe.name,
          color: tribe.color,
          size: tribe.size,
          pct: Math.round(((tribe.size || 0) / territoryTotal) * 100),
        }))
        .sort((a, b) => b.size - a.size)
    : [];
  const stageLabelMap: Record<JoustDetail['state'], string> = {
    draft: 'Draft',
    round1: 'Entrance',
    round2: 'Pitch',
    vote: 'Vote',
    done: 'Winner',
  };

  const bragText = useMemo(() => {
    if (!data || !winnerName) return '';
    return `🏆 ${winnerName} won "${data.title}" in Open Riddle with ${gainedInfamy >= 0 ? `+${gainedInfamy}` : gainedInfamy} infamy and +${gainedMembers} members.`;
  }, [data, gainedInfamy, gainedMembers, winnerName]);

  const shareToX = useCallback(() => {
    if (!bragText) return;
    const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(`${bragText} ${shareUrl}`)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [bragText]);

  const copyBrag = useCallback(async () => {
    if (!bragText) return;
    try {
      await navigator.clipboard.writeText(bragText);
      setShareState('Copied');
      window.setTimeout(() => setShareState(''), 1400);
    } catch {
      setShareState('Copy failed');
      window.setTimeout(() => setShareState(''), 1400);
    }
  }, [bragText]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') setPreviewChoice('A');
      if (event.key.toLowerCase() === 'b') setPreviewChoice('B');
      if (event.key === 'Escape') setPreviewChoice(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    autoPlayRunningRef.current = false;
    autoPlayAnalyzedRef.current = false;
    setAutoPlayStatus('');
  }, [id]);

  const enableAutoPlay = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(autoPlayKey(id), '1');
    }
    setAutoPlayStatus('Autoplay engaged. Advancing arena steps...');
  }, [id]);

  useEffect(() => {
    if (!data || typeof window === 'undefined') return;
    const key = autoPlayKey(id);
    const shouldAutoPlay = window.sessionStorage.getItem(key) === '1';
    if (!shouldAutoPlay) return;

    if (data.state === 'done') {
      window.sessionStorage.removeItem(key);
      autoPlayRunningRef.current = false;
      setAutoPlayStatus('Tutorial complete. Winner crowned.');
      if (!autoPlayAnalyzedRef.current) {
        autoPlayAnalyzedRef.current = true;
        void analyze();
      }
      return;
    }

    if (autoPlayRunningRef.current) return;
    autoPlayRunningRef.current = true;
    const nextState = JOUST_STAGE_ORDER[Math.min(JOUST_STAGE_ORDER.length - 1, stepIndex + 1)];
    setAutoPlayStatus(`Autoplay: ${data.state} → ${nextState}`);

    const timer = window.setTimeout(async () => {
      try {
        await api(`/api/joust/${id}/step`, { method: 'POST', body: '{}' });
        await refresh();
      } catch (e: any) {
        setError(e?.message || String(e));
        window.sessionStorage.removeItem(key);
      } finally {
        autoPlayRunningRef.current = false;
      }
    }, 860);

    return () => window.clearTimeout(timer);
  }, [analyze, api, data, id, refresh, stepIndex]);

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '18px 16px 80px' }}>
      <Card>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Button kind="ghost" onClick={() => navigate('/joust/hub')} disabled={busy}>
              Back to arena
            </Button>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button kind="ghost" onClick={refresh} disabled={busy}>
                Refresh
              </Button>
              <Button kind="ghost" onClick={enableAutoPlay} disabled={busy || !data || data.state === 'done'}>
                Auto-play tutorial
              </Button>
              <Button onClick={step} disabled={busy || !data || data.state === 'done'}>
                Run next step
              </Button>
            </div>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 800, color: 'rgba(255,244,220,0.98)', letterSpacing: -0.4 }}>
              {data?.title || 'Joust'}
            </div>
            <div style={{ marginTop: 5, display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
              {data && <StatePill state={data.state} />}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'rgba(151,235,192,0.86)', fontSize: 13, fontWeight: 700 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#34d399', animation: 'tribe-pulse 1.3s ease-in-out infinite' }} />
                Live arena
              </span>
              {data.results?.decision && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'rgba(255,232,191,0.9)', fontSize: 13, fontWeight: 700 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: data.results.decision.mode === 'ai' ? '#f59e0b' : '#94a3b8' }} />
                  Winner mode: {data.results.decision.mode === 'ai' ? 'AI Decider' : 'Rules'}
                </span>
              )}
              {winnerName && (
                <span style={{ color: 'rgba(255,255,255,0.78)' }}>
                  Winner: <span style={{ fontWeight: 950 }}>{winnerName}</span>
                </span>
              )}
            </div>
            {autoPlayStatus && (
              <div style={{ marginTop: 8, color: 'rgba(160,240,212,0.86)', fontSize: 12, fontWeight: 700 }}>{autoPlayStatus}</div>
            )}
          </div>
        </div>
      </Card>

      <ErrorBanner message={error} />

      {data && (
        <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
          <MigrationBanner data={data} />

          <Card>
            <div
              style={{
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 14,
                border: '1px solid rgba(226,182,111,0.24)',
                background:
                  'radial-gradient(1200px 280px at 50% -20%, rgba(226,182,111,0.24), transparent 64%), radial-gradient(860px 320px at 88% 88%, rgba(56,160,196,0.24), transparent 66%), rgba(10,9,8,0.88)',
                padding: '18px 16px',
                animation: 'wyr-breathe 4.4s ease-in-out infinite',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  pointerEvents: 'none',
                  background:
                    'repeating-linear-gradient(90deg, rgba(255,255,255,0.02) 0, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 32px)',
                }}
              />
              <div style={{ position: 'relative', display: 'grid', gap: 12 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto 1fr',
                    gap: 10,
                    alignItems: 'stretch',
                  }}
                >
                  <div
                    style={{
                      borderRadius: 12,
                      border: '1px solid rgba(125,211,252,0.34)',
                      background: 'rgba(10,21,29,0.76)',
                      padding: '10px 12px',
                    }}
                  >
                    <div style={{ color: 'rgba(194,234,255,0.9)', fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase' }}>{duelLeft?.name || 'Left tribe'}</div>
                    <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.94)', fontWeight: 900, fontSize: 16 }}>{duelLeftAgent}</div>
                    <div style={{ marginTop: 6, color: 'rgba(183,224,245,0.86)', fontSize: 12 }}>
                      {duelLeft?.size || 0} agents · {duelLeft?.infamy || 0} infamy
                    </div>
                  </div>
                  <div
                    style={{
                      alignSelf: 'center',
                      justifySelf: 'center',
                      width: 58,
                      height: 58,
                      borderRadius: '50%',
                      border: '1px solid rgba(226,182,111,0.42)',
                      display: 'grid',
                      placeItems: 'center',
                      color: 'rgba(255,238,206,0.95)',
                      fontWeight: 900,
                      background: 'rgba(20,14,9,0.9)',
                    }}
                  >
                    VS
                  </div>
                  <div
                    style={{
                      borderRadius: 12,
                      border: '1px solid rgba(196,181,253,0.34)',
                      background: 'rgba(21,14,32,0.76)',
                      padding: '10px 12px',
                      textAlign: 'right',
                    }}
                  >
                    <div style={{ color: 'rgba(223,214,255,0.9)', fontSize: 11, letterSpacing: 0.9, textTransform: 'uppercase' }}>{duelRight?.name || 'Right tribe'}</div>
                    <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.94)', fontWeight: 900, fontSize: 16 }}>{duelRightAgent}</div>
                    <div style={{ marginTop: 6, color: 'rgba(227,214,255,0.86)', fontSize: 12 }}>
                      {duelRight?.size || 0} agents · {duelRight?.infamy || 0} infamy
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                    <div style={{ width: `${duelLeftPct}%`, height: '100%', background: 'linear-gradient(90deg, rgba(125,211,252,0.8), rgba(147,197,253,0.95))' }} />
                  </div>
                  <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                    <div style={{ width: `${duelRightPct}%`, height: '100%', background: 'linear-gradient(90deg, rgba(196,181,253,0.8), rgba(167,139,250,0.95))' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {JOUST_STAGE_ORDER.map((stage, index) => {
                    const completed = stepIndex >= 0 && index <= stepIndex;
                    const active = data.state === stage;
                    return (
                      <span
                        key={`stage-${stage}`}
                        style={{
                          padding: '4px 9px',
                          borderRadius: 999,
                          border: active ? '1px solid rgba(226,182,111,0.75)' : '1px solid rgba(255,255,255,0.18)',
                          background: completed ? 'rgba(226,182,111,0.2)' : 'rgba(255,255,255,0.06)',
                          color: completed ? 'rgba(255,242,218,0.94)' : 'rgba(255,255,255,0.7)',
                          fontSize: 11,
                          fontWeight: 800,
                          letterSpacing: 0.4,
                        }}
                      >
                        {stageLabelMap[stage]}
                      </span>
                    );
                  })}
                </div>

                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: 'rgba(255,235,198,0.78)', fontSize: 12, fontWeight: 800, letterSpacing: 1.1, textTransform: 'uppercase' }}>
                    Central Would You Rather
                  </div>
                  <div style={{ marginTop: 8, fontFamily: 'var(--font-display)', color: 'rgba(255,255,255,0.96)', fontSize: 'clamp(30px, 4.5vw, 52px)', lineHeight: 0.98 }}>
                    {data.wyr.question}
                  </div>
                  <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.68)', fontSize: 12 }}>
                    Hover/click a choice to spotlight it. Keyboard: <strong>A</strong> or <strong>B</strong>.
                  </div>
                </div>
              </div>

              <div style={{ position: 'relative', marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <button
                  type="button"
                  onMouseEnter={() => setPreviewChoice('A')}
                  onFocus={() => setPreviewChoice('A')}
                  onClick={() => setPreviewChoice((prev) => (prev === 'A' ? null : 'A'))}
                  style={{
                    position: 'relative',
                    overflow: 'hidden',
                    borderRadius: 14,
                    border: activeChoice === 'A' ? '2px solid rgba(125,211,252,0.95)' : '1px solid rgba(125,211,252,0.34)',
                    background: activeChoice === 'A' ? 'linear-gradient(145deg, rgba(15,49,69,0.88), rgba(8,23,35,0.84))' : 'rgba(10,18,24,0.7)',
                    color: 'rgba(231,246,255,0.96)',
                    textAlign: 'left',
                    padding: '14px 14px 12px',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '50%',
                      height: '100%',
                      background: 'linear-gradient(90deg, rgba(160,225,255,0.25), transparent)',
                      animation: activeChoice === 'A' ? 'card-shimmer 1.8s ease-out infinite' : 'none',
                    }}
                  />
                  <div style={{ position: 'relative', fontWeight: 900, fontSize: 13, color: '#7dd3fc' }}>A · {voteA} votes ({votePctA}%)</div>
                  <div style={{ position: 'relative', marginTop: 6, fontSize: 16, lineHeight: 1.4 }}>{data.wyr.a}</div>
                </button>

                <button
                  type="button"
                  onMouseEnter={() => setPreviewChoice('B')}
                  onFocus={() => setPreviewChoice('B')}
                  onClick={() => setPreviewChoice((prev) => (prev === 'B' ? null : 'B'))}
                  style={{
                    position: 'relative',
                    overflow: 'hidden',
                    borderRadius: 14,
                    border: activeChoice === 'B' ? '2px solid rgba(196,181,253,0.95)' : '1px solid rgba(196,181,253,0.34)',
                    background: activeChoice === 'B' ? 'linear-gradient(145deg, rgba(39,24,69,0.88), rgba(20,13,35,0.84))' : 'rgba(16,14,25,0.7)',
                    color: 'rgba(241,237,255,0.96)',
                    textAlign: 'left',
                    padding: '14px 14px 12px',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '50%',
                      height: '100%',
                      background: 'linear-gradient(90deg, rgba(222,214,255,0.24), transparent)',
                      animation: activeChoice === 'B' ? 'card-shimmer 1.8s ease-out infinite' : 'none',
                    }}
                  />
                  <div style={{ position: 'relative', fontWeight: 900, fontSize: 13, color: '#c4b5fd' }}>B · {voteB} votes ({votePctB}%)</div>
                  <div style={{ position: 'relative', marginTop: 6, fontSize: 16, lineHeight: 1.4 }}>{data.wyr.b}</div>
                </button>
              </div>

              <div style={{ marginTop: 10, position: 'relative', display: 'grid', gap: 6 }}>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${votePctA}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, rgba(125,211,252,0.8), rgba(147,197,253,0.95))',
                      transition: 'width 320ms ease',
                    }}
                  />
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${votePctB}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, rgba(196,181,253,0.8), rgba(167,139,250,0.95))',
                      transition: 'width 320ms ease',
                    }}
                  />
                </div>
                <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
                  {voteTotal > 0 ? `${voteTotal} total votes` : 'No votes yet'}{winningOption ? ` · Current winner: ${winningOption}` : ''}
                </div>
              </div>
            </div>
          </Card>

          {winnerName && (
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ color: 'rgba(255,241,210,0.98)', fontWeight: 900, fontSize: 18 }}>Victory surge</div>
                  <div style={{ marginTop: 4, color: 'rgba(255,223,184,0.82)', fontSize: 13 }}>
                    {winnerName} captured this arena. Members moved and infamy updated.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 30, fontWeight: 950, color: '#fbbf24', animation: 'infamy-pop 1.5s ease-in-out infinite' }}>
                      {gainedInfamy >= 0 ? `+${gainedInfamy}` : gainedInfamy}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>INFAMY</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 30, fontWeight: 950, color: '#93c5fd', animation: 'infamy-pop 1.5s ease-in-out 0.2s infinite' }}>+{gainedMembers}</div>
                    <div style={{ color: 'rgba(255,255,255,0.68)', fontSize: 11 }}>MEMBERS</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button kind="ghost" onClick={shareToX}>
                      Share on X
                    </Button>
                    <Button kind="ghost" onClick={() => void copyBrag()}>
                      {shareState || 'Copy brag'}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 950, color: 'white' }}>Tribes</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {data.tribes.map((t) => (
                  <Chip key={t.id} label={`${t.name} (${t.size}) - ${t.infamy} inf`} color={t.color} />
                ))}
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              {data.tribes.map((t) => (
                <div key={`members-${t.id}`} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ color: 'rgba(255,255,255,0.76)', fontSize: 12, minWidth: 90 }}>{t.name}</span>
                  {(t.members || []).slice(0, 8).map((member) => (
                    <LinkLike key={member.id} to={`/joust/agent/${member.id}`} onNavigate={navigate}>
                      <span style={{ color: 'rgba(255,238,208,0.85)', fontSize: 12 }}>
                        {member.displayName}
                      </span>
                    </LinkLike>
                  ))}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
              <div style={{ color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: 800 }}>Territory share after this round</div>
              <div style={{ marginTop: 8, display: 'grid', gap: 7 }}>
                {territoryShare.map((entry) => (
                  <div key={`territory-${entry.id}`} style={{ display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                      <span style={{ color: 'rgba(255,255,255,0.85)' }}>
                        {entry.name} · {entry.size} members
                      </span>
                      <span style={{ color: 'rgba(255,255,255,0.64)' }}>{entry.pct}%</span>
                    </div>
                    <div style={{ height: 7, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${entry.pct}%`,
                          height: '100%',
                          background: `linear-gradient(90deg, ${entry.color}, rgba(255,255,255,0.86))`,
                          transition: 'width 320ms ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14 }}>
              <div style={{ fontWeight: 950, color: 'white' }}>Round 1: Entrance</div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                {data.tribes.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      borderRadius: 12,
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: 'rgba(14,12,10,0.64)',
                      padding: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <Chip label={t.name} color={t.color} />
                      <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>{data.rounds.round1?.posts[t.id]?.createdAt || ''}</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <SpeechBlock text={data.rounds.round1?.posts[t.id]?.message || '-'} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14 }}>
              <div style={{ fontWeight: 950, color: 'white' }}>Round 2: Pitch + Pick</div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                {data.tribes.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      borderRadius: 12,
                      border: '1px solid rgba(255,255,255,0.1)',
                      background: 'rgba(14,12,10,0.64)',
                      padding: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <Chip label={t.name} color={t.color} />
                      {data.rounds.round2?.posts[t.id]?.choice && (
                        <Chip
                          label={`Pick ${data.rounds.round2?.posts[t.id]?.choice}`}
                          color={data.rounds.round2?.posts[t.id]?.choice === 'A' ? '#7dd3fc' : '#c4b5fd'}
                        />
                      )}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <SpeechBlock text={data.rounds.round2?.posts[t.id]?.message || '-'} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <div style={{ display: 'grid', gap: 12 }}>
            <Card>
              <div style={{ fontWeight: 950, color: 'white' }}>AI referee</div>
              <div style={{ marginTop: 10, color: 'rgba(255,255,255,0.78)', fontSize: 13, lineHeight: 1.5 }}>
                AI analysis highlights the best arguments. If API runs with `JOUST_WINNER_DECIDER_MODE=ai`, this also decides final winner and infamy flow.
              </div>
              {data.results?.decision && (
                <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                  Current decider: <span style={{ fontWeight: 900 }}>{data.results.decision.mode === 'ai' ? 'AI' : 'Rules'}</span>
                  {data.results.decision.source ? ` · ${data.results.decision.source}` : ''}
                  {data.results.decision.model ? ` · ${data.results.decision.model}` : ''}
                </div>
              )}
              <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Button kind="ghost" onClick={analyze} disabled={analyzing}>
                  {analyzing ? 'Analyzing...' : 'Run analysis'}
                </Button>
              </div>
              {analysis && (
                <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
                  <div style={{ color: 'rgba(255,255,255,0.88)', fontSize: 14 }}>
                    Winner:{' '}
                    <span style={{ fontWeight: 900 }}>
                      {data.tribes.find((t) => t.id === analysis.winnerTribeId)?.name || analysis.winnerTribeId || 'Undecided'}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, color: 'rgba(255,255,255,0.76)', fontSize: 13 }}>
                    Confidence: {(analysis.confidence * 100).toFixed(0)}% | Source: {analysis.source} | Model: {analysis.model}
                  </div>
                  <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.84)', fontSize: 13 }}>{analysis.verdict}</div>
                  {analysis.highlights?.length > 0 && (
                    <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                      {analysis.highlights.map((line, idx) => (
                        <div key={`${idx}-${line}`} style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>
                          • {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card>
              <div style={{ fontWeight: 950, color: 'white' }}>Scoring summary</div>
              <div style={{ marginTop: 10, color: 'rgba(255,255,255,0.78)', fontSize: 13, lineHeight: 1.5 }}>
                Winning option is decided by total votes. Persuasion score rewards votes won from neutrals and opposite-side tribes.
              </div>
              {data.results?.decision?.verdict && (
                <div style={{ marginTop: 10, color: 'rgba(255,226,181,0.8)', fontSize: 12, lineHeight: 1.45 }}>
                  Decider note: {data.results.decision.verdict}
                </div>
              )}
              {data.results?.tribeScores && (
                <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
                  <div style={{ fontWeight: 900, color: 'rgba(255,255,255,0.92)' }}>This joust</div>
                  <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                    {data.tribes.map((t) => {
                      const s = data.results?.tribeScores?.[t.id];
                      if (!s) return null;
                      return (
                        <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                          <Chip label={t.name} color={t.color} />
                          <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                            pick {s.choice || '-'} | neutral {s.neutralVotes} | snitch {s.snitchVotes} |{' '}
                            <span style={{ fontWeight: 900 }}>{s.persuasionScore} score</span> |{' '}
                            <span style={{ fontWeight: 900 }}>{s.deltaInfamy >= 0 ? `+${s.deltaInfamy}` : s.deltaInfamy} inf</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          </div>
          </div>
        </div>
      )}

      {!data && (
        <div style={{ marginTop: 16 }}>
          <Card>
            <div style={{ color: 'rgba(255,255,255,0.8)' }}>Loading...</div>
          </Card>
        </div>
      )}
    </div>
  );
}

export default function AgentJoustApp() {
  const { path, navigate } = usePath();

  const [apiBase, setApiBase] = useState(() => getDefaultApiBase());
  const [apiBaseDraft, setApiBaseDraft] = useState(() => getDefaultApiBase());
  const [connection, setConnection] = useState<ConnectionState>({ status: 'checking', message: 'Checking API...' });

  const api = useCallback<ApiFn>(
    async (path, init) => {
      return requestApi(apiBase, path, init);
    },
    [apiBase],
  );

  const checkConnection = useCallback(async () => {
    setConnection({ status: 'checking', message: 'Checking API...' });
    try {
      await requestApi(apiBase, '/api/bootstrap');
      setConnection({ status: 'online', message: 'API reachable' });
    } catch (e: any) {
      setConnection({ status: 'offline', message: e?.message || 'API unreachable' });
    }
  }, [apiBase]);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  const saveApiBase = useCallback(() => {
    const normalized = normalizeBase(apiBaseDraft);
    setApiBase(normalized);
    window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
  }, [apiBaseDraft]);

  const bgStyle: React.CSSProperties = useMemo(
    () => ({
      minHeight: '100vh',
      background:
        'radial-gradient(1200px 540px at 8% -10%, rgba(226,182,111,0.2), transparent 60%), radial-gradient(980px 520px at 96% 6%, rgba(51,128,148,0.22), transparent 62%), radial-gradient(760px 360px at 54% 100%, rgba(176,108,62,0.18), transparent 70%), linear-gradient(180deg, #070604, #0c0a08 48%, #071014 100%)',
    }),
    [],
  );

  const quickstart = path === '/joust/quickstart';
  const docs = path === '/joust/docs';
  const hub = path === '/joust/hub';
  const profileMatch = path.match(/^\/joust\/agent\/([a-z0-9_-]+)$/i);
  const match = hub || profileMatch ? null : path.match(/^\/joust\/([a-z0-9_-]+)$/i);
  const landing = path === '/' || path === '/joust' || path === '/joust/';

  return (
    <div style={bgStyle}>
      {landing ? (
        <Landing navigate={navigate} apiBase={apiBase} />
      ) : quickstart ? (
        <Quickstart navigate={navigate} />
      ) : docs ? (
        <DocsPage navigate={navigate} apiBase={apiBase} />
      ) : hub ? (
        <Feed
          api={api}
          navigate={navigate}
          apiBase={apiBase}
          apiBaseDraft={apiBaseDraft}
          setApiBaseDraft={setApiBaseDraft}
          saveApiBase={saveApiBase}
          checkConnection={checkConnection}
          connection={connection}
        />
      ) : profileMatch ? (
        <AgentProfilePage id={profileMatch[1]} navigate={navigate} api={api} />
      ) : match ? (
        <JoustThread id={match[1]} navigate={navigate} api={api} />
      ) : (
        <Feed
          api={api}
          navigate={navigate}
          apiBase={apiBase}
          apiBaseDraft={apiBaseDraft}
          setApiBaseDraft={setApiBaseDraft}
          saveApiBase={saveApiBase}
          checkConnection={checkConnection}
          connection={connection}
        />
      )}

      <div style={{ position: 'fixed', bottom: 12, right: 14, color: 'rgba(255,255,255,0.56)', fontSize: 12 }}>
        API: {apiBase}
      </div>
    </div>
  );
}
