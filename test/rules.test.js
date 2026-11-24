import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../logic/rules.js';

// Deterministic rng for shuffle-based tests.
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('drinkCallout examples from spec', () => {
  assert.equal(R.drinkCallout('fun', 0, 1).text, '1 SIP');
  assert.equal(R.drinkCallout('fun', 0, 2).text, '2 SIPS');
  assert.equal(R.drinkCallout('tipsy', 5, 2).text, '4 SIPS');
  assert.equal(R.drinkCallout('tipsy', 2, 1).text, '2 SIPS');
  assert.equal(R.drinkCallout('sending', 0, 3).text, '6 SIPS + 1 SHOT');
  assert.equal(R.drinkCallout('sending', 2, 1).text, '1 SHOT');
  assert.equal(R.drinkCallout('sending', 1, 1).text, '3 SIPS');
  assert.equal(R.drinkCallout('blackout', 0, 2).text, 'HALF YOUR DRINK ×2');
  assert.equal(R.drinkCallout('blackout', 2, 1).text, '1 SHOT');
  assert.equal(R.drinkCallout('alcoholism', 0, 1).text, 'FINISH YOUR DRINK');
  assert.equal(R.drinkCallout('alcoholism', 0, 6).text, 'FINISH YOUR DRINK ×4 + 2 SHOTS');
});

test('drinkCallout returns shots and units', () => {
  const r = R.drinkCallout('sending', 0, 3);
  assert.deepEqual(r, {text:'6 SIPS + 1 SHOT', shots:1, units:3});
  assert.deepEqual(R.drinkCallout('fun', 0, 0), {text:'', shots:0, units:0});
});

test('drinkCallout: all 5 levels, zero units gives empty text', () => {
  for (const l of R.LEVELS) {
    assert.equal(R.drinkCallout(l.id, 4, 0).text, '');
  }
  assert.equal(R.drinkCallout('fun', 0, 1).text, '1 SIP');
  assert.equal(R.drinkCallout('tipsy', 0, 1).text, '2 SIPS');
  assert.equal(R.drinkCallout('sending', 0, 1).text, '3 SIPS');
  assert.equal(R.drinkCallout('blackout', 0, 1).text, 'HALF YOUR DRINK');
  assert.equal(R.drinkCallout('alcoholism', 0, 2).text, 'FINISH YOUR DRINK ×2');
});

test('shot rule: every 3rd cumulative unit is a shot at sending/blackout/alcoholism only', () => {
  // Cumulative units 1..12 added one at a time: shots land on 3,6,9,12.
  for (const level of ['sending', 'blackout', 'alcoholism']) {
    const shotUnits = [];
    for (let u = 0; u < 12; u++) {
      if (R.drinkCallout(level, u, 1).shots === 1) shotUnits.push(u + 1);
    }
    assert.deepEqual(shotUnits, [3, 6, 9, 12], level);
  }
  // Fun and tipsy never produce shots.
  for (const level of ['fun', 'tipsy']) {
    for (let u = 0; u < 12; u++) {
      const r = R.drinkCallout(level, u, 1);
      assert.equal(r.shots, 0, level);
      assert.ok(!r.text.includes('SHOT'), level);
    }
    assert.equal(R.drinkCallout(level, 0, 6).text, level === 'fun' ? '6 SIPS' : '12 SIPS');
  }
});

test('LEVELS has all five levels in order', () => {
  assert.deepEqual(R.LEVELS.map(l => l.id), ['fun', 'tipsy', 'sending', 'blackout', 'alcoholism']);
});

test('makeRoomCode: 500 codes are 4 safe chars', () => {
  for (let i = 0; i < 500; i++) {
    const code = R.makeRoomCode();
    assert.match(code, /^[A-HJKMNP-Z]{4}$/);
    assert.ok(!/[ILO01]/.test(code), code);
  }
  assert.equal(R.CODE_ALPHABET.length, 23);
});

test('makeRoomCode uses injected rng', () => {
  assert.equal(R.makeRoomCode(() => 0), 'AAAA');
});

