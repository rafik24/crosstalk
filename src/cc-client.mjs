// ---------------------------------------------------------------------------
// cc-client.mjs — the thin REST SEND side of the bus, shared by any agent-class client.
//
// The RECEIVE side is cc-receive.mjs (the shared push+backfill engine). This is its
// counterpart: the one-shot writes a session makes — register presence, send a message,
// ack a handoff, list peers — a reusable write client so a second client (the pi extension,
// src/pi/crosstalk-core.mjs) does not re-implement discovery, the auth + version header, or the
// /api call shapes. (It mirrors cc-codex.mjs's write surface but is a PARALLEL implementation —
// cc-codex.mjs was NOT changed to consume it; the two can drift, so keep them in step or migrate
// cc-codex.mjs onto this client later.) Discovery, token and the version header are the plugin's
// own (cc-discover / cc-rev), so this client is subject to the same fleet version gate as
// every host.
//
//   const client = createClient({ pin, token });   // pin = CC_BASE override, else discovery
//   await client.register(id, desc);
//   await client.send(id, 'dm-foo' | 'all', 'text', 'request'|'response'|'handoff'|'done'|...);
//   await client.ack(id, channel, 'note');          // a response whose body starts "ACK"
//   await client.peers();                            // GET /api/instances
//
// A 426 (fleet version gate) throws a VersionGateError carrying { required, yours, how_to_update }
// so the caller can surface it however it likes (cc-ws exits; the pi extension notifies + stops).
// Zero deps.
// ---------------------------------------------------------------------------
import { resolveFast, resolveFull, loadConfig } from './cc-discover.mjs';
import { revString, pkgVersion } from './cc-rev.mjs';

export class VersionGateError extends Error {
  constructor(info) { super('version_mismatch'); this.name = 'VersionGateError'; this.info = info || {}; }
}

const normChannel = (ch) => (ch === 'all' ? 'general' : ch);

export function createClient(opts = {}) {
  const cfg = loadConfig();
  const PIN = opts.pin ?? process.env.CC_BASE ?? cfg.pin;
  const TOKEN = opts.token ?? process.env.CC_TOKEN ?? cfg.token;
  let BASE = opts.base ?? null;

  const headers = () => ({ Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-cc-version': pkgVersion() || '' });

  async function ensureBase(full = false) {
    if (BASE && !full) return BASE;
    const leader = full ? await resolveFull({ pin: PIN, token: TOKEN }) : await resolveFast({ pin: PIN, token: TOKEN });
    if (leader && leader.base) BASE = leader.base;
    return BASE;
  }

  async function api(path, o = {}) {
    if (!TOKEN) throw new Error('no CC_TOKEN (bus config ~/.claude/.crosstalk missing?)');
    if (!BASE) { await ensureBase(true); if (!BASE) throw new Error('no bus leader found'); }
    const r = await fetch(BASE + path, { ...o, headers: { ...headers(), ...(o.headers || {}) } });
    if (r.status === 426) { let info = {}; try { info = await r.json(); } catch {} throw new VersionGateError(info); }
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text().catch(() => '')}`);
    return r.json();
  }

  return {
    get base() { return BASE; },
    ensureBase,
    register: (id, desc) => api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ instance_id: id, description: desc || process.env.CC_DESC || '', rev: revString(), version: pkgVersion() }),
    }),
    // Strips no flags — callers pass structured args, not a shell line (unlike cc-codex.mjs's argv parse).
    send: (id, channel, content, type = 'message') => api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ channel: normChannel(channel), sender: id, content, message_type: type }),
    }),
    ack: (id, channel, note) => {
      let body = String(note || '');
      if (!/^ACK\b/.test(body)) body = 'ACK — ' + body;
      return api('/api/messages', { method: 'POST', body: JSON.stringify({ channel: normChannel(channel), sender: id, content: body, message_type: 'response' }) });
    },
    peers: () => api('/api/instances'),
  };
}

export { normChannel };
