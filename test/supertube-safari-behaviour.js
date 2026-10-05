// Headless behavioural tests for Supertube.safari.user.js.
//
//   node test/supertube-safari-behaviour.js
//
// Evaluates the script against a stubbed WebKit DOM and asserts the behaviour
// 2.1.0 rests on: that AV1 filtering survives Safari 17+'s ManagedMediaSource
// (which declares its own static isTypeSupported and so is NOT covered by
// patching MediaSource), that VP9 is never filtered because 4K depends on it,
// that quality selection is capped below the software-decode-only 8K/5K tiers
// on BOTH the player-API path and the settings-menu fallback, that the player
// keeps an ABR floor instead of being pinned, and that the MutationObserver
// never falls back to observing the whole feed.
//
// 2.2.0 adds: that a cached hardware-AV1 verdict is applied SYNCHRONOUSLY, before
// decodingInfo() settles (the window the player actually asks in, which every
// other check here misses because it runs after clock.flush()); that a stale
// cache loses to the live probe; that a verdict signed by different hardware or
// a different Safari major is ignored; that AV1 survives when only one of the two
// probe configurations is power-efficient; that the observer's record filter
// drops text-node churn without losing player remounts; that preconnects target
// the non-CORS pool; and that a blocked XHR is as parseable as a blocked fetch.
//
// 2.3.0 rests on behaviour read out of YouTube's own player (base.js 8ab5c328):
// its quality menu picks with setPlaybackQualityRange(q, q, formatId), and a
// range only counts as locked when min === max. So: the pick is pinned and
// carries its formatId; Premium 1080p is chosen through that formatId with no
// menu walk; an API that exists but has not loaded formats never falls back to
// clicking the menu or spends an attempt; a player still holding the previous
// video is not pinned; a round that ends without a pick re-arms on the next
// player event; yt-player-quality is raised to the ceiling, in YouTube's current
// record shape, before the player boots; the default ceiling is the top of the
// ladder, 8K included, with a dropped-frame guard that steps down one level,
// only measures visible playback at the guarded level, and only remembers a
// limit after failing on two page loads; and /live/<id> counts as a watch page.
//
// No browser required.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Mirrors the signature the script builds from navigator: cores '.' Safari major.
const AV1_KEY = 'supertube-av1-hw-v2:8.18';

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'Supertube.safari.user.js'), 'utf8');

const results = [];
const check = (name, ok, extra) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// --- virtual clock ----------------------------------------------------------
// The script schedules quality selection at [250, 1000, 2500, 5000]ms, so the
// tests need to run timers deterministically rather than wait in real time.
function makeClock() {
    let now = 0;
    let seq = 0;
    const queue = new Map();
    return {
        setTimeout(fn, delay) {
            const id = ++seq;
            queue.set(id, { fn, at: now + (Number(delay) || 0) });
            return id;
        },
        clearTimeout(id) { queue.delete(id); },
        size() { return queue.size; },
        now() { return now; },
        async flush(limit = 400) {
            let steps = 0;
            while (queue.size && steps++ < limit) {
                let bestId = null;
                let bestAt = Infinity;
                for (const [id, t] of queue) {
                    if (t.at < bestAt) { bestAt = t.at; bestId = id; }
                }
                const timer = queue.get(bestId);
                queue.delete(bestId);
                now = Math.max(now, timer.at);
                try { timer.fn(); } catch (_) {}
                await new Promise((r) => setImmediate(r));
            }
        }
    };
}

function makeEl(tag) {
    return {
        tagName: String(tag).toUpperCase(),
        nodeType: 1,
        attributes: {},
        children: [],
        textContent: '',
        rel: '', href: '', crossOrigin: undefined,
        isConnected: true,
        setAttribute(k, v) { this.attributes[k] = String(v); },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        addEventListener() {}, removeEventListener() {}, remove() {},
        appendChild(c) { this.children.push(c); return c; },
        querySelector: () => null,
        querySelectorAll: () => [],
        getClientRects: () => [{}],
        click() { this.clicked = (this.clicked || 0) + 1; }
    };
}

