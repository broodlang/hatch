# Hatch — Web Framework Roadmap

*Hatch is a Phoenix/LiveView-inspired web framework for the
[Brood](https://broodlang.org) language. Pure Brood, no npm, no new
Rust — TLS is handled by a reverse proxy.*

---

## Stack layers

```
┌──────────────────────────────────────────────────────────┐
│  Hardening ✅  compress · ratelimit · logger · stream    │
├──────────────────────────────────────────────────────────┤
│  Live      ✅  web/live · component · pubsub · presence  │
│  Rendering ✅  web/template (Hiccup) · bml · parts       │
│  Pipeline  ✅  web/router + web/conn · session · csrf    │
├──────────────────────────────────────────────────────────┤
│  Transport ✅  http/*  (HTTP/1.1 + WebSocket, our Bandit)│
├──────────────────────────────────────────────────────────┤
│  Already in stdlib:  tcp-*, %sha1, %hmac-sha256,         │
│                      string->utf8-bytes, %random-bytes   │
└──────────────────────────────────────────────────────────┘
```

---

## What shipped

Phases 1–11 are all complete as of **0.4.1** (2026-08-11), plus `web/upload` (live upload
progress) on top. The per-phase record — what each one built, and the scope calls and
trade-offs behind them — is archived in
[`_archive/shipped-phases.md`](_archive/shipped-phases.md).

| Layer | Modules |
|---|---|
| HTTP/1.1 + WebSocket | `http/request` `http/response` `http/server` `http/websocket` `http/multipart` `http/util` `http/base64` |
| Request pipeline | `web/conn` `web/router` `web/page` `web/static` `web/session` `web/csrf` `web/auth` |
| Rendering | `web/template` (Hiccup) `web/bml` (`.bml` compiler) `web/parts` (static/dynamic diff split) |
| Live views | `web/live` `web/component` `web/pubsub` `web/presence` `web/registry` |
| Forms & uploads | `web/form` `web/upload` |
| Production | `web/compress` `web/ratelimit` `web/logger` `web/stream` `web/assets` `web/application` `web/repo` |
| Tooling | `web/test`, `nest new --template hatch` / `--template web-api` |

Per-item `:for` diffing, per-component wire diffs and reconnect statics-caching are all in: a
changed row ships that row, a changed component ships only its own changed inner slots, and a
reconnecting client that still holds the page skeleton is not sent it again. Since 0.4.2,
`web/live/live-conn` also exposes the connection's read-only Conn to view code
(a dynamic binding set once per session, so no hook signature changed), and `web/csrf` grew
`live-token`/`live-csrf-input` on top of it — closing the gap where a live view had no way to
render a CSRF token for a POST to a protected route.

Closed bugs, cleanup passes and post-merge reviews are archived in
[`_archive/fixed-issues.md`](_archive/fixed-issues.md) — worth reading for the root causes,
several of which document non-obvious Brood behaviour.

---

## Still open

With Phases 1–11 done, this is the actual backlog. Nothing here blocks anything else; pick by
appetite.

- **Framed reads (`tcp-read-until`) — now genuinely adoptable (brood ≥ 0.3.10).**
  Adopting them would have *regressed* hatch's slow-loris hardening, because `:timeout-ms` is an
  **idle** timeout (reset per chunk, by design) while all four of hatch's read loops enforce an
  idle timeout *and* a total deadline. Filed and fixed upstream the same day (2026-08-13):
  both combinators now take **`:deadline-ms`**, a total budget resolved once at the call, and it
  shipped in brood **0.3.10**. `worker-read-head` and the three body drains can each now drop
  their hand-rolled `receive` loop for a single call. Still only a line-count win — the loops
  are already O(n) and already answer 408/413 — so it is cleanup, not a fix.
- **No component-level `tick`** — the remaining half of the Phase 8 carve-out (the wire-diff
  half shipped 2026-08-13). A parent's own tick can `send-update` if a component needs periodic
  refresh, which covers most of it.
- **Components nested in `(if …)`/`(for …)` still diff coarsely** — such a component is part of
  its enclosing opaque dynamic and re-sends whole. The same carve-out that applies to anything
  inside a conditional; a *direct* component hole now diffs per inner slot.
- **Q10, still undecided** — head updates: a `[:set-title]` effect, or a `<head>` slot in the
  layout? (See *Open design questions*.)

---

## Known issues

None open. The three stale `bytes` type-signature warnings recorded here (`count`/`fold`
called directly on `bytes` at `http/response.blsp`, `http/util.blsp`, `web/static.blsp`) are
**gone as of 2026-08-13** — `nest check` reports zero warnings across `src/` and `tests/`.
They were never real perf bugs (analysed at the time: `count` on `bytes` dispatches to the
O(1) native `byte-length`, and the `http/util` fold ran over at most 4 bytes); they cleared
without a dedicated fix, partly from the bytes-native port routing that fold through `seq`,
partly from brood 0.3.10's checker. The original analysis is in
[`_archive/fixed-issues.md`](_archive/fixed-issues.md).

---

## Blocked on Brood language changes

These are hatch-side follow-ups that only become worth doing once the matching
Brood language/runtime change ships. We proposed all six upstream — they're at the
top of [`brood/ROADMAP.md`](../../brood/ROADMAP.md) under *"Findings from hatch
(2026-07-11)"*. Context for the first three is `docs/tcp-http-audit.md` §16–§17
(the O(n²) class they retire).

**All six upstream items have now shipped** (reviewed against brood 0.3.8,
2026-08-07). **Five are now closed hatch-side** — the bytes-native port, the last of them,
finished in `d119f20` (2026-08-11, released as 0.4.1). The sixth (framed reads) cleared its
original blocker and immediately hit a new one, found by attempting the adoption on 2026-08-13
— which was itself filed and fixed upstream the same day (`:deadline-ms`), so it is now waiting
only on a brood release. Details in its entry below.

- ✅ **Iolists — shipped upstream as ADR-139** (`tcp-send`/`bytes-concat`/`spit` take
  arbitrarily nested trees of strings, `bytes` and byte ints, flattened once at the
  write). Adopted where it applies: `http/websocket`'s frame builders now *describe*
  each frame as an iolist (`(bytes-concat [129 n body])`) instead of concatenating
  pairwise, and the hand-rolled `u64-be` shift-and-mask is gone in favour of the
  prelude's `int->bytes`. The remaining accumulators (`http/server`'s head reader and
  body drain, `http/request`'s `dechunk-step`) are *read*-side, not write-side — an
  iolist doesn't help there; they are covered by the bytes port below.
- ✅ **`bytes`-native parsing → drop the carrier-string bridge.** Upstream shipped
  ADR-141 (bytes-native `std/net`, carrier send rule deleted) and ADR-140 (bit syntax),
  and hatch's **WebSocket half is done** — the inbound frame parser is bytes-native and
  outbound frames are `bytes`. The HTTP half was: `http/server` bridges every read with
  `bytes->carrier`, and `web/conn` converts straight back (`carrier->bytes`), so a request
  body is walked twice for nothing (audit §16). **The parser is now ported** —
  `http/request/try-parse-bytes` / `try-parse-head-bytes` / `dechunk-step-bytes` parse a
  `bytes` buffer directly and keep the body as `bytes`. Because the parser is where the
  request-smuggling defenses live and the port is a *performance* change to *correct* code,
  it was gated on a **differential fuzz** (`tests/http_request_bytes_test.blsp`): a broad
  corpus (every framing/smuggling branch + binary bodies) and a truncation sweep (every
  byte-prefix of several requests) run through both the carrier parser and the byte parser,
  asserting identical verdicts, plus golden output checks. The fuzz earned its keep — it
  caught a hand-mirrored `cond` that had dropped three freshly-added smuggling checks; the
  byte parser now delegates head *classification* to `try-parse-head` verbatim, so the two
  can never drift, and slices only the body natively. **The server rewire landed too**
  (`d119f20`): `http/server`'s read loop accumulates `bytes` chunks verbatim (head completeness
  via `bytes-index-of`, body/chunked/spool paths on `subbytes`/`bytes-concat`) and
  `web/conn/build` carries the request `:body` as `bytes`, exposing `:body-bytes` and decoding
  `:body` text only for form/JSON handlers. So the whole-buffer `bytes->carrier` per read and
  `web/conn`'s `carrier->bytes` round-trip — the quadratic-in-upload-size double walk of audit
  §16 — are both gone from the hot path. The one behaviour change: a RAW handler's `:body` is
  now `bytes`. The carrier parser stays in `http/request` purely as the fuzz oracle.
