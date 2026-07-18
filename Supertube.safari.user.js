// ==UserScript==
// @name         SuperTube Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.1.0
// @description  Safari-friendly YouTube cleanup and automatic highest-quality selection.
// @author       nickleechn
// @match        https://www.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @exclude      https://www.youtube.com/live_chat*
// @inject-into  content
// @grant        GM.addStyle
// @noframes
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Supertube.safari.user.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Supertube.safari.user.js
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window) return;

    const APPLY_DELAYS_MS = [250, 1000, 2500, 5000];
    const MENU_WAIT_MS = 150;
    const MAX_ATTEMPTS_PER_VIDEO = 4;
    const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
    const QUALITY_ORDER = [
        'highres', 'hd2880', 'hd2160', 'hd1440',
        'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'
    ];
    const PREMIUM_RE = /\b(?:premium|enhanced bitrate)\b/i;
    // Apex googlevideo.com does not warm the real CDN hosts (rr*---sn-*.googlevideo.com).
    const PRECONNECT_HOSTS = [
        'https://i.ytimg.com',
        'https://yt3.ggpht.com',
        'https://s.ytimg.com'
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
        a[title="Shorts"],
        ytd-mini-guide-entry-renderer[aria-label="Shorts"] {
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
    let styleInstalled = false;
    let currentVideoKey = '';
    let completedVideoKey = '';
    let premiumAttemptedKey = '';
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
            return Array.isArray(data) ? data.filter(Boolean) : [];
        } catch (_) {
            return [];
        }
    }

    function rankQuality(quality) {
        const index = QUALITY_ORDER.indexOf(quality);
        return index === -1 ? QUALITY_ORDER.length : index;
    }

    function chooseTargetQuality(levels, qualityData) {
        const uniqueLevels = Array.from(new Set(levels)).sort(function (left, right) {
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
                player.setPlaybackQualityRange(quality, quality);
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
        const choices = items.map(parseQuality).filter(Boolean);
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

    async function selectHighestQuality(reason) {
        if (stopped || qualitySelectionRunning || attempts >= MAX_ATTEMPTS_PER_VIDEO) return;
        if (!isWatchPage()) return;

        const expectedVideoKey = getVideoKey();
        if (completedVideoKey === expectedVideoKey) return;

        const player = getPlayer();
        if (!player) return;

        const levels = getAvailableQualityLevels(player);
        const choice = chooseTargetQuality(levels, getAvailableQualityData(player));
        // Don't burn attempts while the player is still initializing.
        if (!choice && !getSettingsButton(player)) return;

        qualitySelectionRunning = true;
        attempts += 1;

        try {
            if (expectedVideoKey !== getVideoKey() || stopped) return;

            if (choice) {
                persistPlayerQuality(choice.quality);
                const applied = applyQualityViaApi(player, choice.quality);
                if (!applied) {
                    // Player API unavailable — fall back to the settings menu once.
                    if (!await selectHighestQualityViaMenu(player) || expectedVideoKey !== getVideoKey()) return;
                } else if (
                    choice.wantsPremium1080 &&
                    premiumAttemptedKey !== expectedVideoKey &&
                    getSettingsButton(player)
                ) {
                    premiumAttemptedKey = expectedVideoKey;
                    await wait(700);
                    if (stopped || expectedVideoKey !== getVideoKey()) return;
                    await selectPremiumInMenu(player, choice.displayLabel);
                }

                completedVideoKey = expectedVideoKey;
                clearApplyTimers();
                return;
            }

            if (!await selectHighestQualityViaMenu(player) || expectedVideoKey !== getVideoKey()) return;

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
                selectHighestQuality(reason + ':' + delay);
            }, delay);
        }
    }

    function handleVideoChange(reason) {
        const nextVideoKey = getVideoKey();
        const changed = nextVideoKey !== currentVideoKey;
        if (changed) {
            currentVideoKey = nextVideoKey;
            completedVideoKey = '';
            premiumAttemptedKey = '';
            attempts = 0;
            qualitySelectionRunning = false;
            attachVideoListeners();
            installObserver();
        }
        scheduleQualitySelection(reason, changed);
    }

    function attachVideoListeners() {
        const video = document.querySelector('#movie_player video, .html5-video-player video, video');
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

        const root = getObservationRoot();
        if (!root) return;

        observer = new MutationObserver(function () {
            cancelTimer(observerTimer);
            observerTimer = schedule(function () {
                observerTimer = 0;
                attachVideoListeners();
            }, 250);
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function installNavigationListeners() {
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
        if (styleInstalled) return;

        const installFallbackStyle = function () {
            if (styleInstalled) return;
            const style = document.createElement('style');
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
            styleInstalled = true;
        };

        try {
            if (typeof GM !== 'object' || typeof GM.addStyle !== 'function') {
                installFallbackStyle();
                return;
            }

            const result = GM.addStyle(CSS);
            styleInstalled = true;
            if (result && typeof result.catch === 'function') {
                result.catch(function () {
                    styleInstalled = false;
                    installFallbackStyle();
                });
            }
        } catch (_) {
            styleInstalled = false;
            installFallbackStyle();
        }
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
        premiumAttemptedKey = '';

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
