// Realtime transport: one Supabase Realtime channel per room (broadcast + presence). No tables.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let client;

export function configured() {
  const c = window.LCL_CONFIG;
  return !!(c && c.SUPABASE_URL && c.SUPABASE_ANON_KEY && !c.SUPABASE_URL.includes('YOUR-PROJECT'));
}

// handlers: {onMsg(payload), onPresence(keys[]), onReady(), onStatus(status)}
export function connect(code, pid, handlers) {
  const c = window.LCL_CONFIG;
  // worker: keep the socket heartbeat alive when a phone/tab is in the background
  client ??= createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, { realtime: { worker: true, params: { eventsPerSecond: 40 } } });
  const ch = client.channel(`lcl-${code}`, { config: { broadcast: { self: false }, presence: { key: pid } } });
  ch.on('broadcast', { event: 'm' }, ({ payload }) => handlers.onMsg(payload));
  ch.on('presence', { event: 'sync' }, () => handlers.onPresence(Object.keys(ch.presenceState())));
  ch.subscribe(async (status) => {
    handlers.onStatus?.(status);
    if (status === 'SUBSCRIBED') {
      await ch.track({ pid });
      handlers.onReady();
    }
  });
  return {
    send: (payload) => ch.send({ type: 'broadcast', event: 'm', payload }),
    close: () => client.removeChannel(ch),
  };
}
