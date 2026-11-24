import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  W, H, BALL_R, CUP_R, HOLES, moverRect, simulateShot, maxStrokes, isPickedUp, golfCutoff,
} from '../logic/golf.js';

const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const distToRect = (r, x, y) => {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
};
const hazardCount = h => h.walls.length + h.bumpers.length + h.sand.length + h.water.length + h.movers.length;

// Simple inline hole for physics tests.
const plain = (over = {}) => ({
  name: 'test', par: 3, tee: { x: 50, y: 140 }, cup: { x: 10, y: 5 },
  walls: [], bumpers: [], sand: [], water: [], movers: [], ...over,
});
const UP = -Math.PI / 2;

// Grid distance map: 1-unit cells, BFS from the cup over cells that are not walls/bumpers/water.
function distanceMap(hole) {
  const blocked = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = i + 0.5, y = j + 0.5;
    const hit = hole.walls.concat(hole.water).some(r =>
      x >= r.x - BALL_R && x <= r.x + r.w + BALL_R && y >= r.y - BALL_R && y <= r.y + r.h + BALL_R) ||
      hole.bumpers.some(b => Math.hypot(x - b.x, y - b.y) < b.r + BALL_R);
    blocked[j * W + i] = hit ? 1 : 0;
  }
  const d = new Int32Array(W * H).fill(-1);
  const start = Math.floor(hole.cup.y) * W + Math.floor(hole.cup.x);
  const q = [start];
  d[start] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], i = c % W, j = (c - i) / W;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (d[nc] >= 0 || blocked[nc]) continue;
      d[nc] = d[c] + 1;
      q.push(nc);
    }
  }
  return d;
}

// Beam search from the tee. Returns the stroke count that holes out, or null if none within maxDepth.
function solve(hole, maxDepth) {
  const dm = distanceMap(hole);
  const value = p => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(p.x)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(p.y)));
    const v = dm[y * W + x];
    return v < 0 ? Infinity : v;
  };
  let beam = [{ pos: hole.tee }];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const cands = new Map();
    for (const st of beam) {
      for (let a = 0; a < 36; a++) {
        for (const power of [0.2, 0.35, 0.5, 0.65, 0.8, 1.0]) {
          const r = simulateShot(hole, st.pos, a * Math.PI / 18, power, 0);
          if (r.holed) return depth;
          if (r.water) continue;
          const key = r.end.x + ',' + r.end.y;
          if (!cands.has(key)) cands.set(key, { pos: r.end, v: value(r.end) });
        }
      }
    }
    beam = [...cands.values()].sort((a, b) => a.v - b.v).slice(0, 6);
  }
  return null;
}

test('HOLES has 9 holes with pars 3,3,3,4,4,4,5,5,5', () => {
  assert.equal(HOLES.length, 9);
  assert.deepEqual(HOLES.map(h => h.par), [3, 3, 3, 4, 4, 4, 5, 5, 5]);
});

test('holes 7-9 each have at least one mover with valid period and amplitude', () => {
  for (const h of HOLES.slice(6)) {
    assert.ok(h.movers.length >= 1, `${h.name} has no movers`);
    for (const m of h.movers) {
      assert.ok(m.period >= 2 && m.period <= 5, `${h.name} period ${m.period}`);
      const amp = Math.max(Math.abs(m.dx), Math.abs(m.dy));
      assert.ok(amp >= 8 && amp <= 25, `${h.name} amplitude ${amp}`);
    }
  }
});

test('holes 4-9 each have water or sand', () => {
  for (const h of HOLES.slice(3)) {
    assert.ok(h.water.length + h.sand.length > 0, `${h.name} has no water or sand`);
  }
});

test('hole 9 has more hazards than hole 1', () => {
  assert.ok(hazardCount(HOLES[8]) > hazardCount(HOLES[0]),
    `hole 9 has ${hazardCount(HOLES[8])}, hole 1 has ${hazardCount(HOLES[0])}`);
});

test('tee and cup are valid on every hole', () => {
  for (const h of HOLES) {
    for (const [label, p] of [['tee', h.tee], ['cup', h.cup]]) {
      assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, `${h.name} ${label} out of bounds`);
      for (const r of h.walls) {
        assert.ok(distToRect(r, p.x, p.y) >= BALL_R + 1, `${h.name} ${label} too close to a wall`);
      }
      for (const r of h.water.concat(h.sand)) {
        assert.ok(!inRect(r, p.x, p.y), `${h.name} ${label} inside water/sand`);
      }
      for (const b of h.bumpers) {
        assert.ok(Math.hypot(p.x - b.x, p.y - b.y) > b.r, `${h.name} ${label} inside a bumper`);
      }
    }
  }
});

