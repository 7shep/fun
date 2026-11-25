// Host-side room + game state machine. Pure: no DOM, no network.
// The host phone calls apply()/tick() and broadcasts the returned state; every phone renders it.
import * as R from './rules.js';
import { HOLES, simulateShot, isPickedUp, golfCutoff } from './golf.js';
import { QUIP_PROMPTS, NHIE_STATEMENTS } from './content.js';

export const GAMES = {
  quip: { name: 'Quip Shots', min: 3, blurb: 'Write the funniest answer. The room votes. Losers drink.' },
  golf: { name: 'Golf', min: 2, blurb: 'Nine holes of top-down mini-golf. Bottom 25% drink every hole.' },
  nhie: { name: 'Never Have I Ever', min: 2, blurb: 'Twenty confessions. Every "I Have" drinks.' },
  bus: { name: 'Ride the Bus', min: 2, blurb: 'Guess the cards. The worst guesser rides the bus.' },
  wheel: { name: 'Wheel of Misfortune', min: 2, blurb: 'Spin the wheel and accept your fate.' },
};
export const T = { answer: 60000, vote: 30000, ask: 20000, guess: 30000, reveal: 25000, spin: 5000, intro: 8000, over: 4000 };
export const MAX_PLAYERS = 12;
export const NHIE_COUNT = 20;
export const CHICKEN = '[chickened out]';
const HOST_ACTIONS = new Set(['kick', 'setDifficulty', 'setGame', 'setLaps', 'setBlind', 'openTerms', 'startGame', 'toLobby', 'next', 'skipTurn']);

const clone = (o) => structuredClone(o);
const zeros = (ids) => Object.fromEntries(ids.map((p) => [p, 0]));
const clean = (t, max) => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
export const nameOf = (s, pid) => s.players.find((p) => p.id === pid)?.name ?? '???';
export const unitsOf = (s, pid) => s.drinks.reduce((n, d) => (d.pid === pid ? n + d.units : n), 0);

export function newRoom(code, pid, name) {
  return {
    code, epoch: 1, v: 1, seq: 0, hostId: pid, players: [{ id: pid, name }],
    difficulty: 'fun', game: 'quip', laps: 1, blind: false, phase: 'lobby', terms: null, g: null, gameNo: 0,
    results: null, drinks: [], callouts: [], custom: [], history: [], lastAct: {},
  };
}

// Host migration: the next player in join order takes over from the last known state.
export const HOST_TIMEOUT = 20000;

// Failover: after the host has been quiet for HOST_TIMEOUT (seen in a fresh poll), the first other player in
// join order who is present takes over. Every phone runs the same rule, so only one of them claims the room.
export function shouldTakeOver(s, me, present, hostQuietMs) {
  if (!s || s.hostId === me || !(hostQuietMs > HOST_TIMEOUT)) return false;
  return s.players.find((p) => p.id !== s.hostId && present.has(p.id))?.id === me;
}

export function takeOver(s0, pid) {
  const s = clone(s0);
  s.epoch++; s.v++; s.hostId = pid;
  return s;
}

export const PID_RE = /^[a-z0-9]{1,16}$/;

// Identifies the exact question/turn an in-game action was made for, so a late or retried action
// can't land on the next one.
export function stageKey(s) {
  const g = s.g;
  if (!g) return '';
  return [s.gameNo, g.round, g.stage, g.mi, g.i, g.hole, g.turn, g.ti, g.gs, g.ride?.stage, g.ride?.restarts, g.turnNo, g.spinNo]
    .map((x) => x ?? '').join(':');
}

// Apply one player action. Returns {state} (same object when nothing changed) or {state, error}.
export function apply(s0, pid, a, now, rng = Math.random) {
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return { state: s0, error: 'Bad action' };
  if (typeof pid !== 'string' || !PID_RE.test(pid)) return { state: s0, error: 'Bad player id' };
  if (a.id != null && !Number.isSafeInteger(a.id)) return { state: s0, error: 'Bad action id' };
  if (a.id != null && (s0.lastAct[pid] ?? 0) >= a.id) return { state: s0 }; // resent duplicate
  const s = clone(s0);
  let error;
  try { error = handle(s, pid, a, now, rng); } catch { error = 'Bad action'; } // fail closed, never crash the host loop
  if (error) return { state: s0, error: typeof error === 'string' ? error : 'Bad action' };
  if (a.id != null) s.lastAct[pid] = a.id;
  s.v++;
  return { state: s };
}

