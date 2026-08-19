// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  Chrome-only: connection-tiered Speculation Rules prefetch/prerender, learned LCP preload + origin preconnect, media priority hints, and a high-hit-rate LRU static asset cache. Respects Cache-Control, avoids sensitive links/APIs, and degrades gracefully on slow connections.
// @author       You
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.js
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const uaBrands = navigator.userAgentData && navigator.userAgentData.brands;
    const isChromium = (uaBrands && uaBrands.some(b => /Chromium|Google Chrome/i.test(b.brand)))
        || /Chrome\//.test(navigator.userAgent);
    if (!isChromium) return;

    // =========================================================================
    // Shared helpers
    // =========================================================================

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;

    const conn = navigator.connection;
    const supportsSpeculationRules = Boolean(HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'));

    // The Prioritized Task Scheduling API exposes `scheduler` as a Window
    // global, not on navigator (navigator.scheduling is a different API with
    // isInputPending), so the previous navigator.scheduler probe never matched
    // and every caller silently fell through to requestIdleCallback.
    const taskScheduler = (window.scheduler && typeof window.scheduler.postTask === 'function')
        ? window.scheduler
        : null;

    // Bandwidth is zero-sum on a constrained link: every speculative byte we
    // spend is a byte the current page does not get. A single slow/not-slow
    // flag is too coarse for that trade-off, so features below read a tier.
    // Always call getConnectionTier() rather than caching it — effectiveType
    // changes as the radio state changes mid-page.
    const TIER_SLOW = 1;
    const TIER_MODERATE = 2;
    const TIER_FAST = 3;

    function getConnectionTier() {
        if (!conn) return TIER_FAST;
        if (conn.saveData) return TIER_SLOW;

        switch (conn.effectiveType) {
            case 'slow-2g':
            case '2g': return TIER_SLOW;
            case '3g': return TIER_MODERATE;
        }

        // effectiveType buckets coarsely and rounds up; rtt/downlink catch a
        // '4g' label sitting on a congested or high-latency link.
        if (Number.isFinite(conn.rtt) && conn.rtt > 0) {
            if (conn.rtt >= 600) return TIER_SLOW;
            if (conn.rtt >= 270) return TIER_MODERATE;
        }
        if (Number.isFinite(conn.downlink) && conn.downlink > 0 && conn.downlink < 0.7) return TIER_SLOW;

        return TIER_FAST;
    }

    function isSlowOrMeteredConnection() {
        return getConnectionTier() === TIER_SLOW;
    }

    function postBackgroundTask(fn, timeout) {
        const deadline = Number.isFinite(timeout) ? timeout : 3000;
        let ran = false;

        const run = () => {
            if (ran) return;
            ran = true;
            fn();
        };

        if (taskScheduler) {
            try {
                // postTask rejects if the task is aborted; nothing here passes a
                // signal, but an unhandled rejection would still surface.
                const task = taskScheduler.postTask(run, { priority: 'background' });
                if (task && typeof task.catch === 'function') task.catch(() => {});
                // Unlike requestIdleCallback's timeout, 'background' priority
                // carries no deadline at all — a busy page can starve it for as
                // long as it stays busy. Everything queued here is optional but
                // not indefinitely postponable (speculation rules, quota
                // pruning), so keep the guarantee the idle path always had.
                setTimeout(run, deadline);
                return;
            } catch (_) {}
        }

        if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: deadline });
        else setTimeout(run, Math.min(deadline, 750));
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

    // =========================================================================
    // Part 1: optimistic static asset cache
    // =========================================================================

    const CACHE_NAME = 'tm-smart-lru-v3';
    const MAX_ITEMS = 2000;
    const PRUNE_CHUNK = 100;
    const METADATA_KEY = 'tm-cache-lru-metadata';
    const STATS_KEY = 'tm-cache-stats';
    const FLUSH_DELAY = 2500;
    const TOUCH_WRITE_MIN_MS = 45 * SECOND;
    const WRITE_MAINTENANCE_INTERVAL = 25;
    const HEURISTIC_MAX_TTL = 24 * HOUR;

    // Revalidation costs a round trip, which is exactly what hurts on a bad
    // link, so stale-tolerance scales with how expensive the network is.
    // (Every branch of the previous switch returned the same 2h constant.)
    function getRevalidateTTL() {
        switch (getConnectionTier()) {
            case TIER_SLOW: return 12 * HOUR;
            case TIER_MODERATE: return 6 * HOUR;
            default: return 2 * HOUR;
        }
    }

    const CACHEABLE_EXTENSIONS = /\.(?:js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp|wasm)(?:[?#]|$)/i;
    // webpack/vite/parcel-style fingerprinted assets: app.deadbeef.js, chunk-a1b2c3d4e5.css
    const FINGERPRINT_ASSET = /(?:^|\/)[^/?#]*?(?:[._-][a-f0-9]{8,}|[a-f0-9]{8,})[^/?#]*\.(?:js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp|wasm)(?:[?#]|$)/i;
    const DOWNLOAD_EXTENSIONS = [
        '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
    ];
    const DOWNLOAD_REGEX = new RegExp('\\.(?:' + DOWNLOAD_EXTENSIONS.map(ext => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[?#]|$)', 'i');

    const SENSITIVE_PATH_SEGMENTS = 'logout|signout|log-out|sign-out|checkout|cart|account|admin|orders?|payments?|delete|auth|login|signin|sign-in|session|destroy|revoke|unsubscribe|remove|transfer';
    const SENSITIVE_PATH_PATTERNS = [
        '/logout*', '/signout*', '/log-out*', '/sign-out*',
        '/checkout*', '/cart*', '/account*', '/admin*',
        '/order*', '/orders*', '/payment*', '/payments*',
        '/delete*', '/auth*', '/login*', '/signin*', '/sign-in*',
        '/session*', '/destroy*', '/revoke*', '/unsubscribe*',
        '/remove*', '/transfer*'
    ];
    const SENSITIVE_HREF_REGEX = new RegExp(
        '\\/(?:' + SENSITIVE_PATH_SEGMENTS + ')(?:[\\/?#-]|$)',
        'i'
    );

    const SKIP_URL_PATTERNS = [
        /\/api(?:\/|$)/i,
        /\/graphql(?:[/?#]|$)/i,
        /\/(?:feed|rss|json|ws)(?:\/|[?#]|$)/i,
        /\.(?:json|html?|xml|m3u8|mpd)(?:[?#]|$)/i,
        /\bservice-worker\b/i,
        /\bmanifest\b.*\.js(?:[?#]|$)/i
    ];

    const NO_STORE = /\bno-store\b/i;
    const PRIVATE = /\bprivate\b/i;
    const FORCE_REVALIDATE = /\b(?:no-cache|must-revalidate)\b/i;
    const IMMUTABLE = /\bimmutable\b/i;
    const CACHEABLE_CONTENT_TYPES = /^(?:text\/css|text\/javascript|application\/javascript|application\/x-javascript|image\/|font\/|application\/font|application\/x-font|application\/wasm)/i;

    let metadataMap = new Map();
    let metadataDirty = false;
    let flushTimer = null;
    let cacheWritesSinceMaintenance = 0;

    // Hit/miss/bypass counters persisted across page loads. In-memory counters
    // alone always read ~0 because they reset on every navigation and the cache
    // only ever sees window.fetch() traffic (a small slice of page loads).
    function loadStats() {
        try {
            const raw = localStorage.getItem(STATS_KEY);
            if (raw) {
                const obj = JSON.parse(raw);
                return {
                    hits: Number(obj.hits) || 0,
                    misses: Number(obj.misses) || 0,
                    bypassed: Number(obj.bypassed) || 0,
                    revalidations: Number(obj.revalidations) || 0
                };
            }
        } catch (_) {}
        return { hits: 0, misses: 0, bypassed: 0, revalidations: 0 };
    }

    const stats = loadStats();
    let statsTimer = null;

    function saveStats() {
        if (statsTimer) {
            clearTimeout(statsTimer);
            statsTimer = null;
        }
        try {
            localStorage.setItem(STATS_KEY, JSON.stringify(stats));
        } catch (_) {}
    }

    function scheduleStatsSave() {
        if (statsTimer) return;
        statsTimer = setTimeout(saveStats, FLUSH_DELAY);
    }

    function normalizeMetadata(value) {
        if (value && typeof value === 'object') {
            const ttlMs = value.ttlMs === Infinity || value.ttlMs === 'Infinity'
                ? Infinity
                : (Number.isFinite(value.ttlMs) ? value.ttlMs : null);

            return {
                touchedAt: Number(value.touchedAt || value.cachedAt || 0),
                cachedAt: Number(value.cachedAt || value.touchedAt || 0),
                ttlMs,
                forceRevalidate: Boolean(value.forceRevalidate)
            };
        }

        const timestamp = Number(value || 0);
        return {
            touchedAt: timestamp,
            cachedAt: timestamp,
            ttlMs: null,
            forceRevalidate: false
        };
    }

    function loadMetadata() {
        try {
            const raw = localStorage.getItem(METADATA_KEY);
            if (!raw) return;

            const entries = Object.entries(JSON.parse(raw))
                .map(([url, meta]) => [url, normalizeMetadata(meta)])
                .sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0))
                .slice(0, MAX_ITEMS + PRUNE_CHUNK);

            metadataMap = new Map(entries);
        } catch (_) {}
    }
    loadMetadata();

    const forceRevalidateUrls = new Set();
    for (const [url, meta] of metadataMap) {
        if (meta.forceRevalidate) forceRevalidateUrls.add(url);
    }

    function scheduleFlush() {
        metadataDirty = true;
        if (flushTimer) return;
        flushTimer = setTimeout(flushMetadata, FLUSH_DELAY);
    }

    function flushMetadata() {
        flushTimer = null;
        if (!metadataDirty) return;
        metadataDirty = false;

        try {
            const entries = Array.from(metadataMap)
                .sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0))
                .slice(0, MAX_ITEMS + PRUNE_CHUNK);

            const obj = Object.fromEntries(entries.map(([url, meta]) => [url, {
                touchedAt: meta.touchedAt || 0,
                cachedAt: meta.cachedAt || 0,
                ttlMs: meta.ttlMs === Infinity ? 'Infinity' : meta.ttlMs,
                forceRevalidate: Boolean(meta.forceRevalidate)
            }]));

            localStorage.setItem(METADATA_KEY, JSON.stringify(obj));
        } catch (_) {
            metadataDirty = true;
        }
    }

    function getMetadata(url) {
        return metadataMap.get(url) || normalizeMetadata(0);
    }

    function rememberCacheability(url, cacheability) {
        if (cacheability.forceRevalidate) forceRevalidateUrls.add(url);
        else forceRevalidateUrls.delete(url);
    }

    function touchItem(url, cacheability) {
        const previous = getMetadata(url);
        const touchedAt = Date.now();
        const next = {
            touchedAt,
            cachedAt: previous.cachedAt,
            ttlMs: previous.ttlMs,
            forceRevalidate: previous.forceRevalidate
        };

        let shouldPersist = !previous.touchedAt || touchedAt - previous.touchedAt >= TOUCH_WRITE_MIN_MS;

        if (cacheability) {
            next.cachedAt = touchedAt;
            next.ttlMs = cacheability.ttlMs;
            next.forceRevalidate = cacheability.forceRevalidate;
            rememberCacheability(url, cacheability);
            shouldPersist = true;
        }

        metadataMap.set(url, next);
        // A throttled touch still changed in-memory LRU state. Mark it dirty so
        // pagehide persists it even when we deliberately avoid scheduling a
        // localStorage write for every cache hit.
        metadataDirty = true;
        if (shouldPersist) scheduleFlush();
    }

    function isFresh(url) {
        const meta = getMetadata(url);
        if (forceRevalidateUrls.has(url) || meta.forceRevalidate || !meta.cachedAt) return false;

        // Offline: treat any stored copy as fresh. Revalidating would spend a
        // guaranteed-failing round trip before falling back to this same copy.
        if (navigator.onLine === false) return true;

        const ttlMs = meta.ttlMs === Infinity
            ? Infinity
            : (Number.isFinite(meta.ttlMs) && meta.ttlMs !== null ? meta.ttlMs : getRevalidateTTL());

        return ttlMs === Infinity || Date.now() - meta.cachedAt < ttlMs;
    }

    function requiresSynchronousRevalidation(url) {
        return forceRevalidateUrls.has(url) || getMetadata(url).forceRevalidate;
    }

    function evictEntry(cache, cacheRequest, url) {
        metadataMap.delete(url);
        forceRevalidateUrls.delete(url);
        scheduleFlush();
        return cache.delete(cacheRequest).catch(() => {});
    }

    // MAX_ITEMS bounds entry count, not bytes. An image-heavy origin can hit
    // the storage quota well under 2000 entries, and once quota is exhausted
    // every cache.put() throws — including the browser's own eviction-sensitive
    // storage. Back off before that happens.
    const STORAGE_CHECK_INTERVAL = 5 * MINUTE;
    const STORAGE_PRESSURE_RATIO = 0.8;
    let storagePressure = false;
    let storageCheckedAt = 0;

    async function underStoragePressure() {
        if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return false;

        const now = Date.now();
        if (storageCheckedAt && now - storageCheckedAt < STORAGE_CHECK_INTERVAL) return storagePressure;
        storageCheckedAt = now;

        try {
            const estimate = await navigator.storage.estimate();
            const quota = Number(estimate && estimate.quota) || 0;
            const usage = Number(estimate && estimate.usage) || 0;
            storagePressure = quota > 0 && usage / quota > STORAGE_PRESSURE_RATIO;
        } catch (_) {
            storagePressure = false;
        }

        return storagePressure;
    }

    function triggerMaintenance(targetMax) {
        const limit = Number.isFinite(targetMax) ? targetMax : MAX_ITEMS;
        // requestIdleCallback invokes its callback with an IdleDeadline, so the
        // limit has to be bound here rather than passed through.
        postBackgroundTask(() => pruneCache(limit), 5000);
    }

    async function pruneCache(targetMax) {
        const limit = Number.isFinite(targetMax) ? targetMax : MAX_ITEMS;

        try {
            const cache = await caches.open(CACHE_NAME);
            const keys = await cache.keys();
            if (keys.length <= limit) return;

            const toDelete = keys
                .sort((a, b) => (getMetadata(a.url).touchedAt || 0) - (getMetadata(b.url).touchedAt || 0))
                .slice(0, Math.max(PRUNE_CHUNK, keys.length - limit));

            await Promise.all(toDelete.map(req => {
                metadataMap.delete(req.url);
                forceRevalidateUrls.delete(req.url);
                return cache.delete(req);
            }));
            scheduleFlush();
        } catch (_) {}
    }

    function isCacheableUrl(url) {
        return CACHEABLE_EXTENSIONS.test(url) && !SKIP_URL_PATTERNS.some(re => re.test(url));
    }

    function isFingerprintedAsset(url) {
        try {
            return FINGERPRINT_ASSET.test(new URL(url, location.href).pathname);
        } catch (_) {
            return FINGERPRINT_ASSET.test(url);
        }
    }

    function isSameOriginUrl(url) {
        try {
            return new URL(url, location.href).origin === location.origin;
        } catch (_) {
            return false;
        }
    }

    function parseCacheTTL(response, cc, allowHeuristic) {
        if (IMMUTABLE.test(cc)) return Infinity;

        const maxAge = cc.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
        if (maxAge) return Number(maxAge[1]) * SECOND;

        const expires = response.headers.get('Expires');
        if (expires) {
            const expiresAt = Date.parse(expires);
            if (!Number.isNaN(expiresAt)) {
                const dateAt = Date.parse(response.headers.get('Date') || '') || Date.now();
                return Math.max(0, expiresAt - dateAt);
            }
        }

        if (!allowHeuristic) return null;

        // Heuristic freshness (RFC 7234 §4.2.2): cache for a fraction of the time
        // since the asset last changed, capped. Lets us cache header-less assets
        // the browser's HTTP cache would otherwise treat as always-stale.
        const lastModified = response.headers.get('Last-Modified');
        if (lastModified) {
            const lastModifiedAt = Date.parse(lastModified);
            if (!Number.isNaN(lastModifiedAt)) {
                const dateAt = Date.parse(response.headers.get('Date') || '') || Date.now();
                const heuristic = (dateAt - lastModifiedAt) * 0.1;
                if (heuristic > 0) return Math.min(heuristic, HEURISTIC_MAX_TTL);
            }
        }

        return null;
    }

    // Caveat on both checks below: Set-Cookie is a forbidden response header
    // (never visible to JS in any browser), and Vary is not CORS-safelisted, so
    // on cross-origin responses headers.get('Vary') returns null even when the
    // server sent it. Heuristic/fingerprint TTLs require same-origin or a
    // readable Cache-Control so we do not invent freshness for CORS-opaque
    // private assets.
    function getCacheability(response, requestUrl) {
        if (!response || !response.ok || response.status === 206) return false;

        const ccHeader = response.headers.get('Cache-Control');
        const cc = ccHeader || '';
        if (NO_STORE.test(cc) || PRIVATE.test(cc)) return false;

        const vary = response.headers.get('Vary') || '';
        if (vary.trim()) return false;

        const ct = response.headers.get('Content-Type') || '';
        if (ct && !CACHEABLE_CONTENT_TYPES.test(ct)) return false;

        const url = requestUrl || response.url || '';
        const sameOrigin = isSameOriginUrl(url);
        const ccReadable = ccHeader !== null;
        const allowHeuristic = sameOrigin || ccReadable;

        // no-cache / must-revalidate assets are storable, but must be revalidated
        // before every reuse (network-first, stale only as offline fallback).
        const forceRevalidate = FORCE_REVALIDATE.test(cc);
        let ttlMs = parseCacheTTL(response, cc, allowHeuristic);

        if (
            ttlMs !== Infinity
            && !forceRevalidate
            && allowHeuristic
            && isFingerprintedAsset(url)
            && (sameOrigin || ccReadable)
        ) {
            // Content-hashed filenames are effectively immutable even without
            // Cache-Control: immutable.
            ttlMs = Infinity;
        }

        // TTL is irrelevant for force-revalidate entries (they always hit the
        // network first), so only reject on a bad TTL for normal entries.
        if (!forceRevalidate && ttlMs !== Infinity && (!Number.isFinite(ttlMs) || ttlMs <= 0)) return false;

        return {
            ttlMs,
            forceRevalidate
        };
    }

    function isReusableCachedResponse(response) {
        if (!response || !response.ok || response.status === 206) return false;

        const cc = response.headers.get('Cache-Control') || '';
        if (NO_STORE.test(cc) || PRIVATE.test(cc)) return false;

        const vary = response.headers.get('Vary') || '';
        if (vary.trim()) return false;

        // Stored no-cache/must-revalidate copies stay reusable as the stale
        // fallback that SWR serves while a revalidation is in flight.
        if (FORCE_REVALIDATE.test(cc)) return true;

        if (isFingerprintedAsset(response.url || '')) return true;

        const ttlMs = parseCacheTTL(response, cc, true);
        return ttlMs === Infinity || (Number.isFinite(ttlMs) && ttlMs > 0);
    }

    // Requests carrying any of these need the real network semantics: Range
    // expects a 206 slice and the conditional headers expect a possible 304 —
    // serving a full cached 200 would break both.
    const BYPASS_REQUEST_HEADERS = ['authorization', 'range', 'if-none-match', 'if-modified-since'];

    function hasBypassHeader(headers) {
        if (!headers) return false;

        try {
            if (typeof headers.get === 'function') {
                return BYPASS_REQUEST_HEADERS.some(name => Boolean(headers.get(name)));
            }
            if (Array.isArray(headers)) {
                return headers.some(([key, value]) =>
                    BYPASS_REQUEST_HEADERS.includes(String(key).toLowerCase()) && Boolean(value));
            }
            if (typeof headers === 'object') {
                return Object.keys(headers).some(key => BYPASS_REQUEST_HEADERS.includes(key.toLowerCase()) && headers[key]);
            }
        } catch (_) {}

        return false;
    }

    function replaceSignalInArgs(args, signal) {
        const request = args[0];
        // Supplying the key is required — omitting it lets new Request(input)
        // copy input.signal. Background revalidation passes null; shared
        // network flights pass their own controller signal.
        const init = Object.assign({}, args[1] || {}, { signal });

        if (request && typeof request === 'object' && 'url' in request && 'method' in request) {
            try {
                return [new Request(request, init)];
            } catch (_) {
                return [request.url, Object.assign({
                    method: request.method,
                    headers: request.headers,
                    credentials: request.credentials,
                    mode: request.mode,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy
                }, init)];
            }
        }

        return [request, init];
    }

    function stripSignalFromArgs(args) {
        return replaceSignalInArgs(args, null);
    }

    let fetchCachePromise = null;

    function installFetchCache() {
        // typeof caches guard: the Cache API only exists in secure contexts, so
        // on plain-HTTP pages the wrapper would fail (and fall back) per fetch.
        const hasServiceWorker = 'serviceWorker' in navigator;
        if ((hasServiceWorker && navigator.serviceWorker.controller) || typeof unsafeWindow === 'undefined' || typeof caches === 'undefined') return;

        const originalFetch = unsafeWindow.fetch;
        if (typeof originalFetch !== 'function') return;

        const inFlightRevalidations = new Map();
        const inFlightNetwork = new Map();

        const getCache = () => {
            if (!fetchCachePromise) {
                fetchCachePromise = caches.open(CACHE_NAME).catch(error => {
                    fetchCachePromise = null;
                    throw error;
                });
            }
            return fetchCachePromise;
        };

        const isRequestLike = obj => obj && typeof obj === 'object' && 'url' in obj && 'method' in obj;

        function getFetchInfo(args) {
            const request = args[0];
            if (request == null) return null;

            const init = args[1] || {};
            const requestLike = isRequestLike(request);
            const url = requestLike ? toUrl(request.url) : toUrl(request);

            if (!url) return null;

            const headers = init.headers || (requestLike ? request.headers : undefined);
            const credentials = init.credentials || (requestLike ? request.credentials : undefined);
            const mode = init.mode || (requestLike ? request.mode : undefined);
            const redirect = init.redirect || (requestLike ? request.redirect : undefined);
            const referrer = init.referrer || (requestLike ? request.referrer : undefined);
            const referrerPolicy = init.referrerPolicy || (requestLike ? request.referrerPolicy : undefined);
            const integrity = init.integrity || (requestLike ? request.integrity : undefined);
            const keepalive = Object.prototype.hasOwnProperty.call(init, 'keepalive')
                ? init.keepalive
                : (requestLike ? request.keepalive : undefined);
            const signal = Object.prototype.hasOwnProperty.call(init, 'signal')
                ? init.signal
                : (requestLike ? request.signal : undefined);

            return {
                url: url.href,
                method: String(init.method || (requestLike ? request.method : '') || 'GET').toUpperCase(),
                cacheMode: init.cache || (requestLike ? request.cache : undefined),
                signal,
                headers,
                credentials,
                mode,
                redirect,
                referrer,
                referrerPolicy,
                integrity,
                keepalive,
                cacheRequest: makeCacheRequest(url.href, { headers, credentials, mode, redirect, referrer, referrerPolicy })
            };
        }

        function makeNetworkKey(info) {
            let headers;
            try {
                headers = Array.from(new Headers(info.headers || undefined).entries())
                    .sort(([aKey, aValue], [bKey, bValue]) => {
                        const keyOrder = aKey.localeCompare(bKey);
                        return keyOrder || aValue.localeCompare(bValue);
                    });
            } catch (_) {
                // If the headers cannot be normalized, do not risk sharing the
                // request with a semantically different caller.
                return null;
            }

            return JSON.stringify([
                info.url,
                info.credentials || '',
                info.mode || '',
                info.redirect || '',
                info.referrer || '',
                info.referrerPolicy || '',
                info.integrity || '',
                Boolean(info.keepalive),
                headers
            ]);
        }

        function makeCacheRequest(url, source) {
            if (typeof Request !== 'function') return url;

            const init = { method: 'GET' };

            if (source.headers) init.headers = source.headers;
            if (source.credentials) init.credentials = source.credentials;
            if (source.mode) init.mode = source.mode;
            if (source.redirect) init.redirect = source.redirect;
            if (source.referrer) init.referrer = source.referrer;
            if (source.referrerPolicy) init.referrerPolicy = source.referrerPolicy;

            try {
                return new Request(url, init);
            } catch (_) {
                return new Request(url, { method: 'GET' });
            }
        }

        function maybeScheduleMaintenance() {
            cacheWritesSinceMaintenance += 1;
            if (cacheWritesSinceMaintenance >= WRITE_MAINTENANCE_INTERVAL) {
                cacheWritesSinceMaintenance = 0;
                triggerMaintenance();
            }
        }

        async function storeResponse(cache, info, networkResponse, cacheability) {
            const finalUrl = networkResponse.url || info.url;
            if (networkResponse.redirected && finalUrl && finalUrl !== info.url) {
                if (!isCacheableUrl(finalUrl)) {
                    await evictEntry(cache, info.cacheRequest, info.url);
                    return;
                }
            }

            if (await underStoragePressure()) {
                // Prune hard rather than storing more: half the entry budget is
                // a blunt but effective way to release quota before the browser
                // starts evicting on our behalf.
                triggerMaintenance(Math.floor(MAX_ITEMS / 2));
                return;
            }

            try {
                // Cache under the URL the caller will request again. A cached
                // Response may retain its final redirected URL; Cache API keys
                // do not need to match response.url.
                await cache.put(info.cacheRequest, networkResponse.clone());
                touchItem(info.url, cacheability);
                maybeScheduleMaintenance();
            } catch (_) {
                // Redirected / opaque / quota failures: skip store.
            }
        }

        function waitForNetworkFlight(flight, signal) {
            flight.waiters += 1;

            return new Promise((resolve, reject) => {
                let callerSettled = false;

                const release = (aborted, reason) => {
                    if (callerSettled) return;
                    callerSettled = true;
                    if (signal) signal.removeEventListener('abort', onAbort);
                    flight.waiters = Math.max(0, flight.waiters - 1);

                    if (aborted && flight.waiters === 0 && !flight.settled) {
                        // Remove immediately so a new caller does not join a
                        // flight whose shared controller is already aborted.
                        if (inFlightNetwork.get(flight.key) === flight) {
                            inFlightNetwork.delete(flight.key);
                        }
                        flight.controller.abort(reason);
                    }
                };

                const onAbort = () => {
                    const reason = getAbortReason(signal);
                    release(true, reason);
                    reject(reason);
                };

                if (signal && signal.aborted) {
                    onAbort();
                    return;
                }

                if (signal) signal.addEventListener('abort', onAbort, { once: true });
                flight.promise.then(response => {
                    release(false);
                    resolve(response.clone());
                }, error => {
                    release(false);
                    reject(error);
                });
            });
        }

        // Callers with semantically identical requests share one controller.
        // One abort only releases that caller; all callers aborting cancels the
        // underlying request and lets a later caller create a fresh flight.
        function coalesceNetwork(thisArg, args, info) {
            const networkKey = makeNetworkKey(info);
            if (!networkKey) {
                return originalFetch.apply(thisArg, args);
            }

            let flight = inFlightNetwork.get(networkKey);
            if (!flight) {
                const controller = new AbortController();
                flight = {
                    key: networkKey,
                    controller,
                    waiters: 0,
                    settled: false,
                    promise: null
                };

                flight.promise = originalFetch.apply(
                    thisArg,
                    replaceSignalInArgs(args, controller.signal)
                ).finally(() => {
                    flight.settled = true;
                    if (inFlightNetwork.get(networkKey) === flight) {
                        inFlightNetwork.delete(networkKey);
                    }
                });

                inFlightNetwork.set(networkKey, flight);
            }

            return waitForNetworkFlight(flight, info.signal);
        }

        function getAbortReason(signal) {
            if (signal && 'reason' in signal && signal.reason !== undefined) {
                return signal.reason;
            }
            if (typeof DOMException === 'function') {
                return new DOMException('Aborted', 'AbortError');
            }
            const err = new Error('Aborted');
            err.name = 'AbortError';
            return err;
        }

        function throwIfAborted(signal) {
            if (!signal || !signal.aborted) return;
            throw getAbortReason(signal);
        }

        async function revalidate(cache, info, thisArg, args) {
            try {
                const networkResponse = await originalFetch.apply(thisArg, stripSignalFromArgs(args));
                const cacheability = getCacheability(networkResponse, networkResponse.url || info.url);
                if (!cacheability) {
                    // The server answered but no longer vouches for this asset
                    // (gone, error, or uncacheable now). Without eviction the
                    // stale copy would be served via SWR forever.
                    await evictEntry(cache, info.cacheRequest, info.url);
                    return;
                }

                await storeResponse(cache, info, networkResponse, cacheability);
                stats.revalidations += 1;
                scheduleStatsSave();
            } catch (_) {
                // Network failure: stale cache is still better than nothing.
            } finally {
                inFlightRevalidations.delete(info.url);
            }
        }

        unsafeWindow.fetch = async function (...args) {
            const info = getFetchInfo(args);
            const bypass = !info
                || info.method !== 'GET'
                || !isCacheableUrl(info.url)
                // Preserve native semantics for every explicit non-default
                // Request.cache mode, especially force-cache/only-if-cached.
                || (info.cacheMode && info.cacheMode !== 'default')
                || hasBypassHeader(info.headers);

            if (bypass) {
                if (info && info.method === 'GET' && CACHEABLE_EXTENSIONS.test(info.url)) {
                    stats.bypassed += 1;
                    scheduleStatsSave();
                }
                return originalFetch.apply(this, args);
            }

            throwIfAborted(info.signal);

            // Failures of our own cache machinery fall back to a plain fetch,
            // but once the real network request has been issued its outcome
            // (including AbortError) must propagate as-is — retrying here would
            // fire the same request twice.
            let networkAttempted = false;
            try {
                const cache = await getCache();
                let cachedResponse = await cache.match(info.cacheRequest);

                if (cachedResponse && !isReusableCachedResponse(cachedResponse)) {
                    await evictEntry(cache, info.cacheRequest, info.url);
                    cachedResponse = null;
                }

                if (cachedResponse) {
                    if (isFresh(info.url)) {
                        throwIfAborted(info.signal);
                        stats.hits += 1;
                        scheduleStatsSave();
                        touchItem(info.url);
                        return cachedResponse;
                    }

                    if (requiresSynchronousRevalidation(info.url)) {
                        let networkResponse;
                        try {
                            networkAttempted = true;
                            networkResponse = await coalesceNetwork(this, args, info);
                            throwIfAborted(info.signal);
                        } catch (error) {
                            // The page cancelled the request; honor abort semantics.
                            // abort(customReason) / AbortSignal.timeout() reject
                            // with arbitrary reasons, so consult the signal too.
                            if ((info.signal && info.signal.aborted) || (error && error.name === 'AbortError')) throw error;
                            // Revalidation failed (offline/error): the stale copy
                            // beats surfacing a network failure to the page.
                            return cachedResponse;
                        }

                        const cacheability = getCacheability(networkResponse, networkResponse.url || info.url);
                        if (cacheability) {
                            storeResponse(cache, info, networkResponse, cacheability).catch(() => {});
                        } else {
                            await evictEntry(cache, info.cacheRequest, info.url);
                        }
                        stats.revalidations += 1;
                        scheduleStatsSave();
                        return networkResponse;
                    }

                    stats.hits += 1;
                    scheduleStatsSave();
                    if (!inFlightRevalidations.has(info.url)) {
                        // The caller already has its bytes. On a constrained
                        // link, issuing the revalidation now would compete with
                        // the page's own critical requests for the same pipe.
                        if (getConnectionTier() === TIER_FAST) {
                            inFlightRevalidations.set(info.url, revalidate(cache, info, this, args));
                        } else {
                            // Placeholder keeps a second hit from queueing a
                            // duplicate before the deferred task runs.
                            inFlightRevalidations.set(info.url, null);
                            postBackgroundTask(() => {
                                inFlightRevalidations.set(info.url, revalidate(cache, info, this, args));
                            }, 5000);
                        }
                    }

                    throwIfAborted(info.signal);
                    return cachedResponse;
                }

                stats.misses += 1;
                scheduleStatsSave();
                networkAttempted = true;
                const networkResponse = await coalesceNetwork(this, args, info);
                throwIfAborted(info.signal);
                const cacheability = getCacheability(networkResponse, networkResponse.url || info.url);

                if (cacheability) {
                    storeResponse(cache, info, networkResponse, cacheability).catch(() => {});
                }

                return networkResponse;
            } catch (error) {
                if (networkAttempted) throw error;
                return originalFetch.apply(this, args);
            }
        };

        if (hasServiceWorker) {
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                unsafeWindow.fetch = originalFetch;
                fetchCachePromise = null;
                inFlightNetwork.clear();
                inFlightRevalidations.clear();
            }, { once: true });
        }
    }

    installFetchCache();

    const IDLE_WARM_LIMIT = 40;

    function initIdleCacheWarm() {
        // Warming re-fetches assets the parser already loaded, purely to copy
        // them into the Cache API. That is a reasonable trade on an idle fast
        // link and a bad one on anything slower.
        if (typeof caches === 'undefined' || getConnectionTier() !== TIER_FAST) return;
        if (typeof unsafeWindow === 'undefined' || typeof unsafeWindow.fetch !== 'function') return;

        const urls = new Set();
        for (const el of document.querySelectorAll('script[src], link[rel~="stylesheet"][href]')) {
            const href = el.currentSrc || el.src || el.href;
            const url = toUrl(href);
            if (!url) continue;
            if (url.origin !== location.origin) continue;
            if (!isCacheableUrl(url.href)) continue;
            urls.add(url.href);
            if (urls.size >= IDLE_WARM_LIMIT) break;
        }

        let chain = Promise.resolve();
        for (const href of urls) {
            chain = chain.then(() => unsafeWindow.fetch(href, {
                credentials: 'same-origin',
                mode: 'same-origin',
                // Prefer our LRU when fresh; otherwise populate via miss path.
                cache: 'default'
            }).catch(() => {}));
        }
    }

    runWhenLoadedIdle(initIdleCacheWarm);

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Purge Asset Cache (Current Origin)', async () => {
            try {
                await caches.delete(CACHE_NAME);
            } catch (_) {}
            fetchCachePromise = null;
            metadataMap.clear();
            forceRevalidateUrls.clear();
            metadataDirty = false;
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }

            try {
                localStorage.removeItem(METADATA_KEY);
            } catch (_) {}

            stats.hits = 0;
            stats.misses = 0;
            stats.bypassed = 0;
            stats.revalidations = 0;
            if (statsTimer) {
                clearTimeout(statsTimer);
                statsTimer = null;
            }
            try {
                localStorage.removeItem(STATS_KEY);
                localStorage.removeItem(LEARN_LCP_KEY);
                localStorage.removeItem(LEARN_ORIGINS_KEY);
                localStorage.removeItem(LEARN_VITALS_KEY);
            } catch (_) {}
            learnedLcpUrl = null;
            alert('Quicksilver asset cache and learned hints purged for this origin.');
        });

        GM_registerMenuCommand('Toggle Aggressive Rendering (content-visibility)', () => {
            const next = contentVisibilityEnabled() ? '0' : '1';
            try {
                localStorage.setItem(CV_FLAG_KEY, next);
            } catch (_) {}
            alert('Aggressive rendering ' + (next === '1' ? 'enabled' : 'disabled')
                + ' for this origin. Reload to apply.\n\nSkips layout/paint for offscreen '
                + 'sections. Disable if sticky headers or in-page anchors misbehave.');
        });

        GM_registerMenuCommand('Show Cache Stats', async () => {
            let itemCount = 0;
            let estimatedSize = 0;

            try {
                const cache = await caches.open(CACHE_NAME);
                const keys = await cache.keys();
                itemCount = keys.length;

                const sample = keys.slice(0, 20);
                const sampleSizes = await Promise.all(sample.map(async req => {
                    const res = await cache.match(req);
                    return res ? (await res.blob()).size : 0;
                }));
                const sampleSize = sampleSizes.reduce((sum, size) => sum + size, 0);
                estimatedSize = sample.length ? sampleSize / sample.length * itemCount : 0;
            } catch (_) {}

            const total = stats.hits + stats.misses;
            const hitRate = total ? (stats.hits / total * 100).toFixed(1) : 'N/A';

            // Cache hit rate measures the machinery; LCP measures whether any
            // of this actually made the page faster.
            const vitals = readStore(LEARN_VITALS_KEY);
            const samples = (vitals && Array.isArray(vitals.lcp) ? vitals.lcp : []).filter(Number.isFinite);
            let lcpStr = 'no samples yet';
            if (samples.length) {
                const sorted = samples.slice().sort((a, b) => a - b);
                const median = sorted[Math.floor(sorted.length / 2)];
                lcpStr = Math.round(median) + ' ms (median of ' + sorted.length + ')';
            }

            const tierName = { 1: 'slow', 2: 'moderate', 3: 'fast' }[getConnectionTier()] || 'unknown';
            const lcpStore = readStore(LEARN_LCP_KEY);
            const learnedPages = lcpStore ? Object.keys(lcpStore).length : 0;
            const originStore = readStore(LEARN_ORIGINS_KEY);
            const learnedOrigins = (originStore && Array.isArray(originStore.origins)) ? originStore.origins.length : 0;
            const sizeStr = estimatedSize > 1048576
                ? (estimatedSize / 1048576).toFixed(1) + ' MB'
                : Math.round(estimatedSize / 1024) + ' KB';

            alert([
                'Quicksilver Cache Stats (cumulative, this origin)',
                'Cached items: ' + itemCount,
                'Estimated size: ' + sizeStr,
                'Hits: ' + stats.hits + ' | Misses: ' + stats.misses,
                'Revalidations: ' + stats.revalidations,
                'Hit rate: ' + hitRate + '% (of ' + total + ' cacheable fetches)',
                'Not cached: ' + stats.bypassed + ' asset-like fetches (reload/auth/skip policy)',
                '',
                'LCP: ' + lcpStr,
                'Learned: ' + learnedPages + ' page(s), ' + learnedOrigins + ' origin(s)',
                'Preloading LCP here: ' + (learnedLcpUrl ? 'yes' : 'no'),
                'Tier: ' + tierName + ' (' + (conn && conn.effectiveType || 'unknown') + ')',
                'TTL: ' + Math.round(getRevalidateTTL() / MINUTE) + ' min'
            ].join('\n'));
        });
    }

    window.addEventListener('pagehide', () => {
        flushMetadata();
        saveStats();
    });

    // =========================================================================
    // Part 2: Speculation Rules prefetch/prerender (Chrome, aggressive)
    // =========================================================================

    // Tracking parameters never change the response body, so a prefetch of
    // /post should still satisfy a click on /post?utm_source=x. Without this
    // hint every campaign-tagged link discards its own prefetch.
    const NO_VARY_SEARCH_PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid', 'igshid',
        'mc_cid', 'mc_eid', '_ga', '_gl'
    ];
    const EXPECTS_NO_VARY_SEARCH = 'params=(' + NO_VARY_SEARCH_PARAMS.map(p => '"' + p + '"').join(' ') + ')';

    // Above this many links, blanket-eager prefetch stops being a head start
    // and becomes self-inflicted congestion: Chrome will happily run dozens of
    // prefetches against the same connection the current page is still using.
    const EAGER_PREFETCH_LINK_BUDGET = 40;

    function initSpeculationRules() {
        const tier = getConnectionTier();
        if (!supportsSpeculationRules || tier === TIER_SLOW) return;

        // Path-segment excludes — avoid substring traps like href*='order'→border.
        const excludeSelectors = [
            "a[href^='javascript:']",
            "a[href^='mailto:']",
            "a[href^='tel:']",
            "a[href*='download' i]",
            "a[target]",
            "a[download]",
            "a[rel~='nofollow']",
            "a[rel~='external']",
            ...DOWNLOAD_EXTENSIONS.map(ext => "a[href$='" + ext + "' i]")
        ].join(', ');

        const eligibleLinks = {
            and: [
                { href_matches: '/*' },
                { not: { href_matches: SENSITIVE_PATH_PATTERNS } },
                { not: { selector_matches: excludeSelectors } }
            ]
        };

        let linkCount = 0;
        try {
            linkCount = document.querySelectorAll('a[href]').length;
        } catch (_) {}

        // 'moderate' is hover-triggered: nearly the same perceived win as
        // 'eager' on a link-dense page, at a fraction of the bytes.
        const prefetchEagerness = (tier === TIER_FAST && linkCount <= EAGER_PREFETCH_LINK_BUDGET)
            ? 'eager'
            : 'moderate';

        const rules = {
            prefetch: [{
                where: eligibleLinks,
                eagerness: prefetchEagerness,
                expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
            }]
        };

        // Prerender downloads *and* executes the target page. That is the right
        // trade only when the connection can absorb it; on 3g the same budget
        // is better spent finishing the page the user is actually looking at.
        if (tier === TIER_FAST) {
            rules.prerender = [
                {
                    where: eligibleLinks,
                    eagerness: 'moderate',
                    expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
                },
                // Speculation rules only ever match <a>/<area> elements, so a
                // link[rel=next] selector would be dead; ~= handles multi-token
                // rel values like "next nofollow".
                {
                    where: {
                        and: [
                            { selector_matches: "a[rel~='next']" },
                            { not: { selector_matches: excludeSelectors } },
                            { not: { href_matches: SENSITIVE_PATH_PATTERNS } }
                        ]
                    },
                    eagerness: 'immediate',
                    expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
                }
            ];
        }

        try {
            const script = document.createElement('script');
            script.type = 'speculationrules';
            script.textContent = JSON.stringify(rules);
            (document.head || document.documentElement).appendChild(script);
        } catch (_) {}
    }

    runWhenLoadedIdle(initSpeculationRules);

    // =========================================================================
    // Part 3: preconnect + dns-prefetch on hover/focus
    // =========================================================================

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
            // An anonymous preconnect would warm a connection navigations
            // never use.
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
    }

    runWhenDomReady(initPreconnectOnIntent);

    // =========================================================================
    // Part 4: pointerdown prefetch supplement (Chrome gaps / older builds)
    // =========================================================================

    const POINTERDOWN_MEMO_LIMIT = 100;

    function initPointerdownPrefetch() {
        if (getConnectionTier() === TIER_SLOW) return;

        const speculated = new Set();
        let currentHint = null;
        let currentRuleScript = null;

        function isEligible(link) {
            if (!link || !link.href) return false;

            const url = toUrl(link.href);
            if (!url) return false;
            if (url.origin !== location.origin) return false;
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
            if (url.pathname + url.search === location.pathname + location.search) return false;

            const href = link.getAttribute('href') || '';
            if (DOWNLOAD_REGEX.test(href)) return false;
            if (SENSITIVE_HREF_REGEX.test(url.pathname) || /download/i.test(href)) return false;
            if (link.target || link.download || /\b(?:nofollow|external)\b/i.test(link.rel || '')) return false;

            return true;
        }

        // A URL-scoped speculation rule beats <link rel=prefetch> here: the
        // navigation consults the speculation-rules prefetch cache, and on a
        // fast link prerender hands over an already-rendered page instead of
        // just bytes. Only one is kept alive at a time — Chrome caps concurrent
        // prerenders, and a rule for a link the user moved past is pure cost.
        function speculate(href) {
            const action = getConnectionTier() === TIER_FAST ? 'prerender' : 'prefetch';
            const rules = {};
            rules[action] = [{ urls: [href], eagerness: 'immediate' }];

            const script = document.createElement('script');
            script.type = 'speculationrules';
            script.textContent = JSON.stringify(rules);

            if (currentRuleScript) currentRuleScript.remove();
            (document.head || document.documentElement).appendChild(script);
            currentRuleScript = script;
        }

        function prefetchHint(href) {
            const hint = document.createElement('link');
            hint.rel = 'prefetch';
            hint.href = href;

            if (currentHint) currentHint.remove();
            (document.head || document.documentElement).appendChild(hint);
            currentHint = hint;
        }

        function warm(href) {
            if (speculated.has(href)) return;
            // Unbounded on an infinite-scroll page; the memo only exists to
            // stop repeat pointerdowns on the same link.
            if (speculated.size >= POINTERDOWN_MEMO_LIMIT) speculated.clear();
            speculated.add(href);

            try {
                if (supportsSpeculationRules) speculate(href);
                else prefetchHint(href);
            } catch (_) {}
        }

        document.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) warm(link.href);
        }, { passive: true, capture: true });
    }

    runWhenDomReady(initPointerdownPrefetch);

    // =========================================================================
    // Part 5: font-display swap injection
    // =========================================================================

    function initFontDisplaySwap() {
        if (typeof CSSFontFaceRule === 'undefined') return;

        // `swap` still repaints and reflows when the webfont finally arrives —
        // on a slow link that can be several seconds after first paint, which
        // is the worst of both worlds. `optional` renders the fallback and
        // never swaps, so text is stable from the first frame.
        const displayValue = getConnectionTier() === TIER_SLOW ? 'optional' : 'swap';

        function patchSheet(sheet) {
            try {
                const rules = sheet.cssRules || sheet.rules;
                if (!rules) return false;

                for (const rule of rules) {
                    if (rule instanceof CSSFontFaceRule && !rule.style.fontDisplay) {
                        rule.style.fontDisplay = displayValue;
                    }
                }

                return true;
            } catch (_) {
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

        const observer = new MutationObserver(mutations => {
            let needsScan = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;

                    // Stylesheet links only: matching every <link> would make
                    // icons, preconnects and prefetches (including the hints
                    // this script injects) schedule full stylesheet rescans.
                    if (node.matches('link[rel~="stylesheet"], style')) {
                        const tryPatch = () => {
                            if (!node.sheet || !patchSheet(node.sheet)) scheduleScan();
                        };

                        // A <link>'s sheet only exists once the stylesheet has
                        // loaded, which is after this mutation fires.
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
    // Part 6: cross-visit learning (LCP preload + critical-origin preconnect)
    // =========================================================================
    //
    // Everything above this point is reactive: it can only speed up a resource
    // once the page has already revealed that it wants it. The largest single
    // win left is starting the two things that gate first paint — the hero
    // image and the third-party connections — before the parser discovers
    // them. We cannot know those on a cold visit, but we saw them last time.

    const LEARN_LCP_KEY = 'tm-qs-lcp';
    const LEARN_ORIGINS_KEY = 'tm-qs-origins';
    const LEARN_VITALS_KEY = 'tm-qs-vitals';
    const LEARN_LCP_MAX_ENTRIES = 60;
    const LEARN_ORIGIN_MAX_ENTRIES = 8;
    const LEARN_VITALS_SAMPLES = 12;
    const LEARN_MAX_AGE = 14 * 24 * HOUR;
    // Act only on the third sighting: a page redesign should cost one wasted
    // preload, not one on every visit until the record ages out.
    const LEARN_MIN_SIGHTINGS = 2;
    const LEARN_EARLY_RESOURCE_MS = 4000;
    const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

    let learnedLcpUrl = null;

    function readStore(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const value = JSON.parse(raw);
            return (value && typeof value === 'object') ? value : null;
        } catch (_) {
            return null;
        }
    }

    function writeStore(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    function appendToHead(node) {
        if (document.head) {
            document.head.appendChild(node);
            return;
        }

        const root = document.documentElement;
        if (!root) return;

        // document-start can run before <head> exists. Resource hints are only
        // reliably processed once they are in the document, so wait for it.
        const observer = new MutationObserver(() => {
            if (!document.head) return;
            observer.disconnect();
            document.head.appendChild(node);
        });
        observer.observe(root, { childList: true });
    }

    // A responsive hero served via srcset resolves to a different candidate at
    // a different width or DPR, so a record is only reusable at a similar
    // viewport — otherwise the preload fetches a variant the page never uses.
    function viewportBucket() {
        const width = Math.round((window.innerWidth || 0) / 160) * 160;
        const dpr = Math.round(window.devicePixelRatio || 1);
        return width + 'x' + dpr;
    }

    function pageKey() {
        // Exact pathname, deliberately not a normalised /post/* pattern: two
        // articles under the same route have different hero images, and
        // preloading the wrong one spends scarce bytes on an unused image.
        return location.pathname.slice(0, 200);
    }

    function capStore(store, limit) {
        const entries = Object.entries(store)
            .sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0))
            .slice(0, limit);
        return Object.fromEntries(entries);
    }

    function applyLearnedHints() {
        const tier = getConnectionTier();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const record = lcpStore && lcpStore[pageKey()];

        if (
            record
            && typeof record.url === 'string'
            && (Number(record.seen) || 0) >= LEARN_MIN_SIGHTINGS
            && record.vw === viewportBucket()
            && Date.now() - (Number(record.at) || 0) < LEARN_MAX_AGE
        ) {
            learnedLcpUrl = record.url;

            try {
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = record.url;
                link.setAttribute('fetchpriority', 'high');
                // The preload has to match how the element will fetch it. A
                // mismatched CORS mode produces a second request rather than a
                // warm cache entry, which is worse than not preloading at all.
                if (record.cors) link.crossOrigin = record.cors;
                appendToHead(link);
            } catch (_) {}
        }

        const originStore = readStore(LEARN_ORIGINS_KEY);
        const origins = (originStore && Array.isArray(originStore.origins)) ? originStore.origins : [];
        const budget = tier === TIER_SLOW ? 2 : (tier === TIER_MODERATE ? 3 : 4);

        let used = 0;
        for (const entry of origins) {
            if (used >= budget) break;
            if (!entry || typeof entry.o !== 'string') continue;
            if ((Number(entry.n) || 0) < LEARN_MIN_SIGHTINGS) continue;
            if (entry.o === location.origin) continue;

            try {
                const hint = document.createElement('link');
                hint.rel = 'preconnect';
                hint.href = entry.o;
                // Fonts and other CSS-initiated subresources fetch in CORS mode
                // and will not reuse an uncredentialed-mismatched connection.
                if (entry.c) hint.crossOrigin = 'anonymous';
                appendToHead(hint);
                used += 1;
            } catch (_) {}
        }
    }

    function initLearning() {
        let latestLcp = null;

        try {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    // LCP is reported repeatedly as larger candidates appear;
                    // the final one wins. Text LCP has no url — nothing to
                    // preload there, so those entries are ignored.
                    if (entry && entry.url) latestLcp = entry;
                }
            });
            observer.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (_) {}

        function persistLcp() {
            if (!latestLcp || !latestLcp.url) return;

            const url = toUrl(latestLcp.url);
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return;

            const store = readStore(LEARN_LCP_KEY) || {};
            const key = pageKey();
            const previous = store[key];
            const bucket = viewportBucket();
            const element = latestLcp.element;
            const cors = (element && element.crossOrigin) ? element.crossOrigin : null;
            const sameTarget = Boolean(previous && previous.url === url.href && previous.vw === bucket);

            store[key] = {
                url: url.href,
                cors,
                vw: bucket,
                at: Date.now(),
                // A changed target resets confidence rather than accumulating
                // it, so a redesigned page stops being preloaded immediately.
                seen: sameTarget ? Math.min(Number(previous.seen) || 0, 50) + 1 : 1
            };

            writeStore(LEARN_LCP_KEY, capStore(store, LEARN_LCP_MAX_ENTRIES));

            const vitals = readStore(LEARN_VITALS_KEY) || {};
            const samples = Array.isArray(vitals.lcp) ? vitals.lcp.filter(Number.isFinite) : [];
            samples.push(Math.round(latestLcp.startTime));
            writeStore(LEARN_VITALS_KEY, { lcp: samples.slice(-LEARN_VITALS_SAMPLES) });
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

            for (const entry of previous) {
                if (!entry || typeof entry.o !== 'string') continue;
                merged.set(entry.o, {
                    o: entry.o,
                    c: Boolean(entry.c),
                    n: Number(entry.n) || 0,
                    t: Number(entry.t) || 0
                });
            }

            for (const info of observed.values()) {
                const existing = merged.get(info.origin);
                if (existing) {
                    existing.n += 1;
                    existing.c = existing.c || info.cors;
                    existing.t = Math.min(existing.t || info.first, info.first);
                } else {
                    merged.set(info.origin, { o: info.origin, c: info.cors, n: 1, t: info.first });
                }
            }

            // Most consistently used first, ties broken by how early the origin
            // is needed — that is the order a preconnect budget should spend in.
            const ranked = Array.from(merged.values())
                .sort((a, b) => (b.n - a.n) || (a.t - b.t))
                .slice(0, LEARN_ORIGIN_MAX_ENTRIES);

            writeStore(LEARN_ORIGINS_KEY, { origins: ranked, at: Date.now() });
        }

        let persisted = false;
        function persist() {
            if (persisted) return;
            persisted = true;
            persistLcp();
        }

        // LCP is only final once the page is backgrounded or torn down.
        // pagehide alone misses tab switches that never unload.
        window.addEventListener('pagehide', persist);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') persist();
        });

        runWhenLoadedIdle(persistOrigins);
    }

    applyLearnedHints();
    initLearning();

    // =========================================================================
    // Part 7: priority hints and lazy media
    // =========================================================================
    //
    // Caveat worth knowing: for images the HTML parser discovers, Chrome's
    // preload scanner may have already started the fetch before a userscript
    // can touch the element, and neither loading=lazy nor fetchpriority
    // retroactively cancels or reorders an in-flight request. The reliable win
    // is script-inserted media — infinite scroll, SPA route changes, lazy
    // widgets — which is also where the runaway byte counts usually are.

    const MEDIA_EAGER_IMAGE_COUNT = 4;
    const MEDIA_SCAN_BUDGET = 300;
    const BELOW_FOLD_FACTOR = 1.5;

    function initMediaPriority() {
        const tunedImages = new WeakSet();
        let imagesSeen = 0;
        let lastPath = location.pathname;

        // A client-side route change starts a new page as far as the user is
        // concerned; without resetting, every image of every subsequent route
        // would be lazy-loaded including its hero.
        function syncRoute() {
            if (location.pathname === lastPath) return;
            lastPath = location.pathname;
            imagesSeen = 0;
        }

        function foldLimit() {
            return (window.innerHeight || document.documentElement.clientHeight || 0) * BELOW_FOLD_FACTOR;
        }

        function isLcpCandidate(img) {
            if (!learnedLcpUrl) return false;
            return img.currentSrc === learnedLcpUrl || img.src === learnedLcpUrl;
        }

        // Runs during parsing, so it must not read layout — getBoundingClientRect
        // here would force a synchronous layout per image and return zeros
        // anyway. Document order is the only signal available this early.
        function tuneEarly(img) {
            // MutationObserver records are delivered asynchronously, so a
            // container's subtree is already populated by the time we see the
            // record for the container itself. Every image inside therefore
            // arrives twice — once via the container scan and once via its own
            // record — which burns the eager budget at double rate and lazies
            // images that should have stayed eager.
            if (tunedImages.has(img)) return;
            tunedImages.add(img);

            imagesSeen += 1;
            if (img.hasAttribute('loading') || img.hasAttribute('fetchpriority')) return;
            if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
            if (imagesSeen <= MEDIA_EAGER_IMAGE_COUNT || isLcpCandidate(img)) return;

            // Chrome still loads a lazy image immediately when it is inside (or
            // near) the viewport, so a mis-classified above-fold image costs
            // little, while a genuinely below-fold one costs nothing at all.
            img.setAttribute('loading', 'lazy');
            img.setAttribute('fetchpriority', 'low');
        }

        // Second pass, once layout exists: catches images the early pass had no
        // ordering signal for and anything inserted after parsing.
        function tuneWithLayout(el, limit) {
            if (el.hasAttribute('loading') || el.hasAttribute('fetchpriority')) return;

            const rect = el.getBoundingClientRect();
            // No box yet (display:none, detached, not laid out): guessing here
            // would deprioritise something that is about to become the hero.
            if (rect.width === 0 && rect.height === 0) return;
            if (rect.top <= limit) return;

            const isImage = el.tagName === 'IMG';
            if (isImage && isLcpCandidate(el)) return;

            el.setAttribute('loading', 'lazy');
            // fetchpriority has no meaning on <iframe>; loading=lazy is the
            // whole lever there.
            if (isImage) el.setAttribute('fetchpriority', 'low');
        }

        function tuneVideo(video) {
            if (getConnectionTier() === TIER_FAST) return;
            if (video.hasAttribute('preload') || video.autoplay) return;
            // Only before playback starts; changing preload mid-playback would
            // fight the media element rather than help it.
            if (!video.paused || video.currentTime > 0) return;
            video.setAttribute('preload', 'none');
        }

        function scanWithLayout() {
            const limit = foldLimit();
            let budget = MEDIA_SCAN_BUDGET;

            try {
                for (const img of document.images) {
                    if (budget-- <= 0) break;
                    tuneWithLayout(img, limit);
                }
                for (const frame of document.querySelectorAll('iframe')) {
                    if (budget-- <= 0) break;
                    tuneWithLayout(frame, limit);
                }
                for (const video of document.querySelectorAll('video')) {
                    if (budget-- <= 0) break;
                    tuneVideo(video);
                }
            } catch (_) {}
        }

        const root = document.documentElement;
        if (root) {
            // Handled synchronously rather than batched into a frame: the whole
            // point is to touch the element before the fetch starts.
            const observer = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (!(node instanceof Element)) continue;

                        try {
                            syncRoute();
                            if (node.tagName === 'IMG') tuneEarly(node);
                            else if (node.tagName === 'VIDEO') tuneVideo(node);
                            else if (node.firstElementChild) {
                                for (const img of node.querySelectorAll('img')) tuneEarly(img);
                                for (const video of node.querySelectorAll('video')) tuneVideo(video);
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

    initMediaPriority();

    // =========================================================================
    // Part 8: content-visibility (opt-in)
    // =========================================================================
    //
    // Skipping layout and paint for offscreen sections is often a bigger win
    // than any network change on a low-end device, but it interacts badly with
    // sticky positioning, in-page anchors and some virtualised lists — so it
    // stays behind a per-origin toggle rather than defaulting on.

    const CV_FLAG_KEY = 'tm-qs-content-visibility';
    const CV_MIN_HEIGHT = 300;
    const CV_MAX_ELEMENTS = 60;

    function contentVisibilityEnabled() {
        try {
            return localStorage.getItem(CV_FLAG_KEY) === '1';
        } catch (_) {
            return false;
        }
    }

    function initContentVisibility() {
        if (!contentVisibilityEnabled()) return;
        if (typeof CSS === 'undefined' || !CSS.supports || !CSS.supports('content-visibility', 'auto')) return;

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

    runWhenLoadedIdle(initContentVisibility);
})();
