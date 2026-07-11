# Hatch — Web Framework Roadmap

*Hatch is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new
Rust — TLS is handled by a reverse proxy.*

---

## Stack layers

```
┌─────────────────────────────────────────────────────────┐
│  Phase 5 ✅  web/live   (deflive, WS sessions, PubSub)  │
│  Phase 4 ✅  web/router + web/conn  (routing, pipelines) │
│  Phase 3 ✅  web/template  (Hiccup renderer)             │
├─────────────────────────────────────────────────────────┤
│  Phase 2 ✅  http/*  (HTTP/1.1 + WebSocket, our Bandit)  │
├─────────────────────────────────────────────────────────┤
│  Phase 1 ✅  stdlib gaps  (base64, JSON, URL decoding)   │
├─────────────────────────────────────────────────────────┤
│  Already in stdlib:  tcp-*, %sha1, %hmac-sha256,        │
│                      string->utf8-bytes, %random-bytes  │
└─────────────────────────────────────────────────────────┘
```

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

## What's left

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
  from disk with `parse-upload-file`. **Still to do:** progress events to live sessions.

### Phase 10 — Developer experience

- **`nest new myapp --template web`** — scaffold: routes, live view,
  layout, `brood_live.js`, `project.blsp` with hatch dependency
- **`nest new myapp --template web-api`** — JSON API variant (no live layer)
- **Hot reload** — `nest run --watch src/` triggers re-render diffs in
  running live sessions without a server restart
- ~~**`web/conn/test`** — test helpers for pure-function handler testing~~ ✅
  shipped as `web/test` (see Assets & dev tooling above)

### Phase 11 — Production hardening

- **Supervisor tree** — `http/server` workers under a proper supervisor;
  restart strategies; max-connections back-pressure
- **Request timeout** — idle worker timeout; slow-read protection
- **Chunked Transfer-Encoding** — for streaming responses (SSE, large file
  downloads). ⛔ **needs a runtime builtin:** responses serialize as one string today; a
  streaming/binary socket write is the prerequisite (pairs with binary serving below).
- **Binary asset serving** ✅ — images, fonts, `.ico`, video, wasm. `web/static` reads binary
  types (`text-mime?` picks the path) via `slurp-bytes` and serves them as raw `bytes`;
  `http/response/format-response` returns the whole response as `bytes` for a binary body so it
  reaches the wire byte-for-byte. Full ETag/304, Cache-Control, nosniff, and byte ranges
  (206/416) apply, and an unknown extension is served as `application/octet-stream` bytes
  rather than being UTF-8-mangled.
- **Compression** — gzip response middleware plug + `Content-Encoding`/`Accept-Encoding`
  negotiation (and pre-compressed `.gz` static variants). ⛔ **needs a runtime builtin:** no
  gzip/deflate/brotli exists in `brood` (no `flate2`/`brotli` dep) — add a `gzip`/`gunzip`
  builtin first. Until then, terminate compression at a reverse proxy.
- **Access logging** — structured log plug (method, path, status, ms)
- **Rate limiting** — token-bucket plug backed by a `defprocess` counter
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
  Verified across two real OS-process nodes. Demo: `web/views/presence`. **Still to do:** a
  non-present-observer mode (pair with PubSub).

---

## Known issues / cleanup backlog

Found during a 2026-07-03 review of the working tree (`nest test`, warning output,
doc-vs-source diff). Not phase-gated — pick up independently of the phases above.

- ✅ **WS large-frame memory blowup** — **FIXED 2026-07-03.** `tests/http_websocket_test.blsp`
  › "text-frame: 64-bit length for payloads > 64 KB" died with a runtime memory-limit-exceeded
  error (>1GB allocated) building a single ~70KB frame. Root cause: `map` iterates a
  collection via repeated `first`/`rest`, and `rest` on a `bytes` value reallocates the
  remaining bytes on *every* call — so `map` directly over `bytes` is O(n²) (confirmed by
  RSS scaling: 43MB/81MB/232MB at n=5k/10k/20k, non-linear). `utf8-byte-string`
  (`http/websocket.blsp`) mapped straight over the `bytes` from `string->utf8-bytes`,
  skipping the `bytes->list` conversion its sibling `bytes->carrier` already used
  correctly. Fix: route through `bytes->list` first. Full suite peak RSS dropped from
  1023MB → 177MB; this was live on the *send* path for every render over 64KB of HTML,
  not just the test.