// Timed transitions (answer timers, reveal auto-advance, wheel landing). Same object when nothing is due.
export function tick(s0, now, rng = Math.random) {
  const g = s0.g;
  if (s0.phase !== 'game' || !g || !g.deadline || now < g.deadline) return s0;
  const s = clone(s0);
  s.g.deadline = null;
  DEADLINE[g.type](s, now, rng);
  s.v++;
  return s;
}

// Each player drinks at their own level; anyone who hasn't picked uses the room default.
export const levelOf = (s, pid) => s.players.find((p) => p.id === pid)?.level ?? s.difficulty;

function handle(s, pid, a, now, rng) {
  const inRoom = s.players.some((p) => p.id === pid);
  if (a.type === 'join') {
    if (inRoom) return;
    if (s.players.length >= MAX_PLAYERS) return 'Room is full (12 max)';
    const r = R.validateName(a.name, s.players.map((p) => p.name));
    if (!r.ok) return r.error;
    s.players.push({ id: pid, name: r.name });
    return;
  }
  if (!inRoom) return 'You are not in this room';
  if (HOST_ACTIONS.has(a.type) && pid !== s.hostId) return 'Only the host can do that';
  const lobby = s.phase === 'lobby';
  switch (a.type) {
    case 'kick':
      if (!lobby) return 'Only in the lobby';
      if (a.target === s.hostId) return 'The host cannot be kicked';
      s.players = s.players.filter((p) => p.id !== a.target);
      return;
    case 'setLevel': // your own tolerance; changeable any time, even mid-game
      if (!R.LEVELS.some((l) => l.id === a.level)) return 'Unknown level';
      s.players.find((p) => p.id === pid).level = a.level;
      return;
    case 'setDifficulty':
      if (!lobby) return 'Only in the lobby';
      if (!R.LEVELS.some((l) => l.id === a.level)) return 'Unknown level';
      s.difficulty = a.level;
      return;
    case 'setGame':
      if (!lobby) return 'Only in the lobby';
      if (!Object.hasOwn(GAMES, a.game)) return 'Unknown game';
      s.game = a.game;
      return;
    case 'setBlind':
      if (!lobby) return 'Only in the lobby';
      if (typeof a.on !== 'boolean') return 'Pick on or off';
      s.blind = a.on;
      return;
    case 'setLaps':
      if (!lobby) return 'Only in the lobby';
      if (!Number.isInteger(a.laps) || a.laps < 1 || a.laps > 5) return 'Laps must be 1–5';
      s.laps = a.laps;
      return;
    case 'addPrompt': {
      if (!lobby) return 'Add prompts in the lobby';
      if (a.kind !== 'quip' && a.kind !== 'nhie') return 'Unknown prompt type';
      let text = clean(a.text, 140);
      if (a.kind === 'nhie') {
        text = text.replace(/^never have i ever\s*/i, '').replace(/[.!?]*$/, '');
        text = text && `Never have I ever ${text}.`;
      }
      if (text.length < 3 || text.length > 130) return 'Prompts must be 3–110 characters';
      if (s.custom.length >= 200) return 'That is plenty of prompts';
      s.custom.push({ kind: a.kind, text, authorId: pid, author: nameOf(s, pid) });
      return;
    }
    case 'openTerms': {
      if (!lobby) return 'Only in the lobby';
      const min = GAMES[s.game].min;
      if (s.players.length < min) return `${GAMES[s.game].name} needs at least ${min} players`;
      s.phase = 'terms';
      s.terms = { game: s.game, signed: {} };
      return;
    }
    case 'sign':
      if (s.phase !== 'terms') return 'Nothing to sign';
      s.terms.signed[pid] = true;
      return;
    case 'startGame': {
      // skip: the host can skip the contract from the lobby, or stop waiting on signatures
      if (s.phase !== 'terms' && !(a.skip === true && lobby)) return 'Sign the contract first';
      if (s.phase === 'terms' && a.skip !== true) {
        const waiting = s.players.filter((p) => !s.terms.signed[p.id]).map((p) => p.name);
        if (waiting.length) return `Still waiting on ${waiting.join(', ')}`;
      }
      const game = s.phase === 'terms' ? s.terms.game : s.game;
      if (s.players.length < GAMES[game].min) return `${GAMES[game].name} needs at least ${GAMES[game].min} players`;
      s.gameNo++;
      s.phase = 'game';
      s.results = null;
      s.g = START[game](s, now, rng);
      s.terms = null;
      return;
    }
    case 'toLobby':
      if (lobby) return;
      s.phase = 'lobby'; s.terms = null; s.g = null;
      return;
    case 'next':
      if (s.phase !== 'game') return 'Nothing to advance';
      return NEXT[s.g.type](s, now, rng);
    case 'skipTurn':
      if (s.phase !== 'game') return 'No game running';
      return SKIP[s.g.type](s, now, rng);
    default: {
      if (s.phase !== 'game') return 'No game running';
      if (!Object.hasOwn(ACTS[s.g.type], a.type)) return 'Unknown action';
      if (a.at !== stageKey(s)) return 'Too late — that moment has passed';
      const f = ACTS[s.g.type][a.type];
      if (!s.g.players.includes(pid)) return 'You are spectating this game';
      return f(s, pid, a, now, rng);
    }
  }
}

