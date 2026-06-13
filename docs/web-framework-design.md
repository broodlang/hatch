# Brood Web Framework Design

*A research-and-design document for a Phoenix/LiveView-inspired web framework built on Brood.*

---

## 1. Executive Summary

Five ideas from Phoenix/LiveView are worth stealing wholesale, in order of leverage:

**1. The static/dynamic template split with change-tracking.**
Phoenix.LiveView.Engine compiles HEEx templates at build time into a `Rendered` struct with a fixed `:static` list (never re-sent) and a `:dynamic` function whose outputs map one-to-one with assign dependencies. Only the changed dynamic slots are sent over the wire after the first render. This is the core reason LiveView can sustain 60fps-class interactivity over WebSocket without sending full HTML. Brood can do the same: s-expression templates compile to a parallel structure (static strings interleaved with numbered dynamic slots) and the diff reduces to slot-value comparison.

**2. The process-per-session model.**
Each LiveView connection is an ordinary Erlang process — nothing more. It holds state in its mailbox loop, receives events, calls its render function, diffs, and sends patches. Brood already has this: `proc/gen` actors are a direct match. A LiveBrood session is a `defprocess` whose state is the view model, whose cast messages are client events and PubSub notifications, and whose render function is called after every state transition.

**3. The dual-pass lifecycle (HTTP → WebSocket).**
The first request renders a full static HTML page (no JS dependency, SEO-friendly). The JavaScript client then upgrades the connection to WebSocket and sends a `join` message that re-runs `mount`. Only the dynamic diffs are then sent. This is elegant: HTTP and WebSocket share the same render path; the static HTML embed contains a signed session token that the WebSocket picks up. Brood's HTTP layer can do the same with a single render fn called in two contexts.

**4. The Conn-as-value pipeline.**
Plug's `%Plug.Conn{}` is a plain immutable struct that flows through a chain of transform functions. No global request state, no thread-local storage, no side channels. Every middleware is `fn conn -> conn`. This is a perfect fit for Brood's immutable model. A `web/conn` map and a pipeline of `fn (conn) -> conn` handlers is the entire HTTP layer.

**5. PubSub via named processes.**
Phoenix PubSub manages topic → subscriber sets and broadcasts across cluster nodes using Erlang's `:pg` (process groups). Brood already has named processes, `register`/`whereis`, distributed nodes, and monitor. Building PubSub on top is ~50 lines and fits naturally into the model without a separate library.

---

## 2. Phoenix Internals Deep Dive

### 2.1 Plug.Conn and the pipeline

`Plug.Conn` is a struct with roughly these fields of interest:

- `method` — HTTP verb as an uppercase string (`"GET"`, `"POST"`)
- `host`, `port`, `scheme`
- `path_info` — the path split on `/` as a list of strings
- `query_string`, `query_params` — raw and parsed query
- `req_headers` — list of `{name, value}` tuples
- `params` — merged query + body params (after a parser plug runs)
- `body_params` — just the parsed body
- `req_cookies` / `resp_cookies`
- `resp_headers` — accumulates `{name, value}` tuples
- `status` — integer response status (default `nil`, set by `put_status`)
- `resp_body` — string or iodata
- `assigns` — user-space key-value map for inter-plug communication
- `private` — framework-internal metadata (router info, Phoenix-specific state)
- `halted` — boolean; when `true`, the remaining pipeline is skipped

A **function plug** is any `fn(conn, opts) -> conn`. A **module plug** implements `init/1` (run once at compile time to preprocess options) and `call/2` (run on every request). The `init/1` / `call/2` split means option processing (parsing config, compiling regexes) pays its cost once.

A **pipeline** is a list of plugs applied left-to-right. Each plug receives the conn returned by the previous one. If any plug calls `Plug.Conn.halt/1`, the pipeline stops — the conn is returned with `halted: true` and no subsequent plug fires.

### 2.2 The Endpoint → Router → Controller chain

**Endpoint** is the outermost plug. It applies plugs that run on every request regardless of routing: static file serving, request logging, gzip compression, cookie parsing, session management, CSRF token injection. The Endpoint then delegates to the Router.

**Router** is compiled from route definitions into a pattern-match function. At compile time, `get "/foo/:id", FooController, :show` generates a function clause matching `("GET", ["foo", id], ...)` that captures `id` into params and associates the pipeline and controller action. The router executes the matched pipeline (e.g., the `:browser` pipeline — adding CSRF protection, session fetch, flash), then dispatches to the controller.

**Pipelines** are named groups of plugs defined with `pipeline :name do ... end` and applied with `pipe_through :name` inside a `scope` block. A `:browser` pipeline typically includes `plug :accepts, ["html"]`, `plug :fetch_session`, `plug :protect_from_forgery`, `plug :put_secure_browser_headers`. An `:api` pipeline skips those and adds `plug :accepts, ["json"]`.

**Controllers** are just plugs too. `Phoenix.Controller` provides helpers that write to `conn` — `put_status/2`, `put_resp_content_type/2`, `render/3`, `json/2`, `redirect/2`. All of them transform and return `conn`. `render/3` calls the view layer to produce HTML, assigns it to `conn.resp_body`, and calls `send_resp/1`.

### 2.3 Phoenix Channels

Channels allow multiplexing many logical pub/sub streams over a single WebSocket connection. The key abstraction is the **Socket** (one per WebSocket connection, holding the underlying transport) and **Channel processes** (one per topic join, created lazily).

The wire protocol wraps every message in a `Phoenix.Socket.Message` envelope:
```json
{"topic": "room:lobby", "event": "new_msg", "payload": {"body": "hello"}, "ref": "1"}
```
- `topic` — the channel being addressed
- `event` — the event name (`"phx_join"`, `"phx_leave"`, or user-defined)
- `payload` — arbitrary JSON
- `ref` — optional correlation ID for request-response

When a client joins a topic, a new lightweight Erlang process is created to handle that channel. `join/3` returns `{:ok, socket}` to authorize the join or `{:error, reason}` to reject it. Incoming events from the client route to `handle_in/3`. The server can push to a single client with `push/3`, or `broadcast!/3` to all subscribers of a topic (which routes through PubSub). `handle_out/3` can intercept and filter broadcasts before delivery.

A key optimization: Phoenix Channels "fastlane" messages — the broadcast payload is serialized *once* and the serialized bytes are distributed to all subscriber sockets, avoiding N serialization calls for N subscribers.

**LiveView is not built on Channels directly** — it has its own WebSocket path — but uses the same underlying socket infrastructure. LiveView's WebSocket upgrade happens at a distinct endpoint path (`/live/websocket`) and the client library sends `phx_join` with a signed session token.

### 2.4 Phoenix Router internals

At compile time, each `get/post/etc` macro call accumulates a `%Route{}` into a module attribute. The `__before_compile__` macro then generates:

1. `__match_route__/4` — a series of pattern-match function clauses. Each clause matches `(method, path_segments, host, private)` and returns `{conn_with_params, pipeline_fn, controller_and_action}`.
2. Named path helpers like `user_path/2` — generated from the route's `:as` name.

When the router's `call/2` receives a request, it calls `__match_route__` to find the right pipeline and controller, then passes `conn` through the pipeline closure, then dispatches to the controller's `call/2`.

Nested scopes allow sharing path prefixes and pipeline associations. For example:
```elixir
scope "/api", MyApp do
  pipe_through :api
  resources "/users", UserController
end
```
All routes inside inherit the `/api` prefix and the `:api` pipeline.

---

## 3. LiveView Deep Dive

### 3.1 What problem LiveView solves

The traditional options before LiveView were:
- **Full page renders** — every interaction does an HTTP round trip, re-renders everything, terrible UX.
- **SPA + JSON API** — the server becomes a data API, the client manages state and rendering in JavaScript, complexity explodes, you run two separate systems.
- **HTMX / Turbo** — the server renders HTML fragments and the client swaps DOM nodes. Less JS, but no persistent server-side state across interactions.

LiveView's bet: keep state on the server (in a long-lived process), keep rendering on the server, but maintain a persistent WebSocket so only minimal diffs travel to the client. You write zero client-side JavaScript for the common case. The server is the source of truth; the client is a thin display.

