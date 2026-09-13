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

  // ---- hooks: the escape hatch to imperative JS -------------------------------------
  //
  // A live view renders markup; some things are not markup. A chart, a map, a rich text
  // editor, a drag-and-drop list, an <audio> element that must keep playing across a patch —
  // every one of those is a library that owns a piece of the DOM and has a lifecycle of its
  // own. Without somewhere to put it, a live view can host none of them.
  //
  //   BroodLive.hook("Chart", {
  //     mounted()      { this.chart = new Chart(this.el, JSON.parse(this.el.dataset.points)) },
  //     updated()      { this.chart.setData(JSON.parse(this.el.dataset.points)) },
  //     destroyed()    { this.chart.destroy() },
  //     disconnected() { this.el.classList.add("stale") },
  //     reconnected()  { this.el.classList.remove("stale") },
  //   });
  //
  // and in the view: [:div {:id "sales" :data-hook "Chart" :data-points …}]
  //
  // Inside a hook, `this.el` is the element, `this.pushEvent(name, payload)` sends an event to
  // the view (or to the enclosing component, exactly as a click would), and
  // `this.handleEvent(name, cb)` receives what a handler sent with `web/live/push-event`.
  //
  // An element whose subtree the hook owns should carry `data-update="ignore"`, or the next
  // server patch will morph the library's own DOM out from under it.
  const hookDefs = new Map();
  const missingHooks = new Set();

  class Hook {
    constructor(session, el, def, name) {
      this.el = el;
      this.name = name;
      this._session = session;
      this._handlers = new Map();
      // The def's methods become the instance's, so `this` inside them is this Hook — that
      // is what gives a hook body `this.el` and `this.pushEvent` alongside its own state.
      Object.assign(this, def);
    }

    // Send an event to the server. Routed by the nearest ancestor [data-cid] like every other
    // event, so a hook inside a LiveComponent reaches that component's handler, not the view's.
    pushEvent(event, payload = {}) {
      this._session.pushEvent(event, payload, nearestCid(this.el));
    }

    // Send to a specific component, named by a selector for an element inside it.
    pushEventTo(selector, event, payload = {}) {
      const target = document.querySelector(selector);
      this._session.pushEvent(event, payload, target ? nearestCid(target) : null);
    }

    // Receive what a handler sent with web/live/push-event.
    handleEvent(event, callback) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(callback);
    }

    removeHandleEvent(event) {
      this._handlers.delete(event);
    }

    _dispatch(event, payload) {
      const list = this._handlers.get(event);
      if (!list) return;
      // A throwing handler must not stop the others, nor the rest of the frame.
      for (const cb of list) {
        try { cb(payload); } catch (e) { console.error(`brood hook ${this.name}:`, e); }
      }
    }

    _call(phase) {
      if (typeof this[phase] !== "function") return;
      try { this[phase](); } catch (e) { console.error(`brood hook ${this.name}.${phase}:`, e); }
    }
  }

  // What the server rendered onto a hook element, as a string, so `updated` fires when the
  // server changed something and not on every unrelated patch. Attributes always count —
  // they are how a view passes data to a hook. The children count only when the framework is
  // the one that maintains them: under `data-update="ignore"` they belong to the hook, which
  // mutates them constantly, and comparing them would fire `updated` at the hook for its own
  // work.
  function hookSignature(el) {
    const attrs = Array.from(el.attributes)
      .map((a) => `${a.name}=${a.value}`)
      .sort()
      .join("|");
    return el.dataset.update === "ignore" ? attrs : `${attrs} ${el.innerHTML}`;
  }

  // ---- debounce and throttle ---------------------------------------------------------
  //
  // Without these the client pushes a frame per keystroke: `data-debounce="300"` waits for a
  // pause, `data-throttle="500"` rate-limits. `data-debounce="blur"` sends only when the field
  // is left. Debounce wins if both are set.
  //
  // Split out as a pure function — no DOM, no socket, no clock — because it is the part with
  // rules in it, and because Brood has no subprocess primitive to run a browser test from
  // `nest test`. `tests/js/timing_test.js` covers it under plain `node`.
  function decideSend(state, opts, now) {
    const { debounce, throttle, carriesValue } = opts;
    // "blur": hold until focusout flushes it, however long that is.
    if (debounce === "blur") return { action: "hold" };
    if (debounce !== null && debounce !== undefined) {
      return { action: "defer", delay: Math.max(0, debounce) };
    }
    if (throttle !== null && throttle !== undefined) {
      // `last` is null until this element has sent something. An explicit sentinel rather
      // than a 0, which would only read as "long ago" because `Date.now()` happens to be
      // large — true in a browser and not in a test, which is precisely the kind of thing
      // that works everywhere except where you are looking at it.
      if (state.last === null || state.last === undefined) return { action: "send" };
      const elapsed = now - state.last;
      if (elapsed >= throttle) return { action: "send" };
      // Inside the window, and the two kinds of event want opposite things.
      //
      // A throttled VALUE stream must end on the value the user stopped at: drop the last
      // event of a dragged slider and the server holds a position the user never chose, which
      // is a wrong answer rather than a coarse one. So the latest is deferred to the end of
      // the window — a trailing edge, which Phoenix's throttle does not have.
      //
      // A throttled ACTION must not happen more often than it was asked for. Replaying a
      // click late is not rate limiting, it is a second click. So it is dropped outright.
      return carriesValue
        ? { action: "defer", delay: throttle - elapsed }
        : { action: "drop" };
    }
    return { action: "send" };
  }

  // ---- data-on-<event>: any DOM event, not a fixed list ------------------------------
  //
  // `data-event` covers the three bindings a page mostly needs — click a control, type in a
  // field, submit a form — by inferring which from the element. Everything else needs saying:
  //
  //   [:input {:data-on-keydown "search" :data-keys "Enter"}]
  //   [:div   {:data-on-click-away "close"}]
  //   [:body  {:data-on-window-keydown "shortcut" :data-keys "Escape,/"}]
  //
  // One rule — `data-on-<dom event>="handler"` — rather than Phoenix's twelve separate
  // attributes (phx-keydown, phx-blur, phx-window-focus, …). Any event name works, so
  // `data-on-dblclick` and `data-on-paste` need nothing added here; the list below only
  // decides which types are CHEAP to discover, and `BroodLive.listen("wheel")` extends it.
  //
  // Two names are not DOM events. `click-away` fires when a click lands outside the element —
  // the dropdown-closing binding, which has no native equivalent. `window-<event>` binds on
  // the window rather than the element, for a shortcut that must work wherever focus is.
  const DEFAULT_EVENTS = [
    "click", "dblclick", "mousedown", "mouseup", "mouseover", "mouseout",
    "keydown", "keyup", "focus", "blur", "change", "input", "submit",
    "paste", "copy", "cut", "contextmenu", "click-away",
  ];
  const listenFor = new Set(DEFAULT_EVENTS);

  // The attribute for one binding, and the selector that finds every element carrying any
  // binding at all. Rebuilt when `listen` adds a type.
  const attrFor = (type) => `data-on-${type}`;
  let bindingSelector = "";
  function rebuildSelector() {
    bindingSelector = [...listenFor]
      .flatMap((t) => [
        `[${attrFor(t)}]`,
        `[${attrFor("window-" + t)}]`,
        `[data-js-${t}]`,
      ])
      .join(",");
  }
  rebuildSelector();

  // ---- data-js-<event>: client-side commands, no round trip --------------------------
  //
  // Opening a dropdown does not need the server to know. `data-js-click` runs a short list of
  // DOM operations locally, so a purely visual change costs no frame and no latency:
  //
  //   [:button {:data-js-click (live/js [[:toggle "#menu"]])} "Menu"]
  //   [:button {:data-on-click "save" :data-js-click (live/js [[:add-class "#form" "saving"]])}]
  //
  // Both families share one listener per event type, so an element may carry both and the
  // local change lands immediately while the server event is in flight.
  //
  // The value is JSON — a list of `[op, …args]` — because it is rendered by the server, and
  // `web/live/js` builds it so an app writes Brood rather than a string. A selector of `"this"`
  // means the element the binding is on.
  function runCommands(el, encoded) {
    let commands;
    try { commands = JSON.parse(encoded); } catch (_) {
      console.error("brood: data-js-* is not valid JSON", el, encoded);
      return;
    }
    if (!Array.isArray(commands)) return;
    for (const command of commands) {
      if (!Array.isArray(command) || command.length === 0) continue;
      const [op, selector, ...rest] = command;
      const targets = selector === "this" || selector === undefined
        ? [el]
        : Array.from(document.querySelectorAll(selector));
      for (const target of targets) runCommand(op, target, rest, el);
    }
  }

  function runCommand(op, target, args, source) {
    switch (op) {
      case "toggle": target.hidden = !target.hidden; break;
      case "show": target.hidden = false; break;
      case "hide": target.hidden = true; break;
      case "add-class": target.classList.add(...args); break;
      case "remove-class": target.classList.remove(...args); break;
      case "toggle-class": for (const c of args) target.classList.toggle(c); break;
      case "set-attr": target.setAttribute(args[0], args[1]); break;
      case "remove-attr": target.removeAttribute(args[0]); break;
      case "focus": target.focus(); break;
      case "blur": target.blur(); break;
      // An app's own JS decides what it means; the source element rides along so a listener
      // can tell which control asked.
      case "dispatch":
        target.dispatchEvent(new CustomEvent(args[0], {
          bubbles: true,
          detail: { ...(args[1] || {}), source },
        }));
        break;
      default: console.error(`brood: unknown data-js command "${op}"`, source);
    }
  }

  // Whether a keyboard event passes the element's `data-keys` filter. Without it a
  // "press Escape to close" binding is a frame per keystroke — the server filtering after the
  // fact is the cost this exists to avoid.
  function keyAllowed(el, event) {
    const wanted = el.dataset.keys;
    if (!wanted || !("key" in event)) return true;
    return wanted.split(",").some((k) => k.trim() === event.key);
  }

  // Whether an event is a VALUE (a point in a stream of what the user is choosing) or an
  // ACTION (a discrete thing they asked for). `decideSend` throttles the two oppositely — a
  // value gets a trailing send so the server ends on what the user stopped at, an action is
  // dropped so it never happens more times than it was asked for.
  //
  // Decided by the EVENT, not by the element. Asking the element — `el.value !== undefined`,
  // which is what this was — reads `""` off a `<button>` and calls a throttled click a value:
  // the click is then replayed at the end of the window, which is the second click the drop
  // path exists to prevent, on the most commonly throttled control there is.
  function carriesValue(event) {
    return event.type === "input" || event.type === "change";
  }

  // `data-params`, decoded. Guarded because it is author-supplied text arriving through an
  // attribute, and an unguarded `JSON.parse` inside a listener throws where the browser
  // swallows it — the event is simply lost, with nothing in the console to say a stray comma
  // is the reason a button stopped working.
  function parseParams(el) {
    if (!el.dataset || !el.dataset.params) return {};
    try {
      const parsed = JSON.parse(el.dataset.params);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      console.error("brood: data-params is not valid JSON", el, el.dataset.params);
      return {};
    }
  }

  // What a binding sends. A keyboard or mouse event carries the details a handler would
  // otherwise have no way to see; a control carries its value; `data-params` is merged over
  // both, so an explicit param always wins.
  function eventParams(el, event) {
    const params = {};
    if ("key" in event) {
      params.key = event.key;
      params.code = event.code;
      params.alt = event.altKey;
      params.ctrl = event.ctrlKey;
      params.shift = event.shiftKey;
      params.meta = event.metaKey;
    }
    if (el.value !== undefined && el.type !== "file") params.value = el.value;
    return { ...params, ...parseParams(el) };
  }

  // Read `data-debounce` / `data-throttle` off an element into `decideSend`'s options.
  // A non-numeric value parses to 0 rather than NaN — `data-debounce="fast"` should behave
  // like no delay, not like a timer that never fires.
  function timingOpts(el, carriesValue) {
    const d = el.dataset.debounce;
    const t = el.dataset.throttle;
    return {
      debounce: d === undefined ? null : (d === "blur" ? "blur" : (parseInt(d, 10) || 0)),
      throttle: t === undefined ? null : (parseInt(t, 10) || 0),
      carriesValue,
    };
  }

  class Session {
    constructor(path, container) {
      this.path = path;
      this.container = container;
      this.socket = null;
      this.connected = false;
      this.reconnectDelay = 250;
      this.reconnectTimer = null;
      // statics + their server-issued fingerprint, kept across a reconnect so the server can
      // skip re-sending the skeleton (see onopen / the "join" handler)
      this.statics = [];
      this.dynamics = [];
      this.staticsFingerprint = null;
      // Live uploads. `pendingUploads` holds the File objects a picker just produced, keyed
      // by a per-OFFER id — not by upload name, which loses a file: pick A, then pick B
      // again before the server has answered the first init, and one name maps to two
      // in-flight offers. The first `upload-ready` carries A's refs but would find B's
      // files, streaming B's bytes into A's entry, and the second would find nothing at all
      // and leave B sitting at 0% forever.
      // `uploads` holds one {cancelled} per in-flight transfer, keyed by ref, so a
      // server-side cancel can stop a send that is halfway through a large file.
      this.pendingUploads = new Map();
      this.nextOfferId = 1;
      this.uploads = new Map();
      // element → Hook instance, for the [data-hook] elements currently in this view, and
      // element → {timer, last, pending, signature} for debounce/throttle state. Both are
      // pruned after every patch, in `_afterPatch`: an element the server removed must not
      // keep a live timer or hold its own DOM node alive in a Map.
      this.hooks = new Map();
      this.timings = new Map();
      this.everConnected = false;
      // Form values captured when the socket drops, replayed after the rejoin patch — see
      // _snapshotForms. Null rather than left undefined so the state is declared here with
      // everything else the session carries.
      this.pendingRecovery = null;
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
        // Only on a RE-connect: a hook's `mounted` already ran for the first one, and
        // `reconnected` means "the gap you were told about has closed", which needs a gap.
        if (this.everConnected) this._callHooks("reconnected");
        this.everConnected = true;
        // Send join with current URL params, plus the fingerprint of the statics we still
        // hold from a previous connection. On a reconnect to the same view the server sees
        // a match and omits the statics from its join frame — they are the bulk of it (the
        // page's whole literal skeleton), so a flaky link stops re-downloading its own
        // markup on every drop. On a first connect there is nothing to claim, and after a
        // navigate or a hot-reloaded template the fingerprints differ and the server sends
        // them as usual, so we can never weave against a stale skeleton.
        const params = Object.fromEntries(new URLSearchParams(location.search));
        const join = { event: "join", params };
        if (this.staticsFingerprint) join.f = this.staticsFingerprint;
        this._send(join);
      };

      this.socket.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        this._handle(msg);
      };

      this.socket.onclose = () => {
        this.connected = false;
        refreshStatus();
        // Snapshot NOW, while the fields still hold what the user typed — the rejoin patch
        // that follows is built from a fresh mount and will overwrite them.
        this.pendingRecovery = this._snapshotForms();
        this._callHooks("disconnected");
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

    // ---- hook lifecycle -------------------------------------------------------------

    _callHooks(phase) {
      for (const hook of this.hooks.values()) hook._call(phase);
    }

    // One querySelectorAll per patch over the known binding attributes, and a listener
    // attached for each type actually present. `_bindType` is idempotent, so re-finding a
    // type that is already bound costs a Set lookup.
    _bindNewEventTypes() {
      if (!this._bindType || !bindingSelector) return;
      this.container.querySelectorAll(bindingSelector).forEach((el) => {
        for (const name of Object.keys(el.dataset)) {
          // dataset camel-cases: data-on-window-keydown → onWindowKeydown, data-js-click →
          // jsClick. Both families want the same listener, so both are read here.
          const prefixed = (name.startsWith("on") && name !== "on")
            || (name.startsWith("js") && name !== "js");
          if (!prefixed) continue;
          const type = name
            .slice(2)
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .toLowerCase();
          this._bindType(type);
        }
      });
    }

    // Run after every patch. Mounts hooks that have appeared, tells the ones whose
    // server-rendered content changed, destroys the ones that are gone, and prunes timing
    // state for elements that left with them.
    _afterPatch() {
      this._bindNewEventTypes();
      this._restoreForms();
      const live = new Set();
      this.container.querySelectorAll("[data-hook]").forEach((el) => {
        const name = el.dataset.hook;
        const def = hookDefs.get(name);
        if (!def) {
          // Once per name: a hook that is not registered is almost always a typo or a script
          // that has not loaded, and repeating it on every patch buries it.
          if (!missingHooks.has(name)) {
            missingHooks.add(name);
            console.error(`brood: no hook registered as "${name}" — BroodLive.hook("${name}", {…})`);
          }
          return;
        }
        // A hook needs a stable identity across patches, and the morph reconciles by
        // data-key/id. Without one the element can be rebuilt rather than reused, so the hook
        // is destroyed and re-mounted on unrelated updates — the library it wraps is torn down
        // mid-use and the cause is nowhere near the symptom. Refuse rather than half-work.
        if (!el.id && el.dataset.key === undefined) {
          console.error(`brood: hook "${name}" needs an id (or data-key) to keep its identity across patches`, el);
          return;
        }
        live.add(el);
        let hook = this.hooks.get(el);
        if (!hook) {
          hook = new Hook(this, el, def, name);
          this.hooks.set(el, hook);
          hook.signature = hookSignature(el);
          hook._call("mounted");
          return;
        }
        const signature = hookSignature(el);
        if (signature !== hook.signature) {
          hook.signature = signature;
          hook._call("updated");
        }
      });
      for (const [el, hook] of this.hooks) {
        if (!live.has(el)) {
          this.hooks.delete(el);
          hook._call("destroyed");
        }
      }
      for (const [el, state] of this.timings) {
        if (!this.container.contains(el)) {
          clearTimeout(state.timer);
          this.timings.delete(el);
        }
      }
    }

    // ---- form recovery across a reconnect -------------------------------------------
    //
    // A dropped socket re-mounts the view, so the server's next render is built from a fresh
    // `mount` and knows nothing about what the user had typed — and the patch that carries it
    // overwrites the fields. Half a filled-in form disappears because the wifi blinked.
    //
    // `data-recover="validate"` on a form fixes it, and the event it names is the author's
    // choice deliberately: the obvious thing is to replay the form's own submit, and that
    // would place an order twice. A recover handler is one the author has decided is safe to
    // replay, which is not a property this can infer.
    //
    // The ordering is the whole trick. Values are snapshotted when the socket CLOSES, because
    // by the time the rejoin patch lands the DOM no longer holds them.
    _snapshotForms() {
      const snapshot = {};
      this.container.querySelectorAll("form[data-recover]").forEach((form) => {
        if (!form.id) {
          console.error("brood: a form with data-recover needs an id to be found again", form);
          return;
        }
        const data = {};
        for (const [field, value] of new FormData(form)) data[field] = value;
        snapshot[form.id] = { event: form.dataset.recover, data };
      });
      return Object.keys(snapshot).length > 0 ? snapshot : null;
    }

    // Run after the first patch that follows a reconnect: put the values back, then tell the
    // server, so its model agrees with what is on screen rather than with a fresh mount.
    _restoreForms() {
      const snapshot = this.pendingRecovery;
      this.pendingRecovery = null;
      if (!snapshot) return;
      for (const id of Object.keys(snapshot)) {
        const form = this.container.querySelector(`form[id="${id}"]`);
        if (!form) continue;
        const { event, data } = snapshot[id];
        for (const field of Object.keys(data)) {
          // Strings only. `new FormData(form)` yields a File for a file input, and assigning
          // one to `.value` throws — inside `_afterPatch`, on the rejoin patch, so the hook
          // sync and the timing prune below it never ran either. A file cannot be restored
          // from a snapshot anyway; web/upload owns that channel.
          if (typeof data[field] !== "string") continue;
          const input = form.elements[field];
          if (input && typeof input.value === "string") input.value = data[field];
        }
        this.pushEvent(event, data, nearestCid(form));
      }
    }

    // ---- debounce / throttle --------------------------------------------------------

    _timingState(el) {
      let state = this.timings.get(el);
      if (!state) {
        state = { timer: null, last: null, pending: null };
        this.timings.set(el, state);
      }
      return state;
    }

    // Run `send` subject to the element's data-debounce/data-throttle. `carriesValue` says
    // whether this event carries what the user typed or chose (input/change) as opposed to
    // being an action (click/submit) — see `decideSend` for why the two are throttled
    // differently.
    _scheduleSend(el, carriesValue, send) {
      const state = this._timingState(el);
      const decision = decideSend(state, timingOpts(el, carriesValue), Date.now());
      if (decision.action === "drop") return;
      if (decision.action === "send") {
        state.last = Date.now();
        send();
        return;
      }
      // "hold" (blur) and "defer" both park the latest send; only defer arms a timer.
      state.pending = send;
      clearTimeout(state.timer);
      state.timer = null;
      if (decision.action === "defer") {
        state.timer = setTimeout(() => {
          state.timer = null;
          state.pending = null;
          state.last = Date.now();
          send();
        }, decision.delay);
      }
    }

    // Send anything parked for `el` (or for any element inside it) right now.
    //
    // Submitting flushes the form's fields first, and that is not a nicety: type into a field
    // debounced at 300ms and hit enter, and without this the submit overtakes the change the
    // user just made — the server validates against a value it has not been told about, and
    // the form is wrong in a way that depends on typing speed.
    _flushPending(root) {
      for (const [el, state] of this.timings) {
        if (!state.pending) continue;
        if (el !== root && !root.contains(el)) continue;
        clearTimeout(state.timer);
        state.timer = null;
        const send = state.pending;
        state.pending = null;
        state.last = Date.now();
        send();
      }
    }

    // ---- live uploads -------------------------------------------------------------
    //
    // Three JSON frames and a binary channel. We describe the chosen files, the server
    // answers with a ref per accepted one, and each file then goes up as binary frames of
    // `[refLength][ref][bytes]`. Binary, not base64 in JSON: the transport already carries
    // bytes, and encoding them would cost a third more on the wire plus a decode per chunk.

    _offerFiles(input) {
      const name = input.dataset.upload;
      const files = [...input.files];
      if (!files.length) return;
      const offer = String(this.nextOfferId++);
      this.pendingUploads.set(offer, files);
      this._send({
        event: "upload-init",
        name,
        offer,
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      });
      // Clear the picker so choosing the SAME file again after a cancel still fires `change`.
      // Without this the second attempt is silent, which reads as the upload being broken.
      input.value = "";
    }

    async _uploadFile(ref, file) {
      const state = { cancelled: false };
      this.uploads.set(ref, state);
      const refBytes = new TextEncoder().encode(ref);
      // Comfortably under the server's 65535-byte frame cap, with room for the ref header.
      const CHUNK = 32768;
      try {
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          if (state.cancelled) return;
          const slice = await file.slice(offset, offset + CHUNK).arrayBuffer();
          if (state.cancelled) return;
          await this._waitForDrain(state);
          if (state.cancelled) return;
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
          const frame = new Uint8Array(1 + refBytes.length + slice.byteLength);
          frame[0] = refBytes.length;
          frame.set(refBytes, 1);
          frame.set(new Uint8Array(slice), 1 + refBytes.length);
          this.socket.send(frame);
        }
        if (!state.cancelled) this._send({ event: "upload-done", ref });
      } catch (_) {
        // A read error (the file was moved or the device unplugged mid-upload) leaves the
        // entry unfinished on the server, where it shows as still in progress and is swept
        // when the session ends. Nothing useful to do from here.
      } finally {
        this.uploads.delete(ref);
      }
    }

    // Backpressure. `socket.send` never blocks: without this the whole file is read into the
    // browser's send buffer as fast as the disk can produce it, so a large upload is held in
    // memory twice over and the progress bar — which reports what the SERVER has — lags the
    // apparent activity by the length of that buffer.
    async _waitForDrain(state) {
      const LIMIT = 1048576;
      while (
        this.socket &&
        this.socket.readyState === WebSocket.OPEN &&
        this.socket.bufferedAmount > LIMIT &&
        !state.cancelled
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    _handle(msg) {
      if (msg.event === "join") {
        // Full render: the static skeleton plus every dynamic slot. We keep both, so a
        // later "diff" only needs to carry the slots that changed.
        //
        // `s` is ABSENT when the server accepted the fingerprint we sent — it is telling us
        // our cached statics are still current, so keep them. Guard on the fingerprint
        // actually matching rather than on `s` being absent alone: without that, a frame
        // that omitted the statics for any other reason would leave us weaving dynamics
        // into whatever skeleton we happened to be holding.
        if (msg.s) {
          this.statics = msg.s;
          this.staticsFingerprint = msg.f || null;
        } else if (!msg.f || msg.f !== this.staticsFingerprint) {
          // No statics and no matching claim — we have nothing coherent to render against.
          // A full page load re-fetches the server-rendered HTML and starts clean.
          location.reload();
          return;
        }
        this.dynamics = msg.d || [];
        this._patch(this._assemble());
      } else if (msg.event === "diff") {
        // Minimal update: a map of {slotIndex: newValue} for the dynamics that changed.
        // A value is a string (scalar slot), a full comprehension `{__comp__:[…]}` or
        // component `{__kslot__,s,d}`, or a per-slot diff of either (`{__cdiff__:{i:html},n}`
        // / `{__kdiff__:{i:value},cid}`) — _applySlot folds each into
        // our dynamics array. Then re-interleave with the (unchanged) statics and morph.
        const d = msg.d || {};
        for (const k in d) this.dynamics[k] = this._applySlot(this.dynamics[k], d[k]);
        this._patch(this._assemble());
      } else if (msg.event === "redirect") {
        // The navigate target isn't a live view (or the server forced a full load via
        // push-redirect) — fall back to a full page load.
        window.location.href = msg.path;
      } else if (msg.event === "nav") {
        // Server-initiated live navigation (push-navigate): drive the same socket-side
        // navigation a data-nav click would, updating the address bar and morphing in place.
        this.navigate(msg.path);
      } else if (msg.event === "push") {
        // Server-initiated client effect (push-event): dispatch a CustomEvent app JS can
        // listen for — `brood:event` with { name, payload } — to do imperative work
        // (focus a field, start an animation) that a re-render can't express.
        // Hooks that registered `handleEvent(name, cb)` get it first, then the CustomEvent
        // for page script that is not in a hook. Both, not one or the other: the event
        // channel predates hooks and pages use it directly.
        for (const hook of this.hooks.values()) hook._dispatch(msg.name, msg.payload);
        document.dispatchEvent(new CustomEvent("brood:event", {
          detail: { name: msg.name, payload: msg.payload },
        }));
      } else if (msg.event === "title") {
        // Server-initiated title change (push-title). The head is deliberately NOT a
        // diffable region — morphing it can re-fetch a stylesheet (a flash of unstyled
        // content on a title change) and re-execute a script — and the title is the one
        // part of it a live view actually changes, with a native setter for exactly this.
        document.title = msg.title;
      } else if (msg.event === "upload-ready") {
        // The server validated the files we offered and issued a ref per accepted one, in the
        // order we offered them, with null where a file was refused. A refused file needs no
        // action here — it is already in the model with its reason, and the re-render that
        // came with this message is showing it.
        // Keyed by the offer this answers, not by upload name — see the constructor.
        const files = this.pendingUploads.get(msg.offer) || [];
        this.pendingUploads.delete(msg.offer);
        (msg.refs || []).forEach((ref, i) => {
          if (ref && files[i]) this._uploadFile(ref, files[i]);
        });
      } else if (msg.event === "stream-delete") {
        // A handler removed items from a stream. The server is not holding the collection, so
        // it cannot express a removal by rendering what is left — it names the ids instead.
        for (const id of msg.ids || []) {
          const node = this.container.querySelector(`[id="${id}"],[data-key="${id}"]`);
          if (node && node.parentNode) node.parentNode.removeChild(node);
        }
      } else if (msg.event === "upload-cancel") {
        // A handler called upload/cancel. The server already ignores chunks for a dropped
        // ref, so this is not needed for correctness — it is needed so a cancelled 40MB
        // upload stops consuming the user's bandwidth the moment they click the ×.
        const state = this.uploads.get(msg.ref);
        if (state) state.cancelled = true;
      } else if (msg.event === "reload-css") {
        // A stylesheet rebuilt (asset watcher) — hot-swap every <link> in place,
        // preserving live state. No full reload, no flash: we re-stamp the href with
        // a fresh cache-buster so the browser refetches the updated CSS.
        reloadStylesheets();
      }
    }

    // The HTML for one dynamic slot value:
    //   {__comp__:[items]}        a comprehension — join its per-item HTML
    //   {__kslot__, s, d}         a LiveComponent — weave its OWN statics and dynamics,
    //                             exactly as _assemble does for the top level. Its wrapper
    //                             <div data-cid> is baked into s[0]/s[n] server-side, so
    //                             there is no wrapper rule here to drift from the server's.
    //                             Recursive: a component's inner slots may be comprehensions
    //                             or further components.
    //   anything else             already an HTML string; null/undefined render empty.
    _slotHtml(v) {
      // Items are usually HTML strings, but a `(for …)` over bare components makes each item
      // that component's own slot — so each is rendered before joining, not concatenated raw.
      if (v && v.__comp__) return v.__comp__.map((item) => this._slotHtml(item)).join("");
      if (v && v.__kslot__) return this._weave(v.s || [], v.d || []);
      return v == null ? "" : v;
    }

    // Interleave statics with rendered dynamics: s0 + d0 + s1 + d1 + ... + sn.
    // (statics has one more entry than dynamics.)
    _weave(s, d) {
      let out = "";
      for (let i = 0; i < s.length; i++) {
        out += s[i];
        if (i < d.length) out += this._slotHtml(d[i]);
      }
      return out;
    }

    // Fold a diff value for slot `k` onto its previous value.
    //   {__cdiff__, n}   patch the previous comprehension's item array (set changed items,
    //                    grow/shrink to n)
    //   {__kdiff__, cid} patch a LiveComponent's own dynamics, keeping its statics — the
    //                    component shipped only the inner slots that changed. Folded
    //                    recursively, so an inner comprehension still diffs per item.
    //   anything else    (a string, or a full {__comp__} / {__kslot__}) replaces the slot
    _applySlot(prev, val) {
      if (val && val.__cdiff__ !== undefined) {
        const items = (prev && prev.__comp__) ? prev.__comp__.slice() : [];
        const changed = val.__cdiff__ || {};
        // Folded, not assigned: an item that is a component ships a {__kdiff__} patch of its
        // own inner slots rather than its whole self, and that has to be applied against the
        // previous item the same way a top-level slot is. A string item takes _applySlot's
        // final branch and simply replaces, exactly as before.
        for (const j in changed) items[j] = this._applySlot(items[j], changed[j]);
        items.length = val.n; // grow (new items are all in `changed`) or shrink
        return { __comp__: items };
      }
      if (val && val.__kdiff__ !== undefined) {
        // Without a previous component slot there are no statics to weave against, so the
        // patch is unusable — keep what we have rather than render a half component. The
        // server only sends a __kdiff__ when its own previous slot was the same cid, so this
        // is a defensive branch, not an expected one.
        if (!prev || !prev.__kslot__ || prev.cid !== val.cid) return prev;
        const d = (prev.d || []).slice();
        const changed = val.__kdiff__ || {};
        for (const j in changed) d[j] = this._applySlot(d[j], changed[j]);
        return { __kslot__: true, cid: prev.cid, s: prev.s, d };
      }
      return val;
    }

    // Assemble the full HTML by interleaving statics with the current dynamics:
    // s0 + d0 + s1 + d1 + ... + sn  (statics has one more entry than dynamics).
    _assemble() {
      return this._weave(this.statics || [], this.dynamics || []);
    }

    // Morph the container's content to the new HTML in place (so focus/caret survive
    // a re-render). morphChildren reconciles by key (data-key/id) when every child
    // carries one — so a reorder/insert above an interactive element keeps its
    // identity and transient state — and falls back to index matching otherwise.
    _patch(html) {
      // Before the morph — see beginLoading. Every server update reaches the DOM through
      // here, so this is the one place a loading control needs restoring.
      endLoading();
      const next = document.createElement("div");
      next.innerHTML = html;
      morphChildren(this.container, next);
      // After the DOM settles, never before: a hook's `mounted` expects its element to be in
      // the document and finished, and `updated` is about what the patch just did.
      this._afterPatch();
    }

    // Called by event bindings to push a user event to the server. `cid` (a live
    // component's id, from the nearest ancestor [data-cid]) routes the event to that
    // component's own handle-event server-side instead of the parent view's — see
    // web/component and web/live's session-dispatch.
    pushEvent(name, params = {}, cid = null) {
      this._send({ event: "event", name, params, ...(cid ? { cid } : {}) });
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

    // Live-patch: update the URL/params on the *current* view, no remount — the light
    // sibling of navigate (Phoenix's push_patch vs push_navigate/live_redirect). Only the
    // query string is expected to change; the path is carried along for the history entry
    // but the server never re-runs mount/lookup-live for a patch.
    patch(href, push = true) {
      const url = new URL(href, location.origin);
      const params = Object.fromEntries(url.searchParams);
      if (push) history.pushState({ broodPatch: true }, "", url.pathname + url.search);
      this._send({ event: "patch", params });
    }
  }

  // The stable identity of a child for keyed morphing: its data-key, else its id, else null.
  function keyOf(node) {
    if (node.nodeType !== 1) return null;
    const k = node.getAttribute("data-key");
    if (k !== null) return k;
    const id = node.getAttribute("id");
    return id !== null ? id : null;
  }

  // Same node "shape" — same type, and for elements the same tag (so we morph in place
  // rather than swap).
  function sameNode(a, b) {
    return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
  }

  // DOM morphing. If every new child carries a key (data-key/id), reconcile by key so a
  // reorder MOVES the existing node (preserving its focus/caret/scroll) instead of
  // rebuilding it. Otherwise fall back to the index walk — identical behaviour to before,
  // so unkeyed views are unaffected.
  function morphChildren(current, next) {
    const nxt = Array.from(next.childNodes);
    // `data-update="stream"`: the server sent only what CHANGED, not the whole collection —
    // it is not holding the collection. Merge rather than reconcile. See morphStream.
    const mode = current.dataset ? current.dataset.update : null;
    if (mode === "stream" || mode === "stream-reset") {
      morphStream(current, nxt, mode === "stream-reset");
      return;
    }
    if (nxt.length > 0 && nxt.every((n) => keyOf(n) !== null)) {
      morphKeyed(current, nxt);
    } else {
      morphIndexed(current, Array.from(current.childNodes), nxt);
    }
  }

  // Stream merge: the container's existing children are kept, and each incoming child is
  // either morphed onto the one with its key or inserted.
  //
  // This is what lets a 50,000-row feed cost the server nothing per session. Everywhere else
  // the client re-assembles the whole document from statics + dynamics and morphs, which
  // requires the server to hold every item in order to render it. A stream container is the
  // one place that contract is relaxed: the server renders the items it was handed since the
  // last patch and forgets them, and this keeps what is already on screen.
  //
  // `reset` empties first — for a filter change or a fresh page of results, where "what
  // changed" is "all of it". The server asks by rendering `data-update="stream-reset"` for
  // that one patch, which arrives as an attribute and so is already in place by the time the
  // children are merged (morphElement syncs attributes first).
  //
  // An item is positioned by `data-stream-at`: absent or -1 appends, 0 prepends, n inserts
  // before the nth child. Items already present are morphed in place and NOT moved, so a
  // re-render of an existing row does not make the list jump.
  function morphStream(current, nxt, reset) {
    if (reset) while (current.firstChild) current.removeChild(current.firstChild);
    const existing = new Map();
    for (let n = current.firstChild; n; n = n.nextSibling) {
      const k = keyOf(n);
      if (k !== null) existing.set(k, n);
    }
    for (const nc of nxt) {
      if (nc.nodeType !== 1) continue; // whitespace between rendered items
      const key = keyOf(nc);
      const match = key === null ? null : existing.get(key);
      if (match && sameNode(match, nc)) {
        morphElement(match, nc);
        continue;
      }
      const node = nc.cloneNode(true);
      // Same key, different tag: replace rather than insert. Without this the old node stays
      // — nothing here removes anything, by design — and the container ends up holding two
      // rows with one id, which is a duplicate the client can never resolve and a `delete`
      // that only ever removes one of them.
      if (match) {
        match.parentNode.replaceChild(node, match);
        // `set`, not `delete` — the replacement IS now the node holding this key, and the
        // lookup was taken before the loop. Clearing it made the same batch's second mention
        // of this id miss and append, producing exactly the duplicate the insert branch below
        // records itself to avoid.
        existing.set(key, node);
        continue;
      }
      // `children`, not `childNodes`: the position is an index among ROWS, and childNodes
      // counts any whitespace text node between them, which would shift every insert after
      // the first by however much the renderer happened to emit.
      const at = node.getAttribute("data-stream-at");
      const index = at === null ? -1 : parseInt(at, 10);
      const rows = current.children;
      if (index < 0 || index >= rows.length) current.appendChild(node);
      else current.insertBefore(node, rows[index]);
      // Record it: two items with the same id in ONE batch would otherwise both miss the
      // lookup — which was taken before the loop — and both be inserted, leaving a duplicate
      // the merge can never resolve afterwards.
      if (key !== null) existing.set(key, node);
    }
  }

  // insertBefore on a node that's already in the document is spec'd as an in-place move —
  // but if the focused element is a *descendant* of that node (not the node itself), some
  // browsers still blur it, even though the element is reused rather than recreated (verified:
  // a reorder that happens to leave the focused row's relative position unchanged never
  // blurs it; one that actually needs to reposition that row does — every time). Save and
  // restore focus (and, for a text input, the caret/selection) around the move so a keyed
  // reorder never steals focus out of a field the user is typing in.
  function moveKeepingFocus(parent, node, pos) {
    const active = document.activeElement;
    const refocus = active && node !== active && node.contains(active);
    const isTextField = refocus && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    const selStart = isTextField ? active.selectionStart : null;
    const selEnd = isTextField ? active.selectionEnd : null;
    parent.insertBefore(node, pos);
    if (refocus && document.activeElement !== active) {
      active.focus();
      if (isTextField && selStart !== null) active.setSelectionRange(selStart, selEnd);
    }
  }

  // Keyed reconcile: match new children to existing ones by key, moving reused nodes into
  // order and cloning genuinely new ones. A `placed` set drives removal, so it's robust to
  // moves, inserts, deletes, and a same-key tag change.
  function morphKeyed(parent, nxt) {
    const keyed = new Map();
    for (let n = parent.firstChild; n; n = n.nextSibling) {
      const k = keyOf(n);
      if (k !== null) keyed.set(k, n);
    }
    const placed = new Set();
    let pos = parent.firstChild;
    for (const nc of nxt) {
      const match = keyed.get(keyOf(nc));
      let node;
      if (match && sameNode(match, nc)) {
        keyed.delete(keyOf(nc));
        morphElement(match, nc);   // update the existing node in place
        node = match;
      } else {
        node = nc.cloneNode(true);  // new key, or key reused with a different tag
      }
      placed.add(node);
      if (pos === node) {
        pos = pos.nextSibling;      // already in the right spot
      } else {
        moveKeepingFocus(parent, node, pos);  // move/insert ahead of the current cursor
      }
    }
    // Drop every original node we didn't reuse (leftover keys, removed items, tag swaps).
    for (let n = parent.firstChild; n; ) {
      const ns = n.nextSibling;
      if (!placed.has(n)) parent.removeChild(n);
      n = ns;
    }
  }

  // Index morph: walk children by position, updating text/attrs in place and
  // inserting/removing at the tail. The original (non-keyed) algorithm.
  function morphIndexed(current, cur, nxt) {
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
    // `data-update="ignore"`: the server rendered this element's opening tag and nothing
    // inside it. Attributes still sync — that is how a view passes fresh data to a hook — but
    // the children belong to whatever owns them here.
    //
    // Without this, hooks are close to unusable: a chart's canvas, a map's tiles, an editor's
    // generated DOM all get morphed back to the empty container the server rendered on the
    // next unrelated update, and the library is left holding detached nodes. The server has
    // no idea what is in there and should not be asked to guess.
    if (cur.dataset && cur.dataset.update === "ignore") return;
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

  // The nearest ancestor live-component id (web/component), if `el` sits inside one —
  // routes the event server-side to that component's own handle-event.
  // ---- data-disable-with: a button that says it is working -------------------------
  //
  // Phoenix's phx-disable-with. A control carrying `data-disable-with="Saving…"` is disabled
  // and shows that text from the moment it is clicked until the server's next patch lands.
  // Without it the only feedback for a round trip is nothing at all, and the usual result is
  // a second click and a duplicate event.
  //
  // Restoring happens BEFORE the patch is morphed in, never after: the server's new HTML is
  // diffed against the element as the app rendered it, not against the placeholder we put
  // there. Restoring afterwards would fight the morph and could leave the placeholder on
  // screen when the re-render happened not to touch that node.
  const loading = new Map();

  // `brood-loading` on the element whose event is in flight, and on the live container while
  // any is — so "dim the form while it saves" and "show a spinner on this button" are both
  // plain CSS with nothing per-view. Removed by `endLoading`, which every patch runs through.
  //
  // Two classes rather than Phoenix's per-binding set (phx-click-loading, phx-submit-loading,
  // phx-change-loading, …): the element already says which binding it carries, so a selector
  // that wants to distinguish them can say `[data-event].brood-loading` and the framework does
  // not need a name per case.
  const inFlight = new Set();

  function markLoading(el) {
    if (!el || !el.classList) return;
    el.classList.add("brood-loading");
    inFlight.add(el);
    const root = el.closest("[data-live]");
    if (root) root.classList.add("brood-loading");
  }

  function clearLoadingClasses() {
    for (const el of inFlight) {
      if (el.classList) el.classList.remove("brood-loading");
      const root = el.closest ? el.closest("[data-live]") : null;
      if (root) root.classList.remove("brood-loading");
    }
    inFlight.clear();
  }

  function beginLoading(el) {
    markLoading(el);
    if (!el) return;
    const label = el.dataset.disableWith;
    if (label == null || loading.has(el)) return;
    loading.set(el, { html: el.innerHTML, disabled: el.disabled });
    el.disabled = true;
    el.setAttribute("aria-busy", "true");
    // textContent, not innerHTML: the label is author-supplied but flows through an
    // attribute, and a control's loading text has no reason to carry markup.
    el.textContent = label;
  }

  function endLoading() {
    for (const [el, prev] of loading) {
      el.innerHTML = prev.html;
      el.disabled = prev.disabled;
      el.removeAttribute("aria-busy");
    }
    loading.clear();
    clearLoadingClasses();
  }

  // Where an event goes. By default the nearest enclosing LiveComponent, so a control inside
  // one reaches that component's handler rather than the view's — which is what the markup
  // around it implies.
  //
  // `data-target` overrides it, in the two directions that were otherwise unreachable:
  //   data-target="view"      send to the view, from inside a component
  //   data-target="#some-id"  send to the component containing that element, from outside it
  function nearestCid(el) {
    const target = el.dataset ? el.dataset.target : null;
    if (target === "view") return null;
    if (target) {
      const other = document.querySelector(target);
      if (!other) {
        console.error(`brood: data-target="${target}" matches no element`, el);
        return null;
      }
      return nearestCidOf(other);
    }
    return nearestCidOf(el);
  }

  function nearestCidOf(el) {
    const cidEl = el.closest("[data-cid]");
    return cidEl ? cidEl.dataset.cid : null;
  }

  // Wire up all [data-event] elements inside a container.
  function bindEvents(container, session) {
    // Params an event carries: `data-params` merged under the control's current value for the
    // events that have one. Read at SEND time, not at schedule time, so a debounced field
    // sends what the user finished typing rather than the first character of it.
    const valueParams = (el) => ({ value: el.value, ...parseParams(el) });

    container.addEventListener("click", (e) => {
      const el = e.target.closest("[data-event]");
      if (!el || !container.contains(el)) return;
      e.preventDefault();
      const name = el.dataset.event;
      // A click is an ACTION: `beginLoading` runs only when the event is actually going, or a
      // throttled button would sit disabled waiting for a round trip that was dropped.
      session._scheduleSend(el, false, () => {
        beginLoading(el);
        session.pushEvent(name, parseParams(el), nearestCid(el));
      });
    });

    container.addEventListener("change", (e) => {
      const el = e.target;
      // A file input declared by web/upload's file-input. It is handled here rather than
      // pushed as an ordinary event because the value the server needs is not the input's
      // `value` — it is the bytes, and those go up their own channel.
      if (el.dataset.upload) {
        session._offerFiles(el);
        return;
      }
      if (!el.dataset.event) return;
      const name = el.dataset.event;
      session._scheduleSend(el, true, () => {
        markLoading(el);
        session.pushEvent(name, valueParams(el), nearestCid(el));
      });
    });

    // Fire on every keystroke (not just on blur, which is what "change" gives) so a
    // [data-event] input drives live as-you-type feedback. The server re-render morphs
    // in place, so the field keeps its focus and caret — as long as the view doesn't
    // render a fighting `value` attribute (let the DOM own what the user typed).
    //
    // "Every keystroke" is the default and not always the right one: put `data-debounce="300"`
    // on the field and this waits for a pause instead, which is what a validation round trip
    // or a search-as-you-type wants.
    container.addEventListener("input", (e) => {
      const el = e.target;
      if (!el.dataset.event) return;
      const name = el.dataset.event;
      session._scheduleSend(el, true, () => {
        markLoading(el);
        session.pushEvent(name, valueParams(el), nearestCid(el));
      });
    });

    // Leaving a field flushes whatever it was holding — both `data-debounce="blur"`, which
    // waits for exactly this, and a numeric debounce whose timer has not run out. A user who
    // types and tabs away has finished with that field; making them wait out the timer to see
    // the result reads as lag.
    // Gated on having something parked, not on carrying `data-event`: the binding might be
    // `data-on-input`, and checking the wrong attribute meant `data-debounce="blur"` on such a
    // field never fired at all — the one thing that attribute is for, silently absent.
    container.addEventListener("focusout", (e) => {
      if (e.target && session.timings.has(e.target)) session._flushPending(e.target);
    });

    // ---- data-on-<event> bindings ---------------------------------------------------
    //
    // Listeners are attached lazily, one per event type per session, the first time a patch
    // renders an element that wants it — so a page with no `data-on-mouseover` never pays for
    // a mouseover listener, which on a busy pointer is the difference between free and not.
    //
    // Attached with `capture: true` so focus and blur are reachable by delegation at all:
    // neither bubbles, and both are in the capture path. `mouseenter`/`mouseleave` do not
    // propagate in either phase — spell those `mouseover`/`mouseout`.
    const bound = new Set();

    const fire = (el, handler, event) => {
      if (!keyAllowed(el, event)) return;
      // A submit or a click on a link has a DEFAULT the browser performs on top of whatever
      // we do — a native form post, a navigation — and either tears the socket down and
      // reloads the page. The dedicated `data-event` handlers prevent it; this generic one
      // reached the same elements through `data-on-submit` / `data-on-click` and did not, so
      // the binding pushed its event and then destroyed the session that was about to handle
      // it. Submitting also flushes the form's debounced fields first, which is the guarantee
      // docs/client.md makes and which only the dedicated path was keeping.
      if (event.type === "submit") {
        event.preventDefault();
        session._flushPending(el);
      } else if (event.type === "click" && el.closest("a[href]")) {
        event.preventDefault();
      }
      session._scheduleSend(el, carriesValue(event), () => {
        beginLoading(el);
        session.pushEvent(handler, eventParams(el, event), nearestCid(el));
      });
    };

    session._bindType = (type) => {
      if (bound.has(type)) return;
      bound.add(type);

      // Not a DOM event: a click anywhere that is not inside the bound element. Already
      // document-wide, so `window-click-away` means the same thing and is handled here rather
      // than falling through to `window.addEventListener("click-away")`, which would bind an
      // event that does not exist and silently never fire.
      if (type === "click-away" || type === "window-click-away") {
        const attr = attrFor(type);
        document.addEventListener("click", (e) => {
          container.querySelectorAll(`[${attr}]`).forEach((el) => {
            if (!el.contains(e.target)) fire(el, el.getAttribute(attr), e);
          });
        }, true);
        return;
      }

      if (type.startsWith("window-")) {
        const domType = type.slice(7);
        window.addEventListener(domType, (e) => {
          container.querySelectorAll(`[${attrFor(type)}]`).forEach((el) => {
            fire(el, el.getAttribute(attrFor(type)), e);
          });
        }, true);
        return;
      }

      container.addEventListener(type, (e) => {
        if (!e.target.closest) return;
        // Local commands first: a toggle should land immediately, not after the round trip
        // it may be accompanying.
        const jsEl = e.target.closest(`[data-js-${type}]`);
        if (jsEl && container.contains(jsEl)) {
          runCommands(jsEl, jsEl.getAttribute(`data-js-${type}`));
        }
        const el = e.target.closest(`[${attrFor(type)}]`);
        if (!el || !container.contains(el)) return;
        fire(el, el.getAttribute(attrFor(type)), e);
      }, true);
    };

    container.addEventListener("submit", (e) => {
      const form = e.target;
      if (!form.dataset.event) return;
      e.preventDefault();
      const name = form.dataset.event;
      // Flush the form's debounced fields BEFORE reading it — see `_flushPending`. Without
      // this a field debounced at 300ms and an immediate enter send in the wrong order, and
      // the server validates a value it was never told about.
      session._flushPending(form);
      const data = Object.fromEntries(new FormData(form));
      // the submitter if it asked, else any submit control in the form that did
      session._scheduleSend(form, false, () => {
        beginLoading(e.submitter || form.querySelector("[data-disable-with]"));
        session.pushEvent(name, data, nearestCid(form));
      });
    });
  }

  // Live navigation wiring (set up once, document-wide):
  //  - a click on an `<a data-nav href="…">` is live-navigated over the open socket
  //    instead of reloading the page (full remount, a different view) — but only if a
  //    live session exists and is connected; otherwise the browser does its normal
  //    navigation (a plain page has no socket, so its data-nav links just load).
  //  - a click on an `<a data-patch href="…">` is live-*patched* instead — same view,
  //    just new params (handle-params), no remount. Same connected-socket gating.
  //  - back/forward (popstate) replays a navigate or a patch depending on which one
  //    pushed that history entry (the `broodNav`/`broodPatch` state flag).
  function setupNavigation() {
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest("a[data-nav], a[data-patch]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || a.target === "_blank") return;
      // Only hijack same-origin links when we actually have a live socket to use.
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return;
      if (!navSession || !navSession.connected) return; // let the browser navigate
      e.preventDefault();
      if (a.hasAttribute("data-patch")) navSession.patch(url.pathname + url.search);
      else navSession.navigate(url.pathname + url.search);
    });

    window.addEventListener("popstate", (e) => {
      if (!navSession || !navSession.connected) return;
      if (e.state && e.state.broodPatch) {
        navSession.patch(location.pathname + location.search, false);
      } else {
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

  // Register one hook, or several at once. Call before the page mounts — a `<script>` above
  // the live container, or anything that runs on DOMContentLoaded ahead of the auto-mount:
  //
  //   BroodLive.hook("Chart", { mounted() { … } });
  //   BroodLive.hooks({ Chart: { … }, Sortable: { … } });
  //
  // Registering later still works for hooks that appear in a later patch; only the elements
  // already on the page at mount time would have been missed, and those log a clear error
  // naming the hook rather than failing quietly.
  function hook(name, def) {
    hookDefs.set(name, def);
    missingHooks.delete(name);
  }

  function hooks(defs) {
    for (const name of Object.keys(defs)) hook(name, defs[name]);
  }

  // Teach the client about a DOM event outside the default set, so `data-on-wheel` /
  // `data-js-wheel` are discovered by the per-patch scan like the rest. Only needed for
  // events the default list leaves out — it covers the common ones, and every entry costs a
  // clause in the selector that runs after each patch, which is why it is a list and not
  // "every event that exists".
  function listen(type) {
    listenFor.add(type);
    rebuildSelector();
    for (const session of sessions) session._bindNewEventTypes();
  }

  // Auto-mount on DOMContentLoaded. Guarded on `document` existing so the file can also be
  // required by a plain `node` test, which loads it for `decideSend` and has no DOM.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
  }

  // `decideSend` is exported for tests/js/timing_test.js — see the note at its definition.
  return { mount, hook, hooks, listen, Session, decideSend };
})();

// Node, for tests/js/timing_test.js. The browser path is untouched: this file defines a
// global and a browser never sees `module`.
if (typeof module !== "undefined" && module.exports) module.exports = BroodLive;
