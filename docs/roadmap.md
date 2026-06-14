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

---

## What's left

### Phase 6 — Static/dynamic template split (diff optimisation)

Currently every event re-sends the full rendered HTML. LiveView's key
insight is that only the dynamic slots need to change.

- **`web/template` slot compiler** — `deflive` templates compile to
  `{:static [...] :dynamic fn :fingerprint hash}`. Static strings are
  sent once on `join`; subsequent events only send changed dynamic slots.
- **Wire protocol v2** — `{"event":"joined","static":[...],"dynamic":{...}}`
  then `{"event":"diff","d":{"0":"42"}}` (changed slot indices only)
- **`brood_live.js` slot patcher** — apply diffs by `data-slot` index
  instead of full DOM replace

### Phase 7 — Sessions, CSRF, and auth

- **`web/session`** — process-backed session store (named `defprocess`
  mapping session-id → session-map); signed-cookie session ID via
  `%hmac-sha256`; pluggable persistence adapter interface
- **`web/csrf`** — double-submit CSRF token (plug + `deflive` integration)
- **Auth convention** — `(on-mount-guard ...)` clause in `deflive` for
  redirect-if-not-authenticated; session reads in `mount`

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
  downloads)
- **Compression** — gzip response middleware plug
- **Access logging** — structured log plug (method, path, status, ms)
- **Rate limiting** — token-bucket plug backed by a `defprocess` counter
- **PubSub** — topic-based broadcast across live sessions, then distributed across
  Brood nodes (an earlier prototype existed; build it back when a view needs it).
  Foundation in place: `deflive`'s `(handle-info (msg model) …)` clause + the
  `web/live/send-info` delivery primitive let any process push an out-of-band message to a
  live session and re-render. PubSub/Presence layer a topic registry + broadcast on top.

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
