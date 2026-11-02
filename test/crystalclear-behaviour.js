// Headless behavioural tests for CyrstalClear.js.
//
//   node test/crystalclear-behaviour.js
//
// Evaluates the script against a stubbed DOM and asserts the behaviour 2.0 rests
// on, read out of YouTube's own player (base.js 11a45ffb): that
// html5_force_av1_for_testing and html5_default_av1_threshold reach every player
// config whichever side of the page's `var ytcfg` the script lands on; that the pick is pinned with its
// formatId, under the ceiling, on both the API and menu paths; that a video gets
// one pin, so a manual pick survives the next `playing`; that only watch pages
// are pinned, and never during an ad or while the player still holds the
// outgoing video; that
// yt-player-quality holds the ceiling in YouTube's current shape and never ages
// out; and that the frame and stall guards step down one level, measure only
// what they should, and remember what they should.
//
// $CC_SCRIPT runs another build, e.g. 1.1, to see what it fails.
//
// No browser required.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = process.env.CC_SCRIPT || path.join(__dirname, '..', 'CyrstalClear.js');
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const OTHER_BUILD = Boolean(process.env.CC_SCRIPT);

// The page's own inline bootstrap, as served on a watch page.
const YTCFG_PAGE = 'var ytcfg={d:function(){return window.yt&&yt.config_||ytcfg.data_||(ytcfg.data_={})},' +
    'get:function(k,o){return k in ytcfg.d()?ytcfg.d()[k]:o},' +
    'set:function(){var a=arguments;if(a.length>1)ytcfg.d()[a[0]]=a[1];' +
    'else{var k;for(k in a[0])ytcfg.d()[k]=a[0][k]}}};';
const FORCE_FLAG = 'html5_force_av1_for_testing';
const THRESHOLD_FLAG = 'html5_default_av1_threshold';
const CONFIGS_KEY = 'WEB_PLAYER_CONTEXT_CONFIGS';
const FRAME_CAP_KEY = 'crystalclear-frame-cap-v1:8.156';
const STALL_CAP_KEY = 'crystalclear-stall-cap-v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = 1800000000000;