- 🟡 **Bytes-migration type warnings** — `count`/`fold`/`map` called directly on `bytes`
  values raise checker warnings at `http/response.blsp:10`, `http/util.blsp:37`,
  `web/static.blsp:235` (fallout from `c1cf3a3`, the bytes-migration commit; the fourth,
  `http/websocket.blsp:104`, was resolved as a side effect of the fix above — it no longer
  maps over `bytes` directly). Not failing, just unresolved — fix the call sites or confirm
  the checker should widen its `bytes` support. (Checked all three: `web/static.blsp:235`
  and `http/response.blsp:10` call `count` on `bytes`, which dispatches to the native
  `byte-length` — O(1), not the O(n²) shape above. `http/util.blsp:37` folds over
  `(string->utf8-bytes c)` where `c` is always a single character from `string->list` —
  at most 4 bytes, so the same first/rest-loop shape as the fixed bug never gets large
  `n` here. All three are a stale type signature, not a hidden perf bug — safe to leave
  or fix at leisure.)
- ✅ **Unused `:use` imports** — **FIXED 2026-07-03.** `http/websocket.blsp` (`http/util`),
  `web/live.blsp` (`web/conn`, plus its now-stale explanatory comment), `tests/web_parts_test.blsp`
  (`web/template`).
- ✅ **Doc drift** — **FIXED 2026-07-03.** `CLAUDE.md`'s source layout now lists
  `web/auth.blsp` and `web/bml.blsp`, and its tests/ and docs/ lists include the previously
  missing `http_server_test.blsp`, `protocol_test.blsp`, `web_auth_test.blsp`,
  `web_bml_test.blsp`, `web_page_test.blsp`, `hardening.md`, `robustness.md`,
  `tcp-http-audit.md`, `live-view-ergonomics.md`. This roadmap's Phase 7 now credits
  `web/auth`'s Basic-auth plug as shipped, separately from the still-open live-view
  `on-mount-guard` convention.

**Phase 8 (LiveComponents) review findings, 2026-07-05** — a post-merge review of the
Phase 8 diff found and fixed four real regressions in what this doc had called done. All
verified by direct reproduction (a scratch test crashing/passing before/after) and covered
by permanent regression tests, not just re-reviewed by inspection.

