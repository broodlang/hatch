# Hardening — adversarial review findings

A three-front adversarial review (security, concurrency, renderer) of the Tier-1 HTTP,
real-time (handle-info / PubSub / Presence), and minimal-diff work. The cores held up:
the session crypto is correct (constant-time compare, malformed cookies never throw), and
no input was found where the static/dynamic split renders differently from a full render.
The exposure is at the edges — security gaps and silent failure under crash/churn.

## Fixed

| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| F1 | `put-cookie` concatenated raw name/value — a user-controlled value could inject `; Domain=…` or CRLF | HIGH (latent) | `cookie-safe` strips `;`/CR/LF in `format-set-cookie` (+test) |
| F2 | `clear-session`/logout re-signed an empty `{}` cookie instead of dropping it | MED | `write-session` emits `Max-Age=0` when the session is empty (+test) |
| F3 | JSON body params left nested object keys as keywords (inconsistent with form/session params) | MED | `json-body-params` deep-stringifies keys (+test) |
| F4 | Misleading client comments ("diff by key", "MVP innerHTML swap") | LOW | corrected to describe the index morph |
| S1 | WebSocket upgrade had no `Origin` check — cross-site WebSocket hijacking (a cross-origin page could open an authenticated live session with the victim's cookies) | HIGH | `:check-origin` (default same-origin) enforced in `http/server`'s upgrade path before the 101; `websocket/origin-allowed?` (true / false / allowlist) (+tests) |
| S2 | Session cookie defaulted `Secure=false` — the auth cookie could traverse plaintext HTTP and be replayed | HIGH | `secure-cookie-default?` — `Secure` outside dev ($HATCH_ENV); explicit `:secure` overrides (+test) |
| S3 | HTTP Basic auth compared creds with `=` (timing oracle to recover the password) | MED | constant-time `crypto/secure=?` over the credential bytes (tests now exercise it) |
| S4 | `unmask` built the payload with per-byte `(str acc …)` — O(n²); a ~64 KB masked frame forced ~GBs of copying (cheap-to-send CPU/mem DoS) | MED | single `join` over a mapped range — O(n) (+ non-zero-key round-trip test) |

## Pending (in recommended order)

| # | Finding | Sev | Plan |
|---|---------|-----|------|
| ~~H16~~ ✅ | PubSub/Presence registries were unsupervised/undurable | HIGH | **Done** — `web/registry` (supervised + snapshot-vault); registries mirror on change, recover state + re-monitor pids on restart |
| ~~H17~~ ✅ | Live-navigate kept the old view's subscriptions/presence | HIGH | **Done** — `deflive` `(unmount (model) …)` clause, run in the navigate arm before the next mount; room/presence demos unsubscribe/untrack |
| ~~M19~~ ✅ | Monitors leaked/duplicated across unsubscribe→resubscribe | MED | **Done** — registries track `{pid → ref}` and `demonitor` when a pid's last subscription/presence drops |
| ~~M20~~ ✅ | `subscribers`/`roster` sync calls had no correlation ref (a late reply could be mismatched) | MED | **Done** — each request carries a fresh `ref`, the reply is pinned to it. (`lookup-live` in web/live is the user's code — left as-is.) |
| ~~H18~~ ✅ | No CSRF protection on POST + signed-cookie session | HIGH | **Done** — `web/csrf`: synchronizer token in the session, `protect-from-forgery` plug, `csrf-input` form field, constant-time verify (+ `X-CSRF-Token` header). Demo `/account` wired. |
| ~~M21~~ ✅ | `morphChildren` matched by index, so a reorder re-cloned interactive nodes and lost focus/caret | MED | **Done** — keyed morph in `brood_live.js`: when all children carry `data-key`/`id`, reconcile by key (move existing nodes) instead of by index; unkeyed views unchanged. Test page: demo `/reorder`. |
| ~~L~~ ✅ | Session cookie defaulted `Secure=false` | LOW→HIGH | **Done** — see S2 above (Secure outside dev) |
| ~~S5~~ ✅ | Duplicate/list `Transfer-Encoding` and obs-fold (leading-WS) header lines aren't rejected — a desync primitive behind a proxy that resolves them differently | MED | **Done** — `obs-fold?` + `duplicate-transfer-encoding?` reject from the raw header lines; a list TE was already rejected (exact-match `chunked?`) (+tests) |
| ~~S6~~ ✅ | Signed session carries no `exp`/nonce — a stolen cookie is valid until `HATCH_SECRET_KEY_BASE` rotates | MED | **Done** — a `__exp__` (epoch-ms) is stamped into the signed payload when `:max-age` is set, verified + stripped on decode (`with-expiry`/`check-expiry`); sliding on each write (+tests) |
| ~~S7~~ ✅ | WebSocket accepts unmasked client frames (RFC 6455: MUST reject); RSV bits, reserved/invalid opcodes, and control-frame `FIN=0` are unvalidated | LOW | **Done** — `parse-one-frame` rejects unmasked frames, non-zero RSV, reserved opcodes (`valid-opcode?`), and fragmented control frames (+tests) |
| ~~S8~~ ✅ | `cookie-safe` sanitizes the value but not the `Path`/`Domain`/`SameSite` option values | LOW | **Done** — `format-set-cookie` now `cookie-safe`s the Path/Domain/SameSite attributes too (+test) |
| ~~S9~~ ✅ | 400 responses echo the attacker's request line in the body | LOW | **Done** — generic `400 Bad Request` body; the parser detail goes to the `[:hatch :request :bad-request]` telemetry event (+test) |

All findings from the security review are now addressed.

Ruled out during the review (reported but not real, given the runtime): chunk-size / Content-Length
**integer-overflow crashes** — Brood integers are bignums (no overflow/throw), so an over-large
size just stays `:incomplete` until the request-size cap / 408. `(random-token 32)` is a 256-bit
token (the arg is the byte count), so CSRF entropy is fine.

Renderer note: the morph defects (M21) produce **correct HTML** — the issue is DOM node
identity/focus stability on reorder, not wrong output.

Granularity (not correctness) follow-ups for the diff renderer: `:for`/`(map …)` is one
opaque slot today (per-item comprehension diffing later); a multi-form `(do …)` render body
collapses to one opaque slot.

---

## Second review pass

A follow-up adversarial sweep of the http + web layers. The cores held again (session
crypto, CSRF, static path-safety, chunked/CL·TE framing, the render escaping). New findings:

### Fixed

| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| L1 | `web/live` session-dispatch called `(get msg "event")` on the raw `json-decode` result; a WS frame whose body is a bare scalar/array/bool (`5`, `true`, `[1,2,3]`) made `get` throw in the dispatch head, which runs OUTSIDE the per-hook guards. The throw killed the session actor before `close-session`, leaking its registry entry + component table per connection — an unauthenticated memory-leak DoS from repeated connect→send. | HIGH | `parse-client-frame` coerces a non-object message (and non-object `params`) to `{}` before any `get` (+tests) |
| L2 | Two header-desync smuggling primitives survived the parser (same class as the fixed obs-fold/dup-TE): whitespace before the field-name colon (`Transfer-Encoding : chunked`, trimmed → honored) and a bare CR/LF inside the head (survives the CRLF-only split → a proxy splitting on it frames differently). | MED | `try-parse`/`try-parse-head` reject `any-ws-before-colon?` and `bare-line-break?` before any framing decision (+tests) |
| L3 | `web/template` passed `data:` URLs through `href`/`src`/… unchanged, so `data:text/html,<script>` (or `data:image/svg+xml`) executed script in the origin. | MED | `dangerous-url?` allows only whitelisted raster-image `data:` URLs, neutralizing the rest to `#` (+tests) |
| L4 | `render-attr` escaped attribute *values* but emitted attribute *names* verbatim — an app that derives a key from user input (`(keyword (str "data-" user))`) could break out of the attribute list. | LOW | `safe-attr-name?` drops a name carrying whitespace/quote/`=`/`<`/`>`/`/`/`&`/backtick (+test) |
| L5 | `head-timeout`: `:read-timeout-ms` re-arms on every byte, so a client dribbling one byte per (timeout−1)s held a worker open indefinitely (slow-loris drip). | MED | new `:head-timeout-ms` (default 15s) caps the TOTAL head read; `worker-read-head` waits `min(idle, deadline−now)` (+test) |
| L6 | `web/form` `email?` rejected spaces but not tabs/CR/LF — a false sense of completeness for a value that might later flow into a mail header. | LOW | rejects the whole control range (≤ 0x20) (+tests) |

### Still pending

| # | Finding | Sev | Plan |
|---|---------|-----|------|
| P1 | The body-drain loops (`buffered-drain`/`chunked-drain`/`spool-drain`) still use only the per-read idle timeout, so a body dribbled after a complete head is bounded by `:max-request-bytes` but not by wall-clock. Lower risk than the head dribble (needs a valid head first, capped by size), but a full fix threads the `:head-timeout-ms` deadline (or a separate body deadline) through those loops too. | MED | thread an absolute deadline through the body-drain recursions |
| P2 | `http/websocket` accepts a close frame with a 1-byte payload (RFC 6455 §5.5.1: 0 or ≥2) and does not validate close codes (reserved/invalid pass through). Framing is correct; only close *semantics* are unchecked. | LOW | validate close-frame length + code in `parse-one-frame` |
| P3 | A header line with no colon is silently dropped rather than rejected, and an HTTP/1.1 request with no `Host` is accepted (RFC 7230 §5.4 MUST reject). | LOW | reject a colon-less header line and a Host-less HTTP/1.1 request |
