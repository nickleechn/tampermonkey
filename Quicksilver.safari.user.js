// ==UserScript==
// @name         Quicksilver Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.0.1
// @description  Safari/WebKit build: learned LCP preload + critical-origin preconnect, hover/focus preconnect, learned connection tiering, navigation-transition learning, media priority hints, font-display patching and opt-in content-visibility. No Speculation Rules — WebKit has none.
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
//
// Two things here have no counterpart in the Chrome build, because they answer
// problems Safari has and Chrome does not:
//
//   Learned font preload (Part C). A webfont is the latest-discovered blocking
//   resource on any page — HTML, then CSSOM, then layout, and only then does
//   the request start. Chrome's build never needed this because its
//   speculation rules had usually delivered the whole next document already.
//   Here it is the largest remaining win, and it is measured from Resource
//   Timing rather than guessed at.
//
//   Viewport preconnect (Part A). iOS has no hover, so on a phone the hover
//   half of Part A never fired and touchstart gave about one handshake of
//   warning. Warming origins as links scroll into view is the closest thing a
//   touch screen produces to hover intent, tightly budgeted because a socket
//   opened for a link nobody taps costs the server and the radio.

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

    const SENSITIVE_PATH_SEGMENTS = 'logout|signout|log-out|sign-out|checkout|cart|account|admin|orders?|payments?|delete|auth|login|signin|sign-in|session|destroy|revoke|unsubscribe|remove|transfer';
    const SENSITIVE_HREF_REGEX = new RegExp(
        '\\/(?:' + SENSITIVE_PATH_SEGMENTS + ')(?:[\\/?#-]|$)',
        'i'
    );

    const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
    // A preload with a type the browser cannot render is a wasted request, and
    // .eot is never usable in WebKit at all, so it is not in this table and
    // anything absent from it is refused rather than preloaded untyped.
    const FONT_MIME = {
        woff2: 'font/woff2',
        woff: 'font/woff',
        ttf: 'font/ttf',
        otf: 'font/otf'
    };

    function fontMimeFor(pathname) {
        const match = /\.([a-z0-9]+)$/i.exec(pathname || '');
        return match ? (FONT_MIME[match[1].toLowerCase()] || null) : null;
    }

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
    const LEARN_FONTS_KEY = 'tm-qs-fonts';
    const LEARN_VITALS_KEY = 'tm-qs-vitals';
    const LEARN_TRANSITIONS_KEY = 'tm-qs-transitions';
    const CV_FLAG_KEY = 'tm-qs-content-visibility';
    const WARM_FLAG_KEY = 'tm-qs-warm';
    const LEARN_INDEX_KEY = 'tm-qs-origin-index';
    const NET_KEY = 'tm-qs-net';

    const ORIGIN_KEYS = [LEARN_LCP_KEY, LEARN_ORIGINS_KEY, LEARN_FONTS_KEY, LEARN_VITALS_KEY, LEARN_TRANSITIONS_KEY];
    const FLAG_KEYS = [CV_FLAG_KEY, WARM_FLAG_KEY];
    const GLOBAL_KEYS = [LEARN_INDEX_KEY, NET_KEY];

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
    // No Navigation API in WebKit, and under @inject-into content a
    // history.pushState patch would only observe calls made from this script's
    // own world — the page's router lives in another one and would go
    // completely undetected. Polling location.href is world-agnostic, costs a
    // string compare, and stops entirely while the tab is hidden.

    const ROUTE_POLL_MS = 400;
    const routeChangeHandlers = [];
    let routeWatcherInstalled = false;
    let watchedHref = location.href;

    function onRouteChange(handler) {
        routeChangeHandlers.push(handler);
        installRouteWatcher();
    }

    function fireRouteChange() {
        for (const handler of routeChangeHandlers) {
            try {
                handler();
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

    function viewportBucket() {
        const width = Math.round((window.innerWidth || 0) / 160) * 160;
        const dpr = Math.round(window.devicePixelRatio || 1);
        return width + 'x' + dpr;
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

    // iOS has no hover at all, so on a phone Part A only ever fired at
    // touchstart — roughly one handshake of warning. A link scrolling into
    // view is seconds of warning instead, and it is the closest thing to
    // hover intent a touch screen produces.
    const VIEWPORT_PRECONNECT_BUDGET = 4;
    const VIEWPORT_DNS_BUDGET = 12;
    const VIEWPORT_LINK_BUDGET = 300;
    const VIEWPORT_ROOT_MARGIN = '200px';

    let viewportIntentState = 'off';

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

        // A socket opened for a link nobody taps is not free — it costs the
        // server a connection and the phone some radio time — so this is
        // budgeted far more tightly than hover, which at least implies intent.
        // DNS is the cheaper half and gets the larger share: no socket, no
        // handshake, and on mobile a cold lookup is routinely 100ms+.
        function initViewportIntent() {
            if (typeof IntersectionObserver === 'undefined') return;

            // Where hover exists it is the better signal, and running both
            // would spend the budget twice for one intent.
            try {
                if (window.matchMedia && window.matchMedia('(hover: hover)').matches) return;
            } catch (_) {}

            if (getConnectionTier() !== TIER_FAST) {
                viewportIntentState = 'paused';
                return;
            }

            let socketBudget = VIEWPORT_PRECONNECT_BUDGET;
            let dnsBudget = VIEWPORT_DNS_BUDGET;
            viewportIntentState = 'on';

            const observer = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry || !entry.isIntersecting) continue;

                    // One link is one chance to learn its origin; leaving it
                    // observed would re-deliver it on every scroll past.
                    observer.unobserve(entry.target);

                    const url = toUrl(entry.target.href);
                    if (!url || url.origin === currentOrigin) continue;
                    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

                    if (dnsBudget > 0 && !dnsPrefetched.has(url.origin)) {
                        dnsBudget -= 1;
                        dnsPrefetch(url.origin);
                    }
                    if (socketBudget > 0 && !connected.has(url.origin)) {
                        socketBudget -= 1;
                        preconnect(url.origin);
                    }
                }

                // Both budgets spent: nothing further to learn, and an
                // observer over hundreds of links in an infinite feed is a
                // cost with no remaining upside.
                if (dnsBudget <= 0 && socketBudget <= 0) {
                    observer.disconnect();
                    viewportIntentState = 'spent';
                }
            }, { rootMargin: VIEWPORT_ROOT_MARGIN });

            // Deliberately no MutationObserver for links added later. The
            // budgets are small enough that they are usually spent on the
            // first screen, and self-limiting beats a permanent subscription
            // on a feed that appends links forever. A second pass after load
            // catches what hydration added.
            function observeLinks() {
                if (viewportIntentState !== 'on') return;

                let budget = VIEWPORT_LINK_BUDGET;
                try {
                    for (const link of document.querySelectorAll('a[href]')) {
                        if (budget-- <= 0) break;
                        observer.observe(link);
                    }
                } catch (_) {}
            }

            observeLinks();
            runWhenLoadedIdle(observeLinks);
        }

        document.addEventListener('pointerover', e => maybePreconnect(e.target), { passive: true, capture: true });
        document.addEventListener('focusin', e => maybePreconnect(e.target), { passive: true, capture: true });
        // touchstart lands roughly 100-300ms before the navigation, which is
        // about one handshake — worth having even where viewport intent has
        // already warmed the common origins.
        document.addEventListener('touchstart', e => {
            const touch = e.touches && e.touches[0];
            if (touch) maybePreconnect(e.target);
        }, { passive: true, capture: true });

        initViewportIntent();
    }

    runWhenDomReady(initPreconnectOnIntent);

    // =========================================================================
    // Part B: font-display injection
    // =========================================================================

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
    // paint time. WebKit exposes nothing equivalent, so the hero is found by
    // measuring — the largest image intersecting the first viewport, taken
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
    const LEARN_FONT_MAX_ENTRIES = 6;
    const LEARN_VITALS_SAMPLES = 12;
    const LEARN_MAX_AGE = 14 * 24 * HOUR;
    // Higher than the Chrome build's 2, because the observation is a
    // heuristic. It applies to the hero and to nothing else: a critical origin
    // is measured from Resource Timing rather than guessed at, so it keeps the
    // Chrome build's gate and is not made to wait an extra visit for a doubt
    // that does not apply to it.
    const LEARN_MIN_SIGHTINGS = 3;
    const LEARN_ORIGIN_MIN_SIGHTINGS = 2;
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

    function applyLearnedHints(route) {
        const key = route || pageKey();
        const tier = getConnectionTier();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const record = lcpStore && lcpStore[key];

        if (
            record
            && typeof record.url === 'string'
            && (Number(record.seen) || 0) >= LEARN_MIN_SIGHTINGS
            && record.vw === viewportBucket()
            && Date.now() - (Number(record.at) || 0) < LEARN_MAX_AGE
            && emittedPreloadFor !== record.url
        ) {
            learnedLcpUrl = record.url;
            emittedPreloadFor = record.url;

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
                if (record.srcset && supportsImageSrcset) {
                    link.setAttribute('imagesrcset', record.srcset);
                    if (record.sizes) link.setAttribute('imagesizes', record.sizes);
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
        const budget = tier === TIER_SLOW ? 2 : (tier === TIER_MODERATE ? 3 : 4);

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

        applyLearnedFonts(tier);
    }

    // A webfont is the latest-discovered blocking resource on the page: the
    // browser needs HTML, then CSSOM, then layout before it knows the font
    // exists, so its request starts three round trips deep. Nothing else this
    // script learns is discovered that late, which is why a font record is
    // worth more than the hero record it sits next to — and unlike the hero it
    // is measured from Resource Timing rather than guessed at from geometry.
    function applyLearnedFonts(tier) {
        // On a slow link the font is not going to arrive before the block
        // period ends anyway; Part B has already set font-display:optional, so
        // the fallback is what renders and the bytes would buy nothing.
        const budget = tier === TIER_SLOW ? 0 : (tier === TIER_MODERATE ? 1 : 2);
        if (!budget) return;

        const store = readStore(LEARN_FONTS_KEY);
        const fonts = (store && Array.isArray(store.fonts)) ? store.fonts : [];

        let used = 0;
        for (const entry of fonts) {
            if (used >= budget) break;
            if (!entry || typeof entry.f !== 'string') continue;
            if ((Number(entry.n) || 0) < LEARN_ORIGIN_MIN_SIGHTINGS) continue;
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && Date.now() - updatedAt > LEARN_MAX_AGE) continue;

            const url = toUrl(entry.f);
            if (!url) continue;
            const type = fontMimeFor(url.pathname);
            if (!type) continue;

            try {
                const hint = document.createElement('link');
                hint.rel = 'preload';
                hint.as = 'font';
                hint.href = url.href;
                hint.setAttribute('type', type);
                // Not optional and not a same-origin exception: fonts are
                // always fetched in anonymous CORS mode, so a preload without
                // crossorigin lands in a different cache partition and the
                // page downloads the font a second time — strictly worse than
                // not preloading it.
                hint.crossOrigin = 'anonymous';
                // A hashed filename dies at the next deploy. Evicting on the
                // 404 stops it costing a request a day for two weeks.
                hint.addEventListener('error', () => {
                    const current = readStore(LEARN_FONTS_KEY);
                    if (!current || !Array.isArray(current.fonts)) return;
                    const kept = current.fonts.filter(f => f && f.f !== entry.f);
                    if (kept.length === current.fonts.length) return;
                    writeStore(LEARN_FONTS_KEY, { fonts: kept, at: Date.now() });
                }, { once: true });
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
            best = {
                url: url.href,
                cors: img.crossOrigin || null,
                srcset: img.getAttribute('srcset'),
                sizes: img.getAttribute('sizes')
            };
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

        function persistHero(route, observed) {
            if (!route || persistedRoute === route) return;
            persistedRoute = route;

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

            const store = readStore(LEARN_LCP_KEY) || {};
            const previous = store[route];
            const bucket = viewportBucket();
            const sameTarget = Boolean(previous && previous.url === observed.url && previous.vw === bucket);

            store[route] = {
                url: observed.url,
                cors: observed.cors,
                srcset: observed.srcset,
                sizes: observed.sizes,
                vw: bucket,
                at: Date.now(),
                // A changed target resets confidence rather than accumulating
                // it. With a geometric heuristic this is doing more work than
                // it does in the Chrome build: it is what stops a rotating
                // banner or a slot that sometimes holds an ad from ever
                // reaching the gate.
                seen: sameTarget ? Math.min(Number(previous.seen) || 0, 50) + 1 : 1
            };

            writeStore(LEARN_LCP_KEY, capStore(store, LEARN_LCP_MAX_ENTRIES));

            // No LCP in WebKit, so the vitals sample is FCP. It is a different
            // number and is reported as such — it says when the page started
            // being useful, not when it finished.
            const fcp = firstContentfulPaint();
            if (Number.isFinite(fcp) && fcp > 0) {
                const vitals = readStore(LEARN_VITALS_KEY) || {};
                const samples = Array.isArray(vitals.fcp) ? vitals.fcp.filter(Number.isFinite) : [];
                samples.push(Math.round(fcp));
                writeStore(LEARN_VITALS_KEY, { fcp: samples.slice(-LEARN_VITALS_SAMPLES) });
            }
        }

        // Safe only while the document still shows currentRoute.
        function observe() {
            if (!sawLoad || hiddenBeforeLoad) return;
            pending = { route: currentRoute, hero: heroCandidate() };
        }

        function settle(measure) {
            if (!sawLoad || hiddenBeforeLoad) return;
            if (measure) observe();
            // A route left before the settle timer fired has no observation at
            // all, which is not the same as having observed no hero: persisting
            // null there would decrement a record on the strength of never
            // having looked.
            if (!pending || pending.route !== currentRoute) return;
            persistHero(pending.route, pending.hero);
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

            currentRoute = next;
            persistedRoute = null;
            pending = null;
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

    function resourceEntries() {
        try {
            return performance.getEntriesByType('resource') || [];
        } catch (_) {
            return [];
        }
    }

    function persistFonts() {
        const observed = new Map();

        for (const entry of resourceEntries()) {
            // A font pulled in late is a lazy widget's, not the one the first
            // screen of text is waiting on.
            if (!entry || entry.startTime > LEARN_EARLY_RESOURCE_MS) continue;

            const url = toUrl(entry.name);
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) continue;
            if (!FONT_EXTENSION.test(url.pathname)) continue;
            // Only formats WebKit can actually use are worth a record.
            if (!fontMimeFor(url.pathname)) continue;

            // Query strings on font URLs are cache-busters, and keeping them
            // would make every deploy look like a different font.
            const href = (url.origin + url.pathname).slice(0, 300);
            const existing = observed.get(href);
            if (existing) existing.first = Math.min(existing.first, entry.startTime);
            else observed.set(href, { font: href, first: entry.startTime });
        }

        if (!observed.size) return;

        const store = readStore(LEARN_FONTS_KEY) || {};
        const previous = Array.isArray(store.fonts) ? store.fonts : [];
        const merged = new Map();
        const now = Date.now();

        for (const entry of previous) {
            if (!entry || typeof entry.f !== 'string') continue;
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && now - updatedAt > LEARN_MAX_AGE) continue;
            merged.set(entry.f, {
                f: entry.f,
                n: Number(entry.n) || 0,
                t: Number(entry.t) || 0,
                u: updatedAt
            });
        }

        for (const info of observed.values()) {
            const existing = merged.get(info.font);
            if (existing) {
                existing.n += 1;
                existing.t = Math.min(existing.t || info.first, info.first);
                existing.u = now;
            } else {
                merged.set(info.font, { f: info.font, n: 1, t: info.first, u: now });
            }
        }

        // A site with eight weights loads them all; the two the first screen
        // waits on are the ones fetched earliest and every time.
        const ranked = Array.from(merged.values())
            .sort((a, b) => (b.n - a.n) || (a.t - b.t))
            .slice(0, LEARN_FONT_MAX_ENTRIES);

        writeStore(LEARN_FONTS_KEY, { fonts: ranked, at: now });
    }

    function persistOrigins() {
        const entries = resourceEntries();
        if (!entries.length) return;

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
        const targets = (entry.t && typeof entry.t === 'object') ? entry.t : {};

        targets[to] = (Number(targets[to]) || 0) + 1;

        // A page that leads everywhere predicts nothing, and storing its whole
        // fan-out just spends quota to dilute the ranking.
        const ranked = Object.entries(targets)
            .sort((a, b) => b[1] - a[1])
            .slice(0, TRANSITION_MAX_TARGETS);

        store[from] = { t: Object.fromEntries(ranked), at: now };

        const live = Object.entries(store)
            .filter(([, value]) => value && (now - (Number(value.at) || 0)) < LEARN_MAX_AGE)
            .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
            .slice(0, TRANSITION_MAX_SOURCES);

        writeStore(LEARN_TRANSITIONS_KEY, Object.fromEntries(live));
    }

    function predictNext(fromPath) {
        const store = readStore(LEARN_TRANSITIONS_KEY);
        const entry = store && store[String(fromPath || '').slice(0, 200)];
        if (!entry || !entry.t) return [];

        return Object.entries(entry.t)
            .filter(([, count]) => (Number(count) || 0) >= TRANSITION_MIN_CONFIDENCE)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([path, count]) => ({ path, count }));
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
        if (SENSITIVE_HREF_REGEX.test(candidate)) return false;
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
        if ((Number(record.seen) || 0) < LEARN_MIN_SIGHTINGS) return;
        if (record.vw !== viewportBucket()) return;
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
    // begun) rather than hover.

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

    function initDocumentWarming() {
        if (!documentWarmingEnabled()) return;
        if (getConnectionTier() === TIER_SLOW) return;

        function isEligible(link) {
            if (!link || !link.href) return false;

            const url = toUrl(link.href);
            if (!isNavigationEligible(url)) return false;
            if (url.pathname + url.search === location.pathname + location.search) return false;

            const href = link.getAttribute('href') || '';
            if (DOWNLOAD_REGEX.test(href) || /download/i.test(href)) return false;
            if (link.target || link.download || /\b(?:nofollow|external)\b/i.test(link.rel || '')) return false;

            return true;
        }

        document.addEventListener('pointerdown', e => {
            // A modified click opens a tab or downloads; neither benefits, and
            // the second is a file we should not be pulling twice.
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) warmDocument(toUrl(link.href));
        }, { passive: true, capture: true });
    }

    function maybeWarmPredictedDocument() {
        if (!documentWarmingEnabled()) return;
        if (getConnectionTier() !== TIER_FAST) return;
        if (!predictedTargets.length) return;

        const best = predictedTargets[0];
        if ((Number(best.count) || 0) < PREWARM_MIN_CONFIDENCE) return;

        const url = toUrl(best.path, location.origin);
        if (isNavigationEligible(url)) warmDocument(url);
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
        const fontStore = readStore(LEARN_FONTS_KEY);
        const vitals = readStore(LEARN_VITALS_KEY);
        const transitions = readStore(LEARN_TRANSITIONS_KEY);
        const record = lcpStore && lcpStore[route];

        const lines = [];
        const feature = (mark, name, detail) => lines.push('  ' + mark + ' ' + name + '\n      ' + detail);

        lines.push('Quicksilver Safari 1.0.0 — ' + location.origin + route);
        lines.push('');
        lines.push('ACTIVE ON THIS PAGE');

        feature('●', 'Hover preconnect', 'DNS + TLS opened on hover, focus or touch');

        const viewportDetail = {
            on: 'warming origins as links scroll into view',
            spent: 'budget spent — origins on this page are already warm',
            paused: 'paused — connection is ' + tierName(tier),
            off: 'not needed — this device has hover'
        }[viewportIntentState];
        feature(viewportIntentState === 'off' ? '○' : (viewportIntentState === 'paused' ? '○' : '●'),
            'Viewport preconnect', viewportDetail);

        const confidentFonts = ((fontStore && Array.isArray(fontStore.fonts)) ? fontStore.fonts : [])
            .filter(f => f && (Number(f.n) || 0) >= LEARN_ORIGIN_MIN_SIGHTINGS && fontMimeFor(f.f));
        if (tier === TIER_SLOW) {
            feature('○', 'Learned font preload', 'paused — the fallback renders instead on a slow link');
        } else if (confidentFonts.length) {
            feature('●', 'Learned font preload', confidentFonts.length + ' font'
                + (confidentFonts.length === 1 ? '' : 's') + ' fetched before the CSS asks for them');
        } else {
            feature('◐', 'Learned font preload',
                'needs ' + LEARN_ORIGIN_MIN_SIGHTINGS + ' visits to learn which fonts load first');
        }

        if (learnedLcpUrl) {
            feature('●', 'Learned hero preload', 'preloading this route’s hero image');
        } else if (record) {
            const seen = Number(record.seen) || 0;
            const need = Math.max(0, LEARN_MIN_SIGHTINGS - seen);
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

        feature(documentWarmingEnabled() ? '●' : '○', 'Document warming',
            documentWarmingEnabled()
                ? 'fetching same-origin pages on pointerdown'
                : 'off for this origin — Safari has no prefetch, see the toggle');

        feature(contentVisibilityEnabled() ? (supportsContentVisibility ? '●' : '○') : '○', 'Aggressive rendering',
            !contentVisibilityEnabled() ? 'off for this origin'
                : (supportsContentVisibility ? 'skipping layout for offscreen sections'
                    : 'enabled, but this Safari has no content-visibility'));

        const samples = (vitals && Array.isArray(vitals.fcp) ? vitals.fcp : []).filter(Number.isFinite);
        const fcpText = samples.length
            ? median(samples) + ' ms (median of ' + samples.length + ')'
            : 'no samples yet';

        const netSamples = readNetSamples();
        const netText = netSamples.length
            ? median(netSamples.map(s => s.t)) + ' ms TTFB (median of ' + netSamples.length + ')'
            : 'no samples yet';

        lines.push('');
        lines.push('LEARNED FOR THIS ORIGIN');
        lines.push('  Pages with a hero record   ' + (lcpStore ? Object.keys(lcpStore).length : 0));
        lines.push('  Critical origins           ' + ((originStore && Array.isArray(originStore.origins))
            ? originStore.origins.length : 0));
        lines.push('  Critical fonts             ' + ((fontStore && Array.isArray(fontStore.fonts))
            ? fontStore.fonts.length : 0));
        lines.push('  Navigation sources         ' + (transitions ? Object.keys(transitions).length : 0));
        lines.push('  Median FCP                 ' + fcpText);
        lines.push('');
        lines.push('ENVIRONMENT');
        lines.push('  Connection                 ' + tierName(tier) + ' — ' + netText);
        lines.push('  Storage                    ' + (gmSync ? 'GM_* (synchronous)'
            : gmAsync ? 'GM.* (asynchronous)' : 'localStorage — readable by this page'));
        lines.push('  fetchpriority              ' + (supportsFetchPriority ? 'yes' : 'no'));
        lines.push('  imagesrcset preload        ' + (supportsImageSrcset ? 'yes' : 'no'));
        lines.push('  content-visibility         ' + (supportsContentVisibility ? 'yes' : 'no'));

        return lines.join('\n');
    }

    function initCommands() {
        registerCommand('Status', () => showPanel(statusReport()));

        registerCommand('Forget this site', () => {
            for (const key of ORIGIN_KEYS) deleteStore(key);
            learnedLcpUrl = null;
            emittedPreloadFor = null;
            predictedTargets = [];
            preWarmedHero = null;
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
                + 'edge, or if sticky headers or in-page anchors misbehave.'
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

        safely(() => applyLearnedHints());
        safely(initLearning);
        safely(initTransitionLearning);
        safely(initDocumentWarming);
        safely(initMediaPriority);
        safely(initCommands);

        runWhenLoadedIdle(() => {
            safely(recordNetSample);
            safely(persistOrigins);
            safely(persistFonts);
        });
        runWhenLoadedIdle(() => safely(initContentVisibility));
    }).catch(() => {});
})();
