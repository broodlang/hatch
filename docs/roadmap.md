# Hatch — Web Framework Roadmap

*Hatch is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new
Rust — TLS is handled by a reverse proxy.*

---

## Stack layers

```
┌──────────────────────────────────────────────────────────┐
│  Hardening ✅  compress · ratelimit · logger · stream    │
├──────────────────────────────────────────────────────────┤
│  Live      ✅  web/live · component · pubsub · presence  │
│  Rendering ✅  web/template (Hiccup) · bml · parts       │
│  Pipeline  ✅  web/router + web/conn · session · csrf    │
├──────────────────────────────────────────────────────────┤
│  Transport ✅  http/*  (HTTP/1.1 + WebSocket, our Bandit)│
├──────────────────────────────────────────────────────────┤
│  Already in stdlib:  tcp-*, %sha1, %hmac-sha256,         │
│                      string->utf8-bytes, %random-bytes   │
└──────────────────────────────────────────────────────────┘
```

---

## What shipped

Phases 1–11 are all complete as of **0.4.1** (2026-08-11); **0.4.2** added `web/upload`
(live upload progress) and **0.4.3** the live-view Conn, per-component wire diffs, reconnect
statics-caching, and the framed-read adoption described below. (Every brood version named in
this file is the one that shipped the change at the time; the CURRENT floor is whatever
`project.blsp` says — `>= 0.23.0` as of 0.16.0 — not any of them.) The per-phase record — what each one built, and the scope calls and
trade-offs behind them — is archived in
[`_archive/shipped-phases.md`](_archive/shipped-phases.md).

| Layer | Modules |
|---|---|
| HTTP/1.1 + WebSocket | `http/request` `http/response` `http/server` `http/websocket` `http/multipart` `http/util` `http/base64` |
| Request pipeline | `web/endpoint` `web/conn` `web/router` `web/page` `web/static` `web/session` `web/csrf` `web/auth` `web/errors` |
| Rendering | `web/template` (Hiccup) `web/bml` (`.bml` compiler) `web/parts` (static/dynamic diff split) |
| Live views | `web/live` `web/component` `web/pubsub` `web/presence` `web/registry` |
| Forms & uploads | `web/form` `web/upload` |
| Production | `web/compress` `web/cache` `web/ratelimit` `web/logger` `web/metrics` `web/dashboard` `web/stream` `web/assets` `web/application` `web/cluster` `web/env` `web/repo` |
| Tooling | `web/test`, `nest new --template hatch` / `--template web-api` |

`http/server`'s request-head read is `tcp/read-until` (brood ≥ 0.3.11), so the delimiter
arithmetic — hand-rolled here through several O(n²) fixes — now lives upstream, in one place,
tested there. Per-item `:for` diffing, per-component wire diffs and reconnect statics-caching
are all in: a
changed row ships that row, a changed component ships only its own changed inner slots, and a
reconnecting client that still holds the page skeleton is not sent it again. Since 0.4.2,
`web/live/live-conn` also exposes the connection's read-only Conn to view code
(a dynamic binding set once per session, so no hook signature changed), and `web/csrf` grew
`live-token`/`live-csrf-input` on top of it — closing the gap where a live view had no way to
render a CSRF token for a POST to a protected route.

**0.10.0 closes the endpoint gap.** Until it, `conn/router->handler` was the only thing
between the server and a router, and every real app therefore hand-rolled the six stages
around it: process isolation with a deadline, a log line for the crash, a validator on the
response, compression after the validator, baseline security headers, and themed error pages.
Six apps, six copies, and the order between stages three and four is the part that is easy to
get wrong and impossible to notice. `web/endpoint/serve` is that pipeline, configured rather
than rewritten; `web/errors` is the error-page half, with the two guards an app gets wrong
once (never skin a JSON body; never skin a page a handler rendered under its own status).
Extracted from hive, whose own comments record each of them as a bug it shipped.

Four smaller modules landed with it, each closing the same shape of gap — something every app
was writing itself, with a trap in it. `web/cluster` finds and dials an app's other machines,
which is what `web/cache/start-cluster` had been waiting for since it shipped: without a peer
list that listener runs correctly and hears nothing. `web/env` is typed environment reads,
because `string/->number` answers a *truthy* failure for junk and every hand-written
`(if (string/->number raw) …)` therefore admits `"abc"`. `web/page` grew `shell-halves` /
`with-shell` / `cached` — the runtime counterpart to `defhtml`, for a page shell whose statics
vary per session rather than per compile. And `web/auth` grew `bearer-auth`, whose scheme
match is case-insensitive as RFC 9110 §11.1 requires; the obvious
`(string/starts-with? raw "Bearer ")` rejects the `bearer` several clients send.

**0.14.0 names what the framework already had.** Four seams that were maps of functions or
maps of keys are now abilities and records, which is the difference between a mistake the
toolchain reports and one that reads as ordinary behaviour.

`web/session` grew the `SessionStore` ability — the answer to Q5 (see *Open design
questions*). `web/ratelimit`'s `:store` became `BucketStore`, so a store carries its own pool
as record fields rather than closing over one; the `{:take fn}` map it took before is no
longer a store, because two spellings for one thing is two shapes a reader has to recognise
and a look-alike map that fails at the call instead of at the definition. `web/live`'s
`Encode` fallback now delegates to the stdlib `JsonEncode`, so an app
writes one impl for both its HTTP JSON bodies and the live wire instead of discovering, on the
socket, that a second and private ability existed.

The Conn is a record and so are the two specs (`web/live/view-spec`,
`web/component/component-spec`). The point is the read: `(get conn :halted)` is a silent nil
that means "not halted", and `(get spec :render-slots)` mistyped means "no slots", which
degrades change tracking to re-rendering everything — correctly, forever, with nothing to see.
Both are now undefined functions `nest check` reports. The generated accessors read a plain map
as happily as a record, so a synthetic conn in a test and a hand-built spec both keep working;
what changed is that the framework's own reads go through a name. Two traps came with it, both
now pinned by tests: a declared field is always *present*, so `contains?` cannot ask "was this
ever set?" (`conn->response` was stamping `:route nil` onto every response), and a record is
not `=` to a map of the same fields. The session no longer merges a spec's keys over its view
either — it carries the spec under `:spec`, so a spec field and a session field cannot collide.

