// ==UserScript==
// @name         SuperTube Safari
// @namespace    https://github.com/nickleechn/tampermonkey
// @version      1.0.0
// @description  Safari-friendly YouTube cleanup and automatic highest-quality selection.
// @author       nickleechn
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
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
    const MAX_MENU_ATTEMPTS_PER_VIDEO = 4;
    const PRECONNECT_HOSTS = [
        'https://i.ytimg.com',
        'https://yt3.ggpht.com',
        'https://googlevideo.com'
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

    let stopped = false;
    let currentVideoKey = '';
    let activeScheduleKey = '';
    let menuAttempts = 0;
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
            schedule(resolve, delay);
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

    function parseQuality(item) {
        const text = normalizeText(item.textContent);
        const resolutionMatch = text.match(/(?:^|\s)(\d{3,4})p(?:\s|$)/i);
        if (!resolutionMatch) return null;

        return {
            item: item,
            resolution: Number(resolutionMatch[1]),
            premium: /\b(?:premium|enhanced bitrate)\b/i.test(text),
            selected: item.getAttribute('aria-checked') === 'true'
        };
    }

    function chooseHighestQuality(items) {
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
        return true;
    }

    async function selectHighestQuality(reason) {
        if (stopped || qualitySelectionRunning || menuAttempts >= MAX_MENU_ATTEMPTS_PER_VIDEO) return;
        const expectedVideoKey = getVideoKey();
        const player = getPlayer();
        if (!player || !getSettingsButton(player)) return;

        qualitySelectionRunning = true;
        menuAttempts += 1;

        try {
            if (!await openQualityMenu(player) || expectedVideoKey !== getVideoKey()) {
                closeSettings(player);
                return;
            }

            const choice = chooseHighestQuality(getVisibleMenuItems(player));
            if (!choice) {
                closeSettings(player);
                return;
            }

            if (!choice.selected) choice.item.click();
            else closeSettings(player);

        } catch (_) {
            closeSettings(player);
        } finally {
            qualitySelectionRunning = false;
        }
    }

    function clearApplyTimers() {
        for (const timer of applyTimers) {
            window.clearTimeout(timer);
            timers.delete(timer);
        }
        applyTimers.clear();
        activeScheduleKey = '';
    }

    function scheduleQualitySelection(reason, force) {
        const videoKey = getVideoKey();
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
            menuAttempts = 0;
            qualitySelectionRunning = false;
            attachVideoListeners();
            installObserver();
        }
        scheduleQualitySelection(reason, changed);
    }

    function attachVideoListeners() {
        const video = document.querySelector('video');
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
            if (observerTimer) window.clearTimeout(observerTimer);
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
        try {
            const result = GM.addStyle(CSS);
            if (result && typeof result.catch === 'function') result.catch(function () {});
        } catch (_) {
            const style = document.createElement('style');
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
            cleanupCallbacks.push(function () { style.remove(); });
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
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
        if (observer) observer.disconnect();
        if (removeVideoListeners) removeVideoListeners();
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

    installStyles();
    installPreconnects();
    addListener(window, 'pagehide', cleanup, { once: true });

    if (document.readyState === 'loading') {
        addListener(document, 'DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
