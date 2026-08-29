// Headless behavioural tests for Quicksilver.safari.user.js.
//
//   node test/quicksilver-safari-behaviour.js
//
// Evaluates the Safari build against a stubbed WebKit DOM — no
// navigator.connection, no LargestContentfulPaint, no Navigation API, no
// speculation rules — and asserts what the port rests on: the WebKit-only
// guard, the geometric hero heuristic and its raised confidence gate, the
// connection tier learned from Navigation Timing, and the same scope limits on
// transition learning the Chrome build has.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, ok, extra) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function makeEl(tag) {
    return {
        tagName: String(tag).toUpperCase(), style: { setProperty() {} }, attributes: {},
        children: [], firstElementChild: null, sheet: null,
        rel: '', href: '', src: '', as: '', type: '', textContent: '', className: '',
        currentSrc: '', crossOrigin: undefined,
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        hasAttribute(k) { return k in this.attributes; },
        removeAttribute(k) { delete this.attributes[k]; },
        addEventListener() {}, removeEventListener() {}, remove() {},
        appendChild(c) { this.children.push(c); return c; },
        attachShadow() { this.shadowRoot = makeEl('shadow-root'); return this.shadowRoot; },
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        matches: () => false,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 })
    };
}

// An <img> with a fixed box, which is the only thing the hero heuristic reads.
function makeImage(width, height, top, src) {
    return Object.assign(makeEl('img'), {
        src, currentSrc: src, crossOrigin: null,
        getBoundingClientRect: () => ({ top, left: 0, width, height })
    });
}

const DEFAULT_NAV = [{
    type: 'navigate', requestStart: 10, responseStart: 60, responseEnd: 120, transferSize: 40000
}];

