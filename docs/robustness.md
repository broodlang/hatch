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

## Tier 2 — correctness / info-leak  🚧 (in progress)

- **Don't leak internals in the default 500.** ✅ `http/server`'s fallback no longer
  echoes the exception text. On a raising handler it emits a `[:hatch :request :exception]`
  telemetry event (method/path/error — the logging hook) and answers whatever
  `:error-handler` returns. Knob: `:error-handler` — a `(fn [request err-message] →
  response)`, default `server-error-resp` (a generic 500 with no detail in the body). The
  old `error-resp` (which embeds the message) remains as an opt-in debugging helper.
- **Chunked `Transfer-Encoding`.** The parser only honors `Content-Length`; a
  `chunked` request is mis-parsed. Add request de-chunking.
- **Graceful shutdown / drain.** `stop` brutal-kills the listener; active connections
  aren't drained. Add a drain phase (stop accepting, let in-flight finish, deadline).
  Knob: `:shutdown-grace-ms`.
- **WebSocket limits.** No max frame size and fragmented (continuation-frame) messages
  aren't reassembled. Knobs: `:ws-max-frame-bytes`, `:ws-max-message-bytes`.

## Tier 3 — features / deeper hardening  ⬜ (planned)

- **Server-side TLS** (HTTPS / WSS) — today TLS is client-only (`tls-request`).
- **Supervise the live registries** — `:hatch-live` / `:hatch-live-routes` are
  lazily spawned; a crash empties the route table until the next module load. Put them
  under a supervisor (with state recovery / re-registration).
- **HTTP/2** — its own project (HPACK, framing, stream multiplexing, flow control);
  this is where genuine process-per-request (per stream) would live.

---

## Notes

- All limits are **per-connection** except `:max-connections` (per-listener). They
  compose with the existing per-connection process isolation and the socket-cleanup-
  on-death fix (a dead worker's socket is reclaimed by the runtime).
- Defaults aim to be safe-but-generous; an app tunes them by passing a config map to
  `server/start` (the demo's `web/endpoint` is the place to set them).
