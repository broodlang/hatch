# Brood Web Stack — Roadmap

*From bare TCP to a LiveBrood web framework. Each phase delivers something
usable on its own; later phases build on earlier ones.*

---

## Stack layers

```
┌─────────────────────────────────────────────────────────┐
│  Phase 5 — web/live   (LiveBrood: deflive, diff, WS)    │
│  Phase 4 — web/router + web/conn  (routing, pipelines)  │
│  Phase 3 — web/template  (Hiccup renderer, slot/diff)   │
├─────────────────────────────────────────────────────────┤
│  Phase 2 — brood-http  (our Bandit: HTTP/1.1 + WS)      │
├─────────────────────────────────────────────────────────┤
│  Phase 1 — stdlib gaps  (base64, JSON, URL encoding)    │
├─────────────────────────────────────────────────────────┤
│  Already in stdlib:  tcp-*, %sha1, %hmac-sha256,        │
│                      string->utf8-bytes, %random-bytes  │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Stdlib gaps

*Prerequisites. Nothing in Phases 2–5 can ship cleanly without these.*

### 1a. Base64 encode/decode

**Why:** The RFC 6455 WebSocket handshake requires base64-encoding the
SHA-1 of the client nonce. Also needed for session-token embedding and
cookie encoding.

**Where:** Can be implemented in pure Brood (bit manipulation, ~60 lines)
and shipped as part of `brood-http` directly, or added to stdlib as
`%base64-encode` / `%base64-decode` (byte-vector ↔ string).

**Blocking:** WebSocket support in brood-http (Phase 2).

**Recommendation:** Start pure-Brood in brood-http for now; promote to
stdlib if it proves useful elsewhere.

### 1b. JSON encode/decode

**Why:** The LiveBrood wire protocol between the server session actor and
the browser JS client is JSON. Browser devtools understand JSON natively;
a custom format would make debugging painful.

**Where:** A standalone `brood-json` nest package (or a stdlib module).
Encoder (~80 lines, straightforward), decoder (~200 lines, recursive
descent parser).

**Blocking:** The wire protocol in `web/live` (Phase 5) and `brood_live.js`.

**Recommendation:** `brood-json` as a first-class nest package — the HTTP
server itself doesn't need JSON, only the live layer does. Keeps
brood-http dependency-free.

### 1c. URL percent-encode/decode

**Why:** HTTP query strings and form-encoded bodies use percent-encoding.
Without it the router can't correctly parse `/search?q=hello%20world`.

**Where:** ~40 lines of pure Brood. Ship inside brood-http as
`http/url-decode` / `http/url-encode`.

**Blocking:** Query string parsing in brood-http (Phase 2).

---

## Phase 2 — `brood-http`

*Our Bandit: a pure-Brood HTTP/1.1 server with WebSocket upgrade support.
No external dependencies beyond Brood's stdlib TCP/crypto primitives.*

See `docs/brood-http.md` for the full design.

### Deliverables

- `http/server` — the listener + accept loop + worker supervision
- `http/request` — HTTP/1.1 request parser (request line, headers, body)
- `http/response` — response serializer (status line, headers, body)
- `http/ws` — WebSocket handshake (RFC 6455) and frame codec
- `http/util` — URL decode, base64, header helpers

### Interface (what the web framework calls)

```lisp
;; Start a server; handler is fn(request-map) -> response-map
(http/server/start {:port 4000 :handler my-handler})

;; Request map shape (delivered to handler)
{:method  "GET"
 :path    "/users/42"
 :query   "page=2"
 :headers {:host "localhost" :content-type "application/json"}
 :body    ""}     ; raw string, empty for GET

;; Response map shape (returned from handler)
{:status  200
 :headers {:content-type "text/html; charset=utf-8"}
 :body    "<html>..."}

;; WebSocket upgrade: return :upgrade instead of a response map
;; handler receives :upgrade-request, returns a pid that owns the WS
{:upgrade :websocket
 :handler ws-handler-pid}
