# Archive — fixed issues and review passes

*Split out of [`../roadmap.md`](../roadmap.md) on 2026-08-13. Every entry here is closed:
bugs found and fixed, cleanup passes, and post-merge reviews, each with the root cause and
the reproduction that proved it. Kept because the root causes are the useful part — several
document non-obvious Brood behaviour (deep-cloned closures across `table-put`, `map` over
`bytes` being O(n²), checker arity vs `&optional`) that is easy to rediscover the hard way.
The one entry still open (the 🟡 stale `bytes` type signatures) stayed in the roadmap.*

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

