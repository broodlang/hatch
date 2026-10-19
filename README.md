# hatch

**Hatch** is a Phoenix/LiveView-inspired web framework for
[Brood](https://broodlang.org). Pure Brood — no npm, no new Rust. It bundles an
HTTP/1.1 + WebSocket server, a server-rendered component layer (`bml`
templates), CSRF/session/presence/pubsub, and a live view layer whose
server-held state pushes diffs to the browser over a socket.

Alongside the live layer: **channels** ([docs](docs/channels.md)) for clients that
want JSON rather than HTML — one socket, many topics, sharing a namespace with
pubsub so a live view and a channel client hear the same broadcast; **streams**
for collections the server renders without holding, so a long feed costs a
session nothing; **uploads** over the socket, spooled to disk with progress as an
ordinary model key; and a **client** ([docs](docs/client.md)) with hooks for
imperative JavaScript, debounce/throttle, and bindings for any DOM event.

Hatch is a **library package**. The framework lives in `src/` (`http/` +
`web/`); `nest new myapp --template hatch` scaffolds a full app that uses it.

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

Accounts are a module, not generated code (`web/accounts`, modelled on phx.gen.auth):
pbkdf2 passwords, email confirmation and password-reset tokens, scoped API tokens, and
who is signed in on a conn. Hand it the repo once at boot, add its tables to your
schemas, and keep your own pages:

```brood
(web/accounts/configure {:repo db/conn :token-scopes ["api:write"]})
(def schemas [(web/accounts/users-schema) web/accounts/api-tokens-schema
              web/accounts/user-tokens-schema])

(web/accounts/sign-up email password)   ; [:ok user] or [:error message]
(web/accounts/current-user conn)        ; the signed-in user, or nil
```

Markdown someone else wrote goes through `web/markdown/safe-html`, which escapes it and
neutralises executing links (`javascript:` in any case) and marks links leaving the site
`nofollow ugc noopener`.

See `docs/web-framework-design.md` for the design rationale.

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
