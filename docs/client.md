# The browser client

`static/brood_live.js` is the other half of a live view. The server renders markup and ships
diffs; this is what turns a user's click into an event, morphs a diff into the DOM, and gives
imperative JavaScript somewhere to live.

It is served straight out of the package — `web/endpoint`'s `:static` stage mounts it at
`/static/brood_live.js`, and `(live …)` in a router injects the `<script>` — so an app never
vendors a copy that can drift from the server half it talks to.

Everything below is a plain HTML attribute. There is no build step and nothing to import.

---

## Sending events

| attribute | what it does |
|---|---|
| `data-event="name"` | on a control: click; on an input: every keystroke and on change; on a `<form>`: submit |
| `data-params='{"…"}'` | extra params merged into the event, as JSON |
| `data-disable-with="Saving…"` | disable and relabel this control until the next patch lands |

An input's event carries `value` alongside its `data-params`. A form's carries its fields the
way `new FormData(form)` collects them.

### Any other event

`data-event` infers the binding from the element, which covers click/type/submit and nothing
else. Everything else is named:

| attribute | what it does |
|---|---|
| `data-on-<event>="name"` | bind any DOM event — `data-on-keydown`, `data-on-blur`, `data-on-paste` |
| `data-on-window-<event>="name"` | the same, bound on `window` — a shortcut that works wherever focus is |
| `data-on-click-away="name"` | a click that lands outside this element |
| `data-keys="Escape,Enter"` | only fire for these keys |

```clojure
[:input {:data-on-keydown "search" :data-keys "Enter"}]
[:div   {:data-on-click-away "close"}]
[:div   {:data-on-window-keydown "shortcut" :data-keys "Escape"}]
```

One rule — `data-on-<dom event>` — rather than Phoenix's twelve separate attributes, so
`data-on-dblclick` and `data-on-contextmenu` need nothing added to the framework. A keyboard
event carries `key`, `code`, `alt`, `ctrl`, `shift` and `meta`; a control also carries `value`;
`data-params` is merged over both.

Listeners attach lazily, one per event type per session, the first time a patch renders an
element wanting it — a page with no `data-on-mouseover` never pays for a mouseover listener.
The default set covers the common events; `BroodLive.listen("wheel")` adds one outside it.
`mouseenter`/`mouseleave` don't propagate in either phase, so spell those `mouseover`/`mouseout`.

In a test, `live-click` / `live-change` / `live-submit` accept these spellings as well as
`data-event`, and `live-fire` drives everything else — one driver taking the attribute, since
the binding family is open and a fixed list would go stale:

```clojure
(live-fire v "#search" :data-on-keydown {"key" "Enter"})
(live-fire v "#menu" :data-on-click-away)
```

### Where an event goes

An event is routed to the nearest ancestor `[data-cid]` — a LiveComponent — if there is one,
and to the view otherwise. `data-target` overrides that in the two directions that were
otherwise unreachable:

| value | what it does |
|---|---|
| `data-target="view"` | send to the view, from inside a component |
| `data-target="#some-id"` | send to the component containing that element, from outside it |

### Doing it without the server

Opening a dropdown does not need a round trip.

```clojure
[:button {:data-js-click (live/js [[:toggle "#menu"]])} "Menu"]

;; both on one control: the panel dims immediately, the save travels
[:button {:data-on-click "save"
          :data-js-click (live/js [[:add-class "#form" "saving"]])} "Save"]
```

`data-js-<event>` takes a JSON list of `[op, selector, …args]`, which `web/live/js` builds so
an app writes Brood rather than a string. A selector of `"this"` means the element itself.
Ops: `toggle` / `show` / `hide`, `add-class` / `remove-class` / `toggle-class`, `set-attr` /
`remove-attr`, `focus` / `blur`, and `dispatch` (a CustomEvent for the page's own JS, carrying
`{…detail, source}`).

Local commands run before the server event on the same element, so the visual change lands
immediately rather than after the round trip it accompanies.

