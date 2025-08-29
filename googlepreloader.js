// ==UserScript==
// @name         Google Search Hover Preload
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Preloads search result URLs on hover, bypassing Google's redirect links
// @match        https://www.google.com/search*
// @match        https://www.google.*/search*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        MAX_PRELOADS: 25,
        DEBOUNCE_DELAY: 100,
        CLEANUP_INTERVAL: 30000, // 30 seconds
        DEBUG: false // Set to true for debugging
    };

    const preloaded = new Set();
    const preloadElements = new Set();

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[Google Search Prefetch]', ...args);
    }

    // Debounce function
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    // Extract the real destination URL from Google's link structure
    function extractRealURL(link) {
        try {
            const href = link.getAttribute('href');

            // Direct external link (newer Google format)
            if (href && href.startsWith('http') && !href.includes('google.com/url?')) {
                return href;
            }

            // Extract from Google's redirect URL (/url?q=...)
            if (href && href.includes('/url?')) {
                const urlParams = new URLSearchParams(href.split('?')[1]);
                const realUrl = urlParams.get('q') || urlParams.get('url');
                if (realUrl && realUrl.startsWith('http')) {
                    return realUrl;
                }
            }

            // Try data attributes that Google uses
            const dataHref = link.getAttribute('data-href') ||
                            link.getAttribute('data-url') ||
                            link.closest('[data-href]')?.getAttribute('data-href');

            if (dataHref && dataHref.startsWith('http')) {
                return dataHref;
            }

            // Check parent elements for the real URL
            const parent = link.closest('div[data-ved]');
            if (parent) {
                const nestedLink = parent.querySelector('a[href^="http"]:not([href*="google.com"])');
                if (nestedLink) {
                    return nestedLink.href;
                }
            }

            return null;

        } catch (e) {
            log('Error extracting URL from link:', e);
            return null;
        }
    }

    // Validate if URL should be prefetched
    function isValidForPrefetch(url) {
        try {
            const urlObj = new URL(url);

            // Skip if:
            // - Google's own URLs
            // - Common file types that shouldn't be prefetched
            // - Obviously non-webpage URLs
            if (urlObj.hostname.includes('google.com') ||
                urlObj.hostname.includes('googleusercontent.com') ||
                urlObj.hostname.includes('gstatic.com') ||
                /\.(pdf|jpg|jpeg|png|gif|webp|svg|mp4|mp3|avi|zip|exe|dmg|doc|docx|xls|xlsx|ppt|pptx)$/i.test(urlObj.pathname) ||
                urlObj.protocol === 'mailto:' ||
                urlObj.protocol === 'tel:') {
                return false;
            }

            return true;

        } catch (e) {
            log('Invalid URL for prefetch:', url);
            return false;
        }
    }

    // Create prefetch link element
    function prefetchURL(url) {
        if (!url || preloaded.has(url)) {
            log('URL already preloaded or invalid:', url);
            return;
        }

        // Clean up old prefetches if we're at the limit
        if (preloaded.size >= CONFIG.MAX_PRELOADS) {
            cleanupOldest();
        }

        if (!isValidForPrefetch(url)) {
            log('URL not valid for prefetch:', url);
            return;
        }

        try {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = url;
            link.crossOrigin = 'anonymous'; // Important for cross-origin prefetch

            // Add error handling
            link.addEventListener('error', () => {
                log('Prefetch failed for:', url);
                preloaded.delete(url);
                preloadElements.delete(link);
            }, { once: true });

            link.addEventListener('load', () => {
                log('Prefetch successful for:', url);
            }, { once: true });

            document.head.appendChild(link);
            preloaded.add(url);
            preloadElements.add(link);

            log('Prefetching:', url);

        } catch (e) {
            console.warn('Failed to create prefetch for:', url, e);
        }
    }

    // Clean up oldest prefetch links
    function cleanupOldest() {
        const elementsArray = Array.from(preloadElements);
        const toRemove = elementsArray.slice(0, Math.floor(CONFIG.MAX_PRELOADS / 2));

        toRemove.forEach(element => {
            if (element.parentNode) {
                element.remove();
            }
            preloaded.delete(element.href);
            preloadElements.delete(element);
        });

        log('Cleaned up', toRemove.length, 'old prefetches');
    }

    // Detect if element is a search result link
    function isSearchResultLink(link) {
        // Check various indicators that this is a search result
        const indicators = [
            // Has Google's tracking attribute
            link.closest('[data-ved]'),
            // Classic search result container
            link.closest('.g'),
            // Modern search result selectors
            link.closest('[jsname]'),
            link.closest('[data-async-context]'),
            // Link is in a search result title or URL area
            link.closest('h3'), // Title links
            link.closest('.yuRUbf'), // URL container
            // Knowledge panel links
            link.closest('.kp-blk'),
            // Image search results
            link.closest('[data-ri]')
        ];

        return indicators.some(indicator => indicator !== null);
    }

    // Handle hover events
    const handleHover = debounce(function(event) {
        const link = event.target.closest('a[href]');
        if (!link) return;

        // Only process links that appear to be search results
        if (!isSearchResultLink(link)) {
            log('Link not identified as search result');
            return;
        }

        const realURL = extractRealURL(link);
        if (realURL) {
            log('Extracted URL from Google link:', realURL);
            prefetchURL(realURL);
        } else {
            log('Could not extract real URL from link');
        }
    }, CONFIG.DEBOUNCE_DELAY);

    // Initialize the script
    function init() {
        log('Initializing Google Search prefetch');

        // Use mouseover for better event coverage
        document.addEventListener('mouseover', handleHover, { passive: true });

        // Periodic cleanup
        setInterval(() => {
            log('Running periodic cleanup. Active prefetches:', preloaded.size);

            // Remove orphaned elements
            preloadElements.forEach(element => {
                if (!document.contains(element)) {
                    preloadElements.delete(element);
                    preloaded.delete(element.href);
                }
            });

            // If we're still at max capacity, clean up some old ones
            if (preloaded.size >= CONFIG.MAX_PRELOADS) {
                cleanupOldest();
            }

        }, CONFIG.CLEANUP_INTERVAL);

        // Cleanup on page navigation
        window.addEventListener('beforeunload', () => {
            preloaded.clear();
            preloadElements.clear();
        });
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
