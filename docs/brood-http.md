# brood-http

*A pure-Brood HTTP/1.1 server with WebSocket upgrade. No Rust, no external
packages beyond Brood's stdlib. The foundation every other web layer builds on.*

---

## What this is

brood-http is to the Brood web stack what Bandit is to Phoenix: a clean,
swappable server layer that speaks HTTP to the outside world and hands a
structured request/response pair to the application layer above it.

The application layer (router, controllers, live sessions) never calls TCP
directly. It only sees the brood-http interface: receive a request map,
return a response map.

---

## Stdlib primitives used

Everything brood-http needs already exists in Brood's stdlib. No new Rust
code required.

**TCP (message-passing model — not blocking reads):**

```
tcp-listen host port    → listener-socket
                          connections arrive as [:tcp-accept lsock client]
                          messages to the calling process

tcp-send sock s         → nil   (write string, blocking)
tcp-close sock          → nil
tcp-controlling-process sock pid  → nil  (hand socket to another process)
tcp-local-port sock     → int or nil
```

The model: TCP data is **pushed to the owning process's mailbox** as
`[:tcp sock data]` messages. A socket closed by the peer arrives as
`[:tcp-closed sock]`. There is no blocking `recv` — you `receive` on your
own mailbox. `tcp-controlling-process` transfers ownership so the listener
can spawn a worker and hand it the accepted socket.

**Crypto (for WebSocket handshake and session signing):**

```
%sha1 s                 → lowercase hex string  (SHA-1 of UTF-8 bytes of s)
%sha1-bytes bytes       → lowercase hex string  (SHA-1 of byte-int vector)
%hmac-sha256 key msg    → lowercase hex string
%random-bytes n         → vector of n byte ints (0–255)
random-token            → hex string (cryptographically strong)
```

**Bytes:**

```
string->utf8-bytes s    → vector of byte ints
utf8-bytes->string bs   → string
```

---

## Implemented in brood-http (not in stdlib)

### Base64 encode/decode

Required for RFC 6455 WebSocket handshake: SHA-1 of the nonce must be
base64-encoded in the `Sec-WebSocket-Accept` response header.

Implemented as `http/util/base64-encode` and `http/util/base64-decode`
(~60 lines). Operates on byte-int vectors. Also used for session token
embedding.

```lisp
(base64-encode [72 101 108 108 111])   ; => "SGVsbG8="
(base64-decode "SGVsbG8=")             ; => [72 101 108 108 111]
```

### URL percent-encode/decode

Required for parsing query strings and form-encoded bodies.

```lisp
(url-decode "hello%20world%21")        ; => "hello world!"
(url-encode "hello world!")            ; => "hello%20world%21"
```

### Query string parser

```lisp
(parse-query "page=2&q=hello%20world") ; => {:page "2" :q "hello world"}
```

---

## Architecture

### Process tree

```
http-supervisor  (named :http-supervisor)
├── listener     (tcp-listen; receives [:tcp-accept ...] messages)
└── workers      (one per active connection; spawned on each accept)
    ├── worker-1 (owns socket; parses HTTP; calls handler; sends response)
    ├── worker-2
    └── ...
```

The listener process never crashes — it just loops receiving accept
messages. Worker crashes are isolated: the connection drops, the listener
continues. The supervisor monitors workers but doesn't restart them
(a crashed worker just means the connection is lost — the client retries).

### Listener process

```lisp
(defn listener--loop (lsock handler)
  (receive
    ([:tcp-accept ~lsock client]
     (let (pid (spawn (worker--run client handler)))
       (tcp-controlling-process client pid)
       (listener--loop lsock handler)))
    ([:stop]
     (tcp-close lsock))))
```

Key point: `tcp-controlling-process` must be called *before* the worker
starts its own `receive`, otherwise the first data packet might arrive at
the listener's mailbox instead of the worker's.

Actually, the safe order is:
1. Listener receives `[:tcp-accept lsock client]` — socket is in passive mode
2. Listener spawns worker (the client socket is not yet reading)
3. Listener calls `tcp-controlling-process client worker-pid` — activates
   reading, directing data to the worker's mailbox