// A player exposing the API path. qualityData drives chooseTargetQuality. Both
// lists live on the player so a test can change them mid-run, the way formats
// arrive after the element exists.
function makePlayer(levels, qualityData, { videoId = null, settingsButton = false } = {}) {
    const player = makeEl('div');
    player.calls = [];
    player.levels = levels;
    player.qualityData = qualityData || [];
    player.current = 'auto';
    player.presentingType = 1;
    player.getAvailableQualityLevels = () => player.levels.slice();
    player.getAvailableQualityData = () => player.qualityData.slice();
    player.setPlaybackQualityRange = function (...args) {
        player.calls.push(['setPlaybackQualityRange', ...args]);
        player.current = args[1] || args[0];
    };
    // What is actually streaming. Follows the last pin unless a test overrides it.
    player.getPlaybackQuality = () => player.current;
    player.getPresentingPlayerType = () => player.presentingType;
    player.videoId = videoId;
    player.getVideoData = () => ({ video_id: player.videoId || '' });
    player.setAutonavState = () => {};
    // A settings button only when asked, to prove the API path never touches it.
    player.settingsButton = makeEl('button');
    player.querySelector = (sel) =>
        (settingsButton && sel === '.ytp-settings-button' ? player.settingsButton : null);
    return player;
}

// A <video> whose frame counters advance with the virtual clock, dropping
// frames at whatever rate dropRatio(currentQuality) says.
function makeVideo(clock, player, { fps = 60, dropRatio = () => 0 } = {}) {
    const video = makeEl('video');
    video.paused = false;
    video.seeking = false;
    video.playbackRate = 1;
    video.listeners = {};
    video.addEventListener = (type, fn) => {
        (video.listeners[type] = video.listeners[type] || []).push(fn);
    };
    video.removeEventListener = (type, fn) => {
        video.listeners[type] = (video.listeners[type] || []).filter((f) => f !== fn);
    };
    video.fire = (type) => (video.listeners[type] || []).slice().forEach((fn) => fn({ type }));
    video.getBoundingClientRect = () => ({ width: 1280, top: 0, bottom: 720 });
    let total = 0;
    let dropped = 0;
    let lastAt = 0;
    video.getVideoPlaybackQuality = () => {
        const now = clock.now();
        const frames = Math.floor((now - lastAt) * fps / 1000);
        if (frames > 0) {
            if (!video.paused) {
                total += frames;
                dropped += Math.round(frames * dropRatio(player.getPlaybackQuality()));
            }
            lastAt = now;
        }
        return { totalVideoFrames: total, droppedVideoFrames: dropped };
    };
    return video;
}

function storedQuality(stored) {
    const record = JSON.parse(stored['yt-player-quality']);
    return { record, data: JSON.parse(record.data) };
}

const FRAME_CAP_KEY = 'supertube-frame-cap-v1:8.18';

// A player with NO quality API, forcing selectHighestQuality down the
// settings-menu fallback. Models the two-step menu: the root panel offers a
// "Quality" row, clicking it swaps in the resolution rows.
function makeMenuPlayer(labels) {
    const player = makeEl('div');
    player.picked = null;

    const settingsButton = makeEl('button');
    settingsButton.setAttribute('aria-expanded', 'false');

    const qualityRow = makeEl('div');
    qualityRow.textContent = 'Quality';
    qualityRow.click = () => { player.menuState = 'quality'; };

    const options = labels.map((label) => {
        const item = makeEl('div');
        item.textContent = label;
        item.setAttribute('aria-label', label);
        item.setAttribute('aria-checked', 'false');
        item.click = () => { player.picked = label; };
        return item;
    });

    player.menuState = 'root';
    player.querySelector = (sel) =>
        (sel === '.ytp-settings-button' ? settingsButton : null);
    player.querySelectorAll = (sel) => {
        if (!String(sel).includes('ytp-menuitem')) return [];
        return player.menuState === 'quality' ? options : [qualityRow];
    };
    return player;
}

