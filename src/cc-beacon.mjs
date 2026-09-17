// ---------------------------------------------------------------------------
// cc-beacon.mjs — LAN discovery beacon for the bus leader (no Tailscale needed).
//
// The leader runs this (in-process, via the cc-bus supervisor). It:
//   • listens on UDP :8788 for {t:'solicit'} datagrams and replies unicast with
//     {t:'announce',host,epoch,port} so a soliciting client learns the leader's
//     address + epoch with zero configuration;
//   • periodically broadcasts a gratuitous announce so passive caches stay warm.
//
//   startBeacon({ host, epoch, port, beaconPort }) → stop()
//
// Kept separate from the HTTP server so discovery is independent of the MCP
// transport and works on a plain LAN. Zero external deps.
// ---------------------------------------------------------------------------
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

function directedBroadcasts() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      try {
        const a = ni.address.split('.').map(Number), m = ni.netmask.split('.').map(Number);
        out.add(a.map((o, i) => (o & m[i]) | (~m[i] & 255)).join('.'));
      } catch {}
    }
  }
  return [...out];
}

export function startBeacon({ host, epoch, port = 8787, beaconPort = 8788, announceMs = 5000 } = {}) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const announce = () => Buffer.from(JSON.stringify({ t: 'announce', v: 1, host, epoch, port }));

  sock.on('error', (e) => { console.error('[beacon] socket error:', e.message); try { sock.close(); } catch {} });
  sock.on('message', (buf, rinfo) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m && m.t === 'solicit') sock.send(announce(), rinfo.port, rinfo.address);
    } catch {}
  });

  let timer = null;
  sock.bind(beaconPort, () => {
    try { sock.setBroadcast(true); } catch {}
    console.log(`[beacon] announcing ${host} epoch=${epoch} on udp/${beaconPort}`);
    const gratuitous = () => {
      const pkt = announce();
      for (const ip of directedBroadcasts()) { try { sock.send(pkt, beaconPort, ip); } catch {} }
    };
    gratuitous();
    timer = setInterval(gratuitous, announceMs);
  });

  return function stop() {
    if (timer) clearInterval(timer);
    try { sock.close(); } catch {}
  };
}
