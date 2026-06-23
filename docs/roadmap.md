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

### Phase 7 — Sessions, CSRF, and auth

- **`web/session`** ✅ — signed-cookie session store (Phase 6); a process-backed
  store + pluggable persistence adapters remain a later option.
- **`web/csrf`** ✅ — synchronizer-token CSRF: a per-session token (minted by the
  `protect-from-forgery` plug), embedded in forms via `csrf-input`, verified
  (constant-time) on POST/PUT/PATCH/DELETE; an `X-CSRF-Token` header is accepted for
  fetch/JSON clients. Demo: `/account`.
- **Auth convention** — `(on-mount-guard ...)` clause in `deflive` for
  redirect-if-not-authenticated; session reads in `mount` (still to do).

### Phase 8 — LiveComponents

- **`deflive-component`** — scoped sub-views, each a separate Brood process
- **`send-update`** — parent sends `[:update component-id assigns]` to a
  child component; child re-renders independently
- **Component slots** — `(component my-form {:on-save "saved"})` in parent
  template

### Phase 9 — Forms, uploads, navigation

- **`web/form`** — `(form-for conn :create-user)` helpers; server-side
  validation returning changeset-style error maps
- **`live-navigate`** — client-side navigation without full reload
  (`push_patch` equivalent); browser history management
- **File uploads** — chunked multipart in `http/request`; progress events
  to live sessions

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
- **Binary asset serving** — images, fonts, `.ico`, `.gz`. ⛔ **needs a runtime builtin:**
  `slurp` is UTF-8 and lossy, so there's no byte-faithful file read — a `slurp-bytes`
  (file → byte vector) in `brood` (`crates/lisp/src/builtins.rs`) is the prerequisite, then
  send over a binary-mode socket. The MIME table (`web/static/*mime-types*`) and a
  `byte-range`-correct `serve-body` slot in behind it. *Cache/ETag/nosniff/range scaffolding
  already shipped (Assets & dev tooling) — only the byte I/O is missing.*
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
  clause + `web/live/send-info`. Demo: `web/views/room`. **Still to do:** distribute
  broadcasts across Brood nodes (the registry is currently single-node).
- **Presence** ✅ (node-local) — `web/presence`: `track`/`untrack`/`roster` over string
  topics. A registry holds `topic → [{:pid :key :meta}]`, monitors each tracked session
  (auto-leave on death), and pushes the refreshed roster to present members via `send-info`.
  Demo: `web/views/presence`. **Still to do:** a non-present-observer mode (pair with
  PubSub) and cross-node/CRDT distribution.

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