// Award drink units; one full-screen callout per drink event.
function give(s, list, reason, now) {
  const by = new Map();
  for (const { pid, units } of list) if (units > 0) by.set(pid, (by.get(pid) ?? 0) + units);
  if (!by.size) return;
  const items = [];
  for (const [pid, units] of by) {
    const level = levelOf(s, pid), c = R.drinkCallout(level, unitsOf(s, pid), units);
    s.drinks.push({ pid, units, shots: c.shots, text: c.text, level, gn: s.gameNo, game: s.g?.type, reason });
    items.push({ pid, name: nameOf(s, pid), text: c.text });
  }
  s.callouts = [...(s.callouts ?? []), { id: ++s.seq, items, reason, at: now }].slice(-6); // a few, so phones that skip a version still see each one
}

function finish(s) {
  const g = s.g;
  const units = zeros(g.players);
  for (const d of s.drinks) if (d.gn === s.gameNo && d.pid in units) units[d.pid] += d.units;
  const st = STANDINGS[g.type](g);
  const ex = R.extremes(units);
  const awards = [];
  if (ex.most.value > 0) awards.push({ key: 'liverMvp', title: 'Liver MVP', pids: ex.most.pids, why: `${ex.most.value} units this game` });
  awards.push({ key: 'mostHydrated', title: 'Most Hydrated', pids: ex.fewest.pids, why: `${ex.fewest.value} units this game` });
  const vals = g.players.map((p) => st.scores[p]);
  const worst = st.higherBetter ? Math.min(...vals) : Math.max(...vals);
  awards.push({ key: 'biggestLoser', title: 'Biggest Loser', pids: g.players.filter((p) => st.scores[p] === worst), why: st.loserWhy(worst) });
  if (st.award && st.award.pids.length) awards.push({ key: 'game', ...st.award });
  s.results = { game: g.type, gn: s.gameNo, players: g.players, units, scores: st.scores, label: st.label, higherBetter: st.higherBetter, awards };
  s.history.push({ game: g.type, gn: s.gameNo, awards });
  s.phase = 'results';
  s.g = null;
}

const best = (ids, score, higher = true) => {
  const vals = ids.map(score);
  const b = higher ? Math.max(...vals) : Math.min(...vals);
  return ids.filter((p) => score(p) === b);
};
const fmtPar = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