const results = [];
const check = (name, ok, extra) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// --- virtual clock ----------------------------------------------------------
function makeClock() {
    let now = 0;
    let seq = 0;
    const queue = new Map();
    const runNext = async (until) => {
        let bestId = null;
        let bestAt = Infinity;
        for (const [id, t] of queue) {
            if (t.at < bestAt) { bestAt = t.at; bestId = id; }
        }
        if (bestId === null || bestAt > until) return false;
        const timer = queue.get(bestId);
        queue.delete(bestId);
        now = Math.max(now, timer.at);
        try { timer.fn(); } catch (_) {}
        await new Promise((r) => setImmediate(r));
        return true;
    };
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
            while (queue.size && steps++ < limit && await runNext(Infinity));
        },
        // Runs what falls due in the next `ms`, then leaves the clock there.
        async advance(ms) {
            const until = now + ms;
            while (await runNext(until));
            now = until;
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

// A player exposing the API path. Both lists live on the player so a test can
// change them mid-run, the way formats arrive after the element exists.
function makePlayer(levels, qualityData, { videoId = null, settingsButton = false } = {}) {
    const player = makeEl('div');
    player.calls = [];
    player.levels = levels;
    player.qualityData = qualityData || [];
    player.current = 'auto';
    player.presentingType = 1;
    player.getAvailableQualityLevels = () => player.levels.slice();
    // During an ad the player answers this one for the ad, and only this one.
    player.adData = [];
    player.getAvailableQualityData = () => (player.presentingType === 2 ? player.adData : player.qualityData).slice();
    player.setPlaybackQualityRange = function (...args) {
        player.calls.push(args);
        player.current = args[1] || args[0];
    };
    // What is actually streaming. Follows the last pin unless a test overrides it.
    player.getPlaybackQuality = () => player.current;
    player.getPresentingPlayerType = () => player.presentingType;
    player.videoId = videoId;
    player.getVideoData = () => ({ video_id: player.videoId || '' });
    // A settings button only when asked, to prove the API path never touches it.
    player.settingsButton = makeEl('button');
    player.querySelector = (sel) =>
        (settingsButton && sel === '.ytp-settings-button' ? player.settingsButton : null);
    return player;
}

// A <video> whose frame counters advance with the virtual clock, dropping frames
// at whatever rate dropRatio(currentQuality) says.
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

// A player with NO quality API, forcing selection down the settings-menu
// fallback. Models the two-step menu: the root panel offers a "Quality" row,
// clicking it swaps in the resolution rows.
function makeMenuPlayer(labels, { qualityRowLabel = 'Quality', qualityRowValue = '' } = {}) {
    const player = makeEl('div');
    player.picked = null;

    const settingsButton = makeEl('button');
    settingsButton.setAttribute('aria-expanded', 'false');
    player.settingsButton = settingsButton;

    const qualityRow = makeEl('div');
    qualityRow.textContent = qualityRowLabel;
    qualityRow.click = () => { player.menuState = 'quality'; };
    const content = makeEl('div');
    content.textContent = qualityRowValue;
    qualityRow.querySelector = (sel) => (sel === '.ytp-menuitem-content' ? content : null);

    const options = labels.map((label) => {
        const item = makeEl('div');
        item.textContent = label;
        item.setAttribute('aria-label', label);
        item.setAttribute('aria-checked', 'false');
        item.click = () => { player.picked = label; };
        return item;
    });

    player.menuState = 'root';
    player.querySelector = (sel) => (sel === '.ytp-settings-button' ? settingsButton : null);
    player.querySelectorAll = (sel) => {
        if (!String(sel).includes('ytp-menuitem')) return [];
        return player.menuState === 'quality' ? options : [qualityRow];
    };
    return player;
}

function storedQuality(stored) {
    const record = JSON.parse(stored['yt-player-quality'] || '{}');
    let data = record.data;
    try { data = JSON.parse(data); } catch (_) {}
    return { record, data: data || {} };
}

function build({
    href = 'https://www.youtube.com/watch?v=abc123',
    levels = ['hd2160', 'hd1080', 'hd720'],
    qualityData = null,
    storedSeed = null,
    hardwareConcurrency = 8,
    chromeVersion = '156',
    playerApi = true,
    menuLabels = null,
    menuOptions = {},
    videoId = null,
    settingsButton = false,
    video = null,
    visibilityState = 'visible',
    readyState = 'complete',
    patch = {},
    pageScript = null,
    startTime = BASE_TIME
} = {}) {
    const clock = makeClock();
    const player = playerApi
        ? makePlayer(levels, qualityData, { videoId, settingsButton })
        : makeMenuPlayer(menuLabels || [], menuOptions);
    const videoEl = video ? makeVideo(clock, player, video) : null;
    const observed = [];
    const stored = Object.assign({}, storedSeed || {});
    const writes = [];
    const body = makeEl('body');
    const docListeners = {};
    const winListeners = {};
    const on = (table) => (type, fn) => { (table[type] = table[type] || []).push(fn); };

    // Off the watch page there is no #player to observe.
    const selectorMap = /[?&]v=|\/live\//.test(href) ? { '#player': makeEl('div') } : {};
    if (videoEl) {
        selectorMap['#movie_player video'] = videoEl;
        selectorMap.video = videoEl;
    }

    const document = {
        readyState,
        visibilityState,
        head: makeEl('head'),
        body,
        documentElement: makeEl('html'),
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => (id === 'movie_player' ? player : null),
        querySelector(sel) {
            if (sel in selectorMap) return selectorMap[sel];
            if (sel === '.html5-video-player') return player;
            return null;
        },
        querySelectorAll: () => [],
        addEventListener: on(docListeners),
        removeEventListener() {}
    };

    class MutationObserver {
        constructor(cb) { this.cb = cb; }
        observe(root, opts) { observed.push({ root, opts, observer: this }); }
        disconnect() { this.disconnected = true; }
    }

    // The script's clocks run on the virtual one.
    class FakeDate extends Date {
        static now() { return startTime + clock.now(); }
    }

    const location = { href };
    const sandbox = {
        console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
        URL, Promise, JSON, Math, Set, Map, Array, Object, String, Number, Boolean, RegExp,
        Date: FakeDate,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        document,
        location,
        MutationObserver,
        localStorage: {
            getItem: (k) => (k in stored ? stored[k] : null),
            setItem: (k, v) => { stored[k] = String(v); writes.push(k); }
        },
        navigator: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/' + chromeVersion + '.0.0.0 Safari/537.36',
            hardwareConcurrency
        },
        addEventListener: on(winListeners),
        removeEventListener() {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    // Config constants can be overridden per test by rewriting their line.
    let source = SOURCE;
    for (const [from, to] of Object.entries(patch)) {
        if (!source.includes(from)) {
            if (OTHER_BUILD) continue;
            throw new Error('patch target missing: ' + from);
        }
        source = source.replace(from, to);
    }

    vm.createContext(sandbox);
    if (pageScript) vm.runInContext(pageScript, sandbox);
    vm.runInContext(source, sandbox, { filename: path.basename(SCRIPT_PATH) });

    return {
        sandbox, document, player, observed, stored, writes, clock, location, body,
        video: videoEl,
        picked: () => player.picked,
        ranges: () => player.calls,
        run: (code) => vm.runInContext(code, sandbox),
        fireDoc: (type) => (docListeners[type] || []).slice().forEach((fn) => fn({ type })),
        fireWin: (type) => (winListeners[type] || []).slice().forEach((fn) => fn({ type })),
        docListeners,
        winListeners,
        last: () => { const r = player.calls[player.calls.length - 1]; return r && r[1]; }
    };
}

const configFlags = (env) => {
    const configs = env.run('ytcfg.get(' + JSON.stringify(CONFIGS_KEY) + ')') || {};
    return Object.keys(configs).map((id) => String(configs[id].serializedExperimentFlags || ''));
};
const hasFlag = (flags) => flags.split('&').includes(FORCE_FLAG + '=true')
    && flags.split('&').includes(THRESHOLD_FLAG + '=8192');

// A stall of `ms`: the element waits, the clock runs, playback resumes.
async function stall(env, ms) {
    env.video.fire('waiting');
    await env.clock.advance(ms);
    env.video.fire('playing');
    await env.clock.advance(0);
}

// A pinned 4K video playing with an empty round of timers. Past the grace period
// unless asked otherwise.
async function playing4k(options = {}, { pastGrace = true } = {}) {
    const env = build({
        levels: ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large'],
        video: {},
        patch: { 'const FRAME_GUARD = true;': 'const FRAME_GUARD = false;' },
        ...options
    });
    await env.clock.advance(6000);
    if (pastGrace) await env.clock.advance(10000);
    return env;
}

(async () => {
    console.log('Forcing AV1\n');

    let env = build({ pageScript: null });
    env.run(YTCFG_PAGE);
    env.run(`ytcfg.set({${CONFIGS_KEY}:{A:{serializedExperimentFlags:'a=1&b=2'},B:{}}})`);
    let flags = (() => { try { return configFlags(env); } catch (_) { return []; } })();
    check('the flags reach every config when the script beats the page\'s var ytcfg',
        flags.length === 2 && flags.every(hasFlag), JSON.stringify(flags));
    check('the page\'s own flags are left in place', flags[0] && flags[0].includes('a=1&b=2'));

    env = build();
    env.run(YTCFG_PAGE);
    env.run(`ytcfg.set(${JSON.stringify(CONFIGS_KEY)}, {A:{serializedExperimentFlags:'c=3'}})`);
    flags = (() => { try { return configFlags(env); } catch (_) { return []; } })();
    check('the two-argument form of ytcfg.set is covered too',
        flags.length === 1 && hasFlag(flags[0]), JSON.stringify(flags));

    env = build();
    env.run(YTCFG_PAGE);
    env.run(`ytcfg.set({OTHER:1})`);
    env.run(`ytcfg.set({${CONFIGS_KEY}:{A:{serializedExperimentFlags:'${FORCE_FLAG}=false&${THRESHOLD_FLAG}=0'}}})`);
    flags = (() => { try { return configFlags(env); } catch (_) { return []; } })();
    check('values YouTube serves for the flags are replaced rather than duplicated',
        flags[0] === `${FORCE_FLAG}=true&${THRESHOLD_FLAG}=8192`, JSON.stringify(flags));

    env = build({
        pageScript: YTCFG_PAGE + `ytcfg.set({${CONFIGS_KEY}:{A:{serializedExperimentFlags:'d=4'}}});`
    });
    flags = configFlags(env);
    check('configs the page already stored are patched when the script lands after it',
        hasFlag(flags[0]) && flags[0].includes('d=4'), JSON.stringify(flags));

    env = build({ pageScript: YTCFG_PAGE });
    env.run(`ytcfg.set({${CONFIGS_KEY}:{B:{serializedExperimentFlags:''}}})`);
    flags = configFlags(env);
    check('later ytcfg.set calls are covered when the script lands after the bootstrap',
        hasFlag(flags[0]), JSON.stringify(flags));

    env = build({ patch: { 'const FORCE_AV1 = true;': 'const FORCE_AV1 = false;' } });
    env.run(YTCFG_PAGE);
    env.run(`ytcfg.set({${CONFIGS_KEY}:{A:{serializedExperimentFlags:'e=5'}}})`);
    check('FORCE_AV1 off leaves the config untouched', configFlags(env)[0] === 'e=5');

    env = build({ readyState: 'loading', href: 'https://www.youtube.com/' });
    env.run(YTCFG_PAGE);
    env.run(`ytcfg.set({${CONFIGS_KEY}:{A:{}}})`);
    flags = (() => { try { return configFlags(env); } catch (_) { return []; } })();
    check('the flags land before DOMContentLoaded and off the watch page, for previews and Shorts',
        flags.length === 1 && hasFlag(flags[0]));

    check('the header runs it at document-start, in the page',
        /@run-at\s+document-start/.test(SOURCE) && /@grant\s+none/.test(SOURCE) && /@sandbox\s+raw/.test(SOURCE));
    check('the header can update itself',
        /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/nickleechn\/tampermonkey\/main\/CyrstalClear\.js/.test(SOURCE)
        && /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/nickleechn\/tampermonkey\/main\/CyrstalClear\.js/.test(SOURCE));

    console.log('\nThe ceiling');

    env = build({ levels: ['highres', 'hd2880', 'hd2160', 'hd1440', 'auto'] });
    await env.clock.flush();
    let range = env.ranges()[0];
    check('an 8K video is pinned at 4K', !!range && range[1] === 'hd2160', JSON.stringify(range));
    check('the pick is pinned (min === max), the only range YouTube treats as locked',
        !!range && range[0] === range[1]);

    env = build({ levels: ['hd1440', 'hd1080', 'hd720', 'auto'] });
    await env.clock.flush();
    check('a video that tops out lower still gets its best level', env.last() === 'hd1440', env.last());

    env = build({ levels: ['hd2160', 'hd1080'], patch: { "const MAX_QUALITY = 'hd2160';": "const MAX_QUALITY = 'hd1080';" } });
    await env.clock.flush();
    check('MAX_QUALITY moves the ceiling', env.last() === 'hd1080', env.last());

    env = build({ levels: ['hd720', 'large'], patch: { "const MAX_QUALITY = 'hd2160';": "const MAX_QUALITY = 'highres';" } });
    await env.clock.flush();
    check('\'highres\' still picks what the video has', env.last() === 'hd720', env.last());

    env = build({
        levels: ['highres', 'hd2160', 'hd1080'],
        qualityData: [
            { quality: 'highres', qualityLabel: '4320p', formatId: 'h', isPlayable: true },
            { quality: 'hd2160', qualityLabel: '2160p', formatId: 'k', isPlayable: false },
            { quality: 'hd1080', qualityLabel: '1080p', formatId: 'f', isPlayable: true }
        ]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('an entry the player says it can\'t play is skipped',
        !!range && range[1] === 'hd1080' && range[2] === 'f', JSON.stringify(range));

    env = build({
        levels: ['hd1080', 'hd720'],
        qualityData: [
            { quality: 'hd1080', qualityLabel: '1080p Premium', formatId: '356', isPlayable: true },
            { quality: 'hd1080', qualityLabel: '1080p', formatId: '399', isPlayable: true },
            { quality: 'hd720', qualityLabel: '720p', formatId: '398', isPlayable: true }
        ],
        settingsButton: true
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('with AV1 forced, plain 1080p beats Premium, by formatId',
        !!range && range[1] === 'hd1080' && range[2] === '399', JSON.stringify(range));
    check('the API path never opens the settings menu', !env.player.settingsButton.clicked);

    env = build({
        levels: ['hd1080'],
        qualityData: [{
            quality: 'hd1080', qualityLabel: '1080p', formatId: '356', isPlayable: true,
            paygatedQualityDetails: { paygatedIndicatorText: 'Premium' }
        }, { quality: 'hd1080', qualityLabel: '1080p', formatId: '399', isPlayable: true }]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('a paygated entry counts as Premium whatever its label says',
        !!range && range[2] === '399', JSON.stringify(range));

    env = build({
        levels: ['hd1080'],
        qualityData: [{ quality: 'hd1080', qualityLabel: '1080p Premium', formatId: '356', isPlayable: true }]
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('Premium is still used when it is the only entry at that level',
        !!range && range[2] === '356', JSON.stringify(range));

    env = build({
        levels: ['hd1080'],
        qualityData: [
            { quality: 'hd1080', qualityLabel: '1080p', formatId: '399', isPlayable: true },
            { quality: 'hd1080', qualityLabel: '1080p Premium', formatId: '356', isPlayable: true }
        ],
        settingsButton: true,
        patch: { 'const FORCE_AV1 = true;': 'const FORCE_AV1 = false;' }
    });
    await env.clock.flush();
    range = env.ranges()[0];
    check('with AV1 not forced, Premium is preferred, still without the menu',
        !!range && range[2] === '356' && !env.player.settingsButton.clicked, JSON.stringify(range));

    console.log('\nThe menu fallback');

    env = build({ playerApi: false, menuLabels: ['4320p', '2160p', '1080p'] });
    await env.clock.flush();
    check('the ceiling holds with no quality API', env.picked() === '2160p', `picked=${env.picked()}`);

    env = build({ playerApi: false, menuLabels: ['1080p Premium', '1080p', '720p'] });
    await env.clock.flush();
    check('plain 1080p beats Premium here too', env.picked() === '1080p', `picked=${env.picked()}`);

    env = build({
        playerApi: false,
        menuLabels: ['2160p', '1080p'],
        menuOptions: { qualityRowLabel: 'Qualität', qualityRowValue: 'Automatisch (1080p)' }
    });
    await env.clock.flush();
    check('the quality row is found in another language', env.picked() === '2160p', `picked=${env.picked()}`);

    env = build({
        levels: [],
        settingsButton: true
    });
    await env.clock.flush();
    check('an API with no formats yet never touches the menu', !env.player.settingsButton.clicked);

    console.log('\nOne pin per video');

    env = build({ video: {} });
    await env.clock.flush();
    check('a video gets exactly one pin', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = build({ video: {} });
    await env.clock.flush();
    env.player.current = 'hd720';
    for (const name of ['pause', 'playing', 'waiting', 'canplay', 'playing']) {
        env.video.fire(name);
        await env.clock.flush();
    }
    check('a manual pick survives pause, resume and a rebuffer',
        env.ranges().length === 1 && env.player.current === 'hd720', `pins=${env.ranges().length} now=${env.player.current}`);

    env = build({ video: {} });
    await env.clock.flush();
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.fireDoc('yt-navigate-finish');
    await env.clock.flush();
    check('the next video gets its own pin', env.ranges().length === 2, `pins=${env.ranges().length}`);
    env.fireDoc('yt-page-data-updated');
    await env.clock.flush();
    check('a second navigation event for it does not pin again', env.ranges().length === 2);

    env = build({ videoId: 'abc123', video: {} });
    await env.clock.flush();
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.fireDoc('yt-navigate-finish');
    await env.clock.flush();
    check('a player still holding the outgoing video is not pinned', env.ranges().length === 1, `pins=${env.ranges().length}`);
    env.player.videoId = 'def456';
    env.video.fire('canplay');
    await env.clock.flush();
    check('it is pinned once the player catches up', env.ranges().length === 2, `pins=${env.ranges().length}`);

    // As measured on base.js 11a45ffb: a pre-roll on a click-through, with the
    // video's id and full level list already showing, and the ad's data list.
    const FOUR_K_DATA = ['hd2160', 'hd1440', 'hd1080', 'hd720'].map((quality) => ({ quality, qualityLabel: quality, isPlayable: true }));
    const AD_DATA = ['hd1080', 'hd720', 'large'].map((quality) => ({ quality, qualityLabel: quality, isPlayable: true }));
    env = build({ levels: ['hd2160', 'hd1440', 'hd1080', 'hd720', 'auto'], qualityData: FOUR_K_DATA, videoId: 'abc123', video: {} });
    env.player.adData = AD_DATA;
    env.player.presentingType = 2;
    await env.clock.flush();
    check('nothing is pinned while an ad is on screen', env.ranges().length === 0, JSON.stringify(env.ranges()));
    env.video.fire('playing');
    await env.clock.flush();
    env.video.fire('canplay');
    await env.clock.flush();
    check('and waiting through it spends no attempts', env.ranges().length === 0);
    env.player.presentingType = 1;
    env.video.fire('loadedmetadata');
    await env.clock.flush();
    check('the video gets its own top level when the ad ends, not the ad\'s',
        env.ranges().length === 1 && env.last() === 'hd2160', JSON.stringify(env.ranges()));

    env = build({ levels: ['hd2160', 'hd1080'], qualityData: FOUR_K_DATA, video: {} });
    env.player.presentingType = 2;
    env.player.adData = AD_DATA;
    for (let i = 0; i < 8; i++) {
        env.video.fire('canplay');
        await env.clock.flush();
    }
    env.player.presentingType = 1;
    env.video.fire('canplay');
    await env.clock.flush();
    check('a long ad break does not use up the video\'s attempts', env.last() === 'hd2160', env.last());

    env = build({ levels: [], video: {} });
    await env.clock.flush();
    check('no formats yet means no pin', env.ranges().length === 0);
    env.player.levels = ['hd1080', 'hd720'];
    env.video.fire('canplay');
    await env.clock.flush();
    check('a load slower than the last delay is still picked up by the next player event',
        env.last() === 'hd1080', env.last());

    for (const [name, href] of [
        ['the home feed', 'https://www.youtube.com/'],
        ['Shorts', 'https://www.youtube.com/shorts/abc123'],
        ['a channel', 'https://www.youtube.com/@somebody']
    ]) {
        env = build({ href, video: {} });
        await env.clock.flush();
        env.video.fire('playing');
        await env.clock.flush();
        check(`${name} is left on Auto`, env.ranges().length === 0, `pins=${env.ranges().length}`);
    }

    env = build({ href: 'https://www.youtube.com/', video: {} });
    env.video.fire('playing');
    check('off the watch page not even a timer is scheduled', env.clock.size() === 0, `timers=${env.clock.size()}`);

    env = build({ levels: [], video: {} });
    await env.clock.advance(500);
    env.location.href = 'https://www.youtube.com/';
    env.fireDoc('yt-navigate-finish');
    env.player.levels = ['hd1080', 'hd720'];
    await env.clock.flush();
    check('a round still running when you leave the watch page pins nothing', env.ranges().length === 0, `pins=${env.ranges().length}`);

    env = build({ href: 'https://www.youtube.com/live/abcdefghijk' });
    await env.clock.flush();
    check('/live/<id> counts as a watch page', env.ranges().length === 1);

    env = build({ readyState: 'loading' });
    await env.clock.flush();
    check('nothing is pinned before DOMContentLoaded', env.ranges().length === 0);
    env.document.readyState = 'interactive';
    env.fireDoc('DOMContentLoaded');
    await env.clock.flush();
    check('selection starts at DOMContentLoaded', env.ranges().length === 1);

    env = build({ video: {} });
    const doubled = (env.winListeners['yt-navigate-finish'] || []).length;
    check('navigation events are bound once, not on window as well', doubled === 0, `window listeners=${doubled}`);
    check('the dead spfdone event is gone', !env.docListeners.spfdone && !env.winListeners.spfdone);

    env = build({ href: 'https://www.youtube.com/', video: {} });
    await env.clock.flush();
    check('the home feed is not observed', env.observed.every((o) => o.root !== env.body), `observed=${env.observed.length}`);

    console.log('\nThe stored preference');

    env = build();
    let saved = storedQuality(env.stored);
    check('the ceiling is written synchronously, before any timer', saved.data.quality === 2160, JSON.stringify(saved.data));
    check('the record uses YouTube\'s current shape, with data as a JSON string',
        typeof saved.record.data === 'string' && typeof saved.data === 'object' && saved.data.previousQuality > 0);
    check('expiry matches YouTube\'s own 360 days',
        saved.record.expiration - saved.record.creation === 360 * DAY_MS);

    const staleRecord = (quality, ageMs) => JSON.stringify({
        data: JSON.stringify({ quality, previousQuality: quality }),
        expiration: BASE_TIME + 100 * DAY_MS,
        creation: BASE_TIME - ageMs
    });

    env = build({ storedSeed: { 'yt-player-quality': staleRecord(720, 1000) } });
    saved = storedQuality(env.stored);
    check('a one-off 720p pick is raised before the player boots',
        saved.data.quality === 2160 && saved.data.previousQuality === 720, JSON.stringify(saved.data));

    env = build({ storedSeed: { 'yt-player-quality': staleRecord(2160, 40 * DAY_MS) } });
    saved = storedQuality(env.stored);
    check('an unchanged record is refreshed before the player\'s 30-day limit',
        saved.record.creation === BASE_TIME, `age=${BASE_TIME - saved.record.creation}`);

    env = build({ storedSeed: { 'yt-player-quality': staleRecord(2160, 1000) } });
    check('a fresh unchanged record is left alone', !env.writes.includes('yt-player-quality'));

    env = build({
        storedSeed: { 'yt-player-quality': JSON.stringify({ data: 'hd1080', expiration: BASE_TIME + DAY_MS, creation: BASE_TIME - 1000 }) }
    });
    saved = storedQuality(env.stored);
    check('the legacy record shape is read and upgraded',
        saved.data.quality === 2160 && saved.data.previousQuality === 1080, JSON.stringify(saved.data));

    env = build({ levels: ['hd720', 'large'], video: {} });
    await env.clock.flush();
    saved = storedQuality(env.stored);
    check('a video that tops out at 720p does not cap the next one', saved.data.quality === 2160, JSON.stringify(saved.data));

    env = build({ levels: ['hd720', 'large'] });
    env.player.setPlaybackQualityRange = function (...args) {
        env.player.calls.push(args);
        // The player's own write when a pick lands below the top on offer.
        env.stored['yt-player-quality'] = staleRecord(480, 0);
    };
    await env.clock.flush();
    saved = storedQuality(env.stored);
    check('the player\'s own lower write is put back after the pin', saved.data.quality === 2160, JSON.stringify(saved.data));

    console.log('\nThe frame guard');

    const dropsAt4k = (quality) => (quality === 'hd2160' ? 0.4 : 0);
    const FOUR_K = ['hd2160', 'hd1440', 'hd1080', 'hd720'];

    env = build({ levels: FOUR_K, video: { dropRatio: dropsAt4k } });
    await env.clock.flush();
    check('dropping frames at 4K steps down one level', env.last() === 'hd1440', JSON.stringify(env.ranges()));
    check('and it stops there when 1440p keeps up', env.ranges().length === 2);

    env = build({
        levels: FOUR_K,
        qualityData: FOUR_K.map((quality, i) => ({ quality, qualityLabel: quality, formatId: 'f' + i, isPlayable: true })),
        video: { dropRatio: dropsAt4k }
    });
    await env.clock.flush();
    range = env.ranges()[1];
    check('the step down carries its formatId', !!range && range[2] === 'f1', JSON.stringify(range));

    env = build({ levels: FOUR_K, video: {} });
    await env.clock.flush();
    check('clean playback never steps down', env.ranges().length === 1);

    env = build({ levels: ['hd1080', 'hd720'], video: { dropRatio: () => 0.9 } });
    await env.clock.flush();
    check('it never touches 1080p or below', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 }, visibilityState: 'hidden' });
    await env.clock.flush();
    check('a background tab is not measured', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 } });
    env.video.paused = true;
    await env.clock.flush();
    check('a paused video is not measured', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 } });
    env.video.playbackRate = 2;
    await env.clock.flush();
    check('a sped-up video is not measured', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 } });
    env.video.seeking = true;
    await env.clock.flush();
    check('a seek is not measured', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 } });
    env.player.getPlaybackQuality = () => 'hd720';
    await env.clock.flush();
    check('a manual pick is not measured against the pin', env.ranges().length === 1);

    env = build({ levels: FOUR_K, video: { dropRatio: () => 0.9 } });
    await env.clock.advance(1000);
    env.player.presentingType = 2;
    await env.clock.flush();
    check('a mid-roll ad is not measured', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = build({ levels: FOUR_K, video: { dropRatio: dropsAt4k } });
    await env.clock.flush();
    let frameRecord = JSON.parse(env.stored[FRAME_CAP_KEY] || '{}');
    check('the first failure is one strike', frameRecord.height === 2160 && frameRecord.strikes === 1, JSON.stringify(frameRecord));

    env = build({ levels: FOUR_K, storedSeed: { [FRAME_CAP_KEY]: JSON.stringify(frameRecord) } });
    await env.clock.flush();
    check('one strike is not remembered on the next load', env.ranges()[0] && env.ranges()[0][1] === 'hd2160');

    env = build({ levels: FOUR_K, video: { dropRatio: dropsAt4k }, storedSeed: { [FRAME_CAP_KEY]: JSON.stringify(frameRecord) } });
    await env.clock.flush();
    frameRecord = JSON.parse(env.stored[FRAME_CAP_KEY] || '{}');
    check('a second failure on a later load is a second strike', frameRecord.strikes === 2, JSON.stringify(frameRecord));

    const twoStrikes = { [FRAME_CAP_KEY]: JSON.stringify(frameRecord) };
    env = build({ levels: FOUR_K, storedSeed: twoStrikes });
    await env.clock.flush();
    check('two strikes are remembered, and the next video boots below them',
        env.ranges()[0] && env.ranges()[0][1] === 'hd1440' && storedQuality(env.stored).data.quality === 1440,
        JSON.stringify(env.ranges()[0]));

    env = build({ levels: FOUR_K, storedSeed: twoStrikes, chromeVersion: '157' });
    await env.clock.flush();
    check('a Chrome upgrade starts fresh', env.ranges()[0] && env.ranges()[0][1] === 'hd2160');

    env = build({ levels: FOUR_K, storedSeed: twoStrikes, hardwareConcurrency: 12 });
    await env.clock.flush();
    check('another machine starts fresh', env.ranges()[0] && env.ranges()[0][1] === 'hd2160');

    env = build({ levels: FOUR_K, storedSeed: twoStrikes, startTime: BASE_TIME + 31 * DAY_MS });
    await env.clock.flush();
    check('the limit expires after 30 days', env.ranges()[0] && env.ranges()[0][1] === 'hd2160');

    console.log('\nThe stall guard');

    env = await playing4k();
    await stall(env, 1500);
    check('one short stall changes nothing', env.ranges().length === 1, `pins=${env.ranges().length}`);
    await env.clock.advance(10000);
    await stall(env, 1500);
    check('two within a minute step down one level', env.last() === 'hd1440', JSON.stringify(env.ranges()));
    check('and only one', env.ranges().length === 2);

    env = await playing4k();
    await stall(env, 1500);
    await env.clock.advance(61000);
    await stall(env, 1500);
    check('two more than a minute apart do not', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    await stall(env, 400);
    await env.clock.advance(1000);
    await stall(env, 400);
    await env.clock.advance(1000);
    await stall(env, 400);
    check('sub-second blips do not count', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.video.fire('waiting');
    await env.clock.advance(4900);
    check('a stall under 5 s does nothing while it runs', env.ranges().length === 1);
    await env.clock.advance(200);
    check('a stall that reaches 5 s steps down without waiting for it to end', env.last() === 'hd1440', JSON.stringify(env.ranges()));
    await env.clock.advance(5000);
    check('that stall is not counted twice', env.ranges().length === 2, `pins=${env.ranges().length}`);

    env = await playing4k({}, { pastGrace: false });
    await stall(env, 1500);
    await env.clock.advance(100);
    await stall(env, 1500);
    check('the refill after pinning is not the link\'s fault', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k({}, { pastGrace: false });
    env.video.fire('waiting');
    await env.clock.advance(6000);
    check('a refill gets the grace period before the 5 s starts', env.ranges().length === 1, `pins=${env.ranges().length}`);
    await env.clock.advance(8000);
    check('but a refill that never finishes counts', env.last() === 'hd1440', JSON.stringify(env.ranges()));

    env = await playing4k();
    for (let i = 0; i < 3; i++) {
        env.video.seeking = true;
        env.video.fire('seeking');
        env.video.fire('waiting');
        await env.clock.advance(6000);
        env.video.seeking = false;
        env.video.fire('playing');
    }
    check('seeks do not count', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.video.fire('waiting');
    await env.clock.advance(500);
    env.video.seeking = true;
    env.video.fire('seeking');
    await env.clock.advance(6000);
    env.video.seeking = false;
    env.video.fire('playing');
    check('a seek during a stall cancels it', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    for (let i = 0; i < 3; i++) {
        env.video.fire('waiting');
        await env.clock.advance(1500);
        env.video.seeking = true;
        env.video.fire('seeking');
        await env.clock.advance(500);
        env.video.seeking = false;
        env.video.fire('playing');
    }
    check('a stall that a seek ends is not a strike', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    for (let i = 0; i < 3; i++) {
        env.video.fire('waiting');
        await env.clock.advance(1500);
        env.video.paused = true;
        env.video.fire('pause');
        await env.clock.advance(500);
        env.video.paused = false;
        env.video.fire('playing');
    }
    check('nor is one that a pause ends', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.video.fire('waiting');
    await env.clock.advance(1000);
    env.player.current = 'hd720';
    await env.clock.advance(6000);
    check('a manual pick during a long stall is not overruled', env.ranges().length === 1 && env.player.current === 'hd720', `pins=${env.ranges().length}`);

    env = await playing4k();
    env.video.paused = true;
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('pauses do not count', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.video.fire('waiting');
    await env.clock.advance(500);
    env.video.paused = true;
    env.video.fire('pause');
    await env.clock.advance(6000);
    check('pausing during a stall cancels it', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.player.presentingType = 2;
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('an ad does not count', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    await stall(env, 1500);
    env.video.fire('waiting');
    await env.clock.advance(1500);
    env.player.presentingType = 2;
    env.video.fire('playing');
    await env.clock.advance(0);
    check('a stall that an ad ends is not a strike', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    await stall(env, 1500);
    env.video.fire('waiting');
    await env.clock.advance(1500);
    env.player.current = 'hd720';
    env.video.fire('playing');
    await env.clock.advance(0);
    check('nor is one that a manual pick ends', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.document.visibilityState = 'hidden';
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('a background tab does not count', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    env.player.current = 'hd1080';
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('a manual pick is never overruled', env.ranges().length === 1 && env.player.current === 'hd1080', `pins=${env.ranges().length}`);

    env = await playing4k();
    await stall(env, 1500);
    await stall(env, 1500);
    const stallRecord = JSON.parse(env.stored[STALL_CAP_KEY] || '{}');
    check('the limit is saved for 30 minutes',
        stallRecord.height === 2160 && stallRecord.until === BASE_TIME + env.clock.now() + 30 * 60 * 1000,
        JSON.stringify(stallRecord));
    check('the stored preference follows it down', storedQuality(env.stored).data.quality === 1440);

    env = await playing4k();
    env.stored[STALL_CAP_KEY] = JSON.stringify({ height: 1440, until: BASE_TIME + 60 * 60 * 1000 });
    await stall(env, 1500);
    await stall(env, 1500);
    check('a lower limit set by another tab is kept', JSON.parse(env.stored[STALL_CAP_KEY]).height === 1440 && env.last() === 'hd1080',
        env.stored[STALL_CAP_KEY]);

    env = await playing4k({
        storedSeed: { [STALL_CAP_KEY]: JSON.stringify({ height: 2160, until: BASE_TIME + 60000 }) }
    });
    check('the next video boots under the limit', env.ranges()[0] && env.ranges()[0][1] === 'hd1440', JSON.stringify(env.ranges()[0]));
    check('and the preference it boots with is lowered too', storedQuality(env.stored).data.quality === 1440);

    env = await playing4k({
        storedSeed: { [STALL_CAP_KEY]: JSON.stringify({ height: 2160, until: BASE_TIME - 1 }) }
    });
    check('after 30 minutes the next video tries 4K again', env.ranges()[0] && env.ranges()[0][1] === 'hd2160', JSON.stringify(env.ranges()[0]));

    // The limit runs out while the tab stays open.
    env = build({
        levels: ['hd2160', 'hd1440'],
        video: {},
        storedSeed: { [STALL_CAP_KEY]: JSON.stringify({ height: 2160, until: BASE_TIME + 60000 }) }
    });
    await env.clock.advance(6000);
    check('a limit in force holds the first video down', env.last() === 'hd1440', env.last());
    await env.clock.advance(120000);
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.fireDoc('yt-navigate-finish');
    await env.clock.advance(6000);
    check('and the same tab goes back up on a later video once it expires', env.last() === 'hd2160', env.last());

    env = await playing4k();
    for (let i = 0; i < 12; i++) {
        await env.clock.advance(10000);
        await stall(env, 1500);
    }
    check('it walks down the ladder and stops at 720p',
        env.ranges().map((r) => r[1]).join() === 'hd2160,hd1440,hd1080,hd720', env.ranges().map((r) => r[1]).join());

    env = await playing4k({ levels: ['hd720', 'large'] });
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('a video already at the floor is left alone', env.ranges().length === 1, `pins=${env.ranges().length}`);

    env = await playing4k();
    await stall(env, 1500);
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.fireDoc('yt-navigate-finish');
    await env.clock.advance(16000);
    await stall(env, 1500);
    check('strikes do not carry over to the next video',
        env.ranges().length === 2 && env.last() === 'hd2160', JSON.stringify(env.ranges()));

    env = await playing4k();
    await stall(env, 1500);
    env.video.fire('waiting');
    await env.clock.advance(1500);
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.video.fire('playing');
    await env.clock.advance(0);
    check('a stall that spans a navigation is nobody\'s strike', !env.stored[STALL_CAP_KEY], env.stored[STALL_CAP_KEY]);

    env = await playing4k();
    await stall(env, 1500);
    env.video.fire('waiting');
    await env.clock.advance(1500);
    env.location.href = 'https://www.youtube.com/watch?v=def456';
    env.fireDoc('yt-navigate-finish');
    env.video.fire('playing');
    await env.clock.advance(0);
    check('nor when the navigation event lands first', !env.stored[STALL_CAP_KEY], env.stored[STALL_CAP_KEY]);

    env = build({
        levels: ['hd2160', 'hd1440'],
        video: {},
        patch: {
            'const STALL_GUARD = true;': 'const STALL_GUARD = false;',
            'const FRAME_GUARD = true;': 'const FRAME_GUARD = false;'
        }
    });
    await env.clock.advance(16000);
    for (let i = 0; i < 3; i++) await stall(env, 6000);
    check('STALL_GUARD off stays pinned', env.ranges().length === 1, `pins=${env.ranges().length}`);

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    console.log(failed.length
        ? `${failed.length} OF ${results.length} CHECKS FAILED`
        : `ALL ${results.length} CHECKS PASSED`);
    process.exit(failed.length ? 1 : 0);
})();
