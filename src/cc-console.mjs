#!/usr/bin/env node
// ---------------------------------------------------------------------------
// cc-console.mjs — reach the Crosstalk operator console from any machine.
//
// The leader already SERVES the console at <leader>/console and the page itself
// discovers/follows the leader once loaded — but the bus has no fixed leader IP,
// so the missing piece is getting your browser TO it. This command discovers the
// current leader (via cc-discover, same as cc-work/cc-poll) and either opens the
// browser at <leader>/console, or runs a tiny local redirector to it.
//
//   node cc-console.mjs [open]              # discover the leader + open the browser
//   node cc-console.mjs serve [--port 8799] # http://localhost:PORT that redirects to
//                                           # the CURRENT leader's console; re-discovers
//                                           # on every hit, so it follows failover. Bookmark it.
//
//   flags: --base <url> (discovery seed) · --token <t> · --no-open (print the URL, don't launch)
//
// The bus token is carried in the URL *hash* (#token=…) — browsers never send a
// fragment to the server, so it stays out of server logs. `serve` binds loopback only.
// Reads ~/.claude/.crosstalk (CC_TOKEN, optional CC_BASE) via cc-discover.loadConfig().
// ---------------------------------------------------------------------------
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFast, loadConfig } from './cc-discover.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const cmd = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'open';

const cfg = loadConfig();
const TOKEN = opt('--token', process.env.CC_TOKEN) || cfg.token || '';
const SEED = opt('--base', process.env.CC_BASE) || cfg.pin || null;

// Build the console URL with base+token in the HASH (client-only; never sent to the server).
export function buildConsoleUrl(base, token) {
  const b = String(base).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('base', b);
  if (token) params.set('token', token);
  return `${b}/console#${params.toString()}`;
}

// A minimal page that redirects CLIENT-SIDE so the hash (with the token) survives —
// a 302 Location header does not reliably carry a URL fragment.
export function redirectHtml(base, token) {
  const url = buildConsoleUrl(base, token);
  // HTML-attribute-escape the fallback link (the '&' between hash params must be &amp; for strict HTML;
  // the primary path is the JS location.replace above, which needs no HTML escaping).
  const hrefAttr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return '<!doctype html><meta charset="utf-8"><title>Crosstalk console</title>' +
    `<script>location.replace(${JSON.stringify(url)})</script>` +
    `<p>Redirecting to the Crosstalk console… <a href="${hrefAttr}">continue</a></p>`;
}

// Open a URL in the default browser with no shell (so '&' in the hash is safe).
function openBrowser(url) {
  const plat = process.platform;
  const [file, args] = plat === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]  // no cmd → no '&' parsing footgun
    : plat === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; }
  catch { return false; }
}

async function discover() {
  const leader = await resolveFast({ pin: SEED, token: TOKEN });
  return leader && leader.base ? leader : null;
}

async function main() {
  if (cmd === 'open') {
    const leader = await discover();
    if (!leader) {
      console.error('cc-console: no bus leader found (loopback / LAN / tailnet all silent). Is a leader running?');
      process.exitCode = 1; return;   // let the loop drain — never process.exit() with handles closing
    }
    const url = buildConsoleUrl(leader.base, TOKEN);
    console.log(`Crosstalk console → ${leader.base}/console  (leader ${leader.host || '?'}, epoch ${leader.epoch ?? '?'})`);
    if (has('--no-open')) { console.log(url); return; }
    if (openBrowser(url)) console.log('Opened your browser. If nothing appeared, open this URL manually:\n  ' + url);
    else console.log('Could not launch a browser. Open this URL manually:\n  ' + url);
    return;
  }

  if (cmd === 'serve') {
    const port = parseInt(opt('--port', '8799'), 10) || 8799;
    const server = http.createServer(async (req, res) => {
      if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
      const leader = await discover();
      if (!leader) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>Crosstalk console</title>' +
          '<p>No bus leader found right now — is a leader running? Refresh to retry.</p>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(redirectHtml(leader.base, TOKEN));
    });
    server.on('error', (err) => { console.error(`cc-console serve: ${err.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Crosstalk console redirector → http://localhost:${port}`);
      console.log('Bookmark that URL: it re-discovers the current leader on every hit (follows failover). Ctrl-C to stop.');
    });
    return;
  }

  console.error(`cc-console: unknown command "${cmd}".\nUsage: cc-console [open] | serve [--port N]   [--base <url>] [--token <t>] [--no-open]`);
  process.exitCode = 2;
}

// Run only when invoked directly, so the test can import the pure helpers side-effect-free.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