### While an event is in flight

`brood-loading` goes on the element whose event is travelling, and on the live container while
any is — both removed by the next patch. Two classes rather than a name per binding: the
element already says which binding it carries, so `[data-event].brood-loading` distinguishes
them without the framework inventing vocabulary.

`data-disable-with="Saving…"` additionally disables and relabels a control.

## Pacing what gets sent

An input with `data-event` fires on **every keystroke** by default. That is right for a
character counter and wrong for anything that hits a database.

| attribute | what it does |
|---|---|
| `data-debounce="300"` | wait 300ms of quiet, then send the latest value |
| `data-debounce="blur"` | send only when the field is left |
| `data-throttle="500"` | send at most once per 500ms |

```clojure
[:input {:type "text" :name "q" :data-event "search" :data-debounce "300"}]
```

Three rules worth knowing, because each one is a bug if you assume the opposite:

**Leaving a field flushes it.** A numeric debounce whose timer has not run out is sent on
`focusout`, not abandoned. A user who types and tabs away has finished with that field.

**Submitting flushes the form first.** Type into a field debounced at 300ms and press enter,
and the pending change is sent *before* the submit — otherwise the server validates against a
value it was never told about, and the form is wrong in a way that depends on typing speed.

**Throttle treats values and actions differently**, and this is where hatch departs from
Phoenix. A throttled **value** (input/change) sends on the leading edge *and* again at the end
of the window with the latest value: drop the last event of a dragged slider and the server is
left holding a position the user never stopped on, which is a wrong answer rather than a coarse
one. A throttled **action** (click/submit) sends on the leading edge and the rest are dropped
outright — replaying a click late is not rate limiting, it is a second click.

If both attributes are on one element, debounce wins.

## Hooks

A live view renders markup; some things are not markup. A chart, a map, a rich text editor, a
drag-and-drop list, an `<audio>` element that must keep playing across a patch — each is a
library that owns a piece of the DOM and has a lifecycle of its own.

```js
BroodLive.hook("Chart", {
  mounted()      { this.chart = new Chart(this.el, this.points()) },
  updated()      { this.chart.setData(this.points()) },
  destroyed()    { this.chart.destroy() },
  disconnected() { this.el.classList.add("stale") },
  reconnected()  { this.el.classList.remove("stale") },
  points()       { return JSON.parse(this.el.dataset.points) },
});
```

```clojure
[:div {:id "sales"
       :data-hook "Chart"
       :data-update "ignore"
       :data-points (json/encode (get model :points))}]
```

Register hooks before the page mounts — a `<script>` above the live container will do.
`BroodLive.hooks({Chart: {…}, Sortable: {…}})` registers several at once.

### Inside a hook

| | |
|---|---|
| `this.el` | the element |
| `this.pushEvent(name, payload)` | send an event, routed like any other (component if inside one) |
| `this.pushEventTo(selector, name, payload)` | send to the component containing `selector` |
| `this.handleEvent(name, cb)` | receive what a handler sent with `web/live/push-event` |
| `this.removeHandleEvent(name)` | stop receiving it |

Anything else you set on `this` is yours and persists for the life of the hook instance.

### The lifecycle

`mounted` when the element appears, `updated` when the **server** changed something on it,
`destroyed` when it goes, and `disconnected`/`reconnected` as the socket drops and returns.

`updated` fires on a change to the element's attributes — which is how a view passes data to a
hook — and to its server-rendered children. It does **not** fire for changes the hook makes
itself under `data-update="ignore"`, and it does not fire on unrelated patches elsewhere on the
page.

### Two requirements

**A hook element needs an `id`** (or a `data-key`). The morph recognises an element by one of
those; with neither, an unrelated update can rebuild it, and the hook is destroyed and
re-mounted underneath a library that is mid-use. The client logs an error and refuses to mount
rather than half-working, and `web/audit` warns about it at render time in dev.

