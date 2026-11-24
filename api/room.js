// Vercel function: the room relay. Phones poll it; the host phone stays authoritative.
// Neon Postgres holds the latest room state, a per-room mailbox, and who was seen recently.
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const CODE = /^[A-Z]{4}$/;
const PID = /^[a-z0-9]{1,16}$/;
const MAX_BODY = 512 * 1024;

export const SCHEMA = [
  `create table if not exists lcl_rooms (code text primary key, state jsonb not null, epoch int not null, v int not null,
     host_id text not null, at_ms bigint not null, updated_at timestamptz not null default now())`,
  `create table if not exists lcl_msgs (id bigserial primary key, code text not null, to_pid text, payload jsonb not null,
     created_at timestamptz not null default now())`,
  'create index if not exists lcl_msgs_code on lcl_msgs (code, to_pid)',
  `create table if not exists lcl_seen (code text not null, pid text not null, at timestamptz not null default now(),
     primary key (code, pid))`,
];

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let b = req.body;
  try { if (typeof b === 'string') b = JSON.parse(b); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  if (!b || typeof b !== 'object') return res.status(400).json({ error: 'Bad request' });
  const { op, code, pid } = b;
  if (!CODE.test(code ?? '') || !PID.test(pid ?? '')) return res.status(400).json({ error: 'Bad room or player id' });
  if (JSON.stringify(b).length > MAX_BODY) return res.status(413).json({ error: 'Too big' });
  try {
    if (op === 'poll') return res.json(await poll(code, pid, b.since));
    if (op === 'state') return res.json(await putState(code, b.s));
    if (op === 'msg') {
      if (b.to != null && !PID.test(b.to)) return res.status(400).json({ error: 'Bad recipient' });
      if (!b.payload || typeof b.payload !== 'object') return res.status(400).json({ error: 'Bad payload' });
      await sql`insert into lcl_msgs (code, to_pid, payload) values (${code}, ${b.to ?? null}, ${JSON.stringify(b.payload)}::jsonb)`;
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown op' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function poll(code, pid, since) {
  const e = Number.isInteger(since?.epoch) ? since.epoch : 0;
  const v = Number.isInteger(since?.v) ? since.v : 0;
  const [, rooms, msgs, seen] = await sql.transaction([
    sql`insert into lcl_seen (code, pid, at) values (${code}, ${pid}, now()) on conflict (code, pid) do update set at = now()`,
    sql`select host_id, epoch, v, at_ms, (extract(epoch from now() - updated_at) * 1000)::int as age,
          case when epoch > ${e} or (epoch = ${e} and v > ${v}) then state end as state
        from lcl_rooms where code = ${code}`,
    // the mailbox addressed to "host" (to_pid null) is drained by whoever the room says is host
    sql`delete from lcl_msgs where code = ${code}
          and (to_pid = ${pid} or (to_pid is null and ${pid} = (select host_id from lcl_rooms where code = ${code})))
        returning id, payload`,
    sql`select pid, (extract(epoch from now() - at) * 1000)::int as age from lcl_seen
        where code = ${code} and at > now() - interval '10 seconds'`,
  ]);
  const r = rooms[0];
  const host = r && seen.find((x) => x.pid === r.host_id);
  return {
    room: r ? { hostId: r.host_id, epoch: r.epoch, v: r.v, state: r.state, at: Number(r.at_ms) + r.age, hostAge: host ? host.age : null } : null,
    msgs: msgs.sort((a, b2) => Number(a.id) - Number(b2.id)).map((m) => m.payload),
    present: seen.map((x) => x.pid),
  };
}

async function putState(code, s) {
  if (!s || typeof s !== 'object' || s.code !== code || !Number.isInteger(s.epoch) || !Number.isInteger(s.v) || !PID.test(s.hostId ?? '')) {
    throw new Error('Bad state');
  }
  // only newer (epoch, v) wins, so out-of-order writes and a returning old host can't roll the room back
  const rows = await sql`insert into lcl_rooms (code, state, epoch, v, host_id, at_ms, updated_at)
      values (${code}, ${JSON.stringify(s)}::jsonb, ${s.epoch}, ${s.v}, ${s.hostId}, ${Date.now()}, now())
    on conflict (code) do update set state = excluded.state, epoch = excluded.epoch, v = excluded.v,
      host_id = excluded.host_id, at_ms = excluded.at_ms, updated_at = now()
    where lcl_rooms.epoch < excluded.epoch or (lcl_rooms.epoch = excluded.epoch and lcl_rooms.v < excluded.v)
    returning code`;
  if (s.v === 1) { // new room: sweep stale data now and then
    await sql.transaction([
      sql`delete from lcl_rooms where updated_at < now() - interval '2 days'`,
      sql`delete from lcl_msgs where created_at < now() - interval '1 hour'`,
      sql`delete from lcl_seen where at < now() - interval '1 day'`,
    ]);
  }
  return { ok: true, applied: rows.length > 0 };
}
