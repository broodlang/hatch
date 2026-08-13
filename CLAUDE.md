# Hatch — guidance for Claude

**Hatch** is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new Rust.

See `docs/roadmap.md` for what's built and what's next. Closed history lives in
`docs/_archive/` — don't pull it into context unless the roadmap points you at it.
See `docs/web-framework-design.md` for the full design rationale.

---

Hatch is a **library package**: `src/` holds only the framework (`http/` +
`web/`). The demo app lives in a separate sibling project, `../hatch-demo`,
which depends on Hatch via a local `:path` dep (`[hatch :path "../hatch"]`) —
so the demo is also our proof that Hatch installs and loads as a real package.

New apps are scaffolded with `nest new myapp --template hatch` (a full
Postgres-backed app) or `--template web-api` (a minimal JSON API, no live layer).
Those templates live **upstream** in Brood's `std/tool/project.blsp` (`nest new` is a
thin dispatcher to `project/new-project`), so editing them is a brood-repo change that
reaches users on the next `make install` of brood — not a hatch-side edit.

## Running

```bash
# In hatch/ (the framework):
nest test          # run the framework test suite
nest format        # format all .blsp source
nest doctest       # check every `expr ;=> result` example in a docstring still holds
nest docs          # generate the HTML API site into doc/ (gitignored)

# In ../hatch-demo/ (the demo app, consumes Hatch via :path):
nest fetch         # resolve the :path dep → project.lock.blsp
nest test          # loads `main`, exercising the dep end-to-end
nest run           # start the demo server ($HATCH_PORT, default 5000)
```

The demo (`../hatch-demo/src/web/routes.blsp`) serves:
- `GET /` — home page (plain)
- `GET /page-inline`, `GET /page-template` — plain pages (inline Hiccup vs `.bml`)
- `GET /counter`, `GET /counter-inline` — live counter (events + tickers)
- `GET /signup` — live form with as-you-type validation (web/form)
- `GET /room` — PubSub demo: `broadcast-from` + an optimistic local update (not just
  plain `broadcast`)