/* ---------------- Quip Shots ---------------- */
function quipStart(s, now, rng) {
  const players = s.players.map((p) => p.id);
  const custom = R.shuffle(s.custom.filter((c) => c.kind === 'quip').map(({ text, authorId, author }) => ({ text, authorId, author })), rng);
  const starters = R.shuffle(QUIP_PROMPTS, rng).slice(0, players.length * 2 + 6).map((text) => ({ text }));
  const g = { type: 'quip', players, deck: custom.concat(starters), round: 1, points: zeros(players), chickens: zeros(players) };
  quipRound(g, now, rng);
  return g;
}
function quipRound(g, now, rng) {
  g.matchups = R.quipAssign(g.players, g.deck, rng).map((m) => ({ ...m, ansA: null, ansB: null }));
  g.stage = 'answer'; g.submitted = {}; g.deadline = now + T.answer; g.mi = 0; g.votes = {}; g.last = null;
}
function quipClose(g, now) {
  for (const m of g.matchups) {
    if (!m.ansA) { m.ansA = CHICKEN; g.chickens[m.a]++; }
    if (!m.ansB) { m.ansB = CHICKEN; g.chickens[m.b]++; }
  }
  g.stage = 'vote'; g.mi = 0; g.votes = {}; g.deadline = now + T.vote;
}
export const quipVoters = (g) => g.players.filter((p) => p !== g.matchups[g.mi].a && p !== g.matchups[g.mi].b);
function quipResolve(s, now) {
  const g = s.g, m = g.matchups[g.mi];
  const vA = quipVoters(g).filter((p) => g.votes[p] === 'a');
  const vB = quipVoters(g).filter((p) => g.votes[p] === 'b');
  const o = R.quipOutcome(vA.length, vB.length, g.round);
  g.points[m.a] += o.pointsA; g.points[m.b] += o.pointsB;
  give(s, [{ pid: m.a, units: o.drinksA }, { pid: m.b, units: o.drinksB }],
    o.result === 'tie' ? 'Dead heat — both drink' : o.shutout ? 'SHUTOUT! Not a single vote' : 'Lost the matchup', now);
  g.last = { votesA: vA, votesB: vB, ...o };
  g.stage = 'reveal'; g.deadline = now + T.reveal;
}
function quipNext(s, now, rng) {
  const g = s.g;
  if (g.stage !== 'reveal') return 'Nothing to advance yet';
  g.mi++; g.last = null;
  if (g.mi < g.matchups.length) { g.stage = 'vote'; g.votes = {}; g.deadline = now + T.vote; }
  else if (g.round === 1) { g.round = 2; quipRound(g, now, rng); }
  else finish(s);
}
const quipActs = {
  quipAnswer(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'answer') return 'Time is up';
    if (g.submitted[pid]) return;
    const ans = a.answers && typeof a.answers === 'object' ? a.answers : {};
    g.matchups.forEach((m, i) => {
      const t = clean(ans[i], 80);
      if (m.a === pid) m.ansA = t || null;
      if (m.b === pid) m.ansB = t || null;
    });
    g.submitted[pid] = true;
    if (g.players.every((p) => g.submitted[p])) quipClose(g, now);
  },
  quipVote(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'vote') return 'Voting is closed';
    if (!quipVoters(g).includes(pid)) return 'You wrote one of these — no voting!';
    if (a.choice !== 'a' && a.choice !== 'b') return 'Pick an answer';
    g.votes[pid] = a.choice;
    if (quipVoters(g).every((p) => g.votes[p])) quipResolve(s, now);
  },
};