function build({
    href = 'https://www.youtube.com/watch?v=abc123',
    levels = ['hd2160', 'hd1080', 'hd720'],
    qualityData = null,
    hasManagedMediaSource = true,
    powerEfficientAv1 = false,
    storedSeed = null,
    hardwareConcurrency = 8,
    safariVersion = '18',
    observationRoots = { '#player': makeEl('div') },
    playerApi = true,
    menuLabels = null,
    videoId = null,
    settingsButton = false,
    video = null,
    visibilityState = 'visible',
    patch = {}
} = {}) {
    const clock = makeClock();
    const player = playerApi
        ? makePlayer(levels, qualityData, { videoId, settingsButton })
        : makeMenuPlayer(menuLabels || []);
    const videoEl = video ? makeVideo(clock, player, video) : null;
    const observed = [];
    const stored = Object.assign({}, storedSeed || {});
    const writes = [];

    const head = makeEl('head');
    const body = makeEl('body');
    const documentElement = makeEl('html');

    const selectorMap = Object.assign({}, observationRoots);
    if (videoEl) selectorMap['#movie_player video'] = videoEl;

    const document = {
        readyState: 'complete',
        visibilityState,
        head, body, documentElement,
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => (id === 'movie_player' ? player : null),
        querySelector(sel) {
            if (sel in selectorMap) return selectorMap[sel];
            if (sel === '.html5-video-player') return player;
            return null;
        },
        addEventListener() {}, removeEventListener() {}
    };

    const nativeIsTypeSupported = (mime) => !/theora/i.test(String(mime));

    // Mirrors WebKit: ManagedMediaSource : MediaSource, but declaring its OWN
    // static isTypeSupported, which shadows the inherited (patched) one.
    class MediaSource {}
    MediaSource.isTypeSupported = nativeIsTypeSupported;
    class ManagedMediaSource extends MediaSource {}
    if (hasManagedMediaSource) {
        Object.defineProperty(ManagedMediaSource, 'isTypeSupported', {
            value: nativeIsTypeSupported, writable: true, configurable: true
        });
    }

    class HTMLVideoElement {}
    HTMLVideoElement.prototype.canPlayType = () => 'probably';
    class HTMLAudioElement {}
    HTMLAudioElement.prototype.canPlayType = () => 'probably';

    class MutationObserver {
        constructor(cb) { this.cb = cb; }
        observe(root, opts) { observed.push({ root, opts, observer: this }); }
        disconnect() { this.disconnected = true; }
    }

    class XMLHttpRequest {
        constructor() { this.listeners = {}; this.responseType = ''; }
        open() {} send() {}
        addEventListener(type, fn) {
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        }
        dispatchEvent(event) {
            for (const fn of this.listeners[event.type] || []) fn(event);
            return true;
        }
    }

    const sandbox = {
        console,
        URL, Event, Response, Promise, JSON, Math, Date, Set, Map, Array, Object, String, Number, Boolean, RegExp,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        document,
        location: { href },
        MediaSource, ManagedMediaSource, HTMLVideoElement, HTMLAudioElement,
        MutationObserver, XMLHttpRequest,
        localStorage: {
            getItem: (k) => (k in stored ? stored[k] : null),
            setItem: (k, v) => { stored[k] = String(v); writes.push(k); }
        },
        navigator: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
                '(KHTML, like Gecko) Version/' + safariVersion + '.0 Safari/605.1.15',
            hardwareConcurrency,
            sendBeacon: () => true,
            mediaCapabilities: {
                // powerEfficientAv1 may be a function so a test can answer
                // differently per configuration, which is the whole point of
                // probing more than one.
                decodingInfo: (config) => Promise.resolve({
                    supported: true,
                    powerEfficient: typeof powerEfficientAv1 === 'function'
                        ? powerEfficientAv1(config.video)
                        : powerEfficientAv1
                })
            }
        },
        fetch: () => Promise.resolve(new Response('native', { status: 200 })),
        addEventListener() {}, removeEventListener() {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    // Config constants can be overridden per test by rewriting their line.
    let source = SOURCE;
    for (const [from, to] of Object.entries(patch)) {
        if (!source.includes(from)) throw new Error('patch target missing: ' + from);
        source = source.replace(from, to);
    }

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'Supertube.safari.user.js' });

    return {
        sandbox, player, observed, stored, writes, clock, MediaSource, ManagedMediaSource, head,
        video: videoEl,
        picked: () => player.picked,
        ranges: () => player.calls.filter((c) => c[0] === 'setPlaybackQualityRange')
    };
}

