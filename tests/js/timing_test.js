// Tests for brood_live.js's debounce/throttle decision. Plain `node`, no dependencies:
//
//     node tests/js/timing_test.js
//
// It is NOT part of `nest test`, and that is a limitation rather than a choice — Brood has no
// subprocess primitive, so a .blsp test cannot shell out to node. Run it by hand when you
// touch the client's timing, and see CLAUDE.md's Running section.
//
// `decideSend` is deliberately pure — state in, decision out, the clock passed as an
// argument — so all of this runs without a DOM, a socket or a real timer. Everything else in
// the client is DOM-bound and stays covered only by `node --check` plus the server-side
// protocol tests.

const { decideSend } = require("../../static/brood_live.js");

let passed = 0;
const failures = [];

function check(what, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${what}\n    expected ${e}\n    actual   ${a}`);
}

const fresh = () => ({ timer: null, last: null, pending: null });
const opts = (o) => ({ debounce: null, throttle: null, carriesValue: false, ...o });

// ---- no timing attributes ---------------------------------------------------

check(
  "with neither attribute, an event sends immediately",
  decideSend(fresh(), opts({}), 1000),
  { action: "send" },
);

// ---- debounce ---------------------------------------------------------------

check(
  "a numeric debounce always defers by its delay",
  decideSend(fresh(), opts({ debounce: 300 }), 1000),
  { action: "defer", delay: 300 },
);

check(
  "a debounce of 0 defers with no delay rather than sending inline",
  // It still goes through the timer, which is what makes it coalesce: several events in the
  // same tick collapse to the last one, which is the point of asking for a debounce at all.
  decideSend(fresh(), opts({ debounce: 0 }), 1000),
  { action: "defer", delay: 0 },
);

check(
  "a negative debounce is clamped rather than passed to setTimeout",
  decideSend(fresh(), opts({ debounce: -50 }), 1000),
  { action: "defer", delay: 0 },
);

check(
  'data-debounce="blur" holds with no timer — focusout is what releases it',
  decideSend(fresh(), opts({ debounce: "blur" }), 1000),
  { action: "hold" },
);

check(
  "debounce wins when both attributes are present",
  decideSend({ timer: null, last: 999, pending: null }, opts({ debounce: 200, throttle: 500 }), 1000),
  { action: "defer", delay: 200 },
);

// ---- throttle ---------------------------------------------------------------

check(
  "the very first event on an element sends, whatever the clock says",
  // `last` is null until something has been sent — an explicit sentinel, not a 0 that only
  // reads as "long ago" because Date.now() is large.
  decideSend(fresh(), opts({ throttle: 500 }), 0),
  { action: "send" },
);

check(
  "the first event of a throttle window sends immediately (leading edge)",
  decideSend(fresh(), opts({ throttle: 500 }), 1000),
  { action: "send" },
);

check(
  "an event exactly at the window boundary sends",
  decideSend({ timer: null, last: 500, pending: null }, opts({ throttle: 500 }), 1000),
  { action: "send" },
);

check(
  "an ACTION inside the window is dropped, not replayed later",
  // Replaying a throttled click late is not rate limiting, it is a second click.
  decideSend({ timer: null, last: 900, pending: null }, opts({ throttle: 500 }), 1000),
  { action: "drop" },
);

check(
  "a VALUE inside the window is deferred to the end of it (trailing edge)",
  // The case Phoenix's throttle gets wrong: drop the last event of a dragged slider and the
  // server is left holding a position the user never stopped on.
  decideSend(
    { timer: null, last: 900, pending: null },
    opts({ throttle: 500, carriesValue: true }),
    1000,
  ),
  { action: "defer", delay: 400 },
);

check(
  "the trailing delay shrinks as the window runs out",
  decideSend(
    { timer: null, last: 900, pending: null },
    opts({ throttle: 500, carriesValue: true }),
    1350,
  ),
  { action: "defer", delay: 50 },
);

check(
  "a value event past the window sends rather than deferring",
  decideSend(
    { timer: null, last: 900, pending: null },
    opts({ throttle: 500, carriesValue: true }),
    1500,
  ),
  { action: "send" },
);

check(
  "a throttle of 0 never suppresses anything",
  decideSend({ timer: null, last: 1000, pending: null }, opts({ throttle: 0 }), 1000),
  { action: "send" },
);

// ---- the sequence a real slider drag produces -------------------------------
//
// Walk a throttled value stream the way the session does — send, suppress, send — and assert
// the shape rather than each step in isolation.

{
  const state = fresh();
  const settings = opts({ throttle: 100, carriesValue: true });
  const actions = [];
  for (const now of [0, 20, 40, 60, 100, 120, 250]) {
    const decision = decideSend(state, settings, now);
    actions.push(decision.action);
    if (decision.action === "send") state.last = now;
  }
  check(
    "a drag sends on the leading edge, defers the rest of each window, and sends again after",
    actions,
    ["send", "defer", "defer", "defer", "send", "defer", "send"],
  );
}

// ---- report -----------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} failed:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} tests, ${passed} passed, 0 failed`);
