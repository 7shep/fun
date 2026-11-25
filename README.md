# Last Call Live!

A retro game-show drinking-game website for friends in the same room. Every player uses their own
phone, and every phone shows the same screen. Phones only differ when a player types an answer, votes or guesses.

**Games:** Quip Shots · Golf (9-hole top-down mini-golf) · Never Have I Ever · Ride the Bus · Wheel of Misfortune.
Every player picks their own drinking level (5 levels, changeable any time). Never Have I Ever has a blind mode where the Nevers guess who said I Have. Includes a fake Terms & Conditions screen before every game (the host can skip it), a drink tally, awards, and custom prompts.

Live at https://fun.alexshepherd.dev.

For adults of legal drinking age. Water counts, and nobody has to drink to play.

## How it works

- Static site: vanilla HTML/CSS/JS, no framework and no build step (`index.html`, `app.js`, `styles.css`).
- The **host's phone is authoritative**. It runs all game logic (`logic/engine.js`) and publishes the full room state after every change.
  Other phones render that state and send their actions to the host.
- **Realtime relay:** `api/room.js` is one Vercel serverless function backed by **Neon Postgres**. Phones poll it about every 0.6 s.
  It stores the latest room state, a small mailbox for actions, and who was seen recently (presence). No accounts.
- Refreshing or relocking a phone puts the player back in their seat (seat in `sessionStorage`, plus a "Rejoin" button from `localStorage`).
- If the host goes quiet for 20 s, the next present player in join order becomes host and carries on from the last state.
- Game rules (scoring, drink math, cards, golf physics) are plain ES modules in `logic/` with no DOM access, tested with `node --test`.

## Run the tests

```powershell
node --test
```

```powershell
node scripts/relay-check.mjs https://your-app.vercel.app
```

The second command checks the live relay's write rules against a deployment (a takeover wins, an old host or a second claimant is refused).

No dependencies are needed for the unit tests. They cover the difficulty→callout mapping (including the every-3rd-unit shot rule),
the golf bottom-25% cutoff, pickup at par+3, the course physics and solvability, the Ride the Bus guesses, restarts and 10-restart cap,
the Quip Shots outcomes and round-2 doubling, room codes, the Wheel slices, and full 5-game playthroughs of the engine.

## Set up the database (Neon)

1. Create a Neon Postgres database. The easiest way is the Vercel Marketplace: in your Vercel project, go to **Storage → Create → Neon**,
   or run `vercel integration add neon`. This adds `DATABASE_URL` to the project's environment variables.
   If you create the database on neon.tech instead, copy its connection string and add it in Vercel as `DATABASE_URL`.
2. Pull the env vars locally and create the tables (one time):

   ```powershell
   vercel env pull .env.local
   ```
   ```powershell
   npm install
   ```
   ```powershell
   node --env-file=.env.local scripts/setup-db.mjs
   ```

`.env.local` is gitignored. Never commit the connection string.

## Deploy to Vercel from GitHub

1. Push this repo to GitHub.
2. In Vercel, click **Add New → Project** and import the repo. Leave the framework as **Other**; `vercel.json` already sets the static settings.
3. Add the Neon integration (or the `DATABASE_URL` env var) as above, then redeploy.
4. Under **Settings → Deployment Protection**, use **Standard Protection** so the production URL is public. Otherwise friends' phones hit a Vercel login.
5. Every push to `main` deploys to production.

## Run locally

```powershell
vercel dev --listen 3000
```

Then open http://localhost:3000 in three browser windows: create a room in one, and join with the 4-letter code in the others.
A plain static server (`npx serve`) can serve the UI, but the realtime relay needs `vercel dev` to run `api/room.js`.

`tools/autopilot.js` is a QA helper. Run `await import('/tools/autopilot.js')` in a window's devtools and that window plays its own
turns, which is handy for testing all five games with several windows.

## Project layout

| Path | What |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | UI, rendering, host loop, failover, golf canvas, wheel |
| `net.js` | Polling transport to `/api/room` |
| `api/room.js` | Vercel function: Neon-backed room relay |
| `logic/engine.js` | Room + all five game state machines (pure) |
| `logic/rules.js` | Drink math, room codes, cards, quip and wheel rules |
| `logic/golf.js` | 9 holes and deterministic ball physics |
| `logic/content.js` | Original prompts, statements and the fake T&C legalese |
| `test/` | `node --test` suites |

## Out of scope

Cheating via devtools, accounts, saved history, remote play. Anyone with a room code can join that room.