- `GET /presence` — Presence demo (live who's-here roster)
- `GET /reorder` — keyed DOM morphing + live-patch (`?highlight=` via `handle-params`,
  no remount — the rotation tick keeps running across it)
- `GET /dashboard` — gated by `on-mount-guard` (redirects to `/account` until the session
  has a name); embeds three LiveComponents (`web/component`): two independent
  `like-button` instances (inline render) + one `counter-widget` rendered from a `.bml`
  template
- `GET`/`POST /account` — form body params + signed session + flash (PRG); `save`
  validates with `web/form` (`max-length?`)
- `GET`/`POST /messages`, `GET /messages/:id` — Postgres-backed message board; `create`
  validates with `web/form` (`required?`, `matches-pattern?`); `:id` is the demo's one
  named-path-param route; the form's second button posts via `fetch` with the CSRF token
  as an `X-CSRF-Token` header instead of the hidden field
- `GET /uploads` — multipart upload (in-memory + spooled-to-disk), stored in Postgres as
  `bytea` and served back byte-faithfully; `GET /csrf-token` — CSRF bootstrap for clients
  that can't be handed a token in their HTML (a live view has no Conn in `render`)
- `GET /upload-progress` — live upload progress (web/upload): the bar is fed by the server
  as it reads a multipart POST on a *different* connection, tied to the live session by an
  `?upload_token=`
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
    bml.blsp        — .bml → Hiccup template compiler (HEEx-flavoured: {expr}, @field,
                      :if, :for, components); macro-time, invoked by deflive's template clause
    conn.blsp       — immutable Conn value + response pipeline (conn->response); cookies,
                      body params, before-send hook
    page.blsp       — plain (non-live) page render helper: (page conn hiccup)
    router.blsp     — defrouter macro (incl. (live …) clause), path-param + *splat matching
    session.blsp    — signed-cookie sessions + flash; fetch-session / fetch-flash plugs
    csrf.blsp       — synchronizer-token CSRF (protect-from-forgery plug, csrf-input);
                      live-token/live-csrf-input read the token off web/live/live-conn
    auth.blsp       — HTTP Basic-auth plug for router through groups (basic-auth)
    static.blsp     — MIME table + path-safe static file handler
    live.blsp       — deflive macro (mount/render/on/tick/handle-info/unmount), session actor,
                      live-conn (the connection's read-only Conn, bound per session),
                      live-route dispatch, JSON codec, send-info (out-of-band → handle-info),
                      page-chrome
    parts.blsp      — static/dynamic render split (minimal-diff wire protocol); compile-parts
    component.blsp  — LiveComponents: deflive-component macro, render-slot, send-update
    form.blsp       — validate/rules → [:ok params]/[:error {field message}]; built-in
                      validators (required?/email?/min-length?/max-length?/matches-pattern?);
                      error-for/field-class template helpers
    registry.blsp   — supervised, vault-backed named registries (shared by pubsub/presence)
    pubsub.blsp     — topic-based pub/sub (subscribe/broadcast) over live sessions
    presence.blsp   — who-is-here tracking (track/roster) with auto-leave on disconnect
    application.blsp — canonical app entry point: default-logger-opts + start (logger + children + park)
    repo.blsp       — open a store repo, migrate schemas, warm up the pool (web/repo/start)
    assets.blsp     — build-step-agnostic bundler glue (watch/build/install); CSS hot-reload
    upload.blsp     — live upload progress: ?upload_token= → [:hatch :upload :progress]
                      telemetry → pubsub → the view's handle-info as {:upload {…}}
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
  http_server_test.blsp
  protocol_test.blsp
  web_template_test.blsp
  web_bml_test.blsp
  web_conn_test.blsp
  web_page_test.blsp
  web_csrf_test.blsp
  web_auth_test.blsp
  web_router_test.blsp
  web_session_test.blsp
  web_static_test.blsp
  web_live_test.blsp
  web_live_conn_test.blsp
  web_parts_test.blsp
  web_component_test.blsp
  web_component_template_test.blsp
  web_live_component_integration_test.blsp
  web_form_test.blsp
  web_registry_test.blsp
  web_pubsub_test.blsp
  web_presence_test.blsp
  web_assets_test.blsp
  web_upload_test.blsp
  web_test_test.blsp
  web_application_test.blsp
docs/
  roadmap.md              — what's LIVE: shipped summary, open backlog, upstream blockers
  _archive/               — closed history. Do NOT read by default; the roadmap links to
                            the specific entry when one is relevant.
    shipped-phases.md     — what each of Phases 1–11 built, and the scope calls behind them
    fixed-issues.md       — closed bugs, cleanup passes, post-merge reviews (+ root causes)
  assets.md
  web-framework-design.md
  brood-http.md
  brood-for-claude.md
  hardening.md            — adversarial security/concurrency/renderer review findings
  robustness.md           — http/server hardening tiers (DoS limits, timeouts)
  tcp-http-audit.md       — socket-stack audit (kernel + framework), findings & fix plan
  live-view-ergonomics.md — router-wired live views design note
```

## Key conventions

- **No MCP tool calls** — use `grep` on `docs/brood-for-claude.md` for
  stdlib discovery; use `nest test` to verify code.
- **No vector patterns with `&`** — vectors are fixed-length; use
  `first`/`rest` for dynamic-length sequences.
- **No vector-destructure of list values** — `(let ([a b] some-list) ...)` raises a
  clean `[:match-error :let (1 2) ([a b])]` (verified on brood 0.3.8; it is an error,
  not a silent misread). Destructuring a *vector* value works. For a list, use
  `first`/`rest`: `(let (a (first x) b (first (rest x))) ...)`.
- **`map`/`filter`/`fold` return lists** — don't assert against `[...]` vectors.
  When you need a vector, use **`mapv`/`filterv`** rather than wrapping in
  `(into [] ...)`.
- **Macro params shadow builtins** — avoid naming macro params `name`,
  `type`, `count`, etc.
- **`tcp-listen` inside spawned process** — accept messages go to the
  calling process mailbox; always call inside the listener green process.
- **Document a pure public function with a doctest** — a docstring line of the form
  `(hatch/mod/fn args) ;=> result` is executed by `nest doctest`, so the example can't
  drift from behaviour. Name the function **fully qualified**: doctests are evaluated at
  root scope, where the module's bare names aren't in scope.

## Writing Brood

`docs/brood-for-claude.md` is the language reference. The
`.claude/skills/writing-brood` skill auto-loads when editing `.blsp` files.
