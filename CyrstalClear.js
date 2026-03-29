// ==UserScript==
// @name         CrystalClear
// @namespace    https://youtube.com/
// @version      1.1
// @description  Automatically picks the highest available YouTube quality on Safari and prefers 1080p Premium when 1080p is the max resolution and the Premium variant exists.
// @author       Codex
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @exclude      https://www.youtube.com/live_chat*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG = false;
    const APPLY_DELAYS_MS = [250, 1000, 2500, 5000];
    const OBSERVER_DEBOUNCE_MS = 250;
    const QUALITY_ORDER = [
        'highres',
        'hd2880',
        'hd2160',
        'hd1440',
        'hd1080',
        'hd720',
        'large',
        'medium',
        'small',
        'tiny'
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

    function log() {
        if (!DEBUG) return;
        console.debug('[YT Auto Quality]', ...arguments);
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function getCurrentVideoKey() {
        try {
            const url = new URL(location.href);
            return url.searchParams.get('v') || url.pathname;
        } catch (_) {
            return location.href;
        }
    }

    function getPlayer() {
        return document.getElementById('movie_player')
            || document.querySelector('.html5-video-player');
    }

    function getVideoElement() {
        return document.querySelector('video');
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
        if (!player || typeof player.getAvailableQualityData !== 'function') {
            log('getAvailableQualityData() unavailable on this player build');
            return [];
        }

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
        const uniqueLevels = Array.from(new Set(levels)).sort((a, b) => rankQuality(a) - rankQuality(b));
        if (!uniqueLevels.length) return null;

        const bestQuality = uniqueLevels[0];
        const matchingData = qualityData.filter(entry => entry.quality === bestQuality);
        const premiumData = matchingData.find(entry => PREMIUM_RE.test([
            entry.qualityLabel,
            entry.label,
            entry.name
        ].filter(Boolean).join(' ')));

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
        let appliedByRange = false;

        try {
            if (typeof player.setPlaybackQualityRange === 'function') {
                player.setPlaybackQualityRange(quality, quality);
                appliedByRange = true;
            }
        } catch (_) {}

        if (appliedByRange) return;

        try {
            if (typeof player.setPlaybackQuality === 'function') {
                player.setPlaybackQuality(quality);
            }
        } catch (_) {}
    }

    async function selectPremium1080InMenu(targetLabel) {
        const player = getPlayer();
        if (!player) return false;

        const settingsButton = player.querySelector('.ytp-settings-button');
        if (!settingsButton) return false;

        const clickIfNeeded = (element) => {
            if (!element) return false;
            element.click();
            return true;
        };

        const closeSettings = () => {
            const expandedButton = player.querySelector('.ytp-settings-button[aria-expanded="true"]');
            if (expandedButton) expandedButton.click();
        };

        let didSelectPremium = false;

        try {
            if (settingsButton.getAttribute('aria-expanded') !== 'true') {
                settingsButton.click();
                await wait(120);
            }

            const qualityMenuEntry = Array.from(player.querySelectorAll('.ytp-menuitem'))
                .find(item => normalizeText(item.textContent).includes('quality'));

            if (!clickIfNeeded(qualityMenuEntry)) {
                closeSettings();
                return false;
            }

            await wait(120);

            const targetText = normalizeText(targetLabel);
            const premiumOption = Array.from(player.querySelectorAll('.ytp-menuitem'))
                .find(item => {
                    const text = normalizeText(item.textContent);
                    if (!text.includes('1080p')) return false;
                    if (!PREMIUM_RE.test(text)) return false;
                    return !targetText || text.includes(targetText) || targetText.includes(text);
                });

            if (!clickIfNeeded(premiumOption)) {
                closeSettings();
                return false;
            }

            log('Selected 1080p Premium from the quality menu');
            didSelectPremium = true;
            return true;
        } catch (error) {
            log('Premium menu selection failed', error);
            return false;
        } finally {
            if (!didSelectPremium) {
                window.setTimeout(closeSettings, 50);
            }
        }
    }

    async function applyBestQuality(reason) {
        const player = getPlayer();
        if (!player) return;

        const levels = getAvailableQualityLevels(player);
        if (!levels.length) {
            log('No quality levels yet', reason);
            return;
        }

        const choice = chooseTargetQuality(levels, getAvailableQualityData(player));
        if (!choice) return;

        persistPlayerQuality(choice.quality);
        applyQualityViaApi(player, choice.quality);
        log('Applied via API', reason, choice.quality, levels);

        const videoKey = getCurrentVideoKey();
        if (!choice.wantsPremium1080 || premiumAttemptedForVideo === videoKey) return;

        premiumAttemptedForVideo = videoKey;
        await wait(700);
        await selectPremium1080InMenu(choice.displayLabel);
    }

    function clearScheduledApplies() {
        scheduledTimers.forEach(timerId => window.clearTimeout(timerId));
        scheduledTimers.clear();
        activeScheduleVideoKey = '';
    }

    function scheduleApply(reason, forceNewCycle) {
        const videoKey = getCurrentVideoKey();
        if (!forceNewCycle && activeScheduleVideoKey === videoKey && scheduledTimers.size) {
            log('Skipping duplicate apply cycle', reason, videoKey);
            return;
        }

        clearScheduledApplies();
        activeScheduleVideoKey = videoKey;
        APPLY_DELAYS_MS.forEach(delay => {
            const timerId = window.setTimeout(() => {
                scheduledTimers.delete(timerId);
                applyBestQuality(reason + ':' + delay).finally(() => {
                    if (!scheduledTimers.size) {
                        activeScheduleVideoKey = '';
                    }
                });
            }, delay);
            scheduledTimers.add(timerId);
        });
    }

    function handleVideoChange(reason) {
        const nextVideoKey = getCurrentVideoKey();
        const isNewVideo = nextVideoKey !== currentVideoKey;

        if (isNewVideo) {
            installObserver();
        }

        if (nextVideoKey !== currentVideoKey) {
            currentVideoKey = nextVideoKey;
            premiumAttemptedForVideo = '';
        }
        scheduleApply(reason, isNewVideo);
    }

    function clearObserverDebounce() {
        if (!observerDebounceTimer) return;
        window.clearTimeout(observerDebounceTimer);
        observerDebounceTimer = null;
    }

    function disconnectObserver() {
        clearObserverDebounce();
        if (!observer) return;
        observer.disconnect();
        observer = null;
    }

    function getObservationRoot() {
        return document.querySelector('#player')
            || document.getElementById('movie_player')
            || document.querySelector('ytd-watch-flexy')
            || document.body;
    }

    function attachVideoListeners() {
        const video = getVideoElement();
        if (!video || video === watchedVideoElement) return;

        if (typeof removeWatchedVideoListeners === 'function') {
            removeWatchedVideoListeners();
            removeWatchedVideoListeners = null;
        }

        watchedVideoElement = video;
        disconnectObserver();

        const handlers = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].map(eventName => {
            const handler = () => handleVideoChange('video-' + eventName);
            video.addEventListener(eventName, handler, { passive: true });
            return { eventName, handler };
        });
        removeWatchedVideoListeners = function () {
            handlers.forEach(({ eventName, handler }) => {
                video.removeEventListener(eventName, handler);
            });
        };

        scheduleApply('video-attached', true);
    }

    function installNavigationListeners() {
        ['yt-navigate-finish', 'spfdone', 'popstate'].forEach(eventName => {
            window.addEventListener(eventName, () => handleVideoChange(eventName), { passive: true });
            document.addEventListener(eventName, () => handleVideoChange(eventName), { passive: true });
        });

        document.addEventListener('yt-page-data-updated', () => handleVideoChange('yt-page-data-updated'), { passive: true });
    }

    function installObserver() {
        const root = getObservationRoot();
        if (!root) return;

        disconnectObserver();

        observer = new MutationObserver(() => {
            clearObserverDebounce();
            observerDebounceTimer = window.setTimeout(() => {
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
})();
