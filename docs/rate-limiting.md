# Rate limiting

`web/ratelimit` is a token-bucket limiter as a plug. It lives in hatch rather than in a
package of its own, because an app that cannot throttle its own login form is incomplete —
and because the alternative costs a version-coordination tax on every change for 200 lines
with one consumer. What keeps that from being a straitjacket is that **every part of the
decision is replaceable**. This page is about those seams.

```brood
(through [(ratelimit/rate-limit {:rate 100 :per 60000 :burst 20})]
  (post "/login" auth/login))
```

Each key owns a bucket holding up to `:burst` tokens, refilled at `:rate` per `:per` ms. A
request spends `:cost`. An empty bucket answers `429` with a `Retry-After`. Put the plug
early in the pipeline so a throttled request is rejected before the expensive work.

## Choosing numbers

Two numbers, and they answer different questions.

- **`:rate` / `:per`** is the sustained ceiling — what a caller may average.
- **`:burst`** is how much of it they may spend at once. It is the one people get wrong:
  set it equal to `:rate` (the default) and a client may spend a whole minute's allowance in
  a second, then wait. Set it low and a legitimate client doing a batch of work is throttled
  for being efficient.

Start from what a *correct* client does. A dependency resolver fetching a few hundred
packages in a run is not abuse; a limit that breaks the tool it exists to serve is a limit
someone will delete. Then check the number against what the resource can actually take —
a pool of five connections is a much lower ceiling than a rate limit usually is.

## The four seams

### Who is being limited — `:key-fn`

```brood
(ratelimit/rate-limit {:key-fn ratelimit/network-key})
```

| | keys by |
|---|---|
| `client-key` (default) | the client address a proxy named |
| `network-key` | an IPv6 caller's **/64**, IPv4 unchanged |

Prefer `network-key` for an abuse control on a public endpoint. An address is not a client:
IPv6 privacy extensions rotate the host half, and a caller who wants to can cycle addresses
far faster than a bucket refills — so a per-address bucket is escaped by picking a new one.
`web/auth/allow-ips` already treats a /64 as the unit of identity.

The cost cuts both ways: everyone behind one /64 shares a bucket. That is right for abuse
control and wrong wherever a neighbour's traffic must not affect yours, which is why
`client-key` remains the default.

Your own key function is any `(fn (conn) -> key)` — an account id, an API token, a tenant,
or a constant for one shared ceiling across all callers.

### Whether to limit at all — `:skip?`

```brood
(ratelimit/rate-limit {:skip? (fn (conn) (= (get conn :path) "/health"))})
```

Route-level wiring is coarse; this is per request. Exempt an internal caller, an address
allow-list, an authenticated operator.

**Never limit the platform's health check.** Throttling it does not protect the machine — it
causes the outage the check exists to detect: the probe reads a 429 as a failure, the
machine is pulled, and its traffic goes to a machine already under the same load.

### What a request costs — `:cost`

```brood
(ratelimit/rate-limit {:cost (fn (conn) (if (= (get conn :path) "/bulk") 10 1))})
```

A number, or a function of the conn. A request for a hundred rows and one for a single row
should not spend the same token.

### Where the buckets live — `:store`

A value implementing the `BucketStore` ability:

```brood
(take-tokens [self key cost config now] -> :ok | [:deny retry-ms])
```

`config` is `{:rate :per :burst}` as `bucket-config` resolves it. `now` is epoch milliseconds
from the *caller*, passed in rather than read inside — which is what lets a store be tested
at a time of the test's choosing.

`refill` and `spend` are public, so a store reuses the token-bucket arithmetic rather than
reimplementing it. A Postgres- or Redis-backed store is roughly those two functions around a
row — and because the store is a record, it carries its own pool rather than closing over
one:

```brood
(defrecord pg-store (pool))

(impl BucketStore my-app/pg-store
  (take-tokens [store key cost config now]
    (let (bucket (load-bucket (pg-store-pool store) key)
          outcome (ratelimit/spend bucket config cost now))
      (save-bucket (pg-store-pool store) key (nth outcome 0))
      (nth outcome 1))))

(ratelimit/rate-limit {:store (pg-store my-pool) :rate 100 :per 60000})
```

There is one spelling. This seam originally took a `{:take fn}` map, and a map is no longer a
store — two ways to write one thing means two shapes a reader has to recognise, and a map that
merely looks like a store failing at the call rather than at the definition. Handing one over
raises with the ability's own name on it.

### What a rejection looks like — `:on-limit`

`(fn (conn retry-after-seconds) -> conn)`. The default halts with a plain-text 429. An API
wants a JSON body so the client's decoder gets an object rather than a document.

## What this does not do

**Buckets are per node.** The default store is one process per machine, so a client
round-robined across N machines gets **N times** the configured allowance — measured on a
two-machine deployment as a burst of 20 admitting 40.

This is a trade, not an oversight. The decision sits on the request path, and a shared store
spends a network round trip on *every limited request* to avoid over-admitting by the
machine count. `web/cache` refuses the same trade for the same reason: per-node copies, only
invalidations cross the network. Divide your intended ceiling by the machine count, or
supply a `:store` when you need a ceiling you can prove — and know what the round trip
costs before you do.

**Buckets are never evicted.** The table is keyed by whatever `:key-fn` returns, so a key
taken from user input grows it without bound. `stats` reports `:buckets` for exactly that
reason: a steadily climbing count is the bug, visible before it is a memory problem.

**It fails open.** If the limiter does not answer within a second the request is allowed.
The worst case of admitting a window of traffic is a busy server; the worst case of the
alternative is an outage caused by the thing meant to prevent one.

**An address is a weak identity.** `client-key` trusts a proxy header (`web/auth/client-ip`),
meaningful only because the proxy overwrites it. Read from a request that did not come
through one, it is whatever the caller typed. An outer defence, never the only one.

## Seeing it work

A limiter that never denies and one nobody reaches look identical from outside, and both
look like one that is working.

- **`stats`** gives `{:allowed :denied :deny-rate :buckets}`. `:deny-rate` is nil until
  there have been decisions — no traffic is not a healthy zero. It is a number and not
  always a float (`round-to` demotes a whole value), so format it rather than comparing it.
- **`web/dashboard`** renders those as a *rate limiting* section, next to cache and cluster.
- **Telemetry**: every rejection emits `[:hatch :ratelimit :denied]` with the key, cost,
  method and path, so a 429 storm reaches a metrics pipeline instead of only the access log.

## Verifying a limit, honestly

Read the config and you will be wrong by the machine count. Drain a bucket instead, and
rotate the identity while you do it — that is the check that catches per-address keying:

```bash
# 26 requests, a fresh IPv6 host half on each: a /64 bucket of 20 should stop this at 20.
for i in $(seq 1 26); do
  curl -s -o /dev/null -w '%{http_code} ' \
    -H "Fly-Client-IP: 2c0f:ef18:1b2e:0:aaaa:$i:2:3" https://example.com/api/thing
done
```
