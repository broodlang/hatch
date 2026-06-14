# TCP / HTTP / WebSocket audit — findings & fix plan

A detailed review of the whole socket stack — kernel (`brood`: `crates/lisp/src/net.rs`,
`process/io_source.rs`) and framework (`hatch`: `http/*`, `web/conn`, `web/static`).
Each finding has a **status**, location, and fix sketch. Severity: 🔴 high · 🟠 medium ·
🟡 low.

Status legend: **FIXED** (done) · **TODO** (planned) · **RESOLVED** (investigated, not a
bug).

> Context: this audit followed the WebSocket "live nav gets stuck" bug, whose root cause
> was the socket being read in **text mode** (UTF-8-lossy → U+FFFD) before
> `tcp-set-binary` took effect — a race fixed by setting binary mode before the `101`
> (`http/server.blsp`). Most findings below are about the same fragile seam (text/binary
> byte handling) and the asymmetry between the hardened read path and the raw write path.

---

## 🔴 High

### 1. Write path blocks the scheduler pool (slow-read DoS) — MITIGATED (kernel); full offload TODO
`net.rs send()` does `write_all` synchronously on the **calling green-scheduler thread**.
Reads are offloaded to dedicated threads (`spawn_io_source`, ADR-059), but writes are not.
A client that stops reading makes `tcp-send` block on a full socket buffer, pinning a
worker from the small pool; a few slow readers → pool starvation.
**Done:** a `WRITE_TIMEOUT` (30 s) is now set on every stream (`connect` + accepted), so a
stuck write *fails* instead of pinning a worker forever; the error surfaces from `tcp-send`
and the framework's resilient send paths (#8) close the connection. This bounds the pin to
30 s rather than ∞.
**Still TODO (full fix):** offload writes to a per-socket writer thread + bounded channel
(symmetric with the read side). The catch that makes it ADR-worthy: `close` must **drain
queued writes before shutdown**, otherwise `tcp-send` immediately followed by `tcp-close`
(the HTTP worker's non-keep-alive path) would **truncate the response**. Also doubles
threads-per-connection. Needs its own design pass + the differential (`test-both`) gate.

### 2. HTTP response splitting (header CRLF injection) — FIXED
`response.blsp format-header` concatenated header values with no sanitization; a
user-controlled `Location` (`redirect-resp`/`redirect`) or any header value containing
`\r\n` could inject headers / split the response. **Fix applied:** `format-header` strips
CR and LF from the value.

### 3. Negative / invalid `Content-Length` crashes the worker — FIXED
`request.blsp` parsed CL with `string->number` (accepts `-5`, `1.5`) and never validated.
`Content-Length: -5` → `body-end < body-start` → `substring` **throws** (confirmed), and
`try-parse` isn't wrapped in `worker--run` → the worker dies on one crafted request.
**Fix applied:** CL must be all-digits (non-negative integer); otherwise `[:error]` → 400.

---

## 🟠 Medium

### 4. `text-frame` errors on payloads > 64 KB — FIXED
`websocket.blsp text-frame` raised for `n > 65535` (no 64-bit length on send). A live view
rendering >64 KB of HTML crashed the session. **Fix applied:** emit a 64-bit (`0x7f`)
length frame for payloads > 65535 (8-byte big-endian length).

### 5. WebSocket has no limits — FIXED
Was: no idle/ping timeout (an idle WS pinned an OS reader thread + a parked green process
forever), no control-frame validation, and `pong-frame` could overflow its length byte.
**Fixed:**
- **Idle/keepalive watchdog** (`web/live` `idle-watchdog`): every `*ws-ping-ms*` (30 s) with
  no client frame, the session pings; a live browser auto-pongs (resets the timer), a
  dead/black-hole peer is reaped after a couple of unanswered pings. Any client frame
  `kick-watchdog`s it alive.
- **Control-frame validation** (`parse-frame`): a control frame (close/ping/pong) with an
  extended length (≥126) is rejected — `control-opcode?` guard.
- **`pong-frame` bounded** to 125 bytes.
- Inbound frames are inherently capped at ~64 KB (64-bit length rejected); continuation
  frames aren't reassembled (single-frame messages). A configurable `:ws-max-frame-bytes`
  and `:ws-idle-timeout-ms` (the watchdog interval is a module constant today) remain a
  nice-to-have refinement.

### 6. Chunked `Transfer-Encoding` → request smuggling — FIXED (reject)
`request.blsp` honored only `Content-Length`; a `chunked` body was mis-parsed and its bytes
treated as a pipelined second request — a smuggling vector behind a proxy. **Fix applied:**
reject any request carrying `Transfer-Encoding` with `[:error]` → 400 (we don't de-chunk
yet). Full de-chunking is the eventual Tier-2 item.

### 7. Binary static files are silently corrupted — FIXED (partial)
`web/static.blsp` reads with `slurp` (UTF-8 text); the MIME table listed `ico` (binary), so
a favicon returned 200 with mangled bytes. **Fix applied:** dropped binary types from the
table and documented that binary assets need byte-faithful reads. Proper fix awaits a
binary file-read primitive (a `slurp-bytes`, or the bytes type — #16); `copy-file` is the
only binary-safe file op today.

### 8. `tcp-send` broken-pipe crashes the worker/session ungracefully — FIXED
**Fixed:** `web/live` `send-msg` now returns a success boolean (wraps the write in `try`);
`push-update`, the pong reply, `reload-css`, and the navigate redirect all end the session
cleanly (`close-session`) on a failed write instead of crashing. `close-session` and the
watchdog's `[:ws-send]` write are best-effort too. Verified by smoke test: a hard-RST
disconnect leaves the server serving with **0** "process died / Broken pipe" log lines.

---

## 🟡 Low / hardening

### 9. Relaxed atomics on the binary flag — FIXED (kernel)
**Fixed:** the `binary` flag is now Release on store (`set_binary`) / Acquire on load (the
reader thread in `start_reader`), and the io-source `subscriber` is Release on `retarget` /
Acquire on `emit`. The binary-mode flip and the controlling-process handoff are now
properly synchronized to the source thread, not merely timing-safe.

### 10. Headers without a space after the colon are dropped — FIXED
`request.blsp parse-headers` split on `": "`; `Host:localhost` (legal — the space is
optional) was discarded. **Fix applied:** split on the first `:`, then `trim` the value.

### 11. One server per VM — FIXED
**Fixed:** the supervisor and listener are registered under port-derived names
(`supervisor-name`/`listener-name` → `:http-supervisor-<port>` / `:http-listener-<port>`),
so several servers can run in one VM. `stop` now takes the `port`. (API change: `(stop)` →
`(stop port)`.)

### 12. Duplicate / conflicting `Content-Length` — FIXED
**Fixed:** `try-parse` rejects (`[:error]` → 400) when `Content-Length` appears more than
once with differing values (`content-length-conflict?`). Duplicate identical values are
accepted. The CL + `Transfer-Encoding` case is already closed by #6.

### 13. Tail-call growth in `worker--run` loops — RESOLVED
The keep-alive and incomplete-read recursions in `worker--run` (and the read loops) are in
**tail position**, and brood TCOs tail calls (tail-trampoline; non-tail recursion is what
`E0044`/the checker flags). No unbounded stack growth. Not a bug.

### 14. O(n²) byte ops — FIXED (base64)
`base64.blsp encode-bytes--acc` called `count` each recursion (O(n²)); fine for a 20-byte
SHA1 but bad if reused. **Fix applied:** carry the sequence as a list and branch on
`first`/`rest` without re-counting. (`websocket.blsp byte-string->utf8` is also O(n²) via
per-index `char-at` — left as-is for now; small frames. Noted for #16.)

### 15. Misc
- `util.blsp hex-char->int`: bad hex digit `%ZZ` → byte 0 (lenient). Acceptable; noted.
- Thread-per-connection (1 OS reader thread / conn) scales to hundreds, not tens of
  thousands. Tied to #1 (and a future writer thread).

---

## 🟣 The one bad abstraction (highest leverage) — TODO (kernel, large)

### 16. "byte string = Latin-1 codepoints 0–255 + per-socket text/binary mode flag"
This is the root fragility. It **caused** the U+FFFD bug; it forces every binary protocol to
manually UTF-8-encode/decode and flip socket mode at exactly the right moment (race-prone);
and it splits "bytes" into two parallel notions (the `string->utf8-bytes` builtin vs. the
`*byte-table*` byte-string in `websocket.blsp`). A real `bytes`/blob value type would delete
a whole class of bugs (text/binary confusion, the mode-flip race in #1/#9, the O(n²)
conversions in #14) and let sockets be byte-faithful always. Documented elsewhere as a
deliberate stopgap; it's the single highest-value design change, and a large one (new
`Value` variant, GC, parser/printer, builtins, socket API). Own design pass.

---

## What's solid (keep)
Passive-accept handoff (no early bytes lost), monitor-based connection counting, the
unclaimed-socket reaper, the supervised listener + bind-retry, and the immutable `Conn` are
all well-built. The Tier-1 DoS caps (read timeout, request-size cap, max-connections) are
correct on the **read** side — #1 is exactly that the **write** side never got the same.

---

## Progress
- **Batch 1 (framework):** FIXED #2, #3, #4, #6, #7, #10, #14. RESOLVED #13.
- **Batch 2 (framework + kernel):** FIXED #5, #8, #9, #11, #12; MITIGATED #1 (write timeout).
- **Remaining:** #1 full async-writer offload (ADR-worthy — see the drain-before-close
  caveat) and #16 the `bytes`/blob value type (large kernel/language change). These two are
  the deliberate big-design items left.