Two bugs fell out of declaring the fields. `web/conn/secure?` read a `:scheme` key nothing
ever set, so its "the server terminated TLS itself" branch could not fire — an app serving its
own HTTPS reported every request as insecure, which suppressed HSTS and cleared the session
cookie's `Secure` flag on exactly the deployment that had earned both; `http/server` stamps it
now. And `web/pubsub` and `web/presence` each carried their own copy of the vault/monitor
bookkeeping, identical down to the `(when ref (demonitor ref))` — one copy now, in
`web/registry`, with the demonitor invariant finally under a test.

**One JSON decoder, and it is the fast one.** `web/live` carried a hand-written
recursive-descent parser — nineteen functions, 175 lines — built to route around two brood
quadratics on a large inbound frame (`string/char-at` scanning codepoints, per-item append
copying the accumulator). Both were real when it was written and neither is now, so the
hand-rolled version had quietly become the slow one: measured on the two frames a session
actually sees, `json/decode` plus a `stringify-keys` pass runs **2.3x faster on a small event
and 4.2x on a 48 KB paste**, the stringify included. The keys still come out as strings,
because a view's `on` handler reads `(get params "value")` — the same spelling a query param
uses.

The one behaviour that changed is worth stating: **malformed input now refuses the frame
instead of degrading inside it.** The old parser answered U+FFFD for a bad `\uXXXX` and nil
for a number token like `1.2.3`, so a crafted frame was dispatched as an event with a hole in
it and the hole reached a model. `json/decode` raises, `parse-client-frame` already caught, and
the frame is dropped whole. The safety property is the one the old comments claimed — a
crafted frame cannot crash the session — reached by refusing the frame rather than guessing at
it. `stringify-keys` also stopped being two identical copies (`http/util` and `web/session`);
it is `http/util`'s, one layer below everything that decodes JSON.

