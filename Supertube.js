// ==UserScript==
// @name         SuperTube
// @namespace    https://youtube.com/
// @version      3.0.0
// @description  Codec filtering, analytics blocking, and auto-selection of the highest available quality (1080p Premium when present). Optimised for Safari.
// @author       you
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @exclude      https://www.youtube.com/live_chat*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ==================================================================
     * PART A — Early hooks (must run at document-start)
     * ================================================================== */

    /* --- A1. Codec filtering --------------------------------------------
     * Pick a profile based on your Mac:
     *   'h264-only' : Intel Mac (capped at 1080p)
     *   'no-av1'    : M1 / M2 (default; keeps 4K/8K via VP9 HW decode)
     *   'all'       : M3 / M4+ or no filtering
     * ------------------------------------------------------------------ */
    const CODEC_PROFILE = 'no-av1';

    let blockedCodecs = null;
    if (CODEC_PROFILE === 'h264-only') blockedCodecs = /vp0?9|av0?1/i;
    else if (CODEC_PROFILE === 'no-av1') blockedCodecs = /av0?1/i;

    if (blockedCodecs) {
        if (window.MediaSource && MediaSource.isTypeSupported) {
            const _ts = MediaSource.isTypeSupported.bind(MediaSource);
            MediaSource.isTypeSupported = function (mime) {
                if (typeof mime === 'string' && blockedCodecs.test(mime)) return false;
                return _ts(mime);
            };
        }
        if (window.HTMLVideoElement) {
            const _vp = HTMLVideoElement.prototype.canPlayType;
            HTMLVideoElement.prototype.canPlayType = function (mime) {
                if (typeof mime === 'string' && blockedCodecs.test(mime)) return '';
                return _vp.call(this, mime);
            };
            const _ap = HTMLAudioElement.prototype.canPlayType;
            HTMLAudioElement.prototype.canPlayType = function (mime) {
                if (typeof mime === 'string' && blockedCodecs.test(mime)) return '';
                return _ap.call(this, mime);
            };
        }
    }

    /* --- A2. Block analytics / logging endpoints ----------------------- */
    const blockedURLPatterns = [
        '/youtubei/v1/log_event',
        '/api/stats/qoe',
        '/api/stats/atr',
        '/api/stats/watchtime',
        '/ptracking',
        '/generate_204',
        '/csi_204',
        '/pagead/',
        'doubleclick.net',
        'googleadservices.com',
    ];
    const isBlockedURL = (url) => {
        if (typeof url !== 'string') {
            try { url = url.url || String(url); } catch { return false; }
        }
        return blockedURLPatterns.some(p => url.includes(p));
    };

    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (isBlockedURL(url)) return Promise.resolve(new Response('', { status: 204 }));
        } catch {}
        return _fetch.call(this, input, init);
    };

    const _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__blocked = isBlockedURL(url);
        return _xhrOpen.call(this, method, url, ...rest);
    };
    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        if (this.__blocked) return;
        return _xhrSend.call(this, body);
    };

    if (navigator.sendBeacon) {
        const _b = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            if (isBlockedURL(url)) return true;
            return _b(url, data);
        };
    }

    /* --- A3. Collapse YT's deferred-init timers ------------------------
     * NOTE: nativeSetTimeout is preserved for CrystalClear (Part B), which
     * relies on real 1s/2.5s/5s polling delays. Without this snapshot,
     * the override below would collapse those too. */
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function (fn, delay, ...args) {
        // Only collapse the suspiciously-round long delay YT uses for init.
        // 1000/3000 removed — too easily hit by legitimate code (incl. ours).
        if (typeof fn === 'function' && delay === 5000) {
            return nativeSetTimeout(fn, 0, ...args);
        }
        return nativeSetTimeout(fn, delay, ...args);
    };
    if (window.requestIdleCallback) {
        const _ric = window.requestIdleCallback.bind(window);
        window.requestIdleCallback = function (cb, opts) {
            return _ric(cb, Object.assign({}, opts || {}, { timeout: 50 }));
        };
    }

    /* --- A4. Spoof window.chrome --------------------------------------- */
    if (!window.chrome) {
        Object.defineProperty(window, 'chrome', {
            value: { runtime: {}, csi: () => ({}), loadTimes: () => ({}) },
            writable: false,
            configurable: false,
        });
    }

    /* --- A5. CSS: hide hover previews, ambient, shorts ----------------- */
    const css = `
        ytd-video-preview, #video-preview,
        ytd-moving-thumbnail-renderer,
        ytd-thumbnail-overlay-loading-preview-renderer { display: none !important; }

        #cinematics, .ytp-cinematics-container,
        .ytd-cinematic-container-renderer { display: none !important; }

        ytd-rich-shelf-renderer[is-shorts],
        ytd-reel-shelf-renderer,
        ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
        a[title="Shorts"],
        ytd-mini-guide-entry-renderer[aria-label="Shorts"] { display: none !important; }

        ytd-masthead, #masthead-container {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);

    /* --- A6. Preconnect to media CDNs ---------------------------------- */
    const hosts = [
        'https://www.youtube.com',
        'https://i.ytimg.com',
        'https://yt3.ggpht.com',
        'https://googlevideo.com',
        'https://r1---sn-googlevideo.googlevideo.com',
        'https://r2---sn-googlevideo.googlevideo.com',
        'https://r3---sn-googlevideo.googlevideo.com',
        'https://r4---sn-googlevideo.googlevideo.com',
    ];
    for (const h of hosts) {
        const l = document.createElement('link');
        l.rel = 'preconnect';
        l.href = h;
        l.crossOrigin = 'anonymous';
        (document.head || document.documentElement).appendChild(l);
    }

    /* ==================================================================
     * PART B — CrystalClear: pick highest quality, prefer 1080p Premium
     * Deferred until DOM is ready.
     * ================================================================== */
    const startCrystalClear = () => {
        const DEBUG = false;
        const APPLY_DELAYS_MS = [250, 1000, 2500, 5000];
        const OBSERVER_DEBOUNCE_MS = 250;
        const QUALITY_ORDER = [
            'highres', 'hd2880', 'hd2160', 'hd1440',
            'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'
        ];
        const PREMIUM_RE = /\b(premium|enhanced bitrate)\b/i;
        const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

        let currentVideoKey = '';
        let scheduledTimers = new Set();
        let watchedVideoElement = null;
        let removeWatchedVideoListeners = null;
        let premiumAttemptedForVideo = '';
        let observer = null;
        let observerDebounceTimer = null;
        let activeScheduleVideoKey = '';
        let autonavDisabledForVideo = '';

        const log = (...a) => { if (DEBUG) console.debug('[CrystalClear]', ...a); };
        const wait = (ms) => new Promise(r => nativeSetTimeout(r, ms));
        const normalizeText = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const getCurrentVideoKey = () => {
            try {
                const url = new URL(location.href);
                return url.searchParams.get('v') || url.pathname;
            } catch { return location.href; }
        };

        const getPlayer = () =>
            document.getElementById('movie_player') ||
            document.querySelector('.html5-video-player');

        const getVideoElement = () => document.querySelector('video');

        const getAvailableQualityLevels = (player) => {
            if (!player || typeof player.getAvailableQualityLevels !== 'function') return [];
            try {
                const levels = player.getAvailableQualityLevels();
                return Array.isArray(levels) ? levels.filter(Boolean) : [];
            } catch { return []; }
        };

        const getAvailableQualityData = (player) => {
            if (!player || typeof player.getAvailableQualityData !== 'function') return [];
            try {
                const data = player.getAvailableQualityData();
                return Array.isArray(data) ? data.filter(Boolean) : [];
            } catch { return []; }
        };

        const rankQuality = (q) => {
            const i = QUALITY_ORDER.indexOf(q);
            return i === -1 ? QUALITY_ORDER.length : i;
        };

        const chooseTargetQuality = (levels, qualityData) => {
            const uniqueLevels = Array.from(new Set(levels)).sort((a, b) => rankQuality(a) - rankQuality(b));
            if (!uniqueLevels.length) return null;
            const bestQuality = uniqueLevels[0];
            const matchingData = qualityData.filter(e => e.quality === bestQuality);
            const premiumData = matchingData.find(e => PREMIUM_RE.test(
                [e.qualityLabel, e.label, e.name].filter(Boolean).join(' ')
            ));
            return {
                quality: bestQuality,
                wantsPremium1080: bestQuality === 'hd1080' && Boolean(premiumData),
                displayLabel: (premiumData || matchingData[0] || {}).qualityLabel || ''
            };
        };

        const persistPlayerQuality = (quality) => {
            try {
                const current = localStorage.getItem('yt-player-quality');
                if (current) {
                    const parsed = JSON.parse(current);
                    if (parsed && parsed.data === quality) return;
                }
                const now = Date.now();
                localStorage.setItem('yt-player-quality', JSON.stringify({
                    data: quality, expiration: now + MONTH_MS, creation: now
                }));
            } catch {}
        };

        const applyQualityViaApi = (player, quality) => {
            try {
                if (typeof player.setPlaybackQualityRange === 'function') {
                    player.setPlaybackQualityRange(quality, quality);
                    return;
                }
            } catch {}
            try {
                if (typeof player.setPlaybackQuality === 'function') {
                    player.setPlaybackQuality(quality);
                }
            } catch {}
        };

        const disableAutonavOnce = (player) => {
            const key = getCurrentVideoKey();
            if (!player || autonavDisabledForVideo === key) return;
            try {
                if (typeof player.setAutonavState === 'function') {
                    player.setAutonavState(1); // 1 = disabled
                    autonavDisabledForVideo = key;
                }
            } catch {}
        };

        const selectPremium1080InMenu = async (targetLabel) => {
            const player = getPlayer();
            if (!player) return false;
            const settingsButton = player.querySelector('.ytp-settings-button');
            if (!settingsButton) return false;

            const clickIfNeeded = (el) => { if (!el) return false; el.click(); return true; };
            const closeSettings = () => {
                const expanded = player.querySelector('.ytp-settings-button[aria-expanded="true"]');
                if (expanded) expanded.click();
            };

            let didSelect = false;
            try {
                if (settingsButton.getAttribute('aria-expanded') !== 'true') {
                    settingsButton.click();
                    await wait(120);
                }
                const qualityEntry = Array.from(player.querySelectorAll('.ytp-menuitem'))
                    .find(i => normalizeText(i.textContent).includes('quality'));
                if (!clickIfNeeded(qualityEntry)) { closeSettings(); return false; }
                await wait(120);

                const targetText = normalizeText(targetLabel);
                const premiumOption = Array.from(player.querySelectorAll('.ytp-menuitem'))
                    .find(item => {
                        const text = normalizeText(item.textContent);
                        if (!text.includes('1080p')) return false;
                        if (!PREMIUM_RE.test(text)) return false;
                        return !targetText || text.includes(targetText) || targetText.includes(text);
                    });

                if (!clickIfNeeded(premiumOption)) { closeSettings(); return false; }
                log('Selected 1080p Premium');
                didSelect = true;
                return true;
            } catch (err) {
                log('Premium menu selection failed', err);
                return false;
            } finally {
                if (!didSelect) nativeSetTimeout(closeSettings, 50);
            }
        };

        const applyBestQuality = async (reason) => {
            const player = getPlayer();
            if (!player) return;

            disableAutonavOnce(player);

            const levels = getAvailableQualityLevels(player);
            if (!levels.length) { log('No quality levels yet', reason); return; }

            const choice = chooseTargetQuality(levels, getAvailableQualityData(player));
            if (!choice) return;

            persistPlayerQuality(choice.quality);
            applyQualityViaApi(player, choice.quality);
            log('Applied', reason, choice.quality);

            const videoKey = getCurrentVideoKey();
            if (!choice.wantsPremium1080 || premiumAttemptedForVideo === videoKey) return;
            premiumAttemptedForVideo = videoKey;
            await wait(700);
            await selectPremium1080InMenu(choice.displayLabel);
        };

        const clearScheduledApplies = () => {
            scheduledTimers.forEach(id => window.clearTimeout(id));
            scheduledTimers.clear();
            activeScheduleVideoKey = '';
        };

        const scheduleApply = (reason, forceNewCycle) => {
            const videoKey = getCurrentVideoKey();
            if (!forceNewCycle && activeScheduleVideoKey === videoKey && scheduledTimers.size) return;
            clearScheduledApplies();
            activeScheduleVideoKey = videoKey;
            APPLY_DELAYS_MS.forEach(delay => {
                const id = nativeSetTimeout(() => {
                    scheduledTimers.delete(id);
                    applyBestQuality(reason + ':' + delay).finally(() => {
                        if (!scheduledTimers.size) activeScheduleVideoKey = '';
                    });
                }, delay);
                scheduledTimers.add(id);
            });
        };

        const handleVideoChange = (reason) => {
            const next = getCurrentVideoKey();
            const isNew = next !== currentVideoKey;
            if (isNew) installObserver();
            if (next !== currentVideoKey) {
                currentVideoKey = next;
                premiumAttemptedForVideo = '';
            }
            scheduleApply(reason, isNew);
        };

        const clearObserverDebounce = () => {
            if (!observerDebounceTimer) return;
            window.clearTimeout(observerDebounceTimer);
            observerDebounceTimer = null;
        };

        const disconnectObserver = () => {
            clearObserverDebounce();
            if (!observer) return;
            observer.disconnect();
            observer = null;
        };

        const getObservationRoot = () =>
            document.querySelector('#player') ||
            document.getElementById('movie_player') ||
            document.querySelector('ytd-watch-flexy') ||
            document.body;

        const attachVideoListeners = () => {
            const video = getVideoElement();
            if (!video || video === watchedVideoElement) return;
            if (typeof removeWatchedVideoListeners === 'function') {
                removeWatchedVideoListeners();
                removeWatchedVideoListeners = null;
            }
            watchedVideoElement = video;
            disconnectObserver();
            const handlers = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].map(name => {
                const h = () => handleVideoChange('video-' + name);
                video.addEventListener(name, h, { passive: true });
                return { name, h };
            });
            removeWatchedVideoListeners = () => {
                handlers.forEach(({ name, h }) => video.removeEventListener(name, h));
            };
            scheduleApply('video-attached', true);
        };

        const installNavigationListeners = () => {
            ['yt-navigate-finish', 'spfdone', 'popstate'].forEach(name => {
                window.addEventListener(name, () => handleVideoChange(name), { passive: true });
                document.addEventListener(name, () => handleVideoChange(name), { passive: true });
            });
            document.addEventListener('yt-page-data-updated',
                () => handleVideoChange('yt-page-data-updated'), { passive: true });
        };

        function installObserver() {
            const root = getObservationRoot();
            if (!root) return;
            disconnectObserver();
            observer = new MutationObserver(() => {
                clearObserverDebounce();
                observerDebounceTimer = nativeSetTimeout(() => {
                    observerDebounceTimer = null;
                    attachVideoListeners();
                }, OBSERVER_DEBOUNCE_MS);
            });
            observer.observe(root, { childList: true, subtree: true });
        }

        currentVideoKey = getCurrentVideoKey();
        attachVideoListeners();
        installNavigationListeners();
        installObserver();
        scheduleApply('startup');
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCrystalClear, { once: true });
    } else {
        startCrystalClear();
    }
})();
