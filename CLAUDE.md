# Hatch — guidance for Claude

**Hatch** is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new Rust.

See `docs/roadmap.md` for what's built and what's next. Closed history lives in
`docs/_archive/` — don't pull it into context unless the roadmap points you at it.
See `docs/web-framework-design.md` for the full design rationale.

---

Hatch is a **library package**: `src/` holds only the framework (`http/` +
`web/`). Its consumers live in sibling projects: hive (`../hive`), which pins
hatch by git commit, and the packages that render pages with it (`../mail`,
`../observe-local`). Grep all of them before removing or moving public API —
`nest check` in each, against your hatch, reports what a change leaves unbound.

**When you change hatch, hive cannot see it until you move its pin.** For local
co-development swap the dep to `[hatch :path "../hatch"]` and re-run `nest
fetch`; `../hive` documents the same swap in its own `project.blsp`. Put the
pin back before committing — hive's Dockerfile builds from its git ref, and a
`:path` dep there is a broken deploy.

New apps are scaffolded with `nest new myapp --from hatch --template app` (a full
Postgres-backed app) or `--template api` (a minimal JSON API, no live layer); `--from
../hatch` uses this checkout instead of the registry. The templates live HERE, as plain
files under `templates/` declared by `:templates` in `project.blsp` (brood ADR-424):
`{{name}}` and `{{package}}` are filled in at scaffold time, nothing else is evaluated,
and `templates/` is outside `:source-paths`, so hatch's own check and format never read
it. Editing a template is a hatch change that users get with the next hatch release.

## Running

```bash
# In hatch/ (the framework):
nest test          # run the framework test suite
nest format        # format all .blsp source
nest doctest       # check every `expr ;=> result` example in a docstring still holds
nest docs          # generate the HTML API site into doc/ (gitignored)

# The browser client (static/*.js) — Brood has no subprocess primitive, so `nest test`
# cannot run these; they are plain node with no dependencies. See docs/client.md.
node tests/js/timing_test.js   # the debounce/throttle decision
node --check static/brood_live.js
```

## Source layout

