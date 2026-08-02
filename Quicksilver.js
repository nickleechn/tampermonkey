// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Chrome-only: aggressive Speculation Rules prefetch/prerender plus a high-hit-rate LRU static asset cache. Respects Cache-Control, avoids sensitive links/APIs, and backs off on slow/data-saver connections.
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

    function isSlowOrMeteredConnection() {
        return Boolean(conn && (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'));
    }

    function runWhenDomReady(fn) {
        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function runWhenLoadedIdle(fn) {
        const runIdle = () => {
            if (navigator.scheduler && typeof navigator.scheduler.postTask === 'function') {
                navigator.scheduler.postTask(fn, { priority: 'background', delay: 0 });
            } else if ('requestIdleCallback' in window) {
                window.requestIdleCallback(fn, { timeout: 3000 });
            } else {
                setTimeout(fn, 750);
            }
        };

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

    function getRevalidateTTL() {
        if (!conn) return 2 * HOUR;
        if (conn.saveData) return 2 * HOUR;

        switch (conn.effectiveType) {
            case '4g': return 2 * HOUR;
            case '3g': return 2 * HOUR;
            case '2g':
            case 'slow-2g': return 2 * HOUR;
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
        if (shouldPersist) scheduleFlush();
    }

    function isFresh(url) {
        const meta = getMetadata(url);
        if (forceRevalidateUrls.has(url) || meta.forceRevalidate || !meta.cachedAt) return false;

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

    function triggerMaintenance() {
        if (navigator.scheduler && typeof navigator.scheduler.postTask === 'function') {
            navigator.scheduler.postTask(pruneCache, { priority: 'background' });
        } else if ('requestIdleCallback' in window) {
            window.requestIdleCallback(pruneCache, { timeout: 5000 });
        } else {
            setTimeout(pruneCache, 5000);
        }
    }

    async function pruneCache() {
        try {
            const cache = await caches.open(CACHE_NAME);
            const keys = await cache.keys();
            if (keys.length <= MAX_ITEMS) return;

            const toDelete = keys
                .sort((a, b) => (getMetadata(a.url).touchedAt || 0) - (getMetadata(b.url).touchedAt || 0))
                .slice(0, Math.max(PRUNE_CHUNK, keys.length - MAX_ITEMS));

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
                return headers.some(([key]) => BYPASS_REQUEST_HEADERS.includes(String(key).toLowerCase()));
            }
            if (typeof headers === 'object') {
                return Object.keys(headers).some(key => BYPASS_REQUEST_HEADERS.includes(key.toLowerCase()) && headers[key]);
            }
        } catch (_) {}

        return false;
    }

    function stripSignalFromArgs(args) {
        const request = args[0];
        const init = args[1] ? Object.assign({}, args[1]) : {};
        delete init.signal;

        if (request && typeof request === 'object' && 'url' in request && 'method' in request) {
            try {
                const next = new Request(request, init);
                return [next];
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

        return args.length > 1 ? [request, init] : [request];
    }

    function installFetchCache() {
        // typeof caches guard: the Cache API only exists in secure contexts, so
        // on plain-HTTP pages the wrapper would fail (and fall back) per fetch.
        const hasServiceWorker = 'serviceWorker' in navigator;
        if ((hasServiceWorker && navigator.serviceWorker.controller) || typeof unsafeWindow === 'undefined' || typeof caches === 'undefined') return;

        const originalFetch = unsafeWindow.fetch;
        if (typeof originalFetch !== 'function') return;

        let cachePromise = null;
        const inFlightRevalidations = new Map();
        const inFlightNetwork = new Map();

        const getCache = () => {
            if (!cachePromise) {
                cachePromise = caches.open(CACHE_NAME).catch(error => {
                    cachePromise = null;
                    throw error;
                });
            }
            return cachePromise;
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
            const signal = init.signal || (requestLike ? request.signal : undefined);

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
                cacheRequest: makeCacheRequest(url.href, { headers, credentials, mode, redirect, referrer, referrerPolicy })
            };
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
            let storeRequest = info.cacheRequest;
            let storeUrl = info.url;

            if (networkResponse.redirected && finalUrl && finalUrl !== info.url) {
                if (!isCacheableUrl(finalUrl)) {
                    await evictEntry(cache, info.cacheRequest, info.url);
                    return;
                }
                storeUrl = finalUrl;
                storeRequest = makeCacheRequest(finalUrl, {
                    headers: info.headers,
                    credentials: info.credentials,
                    mode: info.mode,
                    redirect: info.redirect,
                    referrer: info.referrer,
                    referrerPolicy: info.referrerPolicy
                });
                if (storeUrl !== info.url) {
                    await evictEntry(cache, info.cacheRequest, info.url);
                }
            }

            try {
                await cache.put(storeRequest, networkResponse.clone());
                touchItem(storeUrl, cacheability);
                maybeScheduleMaintenance();
            } catch (_) {
                // Redirected / opaque / quota failures: skip store.
            }
        }

        // Shared network flight ignores per-caller AbortSignals so one abort
        // cannot cancel siblings; callers re-check their own signal after.
        function coalesceNetwork(thisArg, args, info) {
            const existing = inFlightNetwork.get(info.url);
            if (existing) {
                return existing.then(response => response.clone());
            }

            const pending = originalFetch.apply(thisArg, stripSignalFromArgs(args)).then(response => {
                inFlightNetwork.delete(info.url);
                return response;
            }, error => {
                inFlightNetwork.delete(info.url);
                throw error;
            });

            inFlightNetwork.set(info.url, pending);
            return pending.then(response => response.clone());
        }

        function throwIfAborted(signal) {
            if (!signal || !signal.aborted) return;
            if (typeof DOMException === 'function') {
                throw new DOMException(signal.reason && signal.reason.message || 'Aborted', 'AbortError');
            }
            const err = new Error('Aborted');
            err.name = 'AbortError';
            throw err;
        }

        async function revalidate(cache, info, thisArg, args) {
            try {
                const networkResponse = await originalFetch.apply(thisArg, stripSignalFromArgs(args));
                const cacheability = getCacheability(networkResponse, networkResponse.url || info.url);
                if (!cacheability) {
                    // The server answered but no longer vouches for this asset
                    // (gone, error, or uncacheable now). Without eviction the
                    // stale copy would be served via SWR forever.
                    evictEntry(cache, info.cacheRequest, info.url);
                    return;
                }

                await storeResponse(cache, info, networkResponse, cacheability);
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
                || info.cacheMode === 'no-cache'
                || info.cacheMode === 'reload'
                || info.cacheMode === 'no-store'
                || hasBypassHeader(info.headers);

            if (bypass) {
                if (info && info.method === 'GET' && CACHEABLE_EXTENSIONS.test(info.url)) {
                    stats.bypassed += 1;
                    scheduleStatsSave();
                }
                return originalFetch.apply(this, args);
            }

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
                            evictEntry(cache, info.cacheRequest, info.url);
                        }
                        stats.revalidations += 1;
                        scheduleStatsSave();
                        return networkResponse;
                    }

                    stats.hits += 1;
                    scheduleStatsSave();
                    if (!inFlightRevalidations.has(info.url)) {
                        inFlightRevalidations.set(info.url, revalidate(cache, info, this, args));
                    }

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
                cachePromise = null;
                inFlightNetwork.clear();
                inFlightRevalidations.clear();
            }, { once: true });
        }
    }

    installFetchCache();

    function initIdleCacheWarm() {
        if (typeof caches === 'undefined' || isSlowOrMeteredConnection()) return;
        if (typeof unsafeWindow === 'undefined' || typeof unsafeWindow.fetch !== 'function') return;

        const urls = new Set();
        for (const el of document.querySelectorAll('script[src], link[rel~="stylesheet"][href]')) {
            const href = el.currentSrc || el.src || el.href;
            const url = toUrl(href);
            if (!url) continue;
            if (url.origin !== location.origin) continue;
            if (!isCacheableUrl(url.href)) continue;
            urls.add(url.href);
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
            } catch (_) {}
            alert('Quicksilver asset cache purged for this origin.');
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
                'TTL: ' + Math.round(getRevalidateTTL() / MINUTE) + ' min (' + (conn && conn.effectiveType || 'unknown') + ' connection)'
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

    function initSpeculationRules() {
        if (!supportsSpeculationRules || isSlowOrMeteredConnection()) return;

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

        const rules = {
            prefetch: [{
                where: {
                    and: [
                        { href_matches: '/*' },
                        { not: { href_matches: SENSITIVE_PATH_PATTERNS } },
                        { not: { selector_matches: excludeSelectors } }
                    ]
                },
                eagerness: 'eager'
            }],
            prerender: [
                {
                    where: {
                        and: [
                            { href_matches: '/*' },
                            { not: { href_matches: SENSITIVE_PATH_PATTERNS } },
                            { not: { selector_matches: excludeSelectors } }
                        ]
                    },
                    eagerness: 'moderate'
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
                    eagerness: 'immediate'
                }
            ]
        };

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

    function initPointerdownPrefetch() {
        if (isSlowOrMeteredConnection()) return;

        const prefetched = new Set();
        let currentPrefetch = null;

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

        function prefetch(href) {
            if (!document.head || prefetched.has(href)) return;

            if (currentPrefetch) currentPrefetch.remove();

            const hint = document.createElement('link');
            hint.rel = 'prefetch';
            hint.href = href;
            document.head.appendChild(hint);
            currentPrefetch = hint;
            prefetched.add(href);
        }

        document.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) prefetch(link.href);
        }, { passive: true, capture: true });
    }

    runWhenDomReady(initPointerdownPrefetch);

    // =========================================================================
    // Part 5: font-display swap injection
    // =========================================================================

    function initFontDisplaySwap() {
        if (typeof CSSFontFaceRule === 'undefined') return;

        function patchSheet(sheet) {
            try {
                const rules = sheet.cssRules || sheet.rules;
                if (!rules) return false;

                for (const rule of rules) {
                    if (rule instanceof CSSFontFaceRule && !rule.style.fontDisplay) {
                        rule.style.fontDisplay = 'swap';
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
})();
