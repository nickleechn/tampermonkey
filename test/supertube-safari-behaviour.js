// Headless behavioural tests for Supertube.safari.user.js.
//
//   node test/supertube-safari-behaviour.js
//
// Evaluates the script against a stubbed WebKit DOM and asserts the behaviour
// 2.1.0 rests on: that AV1 filtering survives Safari 17+'s ManagedMediaSource
// (which declares its own static isTypeSupported and so is NOT covered by
// patching MediaSource), that VP9 is never filtered because 4K depends on it,
// that quality selection is capped below the software-decode-only 8K/5K tiers,
// that the player keeps an ABR floor instead of being pinned, and that the
// MutationObserver never falls back to observing the whole feed.
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

function build({
    href = 'https://www.youtube.com/watch?v=abc123',
    levels = ['hd2160', 'hd1080', 'hd720'],
    qualityData = null,
    hasManagedMediaSource = true,
    powerEfficientAv1 = false,
    observationRoots = { '#player': makeEl('div') }
} = {}) {
    const clock = makeClock();
    const player = makePlayer(levels, qualityData);
    const observed = [];
    const stored = {};

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
        observe(root, opts) { observed.push({ root, opts }); }
        disconnect() { this.disconnected = true; }
    }

    class XMLHttpRequest {
        open() {} send() {} addEventListener() {} dispatchEvent() {}
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
                decodingInfo: () => Promise.resolve({
                    supported: true, powerEfficient: powerEfficientAv1
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

    return { sandbox, player, observed, stored, clock, MediaSource, ManagedMediaSource };
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
    check('an unblocked fetch still reaches the native implementation',
        (await allowed.text()) === 'native');

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    console.log(failed.length
        ? `${failed.length} OF ${results.length} CHECKS FAILED`
        : `ALL ${results.length} CHECKS PASSED`);
    process.exit(failed.length ? 1 : 0);
})();