test('validateName edge cases', () => {
  assert.equal(R.validateName('').ok, false);
  assert.equal(R.validateName('   ').ok, false);
  const long = R.validateName('abcdefghijklm', []);
  assert.deepEqual(long, {ok:false, error:'Name must be 1–12 characters'});
  assert.deepEqual(R.validateName('  Al  ex ', []), {ok:true, name:'Al ex'});
  assert.deepEqual(R.validateName('abcdefghijkl', []), {ok:true, name:'abcdefghijkl'});
  assert.deepEqual(R.validateName('ALEX', ['alex']), {ok:false, error:'That name is taken'});
  assert.equal(R.validateName(undefined, []).ok, false);
  assert.equal(R.validateName(42, []).ok, false);
});

test('shuffle returns a new permutation and does not mutate input', () => {
  const input = [1, 2, 3, 4, 5];
  const out = R.shuffle(input, seq([0.9, 0.1, 0.5, 0.3]));
  assert.notEqual(out, input);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5]);
});

test('quipAssign: 3 players, each in exactly 2 matchups', () => {
  const ids = ['p1', 'p2', 'p3'];
  const deck = [{text:'a', authorId:'x'}, {text:'b', authorId:'y'}, {text:'c', authorId:'z'}];
  const out = R.quipAssign(ids, deck);
  assert.equal(out.length, 3);
  assertEachPlayerTwice(out, ids);
  assert.equal(deck.length, 0);
});

test('quipAssign: 4 players', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const deck = Array.from({length: 10}, (_, i) => ({text:'t' + i, authorId:'nobody'}));
  const out = R.quipAssign(ids, deck, seq([0.2, 0.7, 0.4]));
  assert.equal(out.length, 4);
  assertEachPlayerTwice(out, ids);
  assert.equal(deck.length, 6);
});

test('quipAssign: 8 players', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const deck = Array.from({length: 20}, (_, i) => ({text:'t' + i, authorId:ids[i % 8]}));
  const out = R.quipAssign(ids, deck);
  assert.equal(out.length, 8);
  assertEachPlayerTwice(out, ids);
  assert.equal(deck.length, 12);
  for (const m of out) assert.ok(m.prompt.text, 'prompt has text');
});

test('quipAssign: prompt by a matchup player is never used for that matchup', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const deck = [{text:'mine', authorId:'p1'}, {text:'other', authorId:'p2'}];
  const out = R.quipAssign(ids, deck, seq([0.1]));
  for (const m of out) {
    if (m.prompt.text === 'mine') {
      assert.notEqual(m.a, 'p1');
      assert.notEqual(m.b, 'p1');
    }
    if (m.prompt.text === 'other') {
      assert.notEqual(m.a, 'p2');
      assert.notEqual(m.b, 'p2');
    }
  }
});

test('quipAssign: falls back to default prompt when deck has no eligible card', () => {
  const ids = ['p1', 'p2', 'p3'];
  const deck = [{text:'only p1', authorId:'p1'}];
  const out = R.quipAssign(ids, deck);
  const fallback = out.filter(m => m.prompt.text === 'Describe tonight in exactly three words.');
  assert.ok(fallback.length >= 1);
});

function assertEachPlayerTwice(matchups, ids) {
  const counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (const m of matchups) {
    assert.notEqual(m.a, m.b);
    counts[m.a]++;
    counts[m.b]++;
  }
  for (const id of ids) assert.equal(counts[id], 2, id);
}

test('quipOutcome: win 3-1 (round 1)', () => {
  assert.deepEqual(R.quipOutcome(3, 1, 1), {
    pointsA: 300, pointsB: 100, drinksA: 0, drinksB: 1, result: 'A', shutout: false,
  });
});

test('quipOutcome: tie 2-2', () => {
  assert.deepEqual(R.quipOutcome(2, 2, 1), {
    pointsA: 200, pointsB: 200, drinksA: 1, drinksB: 1, result: 'tie', shutout: false,
  });
});

test('quipOutcome: shutout 3-0 gives loser 2 drinks', () => {
  assert.deepEqual(R.quipOutcome(3, 0, 1), {
    pointsA: 300, pointsB: 0, drinksA: 0, drinksB: 2, result: 'A', shutout: true,
  });
  assert.deepEqual(R.quipOutcome(0, 3, 1), {
    pointsA: 0, pointsB: 300, drinksA: 2, drinksB: 0, result: 'B', shutout: true,
  });
});

