// ==UserScript==
// @name         Quicksilver Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.2.0
// @description  Safari/WebKit build: learned hero preload (LCP where WebKit reports it, geometry otherwise) + critical-origin preconnect, hover/focus preconnect, learned connection tiering, navigation-transition learning, SPA detection, Speculation Rules prefetch where Safari has it switched on, media priority hints, font-display patching and opt-in content-visibility.
// @author       nickleechn
// @match        *://*/*
// @inject-into  content
// @noframes
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.safari.user.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.safari.user.js
// ==/UserScript==

// 1.2.0 — tuned for Safari 27 on macOS.
//
// - Speculation Rules. WebKit has a prefetch implementation (since 26.2),
//   still off by default in 27.0 and switched on from Develop > Feature
//   Flags. Where HTMLScriptElement.supports() says it is on, pressed links
//   and learned next pages are prefetched through it — on by default, with
//   no per-origin toggle, because nothing that made fetch() warming opt-in
//   applies: per spec the request is marked Sec-Purpose: prefetch, and the
//   navigation uses the response whether or not it was cacheable. Same action-link
//   filter, same SPA switch-off, prefetch only (WebKit has no prerender),
//   Trusted Types-safe (Safari 26 enforces them, YouTube requires them),
//   and a strict CSP falls back to the opt-in path.
// - sizes="auto" (new in 27.0, for lazy images) means "use my layout box".
//   A preload has none, so replaying it as imagesizes fell back to 100vw and
//   preloaded a bigger candidate than the <img> takes — two downloads. The
//   author's fallback list is kept; with none, the exact URL is preloaded.
// - LCP and the Navigation API shipped in Safari 26.2, so on 27 the 1.1.0
//   feature probes take the measured-LCP and event-driven paths; geometry
//   and polling are now only the fallback for older Safari.
// - Scroll anchoring (27.0) keeps the page still while content-visibility
//   sections are measured, which removes one of the opt-in's costs. The
//   others (sticky headers, clipped popovers) remain, so it stays opt-in.
//
// 1.1.0 — brought up to the Chrome build's 4.2.0, where WebKit allows it.
//
// From Chrome 4.1.0 and 4.2.0, unchanged in substance:
// - The action-link filter. It matters more here than in Chrome: document
//   warming in Safari is a real credentialed fetch(), indistinguishable from
//   a click, so /vote?id=…&auth=…, /Account/LogOff, /remove-from-cart/5 and
//   /cancelOrder must never be warmed. Links carrying a CSRF-style token are
//   refused outright, the verb list is Chrome's, matching is case-insensitive
//   and catches compound and camelCase forms, and pages that act by being
//   viewed (/message/unread/, /notifications, /inbox) are refused.
// - Transition learning could never add a fifth destination and never let
//   the first four expire. Targets now carry their own last-seen time.
// - A hero inside <picture> replayed the <img> fallback srcset, preloading a
//   JPEG the page never used. Such heroes now preload the exact URL painted.
// - Records survive zoom and nudged window edges: 320px width buckets, and a
//   srcset hero (which the browser resolves per density) ignores the DPR.
// - Icon fonts keep their blocking font-display; swap flashed ligature text.
// - Learned critical origins act on the second visit, up to 6 on a fast link.
// - target="" and target="_self" stay in the tab and are no longer refused;
//   a bare <a download> no longer slips past as "not a download".
// - SPA detection: one click whose link URL a same-document navigation then
//   lands on marks the origin as client-routed, and document warming stops
//   there (the router never uses a fetched document). Learning continues.
// - Status reports how often the hero preload was the hero that painted.
//
// Feature-detected rather than assumed absent, because WebKit has been
// closing these gaps (LCP and the Navigation API shipped in Safari 26.2):
// - Where WebKit reports largest-contentful-paint, the hero is the measured
//   LCP and the gate drops to Chrome's two sightings. Geometry remains the
//   fallback, and is still what learns routes reached by a client-side
//   navigation, which LCP never reports on.
// - Where the Navigation API exists, route changes come from its events and
//   the 400ms location poll is not started at all.
// - Where <link rel=prefetch> is supported, document warming uses it instead
//   of fetch(): the browser issues it at its own priority and, per spec,
//   marks it as a prefetch (Sec-Purpose). A script fetch() can be neither.
//
// Considered and left out: Chrome 4.2.0 warms on pointerdown on every link
// tier, because there the prefetched response *is* the navigation. Here it
// is only reused when the page is cacheable, so on a slow link it is two
// copies of the page competing for the bandwidth. Slow links still skip it.
// Trusted Types needed no change: nothing here writes to a script sink.
//
// A port of Quicksilver 4.0.0 to WebKit. Not a compatibility shim around the
// Chrome script — four of its load-bearing APIs do not exist in Safari, so the
// parts that depended on them are either rebuilt on something WebKit does have
// or removed outright. What changed, and why:
//
// 1. Speculation Rules (Parts 2, 4, and the acting half of 9) are gone.
//    WebKit implements neither prefetch nor prerender speculation, and
//    <link rel=prefetch> is not supported either — so there is no declarative
//    way to warm a *document* in Safari at all. The only remaining mechanism is
//    a manual fetch(), which duplicates the request whenever the response is
//    not cacheable and can double-count server-side page views. That is a real
//    cost for an uncertain win, so document warming is off by default and sits
//    behind a per-origin toggle (Part E). Everything else here is free.
//
// 2. Largest Contentful Paint does not exist in WebKit — no
//    'largest-contentful-paint' entry type, and no Element Timing either. The
//    hero is instead identified after load by geometry: the largest image
//    intersecting the first viewport. That is a heuristic where Chrome had a
//    measurement, so the confidence gate is raised from 2 sightings to 3 and
//    the record has to agree with itself before anything is preloaded.
//
// 3. The Network Information API does not exist in WebKit, so
//    navigator.connection is permanently undefined and the Chrome script's
//    entire tiering system would collapse to "always fast". The tier is now
//    learned from Navigation Timing — a rolling median of recent TTFB and
//    transfer rate, kept globally rather than per-origin, because it describes
//    the link and not the site.
//
// 4. The Navigation API does not exist in WebKit, and @inject-into content
//    puts this script in an isolated world where patching history.pushState
//    would only see its own world's calls. Same-document navigation is
//    detected by watching location.href on a visibility-gated interval, which
//    is world-agnostic and costs a string compare every 400ms.
//
// Also removed: the prerendering guards (nothing prerenders), the 3.x
// CacheStorage migration (that cache only ever existed under the Chrome
// script), and in-frame execution (@noframes — the surviving features are
// document-scoped and a 300x250 ad frame has no hero to learn).