/* ---------------- Never Have I Ever ---------------- */
function nhieStart(s, now, rng) {
  const players = s.players.map((p) => p.id);
  const custom = R.shuffle(s.custom.filter((c) => c.kind === 'nhie').map(({ text, author }) => ({ text, author })), rng).slice(0, NHIE_COUNT);
  const starters = R.shuffle(NHIE_STATEMENTS, rng).slice(0, NHIE_COUNT - custom.length).map((text) => ({ text }));
  return { type: 'nhie', players, list: R.shuffle(custom.concat(starters), rng), i: 0, haves: zeros(players), stage: 'ask', answers: {}, deadline: now + T.ask, last: null, blind: s.blind === true };
}
function nhieReveal(s, now) {
  const g = s.g;
  const have = g.players.filter((p) => g.answers[p] === true);
  const never = g.players.filter((p) => g.answers[p] === false);
  if (g.blind) {
    for (const p of have) g.haves[p]++;
    // Blind mode: only the "I have" count is shown; everyone who said Never guesses who said I Have
    if (have.length && never.length) {
      g.stage = 'guess'; g.yesCount = have.length; g.guessers = never; g.guesses = {}; g.deadline = now + T.guess;
    } else {
      g.last = { have, never, blind: true, results: [] }; // nobody to catch, or nobody to guess
      g.stage = 'reveal'; g.deadline = now + T.reveal;
    }
    return;
  }
  const lone = have.length === 1 ? have[0] : null;
  for (const p of have) g.haves[p]++;
  give(s, lone ? [{ pid: lone, units: 2 }] : have.map((pid) => ({ pid, units: 1 })), lone ? 'The only one who has — explain yourself!' : 'Guilty as charged', now);
  g.last = { have, never, lone };
  g.stage = 'reveal'; g.deadline = now + T.reveal;
}
// Each pick that really said I Have makes them drink 1; each wrong pick makes the guesser drink 1.
function nhieBlindResolve(s, now) {
  const g = s.g;
  const have = g.players.filter((p) => g.answers[p] === true);
  const list = [], results = [];
  for (const guesser of g.guessers) {
    const picks = g.guesses[guesser];
    if (!picks) { results.push({ guesser, picks: [], skipped: true }); continue; }
    const marked = picks.map((pid) => ({ pid, right: have.includes(pid) }));
    for (const m of marked) list.push({ pid: m.right ? m.pid : guesser, units: 1 });
    results.push({ guesser, picks: marked });
  }
  give(s, list, 'Blind mode: caught out or guessed wrong', now);
  g.last = { have, never: g.guessers, blind: true, results };
  g.stage = 'reveal'; g.deadline = now + T.reveal;
}
function nhieNext(s, now) {
  const g = s.g;
  if (g.stage !== 'reveal') return 'Nothing to advance yet';
  g.i++;
  if (g.i >= g.list.length) return void finish(s);
  g.stage = 'ask'; g.answers = {}; g.last = null; g.guesses = null; g.guessers = null; g.yesCount = null; g.deadline = now + T.ask;
}
const nhieActs = {
  nhieAnswer(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'ask') return 'Too late';
    if (typeof a.have !== 'boolean') return 'Pick one';
    g.answers[pid] = a.have;
    if (g.players.every((p) => p in g.answers)) nhieReveal(s, now);
  },
  nhieGuess(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'guess') return 'Not guessing right now';
    if (!g.guessers.includes(pid)) return 'Only the people who said Never guess';
    if (g.guesses[pid]) return 'You already locked in a guess';
    const picks = a.picks;
    if (!Array.isArray(picks) || picks.length !== g.yesCount) return `Pick exactly ${g.yesCount}`;
    if (new Set(picks).size !== picks.length || !picks.every((p) => typeof p === 'string' && g.players.includes(p) && p !== pid)) return 'Pick other players';
    g.guesses[pid] = [...picks];
    if (g.guessers.every((p) => g.guesses[p])) nhieBlindResolve(s, now);
  },
};

