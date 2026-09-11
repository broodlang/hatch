# SEO and security headers

What hatch does for you, what it warns you about, and what it deliberately refuses to do.

An SEO audit tool will hand you a list. Some of it is real, some of it is generic advice that
is wrong for your site, and the generic items are the loud ones. This page is the triage, and
the defaults exist so the real items are already handled before anyone runs a scan.

## On by default

| | what | where |
|---|---|---|
| `X-Content-Type-Options: nosniff` | never MIME-sniff a response into an executable type | `web/endpoint` |
| `X-Frame-Options: DENY` | clickjacking | `web/endpoint` |
| `Referrer-Policy: strict-origin-when-cross-origin` | don't leak full paths cross-origin | `web/endpoint` |
| `Strict-Transport-Security: max-age=31536000` | **HTTPS requests only** | `web/endpoint` |
| `ETag` + conditional GET | a revalidation costs a 304, not the body | `web/endpoint` |
| `Content-Encoding` | brotli where offered, else gzip | `web/endpoint` |

Every one is merged *under* whatever a handler set, so an app that needs a page framed, or a
different referrer policy, just sets it.

### HSTS, and why `includeSubDomains` is not the default

It is sent only when `web/conn/secure?` says the request arrived over HTTPS — behind a
proxy, read from `X-Forwarded-Proto`. Over plaintext the specification says a client MUST
ignore the header, and a header that is ignored is one nobody notices is misconfigured.

`includeSubDomains` is the usual recommendation and hatch will not make that promise for
you: it commits *every* subdomain of the host to HTTPS, including ones your app has never
heard of, and a staging or internal subdomain still serving plaintext simply stops working —
with a year-long memory in every browser that saw it. `preload` is the same commitment made
irreversible. Both are one string away when you have checked:

```brood
(web/endpoint/serve {:router app-router :hsts "max-age=31536000; includeSubDomains"})
```

## One line to add

### A canonical host

One page reachable at several addresses is one page's worth of ranking split across them, and
the addresses accumulate without anyone adding them — an apex and a `www`, a platform
hostname beside a custom domain, an old domain still pointed at the app.

```brood
(through [(seo/canonical-host *site*)]
  (get "/" home/index))
```

301, so the signal transfers; path and query preserved, so deep links survive; `:except` for
a probe that dials the machine by an internal name.

A `<link rel="canonical">` states a preference. This *enforces* one, which is the only
version that also fixes a duplicate already in an index.

### `robots.txt`, `sitemap.xml`, `llms.txt`

`seo/robots-handler`, `seo/sitemap-handler` (derived from the router's own table, so it
cannot drift from the routes) and `seo/llms-handler`. See `web/seo`.

### Per-page metadata

`seo/head-tags` — description, canonical, robots, Open Graph, JSON-LD.

### Marking user-generated links

Content your users wrote is content you should not vouch for. An external link in a README,
a comment or a profile wants `rel="nofollow ugc noopener"` — without it, being able to post
is being able to buy links off your domain. Your *own* outbound links should not have it:
marking your project's own repository `nofollow` discards a real signal to say something
untrue.

## Warned about in dev

`web/audit` runs on every rendered page in dev, logs, and never alters the response. Each
rule is written to have no false positives — a lint that cries wolf is one people stop
reading.

- **Inert controls** — an input no form, handler or script can reach.
- **First flight** — a document too large to paint in one TCP round trip, and
  render-blocking third-party resources in `<head>`.
- **Unstyled canvas** — a stylesheet with no `color-scheme` declared ahead of it, so every
  navigation flashes the browser's default background.
- **Heading hierarchy** — `h1` followed by `h3` with no `h2`. A level is size in CSS and
  *structure* in HTML; skipping one tells a reader navigating by heading that they are inside
  a section that does not exist. The classic defect that looks perfect.
- **Favicon** — no `<link rel="icon">` at all. Serve `/favicon.ico` as well: browsers and
  scanners ask for it without reading your markup.
- **WebMCP tool coverage** — a page that declares tools and still leaves a GET form no tool
  can stand in for. A form annotated with `toolname` counts as covered by itself.

## Making a form agent-callable

WebMCP has two halves, and the choice between them is not a style question.

The **imperative** API (`mcp/tools-script`) registers tools through JavaScript, backed by
whatever endpoint you name. Use it for a capability that is not a form — a lookup with no
UI, an action the page performs itself.

The **declarative** API annotates the form directly, and the browser derives the tool's input
schema from the fields:

```brood
[:form
  (merge {:action "/packages" :method "get"}
    (mcp/form-tool {:name "searchPackages"
                    :description "Search the package registry by name."
                    :autosubmit true}))
  [:label {:for "q"} "Search"]
  [:input {:id "q" :name "q" :toolparamdescription "Search text."}]]
```

Prefer it whenever a form already does the thing. There is no endpoint to duplicate and no
second code path to keep in step — and, the part that matters in practice, **an annotated
form is static HTML**. A crawler, an audit tool, or an agent that never executes the page can
still see the capability; the imperative block is invisible to all of them, because it is
only real once a browser that implements WebMCP has run the script and registered the tools.

That distinction is worth knowing before reading an audit report. A tool that lists "WebMCP
tools registered" is reporting what a browser registered *at analysis time*, so a page using
only the imperative API shows nothing there — not because the page is wrong, but because the
scanner's browser does not implement the API. Annotated forms show up regardless.

`:autosubmit` lets an agent submit the form once it has filled it. Right for a search; wrong
for anything that spends money or cannot be undone, which is why it is off by default.

## What hatch will not do

**A CDN.** Real infrastructure, not a header. Weigh it against where your database is: an app
that moves away from its data pays that round trip on every query, which is usually worse
than the bytes it saved.

**Analytics.** Adding third-party tracking to raise an audit score is bad advice. It is
render-blocking third-party JavaScript on every page — the exact thing `web/audit`'s
first-flight rule warns about — plus a privacy and compliance obligation, in exchange for a
checkbox. `web/metrics` and `web/dashboard` already answer "what is this app doing" without
any of that.

**`ads.txt`.** It declares who may sell *advertising* on your site. If you sell none, the
file has nothing to say.

**SPF/DMARC records.** DNS, not application code — and only relevant if the domain sends
mail. Worth setting anyway to stop spoofing, but nothing hatch can emit.

**Keyword optimisation.** "Include the most common keywords in the title, meta description and
headings" is advice to write well about your subject, not a change to make. Nothing a
framework can do, and stuffing keywords is worse than ignoring it.
