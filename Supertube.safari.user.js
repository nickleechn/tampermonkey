// ==UserScript==
// @name         SuperTube Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      2.1.0
// @description  Safari-only YouTube tuning: hardware-aware codec filtering, telemetry blocking, UI cleanup, and automatic highest-quality selection capped at 4K (1080p Premium when offered).
// @author       nickleechn
// @match        https://www.youtube.com/*
// @exclude      https://www.youtube.com/live_chat*
// @inject-into  page
// @grant        none
// @noframes
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Supertube.safari.user.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Supertube.safari.user.js
// ==/UserScript==

/*
 * WORLD: page, not content.
 *
 * Every early hook below (MediaSource.isTypeSupported, fetch, XMLHttpRequest)
 * and the whole player-API path (getAvailableQualityLevels /
 * setPlaybackQualityRange) only work if this script shares a global with
 * YouTube's own code. In an isolated content world `window` is a different
 * object and DOM nodes carry none of the JS properties page script attached to
 * them, so `movie_player.getAvailableQualityLevels` is simply undefined there.
 *
 * `@grant none` already means page context under Tampermonkey for Safari;
 * `@inject-into page` says the same thing to the Userscripts extension. The
 * cost is that GM.* APIs are unavailable, so styles go in via a plain <style>
 * element. The settings-menu clicking path is kept as a fallback for the case
 * where the player API is missing anyway.
 */