(async () => {
    console.log('Codec filtering — the 4K-critical path\n');

    // M1/M2: probe reports AV1 decodable but NOT power efficient, so AV1 must be
    // blocked and playback must fall to hardware VP9.
    let env = build({ powerEfficientAv1: false });
    await env.clock.flush();

    check('AV1 is blocked through MediaSource on a non-power-efficient Mac',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false);

    check('AV1 is blocked through ManagedMediaSource too (Safari 17+ path)',
        env.ManagedMediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false,
        'ManagedMediaSource declares its own static; patching MediaSource alone misses it');

    check('VP9 survives both hooks, so 4K stays reachable',
        env.MediaSource.isTypeSupported('video/webm; codecs="vp9"') === true
        && env.ManagedMediaSource.isTypeSupported('video/webm; codecs="vp9"') === true);

    check('H.264 is never forced in place of VP9',
        env.MediaSource.isTypeSupported('video/webm; codecs="vp09.00.10.08"') === true);

    // M3/M4: hardware AV1, so nothing should be filtered once the probe resolves.
    env = build({ powerEfficientAv1: true });
    await env.clock.flush();
    check('AV1 is allowed once the probe reports a power-efficient decoder',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === true);

    // Every check above runs after clock.flush(), i.e. after decodingInfo() has
    // settled. That is precisely the window the player actually asks in, so the
    // synchronous seed has to be asserted with no flush at all.
    env = build({ powerEfficientAv1: true, storedSeed: { [AV1_KEY]: '1' } });
    check('a cached hardware verdict unblocks AV1 before the probe resolves',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === true);

    env = build({ powerEfficientAv1: false });
    check('with no cache the first load still starts conservative',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false);

    env = build({ powerEfficientAv1: true });
    await env.clock.flush();
    check('the probe writes its verdict back for the next load',
        env.stored[AV1_KEY] === '1');

    // A stale cache must lose to the live probe rather than persisting forever.
    env = build({ powerEfficientAv1: false, storedSeed: { [AV1_KEY]: '1' } });
    await env.clock.flush();
    check('a stale cache is corrected once the probe disagrees',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false
        && env.stored[AV1_KEY] === '0');

    // A verdict recorded on different hardware, or before a Safari major upgrade,
    // must not be trusted — that is the whole point of signing the key.
    env = build({ powerEfficientAv1: false, storedSeed: { [AV1_KEY]: '1' }, hardwareConcurrency: 12 });
    check('a verdict cached on other hardware is ignored',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false);

    env = build({ powerEfficientAv1: false, storedSeed: { [AV1_KEY]: '1' }, safariVersion: '19' });
    check('a verdict cached before a Safari major upgrade is ignored',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false);

    // powerEfficient is answered per configuration: hardware that is not efficient
    // at the top of the bitrate ladder can still be efficient at the 4K60 stream
    // actually served, and blocking AV1 on the first answer alone loses that.
    env = build({ powerEfficientAv1: (video) => video.framerate === 60 });
    await env.clock.flush();
    check('AV1 survives when only the second probe configuration is efficient',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === true);

    console.log('\nQuality selection — player API');

    env = build({ levels: ['highres', 'hd2880', 'hd2160', 'hd1080'] });
    await env.clock.flush();
    let range = env.ranges()[0];
    check('the highest level on offer is chosen, 8K included',
        !!range && range[2] === 'highres',
        range ? `ceiling=${range[2]}` : 'setPlaybackQualityRange never called');

    check('the pick is pinned (min === max), the only range YouTube treats as locked',
        !!range && range[1] === range[2],
        range ? `range=[${range[1]}, ${range[2]}]` : 'n/a');

    env = build({ levels: ['hd1440', 'hd1080', 'hd720'] });
    await env.clock.flush();
    range = env.ranges()[0];
    check('a video that tops out lower still selects its best level',
        !!range && range[1] === 'hd1440' && range[2] === 'hd1440', range ? `range=[${range[1]}, ${range[2]}]` : 'n/a');

    env = build({
        levels: ['hd2160', 'hd1080'],
        qualityData: [
            { quality: 'hd2160', qualityLabel: '2160p60', formatId: '315', isPlayable: true },
            { quality: 'hd1080', qualityLabel: '1080p60', formatId: '303', isPlayable: true }
        ]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('the pick carries its formatId, exactly like a click in the quality menu',
        !!range && range[2] === 'hd2160' && range[3] === '315',
        range ? `args=${JSON.stringify(range.slice(1))}` : 'n/a');

    env = build({
        levels: ['hd1080', 'hd720'],
        settingsButton: true,
        qualityData: [
            { quality: 'hd1080', qualityLabel: '1080p', formatId: '137', isPlayable: true },
            { quality: 'hd1080', qualityLabel: '1080p Premium', formatId: '356', isPlayable: true },
            { quality: 'hd720', qualityLabel: '720p', formatId: '136', isPlayable: true }
        ]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('Premium 1080p is selected through the API by its formatId',
        !!range && range[2] === 'hd1080' && range[3] === '356',
        range ? `args=${JSON.stringify(range.slice(1))}` : 'n/a');
    check('and the settings menu is never opened to do it',
        !env.player.settingsButton.clicked, `clicks=${env.player.settingsButton.clicked || 0}`);

    env = build({
        levels: ['hd1080', 'hd720'],
        qualityData: [
            { quality: 'hd1080', qualityLabel: '1080p', formatId: '137', isPlayable: true },
            { quality: 'hd1080', qualityLabel: '1080p Premium', formatId: '356', isPlayable: false },
            { quality: 'hd720', qualityLabel: '720p', formatId: '136', isPlayable: true }
        ]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('a paywalled Premium entry is not chosen for a non-Premium account',
        !!range && range[3] === '137', range ? `formatId=${range[3]}` : 'n/a');

    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        patch: { "const MAX_QUALITY = 'highres';": "const MAX_QUALITY = 'hd2160';" }
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('an explicit MAX_QUALITY cap is still honoured',
        !!range && range[2] === 'hd2160', range ? `ceiling=${range[2]}` : 'n/a');

    env = build({
        levels: ['hd2160', 'hd1080', 'hd720'],
        qualityData: [{ quality: 'hd2160', qualityLabel: '2160p', formatId: '313', isPlayable: true }],
        patch: { 'const MIN_QUALITY = null;': "const MIN_QUALITY = 'hd1080';" }
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('a configured floor still yields a range, and a range carries no formatId',
        !!range && range[1] === 'hd1080' && range[2] === 'hd2160' && range.length === 3,
        range ? `args=${JSON.stringify(range.slice(1))}` : 'n/a');

    env = build({
        levels: ['hd720', 'medium'],
        patch: { 'const MIN_QUALITY = null;': "const MIN_QUALITY = 'hd1080';" }
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('the floor never outranks the ceiling on a low-quality video',
        !!range && range[1] === 'hd720' && range[2] === 'hd720',
        range ? `range=[${range[1]}, ${range[2]}]` : 'n/a');

    env = build({ href: 'https://www.youtube.com/live/abcdefghijk', videoId: 'abcdefghijk' });
    await env.clock.flush();
    check('a /live/<id> URL is treated as a watch page',
        env.ranges().length === 1, `calls=${env.ranges().length}`);

    console.log('\nQuality selection — timing');

    // Formats arrive after the element and its settings button exist. Opening
    // the menu in that window used to flash the panel and burn the attempts.
    env = build({ levels: [], settingsButton: true, video: {} });
    await env.clock.flush();
    check('an API with no formats yet neither opens the menu nor pins anything',
        !env.player.settingsButton.clicked && env.ranges().length === 0,
        `clicks=${env.player.settingsButton.clicked || 0} pins=${env.ranges().length}`);

    env.player.levels = ['hd2160', 'hd1080'];
    env.video.fire('canplay');
    await env.clock.flush();
    range = env.ranges()[0];
    check('a round that ended without a pick re-arms on the next player event',
        !!range && range[2] === 'hd2160', range ? `ceiling=${range[2]}` : 'never re-armed');

    // On an SPA navigation the URL changes before the player swaps videos.
    env = build({ videoId: 'previous000', video: {} });
    await env.clock.flush();
    check('a player still holding the previous video is not pinned',
        env.ranges().length === 0, `pins=${env.ranges().length}`);

    env.player.videoId = 'abc123';
    env.video.fire('loadedmetadata');
    await env.clock.flush();
    check('and is pinned once the new video has loaded',
        env.ranges().length === 1, `pins=${env.ranges().length}`);

    console.log('\nStored quality preference');

    const day = 24 * 60 * 60 * 1000;
    const legacyNow = Date.now();
    env = build({
        storedSeed: {
            'yt-player-quality': JSON.stringify({
                data: JSON.stringify({ quality: 720, previousQuality: 1080 }),
                expiration: legacyNow + 300 * day,
                creation: legacyNow
            })
        }
    });
    // No flush: this has to land before the player boots, synchronously.
    let pref = storedQuality(env.stored);
    check('a lower stored preference is raised to the ceiling before the player boots',
        pref.data.quality === 4320, `quality=${pref.data.quality}`);
    check('in YouTube\'s current record shape (data is a JSON string of heights)',
        typeof pref.record.data === 'string' && pref.data.previousQuality === 720
        && pref.record.expiration > pref.record.creation,
        pref.record.data);

    env = build({
        storedSeed: {
            'yt-player-quality': JSON.stringify({
                data: 'hd720', expiration: legacyNow + day, creation: legacyNow
            })
        }
    });
    pref = storedQuality(env.stored);
    check('the legacy "data":"hd720" form is read and replaced',
        pref.data.quality === 4320 && pref.data.previousQuality === 720, pref.record.data);

    env = build({
        storedSeed: {
            'yt-player-quality': JSON.stringify({
                data: JSON.stringify({ quality: 4320, previousQuality: 4320 }),
                expiration: legacyNow + 300 * day,
                creation: legacyNow
            })
        }
    });
    await env.clock.flush();
    check('a current, fresh record is left alone',
        !env.writes.includes('yt-player-quality'), `writes=${env.writes.join(',')}`);

    env = build({
        storedSeed: {
            'yt-player-quality': JSON.stringify({
                data: JSON.stringify({ quality: 4320, previousQuality: 4320 }),
                expiration: legacyNow + 300 * day,
                creation: legacyNow - 2 * day
            })
        }
    });
    pref = storedQuality(env.stored);
    check('an ageing record is refreshed before YouTube\'s 30-day cut-off ignores it',
        pref.record.creation >= legacyNow, `creation=${pref.record.creation}`);

    console.log('\nFrame guard');

    env = build({ levels: ['highres', 'hd2160', 'hd1080'], video: {} });
    await env.clock.flush();
    check('healthy 8K playback is left at 8K',
        env.ranges().length === 1 && env.ranges()[0][2] === 'highres' && !env.stored[FRAME_CAP_KEY],
        `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        video: { dropRatio: (q) => (q === 'highres' ? 0.3 : 0) }
    });
    await env.clock.flush();
    let pins = env.ranges().map((c) => c[2]).join('>');
    check('heavy drops at 8K step down one level, to 4K',
        pins === 'highres>hd2160', `pins=${pins}`);
    const cap = env.stored[FRAME_CAP_KEY] ? JSON.parse(env.stored[FRAME_CAP_KEY]) : null;
    check('and the failure is recorded as a first strike for this Mac',
        !!cap && cap.height === 4320 && cap.strikes === 1, JSON.stringify(cap));

    env = build({
        levels: ['highres', 'hd2160', 'hd1440', 'hd1080'],
        video: { dropRatio: () => 0.3 }
    });
    await env.clock.flush();
    pins = env.ranges().map((c) => c[2]).join('>');
    check('it keeps stepping while drops persist, but never below 1080p',
        pins === 'highres>hd2160>hd1440>hd1080', `pins=${pins}`);

    const future = Date.now() + 10 * day;
    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        storedSeed: { [FRAME_CAP_KEY]: JSON.stringify({ height: 4320, strikes: 1, until: future }) }
    });
    await env.clock.flush();
    check('one failed page load does not cap the next one',
        env.ranges()[0] && env.ranges()[0][2] === 'highres', `ceiling=${env.ranges()[0] && env.ranges()[0][2]}`);

    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        storedSeed: { [FRAME_CAP_KEY]: JSON.stringify({ height: 4320, strikes: 2, until: future }) }
    });
    await env.clock.flush();
    check('two failed page loads cap this Mac below the failing level',
        env.ranges()[0] && env.ranges()[0][2] === 'hd2160', `ceiling=${env.ranges()[0] && env.ranges()[0][2]}`);
    // Exclusive cap: 8K failed, so the next rung down (5K) is what players boot under.
    check('and the stored preference boots players under that cap',
        storedQuality(env.stored).data.quality === 2880, env.stored['yt-player-quality']);

    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        storedSeed: { [FRAME_CAP_KEY]: JSON.stringify({ height: 4320, strikes: 2, until: Date.now() - 1 }) }
    });
    await env.clock.flush();
    check('an expired cap is ignored, so the Mac gets re-tested',
        env.ranges()[0] && env.ranges()[0][2] === 'highres', `ceiling=${env.ranges()[0] && env.ranges()[0][2]}`);

    env = build({ levels: ['highres', 'hd2160'], video: { dropRatio: () => 0.5 }, visibilityState: 'hidden' });
    await env.clock.flush();
    check('a background tab is never measured',
        env.ranges().length === 1, `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    env = build({ levels: ['highres', 'hd2160'], video: { dropRatio: () => 0.5 } });
    env.video.paused = true;
    await env.clock.flush();
    check('a paused video is never measured',
        env.ranges().length === 1, `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    // Before the stream reaches the pinned level, drops belong to the old one.
    env = build({ levels: ['highres', 'hd2160'], video: { dropRatio: () => 0.5 } });
    env.player.getPlaybackQuality = () => 'hd1080';
    await env.clock.flush();
    check('frames are only counted once the stream is actually at the guarded level',
        env.ranges().length === 1, `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    env = build({ levels: ['highres', 'hd2160'], video: { dropRatio: () => 0.5 } });
    env.player.presentingType = 2;
    await env.clock.flush();
    check('an ad is never measured',
        env.ranges().length === 1, `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    env = build({ levels: ['hd1080', 'hd720'], video: { dropRatio: () => 0.5 } });
    await env.clock.flush();
    check('1080p and below are never guarded',
        env.ranges().length === 1 && !env.stored[FRAME_CAP_KEY], `pins=${env.ranges().map((c) => c[2]).join('>')}`);

    console.log('\nSettings-menu fallback');

    // The menu path runs only when the player API is missing. It reads
    // resolutions out of label text rather than level ids, so it needs the
    // ceiling applied separately — it is not covered by chooseTargetQuality.
    env = build({ menuLabels: ['4320p', '2160p60', '1080p', '720p'], playerApi: false });
    await env.clock.flush();
    check('the menu fallback takes the highest level, 8K included',
        env.picked() === '4320p', `picked=${env.picked()}`);

    env = build({
        menuLabels: ['4320p', '2160p60', '1080p', '720p'],
        playerApi: false,
        storedSeed: { [FRAME_CAP_KEY]: JSON.stringify({ height: 4320, strikes: 2, until: future }) }
    });
    await env.clock.flush();
    check('a learned cap binds the menu fallback too',
        env.picked() === '2160p60', `picked=${env.picked()}`);

    env = build({
        menuLabels: ['4320p', '2160p60', '1080p'],
        playerApi: false,
        patch: { "const MAX_QUALITY = 'highres';": "const MAX_QUALITY = 'hd2160';" }
    });
    await env.clock.flush();
    check('and so does an explicit MAX_QUALITY',
        env.picked() === '2160p60', `picked=${env.picked()}`);

    env = build({ menuLabels: ['2160p', '1080p Premium', '1080p'], playerApi: false });
    await env.clock.flush();
    check('the menu fallback prefers resolution over the Premium label',
        env.picked() === '2160p', `picked=${env.picked()}`);

    console.log('\nObserver scope');

    env = build({ observationRoots: { '#player': makeEl('div') } });
    await env.clock.flush();
    check('a watch page observes the player subtree',
        env.observed.length > 0 && env.observed[0].root.tagName === 'DIV');

    // Feed pages have no #player and no ytd-watch-flexy.
    env = build({ href: 'https://www.youtube.com/', observationRoots: {} });
    await env.clock.flush();
    check('a feed page installs no observer at all',
        env.observed.length === 0,
        env.observed.length ? `observed ${env.observed[0].root.tagName}` : '');

    check('and never falls back to observing <body>',
        !env.observed.some((o) => o.root.tagName === 'BODY'));

    // The player subtree churns ~1Hz purely from .ytp-time-current being
    // rewritten, which appends a Text node. Those must not reach the debounce.
    env = build({ observationRoots: { '#player': makeEl('div') } });
    await env.clock.flush();
    const observer = env.observed[0].observer;
    let before = env.clock.size();
    observer.cb([{ addedNodes: [{ nodeType: 3, textContent: '1:23' }] }]);
    check('a text-node mutation schedules no work',
        env.clock.size() === before);

    const chrome = makeEl('div');
    observer.cb([{ addedNodes: [chrome] }]);
    check('an unrelated element mutation schedules no work either',
        env.clock.size() === before);

    observer.cb([{ addedNodes: [makeEl('video')] }]);
    check('a <video> insertion still schedules a re-attach',
        env.clock.size() === before + 1);

    // Drain first: the debounce cancels the pending timer before scheduling the
    // next one, so back-to-back hits leave the queue the same size rather than
    // growing it.
    await env.clock.flush();
    const wrapper = makeEl('div');
    wrapper.querySelector = (sel) => (sel === 'video' ? makeEl('video') : null);
    before = env.clock.size();
    observer.cb([{ addedNodes: [wrapper] }]);
    check('a remounted container carrying a <video> is caught too',
        env.clock.size() === before + 1);

    console.log('\nPreconnect hints');

    env = build();
    const hints = env.head.children.filter((el) => el.rel === 'preconnect');
    check('preconnects target the non-CORS pool the assets actually use',
        hints.length === 3 && hints.every((h) => !h.crossOrigin),
        hints.length ? 'crossOrigin=' + String(hints[0].crossOrigin) : 'no hints');

    console.log('\nBlocked requests stay parseable');

    env = build();
    await env.clock.flush();
    const blocked = await env.sandbox.fetch('https://www.youtube.com/youtubei/v1/log_event?x=1');
    let parsed = null;
    let threw = null;
    try { parsed = await blocked.clone().json(); } catch (e) { threw = e; }
    check('a blocked fetch resolves to valid JSON rather than an unparseable 204',
        threw === null && parsed && typeof parsed === 'object',
        threw ? `${threw.name}: ${threw.message}` : `body=${JSON.stringify(parsed)}`);

    const allowed = await env.sandbox.fetch('https://www.youtube.com/watch?v=abc123');
    env = build();
    const xhr = new env.sandbox.XMLHttpRequest();
    let xhrParsed = null;
    let xhrThrew = null;
    xhr.addEventListener('load', () => {
        try { xhrParsed = JSON.parse(xhr.responseText); } catch (err) { xhrThrew = err; }
    });
    xhr.open('POST', 'https://www.youtube.com/youtubei/v1/log_event');
    xhr.send('{}');
    await env.clock.flush();
    check('a blocked XHR is parseable too, matching the fetch path',
        xhrThrew === null && xhrParsed !== null && xhr.status === 200
        && xhr.response === '{}',
        xhrThrew ? String(xhrThrew.message) : 'status=' + xhr.status);

    check('an unblocked fetch still reaches the native implementation',
        (await allowed.text()) === 'native');

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    console.log(failed.length
        ? `${failed.length} OF ${results.length} CHECKS FAILED`
        : `ALL ${results.length} CHECKS PASSED`);
    process.exit(failed.length ? 1 : 0);
})();
