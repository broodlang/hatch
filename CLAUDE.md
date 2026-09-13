# Hatch — guidance for Claude

**Hatch** is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new Rust.

See `docs/roadmap.md` for what's built and what's next. Closed history lives in
`docs/_archive/` — don't pull it into context unless the roadmap points you at it.
See `docs/web-framework-design.md` for the full design rationale.

---

Hatch is a **library package**: `src/` holds only the framework (`http/` +
`web/`). The demo app lives in a separate sibling project, `../hatch-demo`,
which normally depends on a **published** Hatch (`[hatch :version "^X.Y.0"]`) — so
the demo is also our proof that Hatch installs and loads as a real package, from
the registry, the way anyone else gets it.

**Right now it does not.** 0.16.0 is tagged here but NOT on the registry (which
still serves 0.15.1), so the demo is pinned to the release commit
(`[hatch :git … :ref "83f22d1…"]`) and that proof is suspended. `nest publish`
from this repo restores it; then flip the demo back to `:version "^0.16.0"`.

**When you change hatch, the demo cannot see it until you release.** For local
co-development swap the dep to `[hatch :path "../hatch"]` and re-run `nest
fetch`; `../hive` documents the same swap in its own `project.blsp`. Put the
pin back before committing either — hive's Dockerfile builds from its git ref,
and a `:path` dep there is a broken deploy.

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

