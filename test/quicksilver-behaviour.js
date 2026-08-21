// Headless behavioural tests for Quicksilver.js.
//
//   node test/quicksilver-behaviour.js
//
// Evaluates the userscript against a stubbed DOM and GM_* API, then asserts the
// behaviour 4.0.0 depends on: learning that does not wait for pagehide, routes
// attributed to the page that actually painted the hero, the confidence gate,
// and the scope limits on what transition prediction will store or act on.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, ok, extra) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

function makeEl(tag) {
    return {
        tagName: String(tag).toUpperCase(), style: { setProperty() {} }, attributes: {},
        children: [], firstElementChild: null, sheet: null,
        rel: '', href: '', src: '', type: '', textContent: '', crossOrigin: undefined,
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        hasAttribute(k) { return k in this.attributes; },
        removeAttribute(k) { delete this.attributes[k]; },
        addEventListener() {}, removeEventListener() {}, remove() {},
        appendChild(c) { this.children.push(c); return c; },
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        matches: () => false,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 })
    };
}

function build({ gm = {}, referrer = '', pathname = '/article', navigationApi = true, anchors = 17 } = {}) {
    const winListeners = new Map();
    const docListeners = new Map();
    const navListeners = new Map();
    const head = makeEl('head');
    const store = new Map(Object.entries(gm));
    const menu = new Map();
    const alerts = [];
    let lcpCallback = null;

    const add = (map, t, f) => { if (!map.has(t)) map.set(t, []); map.get(t).push(f); };
    const fire = (map, t, ev) => { for (const f of (map.get(t) || []).slice()) f(ev || {}); };

    const document = {
        readyState: 'loading', visibilityState: 'visible', referrer,
        head, body: makeEl('body'), documentElement: makeEl('html'),
        images: [], styleSheets: [],
        createElement: makeEl,
        querySelectorAll: sel => (String(sel).includes('a[href]')
            ? new Array(anchors).fill(0).map(() => makeEl('a')) : []),
        querySelector: () => null,
        addEventListener: (t, f) => add(docListeners, t, f),
        removeEventListener() {}, dispatchEvent: () => true
    };

    const history = { pushState() {}, replaceState() {} };

    const sandbox = {
        console, document, history,
        location: { href: 'https://site.test' + pathname, origin: 'https://site.test', pathname, search: '', protocol: 'https:' },
        navigator: {
            userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
            userAgentData: { brands: [{ brand: 'Google Chrome' }] },
            onLine: true,
            connection: { effectiveType: '4g', rtt: 80, downlink: 10, saveData: false },
            serviceWorker: { controller: null, addEventListener() {} }
        },
        performance: { getEntriesByType: () => [] },
        MutationObserver: class { observe() {} disconnect() {} },
        PerformanceObserver: class { constructor(cb) { lcpCallback = cb; } observe() {} disconnect() {} },
        HTMLScriptElement: { supports: () => true },
        CSSFontFaceRule: class {}, CSS: { supports: () => true },
        URL, Element: class {},
        innerWidth: 1280, devicePixelRatio: 2, innerHeight: 900,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: fn => setTimeout(fn, 0),
        requestIdleCallback: fn => setTimeout(() => fn({ timeRemaining: () => 5 }), 0),
        scheduler: undefined,
        alert: msg => alerts.push(String(msg)),
        GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
        GM_setValue: (k, v) => store.set(k, String(v)),
        GM_deleteValue: k => store.delete(k),
        GM_registerMenuCommand: (label, fn) => menu.set(label, fn)
    };

    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox; sandbox.globalThis = sandbox;
    sandbox.unsafeWindow = sandbox;
    sandbox.window.addEventListener = (t, f) => add(winListeners, t, f);
    sandbox.window.removeEventListener = () => {};
    if (navigationApi) {
        sandbox.navigation = { addEventListener: (t, f) => add(navListeners, t, f) };
    }

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Quicksilver.js'), 'utf8'),
        sandbox, { filename: 'Quicksilver.js' });

    return {
        head, store, menu, alerts, sandbox,
        emitLcp: entry => lcpCallback && lcpCallback({ getEntries: () => [entry] }),
        load() { document.readyState = 'complete'; fire(winListeners, 'load'); },
        domReady() { document.readyState = 'interactive'; fire(docListeners, 'DOMContentLoaded'); },
        navigateTo(p) {
            sandbox.location.pathname = p;
            sandbox.location.href = 'https://site.test' + p;
            if (navigationApi) fire(navListeners, 'navigate');
            else sandbox.history.pushState({}, '', p);
        },
        specRules: () => head.children.filter(c => c.type === 'speculationrules').map(c => c.textContent).join(' ')
    };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const lcpOf = h => JSON.parse(h.store.get('tm-qs-lcp::https://site.test') || '{}');
const transOf = h => JSON.parse(h.store.get('tm-qs-transitions::https://site.test') || '{}');

