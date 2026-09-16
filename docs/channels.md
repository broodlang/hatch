# Channels

A live view owns a URL. The socket *is* the view, the server holds the model, and what crosses
the wire is a diff of rendered markup. That is the right shape for a page and the wrong one for
everything that is not a page.

A channel is the other shape: one socket, any number of named topics, messages in both
directions, and nothing rendered. A mobile client, a device feed, a game, a browser tab that
wants JSON rather than HTML — all of them want this and none of them want a live view.

---

## A channel module

```clojure
(defmodule app/channels/room (:use web/channel))

(defchannel
  (join (topic params socket)
    (if (valid-token? (get params "token"))
      [:ok {:joined topic} (assign socket {:user-id (get params "user_id")})]
      [:error {:reason "unauthorized"}]))

  (on "new_msg" (params socket)
    (do
      (broadcast socket "new_msg" {:body (get params "body")
                                   :from  (assigned socket :user-id)})
      [:noreply socket]))

  (on "ping" (params socket) [:reply {:pong true} socket])

  (terminate (reason socket) (log/info "left " (channel-socket-topic socket))))
```

```clojure
(defrouter routes
  (channel "room:*" app/channels/room)
  (channel "user:*" app/channels/user))
```

A pattern is an exact topic or a trailing-`*` prefix. An exact registration always beats a
wildcard that also covers the topic, and among wildcards the longest prefix wins — so
`"room:admin:*"` can sit beside `"room:*"` without registration order deciding anything.

The clause adds no route. Channel sockets all arrive on `/channel/ws` and name their topic in
each frame, so an enclosing `through` group does not cover them — a channel authorizes in its
own `join`.

## Handler returns

| clause | answers |
|---|---|
| `join` | `[:ok socket]`, `[:ok payload socket]`, `[:error payload]` |
| `on` | `[:noreply socket]`, `[:reply payload socket]`, `[:stop reason socket]` |
| `handle-info` | the same three |
| `handle-out` | `[:push event payload socket]` (the default), `[:noreply socket]` to drop it |
| `terminate` | anything; it is for cleanup |

`socket` is to a channel what `model` is to a live view: the one value every callback takes and
returns. It carries the topic, the connection's read-only Conn, and whatever `assign` has put
in its assigns. Nothing is mutated — a handler must return the socket it wants kept.

## `join` is required

Every other clause has a sensible default. This one refuses to.

A channel is reachable by anything that can open a socket, and a pattern like `"user:*"` lets
the client choose the rest of the topic itself. A channel whose author forgot `join` would be
an open door that reads exactly like a closed one — so a missing clause is an error at macro
expansion rather than a permissive default at runtime.

For a decision about the *connection* rather than a topic, the endpoint takes a connect guard:

```clojure
(web/endpoint/serve {:router routes
                     :channels (fn (conn) (unless (signed-in? conn) :refused))})
```

Return a falsy value to accept. It is the counterpart of a live view's `on-mount-guard`.

## Topics are shared with `web/pubsub`

Deliberately, and it is what makes a channel worth having *next to* a live view rather than
instead of one.

`broadcast` publishes on the topic name itself, so a live view that subscribes to the same
topic in its `mount` receives every channel message at its `handle-info` as
`{:topic :event :payload}`:

```clojure
;; in a live view
(mount (params) (do (pubsub/subscribe "room:lobby") {:messages (list)}))
(handle-info (msg model)
  (if (= (get msg :event) "new_msg")
    (update model :messages (fn (ms) (append ms [(get msg :payload)])))
    model))
```

And `broadcast-to` sends from anywhere with no socket in hand — an HTTP handler, a background
job, a `handle-info` in some other process:

```clojure
(web/channel/broadcast-to "room:lobby" "announcement" {:text "back in 5"})
```

| from | to |
|---|---|
| `(broadcast socket event payload)` | everyone on the topic, including this client |
| `(broadcast-from socket event payload)` | everyone else |
| `(push socket event payload)` | this client only |
| `(broadcast-to topic event payload)` | everyone, from outside any socket |

## Presence

`web/presence` works unchanged — it tracks a process, and a channel socket is one:

