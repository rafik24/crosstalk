# Crosstalk

**A near-real-time coordination bus for AI coding agents — across your machines.**

Crosstalk is the live link between the Claude Code (or any HTTP/WebSocket-speaking) agent sessions
you run — on one machine or many, on **Windows, Linux, or macOS**. Sessions message each other in
under a second, see who else is online, and coordinate through a shared human console. One clone on
any node can **host** the bus or **connect** to whoever is hosting — **no configured server IP, no
cloud account, no external database.** The whole bus is a single local SQLite file any node can carry.

## What is Crosstalk

It doesn't just carry the chatter — it's the layer that makes multi-agent work **reliable and
visible**. Agents **declare** what they're doing and **atomically claim** it on a shared work board:
a claim is a real distributed lock, so two agents *cannot* silently pick up the same task — and you
can see, live, who owns what and what state it's in.

- **Talk** — sub-second push messaging, DMs, broadcasts, typed hand-offs with an ack contract, and presence.
- **Coordinate** — a work board (epic → task, `queued → … → deployed`) with an **atomic claim-lock** so
  nothing gets double-done, and hand-offs that transfer ownership cleanly. *(The smart part — routing
  work to whoever's best-placed by context/knowledge — is a protocol the agents run on top; Crosstalk
  enforces it with the lock and makes it observable on the board and console.)*
- **Survive** — durable history + cursor backfill (nothing missed while a session was away), leader
  election, DB replication, and failover with no single point of failure.
- **Stay yours** — self-hosted on a trusted network (tailnet/LAN), **secure-by-default** (bearer +
  admin scope, loopback-default bind, rate limits), zero external services.
- **Just work** — ships as a Claude Code **plugin**: install it and every session auto-joins.

We built cross-agent messaging before Claude Code had native inter-agent comms; native now has
messaging and a shared task list, but Crosstalk adds **cross-machine reach, persistence, a real
distributed lock, self-hosting + failover, and an operator console**.

## Self-hosting + zero-config discovery

- **The server lives here** (`server/`) — an original, dependency-light HTTP + WebSocket bus
  over a single SQLite file. Every node carries it, so any node can host and the bus can be
  **moved** between hosts.
- **No hardcoded IP.** The leader is discovered, cheapest-first, then the highest election
  **epoch** wins: loopback → cache → **LAN UDP beacon** (no Tailscale needed) → **tailnet
  peer-scan** (`tailscale status`) → optional static `CC_PEERS`.
- **Single-server election on start.** `cc-bus start` starts a server **only if none is
  present**; otherwise it runs client-only and watches for failover.
- **PO-commanded migration.** `cc-bus migrate --to <host> --confirm` moves the live bus
  (message DB + leadership) to another host, made **authoritative** via `epoch+1`.

## Install (as a Claude Code plugin)

Crosstalk is **one Claude Code plugin** — the `crosstalk` skill, the SessionStart + PreToolUse
hooks, the `crosstalk-reviewer` agent, and the bus scripts, in a single install:

```sh
claude plugin marketplace add https://github.com/rafik24/crosstalk.git
claude plugin install crosstalk@crosstalk
```

Then create the config `~/.claude/.crosstalk` (shared token). That's it — **hosting needs no native
build**: the server stores everything in Node's built-in `node:sqlite`, so a bare `claude plugin
install` can host the bus on any node (Node 22.13+/24). Full step-by-step: **[`ENROLLMENT.md`](./ENROLLMENT.md)**.

## Quick start (running the bus directly)

```sh
npm ci                       # installs express + zod (pure JS; node 22.13+/24, server uses built-in node:sqlite)
node cc-bus.mjs start        # elect: become leader if none present, else client + failover-watch
node cc-bus.mjs ensure       # idempotent: start a supervisor here only if one isn't already running
node cc-bus.mjs status       # the authoritative leader + estate failover coverage
```

Per host, run `cc-bus start` as a small daemon (systemd unit on Linux, Scheduled
Task / nssm on Windows) — or set `CC_AUTO_SUPERVISOR=1` and let each session's `cc-join.sh`
hook `cc-bus ensure` one for you (see **Self-healing supervisors + coverage**). The `cc-join.sh`
SessionStart hook otherwise stays advisory; its register + Monitor base come from discovery.

## Enrolling a new Claude Code CLI install

Full step-by-step (plugin install → config → host deps → verify) for wiring a fresh machine's
Claude Code to join the bus and communicate: **[`ENROLLMENT.md`](./ENROLLMENT.md)**. The `crosstalk`
skill ships in the plugin at [`skills/crosstalk/SKILL.md`](./skills/crosstalk/SKILL.md); the
SessionStart + PreToolUse hooks in [`hooks/hooks.json`](./hooks/hooks.json); the reviewer in
[`agents/crosstalk-reviewer.md`](./agents/crosstalk-reviewer.md); the manifest in
[`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json).

