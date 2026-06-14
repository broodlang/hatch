// brood_live.js — LiveBrood WebSocket client
// Connects to /live/ws, handles render/diff messages, sends user events.
// No dependencies. ~200 lines.

const BroodLive = (() => {
  // Connection status across every live session on the page. We reflect it as a
  // class on <html> (brood-connected / brood-disconnected) and a `brood:status`
  // CustomEvent, so a page can show a reconnect indicator with plain CSS — or hook
  // the event for custom behaviour — without any per-view code.
  const sessions = new Set();
  function refreshStatus() {
    const connected = [...sessions].every((s) => s.connected);
    const root = document.documentElement;
    root.classList.toggle("brood-disconnected", sessions.size > 0 && !connected);
    root.classList.toggle("brood-connected", sessions.size > 0 && connected);
    document.dispatchEvent(new CustomEvent("brood:status", { detail: { connected } }));
  }

  class Session {
    constructor(path, container) {
      this.path = path;
      this.container = container;
      this.socket = null;
      this.connected = false;
      this.reconnectDelay = 1000;
      this.reconnectTimer = null;
      sessions.add(this);
      refreshStatus();
      this._connect();
    }

    _connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/live/ws${this.path}`;
      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        this.reconnectDelay = 1000;
        this.connected = true;
        refreshStatus();
        // Send join with current URL params
        const params = Object.fromEntries(new URLSearchParams(location.search));
        this._send({ event: "join", params });
      };

      this.socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        this._handle(msg);
      };

      this.socket.onclose = () => {
        this.connected = false;
        refreshStatus();
        this._scheduleReconnect();
      };
      this.socket.onerror = () => {};
    }

    _scheduleReconnect() {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this._connect();
      }, this.reconnectDelay);
    }

    _send(msg) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }

    _handle(msg) {
      if (msg.event === "render") {
        this._patch(msg.html);
      } else if (msg.event === "diff") {
        this._patch(msg.html);
      }
    }

    // Morph the container's content to the new HTML.
    // For the MVP, this is an innerHTML swap. A future version
    // will use a proper morphdom-style algorithm.
    _patch(html) {
      const next = document.createElement("div");
      next.innerHTML = html;
      morphChildren(this.container, next);
    }

    // Called by event bindings to push a user event to the server.
    pushEvent(name, params = {}) {
      this._send({ event: "event", name, params });
    }
  }

  // Simple DOM morphing: diff children by key, update text/attrs in-place.
  function morphChildren(current, next) {
    const cur = Array.from(current.childNodes);
    const nxt = Array.from(next.childNodes);

    let ci = 0, ni = 0;
    while (ni < nxt.length) {
      const nc = nxt[ni];
      if (ci >= cur.length) {
        current.appendChild(nc.cloneNode(true));
        ni++; continue;
      }
      const cc = cur[ci];
      if (cc.nodeType !== nc.nodeType ||
          (cc.nodeType === 1 && cc.tagName !== nc.tagName)) {
        current.insertBefore(nc.cloneNode(true), cc);
        ni++; continue;
      }
      if (nc.nodeType === 3) {
        if (cc.textContent !== nc.textContent) cc.textContent = nc.textContent;
        ci++; ni++; continue;
      }
      morphElement(cc, nc);
      ci++; ni++;
    }
    while (ci < cur.length) { current.removeChild(cur[ci++]); }
  }

  function morphElement(cur, next) {
    // Sync attributes
    const nextAttrs = new Set();
    for (const { name, value } of next.attributes) {
      nextAttrs.add(name);
      if (cur.getAttribute(name) !== value) cur.setAttribute(name, value);
    }
    for (const { name } of cur.attributes) {
      if (!nextAttrs.has(name)) cur.removeAttribute(name);
    }
    morphChildren(cur, next);
  }

  // Wire up all [data-event] elements inside a container.
  function bindEvents(container, session) {
    container.addEventListener("click", (e) => {
      const el = e.target.closest("[data-event]");
      if (!el || !container.contains(el)) return;
      e.preventDefault();
      const name = el.dataset.event;
      const params = el.dataset.params ? JSON.parse(el.dataset.params) : {};
      session.pushEvent(name, params);
    });

    container.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset.event) return;
      const name = el.dataset.event;
      const params = { value: el.value, ...(el.dataset.params ? JSON.parse(el.dataset.params) : {}) };
      session.pushEvent(name, params);
    });

    container.addEventListener("submit", (e) => {
      const form = e.target;
      if (!form.dataset.event) return;
      e.preventDefault();
      const name = form.dataset.event;
      const data = Object.fromEntries(new FormData(form));
      session.pushEvent(name, data);
    });
  }

  // Public API: mount all [data-live] elements on the page.
  function mount() {
    document.querySelectorAll("[data-live]").forEach((el) => {
      const path = el.dataset.live || location.pathname;
      const session = new Session(path, el);
      bindEvents(el, session);
    });
  }

  // Auto-mount on DOMContentLoaded.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  return { mount, Session };
})();
