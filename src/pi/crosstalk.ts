// ---------------------------------------------------------------------------
// crosstalk.ts — pi.dev extension entry for the Crosstalk coordination bus (3.3.0).
//
// pi.dev is the third agent class on the bus (after Claude Code and Codex). This file is the
// only pi-runtime-specific part: it is loaded by the pi extension host, and it dynamic-imports
// the real logic (src/pi/crosstalk-core.mjs) IN-PROCESS from the crosstalk checkout so pi shares
// the exact same receive engine (cc-receive.mjs) as Claude's cc-ws and Codex's cc-codex-bridge.
//
// INSTALL (on the box running pi):
//   1. export CC_LIVE=/absolute/path/to/crosstalk   # the checkout root (has package.json + src/)
//   2. copy or symlink this file to  ~/.pi/agent/extensions/crosstalk.ts   (or run:  pi -e <path>/crosstalk.ts)
//   3. the machine must already be enrolled on the bus (~/.claude/.crosstalk holds CC_TOKEN)
//
// The host must permit a runtime dynamic import of a local module. pi's own probe confirmed
// `await import(CC_LIVE + '/src/cc-receive.mjs')` resolves in an ESM context; if a future host
// bundles extensions statically instead, bundle crosstalk-core.mjs + cc-receive.mjs from the SAME
// checkout and re-bundle on every crosstalk update (or the host drifts off the leader version and
// the fleet version gate locks pi out). See docs/PI_AGENT.md.
// ---------------------------------------------------------------------------
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Type-only; erased at load (pi strips types). Kept `any` so an SDK package-name change can't
// break the extension — the runtime shape is what matters, and the core is untyped .mjs.
type ExtensionAPI = any;

export default async function crosstalk(pi: ExtensionAPI) {
  const root = process.env.CC_LIVE;
  if (!root) {
    console.error('[crosstalk] CC_LIVE is not set — point it at the crosstalk checkout root (the dir with package.json + src/) to enable the bus. Extension inactive.');
    return;
  }
  // TypeBox powers the tool parameter schemas. It is NOT a crosstalk dependency — it comes from
  // pi's own runtime — so import it DEFENSIVELY: if the host doesn't provide it, the core degrades
  // to receive-only (bus_send/ack/peers skip registration) rather than the whole extension throwing
  // at load (reviewer, 2026-09-17). If pi re-exports Type from its SDK instead, add that specifier here.
  let Type: unknown = null;
  try { ({ Type } = await import('@sinclair/typebox')); }
  catch { console.error('[crosstalk] @sinclair/typebox not resolvable in this host — bus tools disabled, receive still active.'); }

  let installCrosstalk: (pi: ExtensionAPI, opts?: Record<string, unknown>) => unknown;
  try {
    const coreUrl = pathToFileURL(join(root, 'src', 'pi', 'crosstalk-core.mjs')).href;
    ({ installCrosstalk } = await import(coreUrl));
  } catch (e: any) {
    console.error('[crosstalk] failed to load the engine from CC_LIVE=' + root + ' — ' + (e && e.message ? e.message : e)
      + '. If this host forbids runtime dynamic import, bundle crosstalk-core.mjs + cc-receive.mjs from the same checkout (see docs/PI_AGENT.md). Extension inactive.');
    return;
  }
  installCrosstalk(pi, { Type });
}
