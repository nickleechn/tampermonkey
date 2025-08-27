// ==UserScript==
// @name         Hover Preload for Safari
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Preloads URLs when hovering over links, optimised for Safari’s quirks.
// @author       Grok
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Store preloaded URLs with a max size to avoid memory bloat
    const preloaded = new Set();
    const MAX_PRELOADS = 50;

    // Debounce function with adaptive delay (shorter for desktop, longer for mobile)
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    const DEBOUNCE_DELAY = isMobile ? 150 : 75;

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    // Create and append prefetch link, with cleanup for old links
    function prefetchLink(url) {
        if (preloaded.has(url) || preloaded.size >= MAX_PRELOADS) {
            // Clean up oldest prefetch if we hit the limit
            if (preloaded.size >= MAX_PRELOADS) {
                const oldestUrl = preloaded.values().next().value;
                preloaded.delete(oldestUrl);
                const oldLink = document.querySelector(`link[href="${oldestUrl}"]`);
                if (oldLink) oldLink.remove();
            }
            return;
        }

        try {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = url;
            link.as = 'document';
            document.head.appendChild(link);
            preloaded.add(url);
        } catch (e) {
            console.warn(`Failed to prefetch ${url}: ${e.message}`);
        }
    }

    // Handle hover event
    const handleHover = debounce(function(event) {
        const link = event.target.closest('a[href]');
        if (!link) return;

        let url;
        try {
            // Resolve relative URLs properly
            url = new URL(link.href, window.location.origin).href;
        } catch (e) {
            console.warn(`Invalid URL: ${link.href}`);
            return;
        }

        // Skip non-HTTP URLs, same page, hash links, or non-HTML links
        if (!url.startsWith('http') ||
            url === window.location.href ||
            link.hash ||
            /\.(pdf|jpg|jpeg|png|gif|mp4|zip)$/i.test(url)) {
            return;
        }

        // Only prefetch same-origin URLs to avoid CORS issues
        const currentOrigin = window.location.origin;
        if (new URL(url).origin !== currentOrigin) return;

        prefetchLink(url);
    }, DEBOUNCE_DELAY);

    // Use mouseenter for better performance
    document.addEventListener('mouseenter', handleHover, { passive: true });

    // Periodic cleanup of preloaded links every 5 minutes
    setInterval(() => {
        const links = document.querySelectorAll('link[rel="prefetch"]');
        links.forEach(link => {
            if (!preloaded.has(link.href)) link.remove();
        });
        preloaded.clear();
    }, 5 * 60 * 1000);

    // Cleanup on page unload (just in case)
    window.addEventListener('unload', () => {
        preloaded.clear();
    });
})();