(function () {
    'use strict';

    /* ==================================================================
     * Configuration
     * ================================================================== */

    // 'auto'      : probe for hardware AV1 decode, block AV1 only if absent (recommended)
    // 'no-av1'    : always block AV1
    // 'h264-only' : block AV1 and VP9 — caps you at 1080p, for old Intel Macs
    // 'all'       : no codec filtering
    const CODEC_PROFILE = 'auto';

    // Blocking /api/stats/watchtime and /api/stats/atr stops YouTube recording
    // your playback position, which breaks "resume where you left off" and stops
    // views counting for creators. Pure telemetry (log_event, qoe, ptracking,
    // ads) is blocked regardless of this setting.
    const BLOCK_WATCH_HISTORY = false;

    // Turn off "autoplay next video" via the player API.
    const DISABLE_AUTOPLAY_NEXT = false;

    // Highest quality this script will ever ask for. 8K and 5K have no hardware
    // decode path on Apple Silicon in Safari, so selecting them drops playback into
    // software VP9 and produces exactly the dropped frames this script exists to
    // prevent — on a panel that cannot resolve them anyway. Set to 'highres' to
    // remove the cap.
    const MAX_QUALITY = 'hd2160';

    // Floor handed to setPlaybackQualityRange as its minimum. Pinning min === max
    // leaves the player no room to adapt, so a bandwidth dip becomes a rebuffer
    // instead of a brief quality drop. Set to null to pin hard at MAX_QUALITY.
    const MIN_QUALITY = 'hd1080';

    /* ==================================================================
     * PART A — Early hooks. Installed once, never torn down.
     * ================================================================== */

    /* --- A1. Codec filtering ------------------------------------------ */

    const AV1_RE = /av0?1/i;
    const VP9_RE = /vp0?9/i;
    const AV1_PROBE = 'video/mp4; codecs="av01.0.08M.08"';

    // Start conservative: assume no hardware AV1 until proven otherwise, so a
    // player that initialises before the async probe resolves never gets handed
    // a software-decoded AV1 stream.
    let blockAv1 = CODEC_PROFILE !== 'all';
    const blockVp9 = CODEC_PROFILE === 'h264-only';

    const isBlockedCodec = (mime) => {
        if (typeof mime !== 'string') return false;
        if (blockAv1 && AV1_RE.test(mime)) return true;
        if (blockVp9 && VP9_RE.test(mime)) return true;
        return false;
    };

    if (CODEC_PROFILE === 'auto') {
        // powerEfficient is the actual question being asked — "does this Mac
        // have an AV1 hardware decoder". M3/M4 report true, M1/M2 report false.
        // This replaces hand-editing a profile to match your own silicon.
        try {
            navigator.mediaCapabilities.decodingInfo({
                type: 'media-source',
                video: {
                    contentType: AV1_PROBE,
                    width: 3840,
                    height: 2160,
                    bitrate: 20000000,
                    framerate: 30
                }
            }).then((info) => {
                blockAv1 = !(info && info.supported && info.powerEfficient);
            }).catch(() => {});
        } catch (_) {}
    }

    if (CODEC_PROFILE !== 'all') {
        // ManagedMediaSource (Safari 17+) declares its OWN static isTypeSupported in
        // WebKit's IDL rather than inheriting MediaSource's. An own property shadows
        // the inherited one, so patching MediaSource alone leaves it untouched — and
        // callers feature-detect `self.ManagedMediaSource || self.MediaSource`, so on
        // Safari 17+ the unpatched path is the one actually used and AV1 filtering
        // silently stops working. Patch every constructor independently.
        const patchIsTypeSupported = function (ctor) {
            if (!ctor || typeof ctor.isTypeSupported !== 'function') return;
            const nativeIsTypeSupported = ctor.isTypeSupported.bind(ctor);
            ctor.isTypeSupported = function (mime) {
                if (isBlockedCodec(mime)) return false;
                return nativeIsTypeSupported(mime);
            };
        };
        patchIsTypeSupported(window.MediaSource);
        patchIsTypeSupported(window.ManagedMediaSource);
        if (window.HTMLVideoElement) {
            const nativeVideoCanPlay = HTMLVideoElement.prototype.canPlayType;
            HTMLVideoElement.prototype.canPlayType = function (mime) {
                if (isBlockedCodec(mime)) return '';
                return nativeVideoCanPlay.call(this, mime);
            };
        }
        if (window.HTMLAudioElement) {
            const nativeAudioCanPlay = HTMLAudioElement.prototype.canPlayType;
            HTMLAudioElement.prototype.canPlayType = function (mime) {
                if (isBlockedCodec(mime)) return '';
                return nativeAudioCanPlay.call(this, mime);
            };
        }
    }

    /* --- A2. Block telemetry / ad endpoints ---------------------------- */

    const BLOCKED_URL_PATTERNS = [
        '/youtubei/v1/log_event',
        '/api/stats/qoe',
        '/ptracking',
        '/csi_204',
        '/pagead/',
        'doubleclick.net',
        'googleadservices.com'
    ];
    if (BLOCK_WATCH_HISTORY) {
        BLOCKED_URL_PATTERNS.push('/api/stats/atr', '/api/stats/watchtime');
    }

    const toUrlString = (value) => {
        if (typeof value === 'string') return value;
        if (!value) return '';
        try {
            // Request exposes .url; URL and everything else stringify sensibly.
            if (typeof value.url === 'string') return value.url;
            return String(value);
        } catch (_) {
            return '';
        }
    };

    const isBlockedURL = (value) => {
        const url = toUrlString(value);
        if (!url) return false;
        return BLOCKED_URL_PATTERNS.some((pattern) => url.includes(pattern));
    };

    if (typeof window.fetch === 'function') {
        const nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                if (isBlockedURL(input)) {
                    // 204 is a null-body status: `new Response('', {status: 204})`
                    // throws TypeError, which previously fell through the catch
                    // and let every "blocked" request through untouched.
                    // A null-body 204 is well-formed, but callers that do
                    // `res.json()` on it get "SyntaxError: Unexpected end of JSON
                    // input". An empty JSON object satisfies both those callers and
                    // the fire-and-forget ones.
                    return Promise.resolve(new Response('{}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }
            } catch (_) {}
            // Not .call(this, ...) — a destructured `fetch` would arrive with
            // `this === undefined` and WebKit rejects that outright.
            return nativeFetch.apply(window, arguments);
        };
    }

    const nativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__supertubeBlocked = isBlockedURL(url);
        return nativeXhrOpen.call(this, method, url, ...rest);
    };

    const nativeXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        if (!this.__supertubeBlocked) return nativeXhrSend.call(this, body);
        // Simply swallowing send() leaves readyState at 1 forever, so callers
        // keep a pending promise or retry timer alive. Fake a clean 204 instead.
        window.setTimeout(() => {
            try {
                Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
                Object.defineProperty(this, 'status', { value: 204, configurable: true });
                Object.defineProperty(this, 'responseText', { value: '', configurable: true });
            } catch (_) {}
            try {
                this.dispatchEvent(new Event('readystatechange'));
                this.dispatchEvent(new Event('load'));
                this.dispatchEvent(new Event('loadend'));
            } catch (_) {}
        }, 0);
    };

    if (typeof navigator.sendBeacon === 'function') {
        const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
            if (isBlockedURL(url)) return true;
            return nativeSendBeacon(url, data);
        };
    }

    /* ==================================================================
     * PART B — Cleanup CSS, preconnects, and quality selection
     * ================================================================== */

    const APPLY_DELAYS_MS = [250, 1000, 2500, 5000];
    const MENU_WAIT_MS = 150;
    const OBSERVER_DEBOUNCE_MS = 250;
    const MAX_ATTEMPTS_PER_VIDEO = 4;
    const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
    const QUALITY_ORDER = [
        'highres', 'hd2880', 'hd2160', 'hd1440',
        'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'
    ];
    const PREMIUM_RE = /\b(?:premium|enhanced bitrate)\b/i;
    // The menu fallback reads resolutions out of label text ("2160p60"), not level
    // ids, so MAX_QUALITY has to be expressible as a height for it to share the cap.
    const QUALITY_HEIGHTS = {
        highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080,
        hd720: 720, large: 480, medium: 360, small: 240, tiny: 144
    };
    const MAX_QUALITY_HEIGHT = QUALITY_HEIGHTS[MAX_QUALITY] || Infinity;
    // Apex googlevideo.com does not warm the real CDN hosts, and the per-session
    // rr*---sn-*.googlevideo.com name is unknowable ahead of time, so media
    // preconnects are not attempted at all.
    const PRECONNECT_HOSTS = [
        'https://i.ytimg.com',
        'https://yt3.ggpht.com',
        'https://s.ytimg.com'
    ];
    const VIDEO_SELECTORS = [
        '#movie_player video',
        '.html5-video-player video',
        'video'
    ];
    const CSS = `
        ytd-video-preview,
        #video-preview,
        ytd-moving-thumbnail-renderer,
        ytd-thumbnail-overlay-loading-preview-renderer {
            display: none !important;
        }

        #cinematics,
        .ytp-cinematics-container,
        .ytd-cinematic-container-renderer {
            display: none !important;
        }

        ytd-rich-shelf-renderer[is-shorts],
        ytd-reel-shelf-renderer,
        ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
        ytd-guide-entry-renderer:has(a[href="/shorts"]),
        ytd-mini-guide-entry-renderer:has(a[href="/shorts"]) {
            display: none !important;
        }

        ytd-masthead,
        #masthead-container {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
    `;

    const timers = new Set();
    const applyTimers = new Set();
    const cleanupCallbacks = [];
    const preconnectHints = new Set();

    let stopped = true;
    let styleElement = null;
    let currentVideoKey = '';
    let completedVideoKey = '';
    let premiumSelectedKey = '';
    let autonavDisabledKey = '';
    let activeScheduleKey = '';
    let attempts = 0;
    let observer = null;
    let observerTimer = 0;
    let watchedVideo = null;
    let removeVideoListeners = null;
    let qualitySelectionRunning = false;

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

    function cancelTimer(timer) {
        if (!timer) return;
        window.clearTimeout(timer);
        timers.delete(timer);
        applyTimers.delete(timer);
    }

    function scheduleApply(callback, delay) {
        const timer = schedule(function () {
            applyTimers.delete(timer);
            callback();
        }, delay);
        applyTimers.add(timer);
        return timer;
    }

    function wait(delay) {
        return new Promise(function (resolve) {
            const timer = window.setTimeout(function () {
                timers.delete(timer);
                resolve();
            }, delay);
            timers.add(timer);
        });
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function getVideoKey() {
        try {
            const url = new URL(location.href);
            return url.searchParams.get('v') || url.pathname;
        } catch (_) {
            return location.href;
        }
    }

    function isWatchPage() {
        try {
            return Boolean(new URL(location.href).searchParams.get('v'));
        } catch (_) {
            return false;
        }
    }

    function getPlayer() {
        return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    }

    function getVideoElement() {
        // Deliberately one querySelector per selector: a grouped selector list
        // returns the first match in *document order*, which on a watch page can
        // be a hover-preview <video> in the sidebar rather than the real player.
        for (const selector of VIDEO_SELECTORS) {
            const video = document.querySelector(selector);
            if (video) return video;
        }
        return null;
    }

    function getSettingsButton(player) {
        return player && player.querySelector('.ytp-settings-button');
    }

    function getVisibleMenuItems(player) {
        return Array.from(player.querySelectorAll('.ytp-panel-menu .ytp-menuitem')).filter(function (item) {
            return item.getClientRects().length > 0;
        });
    }

    function closeSettings(player) {
        const button = getSettingsButton(player);
        if (button && button.getAttribute('aria-expanded') === 'true') button.click();
    }

    function getAvailableQualityLevels(player) {
        if (!player || typeof player.getAvailableQualityLevels !== 'function') return [];
        try {
            const levels = player.getAvailableQualityLevels();
            return Array.isArray(levels) ? levels.filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    function getAvailableQualityData(player) {
        if (!player || typeof player.getAvailableQualityData !== 'function') return [];
        try {
            const data = player.getAvailableQualityData();
            if (!Array.isArray(data)) return [];
            return data.filter(function (entry) {
                return entry && entry.isPlayable !== false;
            });
        } catch (_) {
            return [];
        }
    }

    function rankQuality(quality) {
        const index = QUALITY_ORDER.indexOf(quality);
        return index === -1 ? QUALITY_ORDER.length : index;
    }

    function chooseTargetQuality(levels, qualityData) {
        // Prefer the levels the player reports as playable; fall back to the raw
        // level list when getAvailableQualityData is unavailable.
        const playableLevels = qualityData.length
            ? qualityData.map(function (entry) { return entry.quality; }).filter(Boolean)
            : [];
        const candidates = playableLevels.length ? playableLevels : levels;

        // A lower rank index means a higher resolution, so the cap is a lower
        // bound on the index. Filter before sorting so uniqueLevels[0] is the best
        // *allowed* level rather than the best available one.
        const maxRank = rankQuality(MAX_QUALITY);
        const uniqueLevels = Array.from(new Set(candidates))
            .filter(function (quality) { return rankQuality(quality) >= maxRank; })
            .sort(function (left, right) {
                return rankQuality(left) - rankQuality(right);
            });
        if (!uniqueLevels.length) return null;

        const bestQuality = uniqueLevels[0];
        const matchingData = qualityData.filter(function (entry) {
            return entry.quality === bestQuality;
        });
        const premiumData = matchingData.find(function (entry) {
            return PREMIUM_RE.test([entry.qualityLabel, entry.label, entry.name].filter(Boolean).join(' '));
        });

        return {
            quality: bestQuality,
            wantsPremium1080: bestQuality === 'hd1080' && Boolean(premiumData),
            displayLabel: (premiumData || matchingData[0] || {}).qualityLabel || ''
        };
    }

    function persistPlayerQuality(quality) {
        try {
            const current = localStorage.getItem('yt-player-quality');
            if (current) {
                const parsed = JSON.parse(current);
                if (parsed && parsed.data === quality) return;
            }
            const now = Date.now();
            localStorage.setItem('yt-player-quality', JSON.stringify({
                data: quality,
                expiration: now + MONTH_MS,
                creation: now
            }));
        } catch (_) {}
    }

    function applyQualityViaApi(player, quality) {
        try {
            if (typeof player.setPlaybackQualityRange === 'function') {
                // Ceiling stays at the chosen quality; the floor gives ABR somewhere
                // to go on a bandwidth dip. Never let the floor outrank the ceiling.
                const floor = (MIN_QUALITY && rankQuality(MIN_QUALITY) >= rankQuality(quality))
                    ? MIN_QUALITY
                    : quality;
                player.setPlaybackQualityRange(floor, quality);
                return true;
            }
        } catch (_) {}
        try {
            if (typeof player.setPlaybackQuality === 'function') {
                player.setPlaybackQuality(quality);
                return true;
            }
        } catch (_) {}
        return false;
    }

    function disableAutonavOnce(player, videoKey) {
        if (!DISABLE_AUTOPLAY_NEXT || !player || autonavDisabledKey === videoKey) return;
        try {
            if (typeof player.setAutonavState === 'function') {
                player.setAutonavState(1); // 1 = disabled
                autonavDisabledKey = videoKey;
            }
        } catch (_) {}
    }

    function parseQuality(item) {
        const text = normalizeText([
            item.textContent,
            item.getAttribute('aria-label')
        ].filter(Boolean).join(' '));
        const resolutionMatch = text.match(/(?:^|\s)(\d{3,4})p(?:\d{2,3})?(?=\s|$)/i);
        if (!resolutionMatch) return null;

        return {
            item: item,
            resolution: Number(resolutionMatch[1]),
            premium: PREMIUM_RE.test(text),
            selected: item.getAttribute('aria-checked') === 'true'
        };
    }

    function chooseHighestMenuQuality(items) {
        // Cap here too. This path runs whenever the player API is missing or
        // setPlaybackQualityRange fails, and without the filter it happily selects
        // 8K straight past MAX_QUALITY.
        const choices = items.map(parseQuality).filter(Boolean)
            .filter(function (choice) { return choice.resolution <= MAX_QUALITY_HEIGHT; });
        choices.sort(function (left, right) {
            if (right.resolution !== left.resolution) return right.resolution - left.resolution;
            if (right.premium !== left.premium) return Number(right.premium) - Number(left.premium);
            return 0;
        });
        return choices[0] || null;
    }

    async function openQualityMenu(player) {
        const settingsButton = getSettingsButton(player);
        if (!settingsButton) return false;

        if (settingsButton.getAttribute('aria-expanded') !== 'true') {
            settingsButton.click();
            await wait(MENU_WAIT_MS);
            if (stopped) return false;
        }

        const menuItems = getVisibleMenuItems(player);
        const qualityEntry = menuItems.find(function (item) {
            const text = normalizeText(item.textContent);
            const label = normalizeText(item.getAttribute('aria-label'));
            return text.includes('quality') || label.includes('quality');
        }) || menuItems.find(function (item) {
            const content = item.querySelector('.ytp-menuitem-content');
            return content && /\b\d{3,4}p\b/i.test(content.textContent || '');
        });
        if (!qualityEntry) return false;

        qualityEntry.click();
        await wait(MENU_WAIT_MS);
        return !stopped;
    }

    async function selectPremiumInMenu(player, targetLabel) {
        if (!await openQualityMenu(player)) {
            closeSettings(player);
            return false;
        }

        const targetText = normalizeText(targetLabel);
        const premiumOption = getVisibleMenuItems(player).find(function (item) {
            const text = normalizeText(item.textContent);
            if (!text.includes('1080p') || !PREMIUM_RE.test(text)) return false;
            return !targetText || text.includes(targetText) || targetText.includes(text);
        });

        if (!premiumOption) {
            closeSettings(player);
            return false;
        }

        premiumOption.click();
        return true;
    }

    async function selectHighestQualityViaMenu(player) {
        if (!await openQualityMenu(player)) {
            closeSettings(player);
            return false;
        }

        const choice = chooseHighestMenuQuality(getVisibleMenuItems(player));
        if (!choice) {
            closeSettings(player);
            return false;
        }

        if (!choice.selected) choice.item.click();
        else closeSettings(player);
        return true;
    }

    async function selectHighestQuality() {
        if (stopped || qualitySelectionRunning || attempts >= MAX_ATTEMPTS_PER_VIDEO) return;
        if (!isWatchPage()) return;

        const expectedVideoKey = getVideoKey();
        if (completedVideoKey === expectedVideoKey) return;

        const player = getPlayer();
        if (!player) return;

        const levels = getAvailableQualityLevels(player);
        const choice = chooseTargetQuality(levels, getAvailableQualityData(player));
        // Don't burn an attempt while the player is still initialising.
        if (!choice && !getSettingsButton(player)) return;

        qualitySelectionRunning = true;
        attempts += 1;

        try {
            if (expectedVideoKey !== getVideoKey() || stopped) return;

            disableAutonavOnce(player, expectedVideoKey);

            if (!choice) {
                if (!await selectHighestQualityViaMenu(player) || expectedVideoKey !== getVideoKey()) return;
                completedVideoKey = expectedVideoKey;
                clearApplyTimers();
                return;
            }

            persistPlayerQuality(choice.quality);

            if (!applyQualityViaApi(player, choice.quality)) {
                // Player API unavailable — drive the settings menu instead.
                if (!await selectHighestQualityViaMenu(player) || expectedVideoKey !== getVideoKey()) return;
                completedVideoKey = expectedVideoKey;
                clearApplyTimers();
                return;
            }

            if (choice.wantsPremium1080 && premiumSelectedKey !== expectedVideoKey) {
                if (!getSettingsButton(player)) {
                    // Menu isn't built yet. Leave the video incomplete so a later
                    // scheduled attempt retries rather than marking it done here.
                    // Refund the attempt: base quality is already applied, and a
                    // premium-only miss must not burn MAX_ATTEMPTS_PER_VIDEO. The
                    // APPLY_DELAYS_MS schedule still bounds the total retries.
                    attempts -= 1;
                    return;
                }
                await wait(700);
                if (stopped || expectedVideoKey !== getVideoKey()) return;
                // Only record success — a failed menu walk must stay retryable.
                if (await selectPremiumInMenu(player, choice.displayLabel)) {
                    premiumSelectedKey = expectedVideoKey;
                } else {
                    attempts -= 1;
                    return;
                }
            }

            completedVideoKey = expectedVideoKey;
            clearApplyTimers();
        } catch (_) {
            closeSettings(player);
        } finally {
            qualitySelectionRunning = false;
        }
    }

    function clearApplyTimers() {
        for (const timer of Array.from(applyTimers)) cancelTimer(timer);
        applyTimers.clear();
        activeScheduleKey = '';
    }

    function scheduleQualitySelection(reason, force) {
        if (!isWatchPage()) return;
        const videoKey = getVideoKey();
        if (completedVideoKey === videoKey) return;
        if (!force && activeScheduleKey === videoKey) return;

        clearApplyTimers();
        activeScheduleKey = videoKey;
        for (const delay of APPLY_DELAYS_MS) {
            scheduleApply(function () {
                selectHighestQuality();
            }, delay);
        }
    }

    function handleVideoChange(reason) {
        const nextVideoKey = getVideoKey();
        const changed = nextVideoKey !== currentVideoKey;
        if (changed) {
            currentVideoKey = nextVideoKey;
            completedVideoKey = '';
            premiumSelectedKey = '';
            autonavDisabledKey = '';
            attempts = 0;
            qualitySelectionRunning = false;
            attachVideoListeners();
            installObserver();
        }
        scheduleQualitySelection(reason, changed);
    }

    function attachVideoListeners() {
        const video = getVideoElement();
        if (!video || video === watchedVideo) return;

        if (removeVideoListeners) removeVideoListeners();
        watchedVideo = video;

        const handlers = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].map(function (name) {
            const handler = function () {
                handleVideoChange('video-' + name);
            };
            video.addEventListener(name, handler, { passive: true });
            return { name: name, handler: handler };
        });

        removeVideoListeners = function () {
            for (const entry of handlers) video.removeEventListener(entry.name, entry.handler);
            if (watchedVideo === video) watchedVideo = null;
        };
    }

    function getObservationRoot() {
        return document.querySelector('#player') ||
            document.querySelector('ytd-watch-flexy') ||
            document.body ||
            document.documentElement;
    }

    function installObserver() {
        if (typeof MutationObserver !== 'function') return;
        if (observer) observer.disconnect();

        // Off the watch page there is no #player and no ytd-watch-flexy, so
        // getObservationRoot() falls back to <body> and every card the infinite
        // feed appends fires the callback. Nothing needs observing until a player
        // exists.
        if (!isWatchPage()) {
            observer = null;
            return;
        }

        const root = getObservationRoot();
        if (!root) return;

        // Note: attachVideoListeners must NOT disconnect this observer. Doing so
        // left the page unobserved for good after the first <video> attach, so
        // later element swaps (ad -> content, player remount) went unnoticed.
        observer = new MutationObserver(function () {
            cancelTimer(observerTimer);
            observerTimer = schedule(function () {
                observerTimer = 0;
                attachVideoListeners();
            }, OBSERVER_DEBOUNCE_MS);
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function installNavigationListeners() {
        // Registered on document only — these bubble, so also binding window
        // would run every handler twice per navigation.
        const events = ['yt-navigate-finish', 'yt-page-data-updated', 'spfdone'];
        for (const eventName of events) {
            addListener(document, eventName, function () {
                handleVideoChange(eventName);
            }, { passive: true });
        }
        addListener(window, 'popstate', function () {
            handleVideoChange('popstate');
        }, { passive: true });
    }

    function installStyles() {
        if (styleElement && styleElement.isConnected) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;
        styleElement = document.createElement('style');
        styleElement.textContent = CSS;
        parent.appendChild(styleElement);
    }

    function installPreconnects() {
        const parent = document.head || document.documentElement;
        if (!parent) return;

        for (const host of PRECONNECT_HOSTS) {
            const hint = document.createElement('link');
            hint.rel = 'preconnect';
            hint.href = host;
            hint.crossOrigin = 'anonymous';
            parent.appendChild(hint);
            preconnectHints.add(hint);
        }
    }

    function cleanup() {
        if (stopped) return;
        stopped = true;

        clearApplyTimers();
        cancelTimer(observerTimer);
        observerTimer = 0;
        for (const timer of Array.from(timers)) cancelTimer(timer);
        timers.clear();
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (removeVideoListeners) {
            removeVideoListeners();
            removeVideoListeners = null;
        }
        qualitySelectionRunning = false;
        while (cleanupCallbacks.length) cleanupCallbacks.pop()();
        for (const hint of preconnectHints) hint.remove();
        preconnectHints.clear();
    }

    function start() {
        if (stopped) return;
        currentVideoKey = getVideoKey();
        attachVideoListeners();
        installNavigationListeners();
        installObserver();
        scheduleQualitySelection('startup', true);
    }

    function activate() {
        if (!stopped) return;
        stopped = false;
        attempts = 0;
        completedVideoKey = '';
        premiumSelectedKey = '';
        autonavDisabledKey = '';

        installStyles();
        installPreconnects();

        if (document.readyState === 'loading') {
            addListener(document, 'DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    // Safari can keep this document alive in its back/forward cache. These
    // lifecycle listeners must survive cleanup so pageshow can reactivate the
    // same userscript instance without duplicating per-page listeners.
    window.addEventListener('pagehide', cleanup);
    window.addEventListener('pageshow', activate);
    activate();
})();
