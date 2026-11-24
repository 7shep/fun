// Mini-golf course data and deterministic ball physics. Pure: no DOM, no imports.

export const W = 100, H = 150;          // course coordinate space (portrait). Outer edge is a wall on all 4 sides.
export const BALL_R = 1.5, CUP_R = 2.6;

const DT = 1 / 120;
const MAX_STEPS = 12 * 120;             // 12 s simulated
const GRASS_K = 0.9, SAND_K = 5;        // friction per second
const MAX_SPEED = 130, CUP_MAX_SPEED = 75, STOP_SPEED = 2;
const WALL_E = 0.75, BUMPER_E = 1.1;

export const HOLES = [
  { name: "The Designated Driveway", par: 3,
    tee: { x: 50, y: 135 }, cup: { x: 50, y: 22 },
    walls: [{ x: 12, y: 85, w: 22, h: 3 }, { x: 66, y: 60, w: 22, h: 3 }],
    bumpers: [], sand: [], water: [], movers: [] },
  { name: "Happy Hour Hairpin", par: 3,
    tee: { x: 30, y: 135 }, cup: { x: 72, y: 20 },
    walls: [{ x: 55, y: 100, w: 3, h: 30 }],
    bumpers: [{ x: 50, y: 70, r: 5 }],
    sand: [{ x: 20, y: 40, w: 25, h: 12 }], water: [], movers: [] },
  { name: "Bartender's Bumper Bank", par: 3,
    tee: { x: 50, y: 135 }, cup: { x: 50, y: 18 },
    walls: [{ x: 10, y: 70, w: 20, h: 3 }],
    bumpers: [{ x: 35, y: 90, r: 4 }, { x: 65, y: 90, r: 4 }],
    sand: [{ x: 40, y: 45, w: 20, h: 10 }], water: [], movers: [] },
  { name: "Last Orders Lagoon", par: 4,
    tee: { x: 80, y: 135 }, cup: { x: 20, y: 18 },
    walls: [{ x: 25, y: 100, w: 55, h: 3 }, { x: 40, y: 55, w: 45, h: 3 }],
    bumpers: [],
    sand: [{ x: 55, y: 120, w: 15, h: 8 }],
    water: [{ x: 45, y: 72, w: 10, h: 10 }], movers: [] },
  { name: "Shot Glass Switchback", par: 4,
    tee: { x: 50, y: 135 }, cup: { x: 50, y: 15 },
    walls: [{ x: 0, y: 110, w: 75, h: 3 }, { x: 25, y: 80, w: 75, h: 3 }, { x: 0, y: 50, w: 75, h: 3 }],
    bumpers: [],
    sand: [{ x: 40, y: 90, w: 15, h: 8 }],
    water: [{ x: 5, y: 60, w: 10, h: 8 }], movers: [] },
  { name: "The Bottomless Brunch", par: 4,
    tee: { x: 50, y: 135 }, cup: { x: 50, y: 20 },
    walls: [{ x: 30, y: 95, w: 40, h: 3 }, { x: 0, y: 40, w: 35, h: 3 }, { x: 65, y: 40, w: 35, h: 3 }],
    bumpers: [],
    sand: [{ x: 5, y: 110, w: 20, h: 8 }],
    water: [{ x: 35, y: 60, w: 30, h: 12 }], movers: [] },
  { name: "Pub Crawl Pendulum", par: 5,
    tee: { x: 50, y: 135 }, cup: { x: 50, y: 15 },
    walls: [{ x: 0, y: 100, w: 70, h: 3 }, { x: 30, y: 60, w: 70, h: 3 },
            { x: 0, y: 25, w: 44, h: 3 }, { x: 56, y: 25, w: 44, h: 3 }],
    bumpers: [],
    sand: [],
    water: [{ x: 78, y: 38, w: 12, h: 12 }],
    movers: [{ x: 40, y: 80, w: 10, h: 5, dx: 20, dy: 0, period: 3 },
             { x: 58, y: 40, w: 12, h: 4, dx: 0, dy: 8, period: 4 }] },
  { name: "Hangover Hurdle", par: 5,
    tee: { x: 20, y: 135 }, cup: { x: 80, y: 15 },
    walls: [{ x: 0, y: 110, w: 60, h: 3 }, { x: 40, y: 80, w: 60, h: 3 },
            { x: 0, y: 50, w: 70, h: 3 }, { x: 30, y: 22, w: 70, h: 3 }],
    bumpers: [],
    sand: [{ x: 70, y: 112, w: 20, h: 8 }],
    water: [{ x: 85, y: 35, w: 10, h: 10 }],
    movers: [{ x: 30, y: 95, w: 8, h: 4, dx: 25, dy: 0, period: 4 },
             { x: 52, y: 62, w: 10, h: 4, dx: 0, dy: 8, period: 3 },
             { x: 30, y: 35, w: 14, h: 4, dx: 20, dy: 0, period: 5 }] },
  { name: "Closing Time Carousel", par: 5,
    tee: { x: 50, y: 135 }, cup: { x: 82, y: 12 },
    walls: [{ x: 40, y: 115, w: 60, h: 3 }, { x: 0, y: 95, w: 60, h: 3 },
            { x: 40, y: 75, w: 60, h: 3 }, { x: 0, y: 55, w: 60, h: 3 },
            { x: 0, y: 30, w: 76, h: 3 }, { x: 88, y: 30, w: 12, h: 3 }],
    bumpers: [],
    sand: [{ x: 75, y: 120, w: 15, h: 8 }],
    water: [{ x: 5, y: 122, w: 20, h: 8 }, { x: 70, y: 63, w: 12, h: 8 }],
    movers: [{ x: 30, y: 103, w: 10, h: 6, dx: 25, dy: 0, period: 4 },
             { x: 70, y: 85, w: 10, h: 3, dx: 10, dy: 0, period: 3 },
             { x: 30, y: 62, w: 14, h: 5, dx: 20, dy: 0, period: 5 }] },
];

