// brood_channel.js — the client half of web/channel: one WebSocket to /channel/ws
// multiplexing any number of topics. No dependencies.
//
// Usage:
//
//   const socket = BroodChannel.connect();            // or connect("/channel/ws")
//   const room = socket.channel("room:lobby", { token });
//
//   room.on("new_msg", (payload) => render(payload));
//   room.join()
//     .then((reply) => console.log("joined", reply))
//     .catch((err) => console.warn("refused", err));
//
//   room.push("new_msg", { body: "hi" });             // fire and forget
//   room.push("ping", {}).then((reply) => …);         // awaits the reply on this ref
//   room.leave();
//
// A frame is { topic, event, payload, ref }. `ref` is the correlation id: a reply comes
// back on the ref of the frame that asked for it and on nothing else, which is what lets
// several topics' traffic share one socket without a client having to guess which push
// answers which request.

const BroodChannel = (() => {
  class Channel {
    constructor(socket, topic, params) {
      this.socket = socket;
      this.topic = topic;
      this.params = params || {};
      this.handlers = new Map();
      this.state = "closed"; // closed | joining | joined
      // Whether the PAGE wants this channel, which is not the same question as what the
      // socket is currently doing. `join()` sets it, `leave()` clears it, and nothing else
      // touches it — so a reconnect can ask "did the app ask for this?" rather than trying to
      // read intent out of `state`.
      //
      // Reading `state` got it wrong in both directions. A channel still "joining" (the
      // documented usage is synchronous, so the first join is queued before the socket is
      // open) was re-joined on the very first `onopen` — two joins, the second accepted and
      // the first answered "already joined", which rejected the promise the app was holding.
      // And a channel whose join was in flight when the socket dropped had its promise
      // rejected, which set `state` to "closed" in a microtask long before the reconnect
      // timer fired, so the reconnect skipped it and the page received nothing ever again.
      this.wanted = false;
    }

    on(event, callback) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(callback);
      return this;
    }

    off(event) {
      this.handlers.delete(event);
      return this;
    }

    join() {
      if (this.state === "joined" || this.state === "joining") {
        return Promise.reject(new Error(`already ${this.state} ${this.topic}`));
      }
      this.state = "joining";
      this.wanted = true;
      return this.socket
        ._request(this.topic, "join", this.params)
        .then((payload) => {
          this.state = "joined";
          this._fire("join", payload);
          return payload;
        })
        .catch((err) => {
          // `state`, not `wanted`: the app still wants this channel, the attempt just did
          // not land. A reconnect re-joins on intent, so a join interrupted by the drop that
          // rejected it is retried rather than abandoned.
          this.state = "closed";
          throw err;
        });
    }

    // Re-join after a reconnect. Separate from `join()` because the app's promise from the
    // original call is long settled, so a failure here has nobody to reject at — it is
    // reported and retried on the next reconnect rather than surfacing as an unhandled
    // rejection the page never asked for.
    _rejoin() {
      this.state = "joining";
      this.socket
        ._request(this.topic, "join", this.params)
        .then((payload) => {
          this.state = "joined";
          this._fire("join", payload);
        })
        .catch((err) => {
          this.state = "closed";
          console.warn(`brood channel: could not rejoin ${this.topic}`, err);
        });
    }

    // Fire-and-forget unless the caller wants the reply: every push carries a ref, so the
    // server always answers, and the promise is simply ignored when nobody holds it.
    push(event, payload) {
      return this.socket._request(this.topic, event, payload || {});
    }

    leave() {
      this.wanted = false;
      const done = this.socket._request(this.topic, "leave", {});
      this.state = "closed";
      this.socket.channels.delete(this.topic);
      return done;
    }

    _fire(event, payload) {
      const list = this.handlers.get(event);
      if (!list) return;
      // A throwing handler must not stop the others, or eat the rest of the frame.
      for (const fn of list) {
        try { fn(payload); } catch (e) { console.error("brood channel handler:", e); }
      }
    }
  }

  class Socket {
    constructor(path) {
      this.path = path || "/channel/ws";
      this.socket = null;
      this.connected = false;
      this.channels = new Map();
      // ref → {resolve, reject}. A request is settled by the reply carrying its ref; on a
      // disconnect every one still waiting is rejected rather than left pending forever.
      this.pending = new Map();
      this.nextRef = 1;
      this.queue = [];
      // Whether this socket has ever been open, so the first `onopen` does not re-join what
      // has not been joined yet — see the rejoin note there.
      this.opened = false;
      this.reconnectDelay = 250;
      this.reconnectTimer = null;
      this._connect();
    }

    channel(topic, params) {
      const existing = this.channels.get(topic);
      if (existing) return existing;
      const ch = new Channel(this, topic, params);
      this.channels.set(topic, ch);
      return ch;
    }

    disconnect() {
      this.reconnectDelay = null; // stop reconnecting
      clearTimeout(this.reconnectTimer);
      if (this.socket) this.socket.close();
    }

    _connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      this.socket = new WebSocket(`${proto}//${location.host}${this.path}`);

      this.socket.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 250;
        // Re-join only on a RE-connect. On the first open there is nothing to re-join: the
        // app's own `join()` is already queued (the documented usage is synchronous, so it
        // was made before the socket opened) and re-joining here would send a second one —
        // the server accepts whichever arrives first and answers the other "already joined",
        // rejecting the promise the app is holding on every single page load.
        if (this.opened) {
          for (const ch of this.channels.values()) {
            // On INTENT, not on `state`: a join still in flight when the socket dropped had
            // its promise rejected, which set `state` to "closed" long before this runs.
            if (ch.wanted) ch._rejoin();
          }
        }
        this.opened = true;
        // Then whatever was queued while the socket was down — a push for a topic is
        // meaningless until its join has gone out, so this order matters.
        const queued = this.queue;
        this.queue = [];
        for (const frame of queued) this._write(frame);
      };

      this.socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        this._handle(msg);
      };

      this.socket.onclose = () => {
        this.connected = false;
        // Nothing in flight can be answered by a socket that is gone.
        for (const { reject } of this.pending.values()) {
          reject(new Error("brood channel: disconnected"));
        }
        this.pending.clear();
        // The queue goes with them. A frame written while the socket was down sits in both
        // `queue` and `pending`; rejecting the promise and keeping the frame meant the app
        // was told its push failed — and a retrying app had already re-sent it — while the
        // reconnect replayed the original anyway, so the room got it twice and the reply was
        // dropped as an unknown ref. Nothing bounded the queue across a long outage either.
        this.queue = [];
        for (const ch of this.channels.values()) {
          if (ch.state === "joined") ch._fire("close", { reason: "disconnected" });
        }
        this._scheduleReconnect();
      };
      this.socket.onerror = () => {};
    }

    _scheduleReconnect() {
      if (this.reconnectDelay === null) return; // disconnect() was called
      clearTimeout(this.reconnectTimer);
      const delay = this.reconnectDelay * (1 + Math.random() * 0.5);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 1000);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
    }

    _write(frame) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(frame));
      } else {
        this.queue.push(frame);
      }
    }

    _request(topic, event, payload) {
      const ref = String(this.nextRef++);
      return new Promise((resolve, reject) => {
        this.pending.set(ref, { resolve, reject });
        this._write({ topic, event, payload, ref });
      });
    }

    _handle(msg) {
      if (msg.event === "reply") {
        const waiting = this.pending.get(msg.ref);
        if (!waiting) return;
        this.pending.delete(msg.ref);
        if (msg.status === "ok") waiting.resolve(msg.payload || {});
        else waiting.reject(msg.payload || {});
        return;
      }
      const ch = this.channels.get(msg.topic);
      if (!ch) return;
      if (msg.event === "close") {
        ch.state = "closed";
        ch._fire("close", msg.payload || {});
        return;
      }
      ch._fire(msg.event, msg.payload || {});
    }
  }

  return {
    connect(path) { return new Socket(path); },
    Socket,
    Channel,
  };
})();

if (typeof window !== "undefined") window.BroodChannel = BroodChannel;
