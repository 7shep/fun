// Live check of the room relay's rules against a running deployment (it needs the real database).
// Usage: node scripts/relay-check.mjs [https://your-app.vercel.app]   (default: http://localhost:3000)
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const code = 'Z' + Array.from({ length: 3 }, () => 'ABCDEFGHJKMNPQRSTUVWXY'[Math.floor(Math.random() * 22)]).join('');
let failed = 0;

async function call(body) {
  const r = await fetch(`${base}/api/room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const write = (pid, epoch, v, hostId = pid) => call({ op: 'state', code, pid, at: Date.now(), s: { code, epoch, v, hostId } });
function check(name, ok, got) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
}

console.log(`relay check on ${base}, room ${code}`);
let r = await write('a', 1, 1);
check('host a creates the room', r.body.applied === true, r.body);
r = await write('a', 1, 2);
check('host a writes a newer version', r.body.applied === true, r.body);
r = await write('a', 1, 2);
check('a repeated version is refused', r.body.applied === false, r.body);
r = await write('b', 1, 3);
check('another phone cannot write in the same epoch', r.body.applied === false && r.body.room?.hostId === 'a', r.body);
r = await write('b', 2, 3);
check('a takeover (next epoch) wins', r.body.applied === true, r.body);
r = await write('a', 1, 99);
check('the old host cannot roll the room back', r.body.applied === false && r.body.room?.epoch === 2 && r.body.room?.hostId === 'b', r.body);
r = await write('c', 2, 4);
check('a second claimant in the takeover epoch is refused', r.body.applied === false, r.body);

r = await call({ op: 'poll', code, pid: 'a', since: { epoch: 0, v: 0 } });
check('poll returns the takeover state', r.body.room?.state?.hostId === 'b' && r.body.room.epoch === 2, r.body.room);
r = await call({ op: 'poll', code, pid: 'a', since: { epoch: 2, v: 3 } });
check('poll omits state the phone already has', r.body.room && r.body.room.state == null, r.body.room);

await call({ op: 'msg', code, pid: 'a', payload: { t: 'act', pid: 'b', a: { type: 'next' } } });
r = await call({ op: 'poll', code, pid: 'b', since: { epoch: 2, v: 3 } });
check('an action is stamped with the phone that sent it', r.body.msgs?.[0]?.pid === 'a', r.body.msgs);

r = await call({ op: 'state', code, pid: 'a', s: { code, epoch: 3, v: 9 } });
check('a state without a host is rejected', r.status === 400, r);
r = await call({ op: 'poll', code: ['ABCD'], pid: 'a' });
check('a non-string room code is rejected', r.status === 400, r);
r = await call({ op: 'state', code, pid: 'a', s: { code: 'ZZZZ', epoch: 9, v: 9, hostId: 'a' } });
check('a state for another room is rejected', r.status === 400, r);

console.log(failed ? `${failed} check(s) failed` : 'all relay checks passed');
process.exit(failed ? 1 : 0);
