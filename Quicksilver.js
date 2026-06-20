// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Faster browsing hints plus a lightweight LRU static asset cache. Respects Cache-Control, avoids sensitive links/APIs, and backs off on slow/data-saver connections.
// @author       You
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.user.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.user.js
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // Shared helpers
    // =========================================================================

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;

    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
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
            if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 3000 });
            else setTimeout(fn, 750);
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
    const MAX_ITEMS = 1000;
    const PRUNE_CHUNK = 75;
    const METADATA_KEY = 'tm-cache-lru-metadata';
    const STATS_KEY = 'tm-cache-stats';
    const FLUSH_DELAY = 2500;
    const TOUCH_WRITE_MIN_MS = 45 * SECOND;
    const WRITE_MAINTENANCE_INTERVAL = 25;

    function getRevalidateTTL() {
        if (!conn) return HOUR;
        if (conn.saveData) return 2 * HOUR;

        switch (conn.effectiveType) {
            case '4g': return 30 * MINUTE;
            case '3g': return HOUR;
            case '2g':
            case 'slow-2g': return 2 * HOUR;
            default: return HOUR;
        }
    }

    const CACHEABLE_EXTENSIONS = /\.(?:js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp|wasm)(?:[?#]|$)/i;
    const DOWNLOAD_EXTENSIONS = [
        '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
    ];
    const DOWNLOAD_REGEX = new RegExp('\\.(?:' + DOWNLOAD_EXTENSIONS.map(ext => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[?#]|$)', 'i');

    const SENSITIVE_PATH_PATTERNS = [
        '/logout*', '/signout*', '/log-out*', '/sign-out*',
        '/checkout*', '/cart*', '/account*', '/admin*',
        '/order*', '/orders*', '/payment*', '/payments*',
        '/delete*', '/auth*', '/login*', '/signin*', '/sign-in*'
    ];
    const SENSITIVE_HREF_REGEX = /\/(?:logout|signout|log-out|sign-out|checkout|cart|account|admin|orders?|payments?|delete|auth|login|signin|sign-in)(?:[/?#-]|$)/i;

    const SKIP_URL_PATTERNS = [
        /\/api(?:\/|$)/i,
        /\/graphql(?:[/?#]|$)/i,
        /\/(?:feed|rss|json|ws)(?:\/|[?#]|$)/i,
        /\.(?:json|html?|xml|m3u8|mpd)(?:[?#]|$)/i,
        /\bservice-worker\b/i,
        /\bmanifest\b.*\.js(?:[?#]|$)/i
    ];

    const NO_STORE = /\bno-store\b/i;
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
                    bypassed: Number(obj.bypassed) || 0
                };
            }
        } catch (_) {}
        return { hits: 0, misses: 0, bypassed: 0 };
    }

    const stats = loadStats();
    let statsTimer = null;

    function saveStats() {
        statsTimer = null;
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

    function triggerMaintenance() {
        if ('requestIdleCallback' in window) window.requestIdleCallback(pruneCache, { timeout: 5000 });
        else setTimeout(pruneCache, 5000);
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

    function parseCacheTTL(response, cc) {
        if (IMMUTABLE.test(cc)) return Infinity;

        const maxAge = cc.match(/(?:^|,)\s*max-age\s*=\s*(\d+)/i);
        if (maxAge) return Number(maxAge[1]) * SECOND;

        const expires = response.headers.get('Expires');
        if (!expires) return null;

        const expiresAt = Date.parse(expires);
        if (Number.isNaN(expiresAt)) return null;

        const dateAt = Date.parse(response.headers.get('Date') || '') || Date.now();
        return Math.max(0, expiresAt - dateAt);
    }

    function getCacheability(response) {
        if (!response || !response.ok || response.status === 206) return false;

        const cc = response.headers.get('Cache-Control') || '';
        if (NO_STORE.test(cc)) return false;

        const vary = response.headers.get('Vary') || '';
        if (vary.trim() === '*') return false;

        const ct = response.headers.get('Content-Type') || '';
        if (ct && !CACHEABLE_CONTENT_TYPES.test(ct)) return false;

        return {
            ttlMs: parseCacheTTL(response, cc),
            forceRevalidate: FORCE_REVALIDATE.test(cc)
        };
    }

    function headersHaveAuthorization(headers) {
        if (!headers) return false;

        try {
            if (typeof headers.get === 'function') return Boolean(headers.get('Authorization'));
            if (Array.isArray(headers)) return headers.some(([key]) => String(key).toLowerCase() === 'authorization');
            if (typeof headers === 'object') return Object.keys(headers).some(key => key.toLowerCase() === 'authorization' && headers[key]);
        } catch (_) {}

        return false;
    }

    function installFetchCache() {
        const hasServiceWorker = 'serviceWorker' in navigator;
        if ((hasServiceWorker && navigator.serviceWorker.controller) || typeof unsafeWindow === 'undefined') return;

        const originalFetch = unsafeWindow.fetch;
        if (typeof originalFetch !== 'function') return;

        let cachePromise = null;
        const inFlightRevalidations = new Map();

        const getCache = () => {
            if (typeof caches === 'undefined') return Promise.reject(new Error('Cache API unavailable'));
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

            return {
                url: url.href,
                method: String(init.method || (requestLike && request.method) || 'GET').toUpperCase(),
                cacheMode: init.cache || (requestLike && request.cache),
                headers: init.headers || (requestLike && request.headers)
            };
        }

        function maybeScheduleMaintenance() {
            cacheWritesSinceMaintenance += 1;
            if (cacheWritesSinceMaintenance >= WRITE_MAINTENANCE_INTERVAL) {
                cacheWritesSinceMaintenance = 0;
                triggerMaintenance();
            }
        }

        async function revalidate(cache, url, thisArg, args) {
            try {
                const networkResponse = await originalFetch.apply(thisArg, args);
                const cacheability = getCacheability(networkResponse);
                if (!cacheability) return;

                await cache.put(url, networkResponse.clone());
                touchItem(url, cacheability);
                maybeScheduleMaintenance();
            } catch (_) {
                // Stale cache is still better than making page fetches fail.
            } finally {
                inFlightRevalidations.delete(url);
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
                || headersHaveAuthorization(info.headers);

            if (bypass) {
                stats.bypassed += 1;
                scheduleStatsSave();
                return originalFetch.apply(this, args);
            }

            try {
                const cache = await getCache();
                const cachedResponse = await cache.match(info.url);

                if (cachedResponse) {
                    stats.hits += 1;
                    scheduleStatsSave();

                    if (isFresh(info.url)) {
                        touchItem(info.url);
                    } else if (!inFlightRevalidations.has(info.url)) {
                        inFlightRevalidations.set(info.url, revalidate(cache, info.url, this, args));
                    }

                    return cachedResponse.clone();
                }

                stats.misses += 1;
                scheduleStatsSave();
                const networkResponse = await originalFetch.apply(this, args);
                const cacheability = getCacheability(networkResponse);

                if (cacheability) {
                    cache.put(info.url, networkResponse.clone())
                        .then(() => {
                            touchItem(info.url, cacheability);
                            maybeScheduleMaintenance();
                        })
                        .catch(() => {});
                }

                return networkResponse;
            } catch (_) {
                return originalFetch.apply(this, args);
            }
        };

        if (hasServiceWorker) {
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                unsafeWindow.fetch = originalFetch;
                cachePromise = null;
            }, { once: true });
        }
    }

    installFetchCache();

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Purge Asset Cache (Current Origin)', async () => {
            await caches.delete(CACHE_NAME);
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
                'Hit rate: ' + hitRate + '% (of ' + total + ' cacheable fetches)',
                'Not cached: ' + stats.bypassed + ' fetches (non-GET / API / non-asset)',
                'TTL: ' + Math.round(getRevalidateTTL() / MINUTE) + ' min (' + (conn && conn.effectiveType || 'unknown') + ' connection)'
            ].join('\n'));
        });
    }

    window.addEventListener('pagehide', () => {
        flushMetadata();
        saveStats();
    });

    // =========================================================================
    // Part 2: Speculation Rules prefetch/prerender
    // =========================================================================

    function initSpeculationRules() {
        if (!supportsSpeculationRules || isSlowOrMeteredConnection()) return;

        const excludeSelectors = [
            "a[href^='javascript:']",
            "a[href^='mailto:']",
            "a[href^='tel:']",
            "a[href*='download']",
            "a[href*='logout']",
            "a[href*='signout']",
            "a[href*='log-out']",
            "a[href*='sign-out']",
            "a[href*='checkout']",
            "a[href*='cart']",
            "a[href*='account']",
            "a[href*='admin']",
            "a[href*='order']",
            "a[href*='payment']",
            "a[href*='delete']",
            "a[href*='auth']",
            "a[href*='login']",
            "a[href*='signin']",
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
                eagerness: 'moderate'
            }],
            prerender: [{
                where: {
                    and: [
                        { selector_matches: "a[rel='next'], link[rel='next']" },
                        { not: { selector_matches: excludeSelectors } }
                    ]
                },
                eagerness: 'moderate'
            }]
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
    // Part 3: preconnect on hover/focus
    // =========================================================================

    function initPreconnectOnIntent() {
        const connected = new Set();
        const currentOrigin = location.origin;
        const maxPreconnects = 8;
        let lastLink = null;

        function removeOldestPreconnect() {
            const oldest = connected.values().next().value;
            if (!oldest) return;

            const escapedOldest = String(oldest).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const oldLink = document.querySelector('link[rel="preconnect"][href="' + escapedOldest + '"]');
            if (oldLink) oldLink.remove();
            connected.delete(oldest);
        }

        function preconnect(origin) {
            if (!document.head || connected.has(origin) || origin === currentOrigin) return;
            if (connected.size >= maxPreconnects) removeOldestPreconnect();

            const hint = document.createElement('link');
            hint.rel = 'preconnect';
            hint.crossOrigin = 'anonymous';
            hint.href = origin;
            document.head.appendChild(hint);
            connected.add(origin);
        }

        function maybePreconnect(target) {
            const link = getClosestLinkTarget(target);
            if (!link || link === lastLink) return;
            lastLink = link;

            const url = toUrl(link.href);
            if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
                preconnect(url.origin);
            }
        }

        document.addEventListener('pointerover', e => maybePreconnect(e.target), { passive: true, capture: true });
        document.addEventListener('focusin', e => maybePreconnect(e.target), { passive: true, capture: true });
    }

    runWhenDomReady(initPreconnectOnIntent);

    // =========================================================================
    // Part 4: fallback link prefetch for browsers without Speculation Rules
    // =========================================================================

    function initFallbackPrefetch() {
        if (supportsSpeculationRules || isSlowOrMeteredConnection()) return;

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
            if (SENSITIVE_HREF_REGEX.test(href) || /download/i.test(href)) return false;
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

        document.addEventListener('mousedown', e => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) prefetch(link.href);
        }, { passive: true, capture: true });

        document.addEventListener('touchstart', e => {
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) prefetch(link.href);
        }, { passive: true, capture: true });
    }

    runWhenDomReady(initFallbackPrefetch);

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

                    if (node.matches('link, style')) {
                        window.requestAnimationFrame(() => {
                            if (!node.sheet || !patchSheet(node.sheet)) scheduleScan();
                        });
                    } else if (node.querySelector('link, style')) {
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