- ✅ **`render` crashed on any component-using view** — **FIXED.** `deflive`'s plain,
  non-split `render` was built straight from the raw render form, which still contained a
  literal `(component module assigns)` — never a real function, only a marker
  `web/parts`' `walk` recognized. Only `render-dynamic` got the component-slot
  compilation; calling `web/test/live-render` (or `:render` directly) on any
  component-embedding view threw `unbound symbol`. Fix: `web/parts/rewrite-components`
  recursively replaces every `(component …)` sub-form with a
  `(web/template/raw (web/component/render-slot …))` call (a valid Hiccup node, not a
  pre-rendered string — preserves `render`'s "returns Hiccup" contract), applied to
  render-expr for `render` and reused inside `walk`'s opaque-dynamic `else` branch.
  `render`'s generated signature gained the same optional, defaulted `live--components`
  param `render-dynamic` already had, so the rewritten form's free reference resolves.
  Regression coverage: `tests/web_live_component_integration_test.blsp`.
- ✅ **A component nested inside `(if …)`/`(for …)` crashed too** — **FIXED**, by the same
  `rewrite-components` fix above (this was the *other* consumer of walk's else branch):
  `component-form?` only ever caught a component that's a *direct* element/list child;
  one nested one level deeper fell into the generic opaque-dynamic case unrewritten.
  Conditionally showing a component is an extremely natural thing to write, so this was
  probably the highest-impact of the four.
- ✅ **Component id collision across modules/views** — **FIXED.** `render-slot` looked up
  stored state by `id` alone, with no check that the entry belonged to the same component
  module — two different components (or the same id reused across a live-navigate to a
  different view, since the table is session-wide and persists across navigation) would
  silently render one's state through the other's `render`. Fix: `component-slot-form`
  also passes the quoted bare `module` symbol; `render-slot` stores it alongside state and
  remounts fresh on a mismatch. Note: comparing the *spec-thunk function* directly doesn't
  work for this — `table-put`/`table-get` deep-clone a stored function, so a round-tripped
  closure is never `=` to the original even though it behaves identically; only a plain
  symbol/string round-trips `=`-stable, which is why `:module` (not `:spec-thunk`) is the
  comparison key. Regression: `tests/web_component_test.blsp`.
- ✅ **Component table leaked on abrupt disconnect** — **FIXED.** The `[:closed]` branch
  (a raw TCP close/reset — closed tab, network drop — with no WS close frame) only
  unregistered the session, skipping the `table-drop` every other exit path
  (`close-session`) performs. Fix: `[:closed]` now calls `close-session` too (its
  socket-write calls are already best-effort/try-caught, so they're harmless on an
  already-dead socket).

Also fixed, lower severity, same pass: `on-mount-guard` invocations (both the initial
connect and live-navigate) are now `try`/`catch`-wrapped and fail closed (socket/session
just ends, no redirect-loop risk) instead of crashing the session on a throwing guard —
matching how every other optional hook is already guarded. `web/live.blsp` now
`(:alias web/component)` itself instead of relying entirely on `deflive`-expanded
consumers to have loaded it (verified the resulting mutual `web/live` ↔ `web/component`
reference is fine — Brood tolerates it) — which also let the now-redundant
`(require 'web/component)` be dropped from `deflive`'s own expansion. A docstring typo
(`web/live/send-update` → `web/component/send-update`) was also fixed.

**A second cleanup pass, 2026-07-05**, after wiring `web/form`/live-patch/LiveComponents
more broadly through hatch-demo (`messages.blsp`'s `create`, a second `like-button`
instance in `dashboard.blsp`):

- ✅ **`LiveModule` behaviour-arity checker noise** — **FIXED.** Giving `render` an
  optional second (`live--components`) parameter (the earlier fix above) made the
  advisory checker miscount its arity against `LiveModule`'s declared `(render [model])`
  — every view implementing the behaviour warned `render takes 3 arg(s), the behaviour
  needs 1` (the checker's arity counter doesn't special-case `&optional`, so it counted
  the `&optional` keyword and the default-pair as extra positional args). Fix: declare
  the behaviour's `render` op with the identical `&optional` shape
  (`[model &optional (live--components (table))]`) so both sides get miscounted the
  same way and agree — a bit of a wart, but it's what silences a checker limitation
  without weakening the actual contract.
- ✅ **Dead code: `web/live/render`** — **FIXED.** A module-level `(defn render (view
  model) …)` in `web/live.blsp` had no callers anywhere in either repo and duplicated
  `web/test/live-render`'s logic exactly. Deleted.
- ✅ **hatch-demo: `req_log_test.blsp` testing deleted functions** — **FIXED.** An earlier
  `main.blsp` refactor (`refactor(main): replace manual startup with
  web/application/start`) deleted the demo's own `text-line`/`json-line` formatters —
  that logic moved into `web/application`'s private `application--text-line`/
  `application--json-line` — but the test file was never updated, so 4 of its assertions
  permanently failed against now-nonexistent `main/text-line`/`main/json-line`. The
  formatter logic had **zero test coverage in either repo** post-refactor. Fix: added
  `hatch/tests/web_application_test.blsp` (text/color/JSON line rendering, at its new,
  correct location), and trimmed hatch-demo's `req_log_test.blsp` down to what's still
  demo-side code — the pure record builders (`start-record`/`done-record`/
  `error-record`). Both repos are fully green now (0 failures) for the first time this
  session.
- ✅ **Two more checker-only "unused `:use` import" false positives** — **FIXED**, the
  same way as `web/component.blsp`'s earlier one (switch `:use` → `:alias` + call the
  macro qualified): hatch-demo's `page-template.blsp` (`deftemplate` from `web/bml`) and
  `like_button.blsp` (`deflive-component`/`LiveComponentModule` from `web/component`).
  The checker doesn't trace a bare macro invocation as "using" its import.

**A simplification pass, 2026-07-05** — no bugs, just reuse (found by re-reading the
Phase 8 code-review's cleanup findings that got deprioritized behind correctness fixes
at the time, plus a duplication introduced by the hatch-demo wiring above):

- ✅ **hatch-demo: `flash-banner` duplicated verbatim** — `account.blsp` and
  `messages.blsp` each hand-rolled the identical info/error/none daisyUI-alert cond
  (introduced this session, in two different sittings). Moved to
  `web/layout/flash-banner` — the demo's existing shared-UI-chrome module — since the
  daisyUI class names are a demo styling choice, not something the framework should
  bake in.
- ✅ **`deflive`/`deflive-component`'s clause-extraction idiom, repeated 11×** —
  `(first (filter (fn (c) (= (first c) 'TAG)) clauses))` for every singular clause
  (`mount`/`render`/`template`/`handle-info`/`unmount`/`on-mount-guard`/`handle-params`)
  and the bare `filter` for the repeatable ones (`on`/`tick`). Factored into
  `deflive--clause`/`deflive--clauses`, alongside the two macro-expansion helpers
  (`deflive--render-expr`/`deflive--handle-event-body`) already shared this way.
- ✅ **`session-dispatch`'s redirect-then-continue, duplicated** — the on-mount-guard
  veto (live-navigate) and the cross-live-session-group fallback both did
  `(if (send-msg sock {:event "redirect" :path X}) (session-recv sock view buf)
  (close-session sock view))`. Factored into `redirect-and-continue`.
- ✅ **`close-session`/`redirect-and-close`'s shared tail** — both ended with the same
  best-effort close-frame-send + tcp-close. Factored into `close-socket`.
- ✅ **`send-info`/`web/component/send-update`'s swallow-if-dead pattern, duplicated
  across modules** — both were `(try (send session [...]) (catch _ nil)) nil` with a
  different message tuple. Factored into `send-safely`, which `send-update` now calls
  via the `web/live` alias `web/component` already has.

None of these changed behavior — every existing test still passes unmodified, plus a
live end-to-end recheck of the guard-redirect and send-update paths.

**A feature-coverage audit, 2026-07-05** — cross-referenced every `hatch/src/web/*`
public function against actual usage in hatch-demo. Most of the framework was already
well covered; five real gaps turned up (four demo additions, one real framework bug
the audit caught along the way):

- ✅ **Named path params never demoed** — every real route used no params, a live-patch
  query param, or `*splat` (only for static files); `parse-pattern`'s `:id`-capture
  support had zero app-level exercise. Added `GET /messages/:id` (`db/get-message`, a new
  `repo/one` query) — each message in the list links to it.
- ✅ **`web/form/min-length?` and `matches-pattern?` never demoed** (only
  `required?`/`email?`/`max-length?` were) — added `min-length? 2` to signup's name rule
  and a `matches-pattern?` (letters/digits/spaces) rule to messages' name rule.
- ✅ **`web/pubsub/broadcast-from` never demoed** (only plain `broadcast`, which delivers
  back to the sender too) — `web/views/room`'s "wave" now updates the waver's own log
  directly (optimistic, no round trip needed for your own action) and `broadcast-from`s
  everyone else, instead of relying on the broadcast echo for the sender's own update —
  a more realistic demonstration of what `broadcast-from` is actually for.
- ✅ **CSRF's `X-CSRF-Token` header path never demoed** (only the hidden `_csrf_token`
  form field was) — messages' form gained a second "Post via fetch" button that submits
  via `fetch()` with the token as a header instead, no hidden field in the request at
  all. Verified live: the message lands with only the header carrying the token.