4. Worker begins its `receive` loop

### Worker process — HTTP/1.1

A worker receives `[:tcp sock data]` messages and buffers them until a
complete HTTP request has arrived.

```lisp
(defn worker--run (sock handler)
  (let (req (worker--read-request sock ""))
    (match req
      ([:ok request]
       (let (response (try (handler request)
                           (catch e (error-response 500 (error-message e)))))
         (worker--send-response sock response)
         (when (keep-alive? request response)
           (worker--run sock handler))))
      ([:error msg]
       (worker--send-response sock (error-response 400 msg))))))

(defn worker--read-request (sock buf)
  ;; Accumulate [:tcp sock data] messages until we have a full request
  (receive
    ([:tcp ~sock chunk]
     (let (buf (str buf chunk))
       (match (try-parse-request buf)
         ([:ok request] [:ok request])
         ([:incomplete]  (worker--read-request sock buf))
         ([:error msg]   [:error msg]))))
    ([:tcp-closed ~sock]
     [:error "connection closed before request complete"])))
```

### HTTP/1.1 request parser

Parses the accumulated string buffer:

```
GET /users/42?page=2 HTTP/1.1\r\n
Host: localhost:4000\r\n
Content-Type: application/json\r\n
Content-Length: 18\r\n
\r\n
{"name":"Alice"}
```

Into:

```lisp
{:method  "GET"
 :path    "/users/42"
 :query   "page=2"
 :version "1.1"
 :headers {:host "localhost:4000"
           :content-type "application/json"
           :content-length "18"}
 :body    "{\"name\":\"Alice\"}"}
```

**Parser steps:**
1. Find `\r\n\r\n` (end of headers). If not found → `:incomplete`.
2. Split into header block and potential body.
3. Parse request line: `(string-split request-line " ")` → method, path+query, version.
4. Split path+query on `?`.
5. Parse headers: each `\r\n`-delimited line split on `: `.
6. Check `Content-Length` to know how many body bytes to expect.
7. If body is incomplete → `:incomplete`; accumulate more chunks.

Header names are lowercased and keywordified (`"Content-Type"` → `:content-type`).

**Content-Length handling:**

```lisp
(defn try-parse-request (buf)
  (let (sep (index-of buf "\r\n\r\n"))
    (if (= sep -1)
      [:incomplete]
      (let (header-part (substring buf 0 sep)
            body-start  (+ sep 4)
            headers     (parse-headers header-part)
            clen        (string->number (get headers :content-length "0"))
            body-end    (+ body-start clen))
        (if (< (string-length buf) body-end)
          [:incomplete]
          [:ok {:method  ...
                :headers headers
                :body    (substring buf body-start body-end)}])))))
```

### HTTP/1.1 response serializer

```lisp
(defn write-response (sock response)
  (let (status  (get response :status 200)
        headers (get response :headers {})
        body    (get response :body "")
        headers (assoc headers :content-length (str (string-length body)))
        head    (str "HTTP/1.1 " status " " (status-text status) "\r\n"
                     (join "" (map header-line (entries headers)))
                     "\r\n")]
    (tcp-send sock head)
    (tcp-send sock body)))

(defn header-line ([k v]) (str (name k) ": " v "\r\n"))
```

### Keep-alive

HTTP/1.1 defaults to keep-alive. A worker loops on the same socket for
multiple requests until:
- `Connection: close` is in the request or response headers
- The socket closes (`[:tcp-closed sock]`)
- An error occurs

```lisp
(defn keep-alive? (request response)
  (and (= (get request :version) "1.1")
       (not (= (lower (get-in request [:headers :connection] "")) "close"))
       (not (= (lower (get-in response [:headers :connection] "")) "close"))))
```

---

## WebSocket upgrade

### Handshake (RFC 6455)