### 3.2 The full lifecycle

**Phase 1: Static HTTP render.**
When a browser requests a LiveView route, the standard Plug pipeline runs. The LiveView controller recognizes the route as a LiveView mount. It calls `mount/3` with `params`, `session`, and a disconnected socket (`connected?` returns `false`). The render function executes and produces a full HTML page. This HTML is sent as an ordinary HTTP response, so non-JS clients and search engines get fully-formed markup.

The rendered HTML contains hidden metadata on the LiveView container element:
- `data-phx-session` — a signed (HMAC-SHA256) token containing the session data and any parameters the LiveView needs
- `data-phx-static` — a hash of the static template parts (used for cache validation on reconnect)
- `data-phx-view` — the module name

Because `connected?` is `false` during HTTP rendering, developers typically skip expensive subscriptions:
```elixir
if connected?(socket), do: PubSub.subscribe(...)
```

**Phase 2: WebSocket join.**
The client JavaScript library (`phoenix_live_view.js`) finds the LiveView container element, extracts `data-phx-session`, and opens a WebSocket to `/live/websocket`. It sends a `phx_join` message with the session token as payload.

The server verifies the session signature, decodes it, and calls `mount/3` again — this time with a *connected* socket. `handle_params/3` runs next to handle URL parameters. The server then renders the view again and sends the rendered output as the initial diff payload in the `phx_reply` message.

**Phase 3: The render/diff cycle.**
When the user clicks a button or submits a form with a `phx-click` or `phx-submit` attribute, the JavaScript client sends a `phx_event` message over the WebSocket:
```json
{"event": "phx_event", "payload": {"type": "click", "event": "increment", "value": {}}}
```

The server routes this to `handle_event("increment", params, socket)`. The handler updates assigns and returns `{:noreply, socket}`. LiveView then calls the render function with the new socket, computes the diff against the previous render, and sends *only the changed dynamic slots* in a `diff` message:
```json
{"diff": {"0": "42"}}
```
where the key is the position of the changed dynamic slot.

The client JavaScript applies the diff by mapping slot positions back to DOM nodes and updating only those nodes using a morphdom-based patcher.

**Phase 4: Server-push via handle_info.**
A LiveView process sits in its mailbox loop. Any Elixir process can send it a message with `send(socket.root_pid, {:some_event, data})`. These arrive in `handle_info/2`, which updates assigns and triggers a diff cycle. This is the mechanism for PubSub-driven updates:
```elixir
def mount(_, _, socket) do
  if connected?(socket), do: PubSub.subscribe(MyApp.PubSub, "updates")
  {:ok, assign(socket, items: [])}
end

def handle_info({:new_item, item}, socket) do
  {:noreply, update(socket, :items, &[item | &1])}
end
```

### 3.3 The rendered struct and change-tracking protocol

This is the most important technical detail for the Brood design.

When HEEx compiles a template like:
```html
<div class="counter">
  <span><%= @count %></span>
  <p><%= @message %></p>
</div>
```

It produces a `%Phoenix.LiveView.Rendered{}` struct:
```
static: ["<div class=\"counter\">\n  <span>", "</span>\n  <p>", "</p>\n</div>"]
dynamic: fn changed ->
  [
    if changed == nil or Map.get(changed, :count), do: @count, else: nil,
    if changed == nil or Map.get(changed, :message), do: @message, else: nil
  ]
end
fingerprint: 123456789   # hash of the static parts
```

Key properties:
- **Static parts never leave the server after the first render.** The client stores them indexed by fingerprint.
- **Dynamic slots return `nil` when unchanged.** The diff algorithm skips `nil` slots — nothing is sent.
- **Fingerprints identify templates.** If a conditional renders a different template on update (e.g., an `:if` goes from `false` to `true`), the fingerprint changes, signaling a full re-render of that subtree.
- **Comprehensions (`:for`) are a separate `Comprehension` struct.** They contain the shared static parts *once*, plus per-entry dynamic functions. When only one item in a list changes, only that item's dynamic slots are sent. When items are added/removed, the diff includes insert/delete operations keyed by the item's DOM id.
- **Change tracking is per-assign.** The `changed` map carries only the assigns that changed in the last transition. If `:count` changed but `:message` did not, only slot 0 is re-evaluated and sent.

**What breaks tracking:**
- Assigning through a local variable inside the template
- Calling arbitrary functions that themselves read assigns
- Passing the full `assigns` map to a component instead of individual keys

This is the core discipline: templates should read assigns directly (`@foo`) and route through `assign/3` / `update/3` rather than doing ad-hoc map operations.

### 3.4 Streams

Streams solve efficient large list handling. Without streams, keeping a list of 10,000 items in assigns means serializing and diffing all 10,000 items on every render. Streams sidestep this by keeping the data off the server entirely after the initial push — the DOM is the only copy.

The server-side API:
- `stream(socket, :items, initial_list)` — initialize, sends all items with DOM ids
- `stream_insert(socket, :items, item)` — add or update one item, sends a single insert operation
- `stream_delete(socket, :items, item)` — remove one item, sends a delete keyed by DOM id

Templates iterate over `@streams.items` which yields `{dom_id, item}` tuples. The container needs `phx-update="stream"`.

The protocol extension adds `insert_at`, `delete` operations to the diff format alongside the standard slot updates. The client's morphdom integration handles them as targeted DOM mutations.

### 3.5 LiveComponents

LiveComponents are stateful sub-views that run inside their parent LiveView process (not separate processes). They have their own state (assigns), their own `mount/1`, `update/2`, and `handle_event/3` callbacks.

Key properties:
- When a LiveComponent's `handle_event` fires, *only that component's diff* is sent to the client — not the parent's diff. This makes components very efficient for isolated interactive widgets.
- `send_update(MyComponent, id: "some-id", new_assign: value)` lets the parent (or any process) push new assigns to a component asynchronously.
- Components have their own fingerprint in the diff tree, so the diffing algorithm treats them as subtrees.

The tradeoff vs. full LiveViews: no separate process means no isolated crash behavior. If the component crashes, it takes the parent LiveView down. For crash isolation you'd use a nested LiveView, but that adds WebSocket overhead.

### 3.6 Navigation: push_patch vs push_navigate

**`push_patch`** — the URL changes (via pushState), `handle_params/3` runs with the new params, but `mount/3` does *not* re-run. The LiveView stays alive; state is preserved. Use for internal navigation like pagination, sorting, or tabs that change the URL.

**`push_navigate`** — the LiveView process is torn down and a new one is mounted. This crosses a `live_session` boundary if needed. The transition triggers a client-side navigation that remounts the target LiveView.

**live_session** — a named group of LiveViews that share session context. Navigating within a `live_session` is efficient (no full page reload). Navigating *across* live_sessions forces a full HTTP request (because the session or layout may differ).

### 3.7 JS interop and client-side commands

**Hooks** attach custom JavaScript to individual DOM elements via `phx-hook="HookName"`. Lifecycle callbacks: `mounted`, `updated`, `beforeUpdate`, `destroyed`, `disconnected`, `reconnected`. Within a hook, `this.el` is the DOM node, `this.pushEvent(name, payload)` sends to the server, `this.handleEvent(name, fn)` receives server pushes.

**JS commands** are a pure client-side operation builder. `JS.push("event")`, `JS.toggle(el)`, `JS.add_class("loading", to: el)` compose into a client-executed command list attached to DOM event attributes. They run immediately without a server round-trip, enabling optimistic UI. For example, disabling a button on click before the server confirms:
```html
<button phx-click={JS.add_class("opacity-50") |> JS.push("submit")}>Save</button>
```
The `add_class` fires instantly; `push` sends the event. When the server responds and re-renders, the server's diff replaces the button state.

**Loading classes** are applied automatically: any element with a `phx-*` binding gets a `phx-*-loading` CSS class applied from the moment the event fires until the server acknowledges it. No explicit setup required.

### 3.8 Session and security model