test('quipOutcome: round 2 doubles points and drinks', () => {
  assert.deepEqual(R.quipOutcome(3, 1, 2), {
    pointsA: 600, pointsB: 200, drinksA: 0, drinksB: 2, result: 'A', shutout: false,
  });
  assert.deepEqual(R.quipOutcome(2, 2, 2), {
    pointsA: 400, pointsB: 400, drinksA: 2, drinksB: 2, result: 'tie', shutout: false,
  });
  assert.deepEqual(R.quipOutcome(3, 0, 2), {
    pointsA: 600, pointsB: 0, drinksA: 0, drinksB: 4, result: 'A', shutout: true,
  });
});

test('makeDeck: 52 unique cards', () => {
  const d = R.makeDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map(c => c.r + c.s)).size, 52);
  for (const c of d) {
    assert.ok(c.r >= 2 && c.r <= 14);
    assert.ok(['H', 'D', 'C', 'S'].includes(c.s));
  }
});

test('isRed and cardLabel', () => {
  assert.equal(R.isRed({r:5, s:'H'}), true);
  assert.equal(R.isRed({r:5, s:'D'}), true);
  assert.equal(R.isRed({r:5, s:'C'}), false);
  assert.equal(R.isRed({r:5, s:'S'}), false);
  assert.equal(R.cardLabel({r:14, s:'H'}), 'A♥');
  assert.equal(R.cardLabel({r:10, s:'S'}), '10♠');
  assert.equal(R.cardLabel({r:12, s:'D'}), 'Q♦');
  assert.equal(R.cardLabel({r:7, s:'C'}), '7♣');
  assert.equal(R.cardLabel({r:11, s:'C'}), 'J♣');
  assert.equal(R.cardLabel({r:13, s:'S'}), 'K♠');
});

test('busCheck stage 1: colour', () => {
  assert.equal(R.busCheck(1, 'red', [], {r:9, s:'H'}), true);
  assert.equal(R.busCheck(1, 'black', [], {r:9, s:'H'}), false);
  assert.equal(R.busCheck(1, 'black', [], {r:2, s:'S'}), true);
  assert.equal(R.busCheck(1, 'red', [], {r:2, s:'S'}), false);
});

test('busCheck stage 2: higher/lower, equal rank is wrong', () => {
  const prev = [{r:7, s:'H'}];
  assert.equal(R.busCheck(2, 'higher', prev, {r:9, s:'C'}), true);
  assert.equal(R.busCheck(2, 'higher', prev, {r:6, s:'C'}), false);
  assert.equal(R.busCheck(2, 'lower', prev, {r:6, s:'C'}), true);
  assert.equal(R.busCheck(2, 'lower', prev, {r:9, s:'C'}), false);
  assert.equal(R.busCheck(2, 'higher', prev, {r:7, s:'C'}), false);
  assert.equal(R.busCheck(2, 'lower', prev, {r:7, s:'C'}), false);
});

test('busCheck stage 3: inside/outside with ties', () => {
  const prev = [{r:5, s:'H'}, {r:10, s:'D'}];
  assert.equal(R.busCheck(3, 'inside', prev, {r:7, s:'C'}), true);
  assert.equal(R.busCheck(3, 'inside', prev, {r:4, s:'C'}), false);
  assert.equal(R.busCheck(3, 'outside', prev, {r:4, s:'C'}), true);
  assert.equal(R.busCheck(3, 'outside', prev, {r:11, s:'C'}), true);
  assert.equal(R.busCheck(3, 'outside', prev, {r:7, s:'C'}), false);
  // equal to lo or hi is wrong for both guesses
  for (const r of [5, 10]) {
    assert.equal(R.busCheck(3, 'inside', prev, {r, s:'C'}), false, `inside r=${r}`);
    assert.equal(R.busCheck(3, 'outside', prev, {r, s:'C'}), false, `outside r=${r}`);
  }
});

