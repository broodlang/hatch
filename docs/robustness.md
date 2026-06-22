# Server robustness — hardening the HTTP pipeline

Hatch's `http/server` is correct and process-isolated on the happy path, but the
request pipeline needs hardening before it's safe to expose to hostile traffic. This
doc tracks that work in three tiers, by risk. Everything here is `http/server`-level
Brood — no new dependencies, no Rust.

Config lives in a **server config map** passed to `(server/start port handler ws-handler config)`,
merged over `default-config`. Each knob below names its key.

---

## Tier 1 — DoS / hostile-traffic limits  ✅ (configurable)

Without these the server is trivially exhausted by a single bad client.

- **Read timeout** — `:read-timeout-ms` (default 30000). A worker waiting for more
  request bytes (`worker--run`'s `:incomplete` branch) used to `receive` forever, so a
  client that connects and sends a partial request (or nothing) pinned a worker
  process indefinitely — classic slow-loris. Now the receive has an `(after …)` that
  answers **408 Request Timeout** and closes.
- **Request-size cap** — `:max-request-bytes` (default 8 MiB). The incomplete-request
  buffer used to grow unbounded (`(str buf chunk)`), and the parser reads the full
  `Content-Length` body into memory. A large/streamed request was an OOM. Now the
  worker rejects with **413 Payload Too Large** once the accumulated bytes exceed the
  cap.
- **Max connections** — `:max-connections` (default 1024). The listener spawned a
  worker per connection without limit — a connection flood = unbounded process spawn.
  Now the listener tracks live connections (one `monitor` per worker, decrement on
  `[:down …]`) and **refuses** (closes) a new connection over the cap.

## Tier 2 — correctness / info-leak  ✅ (done)

- **Don't leak internals in the default 500.** ✅ `http/server`'s fallback no longer
  echoes the exception text. On a raising handler it emits a `[:hatch :request :exception]`
  telemetry event (method/path/error — the logging hook) and answers whatever
  `:error-handler` returns. Knob: `:error-handler` — a `(fn [request err-message] →
  response)`, default `server-error-resp` (a generic 500 with no detail in the body). The
  old `error-resp` (which embeds the message) remains as an opt-in debugging helper.
- **Chunked `Transfer-Encoding`.** ✅ `http/request` now de-chunks a
  `Transfer-Encoding: chunked` body (chunk sizes, extensions, trailers, pipelined
  remainder). `Transfer-Encoding` + `Content-Length` together is rejected (smuggling),
  and any non-`chunked` coding (gzip, …) is rejected rather than mis-framed.
- **Graceful shutdown / drain.** ✅ `stop` now drains: the listener stops accepting
  (closes the listen socket), waits for in-flight workers to finish up to
  `:shutdown-grace-ms` (default 5000), hard-kills any stragglers past the deadline, and
  only then tears down the supervisor. The listener tracks live worker pids (not just a
  count) so it can wait on and kill them.
- **WebSocket limits.** ✅ `http/websocket` now reassembles fragmented messages
  (a non-FIN data frame + continuation frames) and caps both a single frame
  (`*ws-max-frame-bytes*`, default 65535 — the 16-bit max, since 64-bit lengths are
  rejected) and a reassembled message (`*ws-max-message-bytes*`, default 1 MiB — the
  active guard against a fragment flood). An interleaved non-continuation frame
  mid-message is rejected. The caps are **module-level defaults by design**, not server
  `config` knobs: they're a protocol-security floor identical for every server, and
  `parse-frame` is reached deep in the live read loop (`live-dispatcher` → session →
  `recv-frame--loop`), so per-server plumbing would mean breaking the `(sock request)`
  ws-handler contract for tuning nobody changes. `parse-message` takes the caps as
  arguments if a caller ever needs to override them.

## Tier 3 — features / deeper hardening  🚧 (in progress)

- **Server-side TLS** (HTTPS / WSS) — ✅ The brood runtime gained `tls-listen host port
  cert-pem key-pem` (a TLS listener that terminates TLS per connection — a per-connection
  actor owns the rustls `ServerConnection`, decrypting inbound to `[:tcp …]` and encrypting
  `tcp-send`, so accepted sockets are transparent and `worker--run` is unchanged) and
  `tls-self-signed host` (rcgen, for zero-config dev). `http/server`'s `:tls {:cert :key}`
  config routes the bind through `tls-listen`; `web/endpoint` reads `TLS_CERT_FILE` /
  `TLS_KEY_FILE` (production) or generates a self-signed localhost cert in dev when
  `HATCH_TLS` is set. WSS comes for free (the WebSocket upgrade rides the same transport).
  Verified end-to-end (`curl -k` → 200, live mounts, themed errors).
- **Supervise the live registries** — ✅ `:hatch-live`, `:hatch-live-routes`, and a new
  `:hatch-live-routes-vault` run under a `:one-for-one` supervisor (`:hatch-live-sup`),
  started once at `web/live` load. The route registry mirrors every entry to the vault
  and re-seeds from it on (re)start, and *monitors* the vault to re-mirror when the vault
  restarts — so a registry crash no longer empties the route table. `live--ensure`
  self-heals: it (re)starts the supervisor on demand if it isn't running.
  (Note: the registry tests pass under the default and `-j2+` runners but fail under
  `nest test --max-parallel 1`. That's a **brood runtime bug**, not this code: with a
  single worker thread, a `nest test` body that makes a synchronous call to another
  spawned process deadlocks (the callee never gets scheduled). Minimal repro — no hatch:
  a test that `(spawn …)`s a server, `(send)`s it a ping and `(receive …)`s the reply
  times out under `-j1`, passes under `-j2`. `nest run -j1` is unaffected. The committed
  registry tests failed under `-j1` the same way before this change.)
- **HTTP/2** — its own project (HPACK, framing, stream multiplexing, flow control);
  this is where genuine process-per-request (per stream) would live.

---

## Notes

- All limits are **per-connection** except `:max-connections` (per-listener). They
  compose with the existing per-connection process isolation and the socket-cleanup-
  on-death fix (a dead worker's socket is reclaimed by the runtime).
- Defaults aim to be safe-but-generous; an app tunes them by passing a config map to
  `server/start` (the demo's `web/endpoint` is the place to set them).