**Session flow:**
1. HTTP request hits the router, passes through plugs that include session fetch and CSRF protection.
2. Authentication plugs (often via `on_mount` hooks) verify the session cookie and assign the current user.
3. The LiveView renders; the session data is signed into `data-phx-session`.
4. WebSocket joins with this token; the server verifies the signature and decodes the session.
5. `mount/3` receives the decoded session and must re-verify authentication — the plug pipeline does *not* run on the WebSocket path.

**CSRF:** The CSRF token is embedded in the page metadata and sent as a parameter in the WebSocket join message. The server verifies it before accepting the connection.

**live_session** adds `on_mount` hooks that run on every LiveView mount in the group, providing a centralized place to enforce authentication for a group of routes.

**Event authorization:** Every `handle_event` must independently verify that the current user is allowed to perform the action. The UI may hide buttons, but the WebSocket is accessible to anyone with a valid session.

**Reconnection:** On disconnect (deployment, network blip), the client retries with exponential backoff. On reconnect, `mount/3` runs again from scratch. The socket's assigns are rebuilt fresh. If you need to preserve client-side form state across reconnect, Phoenix provides `phx-auto-recover` for form inputs.

### 3.9 PubSub internals

`Phoenix.PubSub` is a standalone library with a pluggable adapter. The default adapter uses Erlang's `:pg` (process groups), which provides a distributed, in-memory group registry across all BEAM nodes in the cluster.

Local dispatch works through a shard pool: subscriptions are hashed to a shard process that maintains a local ETS table of `topic -> [pid, ...]` mappings. A `broadcast/3` call hashes the topic to the shard, looks up local subscribers, delivers locally, then forwards to remote nodes' PubSub servers via normal Erlang distribution.

A critical optimization: **fastlaning**. When a message is broadcast to many subscribers, it is serialized *once* to JSON/binary. Each subscriber process receives a pointer to the pre-serialized bytes, not a separate copy. This allows Phoenix to sustain millions of connected clients on modest hardware.

LiveView subscribes to PubSub topics inside `mount/3` (only when `connected?` is true). Incoming broadcasts arrive as ordinary messages in the LiveView process's mailbox and are handled by `handle_info/2`. The subscription is automatically cleaned up when the LiveView process terminates.

---

## 4. HTMX / Hotwire / Others

### 4.1 HTMX

HTMX extends HTML with `hx-*` attributes: `hx-get="/search"`, `hx-post="/add"`, `hx-trigger="keyup delay:300ms"`, `hx-target="#results"`, `hx-swap="innerHTML"`. An HTTP request fires on the trigger, the response is HTML, and the target element is swapped.

**What makes it compelling:**
- Zero JavaScript for common patterns. The HTML is the entire program.
- Backend-agnostic — any server that returns HTML fragments works.
- Progressive enhancement — the page works without JS, HTMX enhances it.
- `hx-boost` opts elements into HTMX's fetch-and-swap without full page reload.
- Server-Sent Events support for server push without WebSocket complexity.

**The insight for Brood:** HTMX's attribute-first design means the template is the contract. You don't need a special `phx-click="..."` naming scheme if you can make the HTML attributes drive everything. The `hx-trigger` concept (debouncing, throttling, intersection observer) is worth stealing — especially `hx-trigger="intersect"` for infinite scroll.

### 4.2 Hotwire / Turbo

Turbo has three parts:
- **Turbo Drive** — automatically intercepts link clicks and form submissions, fetches the new page as HTML, and replaces only the `<body>` (or a specific `<turbo-frame>`). Works with zero developer effort once included.
- **Turbo Frames** — `<turbo-frame id="chat">` marks a region; links inside a frame update only that frame. Enables lazy loading and independent page regions.
- **Turbo Streams** — the server sends `<turbo-stream action="append" target="messages">` HTML elements (over WebSocket or SSE) that perform targeted DOM mutations: append, prepend, replace, update, remove, morph. Nine actions, no JS.

**The insight for Brood:** Turbo Streams show that a small vocabulary of DOM operations (append/prepend/replace/remove + morph) covers most real-world cases. You don't need an arbitrary diff algorithm if you expose the operations explicitly. This is worth considering as an alternative to LiveView's transparent diffing — a "Turbo Streams mode" where the developer names the operation.

**Stimulus** (Hotwire's JS layer) adds behavior to server-rendered HTML via `data-controller`, `data-action`, `data-target` attributes. Controllers are small JS classes. This is the Rails answer to "how do you add interactivity without a full SPA?" It's explicitly an escape hatch, not the primary model.

### 4.3 Lustre (Gleam)

Lustre is a Gleam framework implementing TEA: `init` (initial model + effects), `update(msg, model) -> (model, effects)`, `view(model) -> Element(Msg)`. It compiles to both JavaScript (browser SPA) and BEAM (server component).

**The key innovation:** the same component code runs on browser or server without modification. A server component is essentially an actor: it receives messages, updates model, renders a virtual DOM tree. Changes are diffed and sent to the browser as minimal patches.

This is very close to what Brood already has with `ui-run` for TUI apps — the `view`/`update` cycle is identical. The jump to web would be: the frontend is a browser instead of a terminal, the render protocol is HTML diff over WebSocket instead of ANSI sequences over stdout.

Lustre's effect system is worth studying: effects are values (not side effects), returned from `update`, executed by the runtime. This keeps `update` pure and testable. For Brood, effects could be modeled as tagged vectors: `[:subscribe "topic"]`, `[:push-event "name" data]`, `[:navigate "/path"]`.

### 4.4 Livewire (Laravel/PHP)

Unlike LiveView, Livewire is **stateless** per request. There is no long-running process. Each interaction is a fresh HTTP request; the component's PHP class properties are serialized to a signed JSON payload and sent to the client, then deserialized on the next request.

`wire:model="name"` two-way binds an input to a PHP class property. On blur (or `wire:model.live` for real-time), a request fires, the property updates, and the response is a diff of the re-rendered component.

**The insight for Brood:** Livewire demonstrates that a stateful-looking UI can be built on stateless infrastructure (each request is independent). The tradeoff is that you can't maintain in-memory state between requests (no PubSub subscriptions, no long-running computations). For Brood, this is worse — processes are cheap and the actor model is the right primitive. But Livewire's `wire:model` two-way binding syntax is clean and worth considering.

### 4.5 Blazor Server

Microsoft's Blazor Server uses SignalR (WebSocket with long-polling fallback) for a full render tree diff. The component model is C# classes with a Razor template. On state change, .NET re-renders the component tree to an in-memory DOM representation, diffs it against the previous render, and sends an encoded diff over SignalR.

**What's different vs. LiveView:** Blazor diffs a full component tree (like React's VDOM), not a pre-split static/dynamic template. This means every state change re-renders and diffs everything, which is more expensive but more general. LiveView's static/dynamic split is a compile-time optimization that Blazor doesn't have.

**The insight:** Blazor's component tree diffing is expensive at scale. LiveView's approach of tracking which assigns changed and only re-evaluating dependent slots is significantly more efficient. Brood should follow LiveView's model, not Blazor's.

### 4.6 SolidJS fine-grained reactivity

SolidJS compiles JSX to DOM operations directly — no virtual DOM. Signals (`createSignal`) are reactive primitives; `createEffect` tracks which signals it reads and re-runs only when those signals change. A component function runs *once*; subsequent updates happen at the granularity of individual DOM attributes, not entire component trees.

**The insight for a server-rendered framework:** SolidJS's dependency graph at compile time is the client analog of LiveView's static/dynamic split. Both systems precompute "what changes when X changes" — SolidJS does it for client signals, LiveView does it for server assigns. The principle is the same: eliminate unnecessary work by making dependencies explicit at compile time. For Brood, the template compiler should track assign dependencies per dynamic slot, exactly as LiveView does.

### 4.7 Fresh (Deno) island architecture

Fresh renders pages server-side on every request (no SPA). JavaScript is only shipped for "islands" — components explicitly opted into client interactivity. Everything else is plain HTML with zero JS.

**The insight:** Islands are a pragmatic answer to "what if most of your page is static?" For a Brood web framework, a similar concept would be: most routes are plain `conn -> conn` handlers returning static HTML; a `live` route upgrades to the LiveBrood actor model. You only pay for the process overhead where you actually need interactivity.