test('busCheck stage 3: lo === hi means inside is always wrong', () => {
  const prev = [{r:8, s:'H'}, {r:8, s:'D'}];
  for (const r of [2, 7, 8, 9, 14]) {
    assert.equal(R.busCheck(3, 'inside', prev, {r, s:'C'}), false, `inside r=${r}`);
  }
  assert.equal(R.busCheck(3, 'outside', prev, {r:7, s:'C'}), true);
  assert.equal(R.busCheck(3, 'outside', prev, {r:8, s:'C'}), false);
});

test('busCheck stage 3: order of prev does not matter', () => {
  const prev = [{r:10, s:'D'}, {r:5, s:'H'}];
  assert.equal(R.busCheck(3, 'inside', prev, {r:7, s:'C'}), true);
});

test('busCheck stage 4: suit', () => {
  assert.equal(R.busCheck(4, 'H', [], {r:3, s:'H'}), true);
  assert.equal(R.busCheck(4, 'S', [], {r:3, s:'H'}), false);
});

test('busPenalty equals stage', () => {
  assert.equal(R.busPenalty(1), 1);
  assert.equal(R.busPenalty(4), 4);
});

test('pickRider: most wrong wins', () => {
  assert.equal(R.pickRider([
    {id:'a', wrong:1, units:9}, {id:'b', wrong:3, units:1}, {id:'c', wrong:2, units:0},
  ]), 'b');
});

test('pickRider: tie on wrong goes to most units', () => {
  assert.equal(R.pickRider([
    {id:'a', wrong:2, units:3}, {id:'b', wrong:2, units:7}, {id:'c', wrong:2, units:5},
  ]), 'b');
});

test('pickRider: full tie goes to earliest in array', () => {
  assert.equal(R.pickRider([
    {id:'x', wrong:2, units:4}, {id:'y', wrong:2, units:4}, {id:'z', wrong:2, units:4},
  ]), 'x');
});

test('busRideStep: correct progresses, stage 4 correct finishes', () => {
  assert.deepEqual(R.busRideStep({stage:1, restarts:0}, true),
    {stage:2, restarts:0, units:0, done:false, offByValve:false});
  assert.deepEqual(R.busRideStep({stage:3, restarts:2}, true),
    {stage:4, restarts:2, units:0, done:false, offByValve:false});
  assert.deepEqual(R.busRideStep({stage:4, restarts:2}, true),
    {stage:4, restarts:2, units:0, done:true, offByValve:false});
});

test('busRideStep: wrong restarts at stage 1 with 1 unit', () => {
  assert.deepEqual(R.busRideStep({stage:3, restarts:0}, false),
    {stage:1, restarts:1, units:1, done:false, offByValve:false});
});

test('busRideStep: 10-restart cap', () => {
  let ride = {stage:1, restarts:0};
  for (let i = 1; i <= 9; i++) {
    ride = R.busRideStep(ride, false);
    assert.equal(ride.restarts, i);
    assert.equal(ride.done, false, `after wrong ${i}`);
    assert.equal(ride.offByValve, false);
  }
  const last = R.busRideStep(ride, false);
  assert.equal(last.restarts, 10);
  assert.equal(last.done, true);
  assert.equal(last.offByValve, true);
  assert.equal(R.BUS_MAX_RESTARTS, 10);
});

test('wheelOutcome: every slice id with mult 1', () => {
  const players = ['a', 'b', 'c'];
  const w = (id, mult = 1) => R.wheelOutcome(id, {spinner:'a', players, mult});
  assert.deepEqual(w('drink1').drinks, [{pid:'a', units:1}]);
  assert.deepEqual(w('drink2').drinks, [{pid:'a', units:2}]);
  assert.deepEqual(w('pick'), {drinks:[], needs:'pick', handout:1, nextMult:1, spinAgain:false});
  assert.deepEqual(w('everyone').drinks, [{pid:'a', units:1}, {pid:'b', units:1}, {pid:'c', units:1}]);
  assert.deepEqual(w('social').drinks, w('everyone').drinks);
  assert.deepEqual(w('waterfall').drinks, [{pid:'a', units:2}, {pid:'b', units:2}, {pid:'c', units:2}]);
  assert.deepEqual(w('safe'), {drinks:[], needs:null, handout:0, nextMult:1, spinAgain:false});
  assert.deepEqual(w('again'), {drinks:[], needs:null, handout:0, nextMult:1, spinAgain:true});
  assert.deepEqual(w('double'), {drinks:[], needs:null, handout:0, nextMult:2, spinAgain:false});
  assert.deepEqual(w('handout'), {drinks:[], needs:'handout', handout:3, nextMult:1, spinAgain:false});
});

