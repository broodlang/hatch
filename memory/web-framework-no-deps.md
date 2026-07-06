---
name: web-framework-no-deps
description: The Brood web framework must have zero external dependencies — no Rust crates, no npm packages, no Phoenix JS
metadata:
  type: project
---

The web framework (working name: LiveBrood) is pure Brood with a vanilla JS client. Two hard constraints:

1. **No new Rust code** — the framework uses only Brood stdlib primitives that already exist (or that get added to Brood stdlib as a separate task). HTTP/1.1 parsing, WebSocket framing, and response serialization are implemented in Brood. TLS is handled by a reverse proxy at the infrastructure layer.

2. **No JS dependencies** — `brood_live.js` is ~600 lines of vanilla JS with no npm packages. Phoenix's `phoenix.js` and `phoenix_live_view.js` are MIT-licensed and fine to copy ideas from, but neither is imported or vendored. The wire protocol and DOM patcher are original.

**Why:** the user wants the framework to be self-contained — installable without a Rust toolchain beyond Brood itself, and without a Node/npm step.

**How to apply:** when designing or implementing web framework features, never reach for a Rust crate or npm package. If a primitive is missing from Brood stdlib, flag it as a stdlib gap rather than adding a Rust dependency to the framework.
