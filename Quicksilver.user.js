// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Blazing-fast browsing: LRU static asset cache + Speculation Rules link prefetch. Respects Cache-Control, skips APIs, and stays out of service workers' way.
// @author       You
// @match        *://*/*
// @grant        GM_registerMenuCommand
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

    // Only cache static asset types — never HTML, JSON, or API responses
    const CACHEABLE_EXTENSIONS = /\.(js|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp)(\?|$)/i;

    // Never cache URLs matching these patterns
    const SKIP_URL_PATTERNS = [
        /\/api\//i,
        /\/graphql/i,
        /\/feed/i,
        /\/rss/i,
        /\/json/i,
        /\/ws\//i,
        /\.json(\?|$)/i,
        /\.html?(\?|$)/i,
        /\.xml(\?|$)/i,
        /\bservice-worker\b/i,
        /\bmanifest\b.*\.js/i,
        /\.m3u8(\?|$)/i,   // HLS streaming
        /\.mpd(\?|$)/i,    // DASH streaming
    ];

    // Cache-Control directives that forbid caching
    const NO_CACHE_DIRECTIVES = /\b(no-store|no-cache|private|must-revalidate)\b/i;

    // Content-Types we are willing to cache
    const CACHEABLE_CONTENT_TYPES = /^(text\/css|text\/javascript|application\/javascript|application\/x-javascript|image\/|font\/|application\/font|application\/x-font|application\/wasm)/i;

    // --- LRU METADATA STORAGE ---
    function getMetadata() {
        try {
            return JSON.parse(localStorage.getItem(METADATA_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveMetadata(metadata) {
        try {
            localStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
        } catch (e) { /* quota exceeded, ignore */ }
    }

    function touchItem(url) {
        const md = getMetadata();
        md[url] = Date.now();
        saveMetadata(md);
    }

    // --- MENU COMMAND ---
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Purge Asset Cache', async () => {
            await caches.delete(CACHE_NAME);
            try { localStorage.removeItem(METADATA_KEY); } catch (e) { /* blocked */ }
            alert('Asset cache purged.');
        });
    }

    // --- LRU PRUNER ---
    const triggerMaintenance = () => {
        if ('requestIdleCallback' in window) {
            window.requestIdleCallback(pruneCache);
        } else {
            setTimeout(pruneCache, 5000);
        }
    };

    async function pruneCache() {
        try {
            const cache = await caches.open(CACHE_NAME);
            const keys = await cache.keys();
            if (keys.length <= MAX_ITEMS) return;

            const metadata = getMetadata();
            const sorted = keys.sort((a, b) => (metadata[a.url] || 0) - (metadata[b.url] || 0));
            const toDelete = sorted.slice(0, PRUNE_CHUNK);

            await Promise.all(toDelete.map(req => {
                delete metadata[req.url];
                return cache.delete(req);
            }));
            saveMetadata(metadata);
            console.log(`[Quicksilver] Pruned ${toDelete.length} LRU items`);
        } catch (err) {
            console.warn('[Quicksilver] Prune error:', err);
        }
    }

    // --- HELPERS ---
    function isCacheableUrl(url) {
        // Must match a known static extension
        if (!CACHEABLE_EXTENSIONS.test(url)) return false;
        // Must not match any skip pattern
        if (SKIP_URL_PATTERNS.some(re => re.test(url))) return false;
        return true;
    }

    function isCacheableResponse(response) {
        // Check Cache-Control
        const cc = response.headers.get('Cache-Control') || '';
        if (NO_CACHE_DIRECTIVES.test(cc)) return false;

        // Check Content-Type
        const ct = response.headers.get('Content-Type') || '';
        if (ct && !CACHEABLE_CONTENT_TYPES.test(ct)) return false;

        // Skip partial content
        if (response.status === 206) return false;

        return response.ok;
    }

    // --- CORE: FETCH OVERRIDE ---
    // Only override if no service worker is controlling this page
    const shouldOverrideFetch = !navigator.serviceWorker || !navigator.serviceWorker.controller;

    if (shouldOverrideFetch) {
        let cachePromise = null;
        function getCache() {
            if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
            return cachePromise;
        }

        const originalFetch = window.fetch;

        window.fetch = async function(...args) {
            // Extract method and URL without creating a Request object
            // (creating a Request can consume a ReadableStream body, breaking POST/PUT)
            let method, url;
            if (args[0] instanceof Request) {
                method = args[0].method;
                url = args[0].url;
            } else {
                method = (args[1] && args[1].method) || 'GET';
                try { url = new URL(args[0], location.href).href; } catch (e) {
                    return originalFetch.apply(this, args);
                }
            }

            // Only intercept GET requests to cacheable URLs
            if (method !== 'GET' || !isCacheableUrl(url)) {
                return originalFetch.apply(this, args);
            }

            const request = new Request(url);

            try {
                const cache = await getCache();
                const cachedResponse = await cache.match(request);

                if (cachedResponse) {
                    const responseToReturn = cachedResponse.clone();

                    // Update LRU timestamp in background
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(() => touchItem(request.url));
                    } else {
                        setTimeout(() => touchItem(request.url), 0);
                    }

                    // Background revalidation
                    originalFetch.apply(this, args)
                        .then(async (networkResponse) => {
                            if (isCacheableResponse(networkResponse)) {
                                await cache.put(request, networkResponse.clone()).catch(() => {});
                                touchItem(request.url);
                                if (Math.random() < 0.05) triggerMaintenance();
                            }
                        })
                        .catch(() => {});

                    return responseToReturn;
                }

                // Cache miss — fetch from network
                const networkResponse = await originalFetch.apply(this, args);

                if (isCacheableResponse(networkResponse)) {
                    cache.put(request, networkResponse.clone())
                        .then(() => {
                            touchItem(request.url);
                            if (Math.random() < 0.05) triggerMaintenance();
                        })
                        .catch(() => {});
                }

                return networkResponse;
            } catch (error) {
                // If cache API fails, fall through to normal fetch
                return originalFetch.apply(this, args);
            }
        };

        console.log('[Quicksilver] Static asset cache active (service-worker aware)');
    } else {
        console.log('[Quicksilver] Skipped — page is controlled by a service worker');
    }

    // =========================================================================
    // PART 2: LINK PRELOADER VIA SPECULATION RULES (runs at idle)
    // =========================================================================

    function initPreloader() {
        // Feature detection
        if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) {
            console.log('[Quicksilver] Speculation Rules API not supported');
            return;
        }

        // Network check
        const conn = navigator.connection;
        if (conn) {
            if (conn.saveData) return;
            if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return;
        }

        const DOWNLOAD_EXTENSIONS = [
            '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
            '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
            '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
        ];

        // Build exclusion rules — no DOM modification needed
        const excludeOr = [
            { "href_matches": "javascript:*" },
            { "href_matches": "mailto:*" },
            { "href_matches": "tel:*" },
            { "href_matches": "*download*" },
            { "href_matches": "*attachment*" },
            { "href_matches": "*logout*" },
            { "href_matches": "*signout*" },
            { "href_matches": "*sign-out*" },
            { "href_matches": "*log-out*" },
            ...DOWNLOAD_EXTENSIONS.map(ext => ({ "href_matches": `*${ext}` }))
        ];

        const rules = {
            "prefetch": [{
                "where": {
                    "and": [
                        { "href_matches": "/*" },
                        { "not": { "or": excludeOr } }
                    ]
                },
                "eagerness": "moderate"
            }]
        };

        // Inject once
        const script = document.createElement('script');
        script.type = 'speculationrules';
        script.textContent = JSON.stringify(rules);
        document.head.appendChild(script);
        console.log('[Quicksilver] Speculation rules injected (moderate eagerness, same-origin only)');
    }

    // Run preloader at idle so it doesn't block page load
    if (document.readyState === 'complete') {
        initPreloader();
    } else {
        window.addEventListener('load', () => {
            if ('requestIdleCallback' in window) {
                requestIdleCallback(initPreloader);
            } else {
                setTimeout(initPreloader, 1000);
            }
        }, { once: true });
    }

})();
