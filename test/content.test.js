import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIP_PROMPTS, NHIE_STATEMENTS, TERMS, AWARD_BLURBS } from "../logic/content.js";

const GAMES = ["quip", "golf", "nhie", "bus", "wheel"];

// Every string the module exports, flattened.
function allStrings() {
  const out = [...QUIP_PROMPTS, ...NHIE_STATEMENTS, ...Object.values(AWARD_BLURBS)];
  for (const game of GAMES) {
    out.push(TERMS[game].title, TERMS[game].waiver, ...TERMS[game].clauses);
  }
  return out;
}

test("QUIP_PROMPTS has at least 90 entries", () => {
  assert.ok(QUIP_PROMPTS.length >= 90, `got ${QUIP_PROMPTS.length}`);
});

test("NHIE_STATEMENTS has at least 90 entries", () => {
  assert.ok(NHIE_STATEMENTS.length >= 90, `got ${NHIE_STATEMENTS.length}`);
});

test("all QUIP prompts and NHIE statements are unique (case-insensitive)", () => {
  for (const list of [QUIP_PROMPTS, NHIE_STATEMENTS]) {
    const seen = new Set(list.map((s) => s.toLowerCase()));
    assert.equal(seen.size, list.length);
  }
});

test("QUIP prompts are strings of at most 110 chars and contain a blank '___'", () => {
  // Rule used for this deck: every prompt contains the three-underscore blank.
  for (const p of QUIP_PROMPTS) {
    assert.equal(typeof p, "string");
    assert.ok(p.length <= 110, `too long (${p.length}): ${p}`);
    assert.ok(p.includes("___"), `missing blank: ${p}`);
  }
});

test("NHIE statements start with 'Never have I ever ', end with '.', and are at most 100 chars", () => {
  for (const s of NHIE_STATEMENTS) {
    assert.ok(s.startsWith("Never have I ever "), `bad prefix: ${s}`);
    assert.ok(s.endsWith("."), `bad suffix: ${s}`);
    assert.ok(s.length <= 100, `too long (${s.length}): ${s}`);
  }
});

test("TERMS has all five games, each with a title, 7-10 clauses and a waiver", () => {
  assert.deepEqual(Object.keys(TERMS).sort(), [...GAMES].sort());
  for (const game of GAMES) {
    const t = TERMS[game];
    assert.equal(typeof t.title, "string", `${game} title`);
    assert.ok(t.title.length > 0, `${game} title empty`);
    assert.ok(Array.isArray(t.clauses), `${game} clauses`);
    assert.ok(t.clauses.length >= 7 && t.clauses.length <= 10, `${game} has ${t.clauses.length} clauses`);
    for (const c of t.clauses) assert.ok(typeof c === "string" && c.length > 0, `${game} empty clause`);
    assert.equal(typeof t.waiver, "string", `${game} waiver`);
    assert.ok(t.waiver.length > 0, `${game} waiver empty`);
  }
});

test("waivers differ between games", () => {
  const waivers = GAMES.map((g) => TERMS[g].waiver.toLowerCase());
  assert.equal(new Set(waivers).size, GAMES.length);
});

test("TERMS clauses use 'units', never sips or shots, for drink amounts", () => {
  for (const game of GAMES) {
    for (const c of TERMS[game].clauses) {
      assert.doesNotMatch(c, /\b(sips?|shots?)\b/i, `${game}: ${c}`);
    }
  }
});

test("AWARD_BLURBS has the three awards, each a non-empty string", () => {
  assert.deepEqual(Object.keys(AWARD_BLURBS).sort(), ["biggestLoser", "liverMvp", "mostHydrated"]);
  for (const v of Object.values(AWARD_BLURBS)) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
});

test("no exported string references Jackbox, Quiplash, Drawful or Fibbage", () => {
  const banned = /\b(jackbox|quiplash|drawful|fibbage)\b/i;
  const hits = allStrings().filter((s) => banned.test(s));
  assert.deepEqual(hits, []);
});