# In ../hatch-demo/ (the demo app, consumes a published Hatch):
nest fetch         # resolve deps → project.lock.blsp (after a dep or version change)
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
    multipart.blsp  — multipart/form-data parser (in-memory + spooled-to-disk uploads)
    response.blsp   — response serializer + helpers
    server.blsp     — TCP listener/worker; WS upgrade detection
    websocket.blsp  — RFC 6455 handshake + frame codec
  web/
    endpoint.blsp   — THE standard endpoint: request → task with a deadline → router →
                      themed errors → freshness → ETag → compression → security headers,
                      in that order (web/endpoint/serve); assets prepared per environment
    errors.blsp     — error pages as a pipeline stage: a status table, an app-supplied
                      :render, and the two guards (never skin a JSON body, never skin a
                      page a handler rendered under its own status)
    env.blsp        — typed environment reads (as-text/as-integer/as-items/as-flag?) plus
                      dev?/prod?; the one place $HATCH_ENV is read
    cluster.blsp    — become a node and keep dialling the app's other machines (Fly's
                      <app>.internal AAAA records by default); the discovery half
                      web/cache/start-cluster waits for
    template.blsp   — Hiccup → HTML renderer
    bml.blsp        — .bml → Hiccup template compiler (HEEx-flavoured: {expr}, @field,
                      :if, :for, components); macro-time, invoked by deflive's template clause
    conn.blsp       — immutable Conn value + response pipeline (conn->response); cookies,
                      body params, before-send hook
    page.blsp       — plain (non-live) page render helper: (page conn hiccup); defhtml
                      (statics baked at expansion time); shell-halves/with-shell/cached
                      (the runtime counterpart — a shell rendered once and split at a
                      marker, and a whole page cached when the caller says it may be)
    router.blsp     — defrouter macro (incl. (live …) clause), path-param + *splat matching
    session.blsp    — signed-cookie sessions + flash; fetch-session / fetch-flash plugs
    csrf.blsp       — synchronizer-token CSRF (protect-from-forgery plug, csrf-input);
                      live-token/live-csrf-input read the token off web/live/live-conn
    auth.blsp       — auth plugs for router through groups: basic-auth, bearer-auth
                      (RFC-9110 case-insensitive scheme), allow-ips / allow-ips-from-env
    static.blsp     — MIME table + path-safe static file handler
    live.blsp       — deflive macro (mount/render/on/tick/handle-info/unmount), session actor,
                      live-conn (the connection's read-only Conn, bound per session),
                      live-route dispatch, JSON codec, send-info (out-of-band → handle-info),
                      page-chrome
    parts.blsp      — static/dynamic render split (minimal-diff wire protocol); compile-parts
    component.blsp  — LiveComponents: deflive-component macro, render-slot (its own
                      static/dynamic split, so a component diffs independently), send-update
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
    audit.blsp      — dev-only page audits, logged and never altering the response: a
                      control nothing can reach, a document too big for one round trip, a
                      head with no color-scheme before its stylesheet, and a page that
                      declares WebMCP tools yet leaves a GET form uncovered
    mcp.blsp        — WebMCP, both halves: tools-script (imperative, JS-registered, shapes
                      validated at render time) and form-tool (declarative annotations the
                      browser reads off a <form> — static HTML, so visible to a crawler)
    seo.blsp        — head-tags, robots.txt, llms.txt, and a sitemap derived from the
                      router's own route table
    test.blsp       — view test harness: synthetic conns, router/handler dispatch, live-view drivers
    compress.blsp   — response compression (brotli over gzip), as a before-send plug
    cache.blsp      — fragment + whole-page caching: fetch (no expiry) / fetch-ttl (bounded
                      staleness); cluster-aware invalidation via web/cluster
    ratelimit.blsp  — token-bucket plug with four seams (:key-fn/:skip?/:cost/:store, the
                      last a BucketStore ability); network-key buckets IPv6 by /64
    logger.blsp     — HTTP access log: the [:hatch :request :stop] telemetry http/server
                      already emits, as one structured line each (attach-access-log)
    metrics.blsp    — per-route latency histogram + status classes
    dashboard.blsp  — the diagnostics page rendering metrics/cache/ratelimit/cluster counters
    stream.blsp     — Server-Sent Events over chunked streaming responses
    job.blsp        — background work PACED so it cannot starve request serving on a
                      single shared vCPU (the reason a bare spawn is not safe)
static/
  brood_live.js     — vanilla JS client for live views
  brood_webmcp.js   — the WebMCP client that registers a page's tools
                      Both are served straight from the package — (web/live/client-js-handler)
                      and (web/mcp/client-js-handler), no vendored copy. web/static locates
                      and serves them (bundled-path / bundled-source / bundled-js-handler).
tests/
  One <module>_test.blsp per src/ module (`ls tests/` is the list — it is not repeated
  here, because a copy of it went stale in eighteen places before this note replaced it).
  The ones that are NOT a straight per-module suite, and what each is for:
    ability_test.blsp                    — the SessionStore/BucketStore/Encode abilities
    http_request_bytes_test.blsp         — differential fuzz: the bytes parser vs the carrier
                                           parser (kept solely as the oracle) must agree on a
                                           smuggling/framing corpus and every truncation of it
    http_spool_test.blsp                 — spooled-to-disk request bodies
    http_upload_test.blsp                — multipart uploads end to end over a real socket
    http_stream_test.blsp                — chunked streaming responses on the wire
    web_change_tracking_test.blsp        — which model keys dirty which slots
    web_component_diff_test.blsp         — per-component wire diffs
    web_component_template_test.blsp     — a component rendered from a .bml file
    web_live_component_integration_test.blsp — components embedded in a live view
    web_live_conn_test.blsp              — the per-session read-only Conn
    web_parts_for_test.blsp              — per-item :for diffing
    web_static_binary_test.blsp          — byte-faithful binary assets (no carrier round-trip)
    readme_example_test.blsp             — README.md's counter, run, so the front page cannot
                                           drift from the macro again (it had: see the file)
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
  rate-limiting.md        — the token-bucket plug, its four extension seams (key/skip/cost/
                            store), and what it deliberately does not do (per-node buckets,
                            no eviction, fails open)
  seo-and-headers.md      — what ships on by default (security headers, HSTS, ETag), what is
                            one line to add (canonical-host, robots/sitemap/llms, ugc rel),
                            what the dev audits warn about, and which audit-tool advice hatch
                            deliberately refuses (CDN, analytics, ads.txt, keyword stuffing)
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
  When you need a vector, use **`mapv`** or **`seq/filterv`** rather than
  wrapping in `(into [] ...)`. The two are *not* in the same place: `mapv` is a
  prelude global, `filterv` lives in `std/seq.blsp` — so it is `seq/filterv`
  qualified (which auto-loads), or bare only after `(:use seq)`. A bare
  `filterv` is an unbound symbol, which surfaces as a warning from `nest check`
  and a runtime failure, not a compile error.
- **Macro params shadow builtins** — avoid naming macro params `name`,
  `type`, `count`, etc.
- **Hatch's macros hand-build their expansion with `list`/`cons`, not quasiquote —
  deliberately.** Inside `` ` ``, Brood qualifies every resolvable symbol to the *defining*
  module and auto-gensyms every binder, so `` `(defn render (model) …) `` in `web/live`
  expands to `(def web/live/render (fn (model__41) …))`. Both are wrong for `deflive` /
  `deflive-component` / `defrouter` / `defhtml` / `deftemplate`: they define `render` /
  `mount` / `handle-event` into the *consuming* module, and `deflive`'s `on` / `tick` /
  `handle-info` clause bodies are anaphoric (a user's body says `model` and `event-params`
  by name). The escape hatch is `~'name` — `` `(defn ~'render (~'model) ~body) ``. Use
  quasiquote only with that discipline, and check `macroexpand` before the tests.
- **`tcp-listen` inside spawned process** — accept messages go to the
  calling process mailbox; always call inside the listener green process.
- **Document a pure public function with a doctest** — a docstring line of the form
  `(hatch/mod/fn args) ;=> result` is executed by `nest doctest`, so the example can't
  drift from behaviour. Name the function **fully qualified**: doctests are evaluated at
  root scope, where the module's bare names aren't in scope.

## Writing Brood

`docs/brood-for-claude.md` is the language reference. The
`.claude/skills/writing-brood` skill auto-loads when editing `.blsp` files.
