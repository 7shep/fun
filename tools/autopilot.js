// Dev-only QA helper: plays for this tab's player. In devtools: await import('/tools/autopilot.js')
window.HOLES_CACHE = (await import('../logic/golf.js')).HOLES;
export const status = (() => {
  clearInterval(window.auto);
  window.autoLog = window.autoLog || [];
  let lastKey = '';
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  window.autoWorker?.terminate();
  const step = () => {
    const { app, act } = lcl, s = app.state;
    if (!s || !app.me || app.pending.size) return;
    const me = app.me.pid, host = s.hostId === me, g = s.g, now = Date.now() + app.offset;
    const busy = g && g.busyUntil && now < g.busyUntil;
    const key = `${s.v}|${busy}`;
    if (key === lastKey) return;
    lastKey = key;
    const A = (a) => { window.autoLog.push(`${s.v}:${a.type}`); act(a); };
    if (s.phase === 'terms') {
      if (!s.terms.signed[me]) return A({ type: 'sign' });
      if (host && s.players.every((p) => s.terms.signed[p.id])) return A({ type: 'startGame' });
      return;
    }
    if (s.phase !== 'game') return;
    if (g.type === 'quip') {
      if (g.stage === 'answer' && !g.submitted[me]) {
        const answers = {};
        g.matchups.forEach((m, i) => { if (m.a === me || m.b === me) answers[i] = `${app.me.name} says ${Math.random().toString(36).slice(2, 6)}`; });
        return A({ type: 'quipAnswer', answers });
      }
      if (g.stage === 'vote') {
        const m = g.matchups[g.mi];
        if (m.a !== me && m.b !== me && !g.votes[me]) return A({ type: 'quipVote', choice: pick(['a', 'b']) });
      }
      if (g.stage === 'reveal' && host) return setTimeout(() => A({ type: 'next' }), 800);
    }
    if (g.type === 'nhie') {
      if (g.stage === 'ask' && !(me in g.answers)) return A({ type: 'nhieAnswer', have: Math.random() < 0.4 });
      if (g.stage === 'guess' && g.guessers.includes(me) && !g.guesses[me]) {
        const others = g.players.filter((p) => p !== me).sort(() => Math.random() - 0.5);
        return A({ type: 'nhieGuess', picks: others.slice(0, g.yesCount) });
      }
      if (g.stage === 'reveal' && host) return setTimeout(() => A({ type: 'next' }), 1500);
    }
    if (g.type === 'golf') {
      if (g.stage === 'play' && g.turn === me && !busy) {
        const b = g.balls[me], h = window.HOLES_CACHE[g.hole];
        const dx = h.cup.x - b.x, dy = h.cup.y - b.y, d = Math.hypot(dx, dy);
        return A({ type: 'golfShot', angle: Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.5, power: Math.min(1, 0.25 + d / 120), t: performance.now() / 1000 });
      }
      if (g.stage === 'holeResult' && host) return setTimeout(() => A({ type: 'next' }), 600);
    }
    if (g.type === 'bus') {
      const active = g.stage === 'p1' ? g.players[g.ti] : g.stage === 'ride' ? g.rider : null;
      const st = g.stage === 'p1' ? g.gs : g.ride?.stage;
      if (active === me) return A({ type: 'busGuess', guess: pick({ 1: ['red', 'black'], 2: ['higher', 'lower'], 3: ['inside', 'outside'], 4: ['H', 'D', 'C', 'S'] }[st]) });
      if ((g.stage === 'rideIntro' || g.stage === 'rideDone') && host) return setTimeout(() => A({ type: 'next' }), 600);
    }
    if (g.type === 'wheel' && g.spinner === me) {
      const others = g.players.filter((p) => p !== me);
      if (g.stage === 'spin') return A({ type: 'wheelSpin' });
      if (g.stage === 'pick') return A({ type: 'wheelPick', target: pick(others) });
      if (g.stage === 'handout') return A({ type: 'wheelHandout', alloc: { [pick(others)]: g.pending.total } });
    }
  };
  // worker clock: hidden tabs throttle setInterval to ~1/min, workers keep ticking
  window.autoWorker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 300)'], { type: 'text/javascript' })));
  window.autoWorker.onmessage = step;
  return 'autopilot on';
})();
