// Pure game rules for Last Call Live. No DOM, no imports.

export const LEVELS = [
  {id:'fun', name:'Fun Night Out', per:'1 sip'},
  {id:'tipsy', name:'Tipsy', per:'2 sips'},
  {id:'sending', name:'Sending It', per:'3 sips'},
  {id:'blackout', name:'Blackout Express', per:'half your drink'},
  {id:'alcoholism', name:'Alcoholism', per:'finish your drink'},
];

const SHOT_LEVELS = ['sending', 'blackout', 'alcoholism'];

export function drinkCallout(level, prevUnits, addUnits) {
  const shotRule = SHOT_LEVELS.includes(level);
  // Every multiple of 3 crossed by the cumulative units is a shot.
  const shots = shotRule
    ? Math.floor((prevUnits + addUnits) / 3) - Math.floor(prevUnits / 3)
    : 0;
  const n = addUnits - shots;
  const parts = [];
  if (n > 0) {
    if (level === 'fun') parts.push(n === 1 ? '1 SIP' : `${n} SIPS`);
    else if (level === 'tipsy') parts.push(`${2 * n} SIPS`);
    else if (level === 'sending') parts.push(`${3 * n} SIPS`);
    else if (level === 'blackout') parts.push(n === 1 ? 'HALF YOUR DRINK' : `HALF YOUR DRINK ×${n}`);
    else if (level === 'alcoholism') parts.push(n === 1 ? 'FINISH YOUR DRINK' : `FINISH YOUR DRINK ×${n}`);
  }
  if (shots > 0) parts.push(shots === 1 ? '1 SHOT' : `${shots} SHOTS`);
  return {text: parts.join(' + '), shots, units: addUnits};
}

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O

export function makeRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return code;
}

export function validateName(name, existingNames = []) {
  if (typeof name !== 'string') return {ok:false, error:'Name must be 1–12 characters'};
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned.length < 1 || cleaned.length > 12) {
    return {ok:false, error:'Name must be 1–12 characters'};
  }
  const lower = cleaned.toLowerCase();
  if (existingNames.some(e => String(e).toLowerCase() === lower)) {
    return {ok:false, error:'That name is taken'};
  }
  return {ok:true, name:cleaned};
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function quipAssign(playerIds, deck, rng = Math.random) {
  const n = playerIds.length;
  const s = shuffle(playerIds, rng);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = s[i];
    const b = s[(i + 1) % n];
    const idx = deck.findIndex(p => p.authorId !== a && p.authorId !== b);
    const prompt = idx >= 0
      ? deck.splice(idx, 1)[0]
      : {text:'Describe tonight in exactly three words.'};
    out.push({prompt, a, b});
  }
  return out;
}

export function quipOutcome(votesA, votesB, round) {
  const mult = round === 2 ? 2 : 1;
  const pointsA = votesA * 100 * mult;
  const pointsB = votesB * 100 * mult;
  if (votesA === votesB) {
    return {pointsA, pointsB, drinksA:1 * mult, drinksB:1 * mult, result:'tie', shutout:false};
  }
  const aWins = votesA > votesB;
  const loserVotes = aWins ? votesB : votesA;
  const loserDrinks = (loserVotes === 0 ? 2 : 1) * mult;
  return {
    pointsA, pointsB,
    drinksA: aWins ? 0 : loserDrinks,
    drinksB: aWins ? loserDrinks : 0,
    result: aWins ? 'A' : 'B',
    shutout: loserVotes === 0,
  };
}

export function makeDeck() {
  const deck = [];
  for (const s of ['H', 'D', 'C', 'S']) {
    for (let r = 2; r <= 14; r++) deck.push({r, s});
  }
  return deck;
}

export const isRed = c => c.s === 'H' || c.s === 'D';

const RANK_LABELS = {11:'J', 12:'Q', 13:'K', 14:'A'};
const SUIT_SYMBOLS = {H:'♥', D:'♦', C:'♣', S:'♠'};

export function cardLabel(c) {
  return `${RANK_LABELS[c.r] || String(c.r)}${SUIT_SYMBOLS[c.s]}`;
}

