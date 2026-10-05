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
//
// 1.1.0 adds what was ported from the Chrome build's 4.1.0 and 4.2.0: the
// action-link filter (asserted on the document-warming path, where a wrong
// answer is a real credentialed GET), target="_self" and bare <a download>,
// SPA detection switching warming off, transition targets that age out and
// make room, <picture> heroes, zoom-tolerant viewport matching, icon fonts
// left alone, the origin gate and budget, and hero hit-rate scoring. It also
// stubs the three APIs this build now feature-detects — LCP, the Navigation
// API and <link rel=prefetch> — and checks each is used when present.
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
    // The three APIs 1.1.0 feature-detects, each absent unless asked for.
    lcpEntries = null, navigationApi = false, linkPrefetch = false,
    innerWidth = 1280, devicePixelRatio = 2
} = {}) {
    const winListeners = new Map();
    const docListeners = new Map();
    const head = makeEl('head');
    const store = new Map(Object.entries(gm));
    const menu = new Map();
    const timers = [];
    const intervals = [];
    const fetches = [];
    const navListeners = new Map();

    const add = (map, t, f) => { if (!map.has(t)) map.set(t, []); map.get(t).push(f); };
    const fire = (map, t, ev) => { for (const f of (map.get(t) || []).slice()) f(ev || {}); };

    const document = {
        readyState, visibilityState: 'visible', referrer,
        head, body: makeEl('body'), documentElement: makeEl('html'),
        images, styleSheets: [],
        createElement: tag => {
            const el = makeEl(tag);
            if (String(tag).toLowerCase() === 'link') {
                el.relList = { supports: type => linkPrefetch && type === 'prefetch' };
            }
            return el;
        },
        querySelectorAll: selector => (String(selector).includes('video') ? videos : []),
        querySelector: () => null,
        addEventListener: (t, f) => add(docListeners, t, f),
        removeEventListener() {}, dispatchEvent: () => true
    };

    const window = {
        document,
        location: new URL('https://example.com' + pathname),
        // The two APIs whose absence defines this port.
        navigator: { userAgent, vendor, connection: undefined },
        innerWidth, innerHeight: 800, devicePixelRatio,
        pageYOffset: 0, pageXOffset: 0,
        performance: {
            now: () => 100,
            getEntriesByType: type => {
                if (type === 'navigation') return navEntries;
                if (type === 'paint') return paintEntries;
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
        fetch: href => { fetches.push(href); return Promise.resolve({ body: null }); },
        MutationObserver: class { observe() {} disconnect() {} },
        // With lcpEntries, a WebKit that reports LCP: buffered entries are
        // delivered as soon as observe() is called.
        PerformanceObserver: lcpEntries
            ? Object.assign(class {
                constructor(callback) { this.callback = callback; }
                observe() { this.callback({ getEntries: () => lcpEntries }); }
            }, { supportedEntryTypes: ['largest-contentful-paint', 'paint', 'resource', 'navigation'] })
            : class { observe() {} },
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

    if (navigationApi) {
        window.navigation = { addEventListener: (t, f) => add(navListeners, t, f) };
    }

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
        'GM', 'GM_getValue', 'GM_setValue', 'GM_deleteValue'
    ]) if (key in window) context[key] = window[key];

    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'Quicksilver.safari.user.js'), 'utf8'),
        context
    );

    const drain = () => { let fn; while ((fn = timers.shift())) fn(); };

    return {
        window, document, head, store, menu, images, winListeners, docListeners, fire, drain,
        fetches, intervals,
        // A link the script's `instanceof Element` check accepts.
        link(href, attrs = {}) {
            const el = Object.create(window.Element.prototype);
            Object.assign(el, makeEl('a'), {
                href: new URL(href, context.location.href).href,
                rel: attrs.rel || ''
            });
            el.attributes = Object.assign({ href }, attrs);
            el.closest = () => el;
            return el;
        },
        press(link) {
            fire(docListeners, 'pointerdown', { button: 0, target: link });
        },
        click(link) {
            fire(docListeners, 'click', { button: 0, target: link });
        },
        // A same-document navigation reported by the Navigation API.
        softNavigate(nextPath) {
            context.location = new URL('https://example.com' + nextPath);
            fire(navListeners, 'currententrychange');
        },
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
                    { o: 'https://ads.example.net', c: false, n: 9, t: 10, u: Date.now() - 15 * 24 * 3600 * 1000 }
                ]
            })
        }
    });
    await env.settled();
    const preconnects = env.head.children.filter(c => c.rel === 'preconnect');
    check('an origin not seen for two weeks is not preconnected',
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
    // preconnects: the budget is 6 on a fast link and 2 on a slow one.
    const fiveOrigins = {
        'tm-qs-origins::https://example.com': JSON.stringify({
            origins: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => ({
                o: 'https://' + name + '.example.net', c: false, n: 5, t: 10, u: Date.now()
            }))
        })
    };
    const netSamples = ttfb => ({
        'tm-qs-net': JSON.stringify({ s: [0, 1, 2].map(() => ({ t: ttfb, at: Date.now() })) })
    });

    env = build({ gm: Object.assign({}, fiveOrigins, netSamples(60)) });
    await env.settled();
    check('a fast link spends the full preconnect budget of six',
        env.head.children.filter(c => c.rel === 'preconnect').length === 6,
        env.head.children.filter(c => c.rel === 'preconnect').length + ' preconnects');

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
        panelText.split('Next-page prediction')[1] ? panelText.split('Next-page prediction')[1].trim().split('\n')[0] : '');

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
                origins: [{ o: 'https://cdn.example.com', c: false, n: 1, t: 10, u: Date.now() }]
            })
        }
    });
    await env2.settled();
    check('one sighting is enough: a measured origin is preconnected on the second visit',
        env2.head.children.filter(c => c.rel === 'preconnect').length === 1);

    const WARM_ON = { 'tm-qs-warm::https://example.com': '1' };
    const fresh = () => Date.now();
    const daysAgo = days => Date.now() - days * 24 * 60 * 60 * 1000;

    console.log('\nAction links (document warming is a real credentialed GET)');

    env2 = build({ gm: WARM_ON });
    await env2.settled();
    const refused = [
        ['/vote?id=1&how=up&auth=abc123', 'a Hacker News vote'],
        ['/item?id=1&goto=news&auth=abc123', 'any link carrying a CSRF-style token'],
        ['/Account/LogOff', 'ASP.NET LogOff, whatever its case'],
        ['/owa/logoff.owa', 'OWA logoff'],
        ['/remove-from-cart/5', 'a verb-led compound with an argument'],
        ['/orders/cancelOrder', 'a camelCase action'],
        ['/message/unread/', 'a page that acts by being viewed'],
        ['/post/9?do=trash', 'a verb as a query value'],
        ['/basket/add?sku=4', 'an add-to-basket link']
    ];
    for (const [href, label] of refused) {
        env2.fetches.length = 0;
        env2.press(env2.link(href));
        check('refuses ' + label, env2.fetches.length === 0, href);
    }

    const allowed = [
        ['/w/index.php?title=Page&action=history', 'Wikipedia history (no blanket action=)'],
        ['/2025/06/like-a-pro-guide', 'a slug that merely starts with a verb'],
        ['/reports', 'a plural index page'],
        ['/blog/next-post', 'an ordinary page']
    ];
    for (const [href, label] of allowed) {
        env2.fetches.length = 0;
        env2.press(env2.link(href));
        check('still warms ' + label, env2.fetches.length === 1, href);
    }

    env2.fetches.length = 0;
    env2.press(env2.link('/section/self', { target: '_self' }));
    check('target="_self" stays in the tab and is warmed', env2.fetches.length === 1);

    env2.fetches.length = 0;
    env2.press(env2.link('/section/blank', { target: '_blank' }));
    check('target="_blank" is not', env2.fetches.length === 0);

    env2.fetches.length = 0;
    env2.press(env2.link('/files/latest', { download: '' }));
    check('a bare <a download> is refused', env2.fetches.length === 0);

    console.log('\nSPA detection');

    env2 = build({ gm: WARM_ON, pathname: '/list' });
    await env2.settled();
    env2.click(env2.link('/item'));
    env2.navigate('/item');
    check('a click answered by a same-document navigation marks the origin',
        Boolean(env2.read('tm-qs-spa')));
    env2.fetches.length = 0;
    env2.press(env2.link('/other'));
    check('and document warming stops on this visit, not only the next',
        env2.fetches.length === 0);

    env2 = build({ gm: WARM_ON, pathname: '/list' });
    await env2.settled();
    env2.navigate('/list/page/2');
    check('a URL rewrite no click asked for is not a router', !env2.read('tm-qs-spa'));

    env2 = build({ gm: WARM_ON, pathname: '/list' });
    await env2.settled();
    env2.click(env2.link('/item'));
    env2.navigate('/list/page/2');
    check('nor is a push to somewhere other than the clicked link', !env2.read('tm-qs-spa'));

    env2 = build({ gm: Object.assign({ 'tm-qs-spa::https://example.com': JSON.stringify({ at: fresh() }) }, WARM_ON) });
    await env2.settled();
    env2.press(env2.link('/blog/next-post'));
    check('a known SPA is not warmed on a later visit', env2.fetches.length === 0);

    env2 = build({ gm: Object.assign({ 'tm-qs-spa::https://example.com': JSON.stringify({ at: daysAgo(15) }) }, WARM_ON) });
    await env2.settled();
    env2.press(env2.link('/blog/next-post'));
    check('an SPA flag ages out, so a site that drops its router gets warming back',
        env2.fetches.length === 1);

    console.log('\nTransition learning, aging');

    const fourTargets = {
        'tm-qs-transitions::https://example.com': JSON.stringify({
            '/list': { t: { '/a': { n: 5, at: fresh() }, '/b': { n: 5, at: fresh() }, '/c': { n: 5, at: fresh() }, '/d': { n: 5, at: fresh() } }, at: fresh() }
        })
    };
    env2 = build({ referrer: 'https://example.com/list', gm: fourTargets });
    await env2.settled();
    let targets = env2.read('tm-qs-transitions')['/list'].t;
    check('a fifth destination is still learned', Boolean(targets['/article']) && targets['/article'].n === 1,
        Object.keys(targets).join(','));
    check('and the source still keeps at most four', Object.keys(targets).length === 4);

    env2 = build({
        referrer: 'https://example.com/list',
        gm: {
            'tm-qs-transitions::https://example.com': JSON.stringify({
                '/list': { t: { '/old': { n: 9, at: daysAgo(20) }, '/kept': { n: 2, at: fresh() } }, at: fresh() }
            })
        }
    });
    await env2.settled();
    targets = env2.read('tm-qs-transitions')['/list'].t;
    check('a destination not taken for two weeks ages out on its own', !targets['/old'] && Boolean(targets['/kept']),
        Object.keys(targets).join(','));

    env2 = build({
        referrer: 'https://example.com/list',
        gm: {
            'tm-qs-transitions::https://example.com': JSON.stringify({ '/list': { t: { '/article': 3 }, at: fresh() } })
        }
    });
    await env2.settled();
    targets = env2.read('tm-qs-transitions')['/list'].t;
    check('a 1.0 bare count is migrated and keeps counting',
        targets['/article'] && targets['/article'].n === 4 && Number.isFinite(targets['/article'].at),
        JSON.stringify(targets));

    console.log('\nHero records, 1.1.0');

    const picture = makeImage(1200, 600, 100, 'https://example.com/hero.avif');
    picture.parentElement = { tagName: 'PICTURE' };
    picture.attributes.srcset = 'https://example.com/hero-800.jpg 800w, https://example.com/hero-1600.jpg 1600w';
    env2 = build({ images: [picture] });
    await env2.settled();
    env2.load();
    learned = env2.read('tm-qs-lcp')['/article'];
    check('a <picture> hero records the URL it painted, not the <img> fallback srcset',
        learned.url === 'https://example.com/hero.avif' && learned.srcset === null, JSON.stringify(learned));

    const srcsetRecord = {
        'tm-qs-lcp::https://example.com': JSON.stringify({
            '/article': {
                url: 'https://cdn.example.com/hero.jpg', srcset: 'https://cdn.example.com/hero.jpg 1x',
                vw: 1280, dpr: 1, at: fresh(), seen: 3
            }
        })
    };
    env2 = build({ gm: srcsetRecord });
    await env2.settled();
    check('a srcset hero survives zoom: the browser picks the density',
        env2.head.children.some(c => c.rel === 'preload'));

    env2 = build({ gm: srcsetRecord, legacyWebKit: true });
    await env2.settled();
    check('but not on a Safari without imagesrcset, which would preload the old density',
        !env2.head.children.some(c => c.rel === 'preload'));

    env2 = build({ gm: heroRecord(3), innerWidth: 1340 });
    await env2.settled();
    check('a nudged window edge keeps the record', env2.head.children.some(c => c.rel === 'preload'));

    env2 = build({ gm: heroRecord(3), images: [makeImage(1200, 600, 100, 'https://cdn.example.com/hero.jpg')] });
    await env2.settled();
    env2.load();
    let stats = env2.read('tm-qs-stats');
    check('a preload that was the hero is scored as a hit', stats && stats.hero && stats.hero.hit === 1,
        JSON.stringify(stats));

    env2 = build({ gm: heroRecord(3), images: [makeImage(1200, 600, 100, 'https://cdn.example.com/other.jpg')] });
    await env2.settled();
    env2.load();
    stats = env2.read('tm-qs-stats');
    check('and one that was not as a miss', stats && stats.hero && stats.hero.miss === 1, JSON.stringify(stats));
    check('the all-sites tally counts it too',
        JSON.parse(env2.store.get('tm-qs-stats-all') || '{}').hero.miss === 1);

    env2.menu.get('Quicksilver: Status')();
    const statusHost = env2.document.body.children[env2.document.body.children.length - 1];
    const statusText = statusHost.shadowRoot.children
        .map(child => (child.children || []).map(c => c.textContent || '').join(' ')).join(' ');
    check('status reports the hit rate', statusText.includes('Hero preload was the hero  0 of 1'),
        (statusText.match(/Hero preload was the hero[^\n]*/) || [''])[0]);

    console.log('\nLargest Contentful Paint, where WebKit reports it');

    const lcpImage = url => ({ url, startTime: 1400, element: { crossOrigin: null, getAttribute: () => null, parentElement: null } });
    env2 = build({
        lcpEntries: [lcpImage('https://example.com/measured.jpg')],
        images: [makeImage(1280, 700, 0, 'https://example.com/biggest-but-not-lcp.jpg')]
    });
    await env2.settled();
    env2.load();
    learned = env2.read('tm-qs-lcp')['/article'];
    check('the measured LCP is the hero, not the largest image',
        learned.url === 'https://example.com/measured.jpg' && learned.src === 'lcp', JSON.stringify(learned));
    check('and the LCP itself is sampled', (env2.read('tm-qs-vitals') || {}).lcp[0] === 1400);

    env2 = build({
        lcpEntries: [lcpImage('https://example.com/logo.png'), { url: '', startTime: 1600, element: null }],
        gm: { 'tm-qs-lcp::https://example.com': JSON.stringify({ '/article': { url: 'https://example.com/logo.png', src: 'lcp', vw: 1280, dpr: 2, at: fresh(), seen: 2 } }) }
    });
    await env2.settled();
    env2.load();
    learned = (env2.read('tm-qs-lcp') || {})['/article'];
    check('a text LCP that outgrew an earlier image clears it', !learned || learned.seen === 1, JSON.stringify(learned));

    env2 = build({
        gm: { 'tm-qs-lcp::https://example.com': JSON.stringify({ '/article': { url: 'https://cdn.example.com/hero.jpg', src: 'lcp', vw: 1280, dpr: 2, at: fresh(), seen: 2 } }) }
    });
    await env2.settled();
    check('a measured record acts at two sightings, like Chrome',
        env2.head.children.some(c => c.rel === 'preload'));

    env2 = build({
        pathname: '/list',
        lcpEntries: [lcpImage('https://example.com/list-lcp.jpg')],
        images: [makeImage(1200, 600, 100, 'https://example.com/list-hero.jpg')]
    });
    await env2.settled();
    env2.load();
    env2.images.length = 0;
    env2.images.push(makeImage(1200, 600, 100, 'https://example.com/item-hero.jpg'));
    env2.navigate('/item');
    env2.drain();
    env2.drain();
    learned = env2.read('tm-qs-lcp') || {};
    check('LCP is silent after a client-side navigation, so geometry learns that route',
        learned['/item'] && learned['/item'].src === 'geo'
        && learned['/list'] && learned['/list'].src === 'lcp', JSON.stringify(learned));

    console.log('\nNavigation API, where WebKit has it');

    env2 = build({ navigationApi: true, pathname: '/list' });
    await env2.settled();
    check('no location poll is started', env2.intervals.length === 0, env2.intervals.length + ' intervals');
    env2.softNavigate('/item');
    check('route changes still arrive', Boolean((env2.read('tm-qs-transitions') || {})['/list']));

    env2 = build({ pathname: '/list' });
    await env2.settled();
    check('without it, the poll is the fallback', env2.intervals.length === 1);

    console.log('\n<link rel=prefetch>, where WebKit has it');

    env2 = build({ gm: WARM_ON, linkPrefetch: true });
    await env2.settled();
    env2.press(env2.link('/blog/next-post'));
    check('warming uses the browser\'s prefetch instead of fetch()',
        env2.fetches.length === 0 && env2.head.children.some(c => c.rel === 'prefetch'));

    console.log('\nIcon fonts');

    env2 = build();
    await env2.settled();
    const fontRule = family => Object.assign(new env2.window.CSSFontFaceRule(), {
        style: { fontDisplay: '', getPropertyValue: name => (name === 'font-family' ? family : '') }
    });
    const iconRule = fontRule('"FontAwesome"');
    const textRule = fontRule('"Inter"');
    env2.document.styleSheets = [{ cssRules: [iconRule, textRule] }];
    env2.fire(env2.winListeners, 'DOMContentLoaded');
    check('a text font gets a non-blocking font-display', textRule.style.fontDisplay === 'swap');
    check('an icon font keeps its blocking one', iconRule.style.fontDisplay === '');

    const failed = results.filter(([, ok]) => !ok);
    console.log('');
    console.log(failed.length
        ? `${failed.length} OF ${results.length} CHECKS FAILED`
        : `ALL ${results.length} CHECKS PASSED`);
    process.exit(failed.length ? 1 : 0);
})();