```

### What's out of scope for brood-http

- TLS (reverse proxy handles it)
- HTTP/2 (v2 scope if ever needed)
- Multipart streaming (Phase 2 parses the body as a string; chunked upload
  is a later concern)

---

## Phase 3 — `web/template`

*Hiccup-style HTML renderer and the static/dynamic split for live diffing.*

### Deliverables

- `web/template/hiccup` — renders `[:tag attrs & children]` vectors to
  HTML strings. Pure function, usable without the live layer.
- `web/template/live` — the `deflive-template` macro: compiles a template
  to a `{:static [...] :dynamic fn :fp hash}` struct for diff-efficient
  rendering.
- `web/template/diff` — computes the diff between two rendered structs:
  returns a map of changed slot indices → new HTML strings.

### Key design decision (resolved)

Change tracking uses **static analysis** of `(get model :key)` patterns
with a `(slot :key expr)` escape hatch for computed accesses. The macro
walker identifies literal-key `get`/`get-in` calls automatically;
anything else is treated as "always re-render this slot."

---

## Phase 4 — `web/conn` + `web/router`

*The HTTP application layer: immutable conn pipeline and macro-compiled
routing.*

### Deliverables

- `web/conn` — the conn map, helpers (`assign`, `put-status`,
  `send-resp`, `redirect`, `put-resp-header`, `fetch-session`,
  `write-session`, `verify-csrf`)
- `web/router` — `get`/`post`/`put`/`delete`/`live` macros that compile
  to a `dispatch fn(conn) -> conn` at load time; named path helpers
  (`path-for`)
- `web/pipeline` — `pipeline` macro for composing middleware
- `web/session` — process-backed session store (a named `defprocess`);
  signed-cookie session ID; CSRF double-submit

### Key design decision (resolved)

Sessions use a **process-backed store** by default: a named `defprocess`
maps session-id → session-map. The session ID is a signed cookie
(`%hmac-sha256`). No cookie size limit; sessions don't survive process
restart without persistence (acceptable default; a persistent adapter is
future work).

---

## Phase 5 — `web/live`

*LiveBrood: the server-side interactive layer. Each browser tab is one
Brood process.*

### Deliverables

- `web/live` — `deflive` macro expanding to a `defprocess` session actor
- `web/live/session` — dual-pass lifecycle (HTTP render → WS join → event
  loop), effects dispatcher, reconnection handling
- `web/live/component` — `deflive-component` for scoped sub-views (each
  its own process)
- `web/pubsub` — topic-based broadcast on named processes; distributed
  broadcast via Brood's node model

### Key design decisions (resolved)

**Event dispatch** uses keywords and Brood pattern matching, not strings:
```lisp
(on :increment (_params model) (update model :count inc))
(on :add-item ({:name n} model) ...)
;; server messages and client events use the same clause syntax
(on [:pubsub "chat" msg] (model) ...)
```

**LiveComponents are separate processes** (not in-process subtrees like
Phoenix). Brood processes are cheap; the isolation is worth it. Each
component owns its state, handles its own events, sends its own diffs.

**Effects** are returned values alongside the model:
```lisp
(on :search ({:q q} model)
  [(assoc model :query q)
   [[:navigate (str "/search?q=" q)]
    [:subscribe "results"]]])
```

---

## Phase 6 — `brood_live.js`

*The browser client. ~600 lines of vanilla JS, no npm dependencies.*

### Deliverables

- Wire protocol client (JSON messages over WebSocket)
- DOM patcher using `data-slot` attributes (no morphdom dependency; a
  ~80-line minimal morpher for element-level changes, direct
  `textContent` assignment for leaf text slots)
- Event delegation (`live-click`, `live-change`, `live-submit`, etc.)
- Automatic loading states (`live-loading` CSS class)
- Reconnection with exponential backoff
- JS hooks escape hatch (`live-hook="HookName"`)

### Wire protocol summary

Client → server: `{"t":"join","token":"..."}` / `{"t":"event","ref":"1","name":"increment","value":{}}` / `{"t":"hb"}`

Server → client: `{"t":"joined","diff":{"s":[...],"d":{"0":"42"},"fp":123}}` / `{"t":"diff","ref":"1","d":{"0":"43"}}` / `{"t":"navigate","url":"/new","kind":"patch"}` / `{"t":"push","name":"chart-updated","payload":{...}}`

---

## Phase 7 — `nest new --template web`

*Developer experience: scaffold a working web app with one command.*

### Deliverables

- `nest new myapp --template web` scaffolds a working project with a
  static route, a live route, layout, and `brood_live.js`
- `nest new myapp --template web-api` scaffolds a JSON API (no live layer)
- Hot reload: `nest run --watch src/` triggers re-render diffs in running
  live sessions
- `nest test` integration: `web/conn/test` helpers for testing handlers
  as pure functions

---

## Dependency graph

```
Phase 7  ─────────────────────────────────── nest tooling
Phase 6  ──────────────────────────────────── brood_live.js
Phase 5  ── brood-json ─── Phase 4 ─── Phase 3 ─── Phase 2
Phase 4  ─────────────────────────────────── Phase 2
Phase 3  ─────────────────────────────────── (none beyond stdlib)
Phase 2  ─────────────────────────────────── Phase 1 + stdlib TCP
Phase 1  ─────────────────────────────────── stdlib
```

---

## Stdlib gaps summary

| Missing primitive | Needed by      | Approach                        |
|-------------------|----------------|---------------------------------|
| `base64-encode`   | brood-http (WS)| Implement in brood-http (~60 ln)|
| `base64-decode`   | brood-http (WS)| Same                            |
| JSON encode/decode| web/live       | `brood-json` package            |
| URL percent-encode| brood-http     | Implement in http/util (~40 ln) |
| `http-get`        | future clients | Stdlib gap; not blocking        |

Crypto (`%sha1`, `%hmac-sha256`, `%random-bytes`), bytes
(`string->utf8-bytes`, `utf8-bytes->string`), and TCP
(`tcp-listen`/`tcp-send`/`tcp-close`/`tcp-controlling-process`) are all
already in stdlib and sufficient for the full stack.

---

## Open questions still needing a decision

| # | Question | Status |
|---|----------|--------|
| Q1 | Template: require `deflive-template` macro, or plain Hiccup everywhere? | Open |
| Q5 | Sessions: process-store only, or also pluggable adapters (disk/DB) from day one? | Open |
| Q8 | Auth: convention for `on-mount` guards, or just code in `mount`? | Open |
| Q10 | Head updates: `[:set-title]` effect, or a `<head>` slot in the layout? | Open |

*See `docs/web-framework-design.md` §6 for full detail on each.*
