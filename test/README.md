# Userscript tests

## `quicksilver-behaviour.js` — headless, current

```bash
node test/quicksilver-behaviour.js
```

Evaluates `Quicksilver.js` against a stubbed DOM and `GM_*` API and asserts the
behaviour 4.0.0 depends on: learning that does not wait for `pagehide`, heroes
attributed to the route that actually painted them, the two-sighting confidence
gate, the `pushState` fallback when the Navigation API is absent, and the scope
limits on transition prediction (same-origin only, query strings stripped,
sensitive and download targets refused).

4.3.0 makes the `PerformanceObserver` stub per entry type and advertises
Soft Navigations only when a test asks. It adds checks that a client-side
route's hero is learned from `interaction-contentful-paint` and preloaded on a
later client-side navigation there; that a paint is claimed whether it arrives
before its `soft-navigation` entry or that entry beats the route watcher; that
a later interaction on the route (a modal, which Chrome 153 reports under the
same `navigationId`) is not the hero; that a bigger text paint displaces an
image; that silence erodes nothing; that a soft-navigation entry for the
clicked link marks an SPA past the 5 s click window, while an in-page anchor
or an unclicked URL does not; that the LCP median leaves out client-side
routes and low-confidence loads; and that the hero preload waits for `<head>`
when the script runs before `<html>` exists. 9 of those 19 checks fail
against 4.2.0; the rest assert refusals and fallbacks 4.2.0 already had. Each
new guard was also mutation-checked: removing it fails its own check.

The rest of 4.3.0 splits `SLOW` into a real 2g link and a separate `SAVE_DATA`,
and has the Navigation API stub fire `navigate` before the URL commits and
`currententrychange` after it, as Chrome does. 49 more checks cover: a route
change held by a `precommitHandler`, soft-route hero included; a bfcache restore
re-warming the pressed link and renewing the prediction; blanket rules following
the connection tier, including a change missed in the bfcache; no
`expects_no_vary_search`; Save-Data warming nothing and scoring nothing; no
`<link rel=prefetch>` fallback on a slow link; `sizes="auto"` never reaching a
preload, in new and stored records; where a navigation came from under each
`Referrer-Policy`; `GM_addElement` used when present, with a fallback when it
returns null or throws; and Part 7 watching only media that starts empty, with no
forced layout. 29 of those 49 fail against the first 4.3.0 commit (`9b66f859`).

No browser required.

## `quicksilver-safari-behaviour.js` — headless, current

```bash
node test/quicksilver-safari-behaviour.js
```

Evaluates `Quicksilver.safari.user.js` against a stubbed **WebKit** DOM — no
`navigator.connection`, no `largest-contentful-paint`, no Navigation API, no
speculation rules — and asserts what the port rests on: the WebKit-only guard,
the geometric hero heuristic and its raised three-sighting gate, the connection
tier learned from Navigation Timing, and the same scope limits on transition
learning the Chrome build has.

1.1.0 adds what was ported from the Chrome build's 4.1.0 and 4.2.0, asserted
where a wrong answer costs the most: the action-link filter on the
document-warming path (a credentialed GET in Safari), `target="_self"` and bare
`<a download>`, SPA detection switching warming off, transition targets that
age out and make room for a fifth, `<picture>` heroes, zoom-tolerant viewport
matching, icon fonts left alone, the origin gate and budget, and hero hit-rate
scoring. It also stubs the three APIs 1.1.0 feature-detects — LCP, the
Navigation API and `<link rel=prefetch>` — and checks each is used when
present and that the 1.0 fallback runs when it is not. Run against 1.0.1,
23 checks fail before the suite stops at the all-sites hit-rate tally, which
1.0.1 never writes.

1.2.0 (Safari 27) adds Speculation Rules prefetch, which WebKit ships behind a
feature flag: a press prefetches through a list rule without the opt-in
toggle and on every tier, one rule replaces the last, learned next pages are
prefetched, action links and known SPAs are refused, a Trusted Types page
gets its rule through a private policy, and an enforced (not report-only) CSP
block hands the pressed link to the opt-in path. It also checks that Safari
27's `sizes="auto"` is never replayed into a preload. 13 of those 18 checks
fail against 1.1.0; the other five assert refusals 1.1.0 already made.

No browser required.

## `supertube-safari-behaviour.js` — headless, current

```bash
node test/supertube-safari-behaviour.js
```

Evaluates `Supertube.safari.user.js` against a stubbed **WebKit** DOM and
asserts what 2.1.0 rests on: that AV1 filtering survives Safari 17+, where
`ManagedMediaSource` declares its *own* static `isTypeSupported` and so is not
covered by patching `MediaSource`; that VP9 is never filtered, because 4K
depends on it and H.264 tops out at 1080p; that the settings-menu fallback
honours the same ceiling as the player-API path; and that the `MutationObserver`
never falls back to observing the whole feed. (2.1.0 also capped selection at
4K and kept a 1080p ABR floor; 2.3.0 replaces both, see below.)

