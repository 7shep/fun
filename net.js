// Transport: phones poll /api/room (Vercel function over Neon Postgres).
// Same message shapes as a pub/sub channel: {t:'state'|'hb'|'act'|'err'|'hello'}.
const POLL_MS = 600;

// handlers: {onMsg(payload), onPresence(pids[]), onReady(), onStatus(status)}
export function connect(code, pid, h) {
  let closed = false, inflight = false, last = 0, wantAll = true, ready = false;
  let since = { epoch: 0, v: 0 };
  const post = async (body) => {
    const r = await fetch('/api/room', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, pid, ...body }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  async function poll() {
    inflight = true; last = Date.now();
    try {
      const all = wantAll;
      const r = await post({ op: 'poll', since: all ? { epoch: 0, v: 0 } : since });
      if (closed) return;
      if (all) wantAll = false;
      if (!ready) { ready = true; h.onStatus?.('SUBSCRIBED'); h.onReady(); }
      h.onPresence(r.present);
      const room = r.room;
      if (room?.state) {
        since = { epoch: room.state.epoch, v: room.state.v };
        h.onMsg({ t: 'state', s: room.state, at: room.at, from: room.hostId });
      }
      if (room && room.hostAge != null) h.onMsg({ t: 'hb', hostId: room.hostId, epoch: room.epoch, v: room.v, age: room.hostAge });
      for (const m of r.msgs) h.onMsg(m);
    } catch {
      // network blip: the next tick retries
    } finally { inflight = false; }
  }
  return {
    // called from the app's (worker-driven) loop so polling survives background-tab timer throttling
    tick() { if (!closed && !inflight && Date.now() - last >= POLL_MS) poll(); },
    send(m) {
      if (closed) return;
      if (m.t === 'hello') { wantAll = true; last = 0; return; }
      if (m.t === 'hb') return; // liveness comes from polling itself
      if (m.t === 'state') return post({ op: 'state', s: m.s }).catch(() => {});
      return post({ op: 'msg', to: m.to ?? null, payload: m }).catch(() => {});
    },
    close() { closed = true; },
  };
}