```clojure
(join (topic params socket)
  ;; assign FIRST — `socket` arrives with empty assigns, so reading them here would track
  ;; every member under nil
  (let (joined (assign socket {:user-id (get params "user_id") :name (get params "name")}))
    (presence/track topic (assigned joined :user-id) {:name (assigned joined :name)})
    [:ok joined]))
```

Roster updates arrive at the channel's `handle-info`. The presence is dropped automatically
when the socket process dies.

## The wire

A frame is a JSON object with four fields.

```
client → server   {"topic":"room:lobby","event":"join","payload":{…},"ref":"1"}
                  {"topic":"room:lobby","event":"new_msg","payload":{…},"ref":"2"}
                  {"topic":"room:lobby","event":"leave","ref":"3"}

server → client   {"topic":"room:lobby","event":"reply","ref":"1","status":"ok","payload":{…}}
                  {"topic":"room:lobby","event":"new_msg","payload":{…}}
                  {"topic":"room:lobby","event":"close","payload":{"reason":…}}
```

`ref` is the client's correlation id. It comes back on the reply to that exact frame and on
nothing else, which is what lets a client await one join while other topics' pushes stream past
it on the same socket.

## The browser client

```js
const socket = BroodChannel.connect();
const room = socket.channel("room:lobby", { token });

room.on("new_msg", (payload) => render(payload));
room.join().then((reply) => …).catch((err) => …);

room.push("new_msg", { body: "hi" });          // fire and forget
room.push("ping", {}).then((reply) => …);      // or await the reply
room.leave();
```

Served from the package at `/static/brood_channel.js`, like the live client. It reconnects with
jittered backoff and re-joins the topics the page asked for. A drop rejects every in-flight
request rather than leaving promises pending forever, and discards what was queued with them:
a frame whose promise was already rejected must not also be replayed on reconnect, or the app
is told its push failed while the room receives it twice.

## Limits

One socket may hold **64 topics** (`web/channel/*max-topics-per-socket*`). A client chooses its
own topics and each join costs a map entry plus a pubsub subscription on every node, so without
a ceiling one connection can grow the registry without bound. No honest client meets it.

The idle watchdog pings a silent peer and reaps one that never answers, exactly as it does for a
live session — and every client frame resets it, so a busy socket is never reaped.

## When a join is refused

The client is told `{:reason "no such channel"}` and nothing more, deliberately: a client has
no business learning which topics exist. In **dev** the server also logs which of the two
things went wrong, because from the reply they are identical and they are nothing alike:

```
[channel] no channel matches topic "user:9" — registered patterns: ["chat:*" "room:*"]
[channel] no channel for topic "room:lobby" — and the channel table is EMPTY, so no
          `(channel …)` clause has registered at all. … Every join will fail this way,
          not just this one.
```

The second is the one to recognise. An empty table means no `(channel …)` clause ever ran —
the router module never loaded, or its load-time registrations were lost — so every join
fails, not the topic you happened to try. `web/live` logs the same distinction for a live
upgrade. The message is a pure function (`unjoinable-channel-message`), so the wording is
under test rather than incidental.

## Testing

`tests/web_channel_test.blsp` drives a real socket over loopback: join replies land on the ref
the client sent, a broadcast from outside reaches a joined client through `handle-out`, an event
for an unjoined topic is answered rather than dropped, `leave` runs `terminate` and drops the
subscription, and presence works across it. The `defchannel` expansion and the topic matcher are
covered as plain functions.

## Who is on the socket

A channel socket's conn is the upgrade request's, built before any router `through` group
runs — so the session plug never touched it. Its `:session` is an EMPTY MAP, not nil, which
is the trap: `(or (conn-session conn) …)` looks loaded and empty, and every socket reads as
signed out. Read it with the store the app's plug uses:

```clojure
(join (topic params socket)
  (let (conn (session/fetch app-store (channel-socket-conn socket))
        user (session/get-session conn "user-id"))
    (if user [:ok (assign socket {:user user})] [:error {:reason "sign in first"}])))
```

`fetch` is idempotent, so a conn the plug did load is returned as is.
