---
name: stdlib-networking
description: Brood stdlib TCP/crypto/bytes primitives inventory — what exists and what's missing for the web stack
metadata:
  type: project
---

Checked 2026-06-13 via `apropos`/`lookup` against the live image.

## What exists

**TCP — message-passing model (not blocking reads):**
- `tcp-listen host port` → lsock; connections arrive as `[:tcp-accept lsock client]` to calling process
- `tcp-connect host port` → sock; data arrives as `[:tcp sock data]` / `[:tcp-closed sock]`
- `tcp-send sock s` → nil (blocking write of string)
- `tcp-close sock` → nil (idempotent)
- `tcp-controlling-process sock pid` → nil (transfer socket ownership; activates reading to new owner)
- `tcp-local-port sock` → int or nil
- `tls-request host port request` → sock (TLS client, low-level; "prefer http-get" mentioned but http-get doesn't exist yet)

**Crypto:**
- `%sha1 s` → lowercase hex (SHA-1 of UTF-8 bytes of s) — needed for WebSocket handshake
- `%sha1-bytes bytes` → lowercase hex (SHA-1 of byte-int vector)
- `%sha256 s` / `%sha256-bytes bytes` → lowercase hex
- `%hmac-sha256 key message` → lowercase hex — needed for session signing
- `%random-bytes n` → vector of n cryptographically-strong byte ints (0–255)
- `random-token` → hex string (strong random, for CSRF tokens, session IDs)
- `%chacha20-encrypt` / `%chacha20-decrypt` (AEAD)
- `%pbkdf2-sha256` (password hashing)

**Bytes:**
- `string->utf8-bytes s` → vector of byte ints (0–255)
- `utf8-bytes->string bytes` → string (errors on invalid UTF-8)

## What's missing (needed for web stack)

- **`base64-encode` / `base64-decode`** — needed for WebSocket handshake (RFC 6455). Plan: implement in pure Brood inside brood-http (~60 lines bit manipulation). May promote to stdlib later.
- **JSON encode/decode** — needed for LiveBrood wire protocol. Plan: `brood-json` as a separate nest package.
- **`http-get`** — mentioned in `tls-request` doc but not in image. HTTP client convenience fn; not blocking for server work.
- **URL percent-encode/decode** — needed for query string parsing. Plan: implement in pure Brood inside brood-http (~40 lines).

## Key model detail

The TCP API is **active-mode** (Erlang-style): no blocking `recv`. Data is pushed to the *owning process's mailbox*. `tcp-controlling-process` transfers ownership — call it after spawning a worker and before the worker starts receiving, so no packets go to the wrong mailbox.

**How to apply:** when designing brood-http, always use the message-passing model. The listener receives `[:tcp-accept lsock client]`, spawns a worker, calls `tcp-controlling-process client worker-pid`, then loops. The worker receives `[:tcp sock data]` chunks and buffers them until a complete HTTP request is assembled.