(function () {
    'use strict';

    // Chromium on macOS still reports "Safari" in its UA string, and this
    // script would be a downgrade there — the Chrome build has real
    // speculation. Bail rather than compete with it.
    const uaBrands = navigator.userAgentData && navigator.userAgentData.brands;
    const isChromium = (uaBrands && uaBrands.some(b => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand)))
        || /Chrome\/|Chromium\/|CriOS\/|Edg\//.test(navigator.userAgent);
    const isGecko = /\bGecko\/\d+/.test(navigator.userAgent) && /Firefox\/|FxiOS\//.test(navigator.userAgent);
    const isWebKit = !isChromium && !isGecko
        && (/Apple/.test(navigator.vendor || '') || /Safari\/|AppleWebKit\//.test(navigator.userAgent));
    if (!isWebKit) return;

    // =========================================================================
    // Shared helpers
    // =========================================================================

    // Matches @version; the status panel reported 1.0.0 all through 1.0.1.
    const SCRIPT_VERSION = '1.2.0';

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;

    // @noframes should make this always true; kept because Safari's userscript
    // managers do not all honour it, and a frame running the learning pass
    // would file the frame's own hero under the top document's route.
    const isTopFrame = (() => {
        try {
            return window.top === window.self;
        } catch (_) {
            return false;
        }
    })();
    if (!isTopFrame) return;

    // Feature probes, all absent in at least one currently-supported Safari.
    // Read once: none of them change during a document's life.
    const supportsFetchPriority = 'fetchPriority' in HTMLImageElement.prototype;
    const supportsImageSrcset = 'imageSrcset' in HTMLLinkElement.prototype;
    const supportsLazyImages = 'loading' in HTMLImageElement.prototype;
    const supportsLazyFrames = 'loading' in HTMLIFrameElement.prototype;
    const supportsContentVisibility = typeof CSS !== 'undefined' && Boolean(CSS.supports)
        && CSS.supports('content-visibility', 'auto');
    // The three gaps the 1.0 port was built around, probed rather than
    // assumed. Each has a fallback that is the 1.0 behaviour.
    const supportsLcp = (() => {
        try {
            const types = PerformanceObserver.supportedEntryTypes;
            return Array.isArray(types) && types.includes('largest-contentful-paint');
        } catch (_) {
            return false;
        }
    })();
    const supportsNavigationApi = Boolean(window.navigation)
        && typeof window.navigation.addEventListener === 'function';
    const supportsLinkPrefetch = (() => {
        try {
            const link = document.createElement('link');
            return Boolean(link.relList && typeof link.relList.supports === 'function'
                && link.relList.supports('prefetch'));
        } catch (_) {
            return false;
        }
    })();
    // WebKit has had a Speculation Rules prefetch implementation since 26.2,
    // off by default through 27.0 and switched on from Develop > Feature
    // Flags. supports() answers for the flag, so this is true exactly when
    // the user (or a later Safari) has turned it on.
    const supportsSpeculationRules = (() => {
        try {
            return typeof HTMLScriptElement !== 'undefined'
                && typeof HTMLScriptElement.supports === 'function'
                && HTMLScriptElement.supports('speculationrules');
        } catch (_) {
            return false;
        }
    })();

    // Safari 26 enforces Trusted Types, and a page that requires them (YouTube)
    // rejects a plain string assigned to a script's text — WebKit has applied
    // that to extension content scripts too. The pass-through policy never
    // leaves this closure and only ever sees JSON built by this script.
    let trustedScriptPolicy;

    function makeRulesScript(rules) {
        const script = document.createElement('script');
        script.type = 'speculationrules';
        const text = JSON.stringify(rules);

        try {
            script.textContent = text;
        } catch (error) {
            // Compared by name: the error comes from the page's realm, not
            // this script's, so instanceof would miss it.
            if (!error || error.name !== 'TypeError' || typeof trustedTypes === 'undefined') throw error;
            if (trustedScriptPolicy === undefined) {
                try {
                    trustedScriptPolicy = trustedTypes.createPolicy('quicksilver', { createScript: s => s });
                } catch (_) {
                    // A trusted-types directive that doesn't list our name.
                    trustedScriptPolicy = null;
                }
            }
            if (!trustedScriptPolicy) throw error;
            script.textContent = trustedScriptPolicy.createScript(text);
        }

        return script;
    }

    const TIER_SLOW = 1;
    const TIER_MODERATE = 2;
    const TIER_FAST = 3;

    // requestIdleCallback only reached Safari recently and scheduler.postTask
    // not at all, so this is a real fallback path here rather than a courtesy.
    function postBackgroundTask(fn, timeout) {
        const deadline = Number.isFinite(timeout) ? timeout : 3000;
        let ran = false;

        const run = () => {
            if (ran) return;
            ran = true;
            fn();
        };

        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(run, { timeout: deadline });
            // Safari's idle callbacks are not guaranteed to fire in a
            // background tab even with a timeout, and everything queued here is
            // postponable but not droppable.
            setTimeout(run, deadline);
            return;
        }

        setTimeout(run, Math.min(deadline, 750));
    }

    function runWhenDomReady(fn) {
        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function runWhenLoadedIdle(fn) {
        const runIdle = () => postBackgroundTask(fn, 3000);

        if (document.readyState === 'complete') runIdle();
        else window.addEventListener('load', runIdle, { once: true });
    }

    function getClosestLinkTarget(target) {
        return target instanceof Element ? target.closest('a[href]') : null;
    }

    function toUrl(href, base) {
        try {
            return new URL(href, base || location.href);
        } catch (_) {
            return null;
        }
    }

    const DOWNLOAD_EXTENSIONS = [
        '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
    ];
    const DOWNLOAD_REGEX = new RegExp('\\.(?:' + DOWNLOAD_EXTENSIONS.map(ext => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[?#]|$)', 'i');

    // Document warming here is a real, credentialed GET that the server cannot
    // tell apart from a click, so any link whose GET *does* something must
    // never be warmed. The list is the Chrome build's 4.2.0 one: account words,
    // the action verbs sites without CSRF-protected forms put in link paths
    // (Hacker News: vote, hide, flag, fave), the shapes Jev (TypeSafe) rated as
    // acting when asked about 42 real links, logoff variants, and pages that
    // act by being viewed (old.reddit's /message/unread/ marks mail read).
    const SENSITIVE_PATH_WORDS = [
        'logout', 'signout', 'log-out', 'sign-out', 'checkout', 'cart', 'account', 'admin',
        'order', 'orders', 'payment', 'payments', 'delete', 'auth', 'login', 'signin', 'sign-in',
        'session', 'destroy', 'revoke', 'unsubscribe', 'remove', 'transfer',
        'vote', 'upvote', 'downvote', 'unvote', 'hide', 'unhide', 'flag', 'unflag',
        'fave', 'unfave', 'favorite', 'favourite', 'like', 'unlike', 'follow', 'unfollow',
        'subscribe', 'report', 'markread', 'mark-read', 'mark_read', 'mark-all', 'archive', 'trash', 'spam',
        'cancel', 'confirm', 'approve', 'reject', 'accept', 'decline', 'leave', 'reset',
        'enable', 'disable', 'toggle',
        'add', 'answer', 'rsvp', 'dismiss', 'setlang', 'set-language', 'set-locale', 'set-currency',
        'logoff', 'log-off', 'signoff', 'sign-off',
        'unread', 'inbox', 'message', 'messages', 'notification', 'notifications'
    ];
    // A segment is an action if it is the verb, optionally with one short
    // suffix (/vote, /delete-account, /logout.php, /mark-all-read), or a
    // verb-led compound followed by another segment, which is its argument
    // (/remove-from-cart/5). Not a final slug that merely starts with a verb
    // (/like-a-pro-guide) and not a plural index (/reports). Case-insensitive:
    // ASP.NET's /Account/LogOff is the same link as /account/logoff.
    const SENSITIVE_HREF_REGEX = new RegExp(
        '\\/(?:' + SENSITIVE_PATH_WORDS.join('|') + ')'
        + '(?:(?:[-_.][a-z0-9]+)?(?:[\\/?#;]|$)|(?:[-_][a-z0-9]+)+\\/[^/?#])',
        'i'
    );
    // camelCase and PascalCase compounds: /cancelOrder, /DeleteItem. Case
    // matters here, so the first letter of each word is spelled both ways.
    const SENSITIVE_CAMEL_REGEX = new RegExp(
        '\\/(?:' + SENSITIVE_PATH_WORDS
            .filter(word => /^[a-z]+$/.test(word))
            .map(word => '[' + word[0] + word[0].toUpperCase() + ']' + word.slice(1))
            .join('|') + ')(?=[A-Z])'
    );
    // Matched anywhere in the raw href, query string included. A URL carrying
    // a per-user CSRF token (HN auth=, phpBB sid=/hash=, WordPress _wpnonce,
    // Moodle sesskey) is an action link by construction. The verbs also count
    // as query values (?action=trash, ?do=vote), but a bare action= does not:
    // Wikipedia's ?action=history is an ordinary page.
    const SENSITIVE_SUBSTRINGS = [
        'logout', 'log-out', 'log_out', 'signout', 'sign-out', 'sign_out', 'delete', 'unsubscribe',
        'auth=', 'token=', 'nonce', 'csrf', 'xsrf', 'sesskey', 'sesc=', 'sid=', 'hash=',
        'mark-all-read', 'markallread', 'logoff', 'log-off', 'log_off', 'signoff', 'sign-off'
    ].concat(SENSITIVE_PATH_WORDS.map(word => '=' + word));
    const SENSITIVE_SUBSTRING_REGEX = new RegExp(
        SENSITIVE_SUBSTRINGS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'i'
    );

    function isSensitiveHref(pathname, rawHref) {
        return SENSITIVE_HREF_REGEX.test(pathname) || SENSITIVE_CAMEL_REGEX.test(pathname)
            || SENSITIVE_SUBSTRING_REGEX.test(rawHref || pathname);
    }

    const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

    // =========================================================================
    // Storage
    // =========================================================================
    //
    // Safari's userscript managers disagree about the GM API. Tampermonkey for
    // Safari has the synchronous GM_* functions; the open-source Userscripts
    // app has only the promise-based GM.* ones. Synchronous storage is worth a
    // lot here — the learned preload has to be emitted before the parser
    // reaches the hero, and awaiting a promise first costs most of the win — so
    // GM_* is preferred, GM.* is read once into memory up front, and
    // localStorage is the last resort.
    //
    // localStorage is genuinely worse and not merely a formality: it is
    // readable by every script on the origin, including analytics and ad tags,
    // which would inherit a visit history from before they were present.

    const LEARN_LCP_KEY = 'tm-qs-lcp';
    const LEARN_ORIGINS_KEY = 'tm-qs-origins';
    const LEARN_VITALS_KEY = 'tm-qs-vitals';
    const LEARN_TRANSITIONS_KEY = 'tm-qs-transitions';
    const LEARN_SPA_KEY = 'tm-qs-spa';
    const STATS_KEY = 'tm-qs-stats';
    const CV_FLAG_KEY = 'tm-qs-content-visibility';
    const WARM_FLAG_KEY = 'tm-qs-warm';
    const LEARN_INDEX_KEY = 'tm-qs-origin-index';
    const NET_KEY = 'tm-qs-net';
    // Unsuffixed, like NET_KEY: one tally across every site.
    const STATS_ALL_KEY = 'tm-qs-stats-all';

    const ORIGIN_KEYS = [LEARN_LCP_KEY, LEARN_ORIGINS_KEY, LEARN_VITALS_KEY, LEARN_TRANSITIONS_KEY,
        LEARN_SPA_KEY, STATS_KEY];
    const FLAG_KEYS = [CV_FLAG_KEY, WARM_FLAG_KEY];
    const GLOBAL_KEYS = [LEARN_INDEX_KEY, NET_KEY, STATS_ALL_KEY];

    const LEARN_MAX_ORIGINS = 150;

    const gmSync = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const gmAsync = !gmSync && typeof GM !== 'undefined' && GM
        && typeof GM.getValue === 'function' && typeof GM.setValue === 'function';
    const usingGm = gmSync || gmAsync;

    // Under GM.* every read is a promise, so the values are mirrored here and
    // this map — not the backend — is what the rest of the script reads. Writes
    // update it synchronously and are flushed onwards fire-and-forget, which
    // also means a manager that drops a write silently costs at most a session.
    const memory = new Map();

    function storeKey(key) {
        // GM storage is one namespace for every site, unlike localStorage.
        return usingGm ? key + '::' + location.origin : key;
    }

    function rawRead(key) {
        if (memory.has(key)) return memory.get(key);

        try {
            if (gmSync) {
                const value = GM_getValue(key, null);
                return typeof value === 'string' ? value : null;
            }
            if (!gmAsync) return localStorage.getItem(key);
        } catch (_) {}

        // gmAsync and not primed: the caller is running before storageReady.
        return null;
    }

    function rawWrite(key, raw) {
        memory.set(key, raw);
        try {
            if (gmSync) GM_setValue(key, raw);
            else if (gmAsync) Promise.resolve(GM.setValue(key, raw)).catch(() => {});
            else localStorage.setItem(key, raw);
        } catch (_) {}
    }

    function rawDelete(key) {
        memory.delete(key);
        try {
            if (gmSync) {
                if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
                else GM_setValue(key, '');
            } else if (gmAsync) {
                if (typeof GM.deleteValue === 'function') Promise.resolve(GM.deleteValue(key)).catch(() => {});
                else Promise.resolve(GM.setValue(key, '')).catch(() => {});
            } else {
                localStorage.removeItem(key);
            }
        } catch (_) {}
    }

    // Everything this script can read for the current origin, primed in one
    // batch so the async managers pay a single round of promise latency.
    const storageReady = (() => {
        if (!gmAsync) return Promise.resolve();

        const keys = ORIGIN_KEYS.concat(FLAG_KEYS).map(storeKey).concat(GLOBAL_KEYS);
        return Promise.all(keys.map(key =>
            Promise.resolve(GM.getValue(key, null))
                .then(value => memory.set(key, typeof value === 'string' ? value : null))
                .catch(() => memory.set(key, null))
        )).then(() => undefined);
    })();

    function readStore(key) {
        try {
            const raw = rawRead(storeKey(key));
            if (!raw || typeof raw !== 'string') return null;
            const value = JSON.parse(raw);
            // May have been written by a hostile origin (localStorage
            // fallback) or by an older schema.
            return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
        } catch (_) {
            return null;
        }
    }

    function writeStore(key, value) {
        try {
            rawWrite(storeKey(key), JSON.stringify(value));
        } catch (_) {}
        touchOriginIndex();
    }

    function deleteStore(key) {
        rawDelete(storeKey(key));
    }

    // GM storage is not scoped per origin and nothing else would ever evict it,
    // so the set of origins we hold data for is capped explicitly.
    function touchOriginIndex() {
        if (!usingGm) return;

        let index;
        try {
            const raw = rawRead(LEARN_INDEX_KEY);
            index = raw ? JSON.parse(raw) : null;
        } catch (_) {
            index = null;
        }
        if (!Array.isArray(index)) index = [];

        const now = Date.now();
        const kept = index.filter(entry => entry && typeof entry.o === 'string' && entry.o !== location.origin);
        kept.push({ o: location.origin, at: now });
        kept.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

        for (const evicted of kept.slice(LEARN_MAX_ORIGINS)) {
            for (const key of ORIGIN_KEYS.concat(FLAG_KEYS)) {
                rawDelete(key + '::' + evicted.o);
            }
        }

        try {
            rawWrite(LEARN_INDEX_KEY, JSON.stringify(kept.slice(0, LEARN_MAX_ORIGINS)));
        } catch (_) {}
    }

    // =========================================================================
    // Connection tiering, learned
    // =========================================================================
    //
    // navigator.connection does not exist in WebKit and there is no
    // Save-Data equivalent either, so the tier is measured instead of asked
    // for: Navigation Timing gives a network-only latency (responseStart -
    // requestStart) and a transfer rate for the document itself, on every load.
    //
    // Samples are kept globally rather than per-origin — this describes the
    // link, not the site — and only recent ones count, because the whole point
    // is to notice when the user has moved onto a slow connection.

    const NET_SAMPLES = 10;
    const NET_SAMPLE_MAX_AGE = 2 * HOUR;
    const NET_SLOW_TTFB_MS = 800;
    const NET_MODERATE_TTFB_MS = 350;
    const NET_SLOW_KBPS = 200;

    let cachedTier = null;
    // The GM.* backend primes asynchronously, and initFontDisplaySwap asks for
    // a tier from a DOM-ready callback that can win that race. Memoising what
    // it computes then would latch TIER_FAST for the session off an empty
    // store — inverting every slow-link protection on the connections they
    // exist for — so the answer is only cached once it can be trusted.
    let storagePrimed = !gmAsync;

    function readNetSamples() {
        let parsed;
        try {
            const raw = rawRead(NET_KEY);
            parsed = raw ? JSON.parse(raw) : null;
        } catch (_) {
            parsed = null;
        }

        const samples = (parsed && Array.isArray(parsed.s)) ? parsed.s : [];
        const now = Date.now();
        return samples.filter(s => s && Number.isFinite(s.t) && Number.isFinite(s.at)
            && now - s.at < NET_SAMPLE_MAX_AGE);
    }

    function median(values) {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    function getConnectionTier() {
        if (cachedTier !== null) return cachedTier;

        const tier = computeConnectionTier();
        if (storagePrimed) cachedTier = tier;
        return tier;
    }

    function computeConnectionTier() {
        // If a future WebKit ships the Network Information API, believe it over
        // the estimate — it can see a radio state change we cannot.
        const conn = navigator.connection;
        if (conn) {
            if (conn.saveData) return TIER_SLOW;
            if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return TIER_SLOW;
            if (conn.effectiveType === '3g') return TIER_MODERATE;
        }

        const samples = readNetSamples();
        if (!samples.length) return TIER_FAST;

        const ttfb = median(samples.map(s => s.t));
        const kbps = median(samples.map(s => s.k).filter(Number.isFinite));

        if (ttfb >= NET_SLOW_TTFB_MS) return TIER_SLOW;
        if (Number.isFinite(kbps) && kbps > 0 && kbps < NET_SLOW_KBPS) return TIER_SLOW;
        if (ttfb >= NET_MODERATE_TTFB_MS) return TIER_MODERATE;
        return TIER_FAST;
    }

    function recordNetSample() {
        let nav;
        try {
            nav = (performance.getEntriesByType('navigation') || [])[0];
        } catch (_) {
            return;
        }
        // A bfcache restore or a prerendered-style reuse reports a nonsense
        // near-zero request phase; so does a document served from disk cache.
        if (!nav || nav.type === 'back_forward') return;

        const ttfb = Number(nav.responseStart) - Number(nav.requestStart);
        if (!Number.isFinite(ttfb) || ttfb <= 0 || ttfb > 60 * SECOND) return;
        if (Number(nav.transferSize) === 0) return;

        const sample = { t: Math.round(ttfb), at: Date.now() };

        const download = Number(nav.responseEnd) - Number(nav.responseStart);
        const bytes = Number(nav.transferSize) || Number(nav.encodedBodySize) || 0;
        // Under ~8KB the measurement is all latency and no throughput; the
        // rate it implies is noise.
        if (download > 0 && bytes > 8192) {
            sample.k = Math.round((bytes * 8) / download);
        }

        const samples = readNetSamples();
        samples.push(sample);
        try {
            rawWrite(NET_KEY, JSON.stringify({ s: samples.slice(-NET_SAMPLES) }));
        } catch (_) {}
    }

    // =========================================================================
    // Same-document route changes
    // =========================================================================
    //
    // Under @inject-into content a history.pushState patch would only observe
    // calls made from this script's own world — the page's router lives in
    // another one and would go completely undetected. Two world-agnostic
    // sources instead: the Navigation API's events where WebKit has it (DOM
    // events reach every world), and otherwise a poll of location.href that
    // costs a string compare and stops entirely while the tab is hidden.

    const ROUTE_POLL_MS = 400;
    const routeChangeHandlers = [];
    let routeWatcherInstalled = false;
    let watchedHref = location.href;

    // A router answering a link click is the SPA signature, and the pushed URL
    // has to be the clicked link's: infinite scroll that rewrites the URL as
    // you read is not a router. Five seconds covers routers that only push
    // once their data has arrived on a slow response.
    const LINK_CLICK_WINDOW_MS = 5000;
    let lastLinkClickAt = 0;
    let lastLinkClickHref = null;

    function withoutHash(href) {
        const url = toUrl(href);
        if (!url) return null;
        url.hash = '';
        return url.href;
    }

    function onRouteChange(handler) {
        routeChangeHandlers.push(handler);
        installRouteWatcher();
    }

    function fireRouteChange() {
        const recent = Date.now() - lastLinkClickAt < LINK_CLICK_WINDOW_MS;
        const info = { clickedHref: recent ? lastLinkClickHref : null };
        for (const handler of routeChangeHandlers) {
            try {
                handler(info);
            } catch (_) {}
        }
    }

    function installRouteWatcher() {
        if (routeWatcherInstalled) return;
        routeWatcherInstalled = true;

        let timer = null;

        const check = () => {
            if (location.href === watchedHref) return;
            watchedHref = location.href;
            fireRouteChange();
        };

        // Capture on document runs before the router's own click handler.
        document.addEventListener('click', event => {
            const link = getClosestLinkTarget(event.target);
            if (!link) return;
            lastLinkClickAt = Date.now();
            lastLinkClickHref = withoutHash(link.href);
        }, { passive: true, capture: true });

        // currententrychange fires once the new URL is committed, for push,
        // replace and traversal alike, so it replaces the poll outright.
        if (supportsNavigationApi) {
            try {
                window.navigation.addEventListener('currententrychange', check);
                window.addEventListener('hashchange', check);
                return;
            } catch (_) {}
        }

        const start = () => {
            if (timer) return;
            timer = setInterval(check, ROUTE_POLL_MS);
        };

        const stop = () => {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        };

        // popstate and hashchange are exact and free; the interval exists only
        // for pushState routers, which announce nothing.
        window.addEventListener('popstate', check);
        window.addEventListener('hashchange', check);
        // A click is the overwhelmingly common cause of a route change, so
        // checking just after one turns most of them into a same-frame
        // detection rather than an up-to-400ms wait.
        document.addEventListener('click', () => setTimeout(check, 0), { passive: true, capture: true });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') stop();
            else {
                check();
                start();
            }
        });

        if (document.visibilityState !== 'hidden') start();
    }

    // -------------------------------------------------------------------------
    // SPA detection
    // -------------------------------------------------------------------------
    //
    // On a site whose router answers link clicks in-page (YouTube, GitHub), a
    // fetched document is never used: the click becomes a pushState and a JSON
    // request. One observed click-driven soft navigation switches document
    // warming off for the origin. Hero pre-warming stays on — a router still
    // fetches the next route's images — and so does all learning.

    const SPA_FLAG_REFRESH = 24 * HOUR;
    let knownSpa = false;

    function isKnownSpa() {
        const flag = readStore(LEARN_SPA_KEY);
        return Boolean(flag) && Date.now() - (Number(flag.at) || 0) < LEARN_MAX_AGE;
    }

    function initSpaDetection() {
        knownSpa = isKnownSpa();
        let lastRoute = pageKey();

        onRouteChange(info => {
            // A hash-only change is an in-page anchor, not a route.
            const next = pageKey();
            if (next === lastRoute) return;
            lastRoute = next;
            if (!info || !info.clickedHref || info.clickedHref !== withoutHash(location.href)) return;

            // Kept alive by use and aged out like everything else, so a site
            // that drops its client-side router gets warming back.
            const flag = readStore(LEARN_SPA_KEY);
            if (!flag || Date.now() - (Number(flag.at) || 0) > SPA_FLAG_REFRESH) {
                writeStore(LEARN_SPA_KEY, { at: Date.now() });
            }
            knownSpa = true;
        });
    }

    // -------------------------------------------------------------------------
    // Measured outcomes
    // -------------------------------------------------------------------------
    //
    // The hero heuristic is the least certain thing in this port, so it is the
    // thing worth scoring: was the image preloaded for a route the image that
    // turned out to be its hero?

    function bumpStats(section, outcome) {
        const bump = previous => {
            const stats = (previous && typeof previous === 'object' && !Array.isArray(previous)) ? previous : {};
            const bucket = (stats[section] && typeof stats[section] === 'object') ? stats[section] : {};
            bucket[outcome] = (Number(bucket[outcome]) || 0) + 1;
            stats[section] = bucket;
            if (!stats.since) stats.since = Date.now();
            return stats;
        };

        writeStore(STATS_KEY, bump(readStore(STATS_KEY)));

        // The localStorage fallback is per-origin by nature; there is no
        // "all sites" to add to.
        if (!usingGm) return;
        try {
            rawWrite(STATS_ALL_KEY, JSON.stringify(bump(readAllStats())));
        } catch (_) {}
    }

    function readAllStats() {
        try {
            return JSON.parse(rawRead(STATS_ALL_KEY) || 'null');
        } catch (_) {
            return null;
        }
    }

    // =========================================================================
    // Hint emission
    // =========================================================================

    function appendToHead(node) {
        if (document.head) {
            document.head.appendChild(node);
            return;
        }

        const root = document.documentElement;

        // document-start can run before <head> exists, and a resource hint
        // outside the document is not processed. It can also run before <html>
        // exists; returning there would discard the hint with no retry, losing
        // the learned preload for the whole navigation. Fall back to watching
        // `document` so <html> and then <head> are both caught.
        const target = root || document;
        const observer = new MutationObserver(() => {
            if (!document.head) return;
            observer.disconnect();
            document.head.appendChild(node);
        });
        observer.observe(target, { childList: true, subtree: !root });
    }

    // A different viewport can mean a different layout and so a different hero,
    // so a record is only reused at a similar width. 320px buckets survive a
    // nudged window edge; the 160px ones 1.0 used did not.
    const VIEWPORT_BUCKET_PX = 320;

    function viewportWidthBucket() {
        return Math.round((window.innerWidth || 0) / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX;
    }

    function currentDpr() {
        return Math.round(window.devicePixelRatio || 1);
    }

    function recordBucket(record) {
        // 1.0 stored "1280x2" at 160px granularity. Re-bucket it rather than
        // make every learned hero start over.
        if (typeof record.vw === 'string') {
            const match = /^(\d+)x(\d+)$/.exec(record.vw);
            if (!match) return null;
            return {
                width: Math.round(Number(match[1]) / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX,
                dpr: Number(match[2])
            };
        }
        return { width: Number(record.vw), dpr: Number(record.dpr) };
    }

    // Safari 27 supports sizes="auto" on lazy images: "use my layout box".
    // A preload has no box, so imagesizes ignores the keyword and falls back
    // to 100vw — a bigger candidate than the <img> will take, downloaded as
    // well as the right one. An author's fallback after "auto," is kept;
    // with nothing after it, false says the srcset cannot be replayed.
    function withoutAutoSizes(sizes) {
        if (typeof sizes !== 'string') return sizes || null;
        const match = /^\s*auto\s*(?:,|$)/i.exec(sizes);
        if (!match) return sizes;
        return sizes.slice(match[0].length).trim() || false;
    }

    // What a preload can faithfully replay of an image's responsive markup.
    // Inside <picture> the browser chose from a <source>, often AVIF or WebP;
    // the <img>'s own srcset is only the fallback, so replaying it would
    // preload a JPEG the page never uses. Either way, nothing replayable
    // means the exact URL that painted is preloaded instead.
    function replayableSourceSet(element) {
        const none = { srcset: null, sizes: null };
        if (!element || typeof element.getAttribute !== 'function') return none;
        if (element.parentElement && element.parentElement.tagName === 'PICTURE') return none;
        const srcset = element.getAttribute('srcset');
        if (!srcset) return none;
        const sizes = withoutAutoSizes(element.getAttribute('sizes'));
        if (sizes === false) return none;
        return { srcset, sizes };
    }

    function canReplaySrcset(record) {
        return Boolean(record.srcset) && supportsImageSrcset && withoutAutoSizes(record.sizes) !== false;
    }

    function matchesViewport(record) {
        const bucket = recordBucket(record);
        if (!bucket || bucket.width !== viewportWidthBucket()) return false;
        // With srcset replayed as imagesrcset the browser picks the density
        // itself, so zoom (which changes devicePixelRatio) only invalidates a
        // src-only hero — or any hero on a Safari too old for imagesrcset,
        // where the preload falls back to the URL resolved for the old density.
        return canReplaySrcset(record) || bucket.dpr === currentDpr();
    }

    function pageKey() {
        return location.pathname.slice(0, 200);
    }

    function capStore(store, limit) {
        const entries = Object.entries(store)
            .sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0))
            .slice(0, limit);
        return Object.fromEntries(entries);
    }

    // =========================================================================
    // Part A: preconnect + dns-prefetch on hover/focus
    // =========================================================================
    //
    // The single best-value thing this script does in Safari. WebKit supports
    // both hints, a cross-origin navigation still pays DNS + TCP + TLS before
    // its first byte, and hovering a link is the cheapest reliable signal of
    // intent there is. Unlike a document warm this cannot double-fetch
    // anything: it opens a socket and sends no request.

    function initPreconnectOnIntent() {
        const connected = new Map();
        const dnsPrefetched = new Set();
        const currentOrigin = location.origin;
        const maxPreconnects = 16;
        let lastLink = null;

        function removeOldestPreconnect() {
            const oldest = connected.keys().next().value;
            if (!oldest) return;

            const oldLink = connected.get(oldest);
            if (oldLink) oldLink.remove();
            connected.delete(oldest);
        }

        function dnsPrefetch(origin) {
            if (!document.head || dnsPrefetched.has(origin) || origin === currentOrigin) return;
            dnsPrefetched.add(origin);
            const hint = document.createElement('link');
            hint.rel = 'dns-prefetch';
            hint.href = origin;
            document.head.appendChild(hint);
        }

        function preconnect(origin) {
            if (!document.head || connected.has(origin) || origin === currentOrigin) return;
            if (connected.size >= maxPreconnects) removeOldestPreconnect();

            // No crossorigin attribute: hovered links lead to document
            // navigations, which reuse the credentialed non-CORS connection.
            const hint = document.createElement('link');
            hint.rel = 'preconnect';
            hint.href = origin;
            document.head.appendChild(hint);
            connected.set(origin, hint);
        }

        function maybePreconnect(target) {
            const link = getClosestLinkTarget(target);
            if (!link || link === lastLink) return;
            lastLink = link;

            const url = toUrl(link.href);
            if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
                dnsPrefetch(url.origin);
                preconnect(url.origin);
            }
        }

        document.addEventListener('pointerover', e => maybePreconnect(e.target), { passive: true, capture: true });
        document.addEventListener('focusin', e => maybePreconnect(e.target), { passive: true, capture: true });
        // iOS has no hover. touchstart lands roughly 100-300ms before the
        // navigation, which is about one handshake — the whole win.
        document.addEventListener('touchstart', e => {
            const touch = e.touches && e.touches[0];
            if (touch) maybePreconnect(e.target);
        }, { passive: true, capture: true });
    }

    runWhenDomReady(initPreconnectOnIntent);

    // =========================================================================
    // Part B: font-display injection
    // =========================================================================

    const ICON_FONT_FAMILY = /icon|awesome|glyph|symbol|fontello|icomoon|material|dashicons|octicon|feather|ionic|remixicon/i;

    function initFontDisplaySwap() {
        if (typeof CSSFontFaceRule === 'undefined') return;

        // `swap` still repaints and reflows when the webfont arrives. On a slow
        // link that can be seconds after first paint; `optional` renders the
        // fallback and never swaps, so text is stable from the first frame.
        //
        // This runs from a DOM-ready callback that can beat storageReady on the
        // GM.* backend, and a tier read from an empty store answers TIER_FAST.
        // Holding the result in a `const` would pin that optimistic answer for
        // the session — exactly inverting the protection on the links it exists
        // for — so re-read it once the store is primed and correct the rules we
        // wrote. Only our own rules are revisited; a font-display the page set
        // itself is left alone.
        let displayValue = getConnectionTier() === TIER_SLOW ? 'optional' : 'swap';
        const ownedRules = new Set();

        function patchSheet(sheet) {
            try {
                const rules = sheet.cssRules || sheet.rules;
                if (!rules) return false;

                for (const rule of rules) {
                    if (!(rule instanceof CSSFontFaceRule)) continue;
                    // An icon font has no readable fallback: 'swap' flashes
                    // ligature text or empty boxes, and 'optional' on a slow
                    // link can leave the hamburger menu blank all visit (Font
                    // Awesome 4.7 and Glyphicons declare no display at all).
                    if (ICON_FONT_FAMILY.test(rule.style.getPropertyValue('font-family'))) continue;

                    if (!rule.style.fontDisplay) {
                        rule.style.fontDisplay = displayValue;
                        ownedRules.add(rule);
                    } else if (ownedRules.has(rule)
                        && rule.style.fontDisplay !== displayValue) {
                        rule.style.fontDisplay = displayValue;
                    }
                }

                return true;
            } catch (_) {
                // Cross-origin stylesheet: cssRules throws and there is nothing
                // to be done about it.
                return false;
            }
        }

        function patchStyleSheets() {
            for (const sheet of document.styleSheets) patchSheet(sheet);
        }

        let scanPending = false;
        function scheduleScan() {
            if (scanPending) return;
            scanPending = true;

            window.requestAnimationFrame(() => {
                scanPending = false;
                patchStyleSheets();
            });
        }

        patchStyleSheets();

        // Resolves immediately when the store was already primed, so this costs
        // one microtask on the synchronous GM_* path.
        storageReady.then(() => {
            const corrected = getConnectionTier() === TIER_SLOW ? 'optional' : 'swap';
            if (corrected === displayValue) return;

            displayValue = corrected;
            patchStyleSheets();
        });

        const observer = new MutationObserver(mutations => {
            let needsScan = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;

                    // Stylesheet links only: matching every <link> would make
                    // the preconnects and preloads this script injects schedule
                    // full stylesheet rescans.
                    if (node.matches('link[rel~="stylesheet"], style')) {
                        const tryPatch = () => {
                            if (!node.sheet || !patchSheet(node.sheet)) scheduleScan();
                        };

                        if (node.matches('link') && !node.sheet) {
                            node.addEventListener('load', tryPatch, { once: true });
                        } else {
                            window.requestAnimationFrame(tryPatch);
                        }
                    } else if (node.querySelector('link[rel~="stylesheet"], style')) {
                        needsScan = true;
                    }
                }
            }

            if (needsScan) scheduleScan();
        });

        const options = { childList: true, subtree: true };
        if (document.head) observer.observe(document.head, options);
        if (document.body) observer.observe(document.body, options);
        else window.addEventListener('DOMContentLoaded', () => {
            if (document.body) observer.observe(document.body, options);
        }, { once: true });
    }

    runWhenDomReady(initFontDisplaySwap);

    // =========================================================================
    // Part C: cross-visit learning (hero preload + critical-origin preconnect)
    // =========================================================================
    //
    // Chrome's version of this reads the LCP entry, which is authoritative:
    // the browser tells you exactly which element it considered largest at
    // paint time. Where WebKit reports LCP too, so does this — for the initial
    // load of a document. Everywhere else, and for every route reached by a
    // client-side navigation (which LCP never reports on), the hero is found
    // by measuring: the largest image intersecting the first viewport, taken
    // after load once layout is stable.
    //
    // That is a guess where Chrome had a fact, and it is wrong in a predictable
    // way: on a page whose real LCP is a CSS background or a text block it will
    // nominate some large decorative image instead. Two mitigations. The
    // confidence gate is 3 rather than 2, and the candidate has to be the same
    // image each time — a page that nominates a different "hero" per visit
    // (a rotating banner, an ad) never accumulates confidence and is never
    // acted on.

    const LEARN_LCP_MAX_ENTRIES = 60;
    const LEARN_ORIGIN_MAX_ENTRIES = 8;
    const LEARN_VITALS_SAMPLES = 12;
    const LEARN_MAX_AGE = 14 * 24 * HOUR;
    // Higher than the Chrome build's 2, because the observation is a
    // heuristic. It applies to the hero and to nothing else: a critical origin
    // is measured from Resource Timing rather than guessed at, so it keeps the
    // Chrome build's gate and is not made to wait an extra visit for a doubt
    // that does not apply to it.
    const LEARN_MIN_SIGHTINGS = 3;
    // A record taken from a real LCP entry is a measurement, so it gets the
    // Chrome build's gate.
    const LEARN_LCP_MIN_SIGHTINGS = 2;
    // One sighting: the preconnect acts on the second visit. A preconnect
    // that turns out unneeded costs one idle socket, not a request.
    const LEARN_ORIGIN_MIN_SIGHTINGS = 1;
    const LEARN_EARLY_RESOURCE_MS = 4000;
    const LEARN_SETTLE_MS = 3000;
    // A hero is a substantial part of the first screen. Below this the
    // candidate is a logo, an avatar or an icon, and preloading it is a
    // request spent to make nothing faster.
    const HERO_MIN_VIEWPORT_FRACTION = 0.06;
    const HERO_MIN_EDGE_PX = 120;
    const HERO_SCAN_BUDGET = 400;

    let learnedLcpUrl = null;
    let emittedPreloadFor = null;
    // Which route a hero preload went out for, and every URL that would count
    // as it being right: with imagesrcset the browser may pick any candidate,
    // all of which are the same image.
    let heroPreload = null;

    function minSightings(record) {
        return record && record.src === 'lcp' ? LEARN_LCP_MIN_SIGHTINGS : LEARN_MIN_SIGHTINGS;
    }

    function preloadUrls(record) {
        const urls = [record.url];
        for (const candidate of String(record.srcset || '').split(',')) {
            const url = toUrl(candidate.trim().split(/\s+/)[0]);
            if (url) urls.push(url.href);
        }
        return urls;
    }

    function applyLearnedHints(route) {
        const key = route || pageKey();
        const tier = getConnectionTier();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const record = lcpStore && lcpStore[key];

        if (
            record
            && typeof record.url === 'string'
            && (Number(record.seen) || 0) >= minSightings(record)
            && matchesViewport(record)
            && Date.now() - (Number(record.at) || 0) < LEARN_MAX_AGE
            && emittedPreloadFor !== record.url
        ) {
            learnedLcpUrl = record.url;
            emittedPreloadFor = record.url;
            heroPreload = { route: key, urls: preloadUrls(record) };

            try {
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = record.url;
                // fetchpriority is Safari 17.2+. Older builds ignore the
                // attribute and the preload still runs at its default
                // priority, which is the point of the hint anyway.
                if (supportsFetchPriority) link.setAttribute('fetchpriority', 'high');
                // The preload has to match how the element will fetch it. A
                // mismatched CORS mode produces a second request rather than a
                // warm cache entry, which is worse than not preloading at all.
                if (record.cors) link.crossOrigin = record.cors;
                // imagesrcset is also 17.2+, and unlike fetchpriority it is not
                // safe to emit unsupported: a build that ignores it would
                // preload the bare href, which for a responsive hero is a
                // candidate the <img> may never request. Where it is missing,
                // fall back to the resolved URL recorded from currentSrc.
                // Records learned before sizes="auto" was understood are
                // cleaned here too.
                if (canReplaySrcset(record)) {
                    link.setAttribute('imagesrcset', record.srcset);
                    const sizes = withoutAutoSizes(record.sizes);
                    if (sizes) link.setAttribute('imagesizes', sizes);
                }
                // A hero that 404s or was removed should stop being preloaded
                // rather than cost a request a day for two weeks.
                link.addEventListener('error', () => {
                    const current = readStore(LEARN_LCP_KEY);
                    if (!current || !current[key]) return;
                    delete current[key];
                    writeStore(LEARN_LCP_KEY, current);
                }, { once: true });
                appendToHead(link);
            } catch (_) {}
        }

        // Origins are a property of the site, not the route.
        if (route) return;

        const originStore = readStore(LEARN_ORIGINS_KEY);
        const origins = (originStore && Array.isArray(originStore.origins)) ? originStore.origins : [];
        const budget = tier === TIER_SLOW ? 2 : (tier === TIER_MODERATE ? 3 : 6);

        let used = 0;
        for (const entry of origins) {
            if (used >= budget) break;
            if (!entry || typeof entry.o !== 'string') continue;
            if ((Number(entry.n) || 0) < LEARN_ORIGIN_MIN_SIGHTINGS) continue;
            if (entry.o === location.origin) continue;
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && Date.now() - updatedAt > LEARN_MAX_AGE) continue;

            try {
                const hint = document.createElement('link');
                hint.rel = 'preconnect';
                hint.href = entry.o;
                // Fonts and other CSS-initiated subresources fetch in CORS mode
                // and will not reuse a credential-mismatched connection.
                if (entry.c) hint.crossOrigin = 'anonymous';
                appendToHead(hint);
                used += 1;
            } catch (_) {}
        }
    }

    // -------------------------------------------------------------------------
    // Observation
    // -------------------------------------------------------------------------

    // Absolute document coordinates, so a scan that happens after the user has
    // scrolled still asks "was this in the first screen?" rather than "is it on
    // screen now?".
    function heroCandidate() {
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        if (!viewportHeight || !viewportWidth) return null;

        const minArea = viewportHeight * viewportWidth * HERO_MIN_VIEWPORT_FRACTION;
        const scrollY = window.pageYOffset || 0;
        const scrollX = window.pageXOffset || 0;

        let best = null;
        let bestArea = 0;
        let budget = HERO_SCAN_BUDGET;

        let images;
        try {
            images = document.images;
        } catch (_) {
            return null;
        }

        for (const img of images) {
            if (budget-- <= 0) break;

            let rect;
            try {
                rect = img.getBoundingClientRect();
            } catch (_) {
                continue;
            }

            if (rect.width < HERO_MIN_EDGE_PX || rect.height < HERO_MIN_EDGE_PX) continue;

            const top = rect.top + scrollY;
            const left = rect.left + scrollX;
            // Must have been inside the first screen: below the fold it cannot
            // be what the user waited for.
            if (top >= viewportHeight || left >= viewportWidth) continue;
            if (top + rect.height <= 0) continue;

            const area = rect.width * rect.height;
            if (area < minArea || area <= bestArea) continue;

            const src = img.currentSrc || img.src;
            if (!src) continue;
            const url = toUrl(src);
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) continue;

            bestArea = area;
            best = Object.assign({
                url: url.href,
                cors: img.crossOrigin || null
            }, replayableSourceSet(img));
        }

        return best;
    }

    function firstContentfulPaint() {
        try {
            for (const entry of performance.getEntriesByType('paint') || []) {
                if (entry.name === 'first-contentful-paint') return entry.startTime;
            }
        } catch (_) {}
        return null;
    }

    function initLearning() {
        // The last measurement taken, and the route that was on screen when it
        // was taken. The Chrome build gets this binding from the LCP entry
        // itself; here it has to be maintained by hand, because a route change
        // is noticed up to ROUTE_POLL_MS after the router has already swapped
        // the DOM. Measuring at that moment would credit the incoming page's
        // hero to the outgoing route — consistently, so the confidence gate
        // would endorse it rather than filter it out.
        let pending = null;
        let sawLoad = document.readyState === 'complete';
        // A tab loaded in the background paints whatever it has when it is
        // finally shown, and its geometry at that moment is not what a viewer
        // would have waited for. Consistently wrong is worse than noisy here:
        // the confidence gate would endorse it.
        let hiddenBeforeLoad = document.visibilityState === 'hidden';
        let currentRoute = pageKey();
        let persistedRoute = null;
        let settleTimer = null;
        // LCP only ever describes the document's initial load. After the first
        // client-side navigation it falls silent and geometry is all there is.
        let softNavigated = false;
        let lcpEntry = null;

        if (supportsLcp) {
            try {
                const observer = new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) {
                        // Reported repeatedly as larger candidates paint; the
                        // last one wins. A text LCP has nothing to preload, but
                        // it does replace an earlier image: a logo that painted
                        // first and then lost to a headline is not the hero.
                        if (!entry) continue;
                        if (!entry.url) {
                            lcpEntry = null;
                            continue;
                        }

                        // Snapshot now: entry.element is null once the element
                        // leaves the document, routine for carousels, and a
                        // crossOrigin read as null then is the CORS-mode
                        // mismatch that turns a preload into a second download.
                        const element = entry.element;
                        lcpEntry = Object.assign({
                            url: entry.url,
                            startTime: entry.startTime,
                            cors: (element && element.crossOrigin) || null,
                            route: currentRoute
                        }, replayableSourceSet(element));
                    }
                });
                observer.observe({ type: 'largest-contentful-paint', buffered: true });
            } catch (_) {}
        }

        function persistHero(route, observed, hardLoad) {
            if (!route || persistedRoute === route) return;
            persistedRoute = route;

            if (heroPreload && heroPreload.route === route) {
                const painted = observed && observed.url ? toUrl(observed.url) : null;
                bumpStats('hero', painted && heroPreload.urls.includes(painted.href) ? 'hit' : 'miss');
                heroPreload = null;
            }

            if (!observed || !observed.url) {
                // No qualifying image on this route: redesigned to a text
                // headline, or the hero is gone. Returning early would leave
                // the old record authoritative for the full LEARN_MAX_AGE,
                // preloading an image the page no longer references.
                const existing = readStore(LEARN_LCP_KEY);
                if (!existing || !existing[route]) return;

                const seen = (Number(existing[route].seen) || 0) - 1;
                if (seen <= 0) delete existing[route];
                else existing[route] = Object.assign({}, existing[route], { seen });
                writeStore(LEARN_LCP_KEY, existing);
                return;
            }

            const url = toUrl(observed.url);
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return;

            const store = readStore(LEARN_LCP_KEY) || {};
            const previous = store[route];
            const sameTarget = Boolean(previous && previous.url === url.href && matchesViewport(previous));

            store[route] = {
                url: url.href,
                cors: observed.cors,
                srcset: observed.srcset,
                sizes: observed.sizes,
                // Which gate the record answers to: 'lcp' was measured by the
                // browser, 'geo' was guessed from layout.
                src: observed.src,
                vw: viewportWidthBucket(),
                dpr: currentDpr(),
                at: Date.now(),
                // A changed target resets confidence rather than accumulating
                // it. With a geometric heuristic this is doing more work than
                // it does in the Chrome build: it is what stops a rotating
                // banner or a slot that sometimes holds an ad from ever
                // reaching the gate.
                seen: sameTarget ? Math.min(Number(previous.seen) || 0, 50) + 1 : 1
            };

            writeStore(LEARN_LCP_KEY, capStore(store, LEARN_LCP_MAX_ENTRIES));

            // Both paint timings belong to the document's initial load. A
            // client-side route has neither, and filing the document's FCP
            // again under every route it visits would drag the median toward
            // whichever page happened to be loaded first.
            if (!hardLoad) return;
            const vitals = readStore(LEARN_VITALS_KEY) || {};
            const next = {};
            const lcp = observed.src === 'lcp' ? observed.startTime : null;
            for (const [name, value] of [['fcp', firstContentfulPaint()], ['lcp', lcp]]) {
                const samples = Array.isArray(vitals[name]) ? vitals[name].filter(Number.isFinite) : [];
                if (Number.isFinite(value) && value > 0) samples.push(Math.round(value));
                if (samples.length) next[name] = samples.slice(-LEARN_VITALS_SAMPLES);
            }
            writeStore(LEARN_VITALS_KEY, next);
        }

        // Safe only while the document still shows currentRoute.
        function observe() {
            if (!sawLoad || hiddenBeforeLoad) return;
            if (supportsLcp && !softNavigated) {
                const entry = lcpEntry && lcpEntry.route === currentRoute ? lcpEntry : null;
                pending = { route: currentRoute, hard: true, hero: entry ? Object.assign({ src: 'lcp' }, entry) : null };
                return;
            }
            const hero = heroCandidate();
            pending = { route: currentRoute, hard: !softNavigated, hero: hero ? Object.assign({ src: 'geo' }, hero) : null };
        }

        function settle(measure) {
            if (!sawLoad || hiddenBeforeLoad) return;
            if (measure) observe();
            // A route left before the settle timer fired has no observation at
            // all, which is not the same as having observed no hero: persisting
            // null there would decrement a record on the strength of never
            // having looked.
            if (!pending || pending.route !== currentRoute) return;
            persistHero(pending.route, pending.hero, pending.hard);
        }

        function scheduleSettle() {
            if (settleTimer) clearTimeout(settleTimer);
            // Late enough for lazy heroes and web fonts to have settled the
            // layout, early enough that most visits still reach it.
            settleTimer = setTimeout(() => settle(true), LEARN_SETTLE_MS);
        }

        onRouteChange(() => {
            const next = pageKey();
            if (next === currentRoute) return;

            // Deliberately not measuring: by the time this runs the DOM is
            // already the next route. Whatever the settle timer saw while the
            // outgoing route was on screen is the only honest observation of
            // it, and if it never ran there is nothing to record.
            settle(false);

            softNavigated = true;
            currentRoute = next;
            persistedRoute = null;
            pending = null;
            lcpEntry = null;
            emittedPreloadFor = null;
            learnedLcpUrl = null;

            applyLearnedHints(next);
            scheduleSettle();
        });

        if (sawLoad) scheduleSettle();
        else window.addEventListener('load', () => {
            sawLoad = true;
            scheduleSettle();
        }, { once: true });

        // Backstops. settle() is idempotent per route, so whichever fires first
        // wins and the rest are no-ops. pagehide rather than unload: an unload
        // listener disqualifies the page from Safari's back/forward cache,
        // which would cost far more than this script saves.
        window.addEventListener('pagehide', () => settle(true));
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'hidden') return;
            if (!sawLoad) hiddenBeforeLoad = true;
            // Unlike a route change, the document here still shows the route
            // being settled, so a fresh measurement is the right one.
            settle(true);
        });
    }

    function persistOrigins() {
        let entries;
        try {
            entries = performance.getEntriesByType('resource') || [];
        } catch (_) {
            return;
        }

        const observed = new Map();
        for (const entry of entries) {
            // Only resources needed early are worth a preconnect; a lazily
            // loaded widget's origin is not on the critical path.
            if (!entry || entry.startTime > LEARN_EARLY_RESOURCE_MS) continue;

            const url = toUrl(entry.name);
            if (!url || url.origin === location.origin) continue;
            if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

            const needsCors = entry.initiatorType === 'css' || FONT_EXTENSION.test(url.pathname);
            const existing = observed.get(url.origin);

            if (existing) {
                existing.cors = existing.cors || needsCors;
                existing.first = Math.min(existing.first, entry.startTime);
            } else {
                observed.set(url.origin, { origin: url.origin, cors: needsCors, first: entry.startTime });
            }
        }

        if (!observed.size) return;

        const store = readStore(LEARN_ORIGINS_KEY) || {};
        const previous = Array.isArray(store.origins) ? store.origins : [];
        const merged = new Map();

        const now = Date.now();
        for (const entry of previous) {
            if (!entry || typeof entry.o !== 'string') continue;
            // Without aging, a CDN that mattered a year ago outranks a
            // currently-critical origin forever and keeps costing a handshake.
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && now - updatedAt > LEARN_MAX_AGE) continue;

            merged.set(entry.o, {
                o: entry.o,
                c: Boolean(entry.c),
                n: Number(entry.n) || 0,
                t: Number(entry.t) || 0,
                u: updatedAt
            });
        }

        for (const info of observed.values()) {
            const existing = merged.get(info.origin);
            if (existing) {
                existing.n += 1;
                existing.c = existing.c || info.cors;
                existing.t = Math.min(existing.t || info.first, info.first);
                existing.u = now;
            } else {
                merged.set(info.origin, { o: info.origin, c: info.cors, n: 1, t: info.first, u: now });
            }
        }

        // Most consistently used first, ties broken by how early the origin is
        // needed — the order a preconnect budget should spend in.
        const ranked = Array.from(merged.values())
            .sort((a, b) => (b.n - a.n) || (a.t - b.t))
            .slice(0, LEARN_ORIGIN_MAX_ENTRIES);

        writeStore(LEARN_ORIGINS_KEY, { origins: ranked, at: Date.now() });
    }

    // =========================================================================
    // Part D: navigation-transition learning
    // =========================================================================
    //
    // Chrome's Part 9 prerenders the page it expects you to open next. Nothing
    // in WebKit can do that. What survives is the learning itself and one safe
    // use for it: if the predicted next page has a hero record, fetch that
    // image now. Images are cacheable and idempotent, so a wrong guess costs
    // bytes and nothing else — unlike a document fetch, which can run server
    // side effects and inflate page-view counts.
    //
    // Scope limit, unchanged from the Chrome build: only same-origin
    // transitions are recorded, keyed by pathname with query strings and
    // fragments dropped before anything is written. Those carry session tokens
    // and search terms and none of it predicts anything.

    const TRANSITION_MAX_SOURCES = 120;
    const TRANSITION_MAX_TARGETS = 4;
    const TRANSITION_MIN_CONFIDENCE = 2;
    // The hero pre-warm is a bet placed before the user has done anything, so
    // it wants more evidence than a hover does.
    const PREWARM_MIN_CONFIDENCE = 3;

    let predictedTargets = [];
    let preWarmedHero = null;

    function recordTransition(fromPath, toPath) {
        const from = String(fromPath || '').slice(0, 200);
        const to = String(toPath || '').slice(0, 200);
        if (!from || !to || from === to) return;

        const store = readStore(LEARN_TRANSITIONS_KEY) || {};
        const now = Date.now();

        const entry = (store[from] && typeof store[from] === 'object') ? store[from] : { t: {}, at: 0 };
        const targets = readTargets(entry, now);

        targets[to] = { n: (targets[to] ? targets[to].n : 0) + 1, at: now };

        // A page that leads everywhere predicts nothing, and storing its whole
        // fan-out just spends quota to dilute the ranking. The destination just
        // taken always stays: through 1.0 a new one tied at 1 with the
        // incumbents, sorted last and was cut, so once a page had four targets
        // it could never learn another — and the source's refreshed timestamp
        // kept the stale four alive indefinitely.
        const ranked = Object.entries(targets)
            .filter(([path]) => path !== to)
            .sort((a, b) => (b[1].n - a[1].n) || (b[1].at - a[1].at))
            .slice(0, TRANSITION_MAX_TARGETS - 1);
        ranked.push([to, targets[to]]);

        store[from] = { t: Object.fromEntries(ranked), at: now };

        const live = Object.entries(store)
            .filter(([, value]) => value && (now - (Number(value.at) || 0)) < LEARN_MAX_AGE)
            .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
            .slice(0, TRANSITION_MAX_SOURCES);

        writeStore(LEARN_TRANSITIONS_KEY, Object.fromEntries(live));
    }

    // Targets are { n, at } since 1.1.0. A 1.0 bare count inherits the
    // source's timestamp, and from then on each target ages out on its own.
    function readTargets(entry, now) {
        const raw = (entry && entry.t && typeof entry.t === 'object') ? entry.t : {};
        const targets = {};
        for (const [path, value] of Object.entries(raw)) {
            const n = typeof value === 'number' ? value : Number(value && value.n) || 0;
            const at = typeof value === 'number' ? Number(entry.at) || 0 : Number(value && value.at) || 0;
            if (n > 0 && now - at < LEARN_MAX_AGE) targets[path] = { n, at };
        }
        return targets;
    }

    function predictNext(fromPath) {
        const store = readStore(LEARN_TRANSITIONS_KEY);
        const entry = store && store[String(fromPath || '').slice(0, 200)];
        if (!entry || !entry.t) return [];

        return Object.entries(readTargets(entry, Date.now()))
            .filter(([, target]) => target.n >= TRANSITION_MIN_CONFIDENCE)
            .sort((a, b) => (b[1].n - a[1].n) || (b[1].at - a[1].at))
            .slice(0, 2)
            .map(([path, target]) => ({ path, count: target.n }));
    }

    function isNavigationEligible(url) {
        if (!url) return false;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (url.origin !== location.origin) return false;
        if (url.pathname === location.pathname) return false;

        // Test the query too: /account?action=logout and /download?file=x.pdf
        // both look inert as a bare pathname, and prefetching either has a
        // side effect. A false positive here only costs a missed prediction.
        const candidate = url.pathname + url.search;
        if (DOWNLOAD_REGEX.test(candidate)) return false;
        if (isSensitiveHref(url.pathname, candidate)) return false;
        return true;
    }

    // new Image() rather than <link rel=preload>: a preload for a resource the
    // current document never uses logs a console warning on every page, and
    // rel=prefetch — which is what this actually is — does not exist in WebKit.
    function warmImage(url) {
        try {
            const img = new Image();
            img.decoding = 'async';
            if (supportsFetchPriority) img.fetchPriority = 'low';
            img.src = url;
            return true;
        } catch (_) {
            return false;
        }
    }

    function preWarmPredictedHero() {
        // Computed before the tier check, not after: on a moderate link the
        // prediction is real and merely unacted-on, and returning early used to
        // leave predictedTargets empty so the status panel reported it as
        // never-learned.
        const candidates = predictNext(pageKey());
        predictedTargets = candidates.filter(c => isNavigationEligible(toUrl(c.path, location.origin)));
        if (!predictedTargets.length) return;
        if (getConnectionTier() !== TIER_FAST) return;

        const best = predictedTargets[0];
        if ((Number(best.count) || 0) < PREWARM_MIN_CONFIDENCE) return;

        const lcpStore = readStore(LEARN_LCP_KEY);
        const record = lcpStore && lcpStore[best.path];
        if (!record || typeof record.url !== 'string') return;
        if ((Number(record.seen) || 0) < minSightings(record)) return;
        if (!matchesViewport(record)) return;
        if (Date.now() - (Number(record.at) || 0) >= LEARN_MAX_AGE) return;
        if (preWarmedHero === record.url) return;

        // One image, once. The next page's hero is the single largest thing it
        // will ask for; anything past that is speculation on speculation.
        if (warmImage(record.url)) preWarmedHero = record.url;
    }

    function initTransitionLearning() {
        let previousRoute = pageKey();

        // document.referrer survives reloads and back/forward traversals, so
        // recording it unconditionally would count /list -> /item once per
        // reload of /item, letting one real navigation reach the confidence
        // gate by itself. Only a fresh navigation is a choice.
        let navType = 'navigate';
        try {
            const nav = performance.getEntriesByType('navigation');
            if (nav && nav[0] && nav[0].type) navType = nav[0].type;
        } catch (_) {}

        if (navType === 'navigate' && document.referrer) {
            const from = toUrl(document.referrer);
            if (from && from.origin === location.origin) {
                recordTransition(from.pathname, previousRoute);
            }
        }

        // A same-document navigation makes no request, so nothing carries a
        // referrer and the transition would otherwise go unrecorded.
        onRouteChange(() => {
            const next = pageKey();
            if (next === previousRoute) return;

            recordTransition(previousRoute, next);
            previousRoute = next;

            // Both belong to the route being left. Carrying preWarmedHero
            // forward would leave the status panel reading predictedTargets[0]
            // on an array this line has just emptied.
            predictedTargets = [];
            preWarmedHero = null;
            preWarmPredictedHero();
            maybeWarmPredictedDocument();
        });

        runWhenLoadedIdle(() => {
            preWarmPredictedHero();
            maybeWarmPredictedDocument();
        });
    }

    // =========================================================================
    // Part E: document warming (opt-in, per origin)
    // =========================================================================
    //
    // The honest version of "prefetch" in Safari. There is no declarative
    // mechanism, so this issues a real same-origin GET and hopes the response
    // is cacheable enough for the navigation to reuse it. Three things are true
    // of that and none of them are true of the Chrome build's prefetch:
    //
    //   - A response with no-store or no-cache — which is most server-rendered
    //     HTML — gains nothing at all and the request is pure waste.
    //   - The server cannot tell this apart from a real visit. Sec-Purpose is a
    //     forbidden header name, so it cannot be set from fetch(). Server-side
    //     analytics and view counters will count it.
    //   - It is a credentialed request, so anything with a session side effect
    //     runs for real.
    //
    // Hence: off unless switched on per origin, same-origin only, sensitive and
    // download paths refused, and triggered by pointerdown (a click that has
    // begun) rather than hover. Where Speculation Rules are switched on, the
    // section after this does the job properly and this path stands down.

    const WARM_BUDGET = 6;
    let warmCount = 0;
    const warmed = new Set();

    // The budget bounds work per navigation. An SPA never reloads, so without
    // this reset the sixth warm of the first route disables document warming
    // for the rest of the visit.
    onRouteChange(() => {
        warmCount = 0;
        warmed.clear();
    });

    function documentWarmingEnabled() {
        return rawRead(storeKey(WARM_FLAG_KEY)) === '1';
    }

    function warmDocument(url) {
        if (warmCount >= WARM_BUDGET || warmed.has(url.href)) return;
        warmed.add(url.href);
        warmCount += 1;

        // The browser's own mechanism where WebKit has it, rather than a
        // request that looks exactly like a visit.
        if (supportsLinkPrefetch) {
            try {
                const hint = document.createElement('link');
                hint.rel = 'prefetch';
                hint.href = url.href;
                appendToHead(hint);
                return;
            } catch (_) {}
        }

        try {
            fetch(url.href, {
                method: 'GET',
                credentials: 'include',
                mode: 'same-origin',
                redirect: 'follow',
                // Ignored by builds that predate fetch priority; harmless there.
                priority: 'low',
                headers: { 'Accept': 'text/html,application/xhtml+xml' }
            }).then(response => {
                // Draining the body is what actually populates the cache entry;
                // an abandoned response can be discarded instead.
                if (response && response.body) return response.text();
                return null;
            }).catch(() => {});
        } catch (_) {}
    }

    // A same-origin link this script would warm by either mechanism.
    function isWarmableLink(link) {
        if (!link || !link.href) return false;

        const url = toUrl(link.href);
        if (!isNavigationEligible(url)) return false;
        if (url.pathname + url.search === location.pathname + location.search) return false;

        const href = link.getAttribute('href') || '';
        if (DOWNLOAD_REGEX.test(href) || /download/i.test(href)) return false;
        // Pointerdown is not a click: a confirm() in the click handler, or a
        // drag off the link, means the user never agreed to this GET. The raw
        // href is checked as well as the resolved path, because that is where
        // a relative action link keeps its token.
        if (isSensitiveHref(url.pathname, href)) return false;
        // '' and '_self' stay in this tab exactly like no target at all (BBC's
        // whole navigation is target="_self"). WebKit's speculation rules
        // cannot follow a link into a new tab either.
        const target = (link.getAttribute('target') || '').toLowerCase();
        if (target && target !== '_self') return false;
        // .download is "" for a bare <a download>, so ask for the attribute.
        if (link.getAttribute('download') !== null || /\b(?:nofollow|external)\b/i.test(link.rel || '')) return false;

        return true;
    }

    function isPlainPrimaryPress(e) {
        // A modified click opens a tab or downloads; neither benefits, and the
        // second is a file that should not be pulled twice.
        return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    }

    function initDocumentWarming() {
        if (!documentWarmingEnabled()) return;
        if (getConnectionTier() === TIER_SLOW) return;

        document.addEventListener('pointerdown', e => {
            // An in-page router answers the click itself; the document we
            // would fetch is never used.
            if (knownSpa) return;
            // Speculation rules do this job properly when they are on.
            if (speculationRulesActive()) return;
            if (!isPlainPrimaryPress(e)) return;
            const link = getClosestLinkTarget(e.target);
            if (isWarmableLink(link)) warmDocument(toUrl(link.href));
        }, { passive: true, capture: true });
    }

    function maybeWarmPredictedDocument() {
        if (speculationRulesActive()) {
            speculatePredicted();
            return;
        }
        if (!documentWarmingEnabled() || knownSpa) return;
        if (getConnectionTier() !== TIER_FAST) return;
        if (!predictedTargets.length) return;

        const best = predictedTargets[0];
        if ((Number(best.count) || 0) < PREWARM_MIN_CONFIDENCE) return;

        const url = toUrl(best.path, location.origin);
        if (isNavigationEligible(url)) warmDocument(url);
    }

    // -------------------------------------------------------------------------
    // Speculation Rules prefetch (where WebKit has it switched on)
    // -------------------------------------------------------------------------
    //
    // Everything that made document warming opt-in is a property of fetch(),
    // not of prefetching. Per spec a speculation-rules prefetch goes out
    // marked Sec-Purpose: prefetch, so a server can tell it from a visit, and
    // the navigation uses the prefetched response whether or not it was
    // cacheable — nothing is fetched twice. So where the rules work, this runs without
    // the toggle, the way the Chrome build does: on pointerdown, about 100ms
    // ahead of the click it starts, and for the destinations learned from
    // here. Prefetch only; WebKit implements no prerender.

    let rulesBlocked = false;
    let pressRulesScript = null;
    let pressHref = null;
    let predictionRulesScript = null;

    function speculationRulesActive() {
        return supportsSpeculationRules && !rulesBlocked && !knownSpa;
    }

    // One script per purpose, replaced rather than accumulated: a rule for a
    // link the user moved past is pure cost, and removing the script cancels
    // its prefetch.
    function installRules(previous, urls) {
        if (previous) previous.remove();
        if (!urls.length) return null;
        const script = makeRulesScript({
            prefetch: [{ source: 'list', urls, eagerness: 'immediate' }]
        });
        (document.head || document.documentElement).appendChild(script);
        return script;
    }

    function speculatePress(href) {
        if (pressHref === href) return;
        pressHref = href;
        try {
            pressRulesScript = installRules(pressRulesScript, [href]);
        } catch (_) {
            // makeRulesScript throws only when Trusted Types refuses the rules
            // and no policy could be made — as final as a CSP block.
            blockRules();
        }
    }

    function speculatePredicted() {
        try {
            // A prefetch the navigation will use is cheap on a fast link and a
            // contested one on a slow link, where only a press warms.
            const urls = getConnectionTier() === TIER_SLOW ? [] : predictedTargets
                .filter(c => (Number(c.count) || 0) >= TRANSITION_MIN_CONFIDENCE)
                .map(c => toUrl(c.path, location.origin))
                .filter(isNavigationEligible)
                .map(url => url.href);
            predictionRulesScript = installRules(predictionRulesScript, urls);
        } catch (_) {
            blockRules();
        }
    }

    // Under a strict CSP inline speculation rules need 'inline-speculation-rules'.
    // Once blocked, stop emitting them and hand the press that was in flight to
    // the opt-in path, which is the only other mechanism there is.
    function blockRules() {
        if (rulesBlocked) return;
        rulesBlocked = true;
        for (const script of [pressRulesScript, predictionRulesScript]) {
            if (script) script.remove();
        }
        pressRulesScript = null;
        predictionRulesScript = null;

        const href = pressHref;
        pressHref = null;
        if (href && documentWarmingEnabled() && getConnectionTier() !== TIER_SLOW) {
            const url = toUrl(href);
            if (url) warmDocument(url);
        }
    }

    function initSpeculationRules() {
        if (!supportsSpeculationRules) return;

        document.addEventListener('securitypolicyviolation', event => {
            // A report-only policy blocks nothing, and a violation for some
            // other script says nothing about inline rules.
            if (!event || event.disposition === 'report') return;
            if (event.blockedURI && event.blockedURI !== 'inline') return;
            if (typeof event.violatedDirective === 'string'
                && event.violatedDirective.indexOf('script-src') === 0) {
                blockRules();
            }
        });

        // Every tier, unlike the fetch() path: a pressed link's prefetch is
        // the navigation's own response, arriving early, not a second copy.
        document.addEventListener('pointerdown', e => {
            if (!speculationRulesActive() || !isPlainPrimaryPress(e)) return;
            const link = getClosestLinkTarget(e.target);
            if (isWarmableLink(link)) speculatePress(link.href);
        }, { passive: true, capture: true });

        // The SPA detector can flip knownSpa mid-visit; a live prediction from
        // before that is pure cost.
        onRouteChange(() => {
            if (!knownSpa) return;
            for (const script of [pressRulesScript, predictionRulesScript]) {
                if (script) script.remove();
            }
            pressRulesScript = null;
            predictionRulesScript = null;
            pressHref = null;
        });
    }

    // =========================================================================
    // Part F: priority hints and lazy media
    // =========================================================================
    //
    // Caveat, and it is larger in Safari than in Chrome: WebKit's preload
    // scanner has usually started fetching parser-discovered images before a
    // userscript can touch them, and neither loading=lazy nor fetchpriority
    // cancels or reorders an in-flight request. The reliable win is
    // script-inserted media — infinite scroll, route changes, lazy widgets —
    // which is also where the runaway byte counts usually are.

    const MEDIA_SCAN_BUDGET = 300;
    const BELOW_FOLD_FACTOR = 1.5;

    function initMediaPriority() {
        // preload="metadata" long predates every feature probed above, so a
        // Safari too old for loading= and fetchpriority still wants the video
        // half of this — which is also the half that saves the most bytes.
        const canTuneLayout = supportsLazyImages || supportsFetchPriority || supportsLazyFrames;

        const tuned = new WeakSet();
        let pending = null;

        function foldLimit() {
            return (window.innerHeight || document.documentElement.clientHeight || 0) * BELOW_FOLD_FACTOR;
        }

        // A responsive hero has no resolved currentSrc until layout runs and
        // may never expose the learned URL through .src at all, so match every
        // candidate the element could resolve to.
        function isLcpCandidate(img) {
            if (!learnedLcpUrl) return false;
            if (img.currentSrc === learnedLcpUrl || img.src === learnedLcpUrl) return true;

            const srcset = img.getAttribute('srcset');
            if (!srcset) return false;

            return srcset.split(',').some(candidate => {
                const href = candidate.trim().split(/\s+/)[0];
                if (!href) return false;
                const url = toUrl(href);
                return Boolean(url) && url.href === learnedLcpUrl;
            });
        }

        // Every decision here needs layout. Guessing from document order is
        // actively harmful: on markup that opens with a logo and a few nav
        // icons the hero is image five, and lazy + fetchpriority=low on the
        // hero is the best-documented way to make a page slower.
        function tuneWithLayout(el, limit) {
            if (!canTuneLayout || tuned.has(el)) return;
            if (el.hasAttribute('loading') || el.hasAttribute('fetchpriority')) return;

            const rect = el.getBoundingClientRect();
            // No box yet (display:none, detached, mid-parse): leave it alone
            // rather than deprioritise something about to become the hero.
            if (rect.width === 0 && rect.height === 0) return;
            if (rect.top <= limit) return;

            const isImage = el.tagName === 'IMG';
            if (isImage && isLcpCandidate(el)) return;

            tuned.add(el);

            if (isImage ? supportsLazyImages : supportsLazyFrames) el.setAttribute('loading', 'lazy');
            // fetchpriority has no meaning on <iframe>; loading=lazy is the
            // whole lever there.
            if (isImage && supportsFetchPriority) el.setAttribute('fetchpriority', 'low');
        }

        function tuneVideo(video) {
            // preload="none" leaves duration NaN until play, which breaks
            // custom players that build their scrubber on loadedmetadata.
            // "metadata" still avoids downloading the media body.
            if (getConnectionTier() !== TIER_SLOW) return;
            if (video.hasAttribute('preload') || video.autoplay) return;
            if (!video.paused || video.currentTime > 0) return;
            video.setAttribute('preload', 'metadata');
        }

        function scanWithLayout() {
            const limit = foldLimit();
            let budget = MEDIA_SCAN_BUDGET;

            try {
                if (canTuneLayout) {
                    for (const img of document.images) {
                        if (budget-- <= 0) break;
                        tuneWithLayout(img, limit);
                    }
                    for (const frame of document.querySelectorAll('iframe')) {
                        if (budget-- <= 0) break;
                        tuneWithLayout(frame, limit);
                    }
                }
                for (const video of document.querySelectorAll('video')) {
                    if (budget-- <= 0) break;
                    tuneVideo(video);
                }
            } catch (_) {}
        }

        // Late-inserted media is where the real byte savings are, and by then
        // layout is available. Batching into a frame also collapses the
        // duplicate delivery a subtree observer sees for a container and each
        // of its children.
        function flushPending() {
            const batch = pending;
            pending = null;
            if (!batch) return;

            const limit = foldLimit();
            for (const el of batch) {
                try {
                    if (el.tagName === 'VIDEO') tuneVideo(el);
                    else tuneWithLayout(el, limit);
                } catch (_) {}
            }
        }

        function enqueue(el) {
            if (tuned.has(el)) return;

            if (!pending) {
                pending = new Set();
                window.requestAnimationFrame(flushPending);
            }
            if (pending.size < MEDIA_SCAN_BUDGET) pending.add(el);
        }

        const root = document.documentElement;
        if (root) {
            const observer = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (!(node instanceof Element)) continue;

                        try {
                            const tag = node.tagName;
                            const selector = canTuneLayout ? 'img, video, iframe' : 'video';
                            if (tag === 'VIDEO' || (canTuneLayout && (tag === 'IMG' || tag === 'IFRAME'))) enqueue(node);
                            else if (node.firstElementChild) {
                                for (const el of node.querySelectorAll(selector)) enqueue(el);
                            }
                        } catch (_) {}
                    }
                }
            });
            observer.observe(root, { childList: true, subtree: true });
        }

        runWhenDomReady(scanWithLayout);
        runWhenLoadedIdle(scanWithLayout);
    }

    // =========================================================================
    // Part G: content-visibility (opt-in)
    // =========================================================================
    //
    // Skipping layout and paint for offscreen sections is often a bigger win
    // than any network change, and on an iPhone it is frequently the biggest
    // win available — but it interacts badly with sticky positioning, in-page
    // anchors and some virtualised lists, so it stays behind a per-origin
    // toggle. WebKit only shipped content-visibility in Safari 18, hence the
    // support probe rather than a bare try.

    const CV_MIN_HEIGHT = 300;
    const CV_MAX_ELEMENTS = 60;

    function contentVisibilityEnabled() {
        return rawRead(storeKey(CV_FLAG_KEY)) === '1';
    }

    function initContentVisibility() {
        if (!contentVisibilityEnabled() || !supportsContentVisibility) return;

        const container = document.querySelector('main, [role="main"], article') || document.body;
        if (!container) return;

        const limit = (window.innerHeight || 0) * BELOW_FOLD_FACTOR;
        const candidates = [];

        // Measure everything first, then write: interleaving would thrash
        // layout once per section.
        for (const child of container.children) {
            if (candidates.length >= CV_MAX_ELEMENTS) break;
            if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') continue;

            const rect = child.getBoundingClientRect();
            if (rect.top <= limit || rect.height < CV_MIN_HEIGHT) continue;
            candidates.push([child, rect.height]);
        }

        for (const [child, height] of candidates) {
            // contain-intrinsic-size is what keeps the scrollbar and any
            // in-page anchor offsets stable while the section is skipped.
            child.style.setProperty('content-visibility', 'auto');
            child.style.setProperty('contain-intrinsic-size', 'auto ' + Math.round(height) + 'px');
        }
    }

    // =========================================================================
    // Commands
    // =========================================================================
    //
    // GM_registerMenuCommand is present in Tampermonkey for Safari and absent
    // from the Userscripts app, which has no menu surface at all. Rather than
    // let the whole control surface disappear on half the installs, commands
    // are also reachable from a panel bound to Ctrl-Shift-Q. The panel lives in
    // a shadow root so the page's CSS cannot restyle or hide it.

    const commands = [];

    function registerCommand(label, fn) {
        commands.push({ label, fn });
        try {
            if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Quicksilver: ' + label, fn);
            else if (typeof GM !== 'undefined' && GM && typeof GM.registerMenuCommand === 'function') {
                GM.registerMenuCommand('Quicksilver: ' + label, fn);
            }
        } catch (_) {}
    }

    let panelHost = null;

    function closePanel() {
        if (!panelHost) return;
        panelHost.remove();
        panelHost = null;
    }

    function showPanel(text) {
        closePanel();
        if (!document.body && !document.documentElement) return;

        panelHost = document.createElement('div');
        panelHost.style.cssText = 'all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647';
        const root = panelHost.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = [
            ':host{all:initial}',
            '.card{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e8e8ea;',
            'background:#1c1c1ef2;-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);',
            'border:1px solid #ffffff26;border-radius:12px;padding:14px 16px;max-width:min(520px,90vw);',
            'max-height:70vh;overflow:auto;box-shadow:0 12px 40px #00000059}',
            'pre{margin:0 0 12px;white-space:pre-wrap;font:inherit}',
            '.row{display:flex;flex-wrap:wrap;gap:6px}',
            'button{font:11px/1 -apple-system,system-ui,sans-serif;color:#e8e8ea;background:#ffffff1a;',
            'border:1px solid #ffffff26;border-radius:7px;padding:7px 10px;cursor:pointer}',
            'button:hover{background:#ffffff2e}'
        ].join('');

        const card = document.createElement('div');
        card.className = 'card';

        const pre = document.createElement('pre');
        pre.textContent = text;
        card.appendChild(pre);

        const row = document.createElement('div');
        row.className = 'row';
        for (const command of commands) {
            const button = document.createElement('button');
            button.textContent = command.label;
            button.addEventListener('click', () => {
                closePanel();
                try {
                    command.fn();
                } catch (_) {}
            });
            row.appendChild(button);
        }

        const close = document.createElement('button');
        close.textContent = 'Close';
        close.addEventListener('click', closePanel);
        row.appendChild(close);

        card.appendChild(row);
        root.appendChild(style);
        root.appendChild(card);
        (document.body || document.documentElement).appendChild(panelHost);
    }

    function tierName(tier) {
        return { 1: 'slow', 2: 'moderate', 3: 'fast' }[tier] || 'unknown';
    }

    function statusReport() {
        const tier = getConnectionTier();
        const route = pageKey();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const originStore = readStore(LEARN_ORIGINS_KEY);
        const vitals = readStore(LEARN_VITALS_KEY);
        const transitions = readStore(LEARN_TRANSITIONS_KEY);
        const record = lcpStore && lcpStore[route];

        const lines = [];
        const feature = (mark, name, detail) => lines.push('  ' + mark + ' ' + name + '\n      ' + detail);

        lines.push('Quicksilver Safari ' + SCRIPT_VERSION + ' — ' + location.origin + route);
        lines.push('');
        lines.push('ACTIVE ON THIS PAGE');

        feature('●', 'Hover preconnect', 'DNS + TLS opened on hover, focus or touch');

        if (learnedLcpUrl) {
            feature('●', 'Learned hero preload', 'preloading this route’s hero image'
                + (record && record.src === 'lcp' ? ' (measured LCP)' : ' (largest first-screen image)'));
        } else if (record) {
            const seen = Number(record.seen) || 0;
            const need = Math.max(0, minSightings(record) - seen);
            feature('◐', 'Learned hero preload', need > 0
                ? 'seen ' + seen + '× — ' + need + ' more visit' + (need === 1 ? '' : 's') + ' before it acts'
                : 'record exists but did not match this viewport');
        } else {
            feature('◐', 'Learned hero preload', 'no record for this route yet');
        }

        if (preWarmedHero && predictedTargets.length) {
            feature('●', 'Next-page prediction', predictedTargets[0].path
                + ' (seen ' + predictedTargets[0].count + '×) — its hero is already fetched');
        } else if (predictedTargets.length) {
            feature('◐', 'Next-page prediction', predictedTargets[0].path
                + ' (seen ' + predictedTargets[0].count + '×) — nothing to pre-warm for it yet');
        } else {
            feature('◐', 'Next-page prediction',
                'learns where you go from here — needs ' + TRANSITION_MIN_CONFIDENCE + ' visits along the same path');
        }

        if (supportsSpeculationRules) {
            feature(speculationRulesActive() ? '●' : '○', 'Prefetch on press',
                speculationRulesActive()
                    ? 'Speculation Rules prefetch on pointerdown and for learned next pages'
                    : knownSpa
                        ? 'off — this site answers link clicks in-page'
                        : 'off — this site’s CSP blocks inline speculation rules');
        }

        feature(documentWarmingEnabled() && !knownSpa ? '●' : '○', 'Document warming',
            !documentWarmingEnabled()
                ? 'off for this origin — Safari has no speculation rules, see the toggle'
                : knownSpa
                    ? 'off — this site answers link clicks in-page, so a fetched page is never used'
                    : (supportsLinkPrefetch ? 'prefetching' : 'fetching') + ' same-origin pages on pointerdown');

        feature(contentVisibilityEnabled() ? (supportsContentVisibility ? '●' : '○') : '○', 'Aggressive rendering',
            !contentVisibilityEnabled() ? 'off for this origin'
                : (supportsContentVisibility ? 'skipping layout for offscreen sections'
                    : 'enabled, but this Safari has no content-visibility'));

        const describeSamples = values => {
            const samples = (Array.isArray(values) ? values : []).filter(Number.isFinite);
            return samples.length ? median(samples) + ' ms (median of ' + samples.length + ')' : null;
        };
        const fcpText = describeSamples(vitals && vitals.fcp) || 'no samples yet';
        const lcpText = describeSamples(vitals && vitals.lcp);

        // Hit rate of the hero preload: was the preloaded image the hero that
        // painted? Low numbers mean the heuristic is guessing wrong here.
        const describeHero = stats => {
            const hero = (stats && stats.hero) || {};
            const hit = Number(hero.hit) || 0;
            const total = hit + (Number(hero.miss) || 0);
            return total ? hit + ' of ' + total + ' (' + Math.round((hit / total) * 100) + '%)' : 'no preloads scored yet';
        };

        const netSamples = readNetSamples();
        const netText = netSamples.length
            ? median(netSamples.map(s => s.t)) + ' ms TTFB (median of ' + netSamples.length + ')'
            : 'no samples yet';

        lines.push('');
        lines.push('LEARNED FOR THIS ORIGIN');
        lines.push('  Pages with a hero record   ' + (lcpStore ? Object.keys(lcpStore).length : 0));
        lines.push('  Critical origins           ' + ((originStore && Array.isArray(originStore.origins))
            ? originStore.origins.length : 0));
        lines.push('  Navigation sources         ' + (transitions ? Object.keys(transitions).length : 0));
        lines.push('  Median FCP                 ' + fcpText);
        if (lcpText) lines.push('  Median LCP                 ' + lcpText);
        lines.push('  Client-side router         ' + (knownSpa ? 'yes — document warming is off here' : 'not seen'));
        lines.push('');
        lines.push('MEASURED');
        lines.push('  Hero preload was the hero  ' + describeHero(readStore(STATS_KEY)) + ' on this site');
        if (usingGm) lines.push('                             ' + describeHero(readAllStats()) + ' on all sites');
        lines.push('');
        lines.push('ENVIRONMENT');
        lines.push('  Connection                 ' + tierName(tier) + ' — ' + netText);
        lines.push('  Storage                    ' + (gmSync ? 'GM_* (synchronous)'
            : gmAsync ? 'GM.* (asynchronous)' : 'localStorage — readable by this page'));
        lines.push('  fetchpriority              ' + (supportsFetchPriority ? 'yes' : 'no'));
        lines.push('  imagesrcset preload        ' + (supportsImageSrcset ? 'yes' : 'no'));
        lines.push('  content-visibility         ' + (supportsContentVisibility ? 'yes' : 'no'));
        lines.push('  LCP entries                ' + (supportsLcp ? 'yes — heroes are measured' : 'no — heroes are found by layout'));
        lines.push('  Navigation API             ' + (supportsNavigationApi ? 'yes — no route polling' : 'no — polling every 400ms while visible'));
        lines.push('  <link rel=prefetch>        ' + (supportsLinkPrefetch ? 'yes' : 'no'));
        lines.push('  Speculation Rules          ' + (supportsSpeculationRules
            ? 'yes — prefetch on press needs no toggle'
            : 'no — off by default; Develop > Feature Flags can switch it on'));

        return lines.join('\n');
    }

    function initCommands() {
        registerCommand('Status', () => showPanel(statusReport()));

        registerCommand('Forget this site', () => {
            for (const key of ORIGIN_KEYS) deleteStore(key);
            learnedLcpUrl = null;
            emittedPreloadFor = null;
            heroPreload = null;
            predictedTargets = [];
            preWarmedHero = null;
            knownSpa = false;
            showPanel('Quicksilver forgot everything learned for ' + location.origin
                + '.\n\nThe per-origin preferences were kept.');
        });

        registerCommand('Forget navigation history (this site)', () => {
            deleteStore(LEARN_TRANSITIONS_KEY);
            predictedTargets = [];
            showPanel('Quicksilver forgot every page-to-page transition learned for '
                + location.origin + '.');
        });

        registerCommand('Toggle document warming', () => {
            const next = documentWarmingEnabled() ? '0' : '1';
            rawWrite(storeKey(WARM_FLAG_KEY), next);
            showPanel('Document warming ' + (next === '1' ? 'enabled' : 'disabled')
                + ' for this origin. Reload to apply.\n\n'
                + 'Safari has no prefetch and no speculation rules, so this issues a real\n'
                + 'same-origin GET when you press on a link. It only helps if the response\n'
                + 'is cacheable, the server cannot tell it apart from a real visit — so\n'
                + 'server-side analytics will count it — and it is credentialed. Leave it\n'
                + 'off on anything with a session, a paywall or a view counter you care\n'
                + 'about.');
        });

        registerCommand('Toggle aggressive rendering', () => {
            const next = contentVisibilityEnabled() ? '0' : '1';
            rawWrite(storeKey(CV_FLAG_KEY), next);
            showPanel('Aggressive rendering ' + (next === '1' ? 'enabled' : 'disabled')
                + ' for this origin. Reload to apply.\n\nSkips layout and paint for offscreen '
                + 'sections. Disable if dropdowns or tooltips appear clipped at a section '
                + 'edge, or if sticky headers or in-page anchors misbehave. On Safari 27, '
                + 'scroll anchoring keeps the page from jumping as skipped sections are measured.'
                + (supportsContentVisibility ? '' : '\n\nThis Safari does not support content-visibility; '
                    + 'the preference is stored but has no effect.'));
        });

        window.addEventListener('keydown', e => {
            if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return;
            if ((e.key || '').toLowerCase() !== 'q') return;
            e.preventDefault();
            if (panelHost) closePanel();
            else showPanel(statusReport());
        }, true);
    }

    // =========================================================================
    // Start
    // =========================================================================
    //
    // Under GM_* this resolves in the same task and the preload is emitted
    // before the parser has left <head>. Under GM.* it costs one microtask
    // round trip, which is still ahead of every parser-discovered image.

    // Each part is independent, and in the Chrome build each was a top-level
    // statement that could fail alone. Sharing one promise callback would let a
    // throw in the first take out the commands in the last — leaving the user
    // no way to see or switch off whatever is misbehaving — and surface as
    // nothing but an unhandled rejection.
    function safely(fn) {
        try {
            fn();
        } catch (error) {
            try {
                console.warn('Quicksilver: ' + (fn.name || 'init') + ' failed', error);
            } catch (_) {}
        }
    }

    storageReady.then(() => {
        storagePrimed = true;
        // Anything computed from an empty store before this point is void.
        cachedTier = null;

        safely(initSpaDetection);
        safely(() => applyLearnedHints());
        safely(initLearning);
        safely(initTransitionLearning);
        safely(initSpeculationRules);
        safely(initDocumentWarming);
        safely(initMediaPriority);
        safely(initCommands);

        runWhenLoadedIdle(() => {
            safely(recordNetSample);
            safely(persistOrigins);
        });
        runWhenLoadedIdle(() => safely(initContentVisibility));
    }).catch(() => {});
})();
