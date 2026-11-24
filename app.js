// Last Call Live! — phone UI, host loop and realtime glue. Game rules live in logic/ (no DOM).
import * as E from './logic/engine.js';
import { LEVELS, SLICES, isRed, makeRoomCode, validateName } from './logic/rules.js';
import { HOLES, W, H, BALL_R, CUP_R, moverRect } from './logic/golf.js';
import { TERMS, AWARD_BLURBS } from './logic/content.js';
import { connect } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SEAT = 'lcl-seat';
const HOST_TIMEOUT = 20000;

const app = {
  view: 'home', error: '', me: null, state: null, net: null, ready: false, present: new Set(),
  offset: 0, lastHostSeen: 0, lastHb: 0, lastHello: 0, helloWanted: false, joining: null,
  pending: new Map(), lastActId: 0, lastHtml: '', seenCallout: null, fxKey: '', autoSent: {},
  ui: { sheet: null, read: null, waived: null, promptKind: 'quip', alloc: {} },
};
const me = () => app.me?.pid;
const amHost = () => !!app.state && app.state.hostId === me();
const hostNow = () => Date.now() + app.offset;
const nm = (pid) => esc(E.nameOf(app.state, pid));

/* ---------------- seat storage ---------------- */
// sessionStorage survives refresh/relock in the same tab; localStorage offers "Rejoin" after the tab was closed.
const saveSeat = (seat) => { const j = JSON.stringify(seat); sessionStorage.setItem(SEAT, j); localStorage.setItem(SEAT, j); };
const clearSeat = () => { sessionStorage.removeItem(SEAT); localStorage.removeItem(SEAT); };
const readSeat = (store) => { try { return JSON.parse(store.getItem(SEAT)); } catch { return null; } };
function newId() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36).slice(0, 4);
}

/* ---------------- networking ---------------- */
function send(payload) { try { app.net?.send(payload)?.catch?.(() => {}); } catch { /* offline: retries/heartbeat recover */ } }
const broadcastState = () => send({ t: 'state', s: app.state, at: Date.now(), from: me() });
function hello() { app.lastHello = Date.now(); send({ t: 'hello', pid: me() }); }

function openNet(code) {
  app.net?.close();
  app.ready = false;
  app.present = new Set();
  app.net = connect(code, me(), {
    onMsg,
    onPresence: (keys) => { app.present = new Set(keys); render(); },
    onReady: () => { app.ready = true; if (amHost()) broadcastState(); else hello(); },
    onStatus: (st) => { if (st !== 'SUBSCRIBED') app.ready = false; },
  });
}

function onMsg(m) {
  if (!m || typeof m !== 'object') return;
  const s = app.state;
  switch (m.t) {
    case 'state': if (m.s && typeof m.s === 'object') adopt(m.s, m.at, m.from); break;
    case 'hb':
      if (!s) return;
      if (m.hostId === s.hostId) app.lastHostSeen = Math.max(app.lastHostSeen, Date.now() - (m.age ?? 0));
      if (m.epoch > s.epoch || (m.epoch === s.epoch && m.v > s.v)) app.helloWanted = true;
      break;
    case 'act': if (amHost() && m.a && typeof m.a === 'object') hostApply(m.pid, m.a); break;
    case 'err':
      if (m.to !== me()) return;
      app.pending.delete(m.id);
      if (app.joining) return failJoin(m.error);
      toast(m.error);
      break;
  }
}

function adopt(s, at = Date.now(), from = null) {
  const cur = app.state;
  if (s.code !== app.me?.code) return;
  if (cur && !(s.epoch > cur.epoch || (s.epoch === cur.epoch && s.v > cur.v))) return;
  app.state = s;
  app.helloWanted = false;
  app.offset = s.hostId === me() ? 0 : (Number(at) || Date.now()) - Date.now();
  if (!cur || from === s.hostId) app.lastHostSeen = Date.now();
  const seated = s.players.some((p) => p.id === me());
  if (app.joining) {
    if (seated) { app.joining = null; saveSeat(app.me); app.view = 'room'; }
    else if (!app.joining.sent) { app.joining.sent = true; act({ type: 'join', name: app.joining.name }); }
  } else if (!seated) return leave('You are no longer in that room.');
  else app.view = 'room';
  for (const id of app.pending.keys()) if (id <= (s.lastAct[me()] ?? 0)) app.pending.delete(id);
  effects(s);
  render();
}

function commit(s) { adopt(s); broadcastState(); }

function hostApply(pid, a) {
  const r = E.apply(app.state, pid, a, Date.now());
  if (r.error) {
    if (pid === me()) toast(r.error); else send({ t: 'err', to: pid, error: r.error, id: a.id });
    return;
  }
  if (r.state !== app.state) commit(r.state);
}

function act(a) {
  app.lastActId = Math.max(Date.now() * 100, app.lastActId + 1);
  a = { ...a, id: app.lastActId };
  if (amHost()) return hostApply(me(), a);
  app.pending.set(a.id, { a, tries: 1, at: Date.now() });
  send({ t: 'act', pid: me(), a });
}

function maybeTakeOver() {
  const s = app.state;
  const next = s.players.find((p) => p.id !== s.hostId && app.present.has(p.id));
  if (next?.id !== me()) return;
  commit(E.takeOver(s, me()));
  toast('The host went quiet — you are the host now!');
}

function loop() {
  const s = app.state, now = Date.now();
  app.net?.tick();
  if (!app.net || !app.ready) return;
  if (!s) { if (now - app.lastHello > 3000) hello(); return; }
  if (amHost()) {
    const s2 = E.tick(s, now);
    if (s2 !== s) commit(s2);
    if (now - app.lastHb > 2000) { app.lastHb = now; send({ t: 'hb', hostId: s.hostId, epoch: app.state.epoch, v: app.state.v, at: now }); }
  } else {
    if (now - app.lastHostSeen > HOST_TIMEOUT) maybeTakeOver();
    if (app.helloWanted && now - app.lastHello > 1500) hello();
  }
  for (const [id, p] of app.pending) {
    if (now - p.at < 2500) continue;
    if (p.tries >= 4) { app.pending.delete(id); continue; }
    p.tries++; p.at = now;
    send({ t: 'act', pid: me(), a: p.a });
  }
}

/* ---------------- room entry ---------------- */
function createRoom(name) {
  const v = validateName(name, []);
  if (!v.ok) return fail(v.error);
  const code = makeRoomCode();
  app.me = { pid: newId(), code, name: v.name };
  saveSeat(app.me);
  app.state = null;
  adopt(E.newRoom(code, me(), v.name));
  openNet(code);
}
function joinRoom(code, name) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return fail('Room codes are 4 letters');
  const v = validateName(name, []);
  if (!v.ok) return fail(v.error);
  app.me = { pid: newId(), code, name: v.name };
  app.state = null;
  app.joining = { name: v.name, sent: false };
  app.view = 'connecting';
  app.error = '';
  openNet(code);
  render();
  setTimeout(() => { if (app.joining && !app.state) failJoin(`No game found with code ${code}`); }, 8000);
}
function resume(seat) {
  app.me = seat;
  app.state = null;
  app.view = 'connecting';
  openNet(seat.code);
}
function failJoin(msg) {
  app.net?.close(); app.net = null; app.joining = null; app.state = null;
  app.view = 'join'; app.error = msg;
  render();
}
function fail(msg) { app.error = msg; render(); }
function leave(msg = '') {
  app.net?.close(); app.net = null; app.state = null; app.joining = null; app.me = null;
  app.pending.clear(); clearSeat();
  app.view = 'home'; app.error = msg; app.ui.sheet = null;
  render();
}