The client sends a normal HTTP GET with:
```
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

The server responds with:
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Where `Sec-WebSocket-Accept` is:
1. Concatenate `Sec-WebSocket-Key` + magic string `"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"`
2. SHA-1 hash → raw bytes (20 bytes)
3. Base64-encode those 20 bytes

We have `%sha1` which gives us lowercase hex, not raw bytes. So:

```lisp
(defn ws-accept-key (client-key)
  (let (magic  "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        hex    (%sha1 (str client-key magic))    ; lowercase hex, 40 chars
        bytes  (hex->bytes hex)                  ; 20-byte vector
        )
    (base64-encode bytes)))

(defn hex->bytes (hex)
  ;; "deadbeef" → [0xDE 0xAD 0xBE 0xEF]
  (let (pairs (chunk-every (string->list hex) 2))
    (map (fn (pair)
           (let (hi (hex-digit->int (first pair))
                 lo (hex-digit->int (first (rest pair))))
             (+ (* hi 16) lo)))
         pairs)))
```

`hex-digit->int` maps `"0"`–`"9"` → 0–9, `"a"`–`"f"` → 10–15.

### Detecting an upgrade request

```lisp
(defn upgrade-request? (request)
  (and (= (lower (get-in request [:headers :upgrade] "")) "websocket")
       (= (get request :method) "GET")))
