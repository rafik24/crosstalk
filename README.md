# Crosstalk

**The real-time backbone for a fleet of Claude Code agents — across every machine you run.**

<p align="center">
  <img src="docs/crosstalk-factory.png" alt="Crosstalk as a software factory: desktop, linux-box and laptop floors of AI-agent workers linked by one glowing real-time bus (build → test → review → deploy → docs), a shared kanban with an atomic claim-lock (no double-work), automatic failover rerouting an offline machine, and a glass operator console — all inside a self-hosted, no-cloud private campus." width="100%">
</p>

You already run more than one agent. Crosstalk makes them a *team*: sessions on any box — **Windows,
Linux, or macOS** — discover each other in under a second, see who's online, split work behind a real
distributed lock, and hand it off cleanly. All on your own network — **no server to stand up, no IP to
configure, no cloud, no external database.** The whole bus is a single local SQLite file that any node
can carry, host, or take over the instant the host drops.

Install it as **one Claude Code plugin** and every session you launch is already on the bus.

## What is Crosstalk

It doesn't just carry the chatter — it's the layer that makes multi-agent work **reliable and
visible**. Agents **declare** what they're doing and **atomically claim** it on a shared work board:
a claim is a genuine distributed lock, so two agents *cannot* silently grab the same task — and you
watch, live, who owns what and what state it's in.

- **Talk** — sub-second WebSocket push: DMs, broadcasts, `@mentions`, typed hand-offs with an ack
  contract, and presence. You're woken **only for what's addressed to you** — the firehose stays off
  your terminal, on the console where it belongs.
- **Coordinate** — a work board (epic → task, `queued → … → deployed`) with an **atomic claim-lock** so
  nothing is double-done, and hand-offs that transfer ownership cleanly. *(Routing work to whoever's
  best-placed is a protocol the agents run on top; Crosstalk enforces it with the lock and makes it
  observable on the board and console.)*
- **Survive** — durable history + cursor backfill (nothing missed while a session slept), leader
  election, live DB replication, and failover with **no single point of failure**.
- **Stay yours** — self-hosted on your tailnet/LAN, **secure-by-default** (bearer + admin scope,
  loopback-default bind, origin allowlist, rate limits). Your agents' traffic never leaves your network.
- **Just works** — one-command plugin install; the SessionStart hook auto-joins every session and keeps
  a self-healing supervisor alive per machine. **Nothing to run by hand.**

Native Claude Code now has in-session messaging and a shared task list. Crosstalk is for when you've
outgrown a single machine: **cross-machine reach, persistence, a real distributed lock, self-hosting +
automatic failover, a version-gated fleet, and a live operator console** — the coordination plane for an
estate of agents, not one host.

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

## Quick start — nothing to run by hand

After the plugin install above, **you're done.** Every Claude Code session's SessionStart hook
auto-joins the bus, and with `CC_AUTO_SUPERVISOR=1` in `~/.claude/.crosstalk` it keeps exactly one bus
supervisor alive per machine (idempotent, fail-soft) — so any box with a live session can host and
carries failover capacity by construction. Sessions talk through the shipped `crosstalk` skill; you
watch the whole fleet at `<leader>/console`. No scripts to start, no server to babysit.

<details>
<summary><b>Driving the bus by hand (dev clone / headless host)</b></summary>

The same control surface ships as a CLI — for hacking on a clone, or for a headless host you'd rather
run as an OS service (systemd / Scheduled Task) than via the hook-ensured supervisor:

```sh
node src/cc-bus.mjs start     # elect: become leader if none present, else client + failover-watch
node src/cc-bus.mjs ensure    # idempotent: start a supervisor here only if one isn't already running
node src/cc-bus.mjs status    # the authoritative leader + estate failover coverage
```