/* ---------------- effects: callouts, sounds, celebrations ---------------- */
let calloutTimer, toastTimer, celebrateTimer;
function effects(s) {
  const c = s.callout;
  if (c && c.id !== app.seenCallout) {
    app.seenCallout = c.id;
    if (hostNow() - c.at < 8000) showCallout(c);
  }
  const g = s.g;
  const key = g ? `${s.gameNo}:${g.stage}:${g.mi ?? g.i ?? g.hole ?? ''}:${g.ride?.restarts ?? ''}` : s.phase;
  if (key !== app.fxKey) {
    app.fxKey = key;
    if (g && ['reveal', 'holeResult', 'rideDone'].includes(g.stage)) sfx('applause');
    if (g?.stage === 'rideIntro' || (g?.stage === 'ride' && g.ride.restarts > 0)) sfx('horn');
    if (s.phase === 'results') sfx('applause');
  }
  if (g?.type === 'bus' && g.last?.ok && g.last.card !== app.lastCard) { app.lastCard = g.last.card; sfx('ding'); }
}
function showCallout(c) {
  const el = $('#callout');
  el.innerHTML = `<div class="callout-title">DRINK CALL!</div>${c.items.map((i) =>
    `<div class="callout-line"><div class="callout-name">${esc(i.name.toUpperCase())}</div><div class="callout-text">${esc(i.text)}!</div></div>`).join('')}
    <div class="callout-sub">${esc(c.reason)}</div><div class="muted small">tap to close</div>`;
  el.classList.add('show');
  sfx('buzz');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => el.classList.remove('show'), Math.min(7000, 3200 + 400 * c.items.length));
}
function celebrate(name) {
  const el = $('#celebrate');
  el.innerHTML = `<div class="celebrate-text">HOLE IN ONE!</div><div class="callout-name">${esc(name.toUpperCase())}</div>`;
  el.classList.add('show');
  sfx('applause'); sfx('ding');
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(() => el.classList.remove('show'), 4500);
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// Sound effects are synthesised (no audio files). Off by default.
const audio = { on: localStorage.getItem('lcl-sound') === '1', ctx: null };
function tone(freq, dur, type = 'sine', when = 0, vol = 0.15) {
  const ctx = audio.ctx, t = ctx.currentTime + when, o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(gn).connect(ctx.destination); o.start(t); o.stop(t + dur);
}
function sfx(kind) {
  if (!audio.on) return;
  try {
    audio.ctx ??= new AudioContext();
    if (kind === 'ding') { tone(880, 0.15); tone(1320, 0.35, 'sine', 0.12); }
    if (kind === 'buzz') tone(98, 0.6, 'sawtooth', 0, 0.12);
    if (kind === 'horn') for (const w of [0, 0.55]) { tone(233, 0.45, 'square', w, 0.06); tone(294, 0.45, 'square', w, 0.06); }
    if (kind === 'applause') {
      const ctx = audio.ctx, len = ctx.sampleRate * 1.8, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.3) * Math.sin((Math.PI * i) / len);
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), gn = ctx.createGain();
      f.type = 'bandpass'; f.frequency.value = 1800; gn.gain.value = 0.25;
      src.buffer = buf; src.connect(f).connect(gn).connect(ctx.destination); src.start();
    }
  } catch { /* audio is optional */ }
}

/* ---------------- rendering ---------------- */
const btnIf = (cond, label, doName, cls = 'primary', extra = '') => (cond ? `<button class="btn ${cls}" data-do="${doName}" ${extra}>${label}</button>` : '');
const hostBtn = (label, doName, cls = 'primary', extra = '') => btnIf(amHost(), label, doName, cls, extra);
const waitHost = (what) => (amHost() ? '' : `<div class="banner">Waiting for ${nm(app.state.hostId)} to ${what}…</div>`);
const timer = (deadline, total) => `<div class="timer-num center" data-deadline="${deadline}"></div><div class="timer" data-deadline="${deadline}" data-total="${total}"><i></i></div>`;
const applause = (on) => `<div class="applause ${on ? 'on' : ''}">APPLAUSE</div>`;
const badges = (pids) => (pids.length ? pids.map((p) => `<span class="badge">${nm(p)}</span>`).join(' ') : '<span class="muted">nobody</span>');
const fmtPar = (n) => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);