function build({
    gm = {}, userAgent = SAFARI_UA, vendor = 'Apple Computer, Inc.',
    referrer = '', pathname = '/article', images = [], videos = [], navEntries = DEFAULT_NAV,
    paintEntries = [{ name: 'first-contentful-paint', startTime: 900 }],
    // The Userscripts app exposes only the promise-based GM.*, which primes
    // storage a few microtasks after document-start.
    asyncGm = false,
    // Safari before 15.4: no loading=, no fetchpriority.
    legacyWebKit = false,
    // 'complete' models a manager that injects after parsing, so every
    // runWhenDomReady callback fires synchronously as the script evaluates.
    readyState = 'loading',
    resourceEntries = [],
    // Desktop Safari has hover; a phone does not, which is the whole reason
    // viewport intent exists.
    hover = true,
    anchors = []
} = {}) {
    const winListeners = new Map();
    const docListeners = new Map();
    const head = makeEl('head');
    const store = new Map(Object.entries(gm));
    const menu = new Map();
    const timers = [];
    const intervals = [];

    const add = (map, t, f) => { if (!map.has(t)) map.set(t, []); map.get(t).push(f); };
    const fire = (map, t, ev) => { for (const f of (map.get(t) || []).slice()) f(ev || {}); };

    const document = {
        readyState, visibilityState: 'visible', referrer,
        head, body: makeEl('body'), documentElement: makeEl('html'),
        images, styleSheets: [],
        createElement: makeEl,
        querySelectorAll: selector => {
            const text = String(selector);
            if (text.includes('video')) return videos;
            if (text.includes('a[href]')) return anchors;
            return [];
        },
        querySelector: () => null,
        addEventListener: (t, f) => add(docListeners, t, f),
        removeEventListener() {}, dispatchEvent: () => true
    };

    const window = {
        document,
        location: new URL('https://example.com' + pathname),
        // The two APIs whose absence defines this port.
        navigator: { userAgent, vendor, connection: undefined },
        innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2,
        pageYOffset: 0, pageXOffset: 0,
        performance: {
            now: () => 100,
            getEntriesByType: type => {
                if (type === 'navigation') return navEntries;
                if (type === 'paint') return paintEntries;
                if (type === 'resource') return resourceEntries;
                return [];
            }
        },
        addEventListener: (t, f) => add(winListeners, t, f),
        removeEventListener() {},
        // No requestIdleCallback: the fallback path is the one Safari takes.
        requestAnimationFrame: f => { timers.push(f); return 1; },
        setTimeout: f => { timers.push(f); return timers.length; },
        clearTimeout() {},
        // Drivable, so tests can actually reach the same-document route path.
        setInterval: f => { intervals.push(f); return intervals.length; },
        clearInterval() {},
        fetch: () => Promise.resolve({ body: null }),
        MutationObserver: class { observe() {} disconnect() {} },
        matchMedia: query => ({ matches: String(query).includes('hover: hover') ? hover : !hover }),
        PerformanceObserver: class { observe() {} },
        Element: class {},
        Image: class { constructor() { this.src = ''; } },
        HTMLImageElement: { prototype: legacyWebKit ? {} : { fetchPriority: '', loading: '' } },
        HTMLLinkElement: { prototype: legacyWebKit ? {} : { imageSrcset: '' } },
        HTMLIFrameElement: { prototype: legacyWebKit ? {} : { loading: '' } },
        CSSFontFaceRule: class {},
        CSS: { supports: () => true },
        URL, console, JSON, Date, Math, Number, Object, Array, Set, Map, WeakSet,
        Promise, RegExp, String, Boolean,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        GM_registerMenuCommand: (n, f) => menu.set(n, f)
    };

    if (asyncGm) {
        window.GM = {
            getValue: (k, d) => Promise.resolve(store.has(k) ? store.get(k) : d),
            setValue: (k, v) => { store.set(k, v); return Promise.resolve(); },
            deleteValue: k => { store.delete(k); return Promise.resolve(); }
        };
    } else {
        window.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
        window.GM_setValue = (k, v) => store.set(k, v);
        window.GM_deleteValue = k => store.delete(k);
    }

    const intersectionObservers = [];
    window.IntersectionObserver = class {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            this.live = true;
            intersectionObservers.push(this);
        }
        observe(target) { if (this.live) this.targets.push(target); }
        unobserve(target) { this.targets = this.targets.filter(t => t !== target); }
        disconnect() { this.live = false; this.targets = []; }
    };

    window.window = window;
    window.self = window;
    window.top = window;
    window.globalThis = window;

    const context = vm.createContext(window);
    for (const key of [
        'document', 'location', 'navigator', 'performance', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'requestAnimationFrame', 'fetch', 'MutationObserver',
        'PerformanceObserver', 'Element', 'Image', 'HTMLImageElement', 'HTMLLinkElement',
        'HTMLIFrameElement', 'CSSFontFaceRule', 'CSS', 'localStorage', 'GM_registerMenuCommand',
        'GM', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'matchMedia', 'IntersectionObserver'
    ]) if (key in window) context[key] = window[key];

    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'Quicksilver.safari.user.js'), 'utf8'),
        context
    );

    const drain = () => { let fn; while ((fn = timers.shift())) fn(); };

    return {
        window, document, head, store, menu, images, winListeners, docListeners, fire, drain,
        // Storage is primed through a promise even on the synchronous backend,
        // so nothing has run until the microtask queue is empty.
        settled: () => new Promise(resolve => setImmediate(resolve)),
        // Fires load without running the settle timer, so a test can navigate
        // away inside the settle window the way a real user does.
        fireLoad() {
            document.readyState = 'complete';
            fire(winListeners, 'load');
        },
        load() {
            document.readyState = 'complete';
            fire(winListeners, 'load');
            drain();
            drain();
        },
        // A same-document navigation: the router swaps the DOM, then the
        // polling watcher notices, which is the ordering the real thing has.
        // Scroll the observed links into view.
        scrollIntoView(targets) {
            for (const observer of intersectionObservers.slice()) {
                if (!observer.live) continue;
                const seen = (targets || observer.targets).slice();
                observer.callback(seen.map(target => ({ target, isIntersecting: true })));
            }
        },
        observedLinks: () => intersectionObservers.reduce((n, o) => n + o.targets.length, 0),
        navigate(nextPath) {
            context.location = new URL('https://example.com' + nextPath);
            for (const tick of intervals.slice()) tick();
        },
        read(key) {
            const raw = store.get(key + '::https://example.com');
            return raw ? JSON.parse(raw) : null;
        }
    };
}

function heroRecord(seen, url = 'https://cdn.example.com/hero.jpg', viewport = '1280x2') {
    return {
        'tm-qs-lcp::https://example.com': JSON.stringify({
            '/article': { url, vw: viewport, at: Date.now(), seen }
        })
    };
}