```

When the handler returns `{:upgrade :websocket :handler ws-pid}`, the
worker:
1. Sends the 101 response
2. Calls `tcp-controlling-process sock ws-pid` — the WS session process
   now owns all future `[:tcp sock data]` messages
3. Exits (its job is done)

### WebSocket frame codec

RFC 6455 frames have a variable-length binary header. Brood strings are
UTF-8, but TCP data arrives as raw bytes. We represent frame bytes as
Brood strings where each character is one byte (codepoint 0–255). The
`string->utf8-bytes` / `utf8-bytes->string` pair bridges between the two.

#### Frame structure

```
Byte 0:  FIN(1) RSV(3) OPCODE(4)
Byte 1:  MASK(1) PAYLOAD-LEN(7)
Bytes 2–9: extended payload length (if len=126: 2 bytes, if 127: 8 bytes)
Bytes N–N+3: masking key (if MASK bit set — always set for client→server)
Bytes M–: payload (XOR'd with masking key for client→server frames)
```

#### Opcodes

```
0x0  continuation
0x1  text frame
0x2  binary frame
0x8  close
0x9  ping
0xA  pong
```

#### Frame reader

```lisp
(defn ws-read-frame--loop (sock buf)
  ;; Accumulate [:tcp sock data] chunks until we have a complete frame
  (receive
    ([:tcp ~sock chunk]
     (let (buf (str buf chunk))
       (match (ws-try-parse-frame buf)
         ([:ok frame rest] [:ok frame rest])
         ([:incomplete]    (ws-read-frame--loop sock (str buf ""))))))
    ([:tcp-closed ~sock]
     [:closed])))

(defn ws-try-parse-frame (buf)
  (let (bytes (string->utf8-bytes buf))
    (if (< (count bytes) 2)
      [:incomplete]
      (let (b0      (get bytes 0)
            b1      (get bytes 1)
            fin     (= (bit-and b0 0x80) 0x80)
            opcode  (bit-and b0 0x0F)
            masked  (= (bit-and b1 0x80) 0x80)
            len7    (bit-and b1 0x7F))
        (ws-parse-frame--length bytes fin opcode masked len7)))))
```

#### Frame writer (server → client, no masking)

```lisp
(defn ws-write-frame (sock opcode payload)
  (let (payload-bytes (string->utf8-bytes payload)
        plen          (count payload-bytes)
        header        (cond
                        (<= plen 125)
                        [(bit-or 0x80 opcode) plen]

                        (<= plen 65535)
                        [(bit-or 0x80 opcode) 126
                         (bit-shift-right plen 8) (bit-and plen 0xFF)]

                        else
                        [(bit-or 0x80 opcode) 127
                         ;; 8-byte big-endian length
                         0 0 0 0
                         (bit-shift-right plen 24) (bit-shift-right plen 16)
                         (bit-shift-right plen  8) (bit-and        plen 0xFF)])
        frame         (utf8-bytes->string (concat header payload-bytes)))
    (tcp-send sock frame)))

(defn ws-send-text  (sock payload) (ws-write-frame sock 0x1 payload))
(defn ws-send-close (sock)         (ws-write-frame sock 0x8 ""))
(defn ws-send-pong  (sock payload) (ws-write-frame sock 0xA payload))
```

---

## Server adapter interface

The adapter map lets you swap the underlying server without changing
application code. `http/server/start` takes an optional `:adapter` key:

```lisp
;; Default: pure-Brood adapter
(http/server/start {:port 4000 :handler my-handler})

;; Explicit adapter
(http/server/start {:port 4000 :handler my-handler
                    :adapter http/adapter/brood})
```

An adapter is a map of functions:

```lisp
{:listen   (fn (host port) -> lsock)
 :close    (fn (sock) -> nil)
 :send     (fn (sock s) -> nil)
 :transfer (fn (sock pid) -> nil)   ; tcp-controlling-process equivalent
 :port     (fn (sock) -> int)}
```

The default adapter is:

```lisp
(def http/adapter/brood
  {:listen   tcp-listen
   :close    tcp-close
   :send     tcp-send
   :transfer tcp-controlling-process
   :port     tcp-local-port})
```

Everything in the listener/worker code goes through the adapter map rather
than calling TCP primitives directly. This keeps brood-http testable
(substitute a mock adapter) and swappable (a future native adapter could
drop in without changing the application).

---

## Error responses

```lisp
(defn error-response (status msg)
  {:status  status
   :headers {:content-type "text/plain; charset=utf-8"}
   :body    (str (status-text status) ": " msg)})
```

Any unhandled exception in the handler generates a 500. The worker process
itself does not crash — it catches the error, sends the 500, and either
loops (keep-alive) or closes the connection.

---

## Public API

```lisp
;; Start a server. Returns the listener pid (registered as :http-listener).
(http/server/start opts)
  ;; opts: {:port int
  ;;        :host string (default "0.0.0.0")
  ;;        :handler fn(request-map) -> response-map
  ;;        :adapter adapter-map (default http/adapter/brood)}

;; Stop the server.
(http/server/stop)

;; The port the server is listening on (useful when port was 0).
(http/server/port)
```

### Request map

```lisp
{:method   "GET"                   ; uppercase string
 :path     "/users/42"             ; decoded, no query string
 :query    "page=2"                ; raw query string
 :params   {:page "2"}             ; parsed query map (url-decoded)
 :version  "1.1"
 :headers  {:content-type "..."    ; lowercased keyword keys
            :host "..."}
 :body     ""}                     ; raw string body
```

### Response map

```lisp
{:status   200                     ; integer
 :headers  {:content-type "..."}   ; keyword keys
 :body     ""}                     ; string body

;; WebSocket upgrade
{:upgrade  :websocket
 :handler  pid}                    ; process that takes over the socket
```

---

## Testing

The adapter interface makes brood-http testable without opening real
sockets. A mock adapter records sent bytes; the test injects request
bytes via simulated `[:tcp sock data]` messages.

```lisp
(describe "http request parser"
  (test "parses GET request"
    (let (raw  "GET /users/42 HTTP/1.1\r\nHost: localhost\r\n\r\n"
          req  (try-parse-request raw))
      (assert= req [:ok {:method "GET" :path "/users/42" :query ""
                         :version "1.1" :headers {:host "localhost"}
                         :body ""}])))

  (test "returns :incomplete for partial headers"
    (assert= (try-parse-request "GET /foo HTTP/1.1\r\nHo") [:incomplete])))

(describe "websocket handshake"
  (test "accept key derivation"
    ;; RFC 6455 test vector
    (assert= (ws-accept-key "dGhlIHNhbXBsZSBub25jZQ==")
             "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")))
```

---

## What brood-http does NOT do

- TLS (terminate at a reverse proxy)
- HTTP/2
- WebSocket permessage-deflate compression
- Chunked transfer encoding for streaming responses (v1 reads the full body)
- Multipart upload streaming (v1 reads the full body into a string)
- Request timeout (v1: the worker waits forever; add a timeout in a later pass)