/* ---------------- Golf ---------------- */
function golfStart(s) {
  const players = s.players.map((p) => p.id);
  const g = { type: 'golf', players, hole: 0, totals: zeros(players), strokes: zeros(players), waters: zeros(players), aces: [], shotNo: 0, busyUntil: 0 };
  golfHole(g);
  return g;
}
function golfHole(g) {
  const h = HOLES[g.hole];
  g.balls = Object.fromEntries(g.players.map((p) => [p, { x: h.tee.x, y: h.tee.y, strokes: 0, done: false, score: null }]));
  g.turn = g.players[g.hole % g.players.length]; // rotate who tees off first
  g.stage = 'play'; g.shot = null; g.board = null; g.deadline = null;
}
function golfNextTurn(g) {
  const n = g.players.length, i = g.players.indexOf(g.turn);
  for (let k = 1; k <= n; k++) {
    const p = g.players[(i + k) % n];
    if (!g.balls[p].done) { g.turn = p; return; }
  }
  g.turn = null;
}
function golfAfterStroke(g, now) {
  golfNextTurn(g);
  if (!g.turn) g.deadline = Math.max(now, g.busyUntil); // hole ends once the last ball stops
}
function golfHoleEnd(s, now) {
  const g = s.g, h = HOLES[g.hole];
  for (const p of g.players) { g.totals[p] += g.balls[p].score - h.par; g.strokes[p] += g.balls[p].score; }
  const losers = golfCutoff(g.totals);
  give(s, losers.map((pid) => ({ pid, units: 1 })), `Bottom of the leaderboard after hole ${g.hole + 1}`, now);
  g.board = { losers };
  g.stage = 'holeResult'; g.deadline = now + T.reveal;
}
function golfNext(s) {
  const g = s.g;
  if (g.stage !== 'holeResult') return 'Finish the hole first';
  g.hole++;
  if (g.hole >= HOLES.length) return void finish(s);
  golfHole(g);
}
const golfActs = {
  golfShot(s, pid, a, now) {
    const g = s.g, h = HOLES[g.hole];
    if (g.stage !== 'play') return 'The hole is over';
    if (pid !== g.turn) return 'Not your shot';
    if (now < g.busyUntil) return 'Wait for the ball to stop';
    const angle = Number(a.angle), power = Math.min(1, Math.max(0, Number(a.power)));
    if (!Number.isFinite(angle) || !Number.isFinite(power) || power < 0.03) return 'Pull back further';
    const t = Number.isFinite(a.t) && a.t >= 0 && a.t < 1e7 ? a.t : 0;
    const b = g.balls[pid];
    const r = simulateShot(h, { x: b.x, y: b.y }, angle, power, t);
    b.strokes += r.water ? 2 : 1;
    if (r.water) g.waters[pid]++;
    else { b.x = r.end.x; b.y = r.end.y; }
    const ace = r.holed && b.strokes === 1;
    if (r.holed) { b.done = true; b.score = b.strokes; }
    else if (isPickedUp(b.strokes, h.par)) { b.done = true; b.score = h.par + 3; b.picked = true; }
    if (ace) g.aces.push(pid);
    g.shot = { no: ++g.shotNo, pid, path: r.path, t0: t, holed: r.holed, water: r.water, ace, picked: !!b.picked };
    g.busyUntil = now + Math.ceil((r.path.length / 30) * 1000) + 600;
    golfAfterStroke(g, now);
  },
};
function golfSkip(s, now) {
  const g = s.g;
  if (g.stage !== 'play' || !g.turn) return 'Nothing to skip';
  const b = g.balls[g.turn];
  b.done = true; b.score = HOLES[g.hole].par + 3; b.picked = true;
  golfAfterStroke(g, now);
}

/* ---------------- Ride the Bus ---------------- */
const GUESSES = { 1: ['red', 'black'], 2: ['higher', 'lower'], 3: ['inside', 'outside'], 4: ['H', 'D', 'C', 'S'] };
function busStart(s, now, rng) {
  const players = s.players.map((p) => p.id);
  return {
    type: 'bus', players, deck: R.shuffle(R.makeDeck(), rng), stage: 'p1', ti: 0, gs: 1, cards: [], prev: null, last: null,
    stats: Object.fromEntries(players.map((p) => [p, { wrong: 0, units: 0 }])), rider: null, ride: null, deadline: null,
  };
}
function draw(g, rng) {
  if (!g.deck.length) g.deck = R.shuffle(R.makeDeck(), rng);
  return g.deck.pop();
}
function busEndTurn(g, now) {
  g.prev = { pid: g.players[g.ti], cards: g.cards };
  g.cards = []; g.gs = 1; g.ti++;
  if (g.ti >= g.players.length) {
    g.rider = R.pickRider(g.players.map((id) => ({ id, ...g.stats[id] })));
    g.stage = 'rideIntro'; g.deadline = now + T.intro;
  }
}
function busNext(s, now, rng) {
  const g = s.g;
  if (g.stage === 'rideIntro') {
    g.stage = 'ride'; g.deck = R.shuffle(R.makeDeck(), rng); g.cards = []; g.prev = null; g.last = null;
    g.ride = { stage: 1, restarts: 0 }; g.deadline = null;
    return;
  }
  if (g.stage === 'rideDone') return void finish(s);
  return 'Nothing to advance';
}
const busActs = {
  busGuess(s, pid, a, now, rng) {
    const g = s.g;
    const stage = g.stage === 'p1' ? g.gs : g.stage === 'ride' ? g.ride.stage : 0;
    if (!stage) return 'Not now';
    if (pid !== (g.stage === 'p1' ? g.players[g.ti] : g.rider)) return 'Not your turn';
    if (!GUESSES[stage].includes(a.guess)) return 'Bad guess';
    const card = draw(g, rng);
    const ok = R.busCheck(stage, a.guess, g.cards, card);
    g.last = { pid, stage, guess: a.guess, card, ok };
    if (g.stage === 'p1') {
      g.cards.push(card);
      if (!ok) {
        const u = R.busPenalty(stage);
        g.stats[pid].wrong++; g.stats[pid].units += u;
        give(s, [{ pid, units: u }], `Wrong on guess ${stage}`, now);
      }
      if (stage === 4) busEndTurn(g, now); else g.gs++;
      return;
    }
    const step = R.busRideStep(g.ride, ok);
    if (ok) g.cards.push(card);
    else {
      g.prev = { pid, cards: [...g.cards, card] };
      g.cards = [];
      give(s, [{ pid, units: step.units }], `Bus stop #${step.restarts} — back to the start`, now);
    }
    g.ride = { stage: step.stage, restarts: step.restarts };
    if (step.done) { g.stage = 'rideDone'; g.offByValve = step.offByValve; g.deadline = now + T.reveal; }
  },
};
function busSkip(s, now) {
  const g = s.g;
  if (g.stage === 'p1') return void busEndTurn(g, now);
  if (g.stage === 'ride') { g.stage = 'rideDone'; g.offByValve = true; g.deadline = now + T.reveal; return; }
  return 'Nothing to skip';
}