## Files

| file | role |
|---|---|
| `cc-bus.mjs` | **Supervisor + control CLI**: `start` (elect/supervise/failover), `ensure` (idempotent per-machine supervisor), `status` (leader + failover coverage), `receive` (standby target), `migrate`. |
| `cc-discover.mjs` | **Discovery** — `resolveFast` (hot path) / `resolveFull` (merged scan); highest-epoch wins. Every client script imports it. |
| `cc-beacon.mjs` | Leader-side **LAN UDP beacon** (UDP :8788) — answers solicits + gratuitous announce so LAN clients find the leader with zero config. |
| `server/` | The bus server: `server.mjs` (HTTP+WS, bearer + admin auth, rate limits), `db.mjs` (SQLite store), `rest-api.mjs` (the `/api` surface + work board), `ws-hub.mjs` (WebSocket push), `openapi.json`. Endpoints: `/cc/whoami` (public beacon), admin-gated `/cc/export` + `/cc/stepdown`, authed `/api/*`, and `/cc/ws`. |
| `server/ws-hub.mjs` | **WebSocket push hub** (issue #3): hand-rolled upgrade on the leader's http server (zero new deps), pushes each new message to the identities it is addressed to. |
| `cc-ws.mjs` | **Real-time PUSH receiver** (the armed Monitor command). Holds a WebSocket open to the leader, backfills the cursor over REST on every (re)connect, writes the liveness beacon, and **auto-falls back to the 2s poll** if the leader can't speak WS. |
| `cc-poll.mjs` | Legacy poll receiver (the fallback `cc-ws` degrades to). **Re-resolves when its leader dies**, so a listener follows a migration instead of going deaf. |
| `cc-render.mjs` | Shared, zero-dep source of truth for the **addressed-to filter** (server fan-out == client display) and **notification wrapping** (fixes the harness truncating long DMs). |
| `cc-name.mjs` / `cc-send.mjs` / `cc-ack.mjs` | Rename / send / ack — all resolve the leader via `cc-discover`. |
| `cc-join.sh` | SessionStart hook: mints identity, registers presence, prints join status + first actions. |
| `cc-listen-gate.mjs` | PreToolUse gate: blocks Edit/Write until this session has a fresh `cc-ws`/`cc-poll` liveness beacon. |
| `cc-console.html` | Human web console over the REST API (the **PO dashboard** — canonical copy lives here). The leader serves it at `<leader>/console`. |
| `cc-console.mjs` | **Console launcher** — discovers the current leader and opens your browser at `<leader>/console` (`open`), or runs a loopback redirector (`serve --port N`) that re-discovers on every hit so it follows failover. The bus token rides in the URL *hash*, so it's never sent to the server. |
| `skills/crosstalk/SKILL.md` | The `crosstalk` skill (shipped by the plugin; invoked `Skill(crosstalk:crosstalk)`). |
| `.claude-plugin/plugin.json` · `hooks/hooks.json` · `agents/crosstalk-reviewer.md` | Plugin manifest · the SessionStart + PreToolUse hooks · the reviewer agent. |
| `ENROLLMENT.md` | Step-by-step to wire a new Claude Code CLI install onto the bus. |
| `test/*.test.mjs` | Regression suite (`npm test`): render/wrap + addressed filter · db (storage + atomic claim) · rest (API + work board) · server (auth/admin/limits + real integration) · WS push + backfill · discovery/highest-epoch + watermark tiebreak · supervisor singleton (`ensure` idempotency). |

## Real-time push (WebSocket) + cursor backfill

Delivery is **push, not poll**. The leader exposes a WebSocket at `GET /cc/ws?identity=<id>`
on the same port/token as the REST API — the Node client sends the token in the `Authorization`
header (browsers, which can't set WS headers, fall back to `?token=`). Hand-rolled upgrade in
`server/ws-hub.mjs` — **no new dependency**, so the estate updates with a plain `git pull` + restart. On every new message the hub
pushes one JSON frame to each connected identity the message is **addressed to** — the same filter the
poller applied (DM channel, `@mention`, `@all`), kept server-side in `cc-render.mjs`.

The client (`cc-ws.mjs`, the armed Monitor command) holds that socket open — instant wake, no 2s
counter. Two things keep it reliable:

- **Cursor backfill.** Sockets drop (sleep, migration, flaky link). On every (re)connect the bridge
  replays `GET /api/messages/<ch>?after_id=<last-seen>` over REST, so anything sent while it was down
  arrives **exactly once** (deduped by message id), then push resumes. Push for immediacy, cursor for
  gap-repair.
- **Graceful fallback.** If the leader is too old to speak WS (or this Node has no WebSocket client),
  the bridge falls back to the 2s poll and keeps retrying the socket — upgrading itself to push the
  moment the leader does. So `cc-ws` is always safe to arm.

**Long messages arrive whole.** The Claude Code harness truncates a single Monitor event line at
~470 chars and a notification at ~3 KB, which is why a long DM used to show `…(truncated)`. `cc-render.mjs`
wraps the body onto ≤400-char lines and splits a very long message across spaced notifications, so it
lands in full, in order, with no fetch. (The bus DB + REST always carried the full body — the fix is at
the notification edge.)

## How discovery + authority works

Authority is a monotonic **epoch** persisted in `~/.cross-claude-mcp/epoch` next to the DB
and **carried with the DB on migration**. `GET /cc/whoami` (unauthenticated — advertises
host/epoch/base plus a data **watermark** and the running code **rev**, never a secret) is the
beacon. Discovery merges every responder and picks the winner by the single `outranks()`
ordering: **highest epoch**, then — at an equal epoch — the **highest watermark** (the freshest
snapshot), then the lexicographically-lowest host. A migrated host starts at `epoch+1`, so it
wins over any stale server; a supervisor that sees a peer outrank it steps down.

The **watermark** is the highest message id the leader has served (tracked in memory, so
`/cc/whoami` never hits the DB). It makes an equal-epoch election pick the branch that took the
**most writes** — so a stale leader returning after an outage can't clobber the fresher history a
standby was promoted onto (**most-writes-win**, a deterministic policy strictly better than the
old arbitrary hostname tie).

**Repointing is automatic.** After a migration the old leader steps down (its base goes
dead), so each client's fast path falls through to a full scan and re-caches the new
higher-epoch leader — no per-node config edit, even for a node that still pins `CC_BASE`
(a dead pin escalates to the scan).

**Failover keeps the messages.** A `cc-bus start` client periodically pulls the leader's DB
snapshot (`GET /cc/export`, every `CC_REPLICATE_MS`, default 30s) and stores it locally with
the leader's epoch. So when the leader vanishes and this node auto-promotes, it comes up on a
**recent** copy of the bus — message loss is bounded to the replication interval instead of the
unbounded loss of promoting on a stale/empty local DB. (A planned `migrate` still transfers the
DB exactly; this only covers *unplanned* failover.)

**Empty-snapshot guard.** A node with **no local DB at all** (never led, never replicated) will
not promote over a live leader that discovery merely hadn't found yet — it does one final full
scan and joins as a client if any leader answers. Only a genuinely alone node bootstraps a fresh
(empty) bus, and it says so loudly. Combined with the watermark tiebreak above, a returning stale
node can neither blank the bus nor overwrite fresher history.

## Self-healing supervisors + coverage

The bus is only as available as the hosts running a supervisor. To stop the "sole leader dies →
bus blacks out until someone hand-runs `cc-bus start`" outage:

- **`cc-bus ensure`** starts a supervisor on this box **only if one is not already running here**
  (idempotent). Liveness is a heartbeat file (`~/.cross-claude-mcp/supervisor.json`) checked by a
  fresh timestamp **and** a live pid (`process.kill(pid,0)`, cross-platform), and an atomic lock
  serializes concurrent session-starts so **exactly one** supervisor runs per machine. It is fast
  (no network) and fail-soft.
- **Opt-in auto-start.** Set `CC_AUTO_SUPERVISOR=1` in `~/.claude/.crosstalk` and the
  SessionStart hook (`cc-join.sh`) runs `cc-bus ensure` — so any box with a live session has
  failover capacity by construction. It is **default-OFF** so the estate's failover behaviour only
  changes when you turn it on.
- **Coverage visibility.** Every supervisor registers on the bus (`cc-bus-supervisor/<host>`,
  heartbeated), so **`cc-bus status`** reports the online supervisors, their hosts, and the
  **failover capacity** — the standby hosts other than the leader's. It calls out a **single point
  of failure** (only the leader host has a supervisor) *before* an outage, not during one.

Residual (by design): a host's supervisor stays down between its own death (e.g. OOM) and that
host's next session start (the re-ensure cadence); cross-host redundancy (≥2 boxes each ensuring)
covers the bus in the meantime. A heavier always-on OS service (systemd / Scheduled Task) is the
alternative this hook-ensured approach deliberately trades away for simplicity.

## Migration

```sh
# on the target host: hold the port and await the DB
node cc-bus.mjs receive

# on (or with reach to) the current leader:
node cc-bus.mjs migrate --to <host|ip|host:port> --confirm
```

`migrate` refuses unless the target is reachable **and** in `receive` (standby) **and**
`--confirm` is passed; it exports a consistent snapshot, imports it at `epoch+1`, **verifies
the new leader is live before** stepping the old one down (so a failed migration leaves the
old leader running). DB transfer is HTTP over LAN/tailnet — never Taildrop.

## Connection config (NOT in this repo)

Each machine reads `~/.claude/.crosstalk` (or the legacy `~/.claude/.cross-claude-bus`) for `CC_TOKEN` (required) and optionally:

- `CC_BASE` — a manual **pin/override**. New setups **omit it** and rely on discovery; a
  dead pin escalates to the scan.
- `CC_PEERS` — csv of `host:port` static hints for headless/edge nodes with no Tailscale.
- `CC_PORT` (default 8787) · `CC_BEACON_PORT` (default 8788).
- `CC_AUTO_SUPERVISOR` — `1` makes each session's `cc-join.sh` `cc-bus ensure` a supervisor on
  this box (default off; see **Self-healing supervisors + coverage**).
- `CC_REPLICATE_MS` (default 30000) — how often a client pulls the leader's snapshot; also the
  bound on unplanned-failover message loss.

Opt-in per machine (the join hook no-ops if the file is absent) and **git-ignored** — the
token never belongs in version control. Firewall: allow inbound **TCP 8787** + **UDP 8788**
on any node that may host.

## Security

The bus assumes a **trusted network** (a tailnet or a home/office LAN). It speaks plain HTTP/WS —
**never bind it to a public interface without TLS and a reverse proxy in front.** The hardening
below raises the floor; it does not make the bus safe to expose to the open internet.

- **Loopback by default.** The server binds `127.0.0.1` unless you set `CC_BIND` (e.g. your
  tailnet IP, or `0.0.0.0`). A node that only serves itself needs nothing; a node that **hosts
  for the estate must set `CC_BIND`** — and, because of the next point, a token with it.
- **Refuse-run-open.** With **no `MCP_API_KEY`** the server refuses to start on a non-loopback
  bind. Override for local dev only with `CC_ALLOW_NO_AUTH=1`. `MCP_API_KEY` is the shared
  chat/API token (constant-time compared).
- **`CC_ADMIN_KEY` for admin ops.** `/cc/export` (full-DB download), `/cc/stepdown` (remote
  kill) and `cc-bus`'s `/cc/import` (DB overwrite) are gated by a **separate** admin secret so a
  leaked chat token can't reach them. When `CC_ADMIN_KEY` is **unset** these are **loopback-only**
  — so **cross-host replication and `migrate` require `CC_ADMIN_KEY` set on every node** (share it
  like `CC_TOKEN`).
- **Token stays out of the URL.** The Node push client sends the token in the `Authorization`
  header; only the **browser** console (which can't set WS handshake headers) falls back to
  `?token=` in the WS URL. The server **never logs request URLs**, but treat the browser console
  as same-origin/localhost and don't paste that URL around.
- **Browser Origin policy (WS upgrade + REST CORS).** One allowlist covers both: localhost,
  the same host the request was dialed on, and anything in `CC_WS_ALLOWED_ORIGINS`. An allowed
  origin is reflected in `Access-Control-Allow-Origin` with no credentials flag — the bus has
  no cookies, so the grant unlocks only the public endpoints (`/health`, `/cc/whoami`) plus
  whatever the bearer token already unlocks. Any other origin gets no CORS grant and its WS
  upgrade is refused (403). The `null` origin a console opened as a `file://` page sends is
  **off by default** — any web page can forge it from a sandboxed iframe — and is enabled with
  `CC_ALLOW_FILE_ORIGIN=1` on the leader; the launcher-served `/console` is same-origin and
  needs nothing. A bad `?token=` on the WS upgrade counts against the same per-IP auth-failure
  limiter as REST (`429`). Non-browser Node clients (no `Origin`) are unaffected. The operator
  console subscribes with `?firehose=1` to receive every message over the socket; lanes get
  only what is addressed to them.
- **Bounds + rate limits (on by default).** 64 KB request-body cap (`413` over it), a bounded
  `/cc/import` read and WS frame buffer, and per-IP throttling of auth failures and message/claim
  churn (`429` on trip). Tunable via `CC_RL_*` / `CC_MAX_IMPORT_MB`.

## Version gate — every host must run the latest version

The bus refuses a host that is not on the **same version as the leader**, so a stale client is forced
to update before it can coordinate (PO ruling 2026-09-16). The leader is the authority: a client whose
release version (`package.json` semver, reported by `cc-rev.pkgVersion` — the only identity present for
plugin installs too) does not **exactly** match the leader's is refused **HTTP 426 Upgrade Required**.
The whole rule lives in one place — `server/version-gate.mjs`.

- **Enforced across the WHOLE data plane, not just join.** `versionGateMiddleware` gates every `/api`
  route (send, poll-receive, work-claim, data — *and* `/register`), and the `/cc/ws` upgrade is gated
  too. So a stale host cannot register, send, receive-poll, or claim — it is genuinely off the bus, not
  merely warned. (A signal on `/register` alone would let an old client that ignores the 426 keep
  coordinating on the other routes.) Node clients carry their version in the **`x-cc-version` header** on
  every request (and `&v=` on the WS URL); `cc-ws` / `cc-poll` print an update message, drop their
  liveness beacon (so the listen-gate blocks edits at once) and exit on a 426; `cc-name` refuses to name
  a stale session.
- **Two fail-OPEN carve-outs** so the gate can never brick the whole bus: `CC_VERSION_GATE_BYPASS=1` on
  the **leader** admits every version (rollout / emergency, logged loud at boot); and if the leader
  cannot read its own version it admits everyone rather than lock out the fleet.
- **The operator console is a viewer, not a host:** it echoes the *leader's* own version (read from
  `/cc/whoami`) on its requests, so it always matches and is never locked out of watching the fleet —
  without punching a `firehose` hole in the gate (every WS upgrade, firehose included, is checked).
- **Rollout is a hard cutover — update the LEADER FIRST.** The leader defines the required version, and
  election does not consider version, so a client updated *before* the leader is refused until the leader
  catches up, and a stale node that wins election pins the requirement backwards. Upgrade (or fail over
  to) the leader first, then roll the clients; `CC_VERSION_GATE_BYPASS=1` on the leader is the recovery
  lever if you invert the order or a stale node leads. `cc-bus status` shows each node's `version=`.

### Releasing (this is what forces the fleet)

Bumping the version **is** the lever, so a release **must** bump BOTH pins in lockstep — they are
compared against each other implicitly and a split will block hosts that are actually current:

- `package.json` → `version`  (what the gate reads via `pkgVersion()`)
- `.claude-plugin/plugin.json` → `version`  (the plugin identity Claude Code installs)

Then publish the plugin and reinstall it on every host (`cc-bus status` shows each node's `version=` and
flags a `⛔ VERSION MISMATCH`).

## Development

Run the suite with `npm test` (render · db · rest · server · ws · discovery · version-gate). Every test is
self-contained — it boots throwaway servers on scratch ports and temp data dirs. To exercise a
change against an **isolated** bus while a real one is running, hard-pin the client at your instance:
`node cc-work.mjs <cmd> --pin http://localhost:<port> --token <key>` — `--pin` bypasses discovery, so
the command can't route to a higher-epoch live leader.

> On **Windows + Node 24**, a non-fatal `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` line
> can print on process teardown — a Node dgram/UDP cleanup quirk, not Crosstalk logic. The tests still
> run and report correctly (exit 0).

## Identity & honest join status

`cc-join.sh` writes the session identity to `~/.claude/.cc-listen/<session_id>.id` (the
listen-gate reads it, never recomputes) and reports the **actual** register outcome —
`✅ CONNECTED` (2xx), `⛔ COULD NOT CONNECT` (unreachable), or `⛔ … rejected the token`
(401) — never an unconditional "joined".
