// brood_live.js — LiveBrood WebSocket client
// Connects to /live/ws, handles render/diff messages, sends user events, and does
// live navigation between views over the one socket (no full page reload).
// No dependencies. ~250 lines.

const BroodLive = (() => {
  // Connection status across every live session on the page. We reflect it as a
  // class on <html> (brood-connected / brood-disconnected) and a `brood:status`
  // CustomEvent, so a page can show a reconnect indicator with plain CSS — or hook
  // the event for custom behaviour — without any per-view code.
  const sessions = new Set();
  // The session that handles live navigation for this page (the page's live view).
  // One live view per page in the common case; the most recently mounted wins.
  let navSession = null;

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
      this.reconnectDelay = 250;
      this.reconnectTimer = null;
      sessions.add(this);
      navSession = this; // this page's live view, for navigation
      refreshStatus();
      this._connect();
    }

    _connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/live/ws${this.path}`;
      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        this.reconnectDelay = 250;
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
      // Retry quickly with jitter, then back off only mildly. A dev server restarting
      // (nest run --watch) or still booting is usually back within a beat, so the page
      // should reconnect within ~a second of the server returning rather than sitting on
      // "Connecting…" through a multi-second sleep. The gentle ×1.5 growth capped at
      // 1000ms keeps a truly-down server from being hammered, while the jitter spreads
      // many tabs' reconnects so they don't stampede the freshly-restarted server.
      // `reconnectDelay` resets to the fast base on every successful open (onopen).
      const delay = this.reconnectDelay * (1 + Math.random() * 0.5);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 1000);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
    }

    _send(msg) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }

    _handle(msg) {
      if (msg.event === "join") {
        // Full render: the static skeleton plus every dynamic slot. We keep both, so a
        // later "diff" only needs to carry the slots that changed.
        this.statics = msg.s || [];
        this.dynamics = msg.d || [];
        this._patch(this._assemble());
      } else if (msg.event === "diff") {
        // Minimal update: a map of {slotIndex: newValue} for the dynamics that changed.
        // Patch them into our dynamics array, re-interleave with the (unchanged) statics,
        // and morph — so the wire only ever carries what actually changed.
        const d = msg.d || {};
        for (const k in d) this.dynamics[k] = d[k];
        this._patch(this._assemble());
      } else if (msg.event === "redirect") {
        // The navigate target isn't a live view — fall back to a full page load.
        window.location.href = msg.path;
      } else if (msg.event === "reload-css") {
        // A stylesheet rebuilt (asset watcher) — hot-swap every <link> in place,
        // preserving live state. No full reload, no flash: we re-stamp the href with
        // a fresh cache-buster so the browser refetches the updated CSS.
        reloadStylesheets();
      }
    }

    // Assemble the full HTML by interleaving statics with the current dynamics:
    // s0 + d0 + s1 + d1 + ... + sn  (statics has one more entry than dynamics).
    _assemble() {
      const s = this.statics || [], d = this.dynamics || [];
      let out = "";
      for (let i = 0; i < s.length; i++) {
        out += s[i];
        if (i < d.length) out += d[i];
      }
      return out;
    }

    // Morph the container's content to the new HTML in place (so focus/caret survive
    // a re-render). The morph below matches children by INDEX, not by key — a keyed
    // morph (data-key/id) is a TODO; until then a reorder/insert above an interactive
    // element rebuilds it and loses its transient state.
    _patch(html) {
      const next = document.createElement("div");
      next.innerHTML = html;
      morphChildren(this.container, next);
    }

    // Called by event bindings to push a user event to the server.
    pushEvent(name, params = {}) {
      this._send({ event: "event", name, params });
    }

    // Live navigation: switch this session to another live view over the SAME socket,
    // without a full page reload. The server mounts the target and pushes a render
    // (which morphs the container); we update the address bar via the History API.
    // `href` may be absolute or relative; only same-origin paths are live-navigated.
    navigate(href, push = true) {
      const url = new URL(href, location.origin);
      const path = url.pathname;
      const params = Object.fromEntries(url.searchParams);
      if (push) history.pushState({ broodNav: true }, "", url.pathname + url.search);
      this.path = path;
      this._send({ event: "navigate", path, params });
    }
  }

  // Simple DOM morphing: walk children by INDEX, updating text/attrs in place and
  // inserting/removing at the tail. Not keyed — a reorder re-clones from the change
  // point on (TODO: match by data-key/id to preserve node identity across moves).
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

  // Hot-swap every stylesheet by re-stamping its href with a fresh cache-buster.
  // Cloning the <link> and removing the old one only after the new one loads avoids
  // an unstyled flash. Skips cross-origin sheets (we can't reliably bust their cache
  // and they're not what the dev watcher rebuilds anyway).
  function reloadStylesheets() {
    document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute("href");
      if (!href) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      url.searchParams.set("v", Date.now().toString());
      const next = link.cloneNode();
      next.setAttribute("href", url.pathname + url.search);
      next.addEventListener("load", () => link.remove(), { once: true });
      next.addEventListener("error", () => next.remove(), { once: true });
      link.parentNode.insertBefore(next, link.nextSibling);
    });
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

    // Fire on every keystroke (not just on blur, which is what "change" gives) so a
    // [data-event] input drives live as-you-type feedback. The server re-render morphs
    // in place, so the field keeps its focus and caret — as long as the view doesn't
    // render a fighting `value` attribute (let the DOM own what the user typed).
    container.addEventListener("input", (e) => {
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

  // Live navigation wiring (set up once, document-wide):
  //  - a click on an `<a data-nav href="…">` is live-navigated over the open socket
  //    instead of reloading the page — but only if a live session exists and is
  //    connected; otherwise the browser does its normal navigation (a plain page has
  //    no socket, so its data-nav links just load).
  //  - back/forward (popstate) re-navigates to the new address over the same socket.
  function setupNavigation() {
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest("a[data-nav]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || a.target === "_blank") return;
      // Only hijack same-origin links when we actually have a live socket to use.
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return;
      if (!navSession || !navSession.connected) return; // let the browser navigate
      e.preventDefault();
      navSession.navigate(url.pathname + url.search);
    });

    window.addEventListener("popstate", () => {
      if (navSession && navSession.connected) {
        navSession.navigate(location.pathname + location.search, false);
      }
    });
  }

  // Public API: mount all [data-live] elements on the page.
  function mount() {
    document.querySelectorAll("[data-live]").forEach((el) => {
      const path = el.dataset.live || location.pathname;
      const session = new Session(path, el);
      bindEvents(el, session);
    });
    setupNavigation();
  }

  // Auto-mount on DOMContentLoaded.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  return { mount, Session };
})();
