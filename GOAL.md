# Goal: "Last Call Live!" — a phones-only party drinking-game site

Build a Jackbox-style drinking-game website for a group of friends playing in the same room.
Every player uses their own phone, and every phone shows the same shared screen. Phones differ only
where a player has to give private input (typing an answer, a vote, a guess).

## Stack (keep it simple)

- Static site: vanilla HTML/CSS/JS, no build step, no framework. Deployed on Vercel from a GitHub repo.
- Realtime: Supabase Realtime (broadcast + presence), one channel per room. No database tables, no accounts.
- Supabase URL and anon key live in `config.js`. Commit `config.example.js` and gitignore the real one.
- The host's phone is authoritative. It runs all game logic and broadcasts the full room state after every
  change, and the other phones render that state. Because every phone holds the full state, a phone that
  rejoins asks for it and gets it, and if the host is gone for more than 20s, the next player in join order
  becomes host and carries on from the last state.
- Game logic (scoring, drink math, card logic, golf physics) lives in plain ES modules with no DOM access,
  so it can be unit-tested with `node --test` and no dependencies.
- Out of scope: cheating via devtools, accounts, saved history, remote play.

## Core flow

1. Home screen: **Create Game** / **Join Game**.
2. Create: the server-free host generates a 4-letter room code (no ambiguous letters such as O/0, I/1)
   and becomes host.
3. Join: enter the code and a nickname (unique within the room, 1–12 chars). 2–12 players.
4. Lobby: the player list, the room code shown big, the host picks a **game** and a **drinking difficulty**.
5. **Terms & Conditions screen** before every game: a funny fake legal document with that game's real
   rules written as legalese ("The Undersigned Drinker hereby acknowledges…"). Every player must scroll to
   the bottom and tap **I Agree** (plus a checkbox like "I waive my right to remember tonight").
   The screen shows who has signed, and the host can't start until everyone has.
6. Play → results screen with this game's drink tally and awards → back to the lobby to pick the next game.
7. Refreshing or relocking a phone puts the player back in their seat (player id + room code in
   localStorage).

## Drinking difficulty

Games only ever award **drink units** to players. The difficulty setting turns units into a callout:

| Level            | 1 unit =          |
| ---------------- | ----------------- |
| Fun Night Out    | 1 sip             |
| Tipsy            | 2 sips            |
| Sending It       | 3 sips            |
| Blackout Express | half your drink   |
| Alcoholism       | finish your drink |

- Every drink event shows a full-screen game-show callout on all phones ("ALEX — 2 SIPS!").
- At Sending It and above, every 3rd unit for a player becomes a shot instead.
- The host can change the difficulty in the lobby between games.

## Shared features

- **Drink tally** per player across the whole session (units plus the callouts as text), always available
  from a small button.
- **Awards** at the end of each game and on a session summary screen: "Liver MVP" (most drinks),
  "Most Hydrated" (fewest), "Biggest Loser", plus one award per game (e.g. "Bus Regular").
- **Custom prompts:** in the lobby, any player can add prompts for the quip game and Never Have I Ever.
  They're mixed into that room's deck for the session only and tagged with the author's name when used.

## Games

### 1. Quip Shots (original prompts, original name)

- Each round, every player privately answers 2 prompts, and each prompt goes to exactly 2 players.
  60-second timer; an empty answer becomes "[chickened out]".
- Matchups are shown one at a time. Everyone except the two authors votes, and the votes are revealed
  with names.
- The loser drinks 1 unit, or 2 units on a shutout (0 votes). A tie means both drink 1.
- 2 rounds; round 2 is worth double points and double units. Points are scored as votes × 100.
- Write at least 80 original starter prompts, edgy but not hateful.
- Players can't answer their own custom prompts.

### 2. Golf (playable top-down mini-golf)

- 9 holes: 3 at par 3, 3 at par 4, 3 at par 5. Difficulty rises from hole 1 (open, easy) to hole 9 (hard).
  Hazards: walls/bumpers, sand (heavy friction), water (+1 stroke and reset to the last spot), and moving
  obstacles on the late holes.