test('wheelOutcome: every slice id with mult 2', () => {
  const players = ['a', 'b'];
  const w = id => R.wheelOutcome(id, {spinner:'a', players, mult:2});
  assert.deepEqual(w('drink1').drinks, [{pid:'a', units:2}]);
  assert.deepEqual(w('drink2').drinks, [{pid:'a', units:4}]);
  assert.deepEqual(w('pick').handout, 2);
  assert.deepEqual(w('pick').needs, 'pick');
  assert.deepEqual(w('everyone').drinks, [{pid:'a', units:2}, {pid:'b', units:2}]);
  assert.deepEqual(w('social').drinks, [{pid:'a', units:2}, {pid:'b', units:2}]);
  assert.deepEqual(w('waterfall').drinks, [{pid:'a', units:4}, {pid:'b', units:4}]);
  assert.equal(w('safe').drinks.length, 0);
  assert.equal(w('again').nextMult, 2);
  assert.equal(w('again').spinAgain, true);
  assert.equal(w('double').nextMult, 4);
  assert.equal(w('handout').handout, 6);
  assert.equal(w('handout').needs, 'handout');
});

test('wheelOutcome: double or nothing caps at 8', () => {
  const w = mult => R.wheelOutcome('double', {spinner:'a', players:['a'], mult});
  assert.equal(w(1).nextMult, 2);
  assert.equal(w(2).nextMult, 4);
  assert.equal(w(4).nextMult, 8);
  assert.equal(w(8).nextMult, 8);
});

test('wheelOutcome: again keeps mult of 4', () => {
  const r = R.wheelOutcome('again', {spinner:'a', players:['a'], mult:4});
  assert.equal(r.nextMult, 4);
});

test('wheelOutcome: SLICES cover every id', () => {
  const ids = R.SLICES.map(s => s.id);
  assert.deepEqual(ids, ['drink1', 'drink2', 'pick', 'everyone', 'social', 'waterfall', 'safe', 'again', 'double', 'handout']);
  for (const id of ids) {
    const r = R.wheelOutcome(id, {spinner:'a', players:['a', 'b'], mult:1});
    assert.ok(r && typeof r === 'object', id);
  }
});

test('validateHandout: good cases', () => {
  const players = ['a', 'b', 'c'];
  assert.equal(R.validateHandout({b:1, c:2}, 'a', players, 3), true);
  assert.equal(R.validateHandout({b:3}, 'a', players, 3), true);
  assert.equal(R.validateHandout({}, 'a', players, 0), true);
});

test('validateHandout: bad cases', () => {
  const players = ['a', 'b', 'c'];
  assert.equal(R.validateHandout({a:1, b:2}, 'a', players, 3), false, 'spinner included');
  assert.equal(R.validateHandout({b:1, c:1}, 'a', players, 3), false, 'wrong sum');
  assert.equal(R.validateHandout({b:-1, c:4}, 'a', players, 3), false, 'negative');
  assert.equal(R.validateHandout({b:1.5, c:1.5}, 'a', players, 3), false, 'non-integer');
  assert.equal(R.validateHandout({b:1, z:2}, 'a', players, 3), false, 'unknown pid');
  assert.equal(R.validateHandout(null, 'a', players, 0), false, 'null alloc');
});

test('extremes: ties and empty', () => {
  assert.deepEqual(R.extremes({a:3, b:1, c:1, d:3}), {
    most: {pids:['a', 'd'], value:3}, fewest: {pids:['b', 'c'], value:1},
  });
  assert.deepEqual(R.extremes({}), {most:{pids:[], value:0}, fewest:{pids:[], value:0}});
  assert.deepEqual(R.extremes({a:2}), {most:{pids:['a'], value:2}, fewest:{pids:['a'], value:2}});
});