- 🔶 **Framed reads — shipped upstream as `tcp-read-until` / `tcp-read-n`** (2026-07-25;
  the transient read buffer this entry originally asked for was *rejected* upstream as an
  immutability violation, and combinators shipped instead). Originally not adoptable —
  neither combinator took a read timeout or a size cap, and `http/server`'s head reader
  answers 408 on an idle client and 413 past `:max-request-bytes` (the slow-loris
  hardening in `docs/robustness.md`). **Brood added both on 2026-08-07** in response:
  `(tcp-read-until sock sep {:timeout-ms n :max-bytes n})`, returning `[:timeout acc]` /
  `[:too-large acc]` alongside `[:closed acc]`; `tcp-read-n` refuses an over-cap declared
  length before reading. Its stated prerequisite (the head reader being on `bytes`) shipped in
  `d119f20` — but on actually attempting the adoption (2026-08-13) it turns out **still not to be
  adoptable**, for a second reason neither side had spotted:

  **`:timeout-ms` is an *idle* timeout, and hatch needs a *total deadline* as well.** Upstream
  chose idle deliberately ("a large legitimate body is slow for honest reasons; what marks an
  attack is silence"), and for a *body* that reasoning is right. But `30493f5` added a total
  head deadline to hatch precisely because idle-alone is defeated by a drip: a client sending one
  byte every `(idle - 1)`ms re-arms the idle timer forever and holds a worker open indefinitely.
  All four of hatch's read loops therefore recompute `(min idle (- deadline (now)))` on *every*
  receive — `worker-read-head` (server.blsp:303) plus `buffered-drain`, `chunked-drain` and
  `spool-drain`. A single `tcp-read-until` call cannot express that: the idle timer resets per
  chunk *inside* the call, so whatever value is passed, a dripper resets it. Splitting it across
  several calls doesn't rescue it either — the combinator only scans its own accumulator, so a
  delimiter straddling two calls would be missed unless the caller re-scans the join, which is
  the hand-rolled loop again.

  **Filed and fixed upstream the same day.** Both combinators now take **`:deadline-ms`** — an
  absolute, non-resetting total budget resolved once in `tcp-read-limits`, with the per-chunk
  wait becoming `(min idle remaining)` and sharing the existing `[:timeout acc]` return. So the
  adoption is unblocked as of brood 0.3.10. Worth restating that the
  value even then is only line count: `worker-read-head` is already O(n) (cons chunks, re-scan a
  3-byte carry) and already enforces the 408 and 413 caps, so this buys clarity, not speed.
  **Do not adopt on a brood without `:deadline-ms`; doing so silently reopens the drip hole.**
- ✅ **`mapv`/`filterv` — shipped upstream 2026-07-18.** Swept: every
  `(into [] (map …))` in `src/` is now `mapv`, and the `(into [] (reverse …))` sites are
  `vec`. The CLAUDE.md convention notes the new spelling.
- ✅ **Module privacy — shipped upstream as ADR-146** and went past "link-checked" to
  enforced def-site privacy (`defn-`/`def-`). Migrated in `2366d07`; the `--`-infix
  convention is gone from the tree.
- ✅ **`let` vector-destructure of a list value — resolved upstream by erroring
  clearly.** Verified on 0.3.8: `(let ([a b] (list 1 2)) …)` raises
  `[:match-error :let (1 2) ([a b])]`. The `first`/`rest` idiom stays correct for lists;
  the CLAUDE.md caveat now records that this is a clean error rather than a silent
  misread.

### New upstream findings (2026-08-07) — all three fixed in brood

Filed back to brood from this review; hatch is the consumer that surfaced each. All three
were fixed upstream the same day, so these need a brood ≥ the next release.

- ✅ **A `table` global locked a project out of the ADR-218 startup image.** `nest check`
  reported *"hatch cannot use a startup image … cannot image global
  `hatch/web/static/*manifest-cache*`"*, so hatch (and every app depending on it) reloaded
  from source on every start. `Value::Table` is the language's *only* sanctioned mutable
  structure, and `web/static` uses two of them for exactly what tables are for (the
  fingerprint-manifest and ETag caches). Reproduced on a bare `nest new` project plus one
  `(def *cache* (table))` — upstream, not a hatch structure problem. **Fixed:** a table
  global is imaged by value (its snapshot) and rebuilt as a fresh table on restore; image
  format v4. No hatch change needed — `nest check` stops printing the note and hatch gets
  imaged startup, so keep the two caches as tables.
- ✅ **`tcp-read-until` / `tcp-read-n` needed a timeout and a byte cap** — see the
  framed-reads entry above. **Fixed:** both take `{:timeout-ms n :max-bytes n}`.
- ✅ **`nest format` descended into `_deps/`** — it counted and rewrote files in the
  dependency cache (it reformatted `_deps/store/.brood-pkg.blsp` on first run here), so
  "68 files considered" included source hatch does not own. **Fixed:** the formatter now
  walks a whitelist (`:source-paths` + `:test-paths` + a new `:format-paths`), so hatch
  reports 62 and never touches `_deps`. No hatch change needed — its Brood all lives under
  `src/` and `tests/`, so it needs no `:format-paths` entry.

### New upstream findings (2026-08-13)

- ✅ **A `defdyn` global loses its dynamic-variable registration when restored from the
  ADR-218 startup image** — **fixed upstream** in `83151776` (image format v5: the dynamic-var
  names are recorded in the image and re-marked on open) and **released in brood 0.3.10**. We
  re-derived it here before spotting the fix, which was a fair outcome: it landed after the
  v0.3.9 tag, so an installed 0.3.9 toolchain still had it.

  Symptom, for searchability: `nest test` on a pristine checkout was green twice, then failed
  38 tests on every run after — all in `web/bml`, plus the one component-template test that
  renders a `.bml` — with `binding: *bml-source* is not a dynamic variable (declare it with
  defdyn)` (E0099) from `hatch/web/bml/parse`. The image is written on the first run and never
  rewritten, so the trigger was the *restore* path. **Verified fixed:** four consecutive
  `nest test` runs from a cleared image are 932/932 on 0.3.10, where 0.3.9 reddened on the
  third. Nothing to do hatch-side — `defdyn` was used correctly throughout, and the failure was
  invisible on a first run, which is why CI starting from a clean checkout never caught it.

---

## Open design questions

| # | Question | Decision needed |
|---|----------|-----------------|
| Q1 | Slot annotation: explicit `(slot :key expr)` or static analysis of `(get model :key)`? | Phase 6 |
| Q5 | Sessions: process-store only, or pluggable adapters (disk/DB) from day one? | Phase 7 |
| Q8 | Auth: `on-mount-guard` clause in `deflive`, or convention in `mount`? | Phase 7 |
| Q10 | Head updates: `[:set-title]` effect, or a `<head>` slot in the layout? | Phase 8 |

---

## Dependency graph

```
Phase 11 ✅ Phases 1–10 (hardening layer)
Phase 10 ✅ nest tooling + all phases
Phase 9  ✅ Phases 4, 5, 7
Phase 8  ✅ Phase 5
Phase 7  ✅ Phases 4, 5
Phase 6  ✅ Phases 3, 5
Phase 5  ✅ Phases 1–4
Phase 4  ✅ Phases 2, 3
Phase 3  ✅ (none beyond stdlib)
Phase 2  ✅ Phase 1 + stdlib TCP
Phase 1  ✅ stdlib
```
