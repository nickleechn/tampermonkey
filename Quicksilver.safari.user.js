// ==UserScript==
// @name         Quicksilver Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.0.0
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
    const WARM_HINT_LIFETIME_MS = 15000;
    const FONT_OBSERVER_LIFETIME_MS = 30000;
    const DOWNLOAD_EXTENSION = /\.(?:7z|apk|avi|bin|deb|dmg|docx?|exe|flv|gz|img|iso|mkv|mov|mp3|mp4|msi|pdf|pkg|pptx?|rar|rpm|tar|webm|wmv|xlsx?|zip)(?:$|[?#])/i;
    const SENSITIVE_PATH = /(?:^|[-_/])(?:account|admin|auth|cart|checkout|delete|destroy|disable|login|logout|order|payment|remove|revoke|sign[-_]?in|sign[-_]?out|unsubscribe)(?:$|[-_/])/i;
    const SENSITIVE_QUERY_KEY = /^(?:access_token|action|auth|code|delete|destroy|disable|logout|password|remove|revoke|session|signout|token|unsubscribe)$/i;

    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const preconnects = new Map();
    const warmedUrls = new Set();
    const warmHints = new Set();
    const cleanupCallbacks = [];
    const timers = new Set();

    let stopped = false;
    let fontObserver = null;
    let fontPatchFrame = 0;

    function isSlowOrMeteredConnection() {
        return Boolean(connection && (
            connection.saveData ||
            connection.effectiveType === 'slow-2g' ||
            connection.effectiveType === '2g'
        ));
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
        return target instanceof Element ? target.closest('a[href]') : null;
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
        if (target && target !== '_self') return false;

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
        if (stopped || isSlowOrMeteredConnection() || !isEligibleNavigation(link)) return;

        const url = new URL(link.href);
        url.hash = '';
        if (warmedUrls.has(url.href)) return;
        rememberBounded(warmedUrls, url.href, MAX_WARMED_URLS);

        const parent = document.head || document.documentElement;
        if (!parent) return;

        const hint = document.createElement('link');
        hint.rel = 'prefetch';
        hint.href = url.href;
        hint.referrerPolicy = 'strict-origin-when-cross-origin';
        parent.appendChild(hint);
        warmHints.add(hint);

        schedule(function () {
            hint.remove();
            warmHints.delete(hint);
        }, WARM_HINT_LIFETIME_MS);
    }

    function handlePointerIntent(event) {
        const link = getLink(event.target);
        preconnectForLink(link);
    }

    function handleFocusIntent(event) {
        const link = getLink(event.target);
        preconnectForLink(link);
        warmNavigation(link);
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
        fontPatchFrame = 0;
        for (const sheet of document.styleSheets) {
            if (!isSameOriginStyleSheet(sheet)) continue;
            try {
                patchFontRules(sheet.cssRules);
            } catch (_) {}
        }
    }

    function scheduleFontPatch() {
        if (stopped || fontPatchFrame) return;
        fontPatchFrame = window.requestAnimationFrame(patchSameOriginFonts);
    }

    function installFontObserver() {
        patchSameOriginFonts();
        if (typeof MutationObserver !== 'function') return;

        fontObserver = new MutationObserver(function (mutations) {
            const hasStyleChange = mutations.some(function (mutation) {
                return Array.from(mutation.addedNodes).some(function (node) {
                    return node instanceof Element && (node.matches('style, link[rel~="stylesheet"]') || node.querySelector('style, link[rel~="stylesheet"]'));
                });
            });
            if (hasStyleChange) scheduleFontPatch();
        });

        fontObserver.observe(document.documentElement, { childList: true, subtree: true });
        schedule(function () {
            if (fontObserver) {
                fontObserver.disconnect();
                fontObserver = null;
            }
        }, FONT_OBSERVER_LIFETIME_MS);
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

        if (fontObserver) fontObserver.disconnect();
        if (fontPatchFrame) cancelAnimationFrame(fontPatchFrame);
        for (const hint of preconnects.values()) hint.remove();
        for (const hint of warmHints) hint.remove();

        preconnects.clear();
        warmedUrls.clear();
        warmHints.clear();
    }

    addListener(document, 'pointerover', handlePointerIntent, { passive: true, capture: true });
    addListener(document, 'focusin', handleFocusIntent, true);
    addListener(document, 'mousedown', handleMouseDown, { passive: true, capture: true });
    addListener(document, 'touchstart', handleTouchStart, { passive: true, capture: true });
    addListener(window, 'pagehide', cleanup, { once: true });
    runWhenDomReady(installFontObserver);
})();
