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

A live view is a `deflive` module — `mount` builds the model, `handle-info`
folds server messages into it, and `render` returns the markup:

```brood
(deflive
  (mount (params) {:count 0})
  (handle-event ("inc" _ model) (update model :count inc))
  (render (model)
    [:div
      [:button {:phx-click "inc"} "+"]
      [:span (get model :count)]]))
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
