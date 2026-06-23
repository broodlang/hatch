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
| S5 | Duplicate/list `Transfer-Encoding` and obs-fold (leading-WS) header lines aren't rejected — a desync primitive behind a proxy that resolves them differently | MED | reject duplicate/list TE and obs-fold lines, decided from the raw header lines (as `content-length-conflict?` already does for CL) |
| S6 | Signed session carries no `exp`/nonce — a stolen cookie is valid until `HATCH_SECRET_KEY_BASE` rotates, and there's no per-session revoke | MED | sign + verify an `exp` (and optional session version) in the payload |
| S7 | WebSocket accepts unmasked client frames (RFC 6455: MUST reject); RSV bits, reserved/invalid opcodes, and control-frame `FIN=0` are unvalidated | LOW | reject unmasked frames, non-zero RSV, and out-of-set opcodes |
| S8 | `cookie-safe` sanitizes the value but not the `Path`/`Domain`/`SameSite` option values | LOW | sanitize attribute values too (only exploitable if an app feeds user input into those opts) |
| S9 | 400 responses echo the attacker's request line in the body | LOW | generic 400 body; log the detail to telemetry |

Ruled out during the review (reported but not real, given the runtime): chunk-size / Content-Length
**integer-overflow crashes** — Brood integers are bignums (no overflow/throw), so an over-large
size just stays `:incomplete` until the request-size cap / 408. `(random-token 32)` is a 256-bit
token (the arg is the byte count), so CSRF entropy is fine.

Renderer note: the morph defects (M21) produce **correct HTML** — the issue is DOM node
identity/focus stability on reorder, not wrong output.

Granularity (not correctness) follow-ups for the diff renderer: `:for`/`(map …)` is one
opaque slot today (per-item comprehension diffing later); a multi-form `(do …)` render body
collapses to one opaque slot.