/* ---------------- Wheel of Misfortune ---------------- */
function wheelStart(s) {
  const players = s.players.map((p) => p.id);
  return {
    type: 'wheel', players, laps: s.laps, turns: s.laps * players.length, turnNo: 0, si: 0, spinner: players[0], mult: 1,
    stage: 'spin', spinNo: 0, spin: null, pending: null, last: null, self: zeros(players), safes: zeros(players), deadline: null,
  };
}
function wheelAdvance(g, now) {
  g.turnNo++; g.pending = null;
  if (g.turnNo >= g.turns) { g.stage = 'over'; g.deadline = now + T.over; return; }
  g.si = (g.si + 1) % g.players.length;
  g.spinner = g.players[g.si];
  g.stage = 'spin';
}
function wheelLand(s, now) {
  const g = s.g, sl = R.SLICES[g.spin.idx];
  const o = R.wheelOutcome(sl.id, { spinner: g.spinner, players: g.players, mult: g.mult });
  g.last = { slice: sl.id, label: sl.label, mult: g.mult, spinner: g.spinner };
  give(s, o.drinks, `${sl.label}${g.mult > 1 ? ` (×${g.mult})` : ''}`, now);
  for (const d of o.drinks) if (d.pid === g.spinner) g.self[g.spinner] += d.units;
  if (sl.id === 'safe') g.safes[g.spinner]++;
  g.mult = o.nextMult;
  if (o.needs) { g.stage = o.needs; g.pending = { total: o.handout }; return; }
  if (o.spinAgain) { g.stage = 'spin'; return; }
  wheelAdvance(g, now);
}
const wheelActs = {
  wheelSpin(s, pid, a, now, rng) {
    const g = s.g;
    if (g.stage !== 'spin') return 'Not now';
    if (pid !== g.spinner) return 'Not your spin';
    g.spinNo++;
    g.spin = { no: g.spinNo, idx: Math.floor(rng() * R.SLICES.length) };
    g.stage = 'spinning'; g.deadline = now + T.spin;
  },
  wheelPick(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'pick' || pid !== g.spinner) return 'Not now';
    if (!g.players.includes(a.target) || a.target === pid) return 'Pick someone else';
    give(s, [{ pid: a.target, units: g.pending.total }], `Picked by ${nameOf(s, pid)}`, now);
    wheelAdvance(g, now);
  },
  wheelHandout(s, pid, a, now) {
    const g = s.g;
    if (g.stage !== 'handout' || pid !== g.spinner) return 'Not now';
    const alloc = a.alloc && typeof a.alloc === 'object' ? a.alloc : {};
    if (!R.validateHandout(alloc, pid, g.players, g.pending.total)) return `Hand out exactly ${g.pending.total} to other players`;
    give(s, Object.entries(alloc).map(([p, units]) => ({ pid: p, units })), `Handed out by ${nameOf(s, pid)}`, now);
    wheelAdvance(g, now);
  },
};
function wheelSkip(s, now) {
  const g = s.g;
  if (!['spin', 'pick', 'handout'].includes(g.stage)) return 'Nothing to skip';
  wheelAdvance(g, now);
}