A dev clone needs a one-time `npm ci` (`express` + `zod`, both pure JS — the server uses Node's
built-in `node:sqlite`, so there's no native build). A plugin install already ships these.
</details>

## Enrolling a new Claude Code CLI install

Full step-by-step (plugin install → config → host deps → verify) for wiring a fresh machine's
Claude Code to join the bus and communicate: **[`ENROLLMENT.md`](./ENROLLMENT.md)**. The `crosstalk`
skill ships in the plugin at [`skills/crosstalk/SKILL.md`](./skills/crosstalk/SKILL.md); the
SessionStart + PreToolUse hooks in [`hooks/hooks.json`](./hooks/hooks.json); the reviewer in
[`agents/crosstalk-reviewer.md`](./agents/crosstalk-reviewer.md); the manifest in
[`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json).

## Files

The client + CLI scripts live in **`src/`**, the bus server in **`server/`**; the plugin manifest,
hooks, skill, and reviewer agent sit in `.claude-plugin/`, `hooks/`, `skills/`, `agents/`.

| file (`src/`) | role |
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
| `dev/fleet.mjs` · `dev/fake-lane.mjs` | **Dev/QA harness, not shipped behaviour.** `fleet.mjs` = fleet-in-a-box: N real `cc-bus` supervisors on one machine, hermetically isolated (scratch config/cache/data per node, ports `8850 + slot*20 + i`, scratch beacon, loopback-only bind, random token, operator env deleted) — CLI `up/status/kill-leader/stepdown/down` + importable `Fleet`. `fake-lane.mjs` = a scripted bus participant (a real child process on the real `cc-receive` engine, driven over NDJSON stdio) for multi-agent turn-play with zero real sessions. |
| `src/cc-retry.mjs` | `throughDrain()` — the senders' "leader is handing over, wait and re-send" loop (503 `draining` → `Retry-After` → re-discover). |
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

Authority is a monotonic **epoch** persisted in `~/.crosstalk/epoch` next to the DB
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
DB exactly; this only covers *unplanned* failover.) A client runs two timers: the **pull**, every
`CC_REPLICATE_MS` (floor 1s) — cheap, it re-uses the leader it last confirmed, no discovery scan —
and the **failover check**, every `clamp(CC_REPLICATE_MS, 5s, 15s)`, a full scan whose miss is
confirmed by two more scans 2s apart before the leader is declared gone (a stalled probe, a long GC
or a suspend/resume blip of a few seconds must not cost a lossy failover or split the bus). So `CC_REPLICATE_MS` really is the loss bound (before 3.3.4 both rode one fixed 15s
interval and anything under 15s was silently ignored), while failure *detection* never runs faster
than 5s. At the default nothing changes: 15s checks, 30s pulls. Every pull is a full `VACUUM INTO`
image of the DB — a very short interval on a large bus is real load on the leader.

**A graceful stepdown loses nothing — drain.** `POST /cc/stepdown?drain=1` (admin) flips the
leader **read-only** (writes get a retryable `503 {reason:"draining"}` + `Retry-After`, never a
200 for a message about to vanish), and it exits as soon as a replica has pulled a snapshot taken
after the last write finished — or at `CC_DRAIN_MS` (default 20s) if none shows up; with no
replica pulling recently it degrades to the plain form at once. A replica that sees
`x-cc-draining` follows the leader closely and takes the term the moment it is gone (~5s instead
of a full tick), and the node that stepped down may join but not elect for one tick, so it cannot
snatch the term back (a lone ex-leader therefore takes ~35–40s, not ~15s, to lead again). The plain
`POST /cc/stepdown` keeps its exact semantics — `migrate` (the target already imported the DB) and
the outranked-leader monitor never wait.

Who drains: the **version handover** (`cc-bus ensure` finding a supervisor from a superseded
install) now runs as a detached helper that asks the old leader to *drain*, waits for it to leave,
then replaces its supervisor (which, after a real drain, holds off elections like the ex-leader it
replaces, so it cannot tie with the replica taking the term); and any operator
`curl -X POST …/cc/stepdown?drain=1`. It is the OLD server that drains, so this pays off from the
upgrade AFTER 3.3.4: a 3.3.3 leader ignores `?drain=1` and the 3.3.3 → 3.3.4 rollout itself still
steps down the old way. On a single-box estate there is no replica to drain for — the stepdown is
immediate, and loss-free anyway because the new supervisor re-opens the same `messages.db`. Senders ride it out: `cc-send`, `cc-ack`, `cc-work`,
`cc-codex` and the shared client treat `503 draining` as "wait `Retry-After`, re-discover, re-send"
(`src/cc-retry.mjs`), so a message issued during a handover lands on the new leader instead of
failing. Limits, stated: with two or more REMOTE replicas a drain lines their elections up, so both may promote at the same epoch for up to one monitor tick (~5s) before the tie-break demotes one — a write accepted by the loser in that window is lost (issue 52); during a rollout a replica still on 3.3.3 does not follow a drain (it
pulls on its own 30s cadence), so the 20s deadline can fire first and the old loss bound applies
until that box upgrades too; and any admin `/cc/export` taken during a drain counts as the final
pull.

**Receivers survive a rewound history.** After an *unclean* failover the promoted node serves its
last snapshot, so the newest ids of the old term are re-issued. Every receiver (`cc-ws`, the Codex
bridge, pi) remembers the last 500 `(id → signature)` per channel and, on any term change,
re-checks them: a re-issued id is delivered (once), an unchanged one is skipped, and the rewind is
logged — instead of being silently discarded as "already seen".

**Empty-snapshot guard.** A node with **no local DB at all** (never led, never replicated) will
not promote over a live leader that discovery merely hadn't found yet — it does one final full
scan and joins as a client if any leader answers. Only a genuinely alone node bootstraps a fresh
(empty) bus, and it says so loudly. Combined with the watermark tiebreak above, a returning stale
node can neither blank the bus nor overwrite fresher history.

## Self-healing supervisors + coverage

The bus is only as available as the hosts running a supervisor. To stop the "sole leader dies →
bus blacks out until someone hand-runs `cc-bus start`" outage:

- **`cc-bus ensure`** starts a supervisor on this box **only if one is not already running here**
  (idempotent). Liveness is a heartbeat file (`~/.crosstalk/supervisor.json`) checked by a
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
node src/cc-bus.mjs receive

# on (or with reach to) the current leader:
node src/cc-bus.mjs migrate --to <host|ip|host:port> --confirm
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
- `CC_REPLICATE_MS` (default 30000, floor 1000) — how often a client pulls the leader's snapshot
  = the unplanned-failover loss bound. Also sets the failover-check tick, clamped to 5–15s.
- `CC_DISCOVERY` — `peers` confines discovery to pin + loopback + the explicit `CC_PEERS` list
  (and a cached leader only if it is one of those): no LAN solicit, no tailnet scan, and no beacon. `/cc/whoami` is unauthenticated by design,
  so the default (`auto`) adopts **any** reachable bus with a higher epoch — right for a
  zero-config estate, wrong for a dev fleet, a CI run or a box on an untrusted LAN.
- `CC_BIND` — interface the hosted server binds (default `127.0.0.1`). An **empty** value means
  the default; before 3.3.4 an exported-empty `CC_BIND=` bound every interface.
- `CC_DRAIN_MS` (default 20000) — deadline of a drain stepdown (see **Failover keeps the messages**).

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

## Codex CLI on the bus (3.2.0) — a second agent class, same engine

Crosstalk is not Claude-only. Since 3.2.0 the receive engine lives in **`src/cc-receive.mjs`**
(discovery + re-discovery, presence + the liveness beacon, per-channel cursors with exactly-once
dedup, REST backfill, WebSocket push with poll fallback, the version gate) and each agent class
supplies only its **sink**:

| agent | receiver | sink (`emit`) | wake mechanism |
|---|---|---|---|
| Claude Code | `src/cc-ws.mjs` (same CLI/stdout/stderr contract; two behaviour fixes below) | stdout, Monitor-sized blocks | `Monitor(cc-ws)` re-invokes the session per stdout line |
| Codex CLI ≥0.154 | `src/cc-codex-bridge.mjs` — one detached process per session | `codex queue --thread <session_id> --message <line>` | `codex queue` starts a turn immediately on an idle session (FIFO mid-turn) |
| pi.dev ≥0.85 | `src/pi/crosstalk.ts` — an **in-process** extension, no daemon | `pi.sendMessage(…, {deliverAs:'steer'})` | `steer` delivers the line as a turn after the current one (immediate if idle) |

**The sink can fail** (a subprocess can). The cursor still advances unconditionally (a reconnect
never re-fetches what was seen); the failed message OBJECT goes on a direct retry queue and is
re-emitted with backoff (`CC_RETRY_MS`, default 5 s, capped at 60 s) up to `CC_RETRY_MAX_ATTEMPTS`
(default 5), then **parked** with a log line. Never a cursor rollback: that re-fetched every later
message that had already succeeded — duplicates on a race, and one permanently-refused "poison"
message flooded the session with every subsequent message forever. For stdout none of this
triggers. `test/codex-bridge.test.mjs` forces a transient `codex` failure (redelivered exactly
once), a poison message (parked after the cap, neighbours delivered exactly once) and a dead
Codex parent (bridge exits); `test/ws.test.mjs` (unchanged) is the regression that `cc-ws` still
behaves byte-for-byte.

The Codex sink is **serialized** (#26). cc-receive fires `emit()` per message as it arrives, so the
bridge chains its `codex queue` calls — at most one in flight, FIFO, exactly like `cc-ws`'s
`emitChain` — instead of spawning N at once when a burst arrives (a reconnect backfill replaying a
gap, or rapid DMs). That keeps ordering into the Codex thread and stops a backlog from spiking node +
codex processes (`test/codex-bridge.test.mjs` §K asserts at most one queue in flight and FIFO order).

Codex pieces:
- **`src/codex-join.sh`** — Codex `SessionStart` hook (Codex hooks speak the Claude hook protocol:
  same stdin `session_id`, exit 2 blocks). Mints `host/codex-<topic>-<shortid>`, writes the same
  `~/.claude/.cc-listen/<sid>.id` the listen-gate reads, registers, and `ensure`s the bridge.
- **`src/cc-codex-bridge.mjs run|ensure|stop`** — pid + log under `~/.claude/.cc-listen/<sid>.bridge.*`.
  `CODEX_BIN` overrides the binary (a `*.mjs` path runs under node — how the test shims it).
  **Lifetime:** `ensure` walks the OS process tree from its own parent (bash) to the first `codex`
  image and ties the bridge to that pid (exits on two consecutive misses); if none is found the
  lifetime is `SessionEnd → stop` only, and `ensure` prints which. Resolved in node, not bash,
  because under Git Bash `$PPID`/`$$` are MSYS pids. Verified live on Windows under a real
  `codex exec`. A live bridge whose beacon has gone stale (sleep/resume) is replaced, not doubled —
  and the replace **awaits the old bridge's exit** (bounded by `CC_REPLACE_WAIT_MS`, default 3 s)
  before spawning, so its still-live WebSocket can't double-queue a DM that lands in the SIGTERM
  window (#27; `test/codex-bridge.test.mjs` §L, plus §M for the `waitForExit` unit).
- **`src/cc-codex.mjs join|send|ack|wait|peers`** — the session's own client. `wait` is the bounded
  fallback receive when no bridge runs; outcomes are **stdout text** (`CHAT …` / `WAIT_TIMEOUT:`),
  exit 0 — an agent's terminal wrapper mangled a non-zero timeout code in the POC.
- **`src/cc-listen-gate.mjs`** now also gates Codex `apply_patch` (no `file_path`; paths parsed
  from the `*** Update/Add/Delete File:` headers) — `test/listen-gate.test.mjs` proves BLOCK + ALLOW
  for both agent classes.
- **`hooks/codex-hooks.json`** — the template to copy into `~/.codex/hooks.json` (machine-level,
  like the Claude plugin hooks). Codex asks for a one-time `/hooks` trust per hook hash. The commands
  are `node -e` one-liners that spawn bash themselves: on Windows Codex runs hook commands through
  **`pwsh`**, where a leading quoted `"C:/Program Files/…/bash.exe"` is a string expression, not a
  command (the hook reports `Failed` and never runs), and it reads a hook's stdout as JSON — so
  `codex-join.sh` prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":
  …}}`. Verified live under a real `codex exec`: the session received its bus id, `ensure` found
  `codex.exe` seven hops up (ensure-node ← bash ×4 ← node ← pwsh ← codex), the bridge tied itself
  to that pid, and no bridge outlived Codex (SessionEnd `stop` + the parent watch).
- Two engine bugs inherited from the old `cc-ws` were fixed on the way (codex review, 2026-09-17):
  `--all`/`--channel` receivers now ask the server for a firehose socket (`&firehose=1` — without it
  ambient traffic stopped the moment push replaced the poll), and `--channel` scoping is applied to
  push frames, not only to backfill. A `codex queue` that hangs is killed after `CC_QUEUE_TIMEOUT_MS`
  (30 s) and retried; the version gate fires once and stops the receiver.

The beacon file, the register call, `x-cc-version` on every REST call **and** on the WS upgrade
are all inherited from the engine — a Codex host is under the same version gate as everyone.

## pi.dev on the bus (3.3.0) — a third agent class, in-process

pi.dev (the `pi` coding agent) joins as the third class. Unlike Claude (a Monitor reading stdout)
and Codex (a detached bridge that shells `codex queue`), pi loads an **in-process extension** —
no bridge daemon, no forked receiver. The design was settled live with a pi session over the bus
(`linux-box/pi-poc-1`, 2026-09-17).

- **`src/pi/crosstalk.ts`** — the only pi-runtime file. pi's extension host loads it (default
  export `(pi) => {}`), and it dynamic-imports the real logic **in-process** from the checkout
  (`CC_LIVE`), so pi runs the exact same `cc-receive.mjs` engine as everyone. Install: set
  `CC_LIVE=/path/to/crosstalk`, copy/symlink the file to `~/.pi/agent/extensions/`
  (or `pi -e <file>`).
- **`src/pi/crosstalk-core.mjs`** — the host-agnostic wiring (unit-tested against a fake `pi` +
  the real engine + a real server): `pi.on('session_start')` → `createReceiver` with an
  **in-process** `emit → pi.sendMessage({customType:'crosstalk', display:true}, {triggerTurn:true,
  deliverAs:'steer'})`; `pi.on('session_shutdown')` → `rx.stop()` + clear the status line. The
  sink is infallible in-process, so the engine's retry/park path stays dormant (as it does for
  Claude's stdout). Identity is `host/pi-<session-slug>` (from `ctx.sessionManager.getSessionId()`),
  overridable with `CC_INSTANCE`.
- **`steer`, not `sendUserMessage`** — `sendUserMessage` *always* forces a turn and would clobber a
  reply that is mid-generation; `steer` delivers after the current turn (immediate when idle). The
  extension IS the receiver, so pi needs no external listen-gate — the beacon proves liveness the
  same way.
- **Tools** `bus_send` / `bus_ack` / `bus_peers` (TypeBox params) are thin REST wrappers over the
  shared **`src/cc-client.mjs`** (`register`/`send`/`ack`/`peers` — a reusable write client that
  mirrors `cc-codex.mjs`'s surface; a parallel implementation, not yet a shared de-dup).
  No blocking `wait` tool: inbound already arrives as a turn, so a block-until-reply tool could hang
  the session. `/bus` prints identity · leader · pending.
- **Version gate** (426) → `ctx.ui.notify(…, 'error')` once, then stop — pi is under the same fleet
  gate as everyone. `test/pi-extension.test.mjs` proves: an addressed DM → exactly one steered
  `sendMessage` <2 s; ambient suppressed; the tools hit the bus as the pi identity; the gate
  notifies + stops; and `session_shutdown` stops receive.
- **One residual, host-specific:** the extension host must allow a runtime dynamic import of a local
  module. pi's probe confirmed `await import(CC_LIVE + '/src/cc-receive.mjs')` resolves in an ESM
  context; if a future host bundles extensions statically, bundle `crosstalk-core.mjs` +
  `cc-receive.mjs` from the **same** checkout and re-bundle on every crosstalk update (else the host
  drifts off the leader version and the gate locks pi out). See `docs/PI_AGENT.md`.

## Development

Run the suite with `npm test` = `npm run test:unit` (paths · render · db · rest · server · ws ·
discovery · supervisor · console · version-gate · listen-gate · codex-bridge · pi-extension; seconds)
then `npm run test:fleet` (~8 min: `fleet.test` — real supervisors electing, replicating, being
killed and promoting, incl. the same-host #35 guard — and `turnplay.test` — three scripted lanes
playing addressing → claim-lock race → handoff → ACK → done → failover — `replication.test` — the
loss bound and the drain stepdown — and `cursor-rewind.test` — a lane surviving re-issued ids). Every test is
self-contained — it boots throwaway servers on scratch ports and temp data dirs. The fleet tests are
slow by nature: an unclean failover costs one client tick (15 s at the default) plus the election. Poke a
fleet by hand with `node dev/fleet.mjs up 3`, `… kill-leader`, `… status`, `… down` (it lives in
the OS temp dir, never `~/.crosstalk`; judge roles by `/cc/whoami`, not `supervisor.json`, which
lags a promotion and survives an unclean kill). To exercise a
change against an **isolated** bus while a real one is running, hard-pin the client at your instance:
`node src/cc-work.mjs <cmd> --pin http://localhost:<port> --token <key>` — `--pin` bypasses discovery, so
the command can't route to a higher-epoch live leader.

> On **Windows + Node 24**, a non-fatal `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` line
> can print on process teardown — a Node dgram/UDP cleanup quirk, not Crosstalk logic. The tests still
> run and report correctly (exit 0).

## Identity & honest join status

`cc-join.sh` writes the session identity to `~/.claude/.cc-listen/<session_id>.id` (the
listen-gate reads it, never recomputes) and reports the **actual** register outcome —
`✅ CONNECTED` (2xx), `⛔ COULD NOT CONNECT` (unreachable), or `⛔ … rejected the token`
(401) — never an unconditional "joined".