**A hook that owns its subtree wants `data-update="ignore"`.** Attributes still sync — that is
the channel the server uses to push it data — but the children are left alone. Without it, the
next patch morphs the library's own DOM back to the empty container the server rendered.

## Surviving a reconnect

A dropped socket re-mounts the view, so the server's next render is built from a fresh `mount`
and knows nothing about what the user had typed — and the patch carrying it overwrites the
fields. Half a filled-in form disappears because the wifi blinked.

```clojure
[:form {:id "signup" :data-event "save" :data-recover "validate"} …]
```

`data-recover` names an event to replay with the form's fields after a reconnect. The client
snapshots the values when the socket *closes* — by the time the rejoin patch lands the DOM no
longer holds them — restores them after that patch, and sends the event so the server's model
agrees with what is on screen.

**The event is the author's choice deliberately.** The obvious thing is to replay the form's
own submit, and that would place an order twice. A recover handler is one you have decided is
safe to replay, which is not a property the framework can infer. The form needs an `id`.

## Navigation

| attribute | what it does |
|---|---|
| `data-nav` on an `<a>` | live-navigate: mount another view over the same socket |
| `data-patch` on an `<a>` | live-patch: same view, new params, no remount |

Both fall back to an ordinary page load when there is no socket, and live navigation only
crosses between views in the same `live-session` group — crossing groups forces a full reload,
which is the auth boundary.

## Streams

`data-update="stream"` on a container tells the client to **merge** the children it is sent
rather than reconcile against them — because the server sent only what changed, and is not
holding the collection.

That is the whole mechanism behind [`web/streams`](../src/web/streams.blsp), and it needs no
wire protocol of its own: the ordinary render/diff path carries a stream, with no special case
in `web/parts`, `web/live` or the frame format. Rows are keyed by `id`, so a re-rendered row
morphs in place and does not jump; `data-stream-at` positions a new one (`0` prepends, `-1` or
absent appends); `data-update="stream-reset"` empties the container for that one patch.

A deletion cannot be rendered — the server does not know what is left — so it arrives as a
`stream-delete` effect naming ids.

## Uploads

`data-upload="name"` on a file input, rendered by `web/upload/file-input`. See
[`web/upload`](../src/web/upload.blsp)'s module docstring for the whole mechanism.

## Connection status

The client puts `brood-connected` / `brood-disconnected` on `<html>` and dispatches a
`brood:status` CustomEvent, so a reconnect indicator is plain CSS with no per-view code.
`web/live/live-chrome` renders a default one.

A server-side `push-event` also dispatches `brood:event` on `document` with
`{name, payload}` — the pre-hooks escape hatch, still supported, for page script that is not
inside a hook.

**Stuck on `brood-disconnected`?** The client reconnects on a loop, so a page that never
connects looks the same as a flaky network. Check the **server** log in dev: an upgrade that
finds no live view now says so, and distinguishes the two causes.

```
[live] no live view registered at "/live/ws/typo" — registered paths: ["/counter" "/feed"]
[live] no live view at "/live/ws/counter" — and the route table is EMPTY, so no `(live …)`
       clause has registered at all. … Every live view will fail this way, not just this one.
```

The second line means no `(live …)` clause ever ran — the router module never loaded, or its
load-time registrations did not survive however the process started. That is not a problem
with the view you were looking at; every view is down. Before 0.21.2 the dispatcher closed
the socket in silence, and this was a day of bisecting.

---

## Testing

The client is covered three ways, and the gap is worth stating plainly.

- `tests/js/timing_test.js` — the debounce/throttle decision, as a pure function, under plain
  `node tests/js/timing_test.js`. No dependencies.
- The server-side suites drive the real protocol over real sockets, so the wire format the
  client speaks is pinned from the other end.
- `node --check` for everything else.

**The DOM-bound half has no automated coverage.** Brood has no subprocess primitive, so
`nest test` cannot shell out to node, and there is no headless browser in the loop. Hook
lifecycle, morphing and the event bindings are verified by hand. If you touch them, say so in
the commit.
