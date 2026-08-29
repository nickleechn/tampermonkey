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
// cache loses to the live probe; that AV1 survives when only one of the two
// probe configurations is power-efficient; that the observer's record filter
// drops text-node churn without losing player remounts; that preconnects target
// the non-CORS pool; and that a blocked XHR is as parseable as a blocked fetch.
//
// No browser required.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

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

// A player exposing the API path. qualityData drives chooseTargetQuality.
function makePlayer(levels, qualityData) {
    const player = makeEl('div');
    player.calls = [];
    player.getAvailableQualityLevels = () => levels.slice();
    player.getAvailableQualityData = () => (qualityData || []).slice();
    player.setPlaybackQualityRange = function (min, max) {
        player.calls.push(['setPlaybackQualityRange', min, max]);
    };
    player.setAutonavState = () => {};
    // No settings button: keeps the menu-walking fallback out of these tests.
    player.querySelector = () => null;
    return player;
}

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
    observationRoots = { '#player': makeEl('div') },
    playerApi = true,
    menuLabels = null
} = {}) {
    const clock = makeClock();
    const player = playerApi
        ? makePlayer(levels, qualityData)
        : makeMenuPlayer(menuLabels || []);
    const observed = [];
    const stored = Object.assign({}, storedSeed || {});

    const head = makeEl('head');
    const body = makeEl('body');
    const documentElement = makeEl('html');

    const selectorMap = Object.assign({}, observationRoots);

    const document = {
        readyState: 'complete',
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
            setItem: (k, v) => { stored[k] = String(v); }
        },
        navigator: {
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

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: 'Supertube.safari.user.js' });

    return {
        sandbox, player, observed, stored, clock, MediaSource, ManagedMediaSource, head,
        picked: () => player.picked
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
    env = build({ powerEfficientAv1: true, storedSeed: { 'supertube-av1-hw-v1': '1' } });
    check('a cached hardware verdict unblocks AV1 before the probe resolves',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === true);

    env = build({ powerEfficientAv1: false });
    check('with no cache the first load still starts conservative',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false);

    env = build({ powerEfficientAv1: true });
    await env.clock.flush();
    check('the probe writes its verdict back for the next load',
        env.stored['supertube-av1-hw-v1'] === '1');

    // A stale cache must lose to the live probe rather than persisting forever.
    env = build({ powerEfficientAv1: false, storedSeed: { 'supertube-av1-hw-v1': '1' } });
    await env.clock.flush();
    check('a stale cache is corrected once the probe disagrees',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === false
        && env.stored['supertube-av1-hw-v1'] === '0');

    // powerEfficient is answered per configuration: hardware that is not efficient
    // at the top of the bitrate ladder can still be efficient at the 4K60 stream
    // actually served, and blocking AV1 on the first answer alone loses that.
    env = build({ powerEfficientAv1: (video) => video.framerate === 60 });
    await env.clock.flush();
    check('AV1 survives when only the second probe configuration is efficient',
        env.MediaSource.isTypeSupported('video/mp4; codecs="av01.0.08M.08"') === true);

    console.log('\nQuality ceiling');

    env = build({ levels: ['highres', 'hd2880', 'hd2160', 'hd1080'] });
    await env.clock.flush();
    let range = env.player.calls.find((c) => c[0] === 'setPlaybackQualityRange');
    check('8K/5K are refused in favour of 4K',
        !!range && range[2] === 'hd2160',
        range ? `ceiling=${range[2]}` : 'setPlaybackQualityRange never called');

    check('the player keeps an ABR floor rather than being pinned',
        !!range && range[1] === 'hd1080' && range[1] !== range[2],
        range ? `range=[${range[1]}, ${range[2]}]` : 'n/a');

    env = build({ levels: ['hd1440', 'hd1080', 'hd720'] });
    await env.clock.flush();
    range = env.player.calls.find((c) => c[0] === 'setPlaybackQualityRange');
    check('a video that tops out below the cap still selects its best level',
        !!range && range[2] === 'hd1440', range ? `ceiling=${range[2]}` : 'n/a');

    env = build({ levels: ['hd720', 'medium'] });
    await env.clock.flush();
    range = env.player.calls.find((c) => c[0] === 'setPlaybackQualityRange');
    check('the floor never outranks the ceiling on a low-quality video',
        !!range && range[1] === 'hd720' && range[2] === 'hd720',
        range ? `range=[${range[1]}, ${range[2]}]` : 'n/a');

    console.log('\nQuality ceiling — settings-menu fallback');

    // The menu path runs whenever the player API is missing or fails. It reads
    // resolutions out of label text rather than level ids, so it needs the cap
    // applied separately — it is not covered by the chooseTargetQuality filter.
    env = build({ menuLabels: ['4320p', '2160p60', '1080p', '720p'], playerApi: false });
    await env.clock.flush();
    check('the menu fallback refuses 8K and takes 4K',
        env.picked() === '2160p60', `picked=${env.picked()}`);

    env = build({ menuLabels: ['1440p', '1080p', '720p'], playerApi: false });
    await env.clock.flush();
    check('the menu fallback still takes the best level under the cap',
        env.picked() === '1440p', `picked=${env.picked()}`);

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
