# Live-view ergonomics — wire live views in the router

**Status:** implemented.

## Goal

Reduce a live-view module to **mostly business logic**. The counter view used to carry
an HTTP `show` page, a `(def live-handler (ws-handler-for live-spec))` wiring line, and
four `:use` clauses — all boilerplate that drowned the actual view logic.

## Decision

Adopt the Phoenix pattern: **wire live views in the router**, not in the view.

```brood
(defrouter app-router
  (get  "/"        web/views/home/index)
  (live "/counter" web/views/counter)   ; auto GET mount-page + WS dispatch
  ...)
```

The `(live path module)` clause does three things at module load:

1. `(require 'module)` — loads the view module (so its `deflive`-generated `live-spec`
   exists); `require` is load-once, so a hot reload just re-runs it harmlessly.
2. Registers `module/live-spec` for WebSocket dispatch at `path`.
3. Adds a `GET path` route serving the mount page.

The view module then contains only imports + `:implements` + `deflive` + domain
functions — no `show`, no `live-handler`, no `web/template`/`web/conn`/`web/layout`
imports (they existed only for the `show` page, which the router now generates):

```brood
(defmodule web/views/counter
  "Click counter + fast/slow tickers."
  (:use web/live)            ; deflive — the one import a view needs
  (:implements LiveModule))

(defn init (start) {:count start :fast 0 :slow 0})
(defn increment (model) (assoc model :count (inc (get model :count))))
(defn bump (model k)    (assoc model k (inc (get model k))))

(deflive
  (mount  (params)          (init (string->number (get params "start" "0"))))
  (render (model)           [:div ...])
  (on "increment" (p model) (increment model))
  (tick 1000 (model)        (bump model :fast))
  (tick 3000 (model)        (bump model :slow)))
```

## How it fits together

- **`deflive`** (`web/live`) generates `live-spec` (a 0-arg thunk →
  `{:mount :render :handle-event :handle-tick :ticks}`). Unchanged — `ws-handler-for`
  still exists for wiring a single view without the router.
- **Live-route registry** (`web/live`) — a named process (`:hatch-live-routes`) holding
  a `path → live-spec` map. The router registers at load (`register-live`); the worker
  looks paths up per connection (`lookup-live`). A process because those two run in
  different green processes and must share the mapping.
- **`live-dispatcher`** (`web/live`) — the server's single ws-handler. brood_live.js
  connects to `/live/ws` + the page's `data-live` path, so `/live/ws/counter` strips to
  `/counter` (`live--ws-path`), which is looked up in the registry and run via the
  shared `start-session`. Unknown paths get the socket closed.
- **Endpoint** wires `(live/live-dispatcher)` as the ws-handler instead of one view's
  handler: `(server/start port adapter (live/live-dispatcher))`.

## Mount page: layout + title (the former open question)

The generated `GET path` handler builds its page with the **`layout` symbol in scope in
the router module** — so the app's router needs `(:use its-layout-module)`. The layout
stays a **plain** document shell: the clause injects the live-view client `<script>` +
connection-status chrome itself, via `web/live/live-chrome`, as children of the layout.
So only live pages carry the live wiring — a plain page (the home page) renders through
the same `layout` with no client script at all. The `<title>` is derived from the path
(`live-title`: `/counter` → `"Counter"`, `/users/online` → `"Users Online"`, `/` →
`"Home"`), overridable:

```brood
(live "/counter" web/views/counter :title "Click counter")
```

Using the in-scope `layout` (a plain bare symbol the app imports) keeps it visible to
the advisory type-checker / LSP — no macro-injected imports.

## Constraints worth remembering

- `(:implements LiveModule)` must stay a **literal** `defmodule` clause — the checker
  reads it from the un-expanded source (`head_is "defmodule"` in
  `crates/lisp/src/types/check/protocol.rs`, `implements_claims`). Any wrapper macro
  around `defmodule` would silently disable the behaviour-conformance check. The
  `LiveModule` behaviour itself lives in `web/live` (`defbehaviour LiveModule`) — named
  to avoid colliding with Phoenix's `LiveView`.
- The `live` clause references `module/live-spec` and `layout` as bare/qualified
  symbols, never injected imports — so LSP and the type-checker see them.

## Rejected alternatives (and why)

- **Elixir-style `use` / `__using__` macro mixin** (a provider module injects imports
  via a referred macro that expands to `require`/`%refer`): *works at runtime* but the
  advisory type-checker / LSP can't see macro-injected imports, so it emits
  `unbound symbol` warnings and autocomplete breaks. LSP support is a hard requirement.
- **Multi-module `:use`**, **`web/live` re-exporting `html`/`html-resp`**, a
  **`use-live-view` macro**: each only collapses import lines. They don't remove the
  real boilerplate (the `show` page + handler wiring), so they don't reach the
  "view = business logic" goal.
