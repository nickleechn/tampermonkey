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

No browser required.

## `quicksilver-chrome/` — browser harness, **partly obsolete**

Written for 3.x. The bulk of its assertions cover the optimistic `fetch` cache,
which **4.0.0 removed** — those parts now exercise code that no longer exists.

Its speculation-rules, preload and preconnect assertions are still meaningful.
Nothing here has been rewritten, because doing so was outside the scope of the
4.0.0 change. Treat a failure in the cache sections as expected, not as a
regression, until the harness is updated or trimmed.
