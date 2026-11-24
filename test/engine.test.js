import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../logic/engine.js';
import { HOLES } from '../logic/golf.js';

// Small seeded RNG so games are reproducible.
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function room(n = 3, rng = seeded(1)) {
  let now = 1000;
  let s = E.newRoom('ABCD', 'p0', 'Host');
  const ids = ['p0'];
  for (let i = 1; i < n; i++) { ids.push('p' + i); s = ok(E.apply(s, 'p' + i, { type: 'join', name: 'P' + i }, now)); }
  const ctx = { get s() { return s; }, ids, rng, get now() { return now; } };
  const stamp = (a) => (s.phase === 'game' && a.at === undefined ? { ...a, at: E.stageKey(s) } : a);
  ctx.do = (pid, a) => { s = ok(E.apply(s, pid, stamp(a), now, rng)); return s; };
  ctx.try = (pid, a) => E.apply(s, pid, stamp(a), now, rng);
  ctx.wait = (ms) => { now += ms; s = E.tick(s, now, rng); return s; };
  ctx.start = (game) => {
    ctx.do('p0', { type: 'setGame', game });
    ctx.do('p0', { type: 'openTerms' });
    assert.match(ctx.try('p0', { type: 'startGame' }).error, /waiting/i);
    for (const p of ids) ctx.do(p, { type: 'sign' });
    ctx.do('p0', { type: 'startGame' });
  };
  return ctx;
}
function ok(r) { assert.equal(r.error, undefined, r.error); return r.state; }

function checkTally(s) {
  assert.equal(s.phase, 'results');
  const sum = Object.values(s.results.units).reduce((a, b) => a + b, 0);
  const logged = s.drinks.filter((d) => d.gn === s.results.gn).reduce((a, d) => a + d.units, 0);
  assert.equal(sum, logged);
  for (const d of s.drinks) assert.ok(d.text.length > 0 && d.units > 0);
  assert.ok(s.results.awards.some((a) => a.title === 'Most Hydrated'));
  assert.ok(s.results.awards.some((a) => a.title === 'Biggest Loser'));
}

test('join validation and lobby rules', () => {
  const r = room(2);
  assert.match(r.try('p9', { type: 'join', name: 'host' }).error, /taken/);
  assert.match(r.try('p1', { type: 'setDifficulty', level: 'tipsy' }).error, /host/);
  r.do('p0', { type: 'setGame', game: 'quip' });
  assert.match(r.try('p0', { type: 'openTerms' }).error, /at least 3/);
  // duplicate action ids are ignored
  const s1 = r.do('p1', { type: 'addPrompt', kind: 'nhie', text: 'licked a battery', id: 5 });
  assert.equal(r.try('p1', { type: 'addPrompt', kind: 'nhie', text: 'again', id: 5 }).state, s1);
  assert.equal(s1.custom[0].text, 'Never have I ever licked a battery.');
});

test('quip shots plays 2 rounds; custom prompts never go to their author', () => {
  const r = room(4);
  r.do('p2', { type: 'addPrompt', kind: 'quip', text: 'Worst bar name: ___' });
  r.start('quip');
  for (let round = 1; round <= 2; round++) {
    const g = r.s.g;
    assert.equal(g.round, round);
    for (const m of g.matchups) if (m.prompt.authorId) assert.ok(m.prompt.authorId !== m.a && m.prompt.authorId !== m.b);
    for (const p of r.ids.slice(0, 3)) r.do(p, { type: 'quipAnswer', answers: { 0: 'x', 1: 'y', 2: 'z', 3: 'w' } });
    r.wait(E.T.answer); // p3 times out → chickened out
    assert.equal(r.s.g.stage, 'vote');
    assert.ok(r.s.g.matchups.some((m) => m.ansA === E.CHICKEN || m.ansB === E.CHICKEN));
    for (let i = 0; i < g.matchups.length; i++) {
      const voters = E.quipVoters(r.s.g);
      for (const v of voters) r.do(v, { type: 'quipVote', choice: 'a' }); // shutout for b
      assert.equal(r.s.g.stage, 'reveal');
      assert.ok(r.s.g.last.shutout);
      assert.equal(r.s.g.last.drinksB, 2 * round);
      r.do('p0', { type: 'next' });
    }
  }
  checkTally(r.s);
});

test('never have I ever: lone confessor drinks 2, timer closes the round', () => {
  const r = room(3);
  r.start('nhie');
  r.do('p1', { type: 'nhieAnswer', have: true });
  r.do('p2', { type: 'nhieAnswer', have: false });
  r.wait(E.T.ask);
  assert.equal(r.s.g.last.lone, 'p1');
  assert.equal(r.s.drinks.at(-1).units, 2);
  r.do('p0', { type: 'next' });
  for (let i = 1; i < E.NHIE_COUNT; i++) {
    for (const p of r.ids) r.do(p, { type: 'nhieAnswer', have: i % 2 === 0 });
    r.wait(E.T.reveal); // auto-advance
  }
  checkTally(r.s);
});

test('golf: 9 holes, strokes capped at par+3, bottom 25% drink each hole', () => {
  const r = room(3);
  r.start('golf');
  for (let h = 0; h < 9; h++) {
    assert.equal(r.s.g.hole, h);
    let guard = 0;
    while (r.s.g.stage === 'play' && r.s.g.turn && guard++ < 100) {
      r.wait(r.s.g.busyUntil - r.now + 1);
      if (r.s.g.stage !== 'play' || !r.s.g.turn) break;
      r.do(r.s.g.turn, { type: 'golfShot', angle: Math.PI / 2, power: 0.2, t: 0 }); // weak shot away from the cup
    }
    for (const p of r.ids) assert.equal(r.s.g.balls[p].score, HOLES[h].par + 3);
    const before = r.s.drinks.length;
    r.wait(10000);
    assert.equal(r.s.g.stage, 'holeResult');
    assert.equal(r.s.drinks.length - before, 3); // all tied → everyone drinks
    r.do('p0', { type: 'next' });
  }
  checkTally(r.s);
});

