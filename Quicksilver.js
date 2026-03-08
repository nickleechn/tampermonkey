// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Blazing-fast browsing: LRU static asset cache + Speculation Rules link prefetch/prerender + DNS prefetch. Respects Cache-Control, skips APIs, and stays out of service workers' way.
// @author       You
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // PART 1: OPTIMISTIC STATIC ASSET CACHE
    // =========================================================================

    const CACHE_NAME = 'tm-smart-lru-v3';
    const MAX_ITEMS = 1000;
    const PRUNE_CHUNK = 50;
    const METADATA_KEY = 'tm-cache-lru-metadata';

    // Network-aware TTL: shorter on fast connections, longer on slow ones
    function getRevalidateTTL() {
        const conn = navigator.connection;
        if (!conn) return 3600000; // 1 hour default
        if (conn.saveData) return 7200000; // 2 hours on data saver
        switch (conn.effectiveType) {
            case '4g': return 1800000;   // 30 min — fast connection, revalidate sooner
            case '3g': return 3600000;   // 1 hour
            case '2g':
            case 'slow-2g': return 7200000; // 2 hours — slow connection, keep cache longer
            default: return 3600000;
        }
    }

    const CACHEABLE_EXTENSIONS = /\.(js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp)(\?|$)/i;

    const SKIP_URL_PATTERNS = [
        /\/api\//i, /\/graphql/i, /\/feed/i, /\/rss/i, /\/json/i, /\/ws\//i,
        /\.json(\?|$)/i, /\.html?(\?|$)/i, /\.xml(\?|$)/i,
        /\bservice-worker\b/i, /\bmanifest\b.*\.js/i,
        /\.m3u8(\?|$)/i, /\.mpd(\?|$)/i,
    ];

    const NO_CACHE_DIRECTIVES = /\b(no-store|no-cache|private|must-revalidate)\b/i;
    const CACHEABLE_CONTENT_TYPES = /^(text\/css|text\/javascript|application\/javascript|application\/x-javascript|image\/|font\/|application\/font|application\/x-font|application\/wasm)/i;

    // --- In-memory metadata with debounced localStorage sync ---
    let metadataMap = new Map();
    let metadataDirty = false;
    let flushTimer = null;
    const FLUSH_DELAY = 2000; // 2 second debounce

    function loadMetadata() {
        try {
            const raw = localStorage.getItem(METADATA_KEY);
            if (raw) {
                const obj = JSON.parse(raw);
                for (const [k, v] of Object.entries(obj)) metadataMap.set(k, v);
            }
        } catch (e) {}
    }
    loadMetadata();

    function scheduleFlush() {
        if (flushTimer) return;
        metadataDirty = true;
        flushTimer = setTimeout(flushMetadata, FLUSH_DELAY);
    }

    function flushMetadata() {
        flushTimer = null;
        if (!metadataDirty) return;
        metadataDirty = false;
        try {
            const obj = Object.fromEntries(metadataMap);
            localStorage.setItem(METADATA_KEY, JSON.stringify(obj));
        } catch (e) { /* quota exceeded */ }
    }

    function touchItem(url) {
        metadataMap.set(url, Date.now());
        scheduleFlush();
    }

    function isFresh(url) {
        const timestamp = metadataMap.get(url);
        if (!timestamp) return false;
        return (Date.now() - timestamp) < getRevalidateTTL();
    }

    // --- Cache stats tracking ---
    let cacheHits = 0;
    let cacheMisses = 0;

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Purge Asset Cache (Current Site)', async () => {
            await caches.delete(CACHE_NAME);
            metadataMap.clear();
            metadataDirty = false;
            try { localStorage.removeItem(METADATA_KEY); } catch (e) {}
            cacheHits = 0;
            cacheMisses = 0;
            alert('Asset cache purged for this domain.');
        });

        GM_registerMenuCommand('Show Cache Stats', async () => {
            let itemCount = 0;
            let estimatedSize = 0;
            try {
                const cache = await caches.open(CACHE_NAME);
                const keys = await cache.keys();
                itemCount = keys.length;
                // Estimate size from a sample of up to 20 entries
                const sample = keys.slice(0, 20);
                let sampleSize = 0;
                for (const req of sample) {
                    const res = await cache.match(req);
                    if (res) {
                        const blob = await res.blob();
                        sampleSize += blob.size;
                    }
                }
                if (sample.length > 0) {
                    estimatedSize = (sampleSize / sample.length) * itemCount;
                }
            } catch (e) {}

            const total = cacheHits + cacheMisses;
            const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : 'N/A';
            const sizeStr = estimatedSize > 1048576
                ? (estimatedSize / 1048576).toFixed(1) + ' MB'
                : (estimatedSize / 1024).toFixed(0) + ' KB';

            alert(
                `Quicksilver Cache Stats (this page)\n` +
                `─────────────────────────\n` +
                `Cached items: ${itemCount}\n` +
                `Estimated size: ${sizeStr}\n` +
                `Hits: ${cacheHits} | Misses: ${cacheMisses}\n` +
                `Hit rate: ${hitRate}%\n` +
                `TTL: ${(getRevalidateTTL() / 60000).toFixed(0)} min (${navigator.connection?.effectiveType || 'unknown'} connection)`
            );
        });
    }

    const triggerMaintenance = () => {
        if ('requestIdleCallback' in window) window.requestIdleCallback(pruneCache);
        else setTimeout(pruneCache, 5000);
    };

    async function pruneCache() {
        try {
            const cache = await caches.open(CACHE_NAME);
            const keys = await cache.keys();
            if (keys.length <= MAX_ITEMS) return;

            const sorted = keys.sort((a, b) => (metadataMap.get(a.url) || 0) - (metadataMap.get(b.url) || 0));
            const toDelete = sorted.slice(0, PRUNE_CHUNK);

            await Promise.all(toDelete.map(req => {
                metadataMap.delete(req.url);
                return cache.delete(req);
            }));
            scheduleFlush();
        } catch (err) {}
    }

    function isCacheableUrl(url) {
        if (!CACHEABLE_EXTENSIONS.test(url)) return false;
        if (SKIP_URL_PATTERNS.some(re => re.test(url))) return false;
        return true;
    }

    function isCacheableResponse(response) {
        const cc = response.headers.get('Cache-Control') || '';
        if (NO_CACHE_DIRECTIVES.test(cc)) return false;
        const ct = response.headers.get('Content-Type') || '';
        if (ct && !CACHEABLE_CONTENT_TYPES.test(ct)) return false;
        if (response.status === 206) return false;
        return response.ok;
    }

    const shouldOverrideFetch = !navigator.serviceWorker || !navigator.serviceWorker.controller;

    if (shouldOverrideFetch && typeof unsafeWindow !== 'undefined') {
        let cachePromise = null;
        function getCache() {
            if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
            return cachePromise;
        }

        const originalFetch = unsafeWindow.fetch;

        unsafeWindow.fetch = async function(...args) {
            let method = 'GET';
            let urlStr = '';

            if (args[0] instanceof Request) {
                method = args[0].method;
                urlStr = args[0].url;
            } else {
                method = (args[1] && args[1].method) || 'GET';
                try { urlStr = new URL(args[0], location.href).href; }
                catch (e) { return originalFetch.apply(this, args); }
            }

            // Bypass cache for no-cache, reload, and no-store fetch modes
            const cacheMode = args[1] && args[1].cache;
            const isBypass = cacheMode === 'no-cache' || cacheMode === 'reload' || cacheMode === 'no-store';

            if (method !== 'GET' || !isCacheableUrl(urlStr) || isBypass) {
                return originalFetch.apply(this, args);
            }

            try {
                const cache = await getCache();
                const cachedResponse = await cache.match(urlStr);

                if (cachedResponse) {
                    cacheHits++;
                    const responseToReturn = cachedResponse.clone();

                    if (!isFresh(urlStr)) {
                        originalFetch.apply(this, args)
                            .then(async (networkResponse) => {
                                if (isCacheableResponse(networkResponse)) {
                                    await cache.put(urlStr, networkResponse.clone()).catch(() => {});
                                    touchItem(urlStr);
                                    if (Math.random() < 0.05) triggerMaintenance();
                                }
                            })
                            .catch(() => {});
                    } else {
                        touchItem(urlStr);
                    }

                    return responseToReturn;
                }

                cacheMisses++;
                const networkResponse = await originalFetch.apply(this, args);

                if (isCacheableResponse(networkResponse)) {
                    cache.put(urlStr, networkResponse.clone())
                        .then(() => {
                            touchItem(urlStr);
                            if (Math.random() < 0.05) triggerMaintenance();
                        })
                        .catch(() => {});
                }

                return networkResponse;
            } catch (error) {
                return originalFetch.apply(this, args);
            }
        };
    }

    // Flush metadata before page unload
    window.addEventListener('beforeunload', flushMetadata);

    // =========================================================================
    // PART 2: LINK PRELOADER VIA SPECULATION RULES
    // =========================================================================

    function initPreloader() {
        if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;

        const conn = navigator.connection;
        if (conn && (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g')) return;

        const DOWNLOAD_EXTENSIONS = [
            '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
            '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
            '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
        ];

        // Use standard CSS selectors instead of invalid URL pattern wildcards
        const excludeSelectors = [
            "a[href^='javascript:']",
            "a[href^='mailto:']",
            "a[href^='tel:']",
            "a[href*='download']",
            "a[href*='logout']",
            "a[href*='signout']",
            "a[href*='log-out']",
            "a[href*='sign-out']",
            ...DOWNLOAD_EXTENSIONS.map(ext => `a[href$='${ext}' i]`)
        ].join(', ');

        const rules = {
            "prefetch": [{
                "where": {
                    "and": [
                        { "href_matches": "/*" },
                        { "not": { "selector_matches": excludeSelectors } }
                    ]
                },
                "eagerness": "moderate"
            }],
            "prerender": [{
                "where": {
                    "and": [
                        { "selector_matches": "a[rel='next'], link[rel='next']" },
                        { "not": { "selector_matches": excludeSelectors } }
                    ]
                },
                "eagerness": "moderate"
            }]
        };

        const script = document.createElement('script');
        script.type = 'speculationrules';
        script.textContent = JSON.stringify(rules);
        document.head.appendChild(script);
    }

    if (document.readyState === 'complete') {
        initPreloader();
    } else {
        window.addEventListener('load', () => {
            if ('requestIdleCallback' in window) requestIdleCallback(initPreloader);
            else setTimeout(initPreloader, 1000);
        }, { once: true });
    }

    // =========================================================================
    // PART 3: DNS PREFETCH FOR EXTERNAL LINKS
    // =========================================================================

    function initDnsPrefetch() {
        const seen = new Set();
        const currentOrigin = location.origin;

        // Collect unique external origins from visible links
        const links = document.querySelectorAll('a[href]');
        for (const link of links) {
            try {
                const url = new URL(link.href);
                if (url.origin !== currentOrigin && url.protocol.startsWith('http') && !seen.has(url.origin)) {
                    seen.add(url.origin);
                }
            } catch (e) {}
        }

        // Inject dns-prefetch hints (batch into a fragment to minimize reflows)
        if (seen.size === 0) return;
        const frag = document.createDocumentFragment();
        for (const origin of seen) {
            const hint = document.createElement('link');
            hint.rel = 'dns-prefetch';
            hint.href = origin;
            frag.appendChild(hint);
        }
        document.head.appendChild(frag);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        if ('requestIdleCallback' in window) requestIdleCallback(initDnsPrefetch);
        else setTimeout(initDnsPrefetch, 500);
    } else {
        window.addEventListener('DOMContentLoaded', () => {
            if ('requestIdleCallback' in window) requestIdleCallback(initDnsPrefetch);
            else setTimeout(initDnsPrefetch, 500);
        }, { once: true });
    }

})();
