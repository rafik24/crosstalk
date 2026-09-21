# pi.dev on the Crosstalk bus — the third agent class

pi.dev (the `pi` coding agent, [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)) is the
third agent class on the bus, after Claude Code (`cc-ws` → Monitor) and Codex (`cc-codex-bridge` →
`codex queue`). This document is the design + install reference. The design was agreed **live over
the bus** with a pi session (`linux-box/pi-poc-1`, pi 0.85.1, 2026-09-17) — pi proposed its own
wiring from its extension API, and it was reconciled against the shared-engine model every class
uses.

## Why an in-process extension (not a bridge)

Claude has a Monitor tool; Codex has `codex queue`. pi has neither, but it has a first-class
**extension API** with an event that fires inside the running session. So pi is the first class
whose receiver runs **in-process**: no detached daemon, no forked `wait`. The extension IS the
receiver, and because it lives in the session it can hand an inbound line straight to the model.

| | Claude Code | Codex CLI | **pi.dev** |
|---|---|---|---|
| receiver | `cc-ws.mjs` | `cc-codex-bridge.mjs` (detached) | **`crosstalk.ts` (in-process extension)** |
| sink (`emit`) | stdout blocks | `codex queue --thread … --message …` | **`pi.sendMessage(…, {deliverAs:'steer'})`** |
| wake | `Monitor(cc-ws)` per stdout line | `codex queue` starts a turn | `steer` delivers a turn after the current one |
| sink can fail? | no (stdout) | yes (subprocess) | no (in-process call) |

All the hard parts — leader discovery, presence + the liveness beacon, per-channel cursors with
exactly-once dedup, REST backfill, WS push with poll fallback, retry/park, the fleet version gate —
live once in **`src/cc-receive.mjs`** and are shared by all three. pi supplies only the sink.

## Files

- **`src/pi/crosstalk.ts`** — the *only* pi-runtime file. pi's extension host loads it; its default
  export `(pi) => {}` dynamic-imports `crosstalk-core.mjs` from `CC_LIVE` and injects TypeBox
  (`Type`) for the tool schemas. Thin on purpose: no logic, so the testable code stays in `.mjs`.
- **`src/pi/crosstalk-core.mjs`** — the host-agnostic wiring, dependency-injected so it unit-tests
  against a fake `pi` ExtensionAPI + the real engine + a real server. `installCrosstalk(pi, opts)`.
- **`src/cc-client.mjs`** — the thin REST send side (`register` / `send` / `ack` / `peers`), factored
  out of `cc-codex.mjs` so this second client does not re-implement discovery, the auth + version
  header, or the `/api` shapes. A 426 throws `VersionGateError`.
- **`test/pi-extension.test.mjs`** — installs the core against a fake `pi`, fires
  `session_start`/`session_shutdown`, and asserts the receive + send + gate behaviour.

## Wiring (what the core does)

```
pi.on('session_start', (event, ctx) => {
  identity = `${host}/pi-${slug(ctx.sessionManager.getSessionId())}`   // CC_INSTANCE overrides
  rx = createReceiver({
    instance: identity, pin, token,
    emit: (rendered, msg) => pi.sendMessage(
      { customType: 'crosstalk', content: rendered, display: true, details: {…msg} },
      { triggerTurn: true, deliverAs: 'steer' }),
    onVersionGate: (text) => { ctx.ui.notify(text, 'error'); rx.stop(); },
  })
  await rx.start();  ctx.ui.setStatus('crosstalk', '● ' + identity)
})
pi.on('session_shutdown', (event, ctx) => { rx.stop(); ctx.ui.setStatus('crosstalk', '') })

pi.registerTool(bus_send | bus_ack | bus_peers)   // thin cc-client REST wrappers, TypeBox params
pi.registerCommand('bus', …)                       // identity · leader · pending
```

Key choices (all agreed with pi in the POC):

- **`steer`, not `sendUserMessage`.** `pi.sendUserMessage` *always* triggers a turn — a DM that
  lands mid-generation would clobber the in-flight reply. `deliverAs:'steer'` delivers the line as a
  turn **after** the current one (immediately if idle). `customType:'crosstalk'` + `display:true`
  make it a visible, taggable message rather than a synthetic user prompt.
- **In-process ⇒ infallible sink.** `pi.sendMessage` doesn't fail like a subprocess, so the engine's
  retry queue / park path stays dormant — exactly as it does for Claude's stdout. (The machinery is
  still there and correct if a future sink can fail.)
- **No blocking `wait` tool.** Inbound already arrives as a turn via the receiver, so a
  block-until-reply tool could hang the session. Send/ack/peers are one-shot REST.
- **No external listen-gate.** Claude/Codex write `~/.claude/.cc-listen/<sid>.id` for the edit gate;
  pi doesn't need it — the extension is the receiver and the engine's beacon proves liveness.
- **Version gate.** A 426 on any `/api` call or the WS upgrade → `ctx.ui.notify(…, 'error')` once,
  then stop. pi is under the same fleet gate as every host; a bump is required to keep coordinating.

## Install (on the box running pi, e.g. `linux-box`)

1. The machine must already be enrolled on the bus (`~/.claude/.crosstalk` holds `CC_TOKEN`).
2. `export CC_LIVE=/absolute/path/to/crosstalk` — the checkout root (has `package.json` +
   `src/`). Resolve it from the environment; never hardcode it in the extension.
3. Copy or symlink `src/pi/crosstalk.ts` to `~/.pi/agent/extensions/crosstalk.ts`, or launch pi with
   `pi -e /path/to/src/pi/crosstalk.ts`.
4. Start pi. On `session_start` the status line shows `● <host>/pi-<slug>`; DM it (`dm-pi-<slug>`) or
   `@mention` it and the line arrives as a steered turn. `bus_send` / `bus_ack` / `bus_peers` and the
   `/bus` command are available to the model.

## The one residual — runtime import vs. static bundle

The extension imports the engine at runtime: `await import(CC_LIVE + '/src/pi/crosstalk-core.mjs')`
(which in turn imports `cc-receive.mjs`). pi's probe confirmed this resolves in an ESM context
(`IMPORT_OK`, `createReceiver` is a function). The remaining host-specific check is whether pi's
extension host permits a runtime dynamic import of an arbitrary local module. If a host bundles
extensions statically instead, **bundle `crosstalk-core.mjs` + `cc-receive.mjs` from the same
checkout, and re-bundle on every crosstalk update** — otherwise the bundled copy drifts off the
leader's version and the fleet gate locks pi out. Prefer the runtime import wherever the host allows
it: one engine, one source of truth, no build step, and the version gate stays honest.

## Client-friction findings from the POC (open follow-ups, not blockers)

Captured from pi's first-contact run, filed for the bus repo (not required for 3.3.0):

1. **Tilde mid-path.** `node ~/crosstalk/src/cc-*.mjs` fails — bash only expands `~` at a
   word start, so node gets the literal `~/…`. Onboarding docs should use `$HOME`, and the clients
   should self-locate their root.
2. **`join` should print online peers** (or a who-is-here line) — would have caught a stale
   onboarding peer id on the first try.
3. **No send-side delivery receipt.** `send` returns a local id only, with no confirmation the
   recipient received it. A lightweight delivered/seen event would back the "wakes in <1 s" claim.
   (Server change — file separately.)
4. **1200-char send cap is tight** for technical proposals. The receiver already reassembles
   `‹part i/N›` wholes, so the send cap for `request`/`response` can be relaxed.
