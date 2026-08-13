# Archive — shipped phases (Phases 1–11)

*Split out of [`../roadmap.md`](../roadmap.md) on 2026-08-13. This is the historical
record of what each phase actually built, including the scope calls and trade-offs made
along the way. Nothing here is outstanding work — the live backlog lives in the roadmap.
Read this when you need to know **why** something is the way it is; skip it otherwise.*

---

## Completed phases

### Phase 1 — Stdlib gaps ✅
- `http/util` — URL percent-decode, query-string parser, status codes
- `http/base64` — pure-Brood base64 encode (RFC 4648), for WS handshake
- `web/live` — minimal JSON encode/decode for the wire protocol

### Phase 2 — `http/*` — our Bandit ✅
- `http/request` — HTTP/1.1 parser, pipelining-safe (`[:ok req remainder]`)
- `http/response` — response serializer + convenience constructors
- `http/server` — listener/worker actor tree; detects WS upgrade
- `http/websocket` — RFC 6455 handshake (SHA1 + base64 accept key), frame
  encoder/decoder, masked frame unmasking, 256-byte char table

### Phase 3 — `web/template` ✅
- Hiccup `[:tag attrs & children]` → HTML string
- Self-closing void tags, boolean attrs, class vectors, `raw` escape bypass
- `html/1` with `<!DOCTYPE html>` prefix

### Phase 4 — `web/conn` + `web/router` ✅
- `web/conn` — immutable conn map, `assign`, `halt`, `run-pipeline`,
  `html-resp`, `text-resp`, `json-resp`, `redirect-resp`, `not-found-resp`
- `web/router` — `parse-pattern` (`:param` capture, `*splat`), `dispatch`,
  `defrouter` macro that compiles routes at load time, incl. the `(live …)` clause
- `web/static` — MIME table + path-safe static file handler

### Phase 5 — `web/live` ✅
- `deflive` macro — `mount`/`render`/`on`/`tick` clauses expand to `defn`s
- Per-connection session actor loop — receives WS frames, handles events,
  re-renders, sends diffs
- `(live path module)` router clause + `live-dispatcher` — wire live views in the
  router; the dispatcher routes WebSocket connections to the right view by path
- `static/brood_live.js` — vanilla JS client: WS connect, join, event push,
  render/diff handling, DOM morphing, auto-reconnect (~200 lines, no npm)

### Phase 6 — HTTP Tier-1: params, cookies, sessions, flash ✅
- **Body params** — `http/util/parse-body-params` parses
  `application/x-www-form-urlencoded` and `application/json` bodies; `web/conn/build`
  merges them into `:params` (query < body < path), so handlers read form/JSON fields the
  same way as query params. multipart/uploads still deferred (Phase 9).
- **Cookies** — `web/conn` parses the request `Cookie` header into `:cookies`
  (`get-cookie`), and `put-cookie`/`delete-cookie` accumulate `Set-Cookie`s;
  `http/response` emits one header line per list-valued header (multiple `Set-Cookie`).