(async () => {
    // ---- learning no longer depends on pagehide ---------------------------
    const a = build();
    a.domReady();
    await wait(20);
    a.emitLcp({ url: 'https://cdn.site.test/hero.jpg', startTime: 1200, element: makeEl('img') });
    a.load();
    await wait(3400);
    check('LCP persisted without pagehide', Boolean(lcpOf(a)['/article']),
        Object.keys(lcpOf(a)).join(',') || 'nothing stored');
    check('hero URL recorded correctly',
        lcpOf(a)['/article'] && lcpOf(a)['/article'].url === 'https://cdn.site.test/hero.jpg');

    // ---- SPA route change must not misattribute the hero ------------------
    const b = build();
    b.domReady();
    await wait(20);
    b.emitLcp({ url: 'https://cdn.site.test/first.jpg', startTime: 900, element: makeEl('img') });
    b.load();
    await wait(20);
    b.navigateTo('/other');
    await wait(80);
    check('route change finalises under the OLD route', Boolean(lcpOf(b)['/article']),
        Object.keys(lcpOf(b)).join(',') || 'nothing stored');
    check('hero not attributed to the new route', !lcpOf(b)['/other']);

    // ---- confidence gate ---------------------------------------------------
    const once = build({ gm: { 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/article': { url: 'https://cdn.site.test/hero.jpg', vw: '1280x2', at: Date.now(), seen: 1 } }) } });
    await wait(20);
    check('single sighting does not preload', !once.head.children.some(c => c.rel === 'preload'));

    const twice = build({ gm: { 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/article': { url: 'https://cdn.site.test/hero.jpg', vw: '1280x2', at: Date.now(), seen: 2 } }) } });
    await wait(20);
    const preload = twice.head.children.find(c => c.rel === 'preload');
    check('second sighting emits the preload', Boolean(preload) && preload.href === 'https://cdn.site.test/hero.jpg');
    check('preload carries fetchpriority=high', Boolean(preload) && preload.getAttribute('fetchpriority') === 'high');

    // ---- transitions from document.referrer --------------------------------
    const r = build({ referrer: 'https://site.test/list?q=personal#frag' });
    await wait(20);
    check('records a transition from the referrer', Boolean(transOf(r)['/list']),
        Object.keys(transOf(r)).join(',') || 'nothing stored');
    check('strips query and fragment before storing',
        !(r.store.get('tm-qs-transitions::https://site.test') || '').includes('personal'));

    const x = build({ referrer: 'https://elsewhere.test/page' });
    await wait(20);
    check('refuses a cross-origin referrer transition', Object.keys(transOf(x)).length === 0);

    // ---- transitions from same-document navigation -------------------------
    const spa = build();
    spa.load();
    await wait(20);
    spa.navigateTo('/detail');
    await wait(80);
    check('records a same-document route transition', Boolean(transOf(spa)['/article']),
        Object.keys(transOf(spa)).join(',') || 'nothing stored');

    // Same, without the Navigation API — exercises the pushState fallback.
    const legacy = build({ navigationApi: false });
    legacy.load();
    await wait(20);
    legacy.navigateTo('/detail');
    await wait(80);
    check('pushState fallback records the transition when Navigation API is absent',
        Boolean(transOf(legacy)['/article']),
        Object.keys(transOf(legacy)).join(',') || 'nothing stored');

    // ---- prediction --------------------------------------------------------
    const seeded = t => ({ 'tm-qs-transitions::https://site.test': JSON.stringify({
        '/article': { t, at: Date.now() } }) });

    const p = build({ gm: seeded({ '/next': 4 }) });
    p.load();
    await wait(80);
    // Part 2's blanket ruleset is also present; match only the prediction's.
    const predictionRule = (p.specRules().match(/\{"(?:prerender|prefetch)":\[\{"urls":[^}]*\}\]\}/) || [])[0];
    check('repeated target installs a speculation rule', p.specRules().includes('/next'),
        predictionRule || 'no prediction rule');

    const weak = build({ gm: seeded({ '/next': 1 }) });
    weak.load();
    await wait(80);
    check('single sighting is below the confidence threshold', !weak.specRules().includes('/next'));

    const unsafe = build({ gm: seeded({ '/account/delete': 9 }) });
    unsafe.load();
    await wait(80);
    check('sensitive predicted target is refused', !unsafe.specRules().includes('/account/delete'));

    const dl = build({ gm: seeded({ '/files/report.pdf': 9 }) });
    dl.load();
    await wait(80);
    check('download predicted target is refused', !dl.specRules().includes('report.pdf'));

    // ---- menu commands -----------------------------------------------------
    const m = build({ gm: { 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/article': { url: 'https://cdn.site.test/hero.jpg', vw: '1280x2', at: Date.now(), seen: 1 } }) } });
    await wait(20);
    check('registers the four menu commands', m.menu.size === 4, [...m.menu.keys()].join(' | '));

    m.menu.get('Quicksilver: Status')();
    const report = m.alerts[0] || '';
    check('status distinguishes "learned but waiting"', report.includes('1 more visit before it acts'),
        (report.split('\n').find(l => l.includes('hero')) || '').trim());
    check('status reports eligible link count', report.includes('17 eligible links'));
    check('status names the connection tier', report.includes('fast (4g)'));

    m.menu.get('Quicksilver: Forget this site')();
    check('forget-this-site clears the learned record', !m.store.has('tm-qs-lcp::https://site.test'));

    const bad = results.filter(r => !r[1]).length;
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
    process.exit(bad ? 1 : 0);
})();