---

## 5. Brood Web Framework Design

The framework has four layers:
1. **`web/http`** — the Conn pipeline: TCP/HTTP1.1, request parsing, response encoding
2. **`web/router`** — pattern-matched route dispatch, pipeline composition
3. **`web/live`** — LiveBrood: the actor-per-session real-time layer
4. **`web/pubsub`** — topic-based broadcast built on Brood's process model

The template layer is part of `web/live` but can be used standalone for static rendering.

The framework ships as a `nest` project template: `nest new myapp --template http-server` scaffolds a working web app with a `web/` directory, `project.blsp` dependencies, and an example route.

### 5.1 HTTP layer — Conn, Router, Middleware

#### The Conn

A `conn` is an immutable map. Every field is a plain Brood value:

```
{:method    "GET"
 :path      ["users" "42" "profile"]   ; split on "/"
 :query     {:page "2"}                ; parsed query string
 :headers   {:content-type "text/html" :accept "application/json"}
 :body      nil                        ; raw request body string, nil until read
 :params    {}                         ; merged after parsing (body + query)
 :cookies   {}
 :assigns   {}                         ; user-space inter-handler data
 :session   {}                         ; decoded from signed cookie
 :status    200
 :resp-body ""
 :resp-headers {:content-type "text/html; charset=utf-8"}
 :halted    false
 :private   {}}                        ; framework-internal metadata
```

Every middleware (handler plug) is `fn (conn) -> conn`. The framework provides combinators:

```lisp
(defn halt (conn) (assoc conn :halted true))
(defn put-status (conn status) (assoc conn :status status))
(defn put-resp-header (conn k v) (assoc-in conn [:resp-headers k] v))
(defn assign (conn k v) (assoc-in conn [:assigns k] v))
(defn send-resp (conn status body)
  (assoc conn :status status :resp-body body :halted true))
(defn redirect (conn url &optional (status 302))
  (send-resp (put-resp-header conn :location url) status ""))
```

A pipeline is just a list of handler functions threaded with `->`:

```lisp
(defn my-pipeline (conn)
  (-> conn
    fetch-session
    verify-csrf
    authenticate-user))
```

Or composed at definition time:

```lisp
(def browser-pipeline (pipeline fetch-session verify-csrf put-secure-headers))
```

where `pipeline` is a macro that composes the functions:

```lisp
(defmacro pipeline (& fns)
  `(fn (conn) (-> conn ~@fns)))
```

Halting is respected by the `->` macro variant we provide, `->halt`:

```lisp
(defmacro ->halt (val & forms)
  ;; threads val through forms, short-circuiting when :halted is true
  ...)
```

#### The TCP/HTTP server

The framework is pure Brood — no new Rust code. The lowest layer calls whatever TCP socket primitives Brood's stdlib exposes (e.g., `(tcp-listen port)`, `(tcp-accept listener)`, `(tcp-read conn n)`, `(tcp-write conn bytes)`). If those don't exist yet, adding them to Brood's stdlib is a prerequisite — that's a Brood stdlib task, not a framework task.

On top of those primitives the framework implements HTTP/1.1 in Brood: a listener loop spawns one worker process per accepted connection, the worker reads bytes and parses the request line + headers using string operations, then calls the application handler. The returned `conn` map is serialized back into HTTP response bytes and written to the socket. Worker crashes are isolated — the listener process is unaffected.

```lisp
(defn http-serve (port router)
  "Start an HTTP server on `port`, dispatching requests to `router`."
  (let (listener (tcp-listen port))
    (spawn :http-listener (accept-loop listener router))))

(defn accept-loop (listener router)
  (let (sock (tcp-accept listener))
    (spawn (handle-connection sock router))
    (accept-loop listener router)))

(defn handle-connection (sock router)
  (let (req  (parse-http-request sock)
        conn (request->conn req)
        conn (router conn))
    (write-http-response sock conn)
    (when (keep-alive? req conn) (handle-connection sock router))))
```

TLS is handled at the infrastructure layer (reverse proxy: nginx, Caddy, fly.io's load balancer) — not by the framework. This is standard practice: terminate TLS at the edge, run the app on plain TCP behind it.

For WebSocket upgrade, the connection worker detects the `Upgrade: websocket` header, completes the RFC 6455 handshake (one SHA-1 + base64 operation), and enters the WebSocket frame loop — also implemented in Brood on top of the same raw TCP read/write primitives.

#### Request body parsing

Body parsing is a middleware that reads the raw body bytes from the connection handle and decodes them based on `Content-Type`. Provided parsers: `parse-json-body`, `parse-form-body`, `parse-multipart-body`. Each returns a conn with `:body-params` and `:params` populated.

```lisp
(defn parse-body (conn)
  (let (ct (get-in conn [:headers :content-type]))
    (cond
      (starts-with? ct "application/json")                  (parse-json-body conn)
      (starts-with? ct "application/x-www-form-urlencoded") (parse-form-body conn)
      (starts-with? ct "multipart/form-data")               (parse-multipart-body conn)
      else conn)))
```

#### The Router

Routes are defined with macros that accumulate into a module-level route table, compiled to a pattern-match dispatch function.

```lisp
(defmodule my-router "Application router."
  (:use web/router))

(pipeline :browser
  parse-body
  fetch-session
  verify-csrf
  put-secure-headers)

(pipeline :api
  parse-body
  accept-json)

(scope "/api" :api
  (get "/users"      users/index)
  (get "/users/:id"  users/show)
  (post "/users"     users/create))

(scope "/" :browser
  (get  "/"          pages/home)
  (get  "/login"     auth/login-form)
  (post "/login"     auth/login)
  (live "/dashboard" dashboard/live))  ; live route — upgrades to LiveBrood
```

At compile time, `defroute` (what `get`/`post`/`live` lower to) adds an entry to a module attribute. The `__compile-routes__` macro generates a `dispatch` function:

```lisp
(defn dispatch (conn)
  (match [(get conn :method) (get conn :path)]
    (["GET"  ["api" "users"]]          (run-pipeline :api conn users/index))
    (["GET"  ["api" "users" id]]       (run-pipeline :api (assoc-in conn [:params :id] id) users/show))
    (["POST" ["api" "users"]]          (run-pipeline :api conn users/create))
    (["GET"  []]                       (run-pipeline :browser conn pages/home))
    (["GET"  ["live" "dashboard"]]     (run-pipeline :browser conn dashboard/live--upgrade))
    (_                                 (send-resp conn 404 "Not Found"))))
```

Path parameters are captured directly in the pattern match and merged into `:params`.

Named routes for URL generation:

```lisp
(path-for :users-show {:id 42})  ; => "/api/users/42"
```

The router macro records route names and their parameter shapes at compile time to generate these helpers.

#### Controllers / Handlers

A handler is any `fn (conn) -> conn`:

```lisp
(defmodule users "User resource handlers."
  (:use web/conn)
  (:use web/template))

(defn index (conn)
  (let (users (db/all-users))
    (render conn "users/index" {:users users})))

(defn show (conn)
  (let (id (get-in conn [:params :id])
        user (db/find-user id))
    (if user
      (render conn "users/show" {:user user})
      (send-resp conn 404 "User not found"))))

(defn create (conn)
  (let (params (get conn :params)
        result (db/create-user params))
    (match result
      ([:ok user]    (redirect conn (path-for :users-show {:id (get user :id)})))
      ([:error errs] (render conn "users/new" {:errors errs :params params})))))
```

### 5.2 Templating — Hiccup-style s-expression HTML

Brood is a Lisp. The natural representation of HTML in a Lisp is Hiccup-style vectors:

```lisp
[:div {:class "container" :id "main"}
  [:h1 {} "Hello, " name]
  [:ul {:class "items"}
    (map (fn (item)
           [:li {:key (get item :id)} (get item :name)])
         items)]]