test('ride the bus: phase 1 penalties, rider restarts, safety valve after 10', () => {
  const r = room(2);
  r.start('bus');
  for (let t = 0; t < 2; t++) {
    const p = r.s.g.players[r.s.g.ti];
    for (const guess of ['red', 'higher', 'inside', 'H']) r.do(p, { type: 'busGuess', guess });
  }
  assert.equal(r.s.g.stage, 'rideIntro');
  const p1Units = r.s.drinks.reduce((a, d) => a + d.units, 0);
  for (const p of r.ids) assert.equal(r.s.g.stats[p].units <= 10, true);
  r.do('p0', { type: 'next' });
  const rider = r.s.g.rider;
  let guard = 0;
  while (r.s.g.stage === 'ride' && guard++ < 500) {
    const st = r.s.g.ride.stage;
    // stage 4 always guess a suit; force wrongs by picking a guess then checking
    r.do(rider, { type: 'busGuess', guess: { 1: 'red', 2: 'higher', 3: 'inside', 4: 'S' }[st] });
  }
  assert.equal(r.s.g.stage, 'rideDone');
  assert.ok(r.s.g.ride.restarts <= 10);
  if (r.s.g.offByValve) assert.equal(r.s.g.ride.restarts, 10);
  const rideUnits = r.s.drinks.reduce((a, d) => a + d.units, 0) - p1Units;
  assert.equal(rideUnits, r.s.g.ride.restarts);
  r.do('p0', { type: 'next' });
  checkTally(r.s);
});

test('wheel: laps × players spins, pick and handout need input', () => {
  const r = room(3);
  r.do('p0', { type: 'setLaps', laps: 2 });
  r.start('wheel');
  let guard = 0;
  while (r.s.phase === 'game' && guard++ < 200) {
    const g = r.s.g;
    if (g.stage === 'spin') r.do(g.spinner, { type: 'wheelSpin' });
    else if (g.stage === 'pick') r.do(g.spinner, { type: 'wheelPick', target: g.players.find((p) => p !== g.spinner) });
    else if (g.stage === 'handout') {
      const other = g.players.find((p) => p !== g.spinner);
      assert.ok(r.try(g.spinner, { type: 'wheelHandout', alloc: { [g.spinner]: g.pending.total } }).error);
      r.do(g.spinner, { type: 'wheelHandout', alloc: { [other]: g.pending.total } });
    } else r.wait(E.T.spin);
  }
  checkTally(r.s);
  assert.equal(r.s.history.length, 1);
});

test('host takeover bumps epoch and keeps the game', () => {
  const r = room(3);
  r.start('nhie');
  const s2 = E.takeOver(r.s, 'p1');
  assert.equal(s2.hostId, 'p1');
  assert.equal(s2.epoch, r.s.epoch + 1);
  assert.deepEqual(s2.g, r.s.g);
});

test('prototype-named or unknown actions fail closed without throwing', () => {
  const r = room(3);
  r.start('nhie');
  const s = r.s;
  for (const t of ['hasOwnProperty', 'valueOf', '__proto__', 'constructor', 'toString', 'isPrototypeOf', 'nope']) {
    const out = E.apply(s, 'p1', { type: t, id: 1, at: E.stageKey(s) }, r.now);
    assert.equal(typeof out.error, 'string', t);
    assert.equal(out.state, s);
  }
  const lobby = room(3);
  for (const game of ['constructor', '__proto__', 'toString']) assert.ok(lobby.try('p0', { type: 'setGame', game }).error);
  assert.ok(E.apply(s, '__proto__', { type: 'join', name: 'Evil' }, r.now).error);
  assert.ok(E.apply(s, 'p1', { type: 'nhieAnswer', have: true, id: 'x' }, r.now).error);
});

test('a late or retried answer cannot land on the next statement', () => {
  const r = room(3);
  r.start('nhie');
  const oldKey = E.stageKey(r.s);
  r.wait(E.T.ask);          // nobody answered; timer reveals
  r.do('p0', { type: 'next' });
  assert.equal(r.s.g.i, 1);
  const late = E.apply(r.s, 'p1', { type: 'nhieAnswer', have: true, id: 99, at: oldKey }, r.now);
  assert.match(late.error, /late/i);
  assert.equal(late.state.g.answers.p1, undefined);
  assert.match(E.apply(r.s, 'p1', { type: 'nhieAnswer', have: true }, r.now).error, /late/i); // unstamped fails closed
});

test('every drink event is kept in the recent callouts list', () => {
  const r = room(2);
  r.start('bus');
  const p = r.s.g.players[0];
  for (const guess of ['red', 'higher']) r.do(p, { type: 'busGuess', guess });
  const wrong = r.s.drinks.length;
  assert.equal(r.s.callouts.length, wrong);
  assert.deepEqual(r.s.callouts.map((c) => c.id), [...r.s.callouts.map((c) => c.id)].sort((a, b) => a - b));
});

test('a room saved before callouts existed still takes drink calls', () => {
  const r = room(2);
  r.start('bus');
  delete r.s.callouts;
  const p = r.s.g.players[0];
  const outs = ['red', 'black'].map((guess) => E.apply(r.s, p, { type: 'busGuess', guess, at: E.stageKey(r.s) }, r.now));
  for (const x of outs) assert.equal(x.error, undefined);
  assert.ok(outs.some((x) => x.state.callouts?.length === 1)); // one of the two was wrong and made a callout
});