- Turn-based: the active player drags back from the ball to aim and set power. Everyone else watches the
  same shot animate live.
- The shooter sends {angle, power}. The host runs a deterministic physics step and broadcasts the ball path
  and final position, and every phone animates that path. Courses are drawn on canvas and scale to any
  phone width.
- Pickup rule: max strokes = par + 3.
- After each hole, show a leaderboard of total score vs par (e.g. "+2"). The **bottom 25% drink 1 unit**:
  ceil(players × 0.25), at least 1, and everyone tied at the cutoff drinks.
- A hole-in-one shows a big celebration.

### 3. Never Have I Ever

- 20 statements per game, from at least 80 original starter statements plus the room's custom ones.
- Everyone privately taps **I Have** / **Never**. Once all have answered (or after 20s), the names are
  revealed. Each "I Have" = 1 unit.
- If only one person says "I Have", they must explain and drink 2 units.

### 4. Ride the Bus

- Use a standard 52-card deck, shuffled by the host.
- Phase 1: each player in turn makes 4 guesses on newly dealt cards: red/black, higher/lower than
  card 1, inside/outside cards 1–2, then suit. A wrong guess at stage N = N units. Ties count as wrong.
- Phase 2: the player with the most wrong guesses (ties broken by most units) **rides the bus**. They
  run all 4 guesses again from a fresh deck. Any wrong guess = 1 unit and a restart from guess 1, until
  they get all 4 in a row.
- Safety valve: after 10 restarts they get off the bus.
- The bus ride gets maximum game-show drama (bus horn, a "STOP #3" counter).

### 5. Wheel of Misfortune

- Players take turns spinning in join order. The host generates the result, and every phone shows the same
  spin animation landing on the same slice.
- Slices: You drink 1, You drink 2, Pick someone (spinner chooses a player), Everyone drinks 1,
  Social (everyone drinks 1), Waterfall (everyone drinks 2), Safe, Spin again, Double or nothing
  (the next spin's units ×2), Hand out 3 (spinner splits 3 units between other players).
- The host picks a round count (1–5 laps of the group).

## Look: retro game show

- 1970s–80s TV game show: marquee bulb lights around panels, a deep red/gold/teal palette, wood-panel and
  sparkle accents, a chunky condensed display font for headlines, an "APPLAUSE" sign that lights up
  on reveals.
- Built for phones first (360–430px wide), with big touch targets (44px+). Works in portrait. No hover-only
  interactions.
- Animations for reveals, drink callouts and the wheel; respect `prefers-reduced-motion`.
- Optional sound effects (buzzer, ding, applause) with a mute toggle, off by default.

## Acceptance criteria (all must pass)

1. `node --test` passes with tests covering: difficulty unit→callout mapping (all 5 levels, including the
   shot rule), the golf bottom-25% cutoff (for 2, 3, 4, 5 and 8 players, including ties at the cutoff),
   golf pickup at par+3, Ride the Bus guess logic for all 4 stages including ties, bus restart and the
   10-restart cap, Quip Shots vote outcomes (win/tie/shutout and round-2 doubling), room-code generation
   (no ambiguous letters), and the Wheel slice outcomes.
2. Served locally (e.g. `npx serve`), with 3 browser windows as 3 players: create, join with the code, and
   every window shows the same lobby.
3. The T&C screen blocks the start until all 3 have agreed, and each window shows the signatures.
4. Each of the 5 games plays from start to finish across the 3 windows with no console errors, and all
   windows show the same screen at every step, apart from private input.
5. Refreshing a non-host window mid-game returns that player to the same seat and screen within 5s.
6. Closing the host window mid-game promotes another player to host within ~20s, and the game continues.
7. The drink tally and session awards match the drinks actually awarded during play.
8. At 375×812, every screen fits without horizontal scroll, and all buttons are at least 44px.
9. A `README.md` covers Supabase setup (create the project, copy the URL and anon key into `config.js`) and
   deploying to Vercel from GitHub.
10. All prompts, names and art are original. No Jackbox names, characters or assets.