export function busCheck(stage, guess, prev, card) {
  if (stage === 1) {
    return (isRed(card) ? 'red' : 'black') === guess;
  }
  if (stage === 2) {
    if (card.r === prev[0].r) return false; // equal rank is wrong
    if (guess === 'higher') return card.r > prev[0].r;
    if (guess === 'lower') return card.r < prev[0].r;
    return false;
  }
  if (stage === 3) {
    const lo = Math.min(prev[0].r, prev[1].r);
    const hi = Math.max(prev[0].r, prev[1].r);
    if (guess === 'inside') return card.r > lo && card.r < hi;
    if (guess === 'outside') return card.r < lo || card.r > hi;
    return false;
  }
  if (stage === 4) {
    return card.s === guess;
  }
  return false;
}

export const busPenalty = stage => stage; // wrong at stage N = N units

export function pickRider(stats) {
  let best = null;
  for (const s of stats) {
    if (!best || s.wrong > best.wrong || (s.wrong === best.wrong && s.units > best.units)) {
      best = s; // strict comparisons keep the earliest on a full tie
    }
  }
  return best ? best.id : null;
}

export const BUS_MAX_RESTARTS = 10;

export function busRideStep(ride, correct) {
  const {stage, restarts} = ride;
  if (correct) {
    if (stage < 4) return {stage: stage + 1, restarts, units: 0, done: false, offByValve: false};
    return {stage: 4, restarts, units: 0, done: true, offByValve: false};
  }
  const r = restarts + 1;
  if (r >= BUS_MAX_RESTARTS) {
    return {stage: 1, restarts: r, units: 1, done: true, offByValve: true};
  }
  return {stage: 1, restarts: r, units: 1, done: false, offByValve: false};
}

export const SLICES = [
 {id:'drink1', label:'You drink 1'}, {id:'drink2', label:'You drink 2'}, {id:'pick', label:'Pick someone'},
 {id:'everyone', label:'Everyone drinks 1'}, {id:'social', label:'Social!'}, {id:'waterfall', label:'Waterfall'},
 {id:'safe', label:'Safe'}, {id:'again', label:'Spin again'}, {id:'double', label:'Double or nothing'}, {id:'handout', label:'Hand out 3'},
];

export function wheelOutcome(sliceId, {spinner, players, mult}) {
  const out = {drinks:[], needs:null, handout:0, nextMult:1, spinAgain:false};
  const everyone = units => players.map(pid => ({pid, units}));
  switch (sliceId) {
    case 'drink1': out.drinks = [{pid:spinner, units:1 * mult}]; break;
    case 'drink2': out.drinks = [{pid:spinner, units:2 * mult}]; break;
    case 'pick': out.needs = 'pick'; out.handout = 1 * mult; break;
    case 'everyone':
    case 'social': out.drinks = everyone(1 * mult); break;
    case 'waterfall': out.drinks = everyone(2 * mult); break;
    case 'safe': break;
    case 'again': out.spinAgain = true; out.nextMult = mult; break;
    case 'double': out.nextMult = Math.min(mult * 2, 8); break;
    case 'handout': out.needs = 'handout'; out.handout = 3 * mult; break;
  }
  return out;
}

export function validateHandout(alloc, spinner, players, total) {
  if (!alloc || typeof alloc !== 'object') return false;
  const ids = players.map(String);
  let sum = 0;
  for (const [k, v] of Object.entries(alloc)) {
    if (!ids.includes(k) || k === String(spinner)) return false;
    if (!Number.isInteger(v) || v < 0) return false;
    sum += v;
  }
  return sum === total;
}

export function extremes(unitsByPid) {
  const entries = Object.entries(unitsByPid);
  if (entries.length === 0) {
    return {most:{pids:[], value:0}, fewest:{pids:[], value:0}};
  }
  const values = entries.map(([, v]) => v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  return {
    most: {pids: entries.filter(([, v]) => v === max).map(([k]) => k), value: max},
    fewest: {pids: entries.filter(([, v]) => v === min).map(([k]) => k), value: min},
  };
}
