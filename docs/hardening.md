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

## Pending (in recommended order)

| # | Finding | Sev | Plan |
|---|---------|-----|------|
| ~~H16~~ ✅ | PubSub/Presence registries were unsupervised/undurable | HIGH | **Done** — `web/registry` (supervised + snapshot-vault); registries mirror on change, recover state + re-monitor pids on restart |
| ~~H17~~ ✅ | Live-navigate kept the old view's subscriptions/presence | HIGH | **Done** — `deflive` `(unmount (model) …)` clause, run in the navigate arm before the next mount; room/presence demos unsubscribe/untrack |
| ~~M19~~ ✅ | Monitors leaked/duplicated across unsubscribe→resubscribe | MED | **Done** — registries track `{pid → ref}` and `demonitor` when a pid's last subscription/presence drops |
| ~~M20~~ ✅ | `subscribers`/`roster` sync calls had no correlation ref (a late reply could be mismatched) | MED | **Done** — each request carries a fresh `ref`, the reply is pinned to it. (`lookup-live` in web/live is the user's code — left as-is.) |
| H18 | No CSRF protection on POST + signed-cookie session | HIGH | CSRF plug: per-session token, hidden field, constant-time compare |
| M21 | `morphChildren` matches by index, so a reorder/insert above an interactive element re-clones it and loses focus/caret | MED | keyed morph via `data-key`/`id` |
| L | Session cookie defaults `Secure=false` | LOW | default on for HTTPS / require explicit dev opt-out |

Renderer note: the morph defects (M21) produce **correct HTML** — the issue is DOM node
identity/focus stability on reorder, not wrong output.

Granularity (not correctness) follow-ups for the diff renderer: `:for`/`(map …)` is one
opaque slot today (per-item comprehension diffing later); a multi-form `(do …)` render body
collapses to one opaque slot.