- ✅ **Real bug found by the audit: `deflive-component`'s `(template …)` clause was
  broken** — its template-render-arg default was `state` (matching
  `deflive-component`'s own inline-render convention), but `web/bml`'s `@field` always
  compiles to `(get model :field)` — a hardcoded name (the same default `deflive` itself
  already uses for its own template clause). Any component using `(template …)` instead
  of inline `(render (state) …)` hit `unbound symbol: model` at render time — never
  caught before because no component anywhere used a template. Fixed by defaulting the
  template render-arg to `model`; added a demo `counter-widget` component (rendered from
  a `.bml` file) and a framework regression test.

All of this shipped with tests (`nest test` green in both repos throughout) and a live
verification pass for each: the path-param page, the fetch/header CSRF path, and the new
`.bml`-templated component, all hit over a real running server.

**Real bug, reported by the user, 2026-07-05: keyed morph could steal focus out of a
field the user was typing in** — `/reorder` ("Keyed morph · focus survives reorder")
lost focus non-deterministically, always on the *n*th rotation for some small *n*, never
the first. Root-caused with a headless-Chrome (Playwright) repro plus a JS-property probe
(an HTML-attribute probe doesn't work here — `morphElement`'s attribute sync strips any
attribute the new render doesn't have, including a manually-added marker, which looks
like node replacement but isn't): `morphKeyed`'s reused DOM nodes really were the same
node across every rotation (confirmed by identity, not just by `data-key`), yet Chrome
still blurred the focused input whenever *its own row* needed an actual `insertBefore`
call to reach its new position — a row that happened to already sit in the right spot
relative to the walk cursor was never blurred. So it wasn't "every second rotation"; it
was "whichever rotation is the first one that actually needs to move *your* row" — which
explains why it read as intermittent. Fixed in `static/brood_live.js`: `moveKeepingFocus`
wraps every keyed `insertBefore`, saving `document.activeElement` (plus, for a text
field, `selectionStart`/`selectionEnd`) beforehand and restoring both immediately after,
so a reorder that repositions the focused row's node never surfaces as a blur. No
`nest test` regressions (JS isn't covered by the Brood test suite — verified instead with
a 4-rotation live-browser repro that failed before the fix and passed after).

---

## Blocked on Brood language changes

These are hatch-side follow-ups that only become worth doing once the matching
Brood language/runtime change ships. We proposed all six upstream — they're at the
top of [`brood/ROADMAP.md`](../../brood/ROADMAP.md) under *"Findings from hatch
(2026-07-11)"*. Revisit each entry here when its upstream item lands. Context for the
first three is `docs/tcp-http-audit.md` §16–§17 (the O(n²) class they retire).

- ⬜ **Iolists → delete the manual list+`join` accumulation idiom.** Once the I/O +
  join builtins (`tcp-send`, `spit`/`append-bytes`, `join`, `str`, `bytes-concat`)
  accept arbitrarily nested lists flattened at the write boundary, rewrite the five
  hand-rolled accumulators (`http/server` body drain + head reader, `http/request`
  `dechunk-step`, `http/websocket` `reassemble`, `web/parts` `interleave`) to just
  *describe* their structure and let the write flatten it — no more cons+`reverse`+
  `join`. Also lets `web/parts` build the render tree as a nested iolist instead of
  interleaving into one string.
- ⬜ **`bytes`-native parsing → drop the carrier-string bridge.** When `bytes` grows a
  fuller search/slice surface, port the HTTP/WebSocket parsers off the Latin-1
  `(str buf (bytes->carrier chunk))` read buffer onto raw `bytes`. Removes the
  text/binary mode-flip seam (root cause of the original U+FFFD live-nav bug) and the
  O(n²) carrier conversions. Retires audit §16.
- ⬜ **Growable read buffer → simplify the length-drain loops.** A transient append
  buffer that freezes to immutable `bytes` on read would make `http/server`'s head
  reader, chunked drain, and `web/live`'s WS frame gather trivially O(n) — deleting the
  manual list+`join` and length-drain gymnastics those currently use. Also the clean fix
  for the WS fragmented-message O(F²) residual noted in §17 (an incremental *message*
  parser keeping decoded fragments across reads).
- ⬜ **`mapv`/`filterv` → drop the `(into [] (map …))` wrappers.** Sweep the codebase
  for `(into [] (map …))` / `(into [] (filter …))` (added wherever a vector was needed
  because `map`/`filter` return lists) and collapse them once the vector-returning
  variants exist.
- ⬜ **Link-checked `--private` → catch cross-module misuse at compile time.** A private
  `foo--bar` called from another module currently only fails at runtime (it bit us during
  the audit work). Once the convention is link-checked upstream, no hatch code change is
  needed — just confirm the suite stays green under the stricter check and drop any
  workarounds.
- ⬜ **`let` vector-destructure of a list value → remove the `first`/`rest` workarounds.**
  We avoid `(let ([a b] some-list) …)` throughout (documented in CLAUDE.md's conventions)
  and hand-expand to `first`/`rest`. If Brood makes vector-destructure work on lists (or
  errors clearly), revisit those sites and the CLAUDE.md caveat.

---

## Open design questions

| # | Question | Decision needed |
|---|----------|-----------------|
| Q1 | Slot annotation: explicit `(slot :key expr)` or static analysis of `(get model :key)`? | Phase 6 |
| Q5 | Sessions: process-store only, or pluggable adapters (disk/DB) from day one? | Phase 7 |
| Q8 | Auth: `on-mount-guard` clause in `deflive`, or convention in `mount`? | Phase 7 |
| Q10 | Head updates: `[:set-title]` effect, or a `<head>` slot in the layout? | Phase 8 |

---

## Dependency graph

```
Phase 11 ── Phases 1–10 (hardening layer)
Phase 10 ── nest tooling + all phases
Phase 9  ── Phases 4, 5, 7
Phase 8  ── Phase 5
Phase 7  ── Phases 4, 5
Phase 6  ── Phases 3, 5
Phase 5  ✅ Phases 1–4
Phase 4  ✅ Phases 2, 3
Phase 3  ✅ (none beyond stdlib)
Phase 2  ✅ Phase 1 + stdlib TCP
Phase 1  ✅ stdlib
```
