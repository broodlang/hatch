# Assets — bundling CSS/JS, build-step agnostic

Hatch's stance on asset bundling is the same as Phoenix's: **the framework only
*serves* `static/`; it never *builds* anything.** Whatever produces your CSS/JS is an
external tool you choose, wired in through one plain-data config map. Swapping Tailwind
for esbuild, sass, UnoCSS, or hand-written CSS is a data edit — no framework code
changes.

This keeps the build step pluggable while still giving you the Phoenix dev experience:
`nest run` boots the server *and* the bundler's `--watch` together, and a CSS rebuild
hot-swaps the stylesheet in open live views with no page reload.

---

## The contract (three pieces)

1. **Serving** — `web/static` already serves `static/` (text assets: CSS, JS, SVG…).
   Point any bundler's output there.
2. **Linking** — your layout pulls the built file in with the `web/template/stylesheet`
   helper: `(stylesheet "/static/app.css")`.
3. **Producing** — `web/assets` shells out to the bundler, driven by a config map.

That's the whole surface. Hatch has no opinion about Tailwind; it just serves files.

---

## `web/assets` — the glue

One config map describes the toolchain:

```clojure
(def *assets*
  {:watchers [{:cmd ["bin/tailwindcss" "-i" "assets/app.css"
                     "-o" "static/app.css" "--watch"]
               :reload-on "Done in"}]      ; a stdout substring → hot-swap CSS
   :build    [["bin/tailwindcss" "-i" "assets/app.css"
              "-o" "static/app.css" "--minify"]]
   :install  [["sh" "-c" "..."]]})          ; optional one-time download commands
```

Three verbs operate over it:

| Verb | When | What |
|------|------|------|
| `(assets/watch *assets*)` | dev | Spawns each watcher as a green process (via `proc-spawn`), pipes its output to the log, and on each finished rebuild (`:reload-on` substring) hot-swaps CSS in open live sessions. |
| `(assets/build *assets*)` | release/CI | Runs each `:build` command one-shot (`run-process`), failing loudly on a non-zero exit. |
| `(assets/install *assets*)` | first-time setup | Runs each `:install` command one-shot — e.g. downloading a standalone binary. |

Each watcher map: `:cmd` (argv), and optional `:cwd`, `:env` (string→string map), and
`:reload-on` (rebuild marker substring; defaults to `"Done in"`, set to `nil` to never
trigger a CSS reload — e.g. a JS watcher). `:build`/`:install` entries are plain argv
vectors run in order.

### Wiring it into the endpoint

```clojure
(defn dev? () (= (or (getenv "HATCH_ENV") "dev") "dev"))

(defn serve ()
  (when (dev?) (assets/watch *assets*))     ; dev: server + bundler together
  (server/start (port) adapter (live/live-dispatcher)))
```

`nest run` (dev) starts the watcher; a release sets `HATCH_ENV=prod` and runs
`(assets/build *assets*)` once before serving. A missing binary just logs an error and
the server still boots — assets are degraded, not fatal.

---

## CSS hot-reload (better than a full live-reload)

Because Hatch already holds a WebSocket to every live view, a CSS rebuild doesn't need a
page reload. The chain:

```
tailwindcss --watch  →  prints "Done in 5ms"  →  web/assets sees :reload-on
   →  web/live/notify-reload-css  →  [:reload-css] to every live session
   →  brood_live.js re-stamps each <link rel=stylesheet> href with ?v=<ts>
```

The model isn't touched — form state, scroll, and focus survive; only the stylesheet
swaps. Plain (non-live) pages don't hold a socket, so they pick up CSS on their next
load, as usual.

---

## Tailwind v4 + daisyUI recipe (no npm)

This is exactly what the demo (`../hatch-demo`) uses. The Tailwind v4 standalone CLI is
a single prebuilt binary — the same thing Phoenix's `tailwind` Hex package wraps — so
there's no Node/npm in your workflow.

**`bin/setup`** (one-time) downloads the standalone CLI into `bin/tailwindcss` and the
daisyUI plugin into `assets/vendor/` (both gitignored). See the demo's `bin/setup`.

**`assets/app.css`** (the source the CLI compiles):

```css
@import "tailwindcss";
@plugin "./vendor/daisyui.js";        /* vendored, no npm */
@source "../src/**/*.blsp";           /* scan Brood for class names */
@source "../src/**/*.bml";            /* and BML templates */
```

The `@source` lines matter: Tailwind doesn't know about `.blsp`/`.bml` extensions, so
you point it at them explicitly — that's how classes in inline Hiccup *and* `.bml`
templates get picked up.

**Layout** links the output and picks a theme:

```clojure
[:html {:data-theme "light"}
  [:head {} … (stylesheet "/static/app.css")]
  [:body {:class "min-h-screen bg-base-100"} …]]
```

---

## Switching tools

Because Hatch only serves `static/`, swapping bundlers touches just your app:

- Edit the argv in `*assets*` (and `assets/app.css` / your source entry point).
- Keep writing the output to `static/` and linking it from the layout.

Nothing in the framework changes. Examples:

```clojure
;; esbuild for JS, alongside Tailwind for CSS:
{:watchers [{:cmd ["bin/tailwindcss" "-i" "assets/app.css" "-o" "static/app.css" "--watch"]
             :reload-on "Done in"}
            {:cmd ["bin/esbuild" "assets/app.js" "--bundle" "--outfile=static/app.js"
                   "--watch"]
             :reload-on nil}]            ; JS rebuild: no CSS hot-swap
 :build    [["bin/tailwindcss" "-i" "assets/app.css" "-o" "static/app.css" "--minify"]
            ["bin/esbuild" "assets/app.js" "--bundle" "--minify"
             "--outfile=static/app.js"]]}
```

---

## Testing views

`web/test` drives handlers and live views as plain functions — no server, no socket —
including assertions about the rendered markup (e.g. that daisyUI classes are present).
See the `web/test` module doc and `../hatch-demo/tests/web/views/`.