function render() {
  const html = screenHtml();
  const root = $('#app');
  if (html !== app.lastHtml) {
    const vals = {}, scrolls = {};
    root.querySelectorAll('input[id], textarea[id]').forEach((el) => { vals[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
    root.querySelectorAll('[data-keep-scroll]').forEach((el) => { scrolls[el.id] = el.scrollTop; });
    const focus = document.activeElement?.id;
    root.innerHTML = html;
    app.lastHtml = html;
    for (const [id, v] of Object.entries(vals)) {
      const el = document.getElementById(id);
      if (!el || !root.contains(el)) continue;
      if (el.type === 'checkbox') el.checked = el.checked || v; else if (!el.value) el.value = v;
    }
    for (const [id, top] of Object.entries(scrolls)) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
  }
  postRender();
}

function screenHtml() {
  if (app.view === 'home') return homeHtml();
  if (app.view === 'create') return formHtml('create');
  if (app.view === 'join') return formHtml('join');
  const s = app.state;
  if (app.view === 'connecting' || !s) {
    return `<section class="screen center"><div class="lights"></div><h1 class="title">Connecting…</h1>
      <div class="banner">Finding room <b>${esc(app.me?.code)}</b></div>
      <button class="btn ghost" data-do="leave">Cancel</button></section>`;
  }
  if (s.phase === 'lobby') return lobbyHtml(s);
  if (s.phase === 'terms') return termsHtml(s);
  if (s.phase === 'results') return resultsHtml(s);
  return GAME_HTML[s.g.type](s, s.g);
}

function homeHtml() {
  const old = readSeat(localStorage);
  return `<section class="screen center">
    <div class="lights"></div>
    <h1 class="logo"><span>LAST CALL</span><span>LIVE!</span></h1>
    <p class="lead">The game show where everybody loses (their dignity).</p>
    ${app.error ? `<div class="banner warn">${esc(app.error)}</div>` : ''}
    <button class="btn primary" data-do="goCreate">Create Game</button>
    <button class="btn secondary" data-do="goJoin">Join Game</button>
    ${old ? `<button class="btn ghost" data-do="rejoin">Rejoin ${esc(old.code)} as ${esc(old.name)}</button>` : ''}
    <p class="muted small">For adults of legal drinking age. Water counts. Nobody has to drink to play.</p>
  </section>`;
}

function formHtml(kind) {
  const join = kind === 'join';
  return `<section class="screen">
    <div class="marquee center"><h1 class="title">${join ? 'Join a Game' : 'Host a Game'}</h1></div>
    ${app.error ? `<div class="banner warn">${esc(app.error)}</div>` : ''}
    <form class="stack" data-form="${kind}">
      ${join ? `<label class="stack"><span class="subtitle">Room code</span><input id="f-code" class="field code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(app.prefillCode || '')}" required></label>` : ''}
      <label class="stack"><span class="subtitle">Your name</span><input id="f-name" class="field" maxlength="12" autocomplete="nickname" placeholder="1–12 characters" required></label>
      <button class="btn primary" type="submit">${join ? 'Join' : 'Create Room'}</button>
    </form>
    <button class="btn ghost" data-do="home">Back</button>
  </section>`;
}

function lobbyHtml(s) {
  const host = amHost(), G = E.GAMES[s.game], lvl = LEVELS.find((l) => l.id === s.difficulty);
  const shotRule = ['sending', 'blackout', 'alcoholism'].includes(s.difficulty) ? ' · every 3rd unit is a shot' : '';
  const mine = s.custom.filter((c) => c.authorId === me());
  const count = (k) => s.custom.filter((c) => c.kind === k).length;
  const link = `${location.origin}${location.pathname}?room=${s.code}`;
  return `<section class="screen">
    <div class="marquee center"><div class="small">ROOM CODE</div><div class="room-code">${esc(s.code)}</div>
      <div class="small">Friends join at <b>${esc(link.replace(/^https?:\/\//, ''))}</b></div></div>
    <div class="panel"><h2 class="subtitle">Contestants ${s.players.length}/12</h2>
      <ul class="player-list">${s.players.map((p) => `<li class="player"><span>${esc(p.name)}</span><span class="spacer"></span>
        ${p.id === s.hostId ? '<span class="badge host">HOST</span>' : ''}${p.id === me() ? '<span class="badge you">YOU</span>' : ''}
        ${app.present.has(p.id) ? '' : '<span class="badge off">AWAY</span>'}
        ${host && p.id !== s.hostId ? `<button class="btn small ghost" data-do="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</li>`).join('')}</ul></div>
    <div class="panel"><h2 class="subtitle">Tonight's Game</h2>
      <div class="chips">${Object.entries(E.GAMES).map(([id, g]) => `<button class="chip ${s.game === id ? 'on' : ''}" data-do="setGame" data-id="${id}" ${host ? '' : 'disabled'}>${g.name}</button>`).join('')}</div>
      <p class="muted">${esc(G.blurb)} (${G.min}+ players)</p>
      ${s.game === 'wheel' ? `<h2 class="subtitle">Laps</h2><div class="chips">${[1, 2, 3, 4, 5].map((n) => `<button class="chip ${s.laps === n ? 'on' : ''}" data-do="setLaps" data-id="${n}" ${host ? '' : 'disabled'}>${n}</button>`).join('')}</div>` : ''}
    </div>
    <div class="panel"><h2 class="subtitle">Drinking Difficulty</h2>
      <div class="chips">${LEVELS.map((l) => `<button class="chip ${s.difficulty === l.id ? 'on' : ''}" data-do="setDifficulty" data-id="${l.id}" ${host ? '' : 'disabled'}>${l.name}</button>`).join('')}</div>
      <p class="muted">1 unit = ${esc(lvl.per)}${shotRule}</p></div>
    ${host ? `<button class="btn primary" data-do="openTerms" ${s.players.length < G.min ? 'disabled' : ''}>Sign the Contract →</button>
      ${s.players.length < G.min ? `<p class="muted center">Need ${G.min - s.players.length} more player(s).</p>` : ''}` : waitHost('pick a game')}
    <div class="panel"><h2 class="subtitle">Write Your Own</h2>
      <div class="chips"><button class="chip ${app.ui.promptKind === 'quip' ? 'on' : ''}" data-do="promptKind" data-id="quip">Quip prompt</button>
        <button class="chip ${app.ui.promptKind === 'nhie' ? 'on' : ''}" data-do="promptKind" data-id="nhie">Never Have I Ever</button></div>
      <input id="custom-text" class="field" maxlength="110" placeholder="${app.ui.promptKind === 'quip' ? 'e.g. The worst name for a cocktail: ___' : 'e.g. …fallen asleep at a party'}">
      <button class="btn secondary small" data-do="addPrompt">Add to the deck</button>
      <p class="muted small">Room deck: ${plural(count('quip'), 'custom prompt')} · ${plural(count('nhie'), 'custom confession')}. This session only.</p>
      ${mine.length ? `<ul class="small">${mine.map((c) => `<li>${c.kind === 'quip' ? 'Quip' : 'NHIE'}: ${esc(c.text)}</li>`).join('')}</ul>` : ''}</div>
    <div class="row"><button class="btn ghost small" data-do="summary">Session summary</button><span class="spacer"></span><button class="btn ghost small" data-do="leave">Leave room</button></div>
  </section>`;
}

function termsHtml(s) {
  const t = TERMS[s.terms.game], key = `${s.code}-${s.gameNo + 1}`;
  const signed = !!s.terms.signed[me()], read = app.ui.read === key, waived = app.ui.waived === key;
  const done = s.players.filter((p) => s.terms.signed[p.id]), waiting = s.players.filter((p) => !s.terms.signed[p.id]);
  return `<section class="screen">
    <h1 class="title center">TERMS &amp; CONDITIONS</h1>
    <div class="terms" id="terms-${key}" data-keep-scroll tabindex="0">
      <h3>${esc(t.title)}</h3>${t.clauses.map((c) => `<p>${esc(c)}</p>`).join('')}
      <p class="fine">This agreement is binding in no jurisdiction whatsoever. Drink responsibly: water and soft drinks count, and nobody has to drink to play.</p>
      <p class="fine center">— END OF DOCUMENT —</p></div>
    ${signed ? '<div class="banner">✓ Signed. Your liver has been notified.</div>' : `
      ${read ? '' : '<p class="muted small center">Scroll to the bottom to unlock your signature.</p>'}
      <label class="check"><input type="checkbox" id="waive-${key}" data-do="waive" ${read ? '' : 'disabled'} ${waived ? 'checked' : ''}><span>${esc(t.waiver)}</span></label>
      <button class="btn primary" data-do="sign" ${read && waived ? '' : 'disabled'}>I Agree</button>`}
    <div class="panel"><h2 class="subtitle">Signatures ${done.length}/${s.players.length}</h2>
      <div class="signatures">${done.map((p) => `<div>${esc(p.name)}</div>`).join('') || '<span class="muted">No signatures yet</span>'}</div>
      ${waiting.length ? `<p class="muted">Waiting on: ${waiting.map((p) => esc(p.name)).join(', ')}</p>` : ''}</div>
    ${amHost() ? `<button class="btn secondary" data-do="startGame" ${waiting.length ? 'disabled' : ''}>Start ${esc(E.GAMES[s.terms.game].name)}</button>
      <button class="btn ghost small" data-do="toLobby">Back to lobby</button>` : waitHost('start the game')}
  </section>`;
}

function resultsHtml(s) {
  const r = s.results, sign = r.higherBetter ? -1 : 1;
  const rows = [...r.players].sort((a, b) => sign * (r.scores[a] - r.scores[b]));
  const score = (p) => (r.game === 'golf' ? fmtPar(r.scores[p]) : r.scores[p]);
  return `<section class="screen">
    <div class="marquee center"><h1 class="title">${esc(E.GAMES[r.game].name)}</h1><div class="subtitle">RESULTS</div></div>
    ${applause(true)}
    <div class="awards">${r.awards.map(awardHtml).join('')}</div>
    <table class="board"><tr><th>Player</th><th class="num">${esc(r.label)}</th><th class="num">Units</th></tr>
      ${rows.map((p) => `<tr class="${p === me() ? 'me' : ''}"><td>${nm(p)}</td><td class="num">${score(p)}</td><td class="num">${r.units[p]}</td></tr>`).join('')}</table>
    ${hostBtn('Back to the lobby', 'toLobby')}${waitHost('head back to the lobby')}
    <button class="btn ghost" data-do="summary">Session summary</button>
  </section>`;
}
const awardHtml = (a) => `<div class="award"><div class="award-title">${esc(a.title)}</div><div class="award-name">${a.pids.map(nm).join(' &amp; ')}</div><div class="award-why">${esc(a.why)}</div></div>`;

/* ---------------- game screens ---------------- */
function quipHtml(s, g) {
  const head = `<div class="row"><span class="chip on">Round ${g.round}/2</span>${g.round === 2 ? '<span class="chip">DOUBLE POINTS + UNITS</span>' : ''}</div>`;
  const playing = g.players.includes(me());
  if (g.stage === 'answer') {
    const waiting = g.players.filter((p) => !g.submitted[p]);
    const mine = g.matchups.map((m, i) => [m, i]).filter(([m]) => m.a === me() || m.b === me());
    return `<section class="screen">${head}<h1 class="title">Write your answers</h1>${timer(g.deadline, E.T.answer)}
      ${!playing ? '<div class="banner">The contestants are writing…</div>'
        : g.submitted[me()] ? `<div class="banner">Locked in! Waiting for ${badges(waiting)}</div>`
        : `${mine.map(([m, i]) => `<div class="prompt">${esc(m.prompt.text)}${m.prompt.author ? `<div class="muted small">— prompt by ${esc(m.prompt.author)}</div>` : ''}</div>
            <textarea class="field" id="ans-${s.gameNo}-${g.round}-${i}" data-ans="${i}" maxlength="80" rows="2" placeholder="Your funniest answer"></textarea>`).join('')}
          <button class="btn primary" data-do="quipSubmit">Lock it in</button>`}
    </section>`;
  }
  const m = g.matchups[g.mi];
  const promptBox = `<div class="muted center">Matchup ${g.mi + 1} of ${g.matchups.length}</div><div class="prompt">${esc(m.prompt.text)}${m.prompt.author ? `<div class="muted small">— prompt by ${esc(m.prompt.author)}</div>` : ''}</div>`;
  if (g.stage === 'vote') {
    const voters = E.quipVoters(g), mineVote = g.votes[me()], author = m.a === me() || m.b === me();
    return `<section class="screen">${head}${promptBox}${timer(g.deadline, E.T.vote)}
      ${['a', 'b'].map((k) => `<button class="vote-option ${mineVote === k ? 'on' : ''}" data-do="quipVote" data-id="${k}" ${voters.includes(me()) ? '' : 'disabled'}>${esc(k === 'a' ? m.ansA : m.ansB)}</button>`).join('<div class="center subtitle">VS</div>')}
      ${author ? '<div class="banner">One of these is yours. Keep a straight face.</div>'
        : !playing ? '<div class="banner">Spectating</div>'
        : mineVote ? `<div class="banner">Vote cast! Waiting for ${badges(voters.filter((v) => !g.votes[v]))}</div>` : '<p class="muted center">Tap the funnier answer.</p>'}
    </section>`;
  }
  const L = g.last;
  const side = (k) => {
    const K = k.toUpperCase(), votes = L['votes' + K], pts = L['points' + K], drinks = L['drinks' + K];
    return `<div class="answer ${L.result === K ? 'win' : L.result === 'tie' ? '' : 'lose'}">
      <div class="prompt">${esc(k === 'a' ? m.ansA : m.ansB)}</div>
      <div class="small">by <b>${nm(m[k])}</b> · ${plural(votes.length, 'vote')} · +${pts} pts${drinks ? ` · drinks ${plural(drinks, 'unit')}` : ''}</div>
      <div class="voters">${badges(votes)}</div></div>`;
  };
  return `<section class="screen">${head}${promptBox}${applause(true)}
    ${L.shutout ? '<div class="bus-banner">SHUTOUT!</div>' : L.result === 'tie' ? '<div class="bus-banner">DEAD HEAT!</div>' : ''}
    ${side('a')}${side('b')}
    <table class="board"><tr><th>Player</th><th class="num">Points</th></tr>
      ${[...g.players].sort((a, b) => g.points[b] - g.points[a]).map((p) => `<tr class="${p === me() ? 'me' : ''}"><td>${nm(p)}</td><td class="num">${g.points[p]}</td></tr>`).join('')}</table>
    ${hostBtn('Next', 'next')}${waitHost('continue')}
  </section>`;
}

function nhieHtml(s, g) {
  const st = g.list[g.i], playing = g.players.includes(me());
  const card = `<div class="muted center">Statement ${g.i + 1} of ${g.list.length}</div>
    <div class="prompt center">${esc(st.text)}${st.author ? `<div class="muted small">— submitted by ${esc(st.author)}</div>` : ''}</div>`;
  if (g.stage === 'ask') {
    const mine = g.answers[me()], waiting = g.players.filter((p) => !(p in g.answers));
    return `<section class="screen"><h1 class="title center">Never Have I Ever</h1>${card}${timer(g.deadline, E.T.ask)}
      ${playing ? `<div class="grid2"><button class="btn danger ${mine === true ? 'on' : ''}" data-do="nhie" data-id="1" aria-pressed="${mine === true}">I Have</button>
        <button class="btn secondary ${mine === false ? 'on' : ''}" data-do="nhie" data-id="0" aria-pressed="${mine === false}">Never</button></div>
        ${mine === undefined ? '<p class="muted center">Your answer is private until everyone has answered.</p>' : `<div class="banner">You said <b>${mine ? 'I HAVE' : 'NEVER'}</b>. Waiting for ${badges(waiting)}</div>`}`
        : '<div class="banner">Spectating</div>'}
    </section>`;
  }
  const L = g.last;
  return `<section class="screen"><h1 class="title center">Never Have I Ever</h1>${card}${applause(true)}
    ${L.lone ? `<div class="bus-banner">STORY TIME! ${nm(L.lone)} must explain — 2 units</div>` : ''}
    <div class="panel"><h2 class="subtitle">I Have (${L.have.length})</h2><div class="voters">${badges(L.have)}</div></div>
    <div class="panel"><h2 class="subtitle">Never (${L.never.length})</h2><div class="voters">${badges(L.never)}</div></div>
    ${hostBtn(g.i + 1 >= g.list.length ? 'Final results' : 'Next statement', 'next')}${waitHost('continue')}
  </section>`;
}

function golfHtml(s, g) {
  const h = HOLES[g.hole];
  if (g.stage === 'holeResult') {
    const rows = [...g.players].sort((a, b) => g.totals[a] - g.totals[b]);
    return `<section class="screen"><div class="marquee center"><h1 class="title">After Hole ${g.hole + 1}</h1><div class="small">${esc(h.name)} · Par ${h.par}</div></div>
      ${applause(true)}
      <table class="board"><tr><th>Player</th><th class="num">Hole</th><th class="num">Total</th></tr>
        ${rows.map((p) => `<tr class="${g.board.losers.includes(p) ? 'drink' : ''} ${p === me() ? 'me' : ''}"><td>${nm(p)}${g.balls[p].picked ? ' <span class="badge off">picked up</span>' : ''}</td>
          <td class="num">${g.balls[p].score}</td><td class="num">${fmtPar(g.totals[p])}</td></tr>`).join('')}</table>
      <p class="muted center">Bottom 25% drink: ${g.board.losers.map(nm).join(', ')}</p>
      ${hostBtn(g.hole === HOLES.length - 1 ? 'Final results' : 'Next hole', 'next')}${waitHost('tee up the next hole')}
    </section>`;
  }
  const yours = g.turn === me();
  return `<section class="screen">
    <div class="golf-hud row"><span class="chip on">Hole ${g.hole + 1}/9</span><span class="chip">Par ${h.par}</span><span class="chip">Max ${h.par + 3}</span></div>
    <div class="subtitle center">${esc(h.name)}</div>
    <div class="banner" id="golf-banner">${!g.turn ? 'Hole complete!' : yours ? '<b>Your shot!</b> Drag back from your ball, release to putt.' : `${nm(g.turn)} is lining up…`}</div>
    <div class="golf-wrap" id="golf-slot"></div>
    <table class="board"><tr><th>Player</th><th class="num">Strokes</th><th class="num">Total</th></tr>
      ${g.players.map((p, i) => `<tr class="${p === me() ? 'me' : ''}"><td><span style="color:${COLORS[i % COLORS.length]}">●</span> ${nm(p)}${g.balls[p].done ? (g.balls[p].picked ? ' <span class="badge off">picked up</span>' : ' <span class="badge signed">in</span>') : ''}</td>
        <td class="num">${g.balls[p].strokes}</td><td class="num">${fmtPar(g.totals[p])}</td></tr>`).join('')}</table>
    ${amHost() && g.turn && !yours ? `<button class="btn ghost small" data-do="skipTurn">Pick up for ${nm(g.turn)}</button>` : ''}
  </section>`;
}

const SUIT = { H: '♥', D: '♦', C: '♣', S: '♠' };
const RANK = (r) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[r] ?? String(r);
const cardHtml = (c, cls = '') => (c ? `<div class="card ${isRed(c) ? 'red' : ''} ${cls}" aria-label="${RANK(c.r)} of ${SUIT[c.s]}"><b>${RANK(c.r)}</b><span>${SUIT[c.s]}</span></div>` : '<div class="card back" aria-label="face-down card"></div>');
const GUESS_LABEL = { red: 'Red', black: 'Black', higher: 'Higher', lower: 'Lower', inside: 'Inside', outside: 'Outside', H: '♥ Hearts', D: '♦ Diamonds', C: '♣ Clubs', S: '♠ Spades' };
const QUESTIONS = { 1: ['Red or black?', ['red', 'black']], 2: ['Higher or lower than card 1?', ['higher', 'lower']], 3: ['Inside or outside cards 1 & 2?', ['inside', 'outside']], 4: ['Name the suit!', ['H', 'D', 'C', 'S']] };

function busHtml(s, g) {
  const L = g.last;
  const lastLine = L ? `<div class="banner ${L.ok ? '' : 'warn'}">${nm(L.pid)} said <b>${esc(GUESS_LABEL[L.guess])}</b> — ${RANK(L.card.r)}${SUIT[L.card.s]} — ${L.ok ? 'CORRECT!' : 'WRONG!'}</div>` : '';
  const stats = `<table class="board"><tr><th>Player</th><th class="num">Wrong</th><th class="num">Units</th></tr>
    ${g.players.map((p) => `<tr class="${p === me() ? 'me' : ''}"><td>${nm(p)}</td><td class="num">${g.stats[p].wrong}</td><td class="num">${g.stats[p].units}</td></tr>`).join('')}</table>`;
  const prev = g.prev && !g.cards.length ? `<div class="muted small center">${nm(g.prev.pid)}'s last run</div><div class="cards">${g.prev.cards.map((c, i) => cardHtml(c, i === g.prev.cards.length - 1 && L && !L.ok ? 'wrong' : '')).join('')}</div>` : '';
  if (g.stage === 'rideIntro') {
    return `<section class="screen center"><div class="bus-banner">ALL ABOARD!</div><h1 class="title">${nm(g.rider)} rides the bus</h1>
      <p class="lead">Most wrong guesses. Get 4 right in a row to get off — every miss is 1 unit and back to the start.</p>
      ${prev}${stats}${hostBtn('Board the bus', 'next')}${waitHost('start the ride')}</section>`;
  }
  if (g.stage === 'rideDone') {
    return `<section class="screen center"><div class="bus-banner">${g.offByValve ? 'SAFETY VALVE!' : 'OFF THE BUS!'}</div>${applause(true)}
      <h1 class="title">${nm(g.rider)} ${g.offByValve ? 'was let off the bus' : 'made it off'}</h1>
      <p class="lead">${plural(g.ride.restarts, 'stop')} on the bus.</p>
      <div class="cards">${(g.cards.length ? g.cards : g.prev?.cards ?? []).map((c) => cardHtml(c)).join('')}</div>
      ${hostBtn('Results', 'next')}${waitHost('show the results')}</section>`;
  }
  const ride = g.stage === 'ride', active = ride ? g.rider : g.players[g.ti], stage = ride ? g.ride.stage : g.gs;
  const [q, opts] = QUESTIONS[stage];
  return `<section class="screen center">
    ${ride ? `<div class="bus-banner">${nm(g.rider)} IS ON THE BUS</div><div class="bus-stop">STOP #${g.ride.restarts + 1}</div>`
      : `<h1 class="title">Ride the Bus</h1><div class="muted">${nm(active)}'s turn (${g.ti + 1}/${g.players.length}) · guess ${stage}/4</div>`}
    <div class="cards">${[0, 1, 2, 3].map((i) => cardHtml(g.cards[i], i === g.cards.length - 1 && L?.ok ? 'right' : '')).join('')}</div>
    ${lastLine}${prev}
    ${active === me() ? `<h2 class="subtitle">${q}</h2><div class="grid2">${opts.map((v) => `<button class="btn card-btn ${['red', 'H', 'D'].includes(v) ? 'danger' : 'secondary'}" data-do="busGuess" data-id="${v}">${GUESS_LABEL[v]}</button>`).join('')}</div>`
      : `<div class="banner">${nm(active)}: ${q}</div>`}
    ${ride ? '' : stats}
    ${amHost() && active !== me() ? `<button class="btn ghost small" data-do="skipTurn">Skip ${nm(active)}</button>` : ''}
  </section>`;
}

function wheelHtml(s, g) {
  const sp = g.spinner, mine = sp === me(), others = g.players.filter((p) => p !== sp);
  let status = '', controls = '';
  if (g.stage === 'spin') { status = mine ? '<b>Your spin!</b>' : `${nm(sp)} is up to spin`; if (mine) controls = '<button class="btn primary" data-do="wheelSpin">SPIN!</button>'; }
  else if (g.stage === 'spinning') status = `${nm(sp)} spun the wheel…`;
  else if (g.stage === 'pick') {
    status = `${nm(sp)} picks who drinks ${plural(g.pending.total, 'unit')}`;
    if (mine) controls = `<div class="grid2">${others.map((p) => `<button class="btn secondary" data-do="wheelPick" data-id="${esc(p)}">${nm(p)}</button>`).join('')}</div>`;
  } else if (g.stage === 'handout') {
    const total = g.pending.total;
    status = `${nm(sp)} hands out ${plural(total, 'unit')}`;
    if (mine) {
      const alloc = (app.ui.alloc[`${s.gameNo}-${g.spinNo}`] ??= {});
      const used = Object.values(alloc).reduce((a, b) => a + b, 0);
      controls = `<div class="panel stack">${others.map((p) => `<div class="row"><span>${nm(p)}</span><span class="spacer"></span>
          <button class="btn small ghost" data-do="handout" data-id="${esc(p)}" data-d="-1" ${alloc[p] ? '' : 'disabled'} aria-label="One less for ${nm(p)}">−</button>
          <b class="timer-num">${alloc[p] ?? 0}</b>
          <button class="btn small ghost" data-do="handout" data-id="${esc(p)}" data-d="1" ${used >= total ? 'disabled' : ''} aria-label="One more for ${nm(p)}">+</button></div>`).join('')}
        <p class="muted">${total - used} left to hand out</p>
        <button class="btn primary" data-do="handoutGo" ${used === total ? '' : 'disabled'}>Hand them out</button></div>`;
    }
  } else if (g.stage === 'over') status = 'That was the last spin!';
  const lastLine = g.last && g.stage !== 'spinning' ? `<div class="banner">${nm(g.last.spinner)} landed on <b>${esc(g.last.label)}</b>${g.last.mult > 1 ? ` ×${g.last.mult}` : ''}</div>` : '';
  return `<section class="screen center"><h1 class="title">Wheel of Misfortune</h1>
    <div class="row" style="justify-content:center"><span class="chip on">Spin ${Math.min(g.turnNo + 1, g.turns)}/${g.turns}</span>${g.mult > 1 ? `<span class="chip">NEXT SPIN ×${g.mult}</span>` : ''}</div>
    <div class="wheel-wrap" id="wheel-slot"><div class="wheel-pointer"></div></div>
    ${lastLine}<div class="banner">${status}</div>${controls}
    ${amHost() && !mine && ['spin', 'pick', 'handout'].includes(g.stage) ? `<button class="btn ghost small" data-do="skipTurn">Skip ${nm(sp)}</button>` : ''}
  </section>`;
}
const GAME_HTML = { quip: quipHtml, nhie: nhieHtml, golf: golfHtml, bus: busHtml, wheel: wheelHtml };

/* ---------------- sheets: tally + session summary ---------------- */
function tallyRows(s) {
  return s.players.map((p) => {
    const list = s.drinks.filter((d) => d.pid === p.id);
    return { p, list, units: list.reduce((a, d) => a + d.units, 0), shots: list.reduce((a, d) => a + d.shots, 0) };
  }).sort((a, b) => b.units - a.units);
}
function tallyHtml(s) {
  const rows = tallyRows(s), lvl = LEVELS.find((l) => l.id === s.difficulty);
  return `<h2 class="title">Drink Tally</h2><p class="muted">Now playing at ${esc(lvl.name)} (1 unit = ${esc(lvl.per)})</p>
    <table class="board"><tr><th>Player</th><th class="num">Units</th><th class="num">Shots</th></tr>
      ${rows.map((r) => `<tr class="${r.p.id === me() ? 'me' : ''}"><td>${esc(r.p.name)}</td><td class="num">${r.units}</td><td class="num">${r.shots}</td></tr>`).join('')}</table>
    ${rows.filter((r) => r.list.length).map((r) => `<details><summary>${esc(r.p.name)} — ${plural(r.list.length, 'call')}</summary>
      <ol class="small">${r.list.map((d) => `<li>${esc(d.text)} — ${esc(E.GAMES[d.game]?.name ?? '')}: ${esc(d.reason)}</li>`).join('')}</ol></details>`).join('')}
    <button class="btn" data-do="closeSheet">Close</button>`;
}
function summaryHtml(s) {
  const rows = tallyRows(s);
  let awards = '';
  if (rows.length && s.drinks.length) {
    const max = rows[0].units, min = rows.at(-1).units;
    const losers = {};
    for (const h of s.history) for (const a of h.awards) if (a.key === 'biggestLoser') for (const p of a.pids) losers[p] = (losers[p] ?? 0) + 1;
    const topL = Math.max(0, ...Object.values(losers));
    const list = [
      { title: 'Liver MVP', pids: rows.filter((r) => r.units === max).map((r) => r.p.id), why: `${max} units · ${AWARD_BLURBS.liverMvp}` },
      { title: 'Most Hydrated', pids: rows.filter((r) => r.units === min).map((r) => r.p.id), why: `${min} units · ${AWARD_BLURBS.mostHydrated}` },
    ];
    if (topL) list.push({ title: 'Biggest Loser', pids: Object.keys(losers).filter((p) => losers[p] === topL), why: `Lost ${plural(topL, 'game')} · ${AWARD_BLURBS.biggestLoser}` });
    awards = `<div class="awards">${list.map(awardHtml).join('')}</div>`;
  } else awards = '<p class="muted">No drinks yet. Suspicious.</p>';
  return `<h2 class="title">Session Summary</h2>${awards}
    ${s.history.map((h) => `<div class="panel"><h2 class="subtitle">Game ${h.gn}: ${esc(E.GAMES[h.game].name)}</h2>
      <ul class="small">${h.awards.map((a) => `<li><b>${esc(a.title)}</b>: ${a.pids.map(nm).join(' & ')} (${esc(a.why)})</li>`).join('')}</ul></div>`).join('')}
    <h2 class="subtitle">Tally</h2>
    <table class="board"><tr><th>Player</th><th class="num">Units</th><th class="num">Shots</th></tr>
      ${rows.map((r) => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.units}</td><td class="num">${r.shots}</td></tr>`).join('')}</table>
    <button class="btn" data-do="closeSheet">Close</button>`;
}

/* ---------------- post-render: topbar, timers, terms gate, canvas, wheel ---------------- */
function postRender() {
  const s = app.state, inRoom = app.view === 'room' && s;
  $('#tb-room').textContent = inRoom ? s.code : '';
  $('#tb-room').classList.toggle('hidden', !inRoom);
  $('#tb-tally').classList.toggle('hidden', !inRoom);
  const snd = $('#tb-sound');
  snd.textContent = audio.on ? '🔊' : '🔇';
  snd.classList.toggle('on', audio.on);
  snd.setAttribute('aria-pressed', String(audio.on));
  snd.setAttribute('aria-label', audio.on ? 'Sound effects on' : 'Sound effects off');
  const sheet = $('#sheet');
  if (inRoom && app.ui.sheet) {
    const html = app.ui.sheet === 'tally' ? tallyHtml(s) : summaryHtml(s);
    if ($('#sheet-body').dataset.html !== html) { $('#sheet-body').innerHTML = html; $('#sheet-body').dataset.html = html; }
  }
  sheet.classList.toggle('show', !!(inRoom && app.ui.sheet));
  const terms = $('.terms');
  if (terms && !terms.dataset.bound) {
    terms.dataset.bound = '1';
    terms.addEventListener('scroll', checkTermsRead, { passive: true });
    requestAnimationFrame(checkTermsRead);
  }
  updateTimers();
  if (s?.g?.type === 'golf' && s.g.stage === 'play') golfMount(s);
  if (s?.g?.type === 'wheel') wheelMount(s);
}
function checkTermsRead() {
  const t = $('.terms'), s = app.state;
  if (!t || s?.phase !== 'terms') return;
  const key = `${s.code}-${s.gameNo + 1}`;
  if (app.ui.read !== key && t.scrollTop + t.clientHeight >= t.scrollHeight - 12) { app.ui.read = key; render(); }
}
function updateTimers() {
  const now = hostNow();
  document.querySelectorAll('#app [data-deadline]').forEach((el) => {
    const rem = Math.max(0, Number(el.dataset.deadline) - now);
    if (el.classList.contains('timer')) el.firstElementChild.style.width = `${Math.min(100, (rem / Number(el.dataset.total)) * 100)}%`;
    else el.textContent = Math.ceil(rem / 1000);
  });
  // submit typed quip answers just before the buzzer instead of losing them
  const s = app.state, g = s?.g;
  if (g?.type === 'quip' && g.stage === 'answer' && g.players.includes(me()) && !g.submitted[me()] && g.deadline - now < 1500) {
    const key = `${s.gameNo}-${g.round}`;
    if (!app.autoSent[key]) { app.autoSent[key] = true; DO.quipSubmit(); }
  }
}

/* ---------------- golf canvas ---------------- */
const COLORS = ['#ffffff', '#f2c14e', '#4fd1c5', '#ff8a80', '#b794f4', '#90cdf4', '#fbd38d', '#9ae6b4', '#feb2b2', '#e9d8fd', '#f6ad55', '#81e6d9'];
const golf = { canvas: null, ctx: null, key: '', anim: null, aim: null, raf: 0, sentAt: 0 };
function golfMount(s) {
  const slot = $('#golf-slot');
  if (!slot) return;
  if (!golf.canvas) {
    const c = (golf.canvas = document.createElement('canvas'));
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Mini-golf course. On your turn, drag back from your ball and release to shoot.');
    golf.ctx = c.getContext('2d');
    c.addEventListener('pointerdown', golfDown);
    c.addEventListener('pointermove', (e) => { if (golf.aim) { golf.aim = golfPoint(e); e.preventDefault(); } });
    c.addEventListener('pointerup', golfUp);
    c.addEventListener('pointercancel', () => { golf.aim = null; });
  }
  if (golf.canvas.parentNode !== slot) slot.appendChild(golf.canvas);
  const g = s.g, key = `${s.code}-${s.gameNo}-${g.shot?.no}`;
  if (g.shot && key !== golf.key) {
    golf.key = key;
    if (hostNow() < g.busyUntil) golf.anim = { shot: g.shot, start: performance.now() };
  }
  if (!golf.raf) golf.raf = requestAnimationFrame(drawGolf);
}
function golfPoint(e) {
  const r = golf.canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}
function canShoot() {
  const g = app.state?.g;
  return g?.type === 'golf' && g.stage === 'play' && g.turn === me() && !golf.anim && hostNow() >= g.busyUntil && Date.now() - golf.sentAt > 4000;
}
function golfDown(e) {
  if (!canShoot()) return;
  golf.aim = golfPoint(e);
  golf.canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}
function golfShotVector() {
  const b = app.state.g.balls[me()];
  const dx = b.x - golf.aim.x, dy = b.y - golf.aim.y;
  return { b, angle: Math.atan2(dy, dx), power: Math.min(1, Math.hypot(dx, dy) / 45) };
}
function golfUp() {
  if (!golf.aim) return;
  const v = golfShotVector();
  golf.aim = null;
  if (!canShoot() || v.power < 0.05) return;
  golf.sentAt = Date.now();
  act({ type: 'golfShot', angle: v.angle, power: v.power, t: performance.now() / 1000 });
}
function drawGolf() {
  golf.raf = 0;
  const c = golf.canvas, s = app.state, g = s?.g;
  if (!c?.isConnected || g?.type !== 'golf') return;
  golf.raf = requestAnimationFrame(drawGolf);
  // size: fit the slot width, capped by 64% of the viewport height
  const box = c.parentNode.getBoundingClientRect();
  const cssW = Math.min(box.width, (innerHeight * 0.64 * W) / H), dpr = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== Math.round(cssW * dpr)) {
    c.width = Math.round(cssW * dpr); c.height = Math.round((cssW * dpr * H) / W);
    c.style.width = `${cssW}px`; c.style.height = `${(cssW * H) / W}px`;
  }
  const ctx = golf.ctx, h = HOLES[g.hole], k = c.width / W;
  let t = performance.now() / 1000, animPos = null;
  const a = golf.anim;
  if (a) {
    const el = (performance.now() - a.start) / 1000, i = Math.floor(el * 30);
    if (i >= a.shot.path.length) { golf.anim = null; golfShotDone(a.shot); }
    else { animPos = a.shot.path[i]; t = a.shot.t0 + el; }
  }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (let y = 0; y < H; y += 10) { ctx.fillStyle = (y / 10) % 2 ? '#2f7d3b' : '#36894a'; ctx.fillRect(0, y, W, 10); }
  const rects = (list, fill, stroke) => list.forEach((r) => { ctx.fillStyle = fill; ctx.fillRect(r.x, r.y, r.w, r.h); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.5; ctx.strokeRect(r.x, r.y, r.w, r.h); } });
  rects(h.sand, '#e3c77f');
  rects(h.water, '#2b78b5', '#5aa7de');
  rects(h.walls, '#7a4a24', '#3b220f');
  rects(h.movers.map((m) => moverRect(m, t)), '#1a7f7a', '#f2c14e');
  for (const b of h.bumpers) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fillStyle = '#b3261e'; ctx.fill(); ctx.lineWidth = 0.8; ctx.strokeStyle = '#f2c14e'; ctx.stroke(); }
  ctx.fillStyle = '#fff3d6'; ctx.fillRect(h.tee.x - 3, h.tee.y - 1, 6, 2);
  ctx.beginPath(); ctx.arc(h.cup.x, h.cup.y, CUP_R, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
  ctx.strokeStyle = '#fff3d6'; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(h.cup.x, h.cup.y); ctx.lineTo(h.cup.x, h.cup.y - 11); ctx.stroke();
  ctx.fillStyle = '#d7263d'; ctx.beginPath(); ctx.moveTo(h.cup.x, h.cup.y - 11); ctx.lineTo(h.cup.x + 7, h.cup.y - 8.5); ctx.lineTo(h.cup.x, h.cup.y - 6); ctx.fill();
  ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  g.players.forEach((p, i) => {
    const b = g.balls[p];
    const pos = a && a.shot.pid === p && animPos ? animPos : b.done ? null : [b.x, b.y];
    if (!pos) return;
    if (p === g.turn && !a) { ctx.beginPath(); ctx.arc(pos[0], pos[1], BALL_R + 1.2 + Math.sin(t * 6) * 0.4, 0, Math.PI * 2); ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 0.5; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(pos[0], pos[1], BALL_R, 0, Math.PI * 2); ctx.fillStyle = COLORS[i % COLORS.length]; ctx.fill();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 0.3; ctx.stroke();
  });
  if (golf.aim && g.turn === me()) {
    const v = golfShotVector(), len = 8 + v.power * 30;
    ctx.setLineDash([1.5, 1.5]); ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(v.b.x, v.b.y); ctx.lineTo(v.b.x + Math.cos(v.angle) * len, v.b.y + Math.sin(v.angle) * len); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(v.b.x, v.b.y); ctx.lineTo(golf.aim.x, golf.aim.y); ctx.stroke();
    ctx.fillStyle = '#fff3d6'; ctx.font = 'bold 4px sans-serif'; ctx.fillText(`${Math.round(v.power * 100)}%`, v.b.x + 3, v.b.y - 3);
  }
}
function golfShotDone(shot) {
  if (shot.ace) celebrate(E.nameOf(app.state, shot.pid));
  else if (shot.water) toast(`SPLASH! ${E.nameOf(app.state, shot.pid)} takes +1 stroke`);
  else if (shot.holed) { toast(`${E.nameOf(app.state, shot.pid)} sinks it!`); sfx('ding'); }
  else if (shot.picked) toast(`${E.nameOf(app.state, shot.pid)} picks up at par + 3`);
}

/* ---------------- wheel ---------------- */
const WHEEL_LABELS = { drink1: 'DRINK 1', drink2: 'DRINK 2', pick: 'PICK ONE', everyone: 'ALL DRINK', social: 'SOCIAL!', waterfall: 'WATERFALL', safe: 'SAFE', again: 'SPIN AGAIN', double: 'DOUBLE', handout: 'HAND OUT 3' };
const WHEEL_FILL = ['#8e1b1b', '#f2c14e', '#1a7f7a', '#fff3d6', '#8e1b1b', '#f2c14e', '#1a7f7a', '#fff3d6', '#c0392b', '#f2c14e'];
const wheel = { el: null, key: '', rot: 0 };
function wheelSvg() {
  const n = SLICES.length, step = 360 / n, r = 96, pt = (deg, rad) => [rad * Math.cos((deg * Math.PI) / 180), rad * Math.sin((deg * Math.PI) / 180)];
  let out = '';
  SLICES.forEach((sl, i) => {
    const [x0, y0] = pt(i * step - 90, r), [x1, y1] = pt((i + 1) * step - 90, r), dark = ['#f2c14e', '#fff3d6'].includes(WHEEL_FILL[i]);
    out += `<path d="M0 0L${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}Z" fill="${WHEEL_FILL[i]}" stroke="#3b220f" stroke-width="1"/>
      <text transform="rotate(${i * step + step / 2 - 90}) translate(58 0)" text-anchor="middle" dominant-baseline="middle" font-family="Anton, Impact, sans-serif" font-size="9.5" fill="${dark ? '#2a1208' : '#fff3d6'}">${WHEEL_LABELS[sl.id]}</text>`;
  });
  for (let i = 0; i < 20; i++) { const [x, y] = pt(i * 18, 97); out += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2" fill="#fff6c9"/>`; }
  const div = document.createElement('div');
  div.innerHTML = `<svg class="wheel" viewBox="-100 -100 200 200" role="img" aria-label="Wheel of Misfortune">${out}<circle r="13" fill="#f2c14e" stroke="#3b220f" stroke-width="2"/></svg>`;
  return div.firstElementChild;
}
function wheelMount(s) {
  const slot = $('#wheel-slot'), g = s.g;
  if (!slot) return;
  wheel.el ??= wheelSvg();
  const el = wheel.el;
  const setRot = (deg, animate) => {
    if (!animate) el.style.transition = 'none';
    el.style.transform = `rotate(${deg}deg)`;
    if (!animate) { el.getBoundingClientRect(); el.style.transition = ''; }
  };
  if (el.parentNode !== slot) { slot.prepend(el); setRot(wheel.rot, false); }
  const key = `${s.code}-${s.gameNo}-${g.spinNo}`;
  if (key === wheel.key) return;
  wheel.key = key;
  // land slice idx under the top pointer; spinNo keeps the angle increasing so it always spins forward
  wheel.rot = g.spin ? g.spinNo * 1800 + (360 - (g.spin.idx * 36 + 18)) : 0;
  setRot(wheel.rot, g.stage === 'spinning' && hostNow() < g.deadline);
}

/* ---------------- input ---------------- */
const DO = {
  home: () => { app.view = 'home'; app.error = ''; render(); },
  goCreate: () => { app.view = 'create'; app.error = ''; render(); $('#f-name')?.focus(); },
  goJoin: () => { app.view = 'join'; app.error = ''; render(); $('#f-code')?.focus(); },
  rejoin: () => { const seat = readSeat(localStorage); if (seat) { saveSeat(seat); resume(seat); render(); } },
  leave: () => { if (!app.state || confirm(amHost() ? 'Leave the room? Another player takes over as host after ~20s.' : 'Leave the room?')) leave(); },
  tally: () => { app.ui.sheet = 'tally'; render(); },
  summary: () => { app.ui.sheet = 'summary'; render(); },
  closeSheet: () => { app.ui.sheet = null; render(); },
  sound: () => { audio.on = !audio.on; localStorage.setItem('lcl-sound', audio.on ? '1' : '0'); if (audio.on) sfx('ding'); render(); },
  closeCallout: () => $('#callout').classList.remove('show'),
  closeCelebrate: () => $('#celebrate').classList.remove('show'),
  setGame: (el) => act({ type: 'setGame', game: el.dataset.id }),
  setLaps: (el) => act({ type: 'setLaps', laps: Number(el.dataset.id) }),
  setDifficulty: (el) => act({ type: 'setDifficulty', level: el.dataset.id }),
  kick: (el) => { if (confirm(`Remove ${E.nameOf(app.state, el.dataset.id)} from the room?`)) act({ type: 'kick', target: el.dataset.id }); },
  promptKind: (el) => { app.ui.promptKind = el.dataset.id; render(); },
  addPrompt: () => {
    const input = $('#custom-text'), text = input.value.trim();
    if (!text) return toast('Write something first');
    act({ type: 'addPrompt', kind: app.ui.promptKind, text });
    input.value = '';
    toast('Added to the deck!');
  },
  openTerms: () => act({ type: 'openTerms' }),
  waive: (el) => { app.ui.waived = el.checked ? `${app.state.code}-${app.state.gameNo + 1}` : null; render(); },
  sign: () => act({ type: 'sign' }),
  startGame: () => act({ type: 'startGame' }),
  toLobby: () => act({ type: 'toLobby' }),
  next: () => act({ type: 'next' }),
  skipTurn: () => act({ type: 'skipTurn' }),
  quipSubmit: () => {
    const answers = {};
    document.querySelectorAll('#app textarea[data-ans]').forEach((t) => { answers[t.dataset.ans] = t.value; });
    act({ type: 'quipAnswer', answers });
  },
  quipVote: (el) => act({ type: 'quipVote', choice: el.dataset.id }),
  nhie: (el) => act({ type: 'nhieAnswer', have: el.dataset.id === '1' }),
  busGuess: (el) => act({ type: 'busGuess', guess: el.dataset.id }),
  wheelSpin: () => act({ type: 'wheelSpin' }),
  wheelPick: (el) => act({ type: 'wheelPick', target: el.dataset.id }),
  handout: (el) => {
    const g = app.state.g, alloc = (app.ui.alloc[`${app.state.gameNo}-${g.spinNo}`] ??= {});
    alloc[el.dataset.id] = Math.max(0, (alloc[el.dataset.id] ?? 0) + Number(el.dataset.d));
    render();
  },
  handoutGo: () => { const g = app.state.g; act({ type: 'wheelHandout', alloc: app.ui.alloc[`${app.state.gameNo}-${g.spinNo}`] ?? {} }); },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-do]');
  if (!el || el.disabled) return;
  if (el.id === 'sheet' && ev.target !== el) return; // taps inside the sheet body don't close it
  DO[el.dataset.do]?.(el, ev);
});
document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const kind = ev.target.dataset.form, name = $('#f-name')?.value;
  if (kind === 'create') createRoom(name);
  if (kind === 'join') joinRoom($('#f-code')?.value, name);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && app.net && app.state && !amHost()) hello(); });

window.lcl = { app, act }; // debug/test handle (devtools cheating is out of scope)

/* ---------------- boot ---------------- */
const qsRoom = new URLSearchParams(location.search).get('room');
if (qsRoom) app.prefillCode = qsRoom.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const seat = readSeat(sessionStorage);
if (seat?.code && seat?.pid) resume(seat);
else if (app.prefillCode) app.view = 'join';
render();
// A worker clock keeps the host loop ticking when the tab is in the background (main-thread timers get throttled).
try {
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 200)'], { type: 'text/javascript' })));
  w.onmessage = () => { loop(); updateTimers(); };
} catch { setInterval(() => { loop(); updateTimers(); }, 200); }
