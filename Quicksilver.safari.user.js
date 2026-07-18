// ==UserScript==
// @name         Quicksilver Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.1.0
// @description  Safari-friendly browsing acceleration using safe connection, navigation, and font hints.
// @author       nickleechn
// @match        *://*/*
// @inject-into  content
// @grant        none
// @noframes
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.safari.user.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.safari.user.js
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window) return;

    const MAX_PRECONNECTS = 8;
    const MAX_WARMED_URLS = 64;
    const MAX_INFLIGHT_WARMS = 2;
    const DOWNLOAD_EXTENSION = /\.(?:7z|apk|avi|bin|deb|dmg|docx?|exe|flv|gz|img|iso|mkv|mov|mp3|mp4|msi|pdf|pkg|pptx?|rar|rpm|tar|webm|wmv|xlsx?|zip)(?:$|[?#])/i;
    // Prefer false positives over warming authenticated or mutating GETs.
    const SENSITIVE_PATH = /(?:^|[-_/])(?:account|admin|api|auth|billing|cart|checkout|confirm|dashboard|delete|destroy|disable|edit|graphql|login|logout|messages?|order|password|payment|profile|register|remove|reset|revoke|settings|sign[-_]?in|sign[-_]?out|signup|subscribe|unsubscribe)(?:$|[-_/])/i;
    const SENSITIVE_QUERY_KEY = /^(?:access_token|action|auth|code|delete|destroy|disable|logout|password|redirect|remove|revoke|session|signout|token|unsubscribe)$/i;

    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const preconnects = new Map();
    const warmedUrls = new Set();
    const warmControllers = new Set();
    const cleanupCallbacks = [];
    const timers = new Set();

    let stopped = true;
    let fontObserver = null;
    let fontPatchTimer = 0;
    let inflightWarms = 0;

    function isSlowOrMeteredConnection() {
        if (connection) {
            if (connection.saveData) return true;
            if (connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g') return true;
        }

        // Safari does not expose Network Information API. Use coarse signals so
        // warming still backs off when the tab is hidden or the browser is offline.
        if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return true;
        if (document.visibilityState === 'hidden') return true;
        return false;
    }

    function addListener(target, type, listener, options) {
        target.addEventListener(type, listener, options);
        cleanupCallbacks.push(function () {
            target.removeEventListener(type, listener, options);
        });
    }

    function schedule(callback, delay) {
        const timer = window.setTimeout(function () {
            timers.delete(timer);
            if (!stopped) callback();
        }, delay);
        timers.add(timer);
        return timer;
    }

    function rememberBounded(set, value, maximum) {
        if (set.has(value)) set.delete(value);
        set.add(value);
        if (set.size > maximum) set.delete(set.values().next().value);
    }

    function getLink(target) {
        const el = target && target.nodeType === 3 ? target.parentElement : target;
        return el && el.nodeType === 1 && typeof el.closest === 'function'
            ? el.closest('a[href]')
            : null;
    }

    function parseHttpUrl(value) {
        try {
            const url = new URL(value, location.href);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
        } catch (_) {
            return null;
        }
    }

    function hasSensitiveQuery(url) {
        for (const key of url.searchParams.keys()) {
            if (SENSITIVE_QUERY_KEY.test(key)) return true;
        }
        return false;
    }

    function hasUnsafeRelationship(link) {
        const relationships = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
        return relationships.includes('external') || relationships.includes('nofollow') || relationships.includes('sponsored');
    }

    function isEligibleNavigation(link) {
        if (!link || link.hasAttribute('download') || hasUnsafeRelationship(link)) return false;

        const target = (link.getAttribute('target') || '').trim().toLowerCase();
        // With @noframes this script only runs in the top-level document, so
        // _top is the same browsing context as _self. Google uses _top for
        // ordinary navigation such as its Images link.
        if (target && target !== '_self' && target !== '_top') return false;

        const rawHref = link.getAttribute('href') || '';
        if (!rawHref || DOWNLOAD_EXTENSION.test(rawHref)) return false;

        const url = parseHttpUrl(rawHref);
        if (!url || url.origin !== location.origin) return false;
        if (DOWNLOAD_EXTENSION.test(url.pathname)) return false;
        if (SENSITIVE_PATH.test(url.pathname) || hasSensitiveQuery(url)) return false;

        url.hash = '';
        const current = new URL(location.href);
        current.hash = '';
        return url.href !== current.href;
    }

    function addPreconnect(origin) {
        if (stopped || origin === location.origin || preconnects.has(origin)) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;

        if (preconnects.size >= MAX_PRECONNECTS) {
            const oldestOrigin = preconnects.keys().next().value;
            const oldestHint = preconnects.get(oldestOrigin);
            if (oldestHint) oldestHint.remove();
            preconnects.delete(oldestOrigin);
        }

        const hint = document.createElement('link');
        hint.rel = 'preconnect';
        hint.href = origin;
        hint.crossOrigin = 'anonymous';
        parent.appendChild(hint);
        preconnects.set(origin, hint);
    }

    function preconnectForLink(link) {
        if (!link) return;
        const url = parseHttpUrl(link.href);
        if (url) addPreconnect(url.origin);
    }

    function warmNavigation(link) {
        if (stopped || isSlowOrMeteredConnection() || inflightWarms >= MAX_INFLIGHT_WARMS) return;
        if (!isEligibleNavigation(link)) return;

        const url = parseHttpUrl(link.href);
        if (!url || url.origin !== location.origin) return;
        url.hash = '';
        if (warmedUrls.has(url.href)) return;
        rememberBounded(warmedUrls, url.href, MAX_WARMED_URLS);

        // Safari leaves <link rel="prefetch"> disabled. Same-origin fetch can
        // still populate the HTTP cache ahead of the impending navigation.
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (controller) warmControllers.add(controller);
        inflightWarms += 1;

        const request = {
            method: 'GET',
            credentials: 'same-origin',
            // Fail closed on cross-origin redirects while allowing same-origin hops.
            mode: 'same-origin',
            // Use cache when present; otherwise fetch and store for the click.
            cache: 'force-cache',
            redirect: 'follow',
            // Chromium honors this; Safari ignores it safely.
            priority: 'low',
            referrerPolicy: 'strict-origin-when-cross-origin',
            headers: {
                Purpose: 'prefetch',
                'Sec-Purpose': 'prefetch'
            }
        };
        if (controller) request.signal = controller.signal;

        Promise.resolve()
            .then(function () {
                return fetch(url.href, request);
            })
            .then(function (response) {
                // Drain the body so the response can settle into cache/memory.
                if (response && response.body && typeof response.body.cancel === 'function') {
                    return response.body.cancel();
                }
                return response && typeof response.arrayBuffer === 'function'
                    ? response.arrayBuffer().then(function () {})
                    : undefined;
            })
            .catch(function () {})
            .then(function () {
                inflightWarms = Math.max(0, inflightWarms - 1);
                if (controller) warmControllers.delete(controller);
            });
    }

    function handlePointerIntent(event) {
        const link = getLink(event.target);
        preconnectForLink(link);
    }

    function handleFocusIntent(event) {
        // Preconnect only on focus. Full document warming on every focused
        // nav link is too aggressive for keyboard traversal.
        preconnectForLink(getLink(event.target));
    }

    function handleMouseDown(event) {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        warmNavigation(getLink(event.target));
    }

    function handleTouchStart(event) {
        if (event.touches && event.touches.length !== 1) return;
        warmNavigation(getLink(event.target));
    }

    function isSameOriginStyleSheet(sheet) {
        if (!sheet.href) return true;
        const url = parseHttpUrl(sheet.href);
        return Boolean(url && url.origin === location.origin);
    }

    function patchFontRules(rules) {
        if (!rules) return;
        for (const rule of rules) {
            if (window.CSSFontFaceRule && rule instanceof CSSFontFaceRule) {
                if (!rule.style.getPropertyValue('font-display')) {
                    rule.style.setProperty('font-display', 'swap');
                }
                continue;
            }

            try {
                if (rule.cssRules) patchFontRules(rule.cssRules);
            } catch (_) {}
        }
    }

    function patchSameOriginFonts() {
        fontPatchTimer = 0;
        for (const sheet of document.styleSheets) {
            if (!isSameOriginStyleSheet(sheet)) continue;
            try {
                patchFontRules(sheet.cssRules);
            } catch (_) {}
        }
    }

    function scheduleFontPatch() {
        if (stopped || fontPatchTimer) return;
        // Safari may throttle requestAnimationFrame in background tabs. A
        // zero-delay task also gives newly inserted stylesheets time to parse.
        fontPatchTimer = schedule(patchSameOriginFonts, 0);
    }

    function installFontObserver() {
        patchSameOriginFonts();
        if (typeof MutationObserver !== 'function') return;

        fontObserver = new MutationObserver(function (mutations) {
            const hasStyleChange = mutations.some(function (mutation) {
                return Array.from(mutation.addedNodes).some(function (node) {
                    if (!node || node.nodeType !== 1) return false;
                    return (typeof node.matches === 'function' && node.matches('style, link[rel~="stylesheet"]')) ||
                        (typeof node.querySelector === 'function' && node.querySelector('style, link[rel~="stylesheet"]'));
                });
            });
            if (hasStyleChange) scheduleFontPatch();
        });

        fontObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function runWhenDomReady(callback) {
        if (document.readyState === 'loading') {
            addListener(document, 'DOMContentLoaded', callback, { once: true });
        } else {
            callback();
        }
    }

    function cleanup() {
        if (stopped) return;
        stopped = true;

        while (cleanupCallbacks.length) cleanupCallbacks.pop()();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();

        if (fontObserver) {
            fontObserver.disconnect();
            fontObserver = null;
        }
        fontPatchTimer = 0;
        for (const controller of warmControllers) {
            try {
                controller.abort();
            } catch (_) {}
        }
        warmControllers.clear();
        inflightWarms = 0;

        for (const hint of preconnects.values()) hint.remove();
        preconnects.clear();
        warmedUrls.clear();
    }

    function activate() {
        if (!stopped) return;
        stopped = false;

        addListener(document, 'pointerover', handlePointerIntent, { passive: true, capture: true });
        addListener(document, 'focusin', handleFocusIntent, true);
        addListener(document, 'mousedown', handleMouseDown, { passive: true, capture: true });
        addListener(document, 'touchstart', handleTouchStart, { passive: true, capture: true });
        runWhenDomReady(installFontObserver);
    }

    // Keep lifecycle listeners outside cleanupCallbacks. Safari can preserve
    // this document in its back/forward cache after pagehide, so pageshow must
    // be able to reactivate the same userscript instance when it is restored.
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('pageshow', activate);
    activate();
})();
