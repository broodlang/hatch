# hatch

**Hatch** is a Phoenix/LiveView-inspired web framework for
[Brood](https://broodlang.org). Pure Brood — no npm, no new Rust. It bundles an
HTTP/1.1 + WebSocket server, a server-rendered component layer (`bml`
templates), CSRF/session/presence/pubsub, and a live view layer whose
server-held state pushes diffs to the browser over a socket.

Hatch is a **library package**. The framework lives in `src/` (`http/` +
`web/`); a full example app lives in the sibling project
[`hatch-demo`](https://github.com/broodlang/hatch-demo), which depends on Hatch.

## Usage

Scaffold a new Hatch app (templates ship with `nest`):

```bash
nest new myapp --template hatch     # full Postgres-backed app
nest new myapp --template web-api   # minimal JSON API, no live layer
```

A live view is a `deflive` module — `mount` builds the model, `on` folds an
event into it, and `render` returns the markup. A control binds to an `on`
clause with `:data-event`:

```brood
(deflive
  (mount (params) {:count 0})
  (on "inc" (params model) (update model :count inc))
  (render (model)
    [:div
      [:button {:data-event "inc"} "+"]
      [:span (get model :count)]]))
```

An app's endpoint is configuration, not code. `web/endpoint/serve` is the
request pipeline every production app needs, in the order that makes it
correct — each request in its own process with a deadline, the crash logged,
an `ETag` computed before the body is compressed, baseline security headers,
and error pages in your own layout:

```brood
(web/endpoint/serve
  {:router    routes/app-router
   :assets    *assets*
   :freshness {:max-age 60 :stale-for 600}
   :errors    {:render my-error-page}})
```

See `docs/web-framework-design.md` for the design rationale and `hatch-demo`
for worked examples (presence, forms, uploads, pubsub).

## Publishing

Releases go to [hive](https://github.com/broodlang/hive), the Brood package
registry at <https://brood.fly.dev>.

**One-time setup** — register and mint an API token:

1. Create an account at <https://brood.fly.dev/register>.
2. Mint an API token on your <https://brood.fly.dev/settings> page (it's shown
   once), then expose it to `nest`:

   ```bash
   export HIVE_TOKEN=<your token>
   # or, persistently, add to ~/.config/brood/config.blsp:  :registry-token "<your token>"
   ```

**Each release:**

1. Bump `:version` in `project.blsp` — releases are **immutable**, so a version
   can never be republished.
2. Confirm the tests pass:

   ```bash
   nest test
   ```

3. Publish:

   ```bash
   nest publish
   ```

`nest publish` builds a source tarball (excluding `_deps/`, `tests/`, `.git/`,
and the lock file), records its sha256, and POSTs it to the registry. Only
`:version` (registry) dependencies are recorded — Hatch depends on
[`store`](https://github.com/broodlang/store), which is itself published to the
registry, so a published Hatch resolves cleanly. Docs build automatically and
appear at `https://brood.fly.dev/packages/hatch`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