/* ---------------- tables ---------------- */
const START = { quip: quipStart, nhie: nhieStart, golf: golfStart, bus: busStart, wheel: wheelStart };
const ACTS = { quip: quipActs, nhie: nhieActs, golf: golfActs, bus: busActs, wheel: wheelActs };
const NEXT = { quip: quipNext, nhie: nhieNext, golf: golfNext, bus: busNext, wheel: () => 'Nothing to advance' };
const SKIP = {
  quip: () => 'Use the timer', nhie: () => 'Use the timer', golf: golfSkip, bus: busSkip, wheel: wheelSkip,
};
const DEADLINE = {
  quip(s, now, rng) {
    const g = s.g;
    if (g.stage === 'answer') quipClose(g, now);
    else if (g.stage === 'vote') quipResolve(s, now);
    else if (g.stage === 'reveal') quipNext(s, now, rng);
  },
  nhie(s, now) {
    if (s.g.stage === 'ask') nhieReveal(s, now);
    else if (s.g.stage === 'guess') nhieBlindResolve(s, now); // no guess in time: no drinks either way
    else if (s.g.stage === 'reveal') nhieNext(s, now);
  },
  golf(s, now) { if (s.g.stage === 'play') golfHoleEnd(s, now); else if (s.g.stage === 'holeResult') golfNext(s); },
  bus(s, now, rng) { busNext(s, now, rng); },
  wheel(s, now) { if (s.g.stage === 'spinning') wheelLand(s, now); else if (s.g.stage === 'over') finish(s); },
};
const STANDINGS = {
  quip: (g) => ({
    scores: g.points, higherBetter: true, label: 'Points', loserWhy: (v) => `${v} points`,
    award: { title: 'Punchline Champion', pids: best(g.players, (p) => g.points[p]), why: `${Math.max(...g.players.map((p) => g.points[p]))} points` },
  }),
  golf: (g) => ({
    scores: g.totals, higherBetter: false, label: 'vs Par', loserWhy: (v) => `${fmtPar(v)} for the round`,
    award: g.aces.length
      ? { title: 'Ace of the Night', pids: [...new Set(g.aces)], why: 'Hole in one!' }
      : { title: 'Club Champion', pids: best(g.players, (p) => g.totals[p], false), why: `${fmtPar(Math.min(...g.players.map((p) => g.totals[p])))} for the round` },
  }),
  nhie: (g) => ({
    scores: g.haves, higherBetter: false, label: '"I Have"s', loserWhy: (v) => `admitted to ${v} things`,
    award: { title: 'Saint of the Evening', pids: best(g.players, (p) => g.haves[p], false), why: 'Suspiciously innocent' },
  }),
  bus: (g) => ({
    scores: Object.fromEntries(g.players.map((p) => [p, g.stats[p].wrong])), higherBetter: false, label: 'Wrong guesses',
    loserWhy: (v) => `${v} wrong guesses`,
    award: { title: 'Bus Regular', pids: g.rider ? [g.rider] : [], why: g.ride ? `${g.ride.restarts} stops on the bus${g.offByValve ? ' (safety valve)' : ''}` : 'Rode the bus' },
  }),
  wheel: (g) => {
    const lucky = best(g.players, (p) => g.safes[p]);
    return {
      scores: g.self, higherBetter: false, label: 'Units from own spins', loserWhy: (v) => `spun ${v} units onto themself`,
      award: g.players.some((p) => g.safes[p] > 0) ? { title: "Lady Luck's Pet", pids: lucky, why: `Landed on Safe ${g.safes[lucky[0]]}×` } : null,
    };
  },
};