**The `.bml` parser had a quadratic in the one thing templates are mostly made of.** Text was
consumed a character at a time — a slice of the whole remaining input, plus an append to a
growing accumulator, per character — so a prose block cost four times as much for every
doubling: 16 KB took 77 ms, 32 KB 223 ms, 64 KB 753 ms, **128 KB 2.95 seconds**. The
`<script>`/`<style>` branch immediately beside it scanned with `index-of` and did the same
128 KB in 0.4 ms, which is the measurement that made it obvious: two branches of one parser,
ten thousand times apart. `string/span-until` finds the next `<`, `{` or `\` in a single
native scan, so a run of text is now one slice and one append — **2950 ms → 0.6 ms, and flat**.

`read-while` went the same way. It took a character predicate, and all six of its call sites
passed the same one, so the generality bought nothing and cost a full-remainder copy per
character of every tag and attribute name; as `read-name` it is one `span-until` and one
slice, and a 1600-element template parses in 537 ms rather than 1147 ms. `skip-ws` is
`string/triml` (guarded, since most calls have nothing to skip and `triml` allocates
regardless) — verified against the hand-rolled loop over every codepoint 1–160.

What remains is bounded and deliberate: the parser still advances by re-slicing once per
*token*, so a very large template is mildly super-linear. Removing that means threading an
index cursor through all 500 lines, and index access is itself O(i) on a UTF-8 string, so it
is not the obvious win it looks like. A realistic template parses in tens of milliseconds, at
macro-expansion time, once. The catastrophic case was the text one, and it is gone; a test
pins the shape rather than a wall-clock number.

**`web/static` wrote its response headers out six times, and they had drifted.** The 200, 206
and 416 paths (each in a text and a bytes flavour) each carried their own literal map of
content-type, ETag, cache-control, accept-ranges and nosniff — and `Vary: Accept-Encoding` had
made it onto the two 200s and no range response, nor onto the 304. A shared cache storing a
206 therefore held a body with nothing saying it varies by content coding, and could hand a
gzip entity to a client that never asked for one. They come from `asset-headers` now, with
`rangeable-headers` adding the range advertisement — kept separate deliberately, because the
precompressed path serves a whole sibling and never honours a `Range`, so it must not claim
to. The 304 gained `Vary` (RFC 9110 §15.4.5) and nothing else: it has no body, so the headers
describing one have nothing to say. Four tests pin the set per status.

Two smaller ones alongside it. `web/parts`' `walk-element` bound a local named `second`,
shadowing the prelude function for its whole body. And the component-table parameter
`live-components` was a bare symbol agreed on by three files that never see each other — the
one `deflive` binds, the one `component-slot-form` passes, and the one `deps-of` recognises as
"always dirty". Renaming the parameter would have left `deps-of` matching a name nothing
binds, and the failure is silent: a component slot stops being `:all`, so a component's own
state change — which touches no model key by definition — never marks its slot dirty and the
component simply freezes on screen. It is `web/parts/*component-table-param*` now, with a test
asserting the three-way agreement.

**`web/cache`'s two fragment caches shared a table and not a shape.** `fetch` stores a value;
`fetch-ttl` stores a value plus its deadline. One key used with both read back the *wrapper* —
so a fragment memoised one way and read the other rendered `{:value "<div>…" :ttl-at 1757…}`
into the page: correct-looking code, visible garbage, nothing raised. The docstring warned
against it and nothing enforced it. The wrapper is a record now, for the reason
`web/template/raw-node` is one — a shape test can be satisfied by accident, an identity cannot
— and with an identity to test, the collision is named at the point it happens instead of
travelling into a response.

**A rate-limit bypass, found by pulling on a duplicate.** `web/auth/client-ip` answered the
forwarded address verbatim, and a forwarded address may carry the source PORT — RFC 7239
spells it `for="192.0.2.43:47011"`, and proxies do it. That answer is what `web/ratelimit`
keys a bucket on, so one client got a *different bucket per connection* and the limiter
silently never limited: not a weakened defence but an absent one, on the login form the plug
is put in front of. `allow-ips` had normalised both sides before comparing all along, so the
two layers already disagreed about who a caller was — which is exactly what the same rule
living in one place and not the other looks like from outside. `client-ip` normalises now
(`[2001:db8::1]:5000`, `203.0.113.9:41001` and `  203.0.113.9  ` all resolve to one client),
and tests pin both halves: one client is one bucket, and two clients still are not.

It surfaced while consolidating `ipv6-groups`, which `web/auth` and `web/ratelimit` each had a
copy of. The duplicate was the symptom; the divergence was the bug.

**Four helpers that existed in two or three copies each now exist once.** The one that
mattered is `script-safe` — the escaper that stops a `</script>` inside JSON-LD or a WebMCP
tool block from ending the element and spilling the rest of the data into the page as markup.
`web/seo` and `web/mcp` each had a copy, byte for byte identical, which is how one gets
hardened and the other does not; it is `web/template/script-safe` now, beside `escape-html`,
because escaping for an HTML context is that module's job. `ipv6-groups` was in `web/auth` and
`web/ratelimit` — the limiter already borrows `client-ip` from auth on the stated principle
that both layers must agree about who a caller is, and how the address is PARSED is the same
argument; two parsers that disagree mean an address the allow-list admits is bucketed as
someone else. `crlf-at?` was in `http/request` and `http/multipart` under one name with
DIFFERENT contracts — multipart's bounds-checked, request's assumed the caller had proved the
index — which is worse than either alone, since a reader who learns one and calls the other
reads off the end of a buffer; the checked contract won and lives in `http/util`.
`remote-nodes` was in `web/cache`, `web/pubsub` and `web/presence`, identical `try`-guard and
all, and belongs in `web/cluster`: what a peer is, and whether there are any, is that module's
subject and the other three only ask.

Also gone: `http/util/carrier->text` (nothing has called it since the parser went bytes-native
in ADR-141) and `http/server`'s `head-complete?`/`tail3`, left behind by the `tcp/read-until`
adoption — one of them documented in terms of a `worker-read-head` that no longer exists.

**One breaking change, and it needs to travel with the hive ref bump.**
`web/seo/sitemap-entries` took a leading `site` it never read; it is `(sitemap-entries routes
opts)` now. Entries are paths — the origin is applied per entry when the XML is rendered — so
there was nothing there to use it for and a reader had to go looking to find that out. hive's
`db_sitemap_test` was the one caller outside this repo and is updated in the same breath.

**0.11.0 adds two checks that were already documented and unenforced.** `web/audit` grew a
fourth rule: a page that declares WebMCP tools and still has a GET form no single tool can
stand in for. Both halves work — the agent registers the tools, the form renders — and the
one thing the page is for is reachable only by driving the markup. It judges GET forms
only, and only on a page that already declared tools: a POST form deliberately without a
tool (a login, a password change) is the common correct case, and warning about it is how a
lint stops being read.

`web/seo/llms-text` now raises when `:details` contains a markdown heading, which its own
docstring had forbidden since it shipped. An `##` there does not render as emphasis — it
opens a section ahead of `:sections`, and everything after it silently becomes that phantom
section's content while the document still looks correct, headings and all.

**0.12.0 gives rate limiting and caching the two shapes a public read surface needs.**
`web/cache/fetch-ttl` is the bounded-staleness sibling of `fetch`, for the case `fetch` is
documented as wrong for: output identical for every requester that nonetheless changes — a
listing, a document built from the database. `fetch` has no expiry, so memoising one serves
its first version for the life of the process unless something remembers to invalidate, and
the failure mode of forgetting a hook is a document that is wrong indefinitely with nothing
to notice. A TTL is wrong for at most its window, whatever changed and whoever forgot.

`web/ratelimit/network-key` keys an IPv6 caller by its /64 rather than its exact address.
An address is not a client: privacy extensions rotate the host half, and a caller can cycle
through a /64 far faster than the rotation does, so a per-address bucket is escaped by
picking a new address — the one thing an abuse control must not allow. `web/auth/allow-ips`
already treats a /64 as the unit of identity. It is opt-in, because the bluntness cuts both
ways and `client-key` remains right wherever a neighbour's traffic must not affect yours.

**0.13.0 makes rate limiting adaptable instead of extractable.** The question that
prompted it was whether to split it into a package; the answer is that the package boundary
was never what people would want from it. What they want is to change parts of the decision,
so all four are now seams: `:key-fn` (who), `:skip?` (whether at all, per request rather than
per route), `:cost` as a function of the conn (what the request is worth), and `:store` —
a value implementing the `BucketStore` ability — for where the buckets live. `refill` and `spend` are
public so an alternative store reuses the token-bucket arithmetic rather than reimplementing
it; a Postgres-backed store is those two functions around a row.

`stats` and `[:hatch :ratelimit :denied]` telemetry close the other half: a limiter that
never denies and one nobody reaches look identical from outside, and both look like one that
works. `web/dashboard` renders the counters, and `:buckets` is the number to watch — keys
are never evicted, so one derived from user input grows the table without bound.
`docs/rate-limiting.md` documents all of it, including the three things it deliberately does
not do.

**0.14.0 turns an SEO audit's findings into framework defaults.** Running a scan against a
hatch app produced a list, and the useful reaction to such a list is not to hand-fix one
site — it is to ask which items every app has and make those either automatic or one line.

Automatic: `Strict-Transport-Security`, sent only on an HTTPS request (`web/conn/secure?`
reads `X-Forwarded-Proto`, since behind a proxy the app's own socket is plaintext). The
default is `max-age=31536000` and nothing more — `includeSubDomains` commits subdomains the
framework has never heard of, with a year-long memory in every browser that saw it.

One line: `seo/canonical-host`, a 301 to the site's own host that preserves path and query,
for the duplicate-address problem that accumulates without anyone adding to it.

Warned about: two new `web/audit` rules. **Heading hierarchy** catches `h1` followed by `h3`
— a level is size in CSS and structure in HTML, and skipping one tells a reader navigating by
heading that they are inside a section that does not exist. **Favicon** catches a `<head>`
that declares no icon.

And `docs/seo-and-headers.md` writes down the triage itself, including what hatch refuses:
a CDN is infrastructure, analytics is render-blocking third-party JavaScript traded for a
checkbox, `ads.txt` declares who may sell advertising on a site that sells none, and
"include your keywords" is advice to write well, not a change to make.

**0.15.0 adds the half of WebMCP that does not need JavaScript.** `mcp/form-tool` emits the
declarative annotations — `toolname`, `tooldescription`, optional `toolautosubmit`, and
`toolparamdescription` on the controls — that a browser reads off a `<form>` to derive a tool
and its input schema.

It matters more than a second spelling of the same idea. The imperative block is only real
once a browser implementing WebMCP has run the script and registered the tools, so a crawler,
an audit tool, or an agent that never executes the page sees nothing at all. An annotated form
is static HTML and is visible to every one of them. Prefer it wherever a form already does the
thing: there is no endpoint to duplicate and no second code path to keep in step.

`web/audit`'s coverage rule learned both halves — an annotated form is covered by itself, and
an annotated form is *itself* a declaration, so a page using only the declarative API is
audited rather than opting out of the check entirely.

**0.16.1: three layers asked one question and gave two answers.** `web/compress/accepts?`
honoured an `Accept-Encoding: gzip;q=0` refusal. `web/static/accepts?` and
`web/stream/accepts-gzip?` were separate crude substring tests that read that refusal as a
yes — measured, not inferred: one conn, three predicates, `false true true`. A client that
spells out `q=0` is usually one that cannot decode gzip, and `web/static` is the worst place
to get it wrong, because there the predicate gates serving the *precompressed* `.gz`/`.br`
sibling — so that client was handed a body it could not read, not merely a missed
optimisation. This is the `client-ip`/`allow-ips` shape again (0.16.0): the duplicate was the
symptom and the disagreement was the bug. One predicate now, `http/util/accepts-encoding?`,
one layer below all three because all three take a header and not a conn; a test pins the
three answering alike so they cannot drift apart again.

`web/live` and `web/mcp` each carried the same four definitions for serving hatch's own
bundled client — `*hatch-root*`, `asset-path`, `client-js`, `client-js-handler` — identical
but for the filename, and mcp's comment said as much ("the same trick web/live uses"). The
root is found by stripping the file's own known suffix off its path, and `string/replace`
answers the subject unchanged when the pattern is absent, so moving either file would have
turned the root into the whole path and 404'd the client with nothing raised. That trap
existed twice. It is `web/static/bundled-path` / `bundled-source` / `bundled-js-handler` now,
beside `serve-body`, which both were already calling; the public names in both modules stay
as delegates. `web_live_test` also asserts the served *body* is the client rather than only a
200 — an unlocatable client degrades to an empty 200, which the old test passed.

**The README's only example did not work.** It used `(handle-event ("inc" _ model) …)` and
`:phx-click` — Phoenix's spellings, neither of which hatch has. `deflive` selects clauses by
name and ignores the rest, so that example compiled, rendered, and produced a button that did
nothing, with nothing raised anywhere; a reader following the front page got a dead counter
and no clue why. `tests/readme_example_test.blsp` now runs the example, so the front page
cannot drift from the macro again.

CLAUDE.md had drifted in the same direction and worse: nine modules missing from the source
layout, `brood_webmcp.js` missing from `static/`, and a hand-copy of `ls tests/` stale in
eighteen places. The copy is gone — a rule plus the suites that are not straight per-module
ones — because a hand-maintained duplicate of a directory listing is what went stale.

**0.17.0: the seventh stage, and the validator it was quietly breaking.** `web/endpoint`
documents the six stages that go AROUND a router. Static assets are the one thing that has to
go in FRONT of one, and both apps built on hatch wrote it themselves and disagreed: hive put
`/static/*path` inside its router; hatch-demo wrote a `cond` on the conn's path with
`(string/substring path 8 …)`, a literal 8 standing in for the length of `"/static/"` that
nothing named and nothing checked. The reference app showed the worse of the two.

`:static` is the stage. `true` mounts `./static` at `/static` and adds hatch's own bundled
clients — `brood_live.js` and `brood_webmcp.js`, served out of the package, which is a route
every live app was writing by hand; `{:at … :dir … :clients …}` overrides any of it. A
request under the mount point is answered before the router runs and never reaches it, so an
asset costs one prefix test rather than a walk through every route, and the router file stays
the app's own routes. `static-subpath` derives the split from the mount point instead of a
hardcoded width, because the two have to agree and a literal in one place cannot — it is a
function precisely so it can be doctested.

Putting it in the router was not only a style question, and this is the part worth keeping.
Inside the router a static response reaches the compressor, and `web/static` has already
negotiated its own coding and tagged its own bytes. `finish` compressed it anyway and left
the ETag describing the UNCOMPRESSED body — so a client holding the gzip copy and
revalidating with `Accept-Encoding: br` is answered 304 against the identity tag and renders
gzip as br. `cache/conditional` had always declined to re-tag a response that arrived with an
ETag, for exactly this reason; the compressor beside it did not decline to re-encode one, and
half a rule is not one. **A response that arrives already tagged is now sent uncompressed.**
This is live-visible: an app serving static through its router was shipping mislabelled
representations, and hive was.

`present?` — "is this value worth emitting as markup at all" — was a byte-identical private
copy in `web/seo` and `web/mcp`, twenty call sites between them asking one question. It is
`web/template/present?` now, beside `escape-html` and `script-safe`, for the same reason
those moved: the decision is about what reaches the document, and that is this module's
subject.

Deliberately NOT done: the one-line `bump` over a counter table in `web/cache` and
`web/ratelimit`. They are two tables on purpose, so sharing means a helper taking the table,
which makes every call site longer to remove one duplicated line. Revisit if a third appears.

**0.17.1: hatch's own browser clients were served EMPTY by every released app.** Found by
curling production before a deploy: `https://brood.fly.dev/static/brood_webmcp.js` answered
`200` with `content-length: 0` and an ETag over the empty body. hive declares its WebMCP
tools on every page and points an agent at that script, so the capability had been dead in
production for as long as it had existed — with a status that says yes, a JavaScript
content-type, and a served-file line in every log.

The cause is `nest release`, and it defeats the two obvious fixes. A release bundles the
manifest and every `src/**/*.blsp` — sources, and only sources — so hatch's `static/` is data
and does not travel. Inside the bundle `reflect/current-file` answers a virtual
`<bundle>/hatch/web/static.blsp`, which contains no `/src/`, so `*hatch-root*`'s suffix-strip
misses and `string/replace` hands the whole path back unchanged: exactly the silent
degradation 0.16.1 predicted, reached by a route nobody had thought of. Reading once into a
load-time `def` does not help, because the bundle evaluates its top level at boot, inside
itself. Nor does a macro: a bundle MACROEXPANDS at boot too — the attempt is what proved it,
by failing the release's own boot check with the path above.

So absence is a fact to design around, not defeat. Two changes, and the second is the one
that would have surfaced this years earlier:

  - `web/endpoint`'s `:static` stage now FALLS THROUGH to the app's own static directory when
    the package copy is unreadable. A released app then needs one `cp` of the clients into
    its static dir during the image build and serves them correctly, with nothing else
    changed.
  - `web/static/bundled-js-handler` answers **404** where it used to answer a 200 with an
    empty body. An empty 200 is indistinguishable from success from the outside, which is the
    whole reason this ran in production unnoticed.

Verified in an actual release binary, run from a directory with no source tree: 404 without
the copy, and 200 with the real 24,955 bytes once it is there.

**0.18.0: `no-transform`, and one counter vocabulary.** Two loose ends from the 0.17 work,
both closed.

An `ETag` names one exact sequence of bytes (RFC 9110 §8.8.3), and hatch went to some trouble
in 0.17.0 to stop its own pipeline re-encoding a response that already carried one. An
intermediary does the same thing from outside: `brood.fly.dev` served an identity stylesheet
that Fly's edge gzipped on the way out, forwarding hive's identity ETag with it — so a client
holds a gzip body under a tag describing the uncompressed one, and its next `If-None-Match`
can be answered 304 for a representation it does not have. The origin was correct; the hop
after it was not.

HTTP has the directive for this. `Cache-Control: no-transform` (RFC 9111 §5.2.2.6) forbids an
intermediary altering the payload, and `web/cache/forbid-transform` adds it to any response
carrying a validator — merged, so a handler's own `no-cache`, `immutable` or `max-age`
survives beside it. It rides in `secured`, the last step every response passes through, so the
directive describes the bytes actually going out; `:no-transform false` opts out. There is
nothing an intermediary can add by re-encoding a hatch response — the content negotiation and
the compression already happened here, under tags that name the coding — only a validator it
can invalidate.

**The counters.** 0.17.0 recorded a decision not to share `web/cache`'s and
`web/ratelimit`'s one-line `bump`, on the grounds that a helper taking the table would
lengthen every call site to remove one duplicated line. That was the wrong boundary to look
at. The duplication worth removing was never the increment — it was the RATE, and the rule
behind it: a rate over no traffic is **nil, not zero**, because a cache nobody asked and a
cache that never hits both read as 0%, as do a limiter nobody reached and one that never
denies. Each module had written that rule out in its own prose and computed it with its own
arithmetic — `(/ (* 100.0 hits) asked)` against `(* 100.0 (/ denied (* 1.0 total)))`. Two
spellings of one rule is how one of them gets a fix and the other does not.

So `web/metrics` — the module whose subject is counting what happened — now owns
`new-counters` / `bump-counter` / `counter-value` / `reset-counters` and, the point of the
exercise, `rate-percent`, with the rule stated once and four doctests pinning it. Each module
still keeps its own table: they are separate namespaces, not one shared tally.

A flaky test went with it. `web_endpoint_test`'s "no etag caches nothing" compared an
absolute count of the process-wide compressed store before and after — which races every
other test that compresses something, and failed about two runs in three once the suite grew.
It asserts the shape of the keys now: an untagged response could only key itself on a nil
tag, and that no such key exists is true regardless of what else is running.

**0.19.0 closes the backlog, and three of the four items were smaller than their entries.**

**A component can beat on its own.** `(tick ms (state) …)` in a `deflive-component`, started at
mount, dispatched by the session as `[:tick-component cid ms]` and applied by `apply-tick` —
structurally `[:update-component]`, with the component computing its own changes instead of
being handed them. The parent's model is untouched, so what reaches the wire is the
component's own inner-slot diff. Unlike a view's beat it is not generation-stamped: a view's
tickers are killed and restarted across live-navigate so a stale beat must be dropped, while
the components table is session-wide and survives navigation by design.

The lifecycle question that kept this a carve-out is answered rather than solved.
`timer/send-interval` monitors its target, so a component's beat dies with the session; what it
can outlive is the component leaving the SCREEN, and a beat then produces a diff for a slot
nobody renders — wasted work, not wrong output, bounded by the session. That is the same shape
as `send-update` to an unrendered component, which has always been a no-op, and it is why this
is a tick and not a scheduler.

**A component in a conditional was never a runtime limitation.** `slot-diff` already fell
through to the whole new value when a slot "just became" a component, and `slot->html` already
rendered any slot kind — the coarseness lived entirely in what `compile-parts` emitted, which
wrapped the whole `(if …)` in `render` and threw the structure away. `conditional-slot-form`
emits an `if` over slot VALUES instead, so the branch actually taken keeps the component's own
split. Flipping branches needs nothing new: a different cid ships whole, a component replaced
by a string ships the string, and only an unchanged cid takes the per-inner-slot path — which
is exactly the condition under which that path is sound.

**The `(for …)` half of that entry was simply wrong**, and is corrected rather than fixed. A
comprehension is a comprehension *slot*, not an opaque dynamic: a component inside one has
always diffed per ITEM, shipping only the row whose HTML changed. The step down to
per-inner-slot would make comprehension items heterogeneous — strings or slot values — and
need `brood_live.js` to weave them, for a row's worth of bytes. Declined, and written down so
the entry does not grow back.

**Q10 is answered: head updates are an effect.** `web/live/push-title` rides the channel
`push-event` and `push-navigate` already use, flushed right after the handler's model diff so
the tab and the body move in one step. A `<head>` slot is the more general-looking option and
the wrong one: it would put the whole document inside the live template, and `<head>` is the
one region where morphing misbehaves — re-touching a stylesheet link can re-fetch and re-apply
it, giving a flash of unstyled content caused by a title change, and a re-inserted script
re-executes. The title is the only part of the head a live view realistically changes, and it
has a single native setter.

**Q1 and Q8 were answered by shipped code and nobody told the table.** Q1 went the
static-analysis way (`web/parts/deps-of`, over-approximating to `:all` so the failure direction
is a needless re-render rather than a stale one); Q8 went the clause way (`on-mount-guard`,
because a convention in `mount` cannot refuse a mount — it can only return a model and hope the
render notices). Both are recorded now, which is the actual fix: a decision log that is never
checked against the tree stops being a record and becomes a list of open questions that are not.

**0.20.0: the last carve-out, and the reason the previous entry was too pessimistic.** 0.19.0
declined per-inner-slot diffing inside a `(for …)` on the grounds that it needed the wire
format to carry slot values inside comprehension items and `brood_live.js` to weave them.
Both are true; neither is expensive. The change is three lines of server and two of client.

A `(for …)` whose body IS a component now makes each item that component's own slot: a row
whose component changed ships that component's changed inner slots rather than the row's
markup. `slot->html` renders each item before joining instead of concatenating raw, and
`comp-diff-at` routes a changed item through `slot-diff` — so an item that is the same
component across two renders produces a `__kdiff__` for that row alone. The client folds a
per-item value through `_applySlot` rather than assigning it, which is the same recursion it
already ran for a top-level slot.

**A wrapped body keeps per-item string diffing, and that is a boundary rather than an
omission.** `[:li {} (component …)]` would need every comprehension item to carry its own
statics/dynamics split, and that founders on IDENTITY: a component patch is gated on a
matching `cid`, a comp item has only its index, and indices shift on insert and delete — so
patching item 3 after a row was removed would splice two unrelated rows together. Per-item
string diffing has no such hazard. The boundary is now written where someone will hit it, in
`web/component`'s "Granularity, precisely" note and in `comp-form` itself.

The client half was verified by loading `brood_live.js` under Node against a stub DOM and
exercising `_slotHtml` and `_applySlot` directly — plain-string comprehensions unchanged,
component items rendered rather than stringified, a per-item `__kdiff__` folded onto the
previous row, grow and shrink intact, and a patch against a missing previous row refusing to
fabricate one. The harness is not committed: hatch is pure Brood with no npm, and a Node
dependency in the suite would cost more than the check is worth as a permanent fixture.

Closed bugs, cleanup passes and post-merge reviews are archived in
[`_archive/fixed-issues.md`](_archive/fixed-issues.md) — worth reading for the root causes,
several of which document non-obvious Brood behaviour.

---

## Still open

**Nothing.** Phases 1–11 are done and the backlog that survived them is now closed too; what
follows is the record of how, since three of the four turned out to be smaller than their
entries claimed.

- **The three body drains stay hand-rolled, on purpose** — the leftover of the framed-read
  adoption (the head reader took it; see *What shipped*). `tcp/read-n` reads to a length and
  returns the bytes, with no per-chunk hook, and each body reader needs one: `spool-drain`
  appends each chunk to disk (buffering the whole body in memory is the exact thing spooling
  exists to avoid), `buffered-drain` emits upload-progress telemetry per read, and
  `chunked-drain` decodes incrementally with no declared length at all. Closed as "not
  applicable", not "not yet done".
- ✅ **Component-level `tick`** — shipped in 0.19.0. `(tick ms (state) …)` in a
  `deflive-component`, started at mount, dispatched by the session as `[:tick-component cid ms]`
  through `apply-tick`. The one thing to know is in `start-component-ticks`: a beat outlives
  the component leaving the screen and is bounded by the session, which is the same shape as
  `send-update` to an unrendered component and the reason this is a tick and not a scheduler.
- ✅ **Components in a conditional diff per inner slot** — shipped in 0.19.0, and it was never
  a runtime limitation. `slot-diff` already fell through to the whole value when a slot "just
  became" a component, and `slot->html` already rendered any slot kind; the coarseness was
  entirely in what `compile-parts` emitted, which wrapped the conditional in `render` and threw
  the structure away. `conditional-slot-form` emits an `if` over slot values instead.
- ✅ **Components in a `(for …)` diff per inner slot too** — shipped in 0.20.0, for the bare
  case `(for (x xs) (component m {…}))`. The entry this replaces claimed a comprehension was
  an opaque dynamic; it never was — it is a comprehension SLOT, and a component inside one
  has always diffed per ITEM. What 0.20.0 adds is the step below that: each item is the
  component's own slot, so a changed row ships its inner-slot patch rather than its markup.
  Wrapped bodies (`[:li {} (component …)]`) keep per-item string diffing, and that is a
  boundary rather than an omission — see the note in `web/component`: item identity is an
  index, and indices shift on insert and delete.
- ✅ **Q10 answered** — head updates are an effect: `web/live/push-title`. See below.
## Known issues

None open. The three stale `bytes` type-signature warnings recorded here (`count`/`fold`
called directly on `bytes` at `http/response.blsp`, `http/util.blsp`, `web/static.blsp`) are
**gone as of 2026-08-13** — `nest check` reports zero warnings across `src/` and `tests/`,
and as of 2026-09-12 so does `nest check --strict`. The six that had accumulated there were
all one shape — index arithmetic the checker widens to `number` where a `string/substring` or
an `epoch-ms->` wants an `int` — and each had a fix worth making on its own terms: a
one-character `substring` became `string/char-at`, a `math/min` over two indices got the
`math/floor` that says it is one, `sitemap-date` now floors a computed (float) timestamp
rather than handing it over, and `web/audit`'s closing-tag widths became named constants
instead of the same literal `7` written in two functions that had to agree.
They were never real perf bugs (analysed at the time: `count` on `bytes` dispatches to the
O(1) native `byte-length`, and the `http/util` fold ran over at most 4 bytes); they cleared
without a dedicated fix, partly from the bytes-native port routing that fold through `seq`,
partly from brood 0.3.10's checker. The original analysis is in
[`_archive/fixed-issues.md`](_archive/fixed-issues.md).

---

## Blocked on Brood language changes

These are hatch-side follow-ups that only become worth doing once the matching
Brood language/runtime change ships. We proposed all six upstream — they're at the
top of [`brood/ROADMAP.md`](../../brood/ROADMAP.md) under *"Findings from hatch
(2026-07-11)"*. Context for the first three is `docs/tcp-http-audit.md` §16–§17
(the O(n²) class they retire).

**All six upstream items have now shipped** (reviewed against brood 0.3.8,
2026-08-07), and **all six are now closed hatch-side**. The last of them, framed reads, took
three further upstream fixes to become usable at all (`:timeout-ms`/`:max-bytes`,
`:deadline-ms`, `:seed`) — each found by trying the adoption and hitting a wall the previous
fix hadn't cleared. It is adopted as of 2026-08-13; details in its entry below.

- ✅ **Iolists — shipped upstream as ADR-139** (`tcp-send`/`bytes-concat`/`spit` take
  arbitrarily nested trees of strings, `bytes` and byte ints, flattened once at the
  write). Adopted where it applies: `http/websocket`'s frame builders now *describe*
  each frame as an iolist (`(bytes-concat [129 n body])`) instead of concatenating
  pairwise, and the hand-rolled `u64-be` shift-and-mask is gone in favour of the
  prelude's `int->bytes`. The remaining accumulators (`http/server`'s head reader and
  body drain, `http/request`'s `dechunk-step`) are *read*-side, not write-side — an
  iolist doesn't help there; they are covered by the bytes port below.
- ✅ **`bytes`-native parsing → drop the carrier-string bridge.** Upstream shipped
  ADR-141 (bytes-native `std/net`, carrier send rule deleted) and ADR-140 (bit syntax),
  and hatch's **WebSocket half is done** — the inbound frame parser is bytes-native and
  outbound frames are `bytes`. The HTTP half was: `http/server` bridges every read with
  `bytes->carrier`, and `web/conn` converts straight back (`carrier->bytes`), so a request
  body is walked twice for nothing (audit §16). **The parser is now ported** —
  `http/request/try-parse-bytes` / `try-parse-head-bytes` / `dechunk-step-bytes` parse a
  `bytes` buffer directly and keep the body as `bytes`. Because the parser is where the
  request-smuggling defenses live and the port is a *performance* change to *correct* code,
  it was gated on a **differential fuzz** (`tests/http_request_bytes_test.blsp`): a broad
  corpus (every framing/smuggling branch + binary bodies) and a truncation sweep (every
  byte-prefix of several requests) run through both the carrier parser and the byte parser,
  asserting identical verdicts, plus golden output checks. The fuzz earned its keep — it
  caught a hand-mirrored `cond` that had dropped three freshly-added smuggling checks; the
  byte parser now delegates head *classification* to `try-parse-head` verbatim, so the two
  can never drift, and slices only the body natively. **The server rewire landed too**
  (`d119f20`): `http/server`'s read loop accumulates `bytes` chunks verbatim (head completeness
  via `bytes-index-of`, body/chunked/spool paths on `subbytes`/`bytes-concat`) and
  `web/conn/build` carries the request `:body` as `bytes`, exposing `:body-bytes` and decoding
  `:body` text only for form/JSON handlers. So the whole-buffer `bytes->carrier` per read and
  `web/conn`'s `carrier->bytes` round-trip — the quadratic-in-upload-size double walk of audit
  §16 — are both gone from the hot path. The one behaviour change: a RAW handler's `:body` is
  now `bytes`. The carrier parser stays in `http/request` purely as the fuzz oracle.
- ✅ **Framed reads — `tcp/read-until` / `tcp/read-n`**, and the three upstream gaps that had to
  close before hatch could use them. Shipped 2026-07-25 with neither a timeout nor a size cap,
  so adopting would have dropped this server's 408/413; `:timeout-ms` and `:max-bytes` were
  added 2026-08-07 on our report. Attempting the adoption on 2026-08-13 found two more, both
  filed and fixed the same day: **`:deadline-ms`** (brood 0.3.10) — `:timeout-ms` is an *idle*
  timeout that a drip-feeder re-arms forever, while `:max-bytes` bounds only the size that drip
  reaches and never the time, so all four of hatch's read loops enforced a total deadline the
  combinator could not express; and **`:seed`** (brood 0.3.11) — the keep-alive path re-enters
  the head read holding the leftover of a pipelined request, which can be a *partial* head, and
  a `\r\n\r\n` straddling that leftover and the next chunk has to be found. **Adopted** in
  `http/server`'s `worker-read-head`, which is gone: the read is one `tcp/read-until` call whose
  three bounds map onto the same 408/408/413 answers. The body drains deliberately stay
  hand-rolled — see *Still open*.
- ✅ **`mapv`/`filterv` — shipped upstream 2026-07-18.** Swept: every
  `(into [] (map …))` in `src/` is now `mapv`, and the `(into [] (reverse …))` sites are
  `vec`. The CLAUDE.md convention notes the new spelling.
- ✅ **Module privacy — shipped upstream as ADR-146** and went past "link-checked" to
  enforced def-site privacy (`defn-`/`def-`). Migrated in `2366d07`; the `--`-infix
  convention is gone from the tree.
- ✅ **`let` vector-destructure of a list value — resolved upstream by erroring
  clearly.** Verified on 0.3.8: `(let ([a b] (list 1 2)) …)` raises
  `[:match-error :let (1 2) ([a b])]`. The `first`/`rest` idiom stays correct for lists;
  the CLAUDE.md caveat now records that this is a clean error rather than a silent
  misread.

### New upstream findings (2026-08-07) — all three fixed in brood

Filed back to brood from this review; hatch is the consumer that surfaced each. All three
were fixed upstream the same day, so these need a brood ≥ the next release.

- ✅ **A `table` global locked a project out of the ADR-218 startup image.** `nest check`
  reported *"hatch cannot use a startup image … cannot image global
  `hatch/web/static/*manifest-cache*`"*, so hatch (and every app depending on it) reloaded
  from source on every start. `Value::Table` is the language's *only* sanctioned mutable
  structure, and `web/static` uses two of them for exactly what tables are for (the
  fingerprint-manifest and ETag caches). Reproduced on a bare `nest new` project plus one
  `(def *cache* (table))` — upstream, not a hatch structure problem. **Fixed:** a table
  global is imaged by value (its snapshot) and rebuilt as a fresh table on restore; image
  format v4. No hatch change needed — `nest check` stops printing the note and hatch gets
  imaged startup, so keep the two caches as tables.
- ✅ **`tcp/read-until` / `tcp/read-n` needed a timeout and a byte cap** — see the
  framed-reads entry above. **Fixed:** both take `{:timeout-ms n :max-bytes n}`.
- ✅ **`nest format` descended into `_deps/`** — it counted and rewrote files in the
  dependency cache (it reformatted `_deps/store/.brood-pkg.blsp` on first run here), so
  "68 files considered" included source hatch does not own. **Fixed:** the formatter now
  walks a whitelist (`:source-paths` + `:test-paths` + a new `:format-paths`), so hatch
  reports 62 and never touches `_deps`. No hatch change needed — its Brood all lives under
  `src/` and `tests/`, so it needs no `:format-paths` entry.

### New upstream findings (2026-08-13)

- ✅ **A `defdyn` global loses its dynamic-variable registration when restored from the
  ADR-218 startup image** — **fixed upstream** in `83151776` (image format v5: the dynamic-var
  names are recorded in the image and re-marked on open) and **released in brood 0.3.10**. We
  re-derived it here before spotting the fix, which was a fair outcome: it landed after the
  v0.3.9 tag, so an installed 0.3.9 toolchain still had it.

  Symptom, for searchability: `nest test` on a pristine checkout was green twice, then failed
  38 tests on every run after — all in `web/bml`, plus the one component-template test that
  renders a `.bml` — with `binding: *bml-source* is not a dynamic variable (declare it with
  defdyn)` (E0099) from `hatch/web/bml/parse`. The image is written on the first run and never
  rewritten, so the trigger was the *restore* path. **Verified fixed:** four consecutive
  `nest test` runs from a cleared image are 932/932 on 0.3.10, where 0.3.9 reddened on the
  third. Nothing to do hatch-side — `defdyn` was used correctly throughout, and the failure was
  invisible on a first run, which is why CI starting from a clean checkout never caught it.

---

## Open design questions

**None.** All five are answered, and two of them had been answered by shipped code for some
time while the table went on asking — which is its own small lesson about a decision log that
is not checked against the tree.

| # | Question | Answer |
|---|----------|--------|
| Q1 | Slot annotation: explicit `(slot :key expr)` or static analysis of `(get model :key)`? | **Static analysis** — `web/parts/deps-of`. It over-approximates on purpose: any opaque use of the model yields `:all`, so the failure direction is a needless re-render rather than a stale one. No annotation to forget. |
| Q5 | Session storage: fixed cookie, or pluggable? | **Pluggable, through the `SessionStore` ability** (0.14.0). See below. |
| Q8 | Auth: `on-mount-guard` clause in `deflive`, or convention in `mount`? | **The clause.** A convention in `mount` cannot refuse a mount — it can only return a model and hope the render notices — whereas the clause redirects before the view exists. hatch-demo's `/dashboard` is the worked example. |
| Q10 | Head updates: a `[:set-title]` effect, or a `<head>` slot in the layout? | **The effect** — `web/live/push-title` (0.19.0). See below. |

**Q10, in full.** A `<head>` slot looks like the more general answer and is the wrong one.
It would mean the live template covering the whole document rather than the view's own
markup, and `<head>` is the one region where DOM morphing misbehaves: re-touching a
`<link rel=stylesheet>` can re-fetch and re-apply it — a flash of unstyled content, caused by
a title change — and a re-inserted `<script>` re-executes. Against that, the title is the only
part of the head a live view realistically changes, it is a single string, and it has a single
native setter. So it rides the effect channel `push-event` and `push-navigate` already use,
flushed straight after the handler's model diff so the tab and the body move together.

**Q5 is answered (0.14.0): pluggable, through an ability.** `fetch-session` takes a value
implementing `SessionStore` — `(cookie-store secret {})` for the built-in one — whose two ops
(`session-read` / `session-write`) are both handed the conn, so a store owns both how the
browser is told which session this is and where the data behind it sits. A store is a value
passed in rather than a name resolved through configuration, so it carries its own pool as
fields. Hatch ships only the cookie store, deliberately: a server-side session is per-node
unless it is replicated, and shipping one that quietly logs a user out on every other request
behind a load balancer would be worse than shipping none.

It briefly also took a bare secret, meaning "the cookie store with this secret". One argument
that is sometimes a secret and sometimes a store is two shapes to recognise and two branches
to keep working, for two saved characters — and it hid the store from the call site, which is
the thing worth seeing. `(cookie-store secret {})` names the store and shows where its options
go; a bare secret is a string, implements nothing, and now fails at the plug.

---

## Dependency graph

```
Phase 11 ✅ Phases 1–10 (hardening layer)
Phase 10 ✅ nest tooling + all phases
Phase 9  ✅ Phases 4, 5, 7
Phase 8  ✅ Phase 5
Phase 7  ✅ Phases 4, 5
Phase 6  ✅ Phases 3, 5
Phase 5  ✅ Phases 1–4
Phase 4  ✅ Phases 2, 3
Phase 3  ✅ (none beyond stdlib)
Phase 2  ✅ Phase 1 + stdlib TCP
Phase 1  ✅ stdlib
```
