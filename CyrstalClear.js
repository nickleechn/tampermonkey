// ==UserScript==
// @name         CrystalClear
// @namespace    https://youtube.com/
// @version      2.0
// @description  YouTube in Chrome: AV1 forced on every video that offers it to save bandwidth, the highest quality up to 4K, and a step down when the link stalls or the machine drops frames.
// @author       Codex
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @exclude      https://www.youtube.com/live_chat*
// @noframes
// @grant        none
// @sandbox      raw
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/CyrstalClear.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/CyrstalClear.js
// ==/UserScript==

/*
 * WORLD: page, at document-start.
 *
 * The AV1 flag goes into YouTube's own ytcfg before the player reads it, and
 * the quality calls live on the player element as properties YouTube's code
 * attached. Neither is visible from an isolated content world, and neither is
 * in time at document-idle.
 *
 * Everything about YouTube's player below was read out of base.js 11a45ffb.
 */

(function () {
    'use strict';

    /* ==================================================================
     * Configuration
     * ================================================================== */

    // Logs each pick, and the codec and bandwidth in use every few seconds.
    const DEBUG = false;
    const DEBUG_INTERVAL_MS = 5000;

    // Use only the AV1 formats on every video that has some. Other videos play as
    // normal. On a machine with no AV1 hardware decoder this means decoding in
    // software above 1080p, which is what the frame guard below is for.
    const FORCE_AV1 = true;

    // Highest quality this script will ever ask for. This moves bandwidth more
    // than the codec does: within AV1, 4K to 1440p about halves the bitrate and
    // 4K to 1080p cuts it 5-8x. 'highres' means whatever the video offers, 8K
    // included.
    const MAX_QUALITY = 'hd2160';

    // After a level above 1080p is selected, this samples getVideoPlaybackQuality()
    // while the video is visibly playing at that level. If more than
    // FRAME_GUARD_DROP_RATIO of FRAME_GUARD_MIN_FRAMES frames are dropped, it steps
    // down one level. A limit that fails on two page loads is remembered for 30
    // days, keyed to this machine and Chrome version.
    const FRAME_GUARD = true;
    const FRAME_GUARD_DROP_RATIO = 0.1;
    const FRAME_GUARD_MIN_FRAMES = 300;

    // A pin turns off YouTube's adaptive quality, so a link that cannot sustain the
    // pick rebuffers instead of dropping down. Two stalls of at least STALL_MIN_MS
    // within STALL_WINDOW_MS, or one of STALL_LONG_MS, step down one level. The
    // limit lasts STALL_CAP_TTL_MS, since a rate limit comes and goes, and later
    // videos then try higher again. It never steps below STALL_FLOOR_HEIGHT.
    const STALL_GUARD = true;
    const STALL_MIN_MS = 1000;
    const STALL_LONG_MS = 5000;
    const STALL_WINDOW_MS = 60 * 1000;
    const STALL_STRIKES = 2;
    const STALL_CAP_TTL_MS = 30 * 60 * 1000;
    const STALL_FLOOR_HEIGHT = 720;
    // Pinning flushes the buffer, and that refill is the pin's doing, not the link's.
    const STALL_GRACE_MS = 8000;

    /* ==================================================================
     * PART A: document-start, synchronous
     * ================================================================== */

    if (FORCE_AV1) {
        // Without these the player uses AV1 only up to its own threshold, 1080p
        // unless media capabilities raise it, and mixes in VP9 above that, which is
        // where AV1 saves the most. The old localStorage['yt-player-av1-pref']
        // switch is gone. Two flags, because there are two paths:
        //  - html5_force_av1_for_testing uses only the AV1 formats, and only when the
        //    video has some, so a video without them still gets normal selection.
        //    A pre-roll can make the player skip that branch and walk a codec list
        //    with VP9 first instead, and a 4K video then plays in VP9.
        //  - html5_default_av1_threshold above 2160 puts AV1 first on that list.
        //
        // The player reads flags from yt.config_, which the page fills through
        // ytcfg.set(), so these have to be in place before that call lands.
        const AV1_FLAGS = {
            html5_force_av1_for_testing: 'true',
            html5_default_av1_threshold: '8192'
        };
        const PLAYER_CONFIGS_KEY = 'WEB_PLAYER_CONTEXT_CONFIGS';

        const addAv1Flags = (configs) => {
            if (!configs || typeof configs !== 'object') return;
            Object.keys(configs).forEach(id => {
                const config = configs[id];
                if (!config || typeof config !== 'object') return;
                const flags = String(config.serializedExperimentFlags || '').split('&')
                    .filter(pair => pair && !(pair.split('=')[0] in AV1_FLAGS));
                Object.keys(AV1_FLAGS).forEach(name => flags.push(name + '=' + AV1_FLAGS[name]));
                config.serializedExperimentFlags = flags.join('&');
            });
        };

        const wrapYtcfgSet = (cfg) => {
            if (!cfg || typeof cfg.set !== 'function') return;
            const nativeSet = cfg.set;
            cfg.set = function (first, second) {
                try {
                    if (first === PLAYER_CONFIGS_KEY) addAv1Flags(second);
                    else if (first && typeof first === 'object') addAv1Flags(first[PLAYER_CONFIGS_KEY]);
                } catch (_) {}
                return nativeSet.apply(this, arguments);
            };
        };

        // document-start usually beats the page's inline `var ytcfg = {...}`, and
        // an accessor catches that assignment. If the page got there first, patch
        // what it already stored as well.
        try {
            if (window.ytcfg) {
                wrapYtcfgSet(window.ytcfg);
                if (typeof window.ytcfg.get === 'function') addAv1Flags(window.ytcfg.get(PLAYER_CONFIGS_KEY));
            } else {
                let currentYtcfg;
                Object.defineProperty(window, 'ytcfg', {
                    configurable: true,
                    get: () => currentYtcfg,
                    set: (value) => {
                        if (value === currentYtcfg) return;
                        currentYtcfg = value;
                        try { wrapYtcfgSet(value); } catch (_) {}
                    }
                });
            }
        } catch (_) {}
    }

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
    const QUALITY_HEIGHTS = {
        highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080,
        hd720: 720, large: 480, medium: 360, small: 240, tiny: 144
    };
    const DAY_MS = 24 * 60 * 60 * 1000;
    const HW_SIGNATURE = (() => {
        try {
            const version = (String(navigator.userAgent).match(/chrome\/(\d+)/i) || [])[1] || '0';
            return String(navigator.hardwareConcurrency || 0) + '.' + version;
        } catch (_) {
            return '0.0';
        }
    })();
    const FRAME_CAP_KEY = 'crystalclear-frame-cap-v1:' + HW_SIGNATURE;
    const FRAME_CAP_TTL_MS = 30 * DAY_MS;
    const STALL_CAP_KEY = 'crystalclear-stall-cap-v1';
    const PLAYER_QUALITY_KEY = 'yt-player-quality';
    // YouTube's own lifetime for this record (31104000 s).
    const PLAYER_QUALITY_TTL_MS = 360 * DAY_MS;

    function heightOf(quality) {
        return QUALITY_HEIGHTS[quality] || 0;
    }

    // The lowest height the frame guard has seen this machine fail to keep up
    // with. Exclusive: that level and everything above it are refused. A saved
    // record only counts once it has failed on two separate page loads; see
    // recordFrameFailure for why one is not enough.
    let frameCapHeight = Infinity;
    try {
        const saved = JSON.parse(localStorage.getItem(FRAME_CAP_KEY) || 'null');
        if (saved && saved.height > 0 && saved.strikes >= 2 && saved.until > Date.now()) {
            frameCapHeight = saved.height;
        }
    } catch (_) {}

    // Read every time rather than once: it expires while a tab stays open, and a
    // link that stalls in one tab is the same link in the others.
    function getStallCapHeight() {
        try {
            const saved = JSON.parse(localStorage.getItem(STALL_CAP_KEY) || 'null');
            if (saved && saved.height > 0 && saved.until > Date.now()) return saved.height;
        } catch (_) {}
        return Infinity;
    }

    function getCeilingHeight() {
        return Math.min(heightOf(MAX_QUALITY) || Infinity, frameCapHeight - 1, getStallCapHeight() - 1);
    }

    // The ceiling as an exact rung of YouTube's ladder. The stored preference is
    // looked up by exact height, so 2159 would silently mean "no ceiling at all".
    function getCeilingQuality() {
        const ceiling = getCeilingHeight();
        return QUALITY_ORDER.find(quality => heightOf(quality) <= ceiling) || 'tiny';
    }

    // YouTube reads this record whenever it creates a player and turns it into the
    // initial constraint "Auto, up to <height>", ignoring it once `creation` is
    // more than 30 days old. Its own writes look like
    //   {"data":"{\"quality\":2160,\"previousQuality\":1080}","expiration":…,"creation":…}
    // `data` is a JSON *string*. The legacy "data":"hd2160" form is still read.
    function persistPlayerQuality(height) {
        try {
            const now = Date.now();
            let previous = 0;
            const raw = localStorage.getItem(PLAYER_QUALITY_KEY);
            if (raw) {
                const record = JSON.parse(raw);
                let data = record && record.data;
                try { data = JSON.parse(data); } catch (_) {}
                previous = (data && typeof data === 'object') ? Number(data.quality) || 0 : heightOf(data);
                // Refreshed daily even when unchanged so `creation` never ages out.
                if (previous === height && now - Number(record.creation) < DAY_MS) return;
            }
            localStorage.setItem(PLAYER_QUALITY_KEY, JSON.stringify({
                data: JSON.stringify({ quality: height, previousQuality: previous || height }),
                expiration: now + PLAYER_QUALITY_TTL_MS,
                creation: now
            }));
        } catch (_) {}
    }

    // Before the first player exists, so it boots under this ceiling instead of
    // whatever was last stored. A one-off 720p pick in another tab would otherwise
    // cap the opening seconds of every new video until the pin below lands.
    persistPlayerQuality(heightOf(getCeilingQuality()));

    /* ==================================================================
     * PART B: quality selection
     * ================================================================== */

    const APPLY_DELAYS_MS = [250, 1000, 2500, 5000];
    const MENU_WAIT_MS = 150;
    const OBSERVER_DEBOUNCE_MS = 250;
    const MAX_ATTEMPTS_PER_VIDEO = 4;
    const PREMIUM_RE = /\b(?:premium|enhanced bitrate)\b/i;
    const FRAME_GUARD_MIN_HEIGHT = 1440;
    const FRAME_GUARD_SAMPLE_MS = 2000;
    // ~3 minutes of sampling. Long enough to outlast a pause or a background tab,
    // short enough that a video left open does not keep a timer alive forever.
    const FRAME_GUARD_MAX_SAMPLES = 90;
    const VIDEO_SELECTORS = [
        '#movie_player video',
        '.html5-video-player video',
        'video'
    ];

    const applyTimers = new Set();

    let currentVideoKey = '';
    let completedVideoKey = '';
    let activeScheduleKey = '';
    let attempts = 0;
    let observer = null;
    let observerTimer = 0;
    let watchedVideo = null;
    let removeVideoListeners = null;
    let menuSelectionRunning = false;
    let frameGuard = null;
    let stallGuard = null;

    function log() {
        if (!DEBUG) return;
        console.debug('[CrystalClear]', ...arguments);
    }

    function wait(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Live streams are linked as /live/<id> and YouTube renders the ordinary
    // watch page there without rewriting the URL.
    function getWatchVideoId() {
        try {
            const url = new URL(location.href);
            const id = url.searchParams.get('v');
            if (id) return id;
            const live = url.pathname.match(/^\/live\/([\w-]{11})(?:[/?#]|$)/);
            return live ? live[1] : '';
        } catch (_) {
            return '';
        }
    }

    function getVideoKey() {
        const id = getWatchVideoId();
        if (id) return id;
        try {
            return new URL(location.href).pathname;
        } catch (_) {
            return location.href;
        }
    }

    // The home feed's hover previews and Shorts are left on Auto: pinning those
    // only spends bandwidth.
    function isWatchPage() {
        return Boolean(getWatchVideoId());
    }

    function getPlayer() {
        return document.getElementById('movie_player')
            || document.querySelector('.html5-video-player');
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

    // The quality API is attached to the player element a beat after the element
    // itself exists. Its absence is the one case the settings-menu fallback is
    // for; its presence with nothing to report only means "not loaded yet".
    function hasQualityApi(player) {
        return Boolean(player)
            && typeof player.getAvailableQualityLevels === 'function'
            && (typeof player.setPlaybackQualityRange === 'function'
                || typeof player.setPlaybackQuality === 'function');
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
            return Array.isArray(data) ? data.filter(entry => entry && entry.isPlayable !== false) : [];
        } catch (_) {
            return [];
        }
    }

    // The video the player has actually loaded. On an SPA navigation this lags
    // the URL, and a pin made in that window lands on the outgoing video's data
    // while the new one boots unpinned.
    function getPlayerVideoId(player) {
        try {
            const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
            return (data && data.video_id) || '';
        } catch (_) {
            return '';
        }
    }

    // During an ad getAvailableQualityData() lists the ad's formats while
    // getVideoData() already names the video, so a pick made then pins a 4K video
    // at whatever the ad tops out at. The ad ending fires the <video> events that
    // bring selection back.
    function isPresentingMainVideo(player) {
        try {
            return typeof player.getPresentingPlayerType !== 'function' || player.getPresentingPlayerType() === 1;
        } catch (_) {
            return false;
        }
    }

    function isPremiumEntry(entry) {
        return Boolean(entry.paygatedQualityDetails)
            || PREMIUM_RE.test([entry.qualityLabel, entry.label, entry.name].filter(Boolean).join(' '));
    }

    function chooseTargetQuality(levels, qualityData) {
        // Prefer the levels the player reports as playable; fall back to the raw
        // level list when getAvailableQualityData is unavailable.
        const playableLevels = qualityData.map(entry => entry.quality).filter(Boolean);
        const candidates = playableLevels.length ? playableLevels : levels;

        // Filter while picking so the result is the best *allowed* level rather
        // than the best available one. 'auto' and unknown ids have no height and
        // drop out here too.
        const ceiling = getCeilingHeight();
        let bestQuality = null;
        for (const quality of candidates) {
            const height = heightOf(quality);
            if (height && height <= ceiling && height > heightOf(bestQuality)) bestQuality = quality;
        }
        if (!bestQuality) return null;

        // "1080p Premium" and plain "1080p" share the quality id hd1080; only the
        // formatId tells them apart, so it is carried along with the pick. Premium
        // is a higher-bitrate encode and pinning its formatId could leave AV1, so
        // FORCE_AV1 takes the plain entry instead.
        const matchingData = qualityData.filter(entry => entry.quality === bestQuality);
        const preferred = FORCE_AV1
            ? matchingData.find(entry => !isPremiumEntry(entry))
            : matchingData.find(isPremiumEntry);
        const entry = preferred || matchingData[0] || null;

        return {
            quality: bestQuality,
            formatId: (entry && entry.formatId) || ''
        };
    }

    function applyQualityViaApi(player, choice) {
        try {
            if (typeof player.setPlaybackQualityRange === 'function') {
                // The same call YouTube's own quality menu makes for a pick, and the
                // player only treats a range as locked when the two ends are equal.
                if (choice.formatId) {
                    player.setPlaybackQualityRange(choice.quality, choice.quality, choice.formatId);
                } else {
                    player.setPlaybackQualityRange(choice.quality, choice.quality);
                }
                return true;
            }
        } catch (_) {}

        try {
            if (typeof player.setPlaybackQuality === 'function') {
                player.setPlaybackQuality(choice.quality);
                return true;
            }
        } catch (_) {}

        return false;
    }

    /* --- Settings-menu fallback, for a player with no quality API ------- */

    function getSettingsButton(player) {
        return player && player.querySelector('.ytp-settings-button');
    }

    function getVisibleMenuItems(player) {
        return Array.from(player.querySelectorAll('.ytp-panel-menu .ytp-menuitem'))
            .filter(item => item.getClientRects().length > 0);
    }

    function closeSettings(player) {
        const button = getSettingsButton(player);
        if (button && button.getAttribute('aria-expanded') === 'true') button.click();
    }

    function parseMenuQuality(item) {
        const text = normalizeText([
            item.textContent,
            item.getAttribute('aria-label')
        ].filter(Boolean).join(' '));
        const resolutionMatch = text.match(/(?:^|\s)(\d{3,4})p(?:\d{2,3})?(?=\s|$)/i);
        if (!resolutionMatch) return null;

        return {
            item,
            resolution: Number(resolutionMatch[1]),
            premium: PREMIUM_RE.test(text),
            selected: item.getAttribute('aria-checked') === 'true'
        };
    }

    function chooseHighestMenuQuality(items) {
        // This path reads heights out of label text, so it shares the ceiling as a
        // height rather than through chooseTargetQuality.
        const ceiling = getCeilingHeight();
        const choices = items.map(parseMenuQuality).filter(Boolean)
            .filter(choice => choice.resolution <= ceiling);
        choices.sort((left, right) => {
            if (right.resolution !== left.resolution) return right.resolution - left.resolution;
            const premiumFirst = Number(right.premium) - Number(left.premium);
            return FORCE_AV1 ? -premiumFirst : premiumFirst;
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

        // Matched by the "720p" it shows as well as by name, so this works in any
        // interface language.
        const menuItems = getVisibleMenuItems(player);
        const qualityEntry = menuItems.find(item => normalizeText(item.textContent).includes('quality')
            || normalizeText(item.getAttribute('aria-label')).includes('quality'))
            || menuItems.find(item => {
                const content = item.querySelector('.ytp-menuitem-content');
                return content && /\b\d{3,4}p\b/i.test(content.textContent || '');
            });
        if (!qualityEntry) return false;

        qualityEntry.click();
        await wait(MENU_WAIT_MS);
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

    async function selectViaMenuFallback(player, expectedVideoKey) {
        // Menu not built yet. Don't burn an attempt while the player initialises.
        if (!getSettingsButton(player)) return;

        menuSelectionRunning = true;
        attempts += 1;
        try {
            if (await selectHighestQualityViaMenu(player) && expectedVideoKey === getVideoKey()) {
                markCompleted(expectedVideoKey);
            }
        } catch (_) {
            closeSettings(player);
        } finally {
            menuSelectionRunning = false;
        }
    }

    /* --- Selection ------------------------------------------------------ */

    function markCompleted(videoKey) {
        completedVideoKey = videoKey;
        clearApplyTimers();
    }

    // One pin per video. Everything after that is the viewer's: a manual pick
    // has to survive the next pause, resume or rebuffer.
    function selectHighestQuality() {
        if (menuSelectionRunning || attempts >= MAX_ATTEMPTS_PER_VIDEO) return;
        if (!isWatchPage()) return;

        const expectedVideoKey = getVideoKey();
        const player = getPlayer();
        if (!player) return;

        if (!hasQualityApi(player)) {
            selectViaMenuFallback(player, expectedVideoKey);
            return;
        }

        // Formats not loaded yet, the player still holds the previous video, or an
        // ad is on screen: wait for the next scheduled try or player event. None of
        // these spends an attempt or touches the settings menu.
        if (!isPresentingMainVideo(player)) return;
        const playerVideoId = getPlayerVideoId(player);
        if (playerVideoId && playerVideoId !== expectedVideoKey) return;
        const choice = chooseTargetQuality(getAvailableQualityLevels(player), getAvailableQualityData(player));
        if (!choice) return;

        attempts += 1;
        if (!applyQualityViaApi(player, choice)) return;
        log('Pinned', choice);

        // After the pin, not before: the player rewrites this record itself when
        // a pick lands below the top level on offer, and the ceiling, not this
        // video's pick, is what the next video should boot under.
        persistPlayerQuality(heightOf(getCeilingQuality()));
        markCompleted(expectedVideoKey);
        startGuards(expectedVideoKey, choice.quality);
    }

    function clearApplyTimers() {
        applyTimers.forEach(timerId => window.clearTimeout(timerId));
        applyTimers.clear();
        activeScheduleKey = '';
    }

    function scheduleQualitySelection(force) {
        if (!isWatchPage()) return;
        const videoKey = getVideoKey();
        if (completedVideoKey === videoKey || attempts >= MAX_ATTEMPTS_PER_VIDEO) return;
        if (!force && activeScheduleKey === videoKey) return;

        clearApplyTimers();
        activeScheduleKey = videoKey;
        APPLY_DELAYS_MS.forEach(delay => {
            const timerId = window.setTimeout(() => {
                applyTimers.delete(timerId);
                selectHighestQuality();
                // A round spent without a pick must stop claiming the video is
                // scheduled, or the next player event (an ad ending, a slow stream
                // finally reaching canplay) is ignored and a load slower than the
                // last delay never gets its quality set at all.
                if (!applyTimers.size && activeScheduleKey === videoKey) activeScheduleKey = '';
            }, delay);
            applyTimers.add(timerId);
        });
    }

    /* --- Guards --------------------------------------------------------- */

    function startGuards(videoKey, quality) {
        startFrameGuard(videoKey, quality);
        startStallGuard(videoKey, quality);
    }

    // Asks for the best level the ceiling now allows. Callers lower the ceiling
    // first, so this only ever moves down, and it restarts the guards there.
    function stepDown(player, guard, why) {
        if (!hasQualityApi(player)) return;

        const choice = chooseTargetQuality(getAvailableQualityLevels(player), getAvailableQualityData(player));
        if (!choice || heightOf(choice.quality) >= heightOf(guard.quality)) return;
        try {
            console.info('[CrystalClear] ' + why + ' at ' + guard.quality + '; stepping down to ' + choice.quality + '.');
        } catch (_) {}
        if (!applyQualityViaApi(player, choice)) return;
        persistPlayerQuality(heightOf(getCeilingQuality()));
        startGuards(guard.videoKey, choice.quality);
    }

    // True while the main video is playing at the level this guard pinned, which
    // is also what keeps both guards off a manual pick and off ads.
    function isAtGuardedLevel(player, quality) {
        if (!isPresentingMainVideo(player)) return false;
        try {
            if (typeof player.getPlaybackQuality === 'function' && player.getPlaybackQuality() !== quality) return false;
        } catch (_) {
            return false;
        }
        return true;
    }

    /* --- Frame guard ---------------------------------------------------- */

    function readFrameCounts(video) {
        try {
            const quality = video.getVideoPlaybackQuality();
            return { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
        } catch (_) {
            return null;
        }
    }

    function isInViewport(element) {
        if (typeof element.getBoundingClientRect !== 'function') return true;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || Infinity);
    }

    // Only frames rendered while the stream is visibly playing at the guarded
    // level count. Paused, seeking, sped-up, background-tab, scrolled-away, ad
    // and mid-switch intervals all inflate droppedVideoFrames for reasons that
    // have nothing to do with decode speed, so they re-baseline instead of
    // being measured.
    function isMeasurable(player, video, quality) {
        if (!player || !video || typeof video.getVideoPlaybackQuality !== 'function') return false;
        if (video.paused || video.seeking || video.playbackRate > 1) return false;
        if (document.visibilityState === 'hidden') return false;
        if (!isInViewport(video)) return false;
        return isAtGuardedLevel(player, quality);
    }

    function stopFrameGuard() {
        if (!frameGuard) return;
        window.clearTimeout(frameGuard.timer);
        frameGuard = null;
    }

    function startFrameGuard(videoKey, quality) {
        stopFrameGuard();
        if (!FRAME_GUARD || heightOf(quality) < FRAME_GUARD_MIN_HEIGHT) return;
        frameGuard = {
            videoKey,
            quality,
            frames: 0,
            dropped: 0,
            samples: 0,
            baseline: null,
            video: null,
            timer: window.setTimeout(sampleFrameGuard, FRAME_GUARD_SAMPLE_MS)
        };
    }

    function sampleFrameGuard() {
        const guard = frameGuard;
        if (!guard) return;
        guard.timer = 0;
        guard.samples += 1;
        if (guard.videoKey !== getVideoKey() || guard.samples > FRAME_GUARD_MAX_SAMPLES) {
            frameGuard = null;
            return;
        }

        const player = getPlayer();
        const video = getVideoElement();
        const counts = isMeasurable(player, video, guard.quality) ? readFrameCounts(video) : null;
        if (counts && guard.baseline && guard.video === video) {
            const frames = counts.total - guard.baseline.total;
            const dropped = counts.dropped - guard.baseline.dropped;
            // The counters restart when the element loads a new stream; a
            // negative delta is that, not a measurement.
            if (frames > 0 && dropped >= 0 && dropped <= frames) {
                guard.frames += frames;
                guard.dropped += dropped;
            }
        }
        guard.baseline = counts;
        guard.video = video;

        if (guard.frames >= FRAME_GUARD_MIN_FRAMES) {
            frameGuard = null;
            if (guard.dropped / guard.frames > FRAME_GUARD_DROP_RATIO) {
                recordFrameFailure(heightOf(guard.quality));
                stepDown(player, guard, Math.round(100 * guard.dropped / guard.frames) + '% of frames dropped');
            }
            return;
        }
        guard.timer = window.setTimeout(sampleFrameGuard, FRAME_GUARD_SAMPLE_MS);
    }

    // One bad measurement steps this page down at once, but only a second one,
    // on a later page load, is remembered for the machine: a single stutter while
    // something else hogged the CPU should not cost a month of 1440p.
    function recordFrameFailure(height) {
        frameCapHeight = Math.min(frameCapHeight, height);
        try {
            const saved = JSON.parse(localStorage.getItem(FRAME_CAP_KEY) || 'null');
            const strikes = (saved && saved.height === height && saved.until > Date.now())
                ? (Number(saved.strikes) || 0) + 1
                : 1;
            localStorage.setItem(FRAME_CAP_KEY, JSON.stringify({
                height,
                strikes,
                until: Date.now() + FRAME_CAP_TTL_MS
            }));
        } catch (_) {}
    }

    /* --- Stall guard ---------------------------------------------------- */

    function stopStallGuard() {
        if (!stallGuard) return;
        window.clearTimeout(stallGuard.timer);
        stallGuard = null;
    }

    function startStallGuard(videoKey, quality) {
        stopStallGuard();
        if (!STALL_GUARD || heightOf(quality) <= STALL_FLOOR_HEIGHT) return;
        stallGuard = {
            videoKey,
            quality,
            graceUntil: Date.now() + STALL_GRACE_MS,
            stalledAt: 0,
            strikes: [],
            timer: 0
        };
    }

    // Seeks, pauses and background tabs all wait for data for reasons that say
    // nothing about the link.
    function isStallCountable(guard) {
        const player = getPlayer();
        const video = getVideoElement();
        if (!player || !video || guard.videoKey !== getVideoKey()) return false;
        if (video.paused || video.seeking || document.visibilityState === 'hidden') return false;
        return isAtGuardedLevel(player, guard.quality);
    }

    function handleStallStart() {
        const guard = stallGuard;
        if (!guard || guard.stalledAt || !isStallCountable(guard)) return;
        guard.stalledAt = Date.now();
        // A stall that never ends has no `playing` to report it. One that starts
        // inside the grace period only counts for what it runs on past it.
        guard.timer = window.setTimeout(handleLongStall, Math.max(guard.graceUntil - guard.stalledAt, 0) + STALL_LONG_MS);
    }

    function handleLongStall() {
        const guard = stallGuard;
        if (!guard || !guard.stalledAt) return;
        guard.stalledAt = 0;
        guard.timer = 0;
        if (isStallCountable(guard)) stepDownForStalls(guard, 'A long stall');
    }

    function handleStallEnd() {
        const guard = stallGuard;
        if (!guard || !guard.stalledAt) return;
        const stalledAt = guard.stalledAt;
        const now = Date.now();
        guard.stalledAt = 0;
        window.clearTimeout(guard.timer);
        guard.timer = 0;
        if (now - stalledAt < STALL_MIN_MS || stalledAt < guard.graceUntil) return;
        // Asked again at the end: this `playing` may be an ad, a manual pick or the
        // next video starting.
        if (!isStallCountable(guard)) return;

        guard.strikes = guard.strikes.filter(at => now - at < STALL_WINDOW_MS);
        guard.strikes.push(now);
        if (guard.strikes.length >= STALL_STRIKES) stepDownForStalls(guard, 'Repeated stalls');
    }

    function handleStallCancel() {
        const guard = stallGuard;
        if (!guard || !guard.stalledAt) return;
        guard.stalledAt = 0;
        window.clearTimeout(guard.timer);
        guard.timer = 0;
    }

    function stepDownForStalls(guard, why) {
        const height = heightOf(guard.quality);
        try {
            localStorage.setItem(STALL_CAP_KEY, JSON.stringify({
                height: Math.min(getStallCapHeight(), height),
                until: Date.now() + STALL_CAP_TTL_MS
            }));
        } catch (_) {}
        stallGuard = null;
        stepDown(getPlayer(), guard, why);
    }

    /* --- Wiring --------------------------------------------------------- */

    function handleVideoChange() {
        const nextVideoKey = getVideoKey();
        const changed = nextVideoKey !== currentVideoKey;
        if (changed) {
            currentVideoKey = nextVideoKey;
            completedVideoKey = '';
            attempts = 0;
            menuSelectionRunning = false;
            attachVideoListeners();
            installObserver();
        }
        scheduleQualitySelection(changed);
    }

    function attachVideoListeners() {
        const video = getVideoElement();
        if (!video || video === watchedVideo) return;

        if (removeVideoListeners) removeVideoListeners();
        watchedVideo = video;

        const handlers = {
            loadedmetadata: handleVideoChange,
            loadeddata: handleVideoChange,
            canplay: handleVideoChange,
            playing: () => {
                handleVideoChange();
                handleStallEnd();
            },
            waiting: handleStallStart,
            seeking: handleStallCancel,
            pause: handleStallCancel
        };
        Object.keys(handlers).forEach(name => video.addEventListener(name, handlers[name], { passive: true }));

        removeVideoListeners = () => {
            Object.keys(handlers).forEach(name => video.removeEventListener(name, handlers[name]));
            if (watchedVideo === video) watchedVideo = null;
        };
    }

    function getObservationRoot() {
        return document.querySelector('#player')
            || document.querySelector('ytd-watch-flexy')
            || document.body
            || document.documentElement;
    }

    function installObserver() {
        if (observer) observer.disconnect();

        // Off the watch page there is no #player and no ytd-watch-flexy, so the root
        // falls back to <body> and every card the infinite feed appends fires the
        // callback. Nothing needs observing until a player exists.
        if (!isWatchPage()) {
            observer = null;
            return;
        }

        const root = getObservationRoot();
        if (!root) return;

        // subtree:true is not optional: #movie_player is a grandchild of #player,
        // so a childList-only observer would miss the player remount and the
        // ad -> content <video> swap. YouTube mutates this subtree about once a
        // second by rewriting .ytp-time-current, which adds a Text node, so the
        // nodeType check throws that whole class away before any timer work.
        observer = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (!node || node.nodeType !== 1) continue;
                    const carriesVideo = node.tagName === 'VIDEO'
                        || (typeof node.querySelector === 'function' && node.querySelector('video'));
                    if (!carriesVideo) continue;
                    window.clearTimeout(observerTimer);
                    observerTimer = window.setTimeout(() => {
                        observerTimer = 0;
                        attachVideoListeners();
                    }, OBSERVER_DEBOUNCE_MS);
                    return;
                }
            }
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function logPlaybackStats() {
        try {
            const video = getVideoElement();
            const player = getPlayer();
            if (video && player && typeof player.getStatsForNerds === 'function') {
                const stats = player.getStatsForNerds();
                const frames = readFrameCounts(video);
                log({
                    codecs: stats.codecs,
                    bandwidth: stats.bandwidth_kbps,
                    buffer: stats.buffer_health_seconds,
                    quality: player.getPlaybackQuality(),
                    ceiling: getCeilingQuality(),
                    dropped: frames && frames.dropped,
                    total: frames && frames.total
                });
            }
        } catch (_) {}
        window.setTimeout(logPlaybackStats, DEBUG_INTERVAL_MS);
    }

    function start() {
        currentVideoKey = getVideoKey();
        attachVideoListeners();
        installObserver();
        scheduleQualitySelection(true);
        if (DEBUG) window.setTimeout(logPlaybackStats, DEBUG_INTERVAL_MS);
    }

    // On document only: these bubble, so also binding window would run every
    // handler twice per navigation.
    ['yt-navigate-finish', 'yt-page-data-updated'].forEach(eventName => {
        document.addEventListener(eventName, handleVideoChange, { passive: true });
    });
    window.addEventListener('popstate', handleVideoChange, { passive: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