export function moverRect(m, t) {
  const s = Math.sin(2 * Math.PI * t / m.period);
  return { x: m.x + m.dx * s, y: m.y + m.dy * s, w: m.w, h: m.h };
}

const r1 = v => Math.round(v * 10) / 10 + 0; // +0 turns -0 into 0
const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const anyIn = (rects, x, y) => (rects || []).some(r => inRect(r, x, y));

// Reflect the velocity along unit normal (nx, ny) with restitution e, only if moving into the surface.
function reflect(s, nx, ny, e) {
  const vn = s.vx * nx + s.vy * ny;
  if (vn < 0) { s.vx -= (1 + e) * vn * nx; s.vy -= (1 + e) * vn * ny; }
}

// Circle (ball) vs axis-aligned rect.
function bounceRect(s, r) {
  let nx, ny;
  if (inRect(r, s.x, s.y)) {
    // Centre inside: push out along the axis of least penetration.
    const l = s.x - r.x, rt = r.x + r.w - s.x, tp = s.y - r.y, bt = r.y + r.h - s.y;
    const m = Math.min(l, rt, tp, bt);
    if (m === l) { nx = -1; ny = 0; s.x = r.x - BALL_R; }
    else if (m === rt) { nx = 1; ny = 0; s.x = r.x + r.w + BALL_R; }
    else if (m === tp) { nx = 0; ny = -1; s.y = r.y - BALL_R; }
    else { nx = 0; ny = 1; s.y = r.y + r.h + BALL_R; }
  } else {
    const cx = Math.min(Math.max(s.x, r.x), r.x + r.w);
    const cy = Math.min(Math.max(s.y, r.y), r.y + r.h);
    const dx = s.x - cx, dy = s.y - cy, d = Math.hypot(dx, dy);
    if (d >= BALL_R) return;
    nx = dx / d; ny = dy / d;
    s.x += nx * (BALL_R - d); s.y += ny * (BALL_R - d);
  }
  reflect(s, nx, ny, WALL_E);
}

function bounceBumper(s, b) {
  const dx = s.x - b.x, dy = s.y - b.y, d = Math.hypot(dx, dy), min = b.r + BALL_R;
  if (d >= min) return;
  const nx = d > 0 ? dx / d : 1, ny = d > 0 ? dy / d : 0;
  s.x = b.x + nx * min; s.y = b.y + ny * min;
  reflect(s, nx, ny, BUMPER_E);
}

export function simulateShot(hole, start, angle, power, t0 = 0) {
  const p = Math.min(1, Math.max(0, power));
  const sp = p * MAX_SPEED;
  const s = { x: start.x, y: start.y, vx: sp * Math.cos(angle), vy: sp * Math.sin(angle) };
  const walls = hole.walls || [], bumpers = hole.bumpers || [], movers = hole.movers || [];
  const path = [[r1(s.x), r1(s.y)]];
  let holed = false, water = false, sand = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const t = t0 + step * DT;
    s.x += s.vx * DT; s.y += s.vy * DT;

    const inSand = anyIn(hole.sand, s.x, s.y);
    if (inSand) sand = true;
    const f = 1 - (inSand ? SAND_K : GRASS_K) * DT;
    s.vx *= f; s.vy *= f;

    // Outer edges (hard boundary, same restitution as walls).
    if (s.x < BALL_R) { s.x = BALL_R; reflect(s, 1, 0, WALL_E); }
    if (s.x > W - BALL_R) { s.x = W - BALL_R; reflect(s, -1, 0, WALL_E); }
    if (s.y < BALL_R) { s.y = BALL_R; reflect(s, 0, 1, WALL_E); }
    if (s.y > H - BALL_R) { s.y = H - BALL_R; reflect(s, 0, -1, WALL_E); }

    for (const r of walls) bounceRect(s, r);
    for (const m of movers) bounceRect(s, moverRect(m, t));
    for (const b of bumpers) bounceBumper(s, b);

    if (anyIn(hole.water, s.x, s.y)) { water = true; path.push([r1(s.x), r1(s.y)]); break; }

    if (Math.hypot(s.x - hole.cup.x, s.y - hole.cup.y) < CUP_R &&
        Math.hypot(s.vx, s.vy) < CUP_MAX_SPEED) {
      holed = true; s.x = hole.cup.x; s.y = hole.cup.y; s.vx = 0; s.vy = 0;
      break;
    }

    if ((step + 1) % 4 === 0) path.push([r1(s.x), r1(s.y)]);
    if (Math.hypot(s.vx, s.vy) < STOP_SPEED) break;
  }

  if (water) return { path, end: { x: r1(start.x), y: r1(start.y) }, holed, water, sand };
  const end = { x: r1(s.x), y: r1(s.y) };
  path.push([end.x, end.y]);
  return { path, end, holed, water, sand };
}

export const maxStrokes = par => par + 3;
export const isPickedUp = (strokes, par) => strokes >= par + 3;

export function golfCutoff(totals) {
  const pids = Object.keys(totals);
  if (pids.length === 0) return [];
  const k = Math.max(1, Math.ceil(pids.length * 0.25));
  const sorted = pids.map(p => totals[p]).sort((a, b) => b - a);
  const cutoff = sorted[k - 1];
  return pids.filter(p => totals[p] >= cutoff);
}