test('all shapes stay inside the course bounds (movers checked across their cycle)', () => {
  const inside = r => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;
  for (const h of HOLES) {
    for (const r of h.walls.concat(h.water, h.sand)) assert.ok(inside(r), `${h.name} rect out of bounds`);
    for (const b of h.bumpers) {
      assert.ok(b.x - b.r >= 0 && b.x + b.r <= W && b.y - b.r >= 0 && b.y + b.r <= H, `${h.name} bumper out of bounds`);
    }
    for (const m of h.movers) {
      for (let i = 0; i < 8; i++) {
        assert.ok(inside(moverRect(m, i * m.period / 8)), `${h.name} mover out of bounds`);
      }
    }
  }
});

test('simulateShot is deterministic', () => {
  const h = HOLES[7];
  const a = simulateShot(h, h.tee, -1.2, 0.8, 0.5);
  const b = simulateShot(h, h.tee, -1.2, 0.8, 0.5);
  assert.deepEqual(a, b);
});

test('a shot fired straight into water returns water:true and end equal to start', () => {
  const h = plain({ water: [{ x: 40, y: 100, w: 20, h: 10 }] });
  const r = simulateShot(h, { x: 50, y: 140 }, UP, 0.5);
  assert.equal(r.water, true);
  assert.deepEqual(r.end, { x: 50, y: 140 });
});

test('ball rolling slowly over the cup is holed', () => {
  const h = plain({ cup: { x: 50, y: 100 } });
  const r = simulateShot(h, { x: 50, y: 140 }, UP, 0.4);
  assert.equal(r.holed, true);
  assert.deepEqual(r.end, { x: 50, y: 100 });
});

test('ball rolling fast over the cup is NOT holed', () => {
  const h = plain({ cup: { x: 50, y: 110 } });
  const r = simulateShot(h, { x: 50, y: 140 }, UP, 1.0);
  assert.equal(r.holed, false);
});

test('ball bouncing off a wall stays in bounds and comes back', () => {
  const h = plain({ walls: [{ x: 30, y: 60, w: 40, h: 3 }] });
  const r = simulateShot(h, { x: 50, y: 140 }, UP, 1.0);
  for (const [x, y] of r.path) {
    assert.ok(x >= 0 && x <= W && y >= 0 && y <= H, `path point ${x},${y} out of bounds`);
  }
  assert.ok(r.end.y > 64, `ball did not bounce back, end y=${r.end.y}`);
});

test('sand stops the ball sooner than grass for the same shot', () => {
  const grass = simulateShot(plain(), { x: 50, y: 140 }, UP, 0.5);
  const sandy = simulateShot(plain({ sand: [{ x: 0, y: 0, w: W, h: H }] }), { x: 50, y: 140 }, UP, 0.5);
  assert.equal(sandy.sand, true);
  assert.equal(grass.sand, false);
  assert.ok(sandy.end.y > grass.end.y, `sand end ${sandy.end.y} should be nearer the start than grass ${grass.end.y}`);
});

test('isPickedUp uses par + 3', () => {
  assert.equal(isPickedUp(5, 3), false);
  assert.equal(isPickedUp(6, 3), true);
  assert.equal(isPickedUp(7, 4), true);
  assert.equal(isPickedUp(8, 5), true);
});

test('maxStrokes(5) is 8', () => {
  assert.equal(maxStrokes(5), 8);
});

test('golfCutoff with 2 players', () => {
  assert.deepEqual(golfCutoff({ a: 3, b: 1 }), ['a']);
});

test('golfCutoff with 3 players including a tie at the cutoff', () => {
  assert.deepEqual(golfCutoff({ a: 2, b: 2, c: 0 }), ['a', 'b']);
});

test('golfCutoff with 4 players', () => {
  assert.deepEqual(golfCutoff({ a: 1, b: 0, c: -1, d: 4 }), ['d']);
});

test('golfCutoff with 5 players (k=2)', () => {
  assert.deepEqual(golfCutoff({ a: 5, b: 4, c: 4, d: 0, e: -2 }), ['a', 'b', 'c']);
});

test('golfCutoff with 8 players (k=2) and ties', () => {
  assert.deepEqual(golfCutoff({ a: 9, b: 7, c: 7, d: 7, e: 1, f: 0, g: 0, h: -1 }), ['a', 'b', 'c', 'd']);
});

test('golfCutoff when everyone is tied drinks everyone', () => {
  assert.deepEqual(golfCutoff({ a: 2, b: 2, c: 2, d: 2 }), ['a', 'b', 'c', 'd']);
});

test('golfCutoff with no players returns []', () => {
  assert.deepEqual(golfCutoff({}), []);
});

for (const [i, h] of HOLES.entries()) {
  test(`solvable: hole ${i + 1} (${h.name}) holes out within par+2 (${h.par + 2})`, { timeout: 120000 }, () => {
    const strokes = solve(h, h.par + 2);
    assert.notEqual(strokes, null, `${h.name} not solvable within ${h.par + 2} strokes`);
  });
}
