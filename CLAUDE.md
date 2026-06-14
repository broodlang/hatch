# Hatch — guidance for Claude

**Hatch** is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new Rust.

See `docs/roadmap.md` for what's built and what's next.
See `docs/web-framework-design.md` for the full design rationale.

---

Hatch is a **library package**: `src/` holds only the framework (`http/` +
`web/`). The demo app lives in a separate sibling project, `../hatch-demo`,
which depends on Hatch via a local `:path` dep (`[hatch :path "../hatch"]`) —
so the demo is also our proof that Hatch installs and loads as a real package.

## Running

```bash
# In hatch/ (the framework):
nest test          # run the framework test suite
nest format        # format all .blsp source

# In ../hatch-demo/ (the demo app, consumes Hatch via :path):
nest fetch         # resolve the :path dep → project.lock.blsp
nest test          # loads `main`, exercising the dep end-to-end
nest run           # start the demo server ($HATCH_PORT, default 5000)
```

The demo (`../hatch-demo/src/web/routes.blsp`) serves:
- `GET /` — home page (plain)
- `GET /page-inline`, `GET /page-template` — plain pages (inline Hiccup vs `.bml`)
- `GET /counter`, `GET /counter-inline` — live counter (events + tickers)
- `GET /signup` — live form with as-you-type validation
- `GET /room` — PubSub demo (real-time broadcast across clients)
- `GET /presence` — Presence demo (live who's-here roster)
- `GET`/`POST /account` — form body params + signed session + flash (PRG)
- `GET /dev` — Basic-auth-gated diagnostics; `GET /slow` — slow-request logging demo
- `GET /static/*` — static assets (+ `/static/brood_live.js`, the live client)

## Source layout

```
src/
  http/
    util.blsp       — URL decode, query parse, status codes
    base64.blsp     — base64 encode (RFC 4648)
    request.blsp    — HTTP/1.1 parser (pipelining-safe)
    response.blsp   — response serializer + helpers
    server.blsp     — TCP listener/worker; WS upgrade detection
    websocket.blsp  — RFC 6455 handshake + frame codec
  web/
    template.blsp   — Hiccup → HTML renderer
    conn.blsp       — immutable Conn value + response pipeline (conn->response); cookies,
                      body params, before-send hook
    page.blsp       — plain (non-live) page render helper: (page conn hiccup)
    router.blsp     — defrouter macro (incl. (live …) clause), path-param + *splat matching
    session.blsp    — signed-cookie sessions + flash; fetch-session / fetch-flash plugs
    static.blsp     — MIME table + path-safe static file handler
    live.blsp       — deflive macro (mount/render/on/tick/handle-info), session actor,
                      live-route dispatch, JSON codec, send-info (out-of-band → handle-info),
                      page-chrome
    parts.blsp      — static/dynamic render split (minimal-diff wire protocol); compile-parts
    pubsub.blsp     — topic-based pub/sub (subscribe/broadcast) over live sessions
    presence.blsp   — who-is-here tracking (track/roster) with auto-leave on disconnect
    assets.blsp     — build-step-agnostic bundler glue (watch/build/install); CSS hot-reload
    test.blsp       — view test harness: synthetic conns, router/handler dispatch, live-view drivers
static/
  brood_live.js     — vanilla JS client for live views; apps can serve it straight
                      from hatch via (web/live/client-js-handler) — no vendored copy
tests/
  http_util_test.blsp
  http_request_test.blsp
  http_response_test.blsp
  http_base64_test.blsp
  http_websocket_test.blsp
  web_template_test.blsp
  web_conn_test.blsp
  web_router_test.blsp
  web_session_test.blsp
  web_static_test.blsp
  web_live_test.blsp
  web_parts_test.blsp
  web_pubsub_test.blsp
  web_presence_test.blsp
  web_assets_test.blsp
  web_test_test.blsp
docs/
  roadmap.md
  assets.md
  web-framework-design.md
  brood-http.md
  brood-for-claude.md
```

## Key conventions

- **No MCP tool calls** — use `grep` on `docs/brood-for-claude.md` for
  stdlib discovery; use `nest test` to verify code.
- **No vector patterns with `&`** — vectors are fixed-length; use
  `first`/`rest` for dynamic-length sequences.
- **No vector-destructure of list values** — `(let ([a b] some-list) ...)` 
  fails; use `first`/`rest` or rewrite as `(let (a (first x) b (first (rest x))) ...)`.
- **`map`/`filter`/`fold` return lists** — don't assert against `[...]` vectors.
- **Macro params shadow builtins** — avoid naming macro params `name`,
  `type`, `count`, etc.
- **`tcp-listen` inside spawned process** — accept messages go to the
  calling process mailbox; always call inside the listener green process.

## Writing Brood

`docs/brood-for-claude.md` is the language reference. The
`.claude/skills/writing-brood` skill auto-loads when editing `.blsp` files.