(async () => {
    console.log('\nEnvironment guard');

    let env = build();
    await env.settled();
    check('runs under Safari', env.menu.size >= 5, [...env.menu.keys()].length + ' commands');

    env = build({ userAgent: CHROME_UA, vendor: 'Google Inc.' });
    await env.settled();
    check('does nothing under Chromium', env.menu.size === 0);

    console.log('\nLearned hero preload');

    env = build({ gm: heroRecord(2) });
    await env.settled();
    check('two sightings is below the Safari gate',
        !env.head.children.some(c => c.rel === 'preload'));

    env = build({ gm: heroRecord(3) });
    await env.settled();
    const preload = env.head.children.find(c => c.rel === 'preload');
    check('three sightings preloads the hero',
        Boolean(preload) && preload.href === 'https://cdn.example.com/hero.jpg');
    check('preload is marked high priority',
        Boolean(preload) && preload.attributes.fetchpriority === 'high');

    env = build({ gm: heroRecord(9, 'https://cdn.example.com/hero.jpg', '320x1') });
    await env.settled();
    check('a record from another viewport is not used',
        !env.head.children.some(c => c.rel === 'preload'));

    console.log('\nHero heuristic (no LCP in WebKit)');

    env = build({
        images: [
            makeImage(80, 80, 0, 'https://example.com/logo.png'),
            makeImage(1200, 600, 100, 'https://example.com/hero.jpg'),
            makeImage(1200, 600, 2000, 'https://example.com/below-fold.jpg')
        ]
    });
    await env.settled();
    env.load();
    let learned = env.read('tm-qs-lcp');
    check('largest first-screen image becomes the hero',
        Boolean(learned) && learned['/article'].url === 'https://example.com/hero.jpg');
    check('a logo-sized image is never the hero',
        Boolean(learned) && learned['/article'].url !== 'https://example.com/logo.png');
    check('first sighting carries no confidence',
        Boolean(learned) && learned['/article'].seen === 1);

    env = build({
        gm: heroRecord(2, 'https://example.com/banner-a.jpg'),
        images: [makeImage(1200, 600, 100, 'https://example.com/banner-b.jpg')]
    });
    await env.settled();
    env.load();
    learned = env.read('tm-qs-lcp')['/article'];
    check('a rotating banner never accumulates confidence',
        learned.seen === 1 && learned.url === 'https://example.com/banner-b.jpg');

    env = build({
        gm: heroRecord(2, 'https://example.com/banner-a.jpg'),
        images: [makeImage(60, 60, 0, 'https://example.com/logo.png')]
    });
    await env.settled();
    env.load();
    check('a hero that disappears decays its record',
        env.read('tm-qs-lcp')['/article'].seen === 1);

    env = build({ images: [makeImage(1200, 600, 100, 'https://example.com/hero.jpg')] });
    env.document.visibilityState = 'hidden';
    env.fire(env.docListeners, 'visibilitychange');
    await env.settled();
    env.load();
    check('a tab loaded in the background learns nothing',
        env.read('tm-qs-lcp') === null);

    console.log('\nLearned critical origins');

    env = build({
        gm: {
            'tm-qs-origins::https://example.com': JSON.stringify({
                origins: [
                    { o: 'https://cdn.example.com', c: true, n: 5, t: 10, u: Date.now() },
                    { o: 'https://ads.example.net', c: false, n: 1, t: 10, u: Date.now() }
                ]
            })
        }
    });
    await env.settled();
    const preconnects = env.head.children.filter(c => c.rel === 'preconnect');
    check('only confident origins are preconnected',
        preconnects.length === 1 && preconnects[0].href === 'https://cdn.example.com');
    check('a CORS origin is preconnected anonymously',
        preconnects.length === 1 && preconnects[0].crossOrigin === 'anonymous');

    console.log('\nConnection tier (no Network Information API)');

    env = build();
    await env.settled();
    env.load();
    const net = JSON.parse(env.store.get('tm-qs-net') || '{"s":[]}');
    check('TTFB sampled from Navigation Timing',
        net.s.length === 1 && net.s[0].t === 50, JSON.stringify(net.s));

    env = build({
        navEntries: [{ type: 'back_forward', requestStart: 10, responseStart: 12, responseEnd: 13, transferSize: 0 }]
    });
    await env.settled();
    env.load();
    check('a back/forward restore is not sampled', !env.store.has('tm-qs-net'));

    // The tier is only observable through what it spends, so this counts
    // preconnects: the budget is 4 on a fast link and 2 on a slow one.
    const fiveOrigins = {
        'tm-qs-origins::https://example.com': JSON.stringify({
            origins: ['a', 'b', 'c', 'd', 'e'].map(name => ({
                o: 'https://' + name + '.example.net', c: false, n: 5, t: 10, u: Date.now()
            }))
        })
    };
    const netSamples = ttfb => ({
        'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: ttfb, at: Date.now() })) })
    });

    env = build({ gm: Object.assign({}, fiveOrigins, netSamples(60)) });
    await env.settled();
    check('a fast link spends the full preconnect budget',
        env.head.children.filter(c => c.rel === 'preconnect').length === 4);

    env = build({ gm: Object.assign({}, fiveOrigins, netSamples(1200)) });
    await env.settled();
    check('a slow link is recognised without navigator.connection',
        env.head.children.filter(c => c.rel === 'preconnect').length === 2);

    console.log('\nTransition learning');

    env = build({ referrer: 'https://example.com/list?q=my-search-term' });
    await env.settled();
    let transitions = env.read('tm-qs-transitions');
    check('a same-origin transition is recorded',
        Boolean(transitions && transitions['/list'] && transitions['/list'].t['/article']));
    check('query strings are never stored',
        !JSON.stringify(transitions).includes('my-search-term'));

    env = build({ referrer: 'https://other.example.org/list' });
    await env.settled();
    check('a cross-origin referrer is ignored', env.read('tm-qs-transitions') === null);

    env = build({
        referrer: 'https://example.com/list',
        navEntries: [{ type: 'reload', requestStart: 10, responseStart: 60, responseEnd: 120, transferSize: 40000 }]
    });
    await env.settled();
    check('a reload is not a navigation choice', env.read('tm-qs-transitions') === null);

    console.log('\nCommands');

    env = build({ gm: heroRecord(3) });
    await env.settled();
    let threw = null;
    try {
        env.menu.get('Quicksilver: Status')();
    } catch (error) {
        threw = error;
    }
    check('status renders without throwing', threw === null, threw ? threw.message : '');

    env.menu.get('Quicksilver: Forget this site')();
    check('forget-this-site clears the learned record', env.read('tm-qs-lcp') === null);

    env.menu.get('Quicksilver: Toggle document warming')();
    check('document warming is opt-in and starts off',
        env.store.get('tm-qs-warm::https://example.com') === '1');

    console.log('\nSame-document route changes');

    // The regression this whole section exists for: a router swaps the DOM and
    // the polling watcher only notices afterwards, so measuring at that moment
    // credits the incoming hero to the outgoing route.
    let env2 = build({ pathname: '/list', images: [makeImage(1200, 600, 100, 'https://example.com/list-hero.jpg')] });
    await env2.settled();
    env2.fireLoad();
    env2.images.length = 0;
    env2.images.push(makeImage(1200, 600, 100, 'https://example.com/item-hero.jpg'));
    env2.navigate('/item');
    env2.drain();
    env2.drain();
    let store2 = env2.read('tm-qs-lcp') || {};
    check('a route left inside the settle window records nothing',
        store2['/list'] === undefined, JSON.stringify(store2['/list'] || null));
    check('the incoming hero is filed under the incoming route',
        Boolean(store2['/item']) && store2['/item'].url === 'https://example.com/item-hero.jpg');

    // The same navigation, but the outgoing route had time to be measured.
    env2 = build({ pathname: '/list', images: [makeImage(1200, 600, 100, 'https://example.com/list-hero.jpg')] });
    await env2.settled();
    env2.load();
    env2.images.length = 0;
    env2.images.push(makeImage(1200, 600, 100, 'https://example.com/item-hero.jpg'));
    env2.navigate('/item');
    env2.drain();
    env2.drain();
    store2 = env2.read('tm-qs-lcp') || {};
    check('a settled route keeps its own hero',
        Boolean(store2['/list']) && store2['/list'].url === 'https://example.com/list-hero.jpg');
    check('and the next route gets its own',
        Boolean(store2['/item']) && store2['/item'].url === 'https://example.com/item-hero.jpg');

    check('the transition is recorded',
        Boolean((env2.read('tm-qs-transitions') || {})['/list']));

    // Status used to read predictedTargets[0] on an array the route change had
    // just emptied, while preWarmedHero survived from the previous route.
    env2 = build({
        pathname: '/list',
        gm: {
            'tm-qs-transitions::https://example.com': JSON.stringify({ '/list': { t: { '/item': 5 }, at: Date.now() } }),
            'tm-qs-lcp::https://example.com': JSON.stringify({
                '/item': { url: 'https://example.com/item-hero.jpg', vw: '1280x2', at: Date.now(), seen: 5 }
            })
        }
    });
    await env2.settled();
    env2.load();
    env2.navigate('/profile');
    env2.drain();
    let statusThrew = null;
    try {
        env2.menu.get('Quicksilver: Status')();
    } catch (error) {
        statusThrew = error;
    }
    check('status survives a route change after a pre-warm',
        statusThrew === null, statusThrew ? statusThrew.message : '');

    // The status panel is the only way a user can tell 'not learned yet' from
    // 'learned but deliberately not acted on', so it has to keep them apart.
    env2 = build({
        pathname: '/list',
        gm: {
            'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: 500, at: Date.now() })) }),
            'tm-qs-transitions::https://example.com': JSON.stringify({ '/list': { t: { '/item': 8 }, at: Date.now() } })
        }
    });
    await env2.settled();
    env2.load();
    env2.menu.get('Quicksilver: Status')();
    const host = env2.document.body.children[env2.document.body.children.length - 1];
    const panelText = host.shadowRoot.children
        .map(child => (child.children || []).map(c => c.textContent || '').join(' '))
        .join(' ');
    check('a moderate link still reports what it has learned',
        panelText.includes('/item') && panelText.includes('8'),
        panelText.split('Next-page prediction')[1] ? panelText.split('Next-page prediction')[1].slice(0, 60).trim() : '');

    console.log('\nAsynchronous storage backend');

    // Storage primes a few microtasks in; a DOM-ready callback asking for the
    // tier before then must not be able to latch it.
    const slowNet = { 'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: 1400, at: Date.now() })) }) };
    const manyOrigins = {
        'tm-qs-origins::https://example.com': JSON.stringify({
            origins: ['a', 'b', 'c', 'd', 'e'].map(name => ({
                o: 'https://' + name + '.example.net', c: false, n: 5, t: 10, u: Date.now()
            }))
        })
    };

    // Injected after parsing, so runWhenDomReady runs during evaluation —
    // before the GM.getValue promises have resolved.
    env2 = build({ asyncGm: true, readyState: 'complete', gm: Object.assign({}, slowNet, manyOrigins) });
    await env2.settled();
    await env2.settled();
    check('a tier computed before priming is not latched',
        env2.head.children.filter(c => c.rel === 'preconnect').length === 2,
        env2.head.children.filter(c => c.rel === 'preconnect').length + ' preconnects');

    env2 = build({ asyncGm: true, gm: heroRecord(3) });
    await env2.settled();
    await env2.settled();
    check('the async backend still emits the learned preload',
        env2.head.children.some(c => c.rel === 'preload'));

    console.log('\nOlder WebKit');

    const video = Object.assign(makeEl('video'), { paused: true, currentTime: 0, autoplay: false });
    env2 = build({ legacyWebKit: true, videos: [video], gm: slowNet });
    await env2.settled();
    env2.load();
    check('video tuning survives without loading= or fetchpriority',
        video.attributes.preload === 'metadata', JSON.stringify(video.attributes));

    console.log('\nCritical origins, second look');

    env2 = build({
        gm: {
            'tm-qs-origins::https://example.com': JSON.stringify({
                origins: [{ o: 'https://cdn.example.com', c: false, n: 2, t: 10, u: Date.now() }]
            })
        }
    });
    await env2.settled();
    check('two sightings is enough for a measured origin',
        env2.head.children.filter(c => c.rel === 'preconnect').length === 1);

    console.log('\nLearned font preload');

    const fontEntry = (name, startTime) => ({ name, startTime, initiatorType: 'css', transferSize: 20000 });
    const fontStore = list => ({
        'tm-qs-fonts::https://example.com': JSON.stringify({
            fonts: list, at: Date.now()
        })
    });

    env2 = build({
        resourceEntries: [
            fontEntry('https://example.com/f/inter.woff2?v=8', 300),
            fontEntry('https://example.com/f/inter-bold.woff2', 350),
            // Too late to be what the first screen waits on.
            fontEntry('https://example.com/f/icons.woff2', 9000),
            // WebKit cannot use it, so it is not worth a record.
            fontEntry('https://example.com/f/legacy.eot', 320)
        ]
    });
    await env2.settled();
    env2.load();
    const learnedFonts = env2.read('tm-qs-fonts');
    const fontUrls = (learnedFonts ? learnedFonts.fonts : []).map(f => f.f);
    check('early fonts are recorded', fontUrls.includes('https://example.com/f/inter.woff2'));
    check('the cache-busting query is dropped',
        !JSON.stringify(fontUrls).includes('v=8'), JSON.stringify(fontUrls));
    check('a late font is not recorded', !fontUrls.some(u => u.includes('icons')));
    check('an unusable format is not recorded', !fontUrls.some(u => u.includes('legacy')));

    env2 = build({ gm: fontStore([{ f: 'https://example.com/f/inter.woff2', n: 1, t: 300, u: Date.now() }]) });
    await env2.settled();
    check('one sighting does not preload a font',
        !env2.head.children.some(c => c.as === 'font'));

    env2 = build({
        gm: fontStore([
            { f: 'https://example.com/f/a.woff2', n: 4, t: 300, u: Date.now() },
            { f: 'https://example.com/f/b.woff2', n: 3, t: 320, u: Date.now() },
            { f: 'https://example.com/f/c.woff2', n: 3, t: 340, u: Date.now() }
        ])
    });
    await env2.settled();
    let fontHints = env2.head.children.filter(c => c.as === 'font');
    check('two sightings preloads the font', fontHints.length > 0);
    check('the font budget is two on a fast link', fontHints.length === 2);
    // Without crossorigin the preload lands in a different cache partition and
    // the page fetches the font a second time — worse than not preloading.
    check('a font preload is always anonymous CORS',
        fontHints.every(c => c.crossOrigin === 'anonymous'));
    check('a font preload carries its type',
        fontHints.every(c => c.attributes.type === 'font/woff2'));

    env2 = build({
        gm: Object.assign(
            {},
            fontStore([{ f: 'https://example.com/f/a.woff2', n: 4, t: 300, u: Date.now() }]),
            { 'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: 1400, at: Date.now() })) }) }
        )
    });
    await env2.settled();
    check('a slow link preloads no fonts, the fallback renders',
        env2.head.children.filter(c => c.as === 'font').length === 0);

    env2 = build({
        gm: fontStore([{ f: 'https://example.com/f/a.woff2', n: 4, t: 300, u: Date.now() - (20 * 24 * 60 * 60 * 1000) }])
    });
    await env2.settled();
    check('a stale font record is not used',
        env2.head.children.filter(c => c.as === 'font').length === 0);

    console.log('\nViewport preconnect (iOS)');

    const anchorTo = href => Object.assign(makeEl('a'), { href });
    const phoneLinks = [
        anchorTo('https://cdn.example.net/a'),
        anchorTo('https://cdn.example.net/b'),
        anchorTo('https://img.example.org/c'),
        anchorTo('https://example.com/same-origin')
    ];

    env2 = build({ readyState: 'complete', hover: false, anchors: phoneLinks });
    await env2.settled();
    env2.scrollIntoView();
    let hints = env2.head.children;
    check('links scrolling into view warm their origin',
        hints.some(c => c.rel === 'preconnect' && c.href === 'https://cdn.example.net'));
    check('one origin is warmed once, not once per link',
        hints.filter(c => c.rel === 'preconnect' && c.href === 'https://cdn.example.net').length === 1);
    check('the current origin is never warmed',
        !hints.some(c => c.href === 'https://example.com'));
    check('DNS is prefetched too',
        hints.some(c => c.rel === 'dns-prefetch' && c.href === 'https://img.example.org'));

    env2 = build({ readyState: 'complete', hover: true, anchors: phoneLinks });
    await env2.settled();
    env2.scrollIntoView();
    check('a device with hover does not use viewport intent',
        !env2.head.children.some(c => c.rel === 'preconnect'));

    env2 = build({
        readyState: 'complete', hover: false, anchors: phoneLinks,
        gm: { 'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: 1400, at: Date.now() })) }) }
    });
    await env2.settled();
    env2.scrollIntoView();
    check('a slow link does not open speculative sockets',
        !env2.head.children.some(c => c.rel === 'preconnect'));

    // Budget: four sockets, then the observer stops watching entirely.
    const manyLinks = [];
    for (let i = 0; i < 20; i += 1) manyLinks.push(anchorTo('https://host' + i + '.example.net/x'));
    env2 = build({ readyState: 'complete', hover: false, anchors: manyLinks });
    await env2.settled();
    env2.scrollIntoView();
    check('the socket budget is capped at four',
        env2.head.children.filter(c => c.rel === 'preconnect').length === 4,
        env2.head.children.filter(c => c.rel === 'preconnect').length + ' preconnects');
    check('the DNS budget is capped at twelve',
        env2.head.children.filter(c => c.rel === 'dns-prefetch').length === 12);
    check('a spent observer stops watching', env2.observedLinks() === 0);

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    console.log(failed.length
        ? `${failed.length} OF ${results.length} CHECKS FAILED`
        : `ALL ${results.length} CHECKS PASSED`);
    process.exit(failed.length ? 1 : 0);
})();
