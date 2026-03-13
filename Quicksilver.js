// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Blazing-fast browsing: LRU static asset cache, Speculation Rules prefetch/prerender, preconnect on hover, fallback prefetch for Firefox/Safari, font-display swap. Respects Cache-Control, skips APIs, stays out of service workers' way.
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

    const NO_STORE = /\bno-store\b/i;
    const FORCE_REVALIDATE = /\b(no-cache|must-revalidate)\b/i;
    const CACHEABLE_CONTENT_TYPES = /^(text\/css|text\/javascript|application\/javascript|application\/x-javascript|image\/|font\/|application\/font|application\/x-font|application\/wasm)/i;

    function getClosestLinkTarget(target) {
        if (!(target instanceof Element)) return null;
        return target.closest('a[href]');
    }

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

    // URLs in this set have Cache-Control: no-cache or must-revalidate,
    // so they are always treated as stale (triggering background revalidation)
    const forceRevalidateUrls = new Set();

    function isFresh(url) {
        if (forceRevalidateUrls.has(url)) return false;
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
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
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

    // Returns: false (uncacheable), 'revalidate' (cache but always revalidate), true (normal cache)
    function getCacheability(response) {
        const cc = response.headers.get('Cache-Control') || '';
        if (NO_STORE.test(cc)) return false;
        const ct = response.headers.get('Content-Type') || '';
        if (ct && !CACHEABLE_CONTENT_TYPES.test(ct)) return false;
        if (response.status === 206) return false;
        if (!response.ok) return false;
        if (FORCE_REVALIDATE.test(cc)) return 'revalidate';
        return true;
    }

    const shouldOverrideFetch = !navigator.serviceWorker || !navigator.serviceWorker.controller;

    if (shouldOverrideFetch && typeof unsafeWindow !== 'undefined') {
        let cachePromise = null;
        function getCache() {
            if (typeof caches === 'undefined') return Promise.reject('Cache API unavailable');
            if (!cachePromise) cachePromise = caches.open(CACHE_NAME).catch(e => {
                cachePromise = null; // allow retry on next call
                throw e;
            });
            return cachePromise;
        }

        const originalFetch = unsafeWindow.fetch;

        if (typeof originalFetch === 'function') {
            // Duck-type check for Request objects — cross-realm instanceof fails
            // between Tampermonkey sandbox and page context
            const isRequest = (obj) => obj && typeof obj === 'object' && 'url' in obj && 'method' in obj;

            unsafeWindow.fetch = async function(...args) {
                let method = 'GET';
                let urlStr = '';

                if (isRequest(args[0])) {
                    method = (args[1] && args[1].method) || args[0].method;
                    urlStr = args[0].url;
                } else {
                    method = (args[1] && args[1].method) || 'GET';
                    try { urlStr = new URL(args[0], location.href).href; }
                    catch (e) { return originalFetch.apply(this, args); }
                }

                method = String(method || 'GET').toUpperCase();

                // Bypass cache for no-cache, reload, and no-store fetch modes
                // Check init override first, then Request object's cache mode
                const cacheMode = (args[1] && args[1].cache) || (isRequest(args[0]) && args[0].cache);
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
                                    const cacheability = getCacheability(networkResponse);
                                    if (cacheability) {
                                        if (cacheability === 'revalidate') forceRevalidateUrls.add(urlStr);
                                        await cache.put(urlStr, networkResponse).catch(() => {});
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

                    const cacheability = getCacheability(networkResponse);
                    if (cacheability) {
                        if (cacheability === 'revalidate') forceRevalidateUrls.add(urlStr);
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
    }

    // Flush metadata on page hide — pagehide is bfcache-safe unlike beforeunload,
    // which can prevent instant back/forward navigation in some browsers.
    window.addEventListener('pagehide', flushMetadata);

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
        (document.head || document.documentElement).appendChild(script);
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
    // PART 3: PRECONNECT ON HOVER
    // =========================================================================
    // When the user hovers over a link, inject <link rel="preconnect"> for its
    // origin. The ~300ms hover-to-click window is enough for DNS + TCP + TLS,
    // making the subsequent navigation feel instant. Strictly better than bulk
    // DNS prefetch: it's just-in-time, does full connection setup, and adds
    // zero overhead for links the user never interacts with.

    function initPreconnectOnHover() {
        const connected = new Set();
        const currentOrigin = location.origin;
        const MAX_PRECONNECTS = 8; // browser limit on concurrent preconnects

        function preconnect(origin) {
            if (connected.has(origin) || origin === currentOrigin) return;
            if (connected.size >= MAX_PRECONNECTS) {
                // Remove the oldest hint to stay under the browser limit
                const oldest = connected.values().next().value;
                const oldLink = document.querySelector(`link[rel="preconnect"][href="${oldest}"]`);
                if (oldLink) oldLink.remove();
                connected.delete(oldest);
            }
            const hint = document.createElement('link');
            hint.rel = 'preconnect';
            hint.crossOrigin = 'anonymous';
            hint.href = origin;
            document.head.appendChild(hint);
            connected.add(origin);
        }

        // Single delegated listener on document — works for SPA-injected links too
        document.addEventListener('pointerenter', (e) => {
            const link = getClosestLinkTarget(e.target);
            if (!link) return;
            try {
                const url = new URL(link.href);
                if (url.protocol.startsWith('http')) preconnect(url.origin);
            } catch (_) {}
        }, { passive: true, capture: true });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initPreconnectOnHover();
    } else {
        window.addEventListener('DOMContentLoaded', initPreconnectOnHover, { once: true });
    }

    // =========================================================================
    // PART 4: FALLBACK PREFETCH FOR NON-CHROME BROWSERS
    // =========================================================================
    // Firefox and Safari don't support Speculation Rules. This provides similar
    // benefit by injecting <link rel="prefetch"> on mousedown/touchstart — the
    // ~100ms before navigation completes is enough to start fetching the target
    // page. Same approach as instant.page.

    function initFallbackPrefetch() {
        // Skip if Speculation Rules are supported — Part 2 handles it
        if (HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) return;

        const conn = navigator.connection;
        if (conn && (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g')) return;

        const prefetched = new Set();
        let currentPrefetch = null;

        function prefetch(href) {
            if (prefetched.has(href)) return;
            // Clean up previous hint to avoid accumulation
            if (currentPrefetch) currentPrefetch.remove();
            const hint = document.createElement('link');
            hint.rel = 'prefetch';
            hint.href = href;
            document.head.appendChild(hint);
            currentPrefetch = hint;
            prefetched.add(href);
        }

        function isEligible(link) {
            if (!link || !link.href) return false;
            try {
                const url = new URL(link.href);
                // Same-origin only, skip non-http, anchors, and current page
                if (url.origin !== location.origin) return false;
                if (!url.protocol.startsWith('http')) return false;
                if (url.pathname + url.search === location.pathname + location.search) return false;
            } catch (_) { return false; }
            // Skip download/logout links
            const href = link.getAttribute('href') || '';
            if (/\.(pdf|zip|tar|gz|exe|dmg|pkg|mp[34]|mov|doc|xls|ppt)/i.test(href)) return false;
            if (/download|logout|signout|log-out|sign-out/i.test(href)) return false;
            return true;
        }

        document.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // left click only
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) prefetch(link.href);
        }, { passive: true, capture: true });

        document.addEventListener('touchstart', (e) => {
            const link = getClosestLinkTarget(e.target);
            if (isEligible(link)) prefetch(link.href);
        }, { passive: true, capture: true });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initFallbackPrefetch();
    } else {
        window.addEventListener('DOMContentLoaded', initFallbackPrefetch, { once: true });
    }

    // =========================================================================
    // PART 5: FONT DISPLAY SWAP INJECTION
    // =========================================================================
    // Prevents Flash of Invisible Text (FOIT) by patching @font-face rules to
    // use font-display: swap. Text renders immediately with a fallback font
    // while custom fonts load, instead of showing invisible text.

    function initFontDisplaySwap() {
        function patchStyleSheets() {
            for (const sheet of document.styleSheets) {
                try {
                    const rules = sheet.cssRules || sheet.rules;
                    if (!rules) continue;
                    for (const rule of rules) {
                        if (rule instanceof CSSFontFaceRule) {
                            // Only patch if font-display is not already set
                            if (!rule.style.fontDisplay) {
                                rule.style.fontDisplay = 'swap';
                            }
                        }
                    }
                } catch (_) {
                    // CORS: can't access cross-origin stylesheet rules
                }
            }
        }

        // Patch existing stylesheets
        patchStyleSheets();

        // Patch dynamically added stylesheets via MutationObserver
        const observer = new MutationObserver((mutations) => {
            let hasNewStyles = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.tagName === 'LINK' || node.tagName === 'STYLE') {
                        hasNewStyles = true;
                        break;
                    }
                }
                if (hasNewStyles) break;
            }
            if (hasNewStyles) {
                // Defer to let the stylesheet parse
                requestAnimationFrame(patchStyleSheets);
            }
        });

        observer.observe(document.head, { childList: true });
        // Also watch body for SPAs that inject stylesheets there
        if (document.body) {
            observer.observe(document.body, { childList: true });
        } else {
            window.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true });
            }, { once: true });
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initFontDisplaySwap();
    } else {
        window.addEventListener('DOMContentLoaded', initFontDisplaySwap, { once: true });
    }

})();