```
src/
  http/
    util.blsp       — URL decode, query parse, Content-Type + Accept-Encoding reads
    request.blsp    — HTTP/1.1 parser (pipelining-safe)
    multipart.blsp  — multipart/form-data parser (in-memory + spooled-to-disk uploads)
    response.blsp   — response serializer, status reason phrases, chunked encoders
    server.blsp     — TCP listener/worker; WS upgrade detection
    websocket.blsp  — RFC 6455 handshake, frame codec, and recv-frame — the socket reader
                      both socket actors (web/live, web/channel) park in, which hands back
                      any non-socket mailbox message rather than knowing about it
  web/
    endpoint.blsp   — THE standard endpoint: :static ahead of the router, then request →
                      task with a deadline → router →
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
    router.blsp     — defrouter macro (incl. the (live …) and (channel …) clauses),
                      path-param + *splat matching
    session.blsp    — signed-cookie sessions + flash; fetch-session / fetch-flash plugs;
                      fetch (the session off a raw conn — a channel socket's)
    csrf.blsp       — synchronizer-token CSRF (protect-from-forgery plug, csrf-input);
                      live-token/live-csrf-input read the token off web/live/live-conn
    oidc.blsp       — OpenID Connect sign-in (authorization code + PKCE): start/complete,
                      end-session-url, zitadel-config; the app keeps identity, gating,
                      session and refusal rendering
    auth.blsp       — auth plugs for router through groups: basic-auth, bearer-auth
                      (RFC-9110 case-insensitive scheme), allow-ips / allow-ips-from-env
    forwarded.blsp  — what the proxy says about a request: client-ip (+ allowed-ip?, the
                      ipv6-groups parse), secure? (scheme), request-host
    static.blsp     — MIME table + path-safe static file handler; file-text/inline-css (a
                      static file read per render, never captured in a def)
    channel.blsp    — topic sockets: defchannel (join/on/handle-info/handle-out/terminate),
                      one multiplexed /channel/ws socket, pattern-matched topic registry;
                      broadcasts ride web/pubsub topics, so a live view and a channel client
                      subscribed to the same topic both hear them
    live.blsp       — deflive macro (mount/render/on/tick/handle-info/unmount), session actor,
                      live-conn (the connection's read-only Conn, bound per session),
                      live-route dispatch, page-chrome
    socket.blsp     — the plumbing web/live and web/channel share: the JSON wire codec
                      (Encode/json-decode), send-msg/close-socket, the push queue, the idle
                      watchdog, send-info (out-of-band → handle-info), and `recv` — the one
                      read step ([:text]/[:binary]/[:control]/[:closed])
    macro-helpers.blsp — macro-time expansion deflive, deflive-component and defchannel
                      share: clause/clauses (duplicate → error), dispatch-match for `on`,
                      tick-match (literal intervals only), optional-defn, render-expr +
                      compile-render (the static/dynamic split with its opaque fallback)
    route-table.blsp — the load-time route tables (live paths, channel patterns) as image-
                      safe globals: global-name, register, the empty-vs-miss diagnostic
    bundled-client.blsp — one of hatch's own browser clients (brood_live/channel/webmcp.js)
                      declared once per module and served by web/endpoint's :static stage
    parts.blsp      — static/dynamic render split (minimal-diff wire protocol); compile-parts
    component.blsp  — LiveComponents: deflive-component macro (mount/render/on/tick),
                      render-slot (its own static/dynamic split, so a component diffs
                      independently), send-update, apply-tick
    form.blsp       — forms over store changesets: value (what an input shows, as typed),
                      error-for/field-class/errors?, email?/validate-email; honeypot +
                      honeypot-filled? (a field only a script fills in)
    format.blsp     — values as a page shows them: date/date-time/clock/calendar-date (UTC),
                      ago-text, month-start/month-days, byte-size, thousands, plural
    registry.blsp   — supervised, vault-backed named registries (pubsub, presence, cache,
                      ratelimit — all reach it bare, via `(:use web/registry)`)
    pubsub.blsp     — topic-based pub/sub (subscribe/broadcast) over live sessions
    presence.blsp   — who-is-here tracking (track/roster) with auto-leave on disconnect
    application.blsp — canonical app entry point: default-logger-opts + start (logger + children + park)
    repo.blsp       — open a store repo, run (dev) or verify (prod) its versioned
                      migrations, warm up the pool (web/repo/start)
    migrate.blsp    — the app's `migrate` commands (up/down/status/pending/sql/check/gen),
                      one function its main hands argv to; Fly runs `<app> migrate` as
                      the release_command
    assets.blsp     — build-step-agnostic bundler glue (watch/build/install); CSS hot-reload
    upload.blsp     — getting a file from a browser here, two ways. Over the live socket:
                      (allow name opts) at a model key, binary chunks spooled to disk,
                      entries/percent/consume/cancel — so progress is an ordinary slot of an
                      ordinary model key and the renderer knows nothing about uploads. Over a
                      plain form POST: ?upload_token= → [:hatch :upload :progress] telemetry →
                      pubsub → the view's handle-info as {:upload {…}}
    audit.blsp      — dev-only page audits, logged and never altering the response: a
                      control nothing can reach, a document too big for one round trip, a
                      head with no color-scheme before its stylesheet, a page that declares
                      WebMCP tools yet leaves a GET form uncovered, a skipped heading level,
                      a head with no favicon, and a data-hook with no id (which the morph
                      cannot recognise, so the hook is torn down mid-use)
    mcp.blsp        — WebMCP, both halves: tools-script (imperative, JS-registered, shapes
                      validated at render time) and form-tool (declarative annotations the
                      browser reads off a <form> — static HTML, so visible to a crawler)
    seo.blsp        — head-tags, robots.txt, llms.txt, and a sitemap derived from the
                      router's own route table
    test.blsp       — view test harness, in two halves. Spec-level: synthetic conns,
                      router/handler dispatch, live-mount/live-event/… Markup-level:
                      live-open then live-click/live-change/live-submit/live-has?/live-text,
                      which go through the rendered Hiccup with a CSS-ish selector — so a test
                      can only fire an event the markup actually wires up
    compress.blsp   — coding negotiation (brotli over gzip, only an encoder the runtime has
                      — available?, a real call probed once) + the encoders web/endpoint uses
    cache.blsp      — fragment + whole-page caching: fetch (no expiry) / fetch-ttl (bounded
                      staleness); cluster-aware invalidation via web/cluster; compressed bodies.
                      Both stores capped by count AND bytes, dropped whole at either cap
    http-cache.blsp — what a response tells downstream caches: strong-etag/etag-for,
                      not-modified?, conditional (304), versioned (a 304 from a version the
                      handler names, before render; weak tag, still compressed),
                      Cache-Control constructors, html-freshness, merge-vary, forbid-transform
    ratelimit.blsp  — token-bucket plug with four seams (:key-fn/:skip?/:cost/:store, the
                      last a BucketStore ability); network-key buckets IPv6 by /64
    heavy.blsp      — slots per kind of expensive work per machine (configure :slots);
                      with-slot answers a full kind with an immediate 503 + Retry-After, never
                      a queue; a crashed holder gives its slot back, a lost keeper fails open
    timing.blsp     — where a request's time goes: request (wrap the router) + span (name
                      the work); a slow request logs its spans, biggest first
    request-memo.blsp — answers remembered for one GET/HEAD request (remember/keep);
                      never for a write, never outside a request
    logger.blsp     — HTTP access log: the [:hatch :request :stop] telemetry http/server
                      already emits, as one structured line each (attach-access-log)
    metrics.blsp    — per-route latency histogram + status classes; also the shared counter
                      vocabulary (new-counters/bump-counter/rate-percent) cache and
                      ratelimit tally with
    dashboard.blsp  — the diagnostics page rendering metrics/cache/ratelimit/cluster counters
    streams.blsp    — collections a live view renders WITHOUT holding: the model keeps only
                      what changed since the last render, the client merges it into what is on
                      screen (data-update="stream"), and the session empties the stream after
                      every frame. No new wire protocol — it rides the ordinary render/diff
                      path. A delete cannot be rendered, so it goes as an effect naming ids
    stream.blsp     — Server-Sent Events over chunked streaming responses
    job.blsp        — background work PACED so it cannot starve request serving on a
                      single shared vCPU (the reason a bare spawn is not safe)
static/
  brood_live.js     — the live-view client: events, DOM morphing, navigation, uploads,
                      hooks (data-hook + BroodLive.hook) and debounce/throttle.
                      docs/client.md is the attribute vocabulary
  brood_webmcp.js   — the WebMCP client that registers a page's tools
  brood_channel.js  — the channel client: one socket, many topics, join/push/on
                      All three are served straight from the package, no vendored copy —
                      (web/live/client-js-handler), (web/mcp/client-js-handler) and
                      (web/channel/client-js-handler). web/static locates and serves them
                      (bundled-path / bundled-source / bundled-js-handler).
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
  `tests/js/` holds the client's own tests, which `nest test` does NOT run — Brood has no
  subprocess primitive. `node tests/js/timing_test.js`; see docs/client.md.
    web_channel_test.blsp                — web/channel end to end over a loopback socket
    web_streams_test.blsp                — web/streams, incl. a real session proving the
                                           server no longer holds a row once its frame is out
    web_live_watchdog_test.blsp          — the keepalive ping and the reap, on the wire
    web_live_upload_test.blsp            — the socket-upload half of web/upload, plus one
                                           real binary frame over a live session
    web_test_markup_test.blsp            — the markup-driven drivers, incl. the bug they exist
                                           for: a button wired to an event no handler has
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
  channels.md             — web/channel end to end: defchannel, topic patterns, the shared
                            pubsub topic namespace, presence over a socket, the wire, the
                            browser client, and the per-socket topic ceiling
  client.md               — the browser client's attribute vocabulary: data-event, debounce
                            and throttle, hooks, data-update=ignore, navigation; and what of
                            it is and is not covered by a test
  seo-and-headers.md      — what ships on by default (security headers, HSTS, ETag), what is
                            one line to add (canonical-host, robots/sitemap/llms, ugc rel),
                            what the dev audits warn about, and which audit-tool advice hatch
                            deliberately refuses (CDN, analytics, ads.txt, keyword stuffing)
```

## Key conventions

- **Load-time state belongs in a global, never in a process.** Anything registered
  once at load — the `(live …)` route table, the `(channel …)` pattern table —
  must live in a `defonce` global that `%registry-swap!` updates. A process cannot
  carry it, and the reason is not crash-safety but the **ADR-218 startup image**:
  an imaged boot restores globals and re-runs no module top-level, so nothing
  re-registers, and a lazily-spawned registry comes back EMPTY. That is exactly
  how every live view in every hatch app broke on an app's *second* run, from the
  first release that wired live views into the router until 0.21.1. Globals are
  shared across green processes anyway, so a process was never buying the sharing
  it looked like it bought. Supervise **runtime** state (pubsub subscribers, the
  presence roster, rate-limit buckets, the reload registry); anything written once
  at load goes in a global, where the image carries it with the module.

  A test proving "no process owns it" is not enough on its own — a Brood test run
  loads from source and never boots from an image. The demo's browser suite is
  what covers the imaged path, which is why its CI job warms the image first.

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