Seven of its seventeen assertions fail against 2.0.0 — the suite was written to
pin down real regressions, not to describe code that already worked.

2.3.0 adds assertions grounded in YouTube's own player code (base.js
`8ab5c328`): the quality menu picks with `setPlaybackQualityRange(q, q,
formatId)` and a range only counts as locked when min equals max, so the suite
checks that the pick is pinned and carries its `formatId`, that Premium 1080p
is chosen that way with no settings-menu walk, that a player whose formats have
not loaded yet is waited on rather than menu-clicked, that a player still
holding the previous video is not pinned, that a round ending without a pick
re-arms on the next player event, that `yt-player-quality` is raised to the
ceiling in YouTube's current record shape before the player boots, that
`/live/<id>` is a watch page, and that the dropped-frame guard steps down one
level at a time, never below 1080p, only measures visible playback at the
guarded level, and only remembers a limit after failing on two page loads.

2.4.0 ships `CODEC_PROFILE = 'force-av1'` and `MAX_QUALITY = 'hd2160'`. The checks
above run with the old `'auto'` and `'highres'` values patched back in, because
those paths still exist. A new section runs the shipped defaults, grounded in
base.js `11a45ffb`: AV1 is allowed synchronously with no probe, a native refusal
is never spoofed away, VP9 survives, `html5_force_av1_for_testing` reaches every
player config whichever side of the page's `var ytcfg` the script lands on, and
the 4K ceiling and plain-over-Premium pick hold on both selection paths. No
headless check can show that the player honours the flag; that takes real Safari
and Stats for nerds.

No browser required.

## `quicksilver-chrome/run.js` — real Chrome, current

```bash
node test/quicksilver-chrome/run.js
```

Drives a real headless Chrome over the DevTools Protocol using only Node 22's
built-in `fetch` and `WebSocket` — no npm packages, no Python. The binary is
`$QS_CHROME`, else Google Chrome on macOS, else `google-chrome`/`chromium` on
`PATH`. `$QS_SCRIPT` runs another build of the script (an older release, say)
to see which checks it fails.

The headless suites stub the DOM, so they cannot see what Chrome does with the
rules the script writes. This one asserts on Chrome's own reports (the CDP
`Preload` domain), on navigation timing in the page that opened, and on a
fixture server's request log: every rule set parses; action links
(`/logout`, `/Account/LogOff`, `?auth=` votes, `/remove-from-cart/5`,
`<a download>`) get no request and no preload attempt after hover and
pointerdown; a hovered link is prefetched and the click lands on it with
`deliveryType` `navigational-prefetch` and no second request; pointerdown
makes a prerender attempt; a Trusted Types page still gets its rules; a strict
CSP sends pointerdown down the `<link rel=prefetch>` path; an SPA router is
detected and link speculation withdrawn; and the learned hero is preloaded on
the third page load.

Prerender can't be activated with DevTools attached (Chrome reports
`PrerenderingDisabledByDevTools`), so prerender checks stop at Chrome
accepting the rule and making the attempt. Each check runs on its own fixture
server, so on its own origin, and learning (which falls back to per-origin
`localStorage` without `GM_*`) can't leak between checks.

4.3.0 adds the Soft Navigations checks, in a real browser where the API's
heuristics actually run: a router that pushes 5.6 s after the click is marked
as an SPA, and a client-side route's hero is learned from the navigating
interaction (a later modal paint on the same route is ignored) and preloaded
on the third visit. Both skip with a note on a Chrome without the API.

The rest of 4.3.0 adds 13 checks, on what only a real browser can settle: a
`precommitHandler` route is recorded and learns its hero; a bfcache restore warms
the pressed link again; each `Referrer-Policy` files a transition under the page
it came from; media inserted empty stays unrequested until it is near, and media
with a source is left alone; a `sizes="auto"` hero fetches no bigger candidate;
and `font-display` reaches the `FontFace`. 9 of the 13 fail against the first
4.3.0 commit (`9b66f859`).

28 checks, all passing on Chromium 156. The first 15 also pass on Chrome 153, and
4 of those fail against 4.2.0: the three Soft Navigations checks, and the
page-load hero, which 4.2.0 dropped when injected before `<html>` existed (as
CDP does).

`GM_*` APIs are absent here, so `GM_addElement` getting past a strict CSP needs
checking in real Tampermonkey: on a strict-CSP site that isn't an SPA, DevTools >
Application > Speculative loads should list the rules.

This replaces the 3.x harness (`index.html`, `harness_server.py`,
`run_system_chrome.py`), which mostly tested the fetch cache 4.0.0 removed
and only ran against Chrome on macOS.
