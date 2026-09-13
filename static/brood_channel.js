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
      // Re-join automatically after a reconnect. The server keeps no state for a dropped
      // socket, so a channel that was joined before the drop is not joined after it; without
      // this the page keeps its listeners and silently stops receiving anything.
      this.rejoinOnReconnect = true;
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
      return this.socket
        ._request(this.topic, "join", this.params)
        .then((payload) => {
          this.state = "joined";
          this._fire("join", payload);
          return payload;
        })
        .catch((err) => {
          this.state = "closed";
          throw err;
        });
    }

    // Fire-and-forget unless the caller wants the reply: every push carries a ref, so the
    // server always answers, and the promise is simply ignored when nobody holds it.
    push(event, payload) {
      return this.socket._request(this.topic, event, payload || {});
    }

    leave() {
      this.rejoinOnReconnect = false;
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
        // Flush anything sent while the socket was down, then re-join. Order matters:
        // a queued push for a topic is meaningless until its join has been re-sent, so
        // re-joins go first.
        for (const ch of this.channels.values()) {
          if (ch.rejoinOnReconnect && ch.state !== "closed") {
            ch.state = "closed";
            ch.join().catch(() => {});
          }
        }
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
