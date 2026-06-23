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
  (if (dev?)
    (assets/ensure *assets*)                              ; dev: build once + watch
    (when (get *assets* :fingerprint)                     ; prod: fingerprint the built files
      (assets/fingerprint (get *assets* :fingerprint))))  ;       (no bundler needed at boot)
  (server/start (port) adapter (live/live-dispatcher)))
```

`nest run` (dev) builds once and starts the watcher. The actual bundler run for prod is a
**release/CI step** — `(assets/build *assets*)`, fail-loud — that produces `static/app.css`
*and* (via the `:fingerprint` key) the fingerprinted copies + manifest. At prod boot the
endpoint only needs to `fingerprint` the already-built file: that just hashes it (no
`bin/tailwindcss` required at runtime, so a slim image boots), and asset URLs resolve to the
immutable, content-addressed names. Keep the bundler out of the boot path.

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

## Caching & conditional requests

Every static response (and `brood_live.js`) goes through one pipeline in `web/static`, so
caching is correct without per-asset config:

- **ETag** — a strong, content-addressed validator (`"<sha256-prefix>"`). It's the same
  across restarts and replicas (unlike an inode/mtime tag), so a client's cached copy keeps
  validating everywhere.
- **`304 Not Modified`** — a request whose `If-None-Match` matches gets a bodyless 304
  (carrying the ETag + `Cache-Control`), so an unchanged asset costs a round-trip but no
  bytes.
- **`Cache-Control`** — environment- and fingerprint-aware:

  | Environment | URL | `Cache-Control` |
  |-------------|-----|-----------------|
  | dev | anything | `no-cache` (revalidate every load — an edit is never masked) |
  | prod | content-fingerprinted (`app.<hash>.css`, **in the manifest**) | `public, max-age=31536000, immutable` |
  | prod | plain (`app.css`, `brood_live.js`) | `no-cache` (cheap — the ETag turns it into a 304) |

  `prod?` is just `$HATCH_ENV` ≠ `dev` (the zero-config default), mirroring the endpoint.
  "Fingerprinted" is **manifest-backed, not a guess**: only a name hatch actually produced
  (a value in `<dir>/cache-manifest`) gets the immutable header, so a hex-shaped look-alike
  you didn't fingerprint (a vendored `chunk.a1b2c3d4.js`) stays revalidated rather than stuck
  in caches for a year. A cheap structural pre-check gates the manifest read, so a plain
  request never touches disk.
- **`X-Content-Type-Options: nosniff`** on every asset, so a browser won't MIME-sniff a
  response into something executable.
- **Ranges** — `Accept-Ranges: bytes` is advertised, and a single `Range` is honoured with a
  `206` (`Content-Range`) for ASCII-clean bodies; an unsatisfiable range gets a `416`. A
  multibyte body (a byte range could split a codepoint) or a multi-range request falls back
  to a full `200`, which the spec allows. (Range mostly matters for large/media files, which
  need binary serving — see the roadmap.)

---

## Content fingerprinting (prod cache-busting)

Long-lived caching is only safe when the URL changes whenever the bytes do. The build step
content-fingerprints assets and records a manifest; `asset-path` emits the right URL.

**1. Build** — add `:fingerprint` to the assets config and call `build` (release):

```clojure
(def *assets*
  {:build       [["bin/tailwindcss" "-i" "assets/app.css" "-o" "static/app.css" "--minify"]]
   :fingerprint {:dir "static" :files ["app.css"]}})   ; after :build
```

`(assets/build *assets*)` then writes `static/app.<sha8>.css` and a `static/cache-manifest`
mapping `app.css → app.<sha8>.css`. (Text assets only — `slurp` is UTF-8.)

**2. Link** — reference assets by their *logical* name via `asset-path`, not a hard-coded
path:

```clojure
[:head {} (stylesheet (static/asset-path "app.css"))]
```

In prod that resolves to `/static/app.<sha8>.css` (served `immutable`); in dev (or with no
manifest) it stays `/static/app.css` (revalidated each load). Link once, get the right
caching in both. The manifest is read on demand — cache it in the caller for a hot path.

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