- **Before-send hook** — `web/conn/register-before-send` runs conn→conn callbacks at
  `conn->response` time (à la Plug's `register_before_send`), the seam sessions/flash use
  to write cookies from the finished conn.
- **`web/session`** — signed cookie session store (HMAC-SHA256 over base64url(JSON),
  constant-time verify; Phoenix's default `:cookie` store shape). `fetch-session` plug,
  `get`/`put`/`delete`/`clear-session`, write-back only when changed. (The Phase 7 sketch
  of a process-backed store + session-id cookie can layer on later as an adapter; an
  encrypted variant is a small follow-up — ChaCha20-Poly1305 is already in the stdlib.)
- **Flash** — `put-flash`/`get-flash` + the `fetch-flash` plug, one-shot messages carried
  in the session across a redirect (POST→redirect→GET).
- Demo: live `/signup` (as-you-type validation over the socket) + plain `/account`
  (form body params + session + flash via PRG).

### Assets & dev tooling ✅
- `web/assets` — build-step-agnostic bundler glue over one config map: `watch`
  (dev watchers via `proc-spawn`, output → log), `build` (one-shot, fail-loud),
  `install` (first-time download). No framework coupling to any tool. See
  `docs/assets.md`.
- **CSS hot-reload** — a watcher rebuild → `web/live/notify-reload-css` →
  `[:reload-css]` to open sessions → `brood_live.js` re-stamps `<link>` hrefs.
  Stylesheet swaps in place; live model/state untouched (no page reload).
- `web/template/stylesheet` — `<link rel=stylesheet>` Hiccup helper.
- **Tailwind v4 + daisyUI** in the demo (no npm): standalone CLI + vendored plugin,
  `bin/setup` installs them, `assets/app.css` is the source, layout links the output.
- `web/test` — view test harness: synthetic conns, `request`/`call` through a router
  or handler, `status`/`body`/`body-contains?`/`resp-header`, and live-view drivers
  `live-mount`/`live-event`/`live-tick`/`live-render`/`live-html`. (Supersedes the
  Phase 10 `web/conn/test` sketch.)
- **Asset caching & conditional requests** ✅ — every static response (and `brood_live.js`)
  flows through `web/static/serve-body`: a strong content **ETag** (→ bodyless **304** on
  `If-None-Match`), **`X-Content-Type-Options: nosniff`**, **`Accept-Ranges`** with
  best-effort byte ranges (**206**/**416**, full-200 fallback for multibyte/multi-range), and
  an env- + fingerprint-aware **`Cache-Control`** (`no-cache` in dev / for plain URLs;
  `immutable`, one-year for fingerprinted ones).
- **Content fingerprinting** ✅ — `web/assets/fingerprint` (opt-in `:fingerprint` build step)
  rewrites built assets to content-addressed names (`app.<sha>.css`) + a `cache-manifest`;
  `web/static/asset-path` emits the fingerprinted, cache-forever URL in prod and the plain
  (revalidated) name in dev. See `docs/assets.md`.

---


## Phases 6–11 — all complete

Every numbered phase is done as of 0.4.1 (2026-08-11). What is genuinely still open is
collected in *Still open* below; the per-phase entries here are the record of what shipped.

### Phase 6 — Static/dynamic template split (diff optimisation) ✅

Live updates no longer re-send the full HTML — only the dynamic slots that changed.

- **`web/parts` slot compiler** ✅ — `compile-parts` runs at macro time (in `deflive`),
  splitting a render form into `:statics` (literal HTML, baked once) and `:dynamics`
  (per-hole forms). Granular for literal structure + value/attr holes; an `(if …)`,
  `(for …)`, component call, or `(map …)` becomes one opaque dynamic — correct, just
  coarser. `deflive` emits `render-static` + `render-dynamic` alongside the full `render`,
  guarded by an invariant test (`interleave(static, dynamic) == render`).
- **Wire protocol v2** ✅ — `{"event":"join","s":[…],"d":[…]}` on connect, then
  `{"event":"diff","d":{"0":"42"}}` carrying only the changed slot indices.
- **`brood_live.js` slot patcher** ✅ — keeps statics + dynamics, patches changed slots,
  re-interleaves, and morphs (so focus/caret survive).
- **Still possible later (Option A++):** per-item comprehension diffing (a `:for` is one
  opaque slot today), and slot fingerprints to drop statics on reconnect.

### Phase 7 — Sessions, CSRF, and auth ✅

- **`web/session`** ✅ — signed-cookie session store (Phase 6); a process-backed
  store + pluggable persistence adapters remain a later option.
- **`web/csrf`** ✅ — synchronizer-token CSRF: a per-session token (minted by the
  `protect-from-forgery` plug), embedded in forms via `csrf-input`, verified
  (constant-time) on POST/PUT/PATCH/DELETE; an `X-CSRF-Token` header is accepted for
  fetch/JSON clients. Demo: `/account`.
- **`web/auth`** ✅ — HTTP Basic-auth plug (`basic-auth`) for router `through` groups:
  constant-time credential check, `WWW-Authenticate` challenge on mismatch. Demo: `/dev`.
  Enough to gate a dev/admin endpoint; not a general login system.
- **Auth convention (live views)** ✅ — `(on-mount-guard (conn) …)` clause in `deflive`:
  runs before `mount`, on the initial WS connect and on every live-navigate into the view
  (a Conn is built once from the WS upgrade request and carried across navigations).
  Return `nil`/`false` to allow the mount, or a path string to veto — the client gets the
  same `{"event":"redirect"}` message live-navigation already sends for a cross-group
  jump (a full reload, so the target path's own HTTP `through` plugs run). The guard
  decodes the session itself (`((session/fetch-session secret) conn)`), so `web/live`
  stays session-agnostic, same as it already is for CSRF. Deliberately *not* done:
  `mount` itself still only takes `(params)` — extending it to see the session too would
  force a breaking 2-arg signature on every existing view for a need the guard alone
  already covers; a narrower follow-up if a view's own business logic needs session data.
  Demo: `/dashboard` in hatch-demo, gated on the session name `/account` sets, verified
  live over a real WS handshake (no cookie → redirect to `/account`; with one → normal
  join/render).

### Phase 8 — LiveComponents (v1) ✅

Scope call made mid-implementation, diverging from this section's original wording
("each a separate Brood process"): after reading `web/parts`' diff compiler closely,
v1 ships **in-process** components instead — matching how Phoenix's real
`LiveComponent` actually works (a separate-process nested LiveView is a different,
heavier, rarely-used Phoenix mechanism). A component's state lives in the session's own
per-id table, embedded as one opaque dynamic slot in the parent's existing static/dynamic
split — the same "coarser but correct" precedent already used for `if`/`for`.

- **`web/component`** ✅ — new module. `deflive-component` (`mount`/`render`/`on` →
  `live-component-spec`, factored from `deflive`'s shared expansion helpers rather than
  duplicated) + `LiveComponentModule` behaviour.
- **Component slots** ✅ — `(component module assigns)` in a parent's template/`.bml`
  (`assigns` must carry a string `"id"`). `web/parts`' `walk` gets a dedicated
  `component-form?` case compiling it to `web/component/render-slot`, resolving
  `module/live-component-spec` at compile time (mirrors `web/router`'s `module/live-spec`
  resolution) — no change to the string-equality diff logic in `web/parts/diff-dynamics`.
  `mount` runs once per id (a session-lifetime `table`, carried across live-navigate);
  a parent re-render alone never re-mounts or touches a live component's state.
- **`send-update`** ✅ — `(send-update session cid changes)` delivers
  `[:update-component cid changes]` to the session mailbox (mirrors `send-info`'s shape
  exactly) — merges into the component's stored state and triggers a re-render on the
  session's next receive-loop pass (so it lands as a separate diff frame after whatever
  triggered the send, same async shape as `send-info`).
- **Event routing** ✅ — a component's rendered root is wrapped in `[:div {:data-cid id}
  …]`; `brood_live.js` reads the nearest ancestor `data-cid` and includes it on the wire
  event. `session-dispatch` routes a `cid`-carrying event to that component's own
  `handle-event` instead of the parent's.
- Demo: `web/views/components/like-button` embedded in `/dashboard` — verified live over
  a real WS handshake: a direct click on the component sends only its own slot in the
  diff (`{"1": "...♥ Liked..."}`, not a full re-render); a separate `send-update` call
  from the parent's own `bump` handler (not the component's event) also reaches it, one
  frame later.
- **Explicitly out of v1 scope** (the "coarser but correct" trade-off, same shape as the
  `:for`-diffing carve-out below): a component doesn't get its own wire-level diff yet —
  a state change re-sends its whole slot's HTML rather than a minimal patch, and there's
  no component-level `tick` (a parent's own tick can `send-update` if a component needs
  periodic refresh). Independent wire-level component diffing is real follow-up work.

### Phase 9 — Forms, uploads, navigation ✅

- **`web/form`** ✅ — a small, composable validation toolkit, not a changeset object
  (matching `web/session`/`web/csrf`'s plain-functions-over-plain-maps style):
  `(validate params rules)` → `[:ok params]`/`[:error {field message}]`, `rules` a
  vector of `[field validator-fn message]` triples. Built-in validators
  (`required?`, `email?`, `min-length?`, `max-length?`, `matches-pattern?`) are each
  just `(fn (value) bool)` — including one built as a validator *factory* (`min-length?`
  takes `n`, returns the actual predicate) — so a storage-backed check (e.g.
  "email already taken") composes as an ordinary rule whose predicate closes over a
  repo/query call made by the *caller*; `web/form` itself never depends on any
  storage module. `error-for`/`field-class` are the template-side helpers every
  hand-rolled form in this codebase was already reimplementing per field. Demo:
  `web/views/signup` (hatch-demo) refactored onto it for the *live*, as-you-type case;
  `web/views/account`'s `save` gained a real validation (`max-length? 50` — blank
  still means "clear my name", so `required?` would have broken that existing feature).
- **`live-navigate`** ✅ — turned out to already be fully built (an earlier phase, this
  roadmap entry was just never updated): `web/live/session-dispatch`'s "navigate" case +
  `brood_live.js`'s `pushState`/`popstate` wiring is Phoenix's `live_redirect`/
  `push_navigate` equivalent (swap to a *different* mounted view, same socket, full
  remount). What was actually still missing — Phoenix's `push_patch` — is done now:
  an optional `(handle-params (params model) …)` `deflive` clause (mirrors
  `handle-info`'s shape), a `"patch"` wire event/`session-dispatch` arm that runs
  `handle-params` against the *current* model with no `lookup-live`, no unmount/remount,
  no ticker restart — the lightest possible update. Client: `session.patch(href)`,
  `data-patch` links (parallel to `data-nav`), and a `broodPatch` history-state flag so
  `popstate` replays the right one. Demo: `web/views/reorder`'s per-row "Highlight" link
  patches `?highlight=<id>` — verified live that the existing 3s rotation tick keeps
  running (and rotation *position* survives) right across a patch, proving no remount.
- **File uploads** ✅ — `multipart/form-data` parsed byte-faithfully in `http/multipart`
  (fields + file parts with raw `:bytes`), exposed on the conn as `files`/`file`. Large
  bodies stream to disk instead of buffering: `http/server`'s `:spool-threshold` writes the
  body to a temp file chunk-by-chunk (via the `append-bytes` runtime builtin), handing the
  handler a `:body-file` path — persist it zero-copy with `web/conn/save-body` or parse it
  from disk with `parse-upload-file`.
- **Upload progress → live sessions** ✅ — **`web/upload`**. The hard part was addressing: the
  upload POST and the live view's WebSocket are different connections in different processes, so
  the two have to be introduced. The introduction is a **token** — the view mints one
  (`watch` → subscribes it on `web/pubsub`), `action` puts it in the form's URL, and
  `http/server` reads it off the *query string*. Query param, not a form field, because the head
  is parsed before a single body byte is read: it is the only part of the request visible in time
  to report on the body's arrival. `http/server` then only *emits* — one
  `[:hatch :upload :progress]` telemetry event, the same fire-and-forget seam the access log
  rides — so the HTTP layer still knows nothing about live sessions, and a handler can't slow the
  worker draining the socket. `web/upload/attach-progress` (wired by `:upload-progress true` in
  `web/application/start`, mirroring `:access-log`) turns those events into pubsub broadcasts that
  land at the view's `handle-info` as `{:upload {:token :got :total :percent :done?}}`.
  Throttled to `:progress-interval-ms` (default 250) — a socket read is one MTU, so unthrottled
  would be thousands of events and re-renders per upload — with the final event always sent
  unthrottled so a bar reliably lands on 100%. Entirely opt-in: no token, no events, so ordinary
  traffic pays one `get` on the parsed query map. Both Content-Length body readers report (the
  in-memory `buffered-drain` and the spool-to-disk `spool-drain`); a chunked body is deliberately
  excluded, having no declared total to be a fraction of. Tests: `tests/web_upload_test.blsp`
  (pure helpers + real-socket uploads over both body paths, asserting incremental, monotonic,
  token-scoped events, and that an untokened upload emits nothing).

### Phase 10 — Developer experience ✅

Turned out to be almost entirely already-built once we actually looked (2026-07-11).
`nest new` templates live in Brood's own stdlib (`std/tool/project.blsp`), *not* in
nest's Rust — `nest new` is a thin dispatcher to `project/new-project` — so scaffolding
is a pure-Brood, upstream change (still "no new Rust"). The hot-reload chain was already
wired end to end in `web/live`; this phase's work was verifying it, closing a test gap,
and adding the missing API template.

- **`nest new myapp --template hatch`** ✅ — the scaffold. A full runnable Hatch app:
  `project.blsp` wiring `[hatch :path …]` + `store-postgres`, `web/endpoint`,
  `web/errors` (themed error pages), `web/layout` (Tailwind + daisyUI), `web/routes`
  (session + CSRF pipeline), a `home` page + a Postgres-backed `messages` board, and
  tests. (Named `hatch`, not `web` — it's more batteries-included than the original
  bullet: it includes the database board.) The live client (`brood_live.js`) isn't
  copied in — apps serve it straight from the hatch dep via
  `(web/live/client-js-handler)`, so there's no vendored copy to drift.
  **Two real bugs found + fixed while verifying it** (2026-07-11): the scaffold didn't
  load at all — `db.blsp` aliased both store's `repo` and `web/repo` to the same `repo`
  name (collision → now `:as web-repo`), and `web/endpoint` referenced a `web/errors`
  module the scaffold never generated (now generated, mirroring the demo). Plus a
  `layout.blsp` unused-`:use` warning. Verified: `nest new … --template hatch && nest
  test` is now green and warning-free.
- **`nest new myapp --template web-api`** ✅ — the JSON-API variant, no live layer, no
  database (just the `hatch` dep — the smallest runnable Hatch app). Router →
  `web/api` handlers returning JSON via `web/live/encode`; `web/endpoint` runs with no
  ws-handler and emits bare JSON 500/504. Serves `GET /`, `GET /api/health`, and
  `GET|POST /api/echo` (query- and JSON-body-param merging both exercised). Verified
  end to end: `nest test` green, and a running server returns the right JSON for each
  route and a 404 for the rest.
- **Hot reload** ✅ — `nest run --watch src/` (which already exists) re-`load`s a changed
  module on save; `deflive` emits a `(def live--reloaded (web/live/notify-reload))`
  sentinel that fires on every (re)load, fanning `[:reload]` through the `:hatch-live`
  registry to open sessions, whose `[:reload]` handler re-resolves fresh code via
  `spec-fn` and re-renders — a diff, no restart. The whole chain was already built; this
  phase added the missing regression test (only the sibling `notify-reload-css` path had
  one) and a direct end-to-end proof that loading a `deflive` module delivers `[:reload]`
  to a registered session.
- ~~**`web/conn/test`** — test helpers for pure-function handler testing~~ ✅
  shipped as `web/test` (see Assets & dev tooling above)

> **Note:** the `hatch`/`web-api` template changes live in the *brood* repo
> (`std/tool/project.blsp`, `include_str!`'d into `nest` at build time), so they reach
> a user's `nest` only after the next `make install` of brood. Fixed in the same pass:
> nest's `--template --help` blurb (it had named a non-existent `http-server` and omitted
> `editor`/`gui`/`hatch`) and Brood's `brood-for-claude.md` template list (baked into
> every scaffold). The authoritative list is `*project-templates*` at runtime, surfaced
> by `nest new --template <unknown>`.

### Phase 11 — Production hardening ✅

- **Supervisor tree** ✅ — `http/server` workers now run as `:temporary` children of a dynamic
  supervisor registered by a port-derived name, so they're supervised and observable
  (`nest observe` / `whereis` + `supervisor/count-children`) yet never restarted — a crashed
  worker's socket and request context are gone and can't resume. The listener still monitors each
  worker for the graceful drain and the max-connections back-pressure (both already done), so the
  shutdown/cap behaviour is unchanged; the supervisor is torn down when the server stops.
- **Request timeout** ✅ — idle read timeout (→ 408) and the slow-loris hardening are in
  `http/server` (`:read-timeout-ms`, the O(n) head reader, 413 on oversize); see
  `docs/robustness.md`.
- **Chunked Transfer-Encoding** ✅ — for streaming responses (SSE, large file downloads). The
  runtime prerequisite (a streaming socket write) was already there: `tcp-send` writes an
  iolist to a per-connection socket and can be called repeatedly by the owning worker, so no
  brood builtin was needed. `http/response` now has the chunk encoders (`chunk`/`last-chunk`/
  `format-stream-head`, the write-side twin of the chunked *reader*); a handler returns a
  response carrying a `:stream` function `(fn (write) …)` and `http/server` sends the head with
  `Transfer-Encoding: chunked`, drives the function, then the terminating chunk (and always
  closes — no keep-alive across an open-ended stream). `web/conn/stream-resp` is the conn-level
  API; **`web/stream`** wraps it as Server-Sent Events (`sse-resp` + `sse-event`, `text/
  event-stream`) and as `stream-bytes`/`stream-file`, which chunk a large body onto the socket in
  fixed-size blocks with optional `Content-Encoding: gzip`. Tests: `tests/http_stream_test.blsp`
  (loopback chunked + SSE + byte/file streaming) and the encoder units in
  `tests/http_response_test.blsp`.
- **Binary asset serving** ✅ — images, fonts, `.ico`, video, wasm. `web/static` reads binary
  types (`text-mime?` picks the path) via `slurp-bytes` and serves them as raw `bytes`;
  `http/response/format-response` returns the whole response as `bytes` for a binary body so it
  reaches the wire byte-for-byte. Full ETag/304, Cache-Control, nosniff, and byte ranges
  (206/416) apply, and an unknown extension is served as `application/octet-stream` bytes
  rather than being UTF-8-mangled.
- **Compression** ✅ — gzip response middleware plug + `Content-Encoding`/`Accept-Encoding`
  negotiation (and pre-compressed `.gz` static variants). The runtime builtin shipped upstream
  as `zlib/gzip`/`zlib/gunzip` (the `flate2`-backed `%gzip`/`%gunzip` prims, brood ≥ 0.3.3), so
  no reverse proxy is needed. Two pieces: (1) **`web/compress`** — a `(compress)` plug that
  registers a before-send callback and gzips a compressible (`text/*` + the JSON/XML/SVG set),
  large-enough, not-already-encoded response body, adding `Content-Encoding: gzip` +
  `Vary: Accept-Encoding`; and (2) `web/static` already serves pre-compressed `.gz` variants
  (`serve-encoded`), now written **in-process** — `web/assets/precompress` uses `zlib/gzip`
  instead of shelling out to the `gzip` CLI, so a build host without that binary no longer
  degrades to uncompressed serving. **Brotli too** (brood ≥ next release: `zlib/brotli`): the
  plug and `serve-encoded` prefer `Content-Encoding: br` over gzip when the client accepts it,
  and `precompress` emits both a `.br` (quality 11) and a `.gz` (level 9) sibling — brotli beats
  gzip on text. Tests: `web_compress_test`, `web_static_test`, `web_assets_test`.
- **Access logging** ✅ — **`web/logger`**: `attach-access-log` turns the
  `[:hatch :request :stop]` / `:bad-request` telemetry `http/server` emits into one structured
  log line per request (method, path, status, duration) through the standard log system, so
  access lines share the app's level/format/sinks. Level follows the status (2xx/3xx info, 4xx
  warn, 5xx error) unless fixed. `web/application/start` wires it with `:access-log true`. Tests:
  `tests/web_logger_test.blsp`.
- **Rate limiting** ✅ — **`web/ratelimit`**: a `(rate-limit)` plug, token-bucket per key (client
  IP from `X-Forwarded-For`/`X-Real-IP`, else one global bucket), backed by a supervised counter
  process so the read-refill-spend is serialized. Over the limit → `429` + `Retry-After`; fails
  OPEN if the limiter doesn't answer, so a hiccup can't take the endpoint down. Tests:
  `tests/web_ratelimit_test.blsp`.
- **PubSub** ✅ (node-local) — `web/pubsub`: `subscribe`/`unsubscribe`/`broadcast`/
  `broadcast-from` over string topics, fanning out to subscribers via `send-info` (→ the
  view's `handle-info`). A named registry process holds `topic → pids` and monitors each
  subscriber, so a dropped session is auto-removed. Built on `deflive`'s `handle-info`
  clause + `web/live/send-info`. Demo: `web/views/room`. **Cross-node** ✅ — a broadcast
  fans out to local subscribers and forwards to peer nodes (`{:name :hatch-pubsub :node n}`),
  tagged `:local`/`:remote` so a forwarded message isn't re-forwarded; a no-op with no nodes.
- **Presence** ✅ (node-local + **cross-node**) — `web/presence`: `track`/`untrack`/`roster`
  over string topics. A registry holds `topic → [{:pid :key :meta}]`, monitors each tracked
  session (auto-leave on death), and pushes the refreshed roster to present members via
  `send-info`. Across a cluster the roster is a state-based CRDT: each node owns its local
  presences and replicates each topic's roster to peers, a joining node learns existing
  presences via a one-time bootstrap, and a departed node's presences drop on node-down.
  Verified across two real OS-process nodes. Demo: `web/views/presence`. **Observer mode** ✅ —
  `observe`/`unobserve` subscribe a non-present process (a dashboard, a moderator view, a lobby
  count) to a topic's roster updates without joining the roster; it gets the same
  `{:presence roster}` at `handle-info` a member does, built on pubsub (monitored + cross-node).

---