```

The format: `[tag-keyword attrs-map & children]`. Children can be strings, numbers, nested vectors, `nil` (ignored), or lists of any of these. This is similar to Clojure's Hiccup library but idiomatic to Brood (vectors, not lists, for data).

#### Rendering to HTML string

For static rendering, the template walks the tree and produces an HTML string:

```lisp
(defn render-to-html (node)
  (match node
    (nil           "")
    (s :when (string? s) (escape-html s))
    (n :when (int? n)    (number->string n))
    ([tag attrs & children]
     (str "<" (name tag) " " (render-attrs attrs) ">"
          (join "" (map render-to-html (flatten children)))
          "</" (name tag) ">"))))
```

Self-closing tags (`[:input {:type "text"}]`), raw HTML escape bypass (`(raw "<b>bold</b>"`).

#### The static/dynamic split for LiveBrood

For live templates, we need the same optimization as LiveView's `Rendered` struct. The trick: at compile time, a macro-based template compiler separates the template into:
- **Static segments** — literal strings between dynamic holes
- **Dynamic slots** — expressions that depend on the model, annotated with which model keys they read

This requires the template to be written with a macro, not as a plain data expression evaluated at runtime.

The `deflive-template` macro (or more ergonomically, `defrenders` inside a `deflive` block) transforms the template at compile time:

```lisp
(deflive-template view (model)
  [:div {:class "counter"}
    [:span {} (get model :count)]          ; slot 0 — depends on :count
    [:p {} (get model :message)]])         ; slot 1 — depends on :message
```

Compiles to approximately:

```lisp
(defn view (model)
  {:static     ["<div class=\"counter\"><span>" "</span><p>" "</p></div>"]
   :dynamic    (fn (changed)
                  [(if (or (nil? changed) (contains? changed :count))
                     (render-to-html (get model :count)) nil)
                   (if (or (nil? changed) (contains? changed :message))
                     (render-to-html (get model :message)) nil)])
   :fingerprint 987654321})
```

This is the key architectural decision: the template compiler, not the runtime, does the work of tracking which model keys map to which dynamic slots.

**Dependency annotation:** The compiler must know which model keys each dynamic slot reads. Two approaches:

1. **Explicit annotation** — the developer annotates: `[:span {} (slot :count (get model :count))]`. Simple to implement, ergonomic enough.
2. **Static analysis** — the macro expands `(get model :count)` and sees that `model` is the template parameter and `:count` is a key literal. This works for direct `get` calls and `get-in` with literal paths, but not for computed paths or helper functions that internally read the model.

The pragmatic choice: start with explicit `slot` annotation, add static analysis for `(get model :key)` patterns. Document the limitation that computed-key reads force the whole template to re-evaluate.

**Comprehension optimization:** For lists:

```lisp
[:ul {}
  (for (item (get model :items))
    [:li {:key (get item :id)} (get item :name)])]
```

The compiler recognizes the `for` form and generates a `Comprehension` struct: the static parts `["<ul>", "<li>", "</li>", "</ul>"]` are shared, and each item generates only its `name` dynamic slot. When items are appended, only new item diffs are sent.

#### Layout system

A layout wraps the rendered content:

```lisp
(deflive-layout app-layout (content)
  [:html {}
    [:head {} [:title {} "My App"]]
    [:body {}
      [:nav {} (nav-bar)]
      [:main {} content]]])
```

The layout itself is static (its only dynamic slot is `content`), so it's rendered once on initial mount and the content slot is updated independently.

### 5.3 LiveBrood — the LiveView equivalent

#### Core concept

Each browser tab that navigates to a live route gets its own Brood process. This process holds the view model in its receive loop, handles events, calls the render function, diffs, and sends patches over WebSocket.

The model maps directly to Phoenix LiveView:

| Phoenix LiveView | LiveBrood |
|---|---|
| `mount/3` | initial state setup in `spawn-live-session` |
| `socket.assigns` | the process's model map |
| `handle_event/3` | `cast` clauses in `defprocess` |
| `handle_info/2` | arbitrary `receive` clauses |
| `render/1` | a pure `view fn(model) -> template` |
| `push_patch` | `[:navigate path]` effect |
| `send_update` | `send pid [:update-component id assigns]` |

#### The `deflive` macro

```lisp
(defmodule dashboard "Live dashboard view."
  (:use web/live)
  (:use web/pubsub))

(deflive dashboard
  ;; Initial state — runs on both HTTP and WebSocket phases
  ;; Receives: params (map), session (map), connected? (bool)
  (mount (params session connected?)
    (let (model {:count 0 :items [] :user (get session :user-id)})
      (when connected?
        (subscribe "events"))
      model))

  ;; Pure render function — called after every state change
  (render (model)
    [:div {:class "dashboard"}
      [:h1 {} "Dashboard"]
      (slot :count [:span {} "Count: " (get model :count)])
      (slot :items
        [:ul {}
          (for (item (get model :items))
            [:li {:key (get item :id)} (get item :name)])])])

  ;; Event handlers — client-triggered
  (on "increment" (params model)
    (assoc model :count (inc (get model :count))))

  (on "add-item" (params model)
    (let (item {:id (now) :name (get params :name)})
      (update model :items (fn (xs) (cons item xs)))))

  ;; Message handlers — server-pushed
  (on-message [:event data] (model)
    (update model :items (fn (xs) (cons data xs))))

  ;; URL navigation within this live view (no remount)
  (on-params (params model)
    (assoc model :page (get params :page "1"))))
```

`deflive` expands to a `defprocess` actor:

```lisp
(defprocess dashboard--session (state)
  ;; state = {:model model :conn ws-conn :last-rendered rendered-struct}
  (cast [:event params]
    (let (new-model (dashboard--on-event params (get state :model))
          diff      (diff-render (dashboard/render new-model) (get state :last-rendered)))
      (send-ws (get state :conn) [:diff diff])
      (assoc state :model new-model :last-rendered (dashboard/render new-model))))

  (cast [:message msg]
    (let (new-model (dashboard--on-message msg (get state :model))
          diff      (diff-render (dashboard/render new-model) (get state :last-rendered)))
      (send-ws (get state :conn) [:diff diff])
      (assoc state :model new-model)))

  (call :get-model
    [(get state :model) state]))
```

#### The lifecycle in detail

**Phase 1: HTTP render (initial page load)**

The router matches a `live` route and calls `live--upgrade`:

```lisp
(defn live--upgrade (conn module)
  ;; 1. Call mount with connected? = false
  (let (model  (call-mount module (get conn :params) (get conn :session) false)
        rendered (call-render module model)
        html     (render-full-page rendered (get conn :session)))
    ;; 2. Embed signed session token in the HTML
    (let (token (sign-session (get conn :session) (get conn :params)))
      (send-resp conn 200 (embed-lv-metadata html token module)))))
```

The signed session token prevents replay attacks. The signature covers: session data, the module name, a nonce, and a server-side secret.

**Phase 2: WebSocket join**

The HTTP server detects `Upgrade: websocket` and performs the handshake. The WebSocket worker sends the socket handle to the `web/live` supervisor, which:

1. Reads the `phx_join` message containing the session token
2. Verifies the signature
3. Decodes the session
4. Calls `mount` again with `connected? = true` — this is where PubSub subscriptions happen
5. Calls `render` to get the initial rendered struct
6. Sends the full `phx_reply` with the rendered output

```lisp
(defn handle-join (ws-conn session-token)
  (let (session  (verify-and-decode-token session-token)
        module   (get session :live-module)
        model    (call-mount module (get session :params) session true)
        rendered (call-render module model))
    ;; 3. Spawn the session actor
    (let (pid (spawn-server dashboard--session
                {:model    model
                 :conn     ws-conn
                 :rendered rendered
                 :session  session}))
      ;; 4. Send initial render
      (send-ws ws-conn [:phx-reply (rendered->wire rendered)])
      pid)))
```

**Phase 3: Event loop**

Each client event arrives as a WebSocket message. The session actor's mailbox receives it, calls the appropriate `on` handler (which returns a new model), diffs against the last rendered struct, and sends the diff:

```lisp
(defn diff-and-send (state event-result)
  (let (new-model   event-result
        new-rendered (call-render (get state :module) new-model)
        diff         (compute-diff (get state :rendered) new-rendered))
    (when (not (empty? diff))
      (send-ws (get state :conn) [:diff diff]))
    (assoc state :model new-model :rendered new-rendered)))
```

The diff protocol (wire format) is a map of slot positions to new values:

```json
{"0": "43", "1": null}
```

`null` means "no change, skip". The client applies: for each non-null slot, update the corresponding DOM node.

**Phase 4: Server-push**

PubSub messages arrive in the session process's mailbox. The `on-message` handler (from `deflive`) processes them just like client events — returns a new model, triggers diff and send.

```lisp
;; In the deflive expansion, subscriptions registered in mount
;; send messages directly to this pid via PubSub's dispatch
(receive
  ([:pubsub-message topic msg]
   (diff-and-send state (on-message msg (get state :model)))))
```

#### Effects system

Some operations can't be expressed as pure model transforms: subscribing to PubSub, navigating the URL, pushing non-diff events to the client. These are modeled as **effects** — values returned alongside the model.

`on` handlers can return either a plain model or `[model effects]`:

```lisp
(on "search" (params model)
  [(assoc model :query (get params :query))
   [[:navigate (str "/search?q=" (get params :query))]
    [:push-event "analytics" {:event "search" :query (get params :query)}]]])
```

The session actor checks whether the return is a plain model or a `[model effects]` pair, processes the effects before or after the diff send:

```lisp
(defn process-return (state result)
  (match result
    ([new-model effects]
     (let (s (diff-and-send state new-model))
       (fold process-effect s effects)))
    (new-model
     (diff-and-send state new-model))))

(defn process-effect (state effect)
  (match effect
    ([:navigate path]
     (send-ws (get state :conn) [:navigate path])
     state)
    ([:push-event name data]
     (send-ws (get state :conn) [:push-event name data])
     state)
    ([:subscribe topic]
     (pubsub/subscribe topic (self))
     state)))
```

#### LiveComponents — scoped sub-views

A `deflive-component` is a sub-view that runs inside the parent session process (no separate process). It has its own model slice, render function, and event handlers.

```lisp
(deflive-component counter-widget
  (render (model)
    [:div {:class "counter"}
      [:button {:phx-click "dec"} "-"]
      [:span {} (get model :count)]
      [:button {:phx-click "inc"} "+"]])

  (on "inc" (params model) (update model :count inc))
  (on "dec" (params model) (update model :count dec)))
```

In the parent template:
```lisp
[:div {}
  (live-component counter-widget {:id "my-counter" :count (get model :widget-count)})]
```

The component gets its own slot in the parent's rendered struct. Events targeted at the component (via `phx-target` in the DOM) route to the component's handler. Only the component's diff is sent on component-scoped events — the parent is unaffected.

#### Reconnection

On WebSocket disconnect, the client retries with exponential backoff (2s, 5s, 10s, ...). On reconnect, the server:
1. Verifies the session token again (it's still valid unless it expired)
2. Calls `mount` again — full restart
3. Sends the initial render again

The session process from the previous connection is garbage collected when the old WebSocket closes. There is no state recovery across reconnection — `mount` starts fresh. This is the correct default: the server is the source of truth, and the URL carries the state needed to reconstruct it.

If `mount` needs to recover form state (e.g., a partially filled form the user was editing), the client can send the form state as parameters in the reconnect join message (the `phx-auto-recover` equivalent).

#### JS hooks (escape hatch)

For client-side behavior that can't be expressed in the template (chart libraries, native browser APIs, focus management):

```lisp
;; In the template
[:div {:phx-hook "Chart" :id "my-chart"} ""]
```

In JavaScript (`app.js`):
```javascript
let Hooks = {}
Hooks.Chart = {
  mounted() {
    this.chart = new Chart(this.el, {data: this.el.dataset.chartData})
  },
  updated() {
    this.chart.update(JSON.parse(this.el.dataset.chartData))
  }
}
let liveSocket = new LiveSocket("/live", Socket, {hooks: Hooks})
```

The server can push data to the hook via `push-client-event`:

```lisp
(on "update-chart" (params model)
  [model [[:push-client-event "chart-data-updated" (get model :chart-data)]]])
```

The hook handles it: `this.handleEvent("chart-data-updated", data => this.chart.update(data))`.

### 5.8 JavaScript client and wire protocol

The framework ships a single small JS file (`brood_live.js`, ~600 lines target) with no npm dependencies. It is copied into `public/js/` by `nest new`. Ideas are freely taken from `phoenix.js` and `phoenix_live_view.js` but the code is original — no fork, no import.

#### Wire protocol

All messages are JSON. Each message is a JSON object with a `t` (type) field.

**Client → Server:**

```json
{"t": "join",    "token": "<signed-session-token>", "csrf": "<csrf-token>", "url": "/current/url"}
{"t": "event",   "ref": "3", "name": "increment", "value": {}}
{"t": "params",  "ref": "4", "params": {"page": "2"}, "url": "/search?page=2"}
{"t": "hb"}
```

- `ref` is a monotonically incrementing integer (string) used to correlate server replies.
- `hb` (heartbeat) is sent every 30 seconds; the server replies `{"t": "hb"}`. Three missed replies → reconnect.

**Server → Client:**

```json
{"t": "joined",  "ref": null, "diff": {"s": ["<div>","</div>"], "d": {"0": "42"}, "fp": 123456}}
{"t": "diff",    "ref": "3",  "d": {"0": "43"}}
{"t": "navigate","url": "/new/path", "kind": "patch"}
{"t": "redirect","url": "/login"}
{"t": "push",    "name": "chart-updated", "payload": {"data": [1,2,3]}}
{"t": "hb"}
```

**Diff format** (the `d` object):
- Keys are decimal string integers — the dynamic slot index.
- Values are the new HTML string for that slot, or `null` (no change, skip).
- On the `joined` message only, `s` carries the static segment array (strings between slots) and `fp` the fingerprint. The client stores `{fp → static_segments}` in a local map. Subsequent `diff` messages carry only `d` — no `s` repeat.
- For comprehensions (lists with `:key`): the diff uses special values `{"ins": [{...}], "del": ["key1"]}` to add/remove items without replacing the whole list.

**Fingerprint caching:** if the client already has the static segments for a given `fp`, the `joined` message can omit `s` entirely — the server checks the `static-fp` query param the client sends in the WebSocket URL on reconnect.

#### DOM patching

The client maps slot indices back to DOM nodes using `data-slot` attributes emitted by the server-side renderer:

```html
<div class="counter"><span data-slot="0">42</span><p data-slot="1">hello</p></div>
```

Applying a diff is:
```javascript
for (const [slot, html] of Object.entries(diff.d)) {
  if (html === null) continue
  const el = document.querySelector(`[data-slot="${slot}"]`)
  if (el) morphdom(el, html)  // or el.innerHTML for leaf nodes
}
```

For leaf-text nodes (slots whose entire content is text or a number), a direct `textContent` assignment is cheaper than morphdom. The server annotates these with `data-slot-text="0"` so the client can skip morphdom entirely.

For comprehension containers (`data-slot-list="2"`), inserts become `insertAdjacentHTML` calls (keyed by `data-key`) and deletes become `el.querySelector('[data-key="..."]').remove()`.

The framework does **not** ship morphdom as a dependency. For element-level patching (not just text), it ships a ~80-line minimal morpher that handles attribute diffs and child node reconciliation for the cases the framework actually generates. Full morphdom is overkill for diffs that are already minimized server-side.

#### Event binding

The client adds a single delegated listener on `document` for `click`, `input`, `change`, `submit`, `focus`, `blur`. On each event it walks up from `event.target` looking for `live-*` attributes:

```
live-click="event-name"       → send {"t":"event","name":"event-name","value":{}}
live-change="event-name"      → send on input with current input value
live-submit="event-name"      → send with FormData serialized to object; preventDefault
live-keydown="event-name"     → send with {key, keyCode}
live-blur="event-name"
live-focus="event-name"
```

The event value payload is always a plain JSON object. For forms, it's the full serialized form state. For clicks, it's the `phx-value-*` equivalent — any `live-value-*` data attributes on the element:

```html
<button live-click="delete" live-value-id="42">Delete</button>
<!-- sends {"t":"event","name":"delete","value":{"id":"42"}} -->
```

#### Loading states

When an event is sent and no reply has arrived yet, the client:
1. Adds `live-loading` CSS class to the element that triggered the event.
2. Adds `live-loading` to any element with `live-loading-target="event-name"`.
3. Removes both classes when the `diff` or error arrives for that `ref`.

No special attribute required — loading state is automatic.

#### Reconnection

On WebSocket close or error, the client enters exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (cap). On each attempt it reconnects, re-sends `join` with the current `data-live-session` token (re-read from the DOM in case a redirect wrote a new one), and the `static-fp` cache hint. The server replies with `joined`; the client applies the diff from that fresh mount. If the session token has expired, the server sends `redirect`.

During disconnection a `live-disconnected` class is added to the live container. On reconnect it's removed and a `live-reconnected` class is added for 1s (for CSS transition hooks).

#### JS hooks

Elements with `live-hook="HookName"` get lifecycle callbacks:

```javascript
const hooks = {
  Chart: {
    mounted()      { this.chart = new Chart(this.el, {}) },
    updated()      { this.chart.update() },
    beforeUpdate() {},
    destroyed()    { this.chart.destroy() },
  }
}

BroodLive.start({ hooks })
```

`this.el` — the DOM element. `this.pushEvent(name, payload)` — sends `{"t":"event","name":name,"value":payload}`. `this.handleEvent(name, fn)` — registers a handler for `{"t":"push","name":name}` messages targeted at this hook (matched by element id).

#### Full initialization

```javascript
import BroodLive from "/js/brood_live.js"

BroodLive.start({
  endpoint: "/live/websocket",  // default
  hooks: {},                    // optional
  params: {},                   // extra params merged into join payload
})
```

That's the entire public API. No socket object to manage, no channel to join manually — `start()` finds all `[data-live-session]` elements on the page and connects them.

---

### 5.4 PubSub

Brood already has everything needed: named processes, `register`/`whereis`, `send`, distributed nodes. PubSub is a thin layer on top.

#### Implementation

A PubSub server is a `defprocess` that maintains a map of `topic -> [pid, ...]`:

```lisp
(defmodule web/pubsub "Topic-based broadcast over Brood processes."
  (:use proc/gen))

(defprocess pubsub-server (topics)
  ;; topics = {:some-topic [pid1 pid2 ...]}

  (cast [:subscribe topic pid]
    (let (subs (get topics topic []))
      (monitor pid)  ; detect subscriber death
      (assoc topics topic (cons pid subs))))

  (cast [:unsubscribe topic pid]
    (let (subs (filter (fn (p) (not (= p pid))) (get topics topic [])))
      (assoc topics topic subs)))

  (cast [:broadcast topic msg]
    (doseq (pid (get topics topic []))
      (send pid [:pubsub-message topic msg]))
    topics)

  (cast [:down ref pid reason]
    ;; subscriber died — remove from all topics
    (fold (fn (acc-topics topic-name)
            (let (subs (filter (fn (p) (not (= p pid))) (get acc-topics topic-name [])))
              (assoc acc-topics topic-name subs)))
          topics (keys topics))))
```

Public API:

```lisp
(defn subscribe (topic)
  "Subscribe the calling process to `topic`."
  (! (whereis :pubsub) [:subscribe topic (self)]))

(defn unsubscribe (topic)
  "Unsubscribe the calling process from `topic`."
  (! (whereis :pubsub) [:unsubscribe topic (self)]))

(defn broadcast (topic msg)
  "Broadcast `msg` to all subscribers of `topic` on this node."
  (! (whereis :pubsub) [:broadcast topic msg]))
```

#### Distributed PubSub

For multi-node clusters, `broadcast` must reach subscribers on other nodes. This maps naturally to Brood's distributed model:

```lisp
(defn broadcast (topic msg)
  "Broadcast `msg` to all subscribers of `topic` across all connected nodes."
  (doseq (node (cons (node-name) (nodes)))
    (send {:name :pubsub :node node} [:broadcast topic msg])))
```

Since each node runs its own `pubsub-server` registered as `:pubsub`, a cross-node broadcast is just a message send to each node's PubSub server, which then dispatches locally.

This is simpler than Phoenix PubSub's `:pg` approach but has the same semantics: one message hop per node, local delivery on each.

For the fastlaning optimization (serialize once, send bytes to N subscribers): since Brood uses deep-copy semantics, the message is already deep-copied per send. An optimization would be to serialize the diff payload to a JSON string before broadcasting, sending the string rather than the Brood data structure — one serialization, N sends of the same string.

### 5.5 Sessions and Cookies

Sessions are signed cookies. The signing uses HMAC-SHA256 with a server-side secret (configured in the project). The session value is a Brood map serialized to JSON and base64-encoded, then signed.

```lisp
(defn encode-session (session-map secret)
  (let (payload (base64-encode (json-encode session-map))
        sig     (hmac-sha256 payload secret))
    (str payload "." sig)))

(defn decode-session (cookie-value secret)
  (let ([payload sig] (string-split cookie-value "."))
    (if (= sig (hmac-sha256 payload secret))
      [:ok (json-decode (base64-decode payload))]
      [:error :invalid-signature])))
```

Session management is a middleware:

```lisp
(defn fetch-session (conn)
  (let (cookie-val (get-in conn [:cookies :session] nil))
    (if cookie-val
      (match (decode-session cookie-val *session-secret*)
        ([:ok session] (assoc conn :session session))
        ([:error _]    (assoc conn :session {})))
      (assoc conn :session {}))))

(defn put-session (conn k v)
  (assoc-in conn [:session k] v))

(defn write-session (conn)
  ;; Called at the end of the pipeline to flush session to cookie
  (let (encoded (encode-session (get conn :session) *session-secret*))
    (set-cookie conn :session encoded {:http-only true :same-site :lax})))
```

**CSRF protection** uses the double-submit cookie pattern: a CSRF token is stored in the session and also embedded in every form as a hidden field. The `verify-csrf` middleware checks that they match.

```lisp
(defn inject-csrf-token (conn)
  (let (token (or (get-in conn [:session :csrf-token]) (random-token 32)))
    (-> conn
      (put-session :csrf-token token)
      (assign :csrf-token token))))

(defn verify-csrf (conn)
  (if (safe-method? (get conn :method))
    conn
    (let (session-token (get-in conn [:session :csrf-token])
          form-token    (get-in conn [:params :_csrf-token]))
      (if (and session-token (= session-token form-token))
        conn
        (send-resp conn 403 "CSRF token mismatch")))))
```

**LiveBrood CSRF:** The session token signed into `data-phx-session` includes the CSRF token. The WebSocket join message includes it as a parameter. The server verifies it before accepting the connection.

### 5.6 Supervision

The HTTP server has a two-level supervision tree:

```
web-supervisor
├── listener-process       ; accepts TCP connections, never crashes
├── pubsub-server          ; registered as :pubsub
└── live-session-supervisor
    ├── session-pid-1      ; one per active browser tab
    ├── session-pid-2
    └── ...
```

The `web-supervisor` is started with `(supervise ...)` (Brood's hand-rolled supervisor pattern from `supervision.md`). If a session process crashes (user code bug), the WebSocket is closed and the client reconnects — starting a fresh session process. The listener and PubSub server are unaffected.

LiveBrood session processes are created with `(spawn ...)` and registered under their WebSocket connection ID. The `live-session-supervisor` monitors them and cleans up on exit.

### 5.7 Developer experience and macros

#### Project template

`nest new myapp --template http-server` scaffolds:

```
myapp/
  project.blsp                  ; name, version, web framework dependency
  src/
    main.blsp                   ; starts the web supervisor and HTTP listener
    router.blsp                 ; route table
    controllers/
      pages.blsp                ; example static handler
    live/
      home.blsp                 ; example deflive view
    templates/
      layout.blsp               ; app-wide HTML layout
  tests/
    controllers/
      pages_test.blsp
  public/                       ; static assets
    js/
      app.js                    ; LiveSocket initialization
    css/
      app.css
```

`src/main.blsp`:
```lisp
(defmodule main "Application entry point."
  (:use web/http)
  (:use router))

(defn main ()
  (http-serve 4000 router/dispatch))
```

#### Key macros

**`defhandler`** — wraps a handler function with common conn operations:

```lisp
(defmacro defhandler (name (conn & args) & body)
  `(defn ~name (~conn ~@args)
     ~@body))
```

**`deflive`** — the LiveBrood view definition:

```lisp
(defmacro deflive (name & clauses)
  ;; Generates:
  ;; 1. name/mount fn
  ;; 2. name/render fn (compiled to static/dynamic struct)
  ;; 3. name/handle-event multimethod
  ;; 4. name/handle-message multimethod
  ;; 5. name--session defprocess that orchestrates them
  ...)
```

**`defroute`** (underlying `get`/`post`/`live`):

```lisp
(defmacro get (path handler)
  `(add-route! :GET ~path ~handler))
```

**`render`** — renders a template to an HTML response:

```lisp
(defn render (conn template-name assigns)
  (let (html (web/template/render template-name assigns))
    (send-resp (put-resp-header conn :content-type "text/html; charset=utf-8") 200 html)))
```

**`slot`** annotation in live templates:

```lisp
(defmacro slot (key expr)
  ;; At compile time: registers key as a dependency of this dynamic slot
  ;; At runtime: just returns (render-to-html expr)
  ;; The macro transformer for deflive-template handles the compile-time part
  `(slot* '~key (fn () ~expr)))
```

#### Testing

Controllers are pure functions — testing is just calling them with a mock conn:

```lisp
(describe "users/show"
  (test "returns 200 for valid user"
    (let (conn (mock-conn :GET "/users/42" {:params {:id "42"}})
          result (users/show conn))
      (assert= (get result :status) 200)))

  (test "returns 404 for missing user"
    (let (conn (mock-conn :GET "/users/999" {:params {:id "999"}})
          result (users/show conn))
      (assert= (get result :status) 404))))
```

LiveBrood views are testable by calling `mount`, `render`, and `on` directly:

```lisp
(describe "dashboard live"
  (test "increment updates count"
    (let (model (dashboard/mount {} {} false)
          model2 (dashboard/handle-event "increment" {} model))
      (assert= (get model2 :count) 1)))

  (test "render includes count"
    (let (model {:count 42 :items []}
          html  (web/template/render-to-html (dashboard/render model)))
      (is (string-contains? html "42")))))
```

The LiveBrood session process itself can be tested with `spawn-server` + `gen-call`:

```lisp
(test "full session lifecycle"
  (let (pid (spawn-live-session dashboard {:params {} :session {}}))
    (send pid [:event {:type "increment" :value {}}])
    (sleep 10)   ; give the process time to handle the message
    (assert= (gen-call pid :get-model) {:count 1 :items []})))
```

#### Hot reload integration

`nest run --watch src/` watches `.blsp` files. When a template file changes:
1. The file is reloaded — `def`/`defn` rebind.
2. All running LiveBrood sessions receive a `[:reload module]` message.
3. Each session re-renders with the new render function and sends a full re-render diff to the client.

Because `defn` rebinds the global and processes use late binding (they call `module/render` by name, not by captured closure), the new render function is picked up automatically on the next event. The hot reload just needs to trigger a re-render — it doesn't need to restart processes.

```lisp
;; In the session actor
(receive
  ([:reload _module]
   (let (new-rendered (call-render (get state :module) (get state :model))
         diff         (compute-diff (get state :rendered) new-rendered))
     (send-ws (get state :conn) [:diff diff])
     (assoc state :rendered new-rendered))))
```

---

## 6. Open Questions

**Q1: Template DSL or plain Hiccup?**
The `deflive-template` macro requires templates to be written as special forms (so the compiler can analyze them). But for static rendering, plain Hiccup vectors work fine. The question is whether to require the macro DSL everywhere or only for live templates. Recommendation: require the macro for `(render ...)` inside `deflive`, allow plain vectors for static `render` in regular handlers. The `slot` annotation provides explicit control without full static analysis.

**Q2: Change tracking — explicit slots vs. static analysis?**
Phoenix HEEx's change tracking works because the compiler can identify `@assign` references syntactically. Brood templates use `(get model :key)` — can the macro transformer identify these automatically? Probably yes for direct `get`/`get-in` with literal keys, but not for computed accesses. Explicit `(slot :key expr)` is simpler and more predictable. Decide whether to implement the static analysis optimization or ship with explicit slots only.

**Q3: HTTP backend — Rust extension or pure Brood? ✓ DECIDED**
The web framework is pure Brood — no new Rust code, no external Rust crates, no FFI beyond what Brood's stdlib already ships. If Brood's stdlib doesn't yet expose TCP socket primitives, that's a Brood stdlib task (adding them there), not a framework concern. HTTP/1.1 request parsing, WebSocket framing, and response serialization are all string/byte manipulation — implementable in Brood directly. TLS is handled at the infrastructure layer (reverse proxy: nginx, Caddy, fly.io's load balancer), not by the framework. The framework document should avoid references to `http-listen` as a Rust-backed primitive and instead specify: the framework provides a pure-Brood TCP listener loop built on whatever socket API Brood's stdlib exposes.

**Q4: WebSocket protocol — Phoenix wire format or custom? ✓ DECIDED**
The framework ships its own JS client and wire protocol. Phoenix's client is MIT-licensed and its ideas are fair game to copy, but neither `phoenix.js` nor `phoenix_live_view.js` will be a dependency. See section 5.8 for the custom protocol and client design.

**Q5: Sessions — cookie-only or also ETS/database-backed?**
Phoenix supports configuring session storage. Cookie-only sessions are simplest but limited in size (4KB). If sessions need to store more (or if you want server-side invalidation without expiry), you need a server-side session store. Brood's process model makes an in-memory session store trivial (a `defprocess` registry). The question is how to expose this as a configuration option.

**Q6: LiveComponent process model.**
Should LiveComponents be implemented as separate processes (full crash isolation, more overhead) or as in-process subtrees (same as Phoenix, more efficient, shared crash domain)? Phoenix chose in-process for efficiency. For Brood, processes are cheap enough that separate processes per component might be viable — but it complicates the diff protocol. Recommendation: start with in-process (same model as Phoenix), consider separate processes for "heavyweight" components as a future option.

**Q7: Streaming large responses.**
Phoenix 1.7+ supports streaming responses for server-sent events and chunked HTTP. Brood's `send-resp` model is fire-and-forget. For streaming, the handler would need to return a channel/process rather than a complete response. Design needed.

**Q8: How do `deflive` views compose with standard `conn` middleware?**
A LiveView in Phoenix still runs the full Plug pipeline on the initial HTTP request. The session, CSRF, and authentication plugs run before the LiveView mounts. The WebSocket join then re-runs authentication in `on_mount`. For Brood: the initial HTTP `conn` pipeline runs normally. The `live` route in the router is a normal handler that also handles the WebSocket upgrade. Authentication should be placed in a pipeline that runs before the live handler, and `mount` must re-verify (same as Phoenix). Design a convention for `on-mount` hooks.

**Q9: How to handle large binary uploads?**
`phx-upload` in Phoenix LiveView handles chunked file uploads over WebSocket with progress tracking. This is a significant feature. For Brood, the initial design should support multipart form uploads (standard HTTP POST) and document that WebSocket-based streaming upload is a future feature.

**Q10: SEO and meta tags.**
Phoenix LiveView supports `<.live_title>` for dynamically updating the page `<title>`. More generally, how does LiveBrood handle `<head>` updates (meta tags for social sharing, OpenGraph)? The layout is static after the initial render. Consider a mechanism for `on` handlers to return `[:set-title "New Title"]` effects that the client applies.

---

*Document status: Research complete, design draft. Ready for review and prototyping. The highest-leverage next step is implementing `web/http` with a Rust backend and `web/router` with the macro-based route compiler — these unblock everything else.*
