// Headless behavioural tests for Quicksilver.js.
//
//   node test/quicksilver-behaviour.js
//
// Evaluates the userscript against a stubbed DOM and GM_* API, then asserts the
// behaviour 4.x depends on: learning that does not wait for pagehide, routes
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
        addEventListener() {}, removeEventListener() {},
        remove() {
            if (!this.parentNode) return;
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
            this.parentNode = null;
        },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        matches: () => false,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 })
    };
}

const FAST = { effectiveType: '4g', rtt: 80, downlink: 10, saveData: false };
const MODERATE = { effectiveType: '3g', rtt: 300, downlink: 1.5, saveData: false };
const SLOW = { effectiveType: '4g', rtt: 80, downlink: 10, saveData: true };
const SCRIPT_VERSION = (fs.readFileSync(path.join(__dirname, '..', 'Quicksilver.js'), 'utf8')
    .match(/@version\s+(\S+)/) || [])[1];

function build({ gm = {}, referrer = '', pathname = '/article', navigationApi = true, anchors = 17, navEntries = [], prerendering = false, speculation = true, localStorageSeed = {}, connection = FAST, topFrame = true, viewport = { width: 1280, dpr: 2 }, trustedTypesEnforced = false, chromeVersion = 154 } = {}) {
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
        prerendering,
        head, body: makeEl('body'), documentElement: makeEl('html'),
        images: [], styleSheets: [],
        // Trusted Types enforcement, as on YouTube: a script element's text
        // refuses plain strings and accepts only a policy's output.
        createElement: tag => {
            const el = makeEl(tag);
            if (trustedTypesEnforced && String(tag).toLowerCase() === 'script') {
                let text = '';
                Object.defineProperty(el, 'textContent', {
                    get: () => text,
                    set: v => {
                        if (typeof v === 'string') throw new TypeError("This document requires 'TrustedScript' assignment.");
                        text = v;
                    }
                });
            }
            return el;
        },
        querySelectorAll: sel => (String(sel).includes('a[href]')
            ? new Array(anchors).fill(0).map(() => makeEl('a')) : []),
        querySelector: () => null,
        addEventListener: (t, f) => add(docListeners, t, f),
        removeEventListener() {}, dispatchEvent: () => true
    };

    const history = { pushState() {}, replaceState() {} };

    const lsMap = new Map(Object.entries(localStorageSeed));
    const sandbox = {
        console, document, history,
        localStorage: {
            getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
            setItem: (k, v) => lsMap.set(k, String(v)),
            removeItem: k => lsMap.delete(k)
        },
        location: { href: 'https://site.test' + pathname, origin: 'https://site.test', pathname, search: '', protocol: 'https:' },
        navigator: {
            userAgent: 'Mozilla/5.0 Chrome/' + chromeVersion + '.0.0.0 Safari/537.36',
            userAgentData: { brands: [{ brand: 'Google Chrome', version: String(chromeVersion) }] },
            onLine: true,
            connection: Object.assign({}, connection),
            serviceWorker: { controller: null, addEventListener() {} }
        },
        performance: { getEntriesByType: t => (t === 'navigation' ? navEntries : []) },
        MutationObserver: class { observe() {} disconnect() {} },
        PerformanceObserver: class { constructor(cb) { lcpCallback = cb; } observe() {} disconnect() {} },
        HTMLScriptElement: { supports: () => speculation },
        CSSFontFaceRule: class {}, CSS: { supports: () => true },
        URL, Element: class {},
        innerWidth: viewport.width, devicePixelRatio: viewport.dpr, innerHeight: 900,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: fn => setTimeout(fn, 0),
        requestIdleCallback: fn => setTimeout(() => fn({ timeRemaining: () => 5 }), 0),
        scheduler: undefined,
        alert: msg => alerts.push(String(msg)),
        GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
        GM_setValue: (k, v) => store.set(k, String(v)),
        GM_deleteValue: k => store.delete(k),
        GM_registerMenuCommand: (label, fn) => menu.set(label, fn),
        GM_info: { script: { version: SCRIPT_VERSION } },
        trustedTypes: trustedTypesEnforced
            ? { createPolicy: () => ({ createScript: s => ({ trusted: s, toString: () => s }) }) }
            : undefined
    };

    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    sandbox.top = topFrame ? sandbox : {};
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
        // DOMContentLoaded bubbles from document to window; listeners exist on both.
        domReady() {
            document.readyState = 'interactive';
            fire(docListeners, 'DOMContentLoaded');
            fire(winListeners, 'DOMContentLoaded');
        },
        // `click` presses a link first, the way a router-driven navigation
        // starts; `push: false` models replaceState.
        navigateTo(p, { push = true, click = false, clickHref = p } = {}) {
            if (click) {
                const link = { href: new URL(clickHref, sandbox.location.href).href, getAttribute: () => clickHref };
                const target = Object.assign(Object.create(sandbox.Element.prototype), { closest: () => link });
                fire(docListeners, 'click', { target });
            }
            sandbox.location.pathname = p;
            sandbox.location.href = 'https://site.test' + p;
            if (navigationApi) fire(navListeners, 'navigate', { navigationType: push ? 'push' : 'replace' });
            else if (push) sandbox.history.pushState({}, '', p);
            else sandbox.history.replaceState({}, '', p);
        },
        activatePrerender() {
            document.prerendering = false;
            fire(docListeners, 'prerenderingchange');
        },
        // Presses a link whose raw href attribute is `href`.
        pointerdown(href, attrs = {}) {
            const link = {
                href: new URL(href, sandbox.location.href).href,
                getAttribute: k => (k === 'href' ? href : (k in attrs ? attrs[k] : null)),
                target: '', download: false, rel: ''
            };
            const target = Object.assign(Object.create(sandbox.Element.prototype), { closest: () => link });
            fire(docListeners, 'pointerdown', { button: 0, target });
        },
        fireDoc: (type, ev) => fire(docListeners, type, ev),
        blanketRules() {
            const script = head.children.find(c => c.type === 'speculationrules' && String(c.textContent).includes('"where"'));
            return script ? JSON.parse(String(script.textContent)) : null;
        },
        specRules: () => head.children.filter(c => c.type === 'speculationrules').map(c => String(c.textContent)).join(' ')
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
    check('single sighting prefetches but does not prerender',
        weak.specRules().includes('{"prefetch":[{"urls":["https://site.test/next"]')
        && !weak.specRules().includes('{"prerender":[{"urls":["https://site.test/next"]'),
        weak.specRules().match(/\{"(?:prerender|prefetch)":\[\{"urls":[^}]*\}\]\}/)?.[0] || 'no rule');

    const pair = build({ gm: seeded({ '/next': 3, '/other': 1 }) });
    pair.load();
    await wait(80);
    const pairRule = pair.specRules();
    check('top prediction prerenders, runner-up prefetches',
        pairRule.includes('"prerender":[{"urls":["https://site.test/next"]')
        && pairRule.includes('"prefetch":[{"urls":["https://site.test/other"]'));

    const mod = build({ gm: seeded({ '/next': 2 }), connection: MODERATE });
    mod.load();
    await wait(80);
    check('moderate tier prerenders a two-sighting prediction',
        mod.specRules().includes('"prerender":[{"urls":["https://site.test/next"]'));

    const vote = build({ gm: seeded({ '/vote': 9 }) });
    vote.load();
    await wait(80);
    check('action-verb predicted target is refused', !vote.specRules().includes('/vote'));

    const unsafe = build({ gm: seeded({ '/account/delete': 9 }) });
    unsafe.load();
    await wait(80);
    check('sensitive predicted target is refused', !unsafe.specRules().includes('/account/delete'));

    const dl = build({ gm: seeded({ '/files/report.pdf': 9 }) });
    dl.load();
    await wait(80);
    check('download predicted target is refused', !dl.specRules().includes('report.pdf'));

    // ---- reloads are not chosen navigations (4.0.0 review fix) -------------
    const rl = build({ referrer: 'https://site.test/list', navEntries: [{ type: 'reload' }] });
    await wait(20);
    check('reload does not re-record the referrer transition', Object.keys(transOf(rl)).length === 0,
        Object.keys(transOf(rl)).join(',') || 'store empty');

    const bf = build({ referrer: 'https://site.test/list', navEntries: [{ type: 'back_forward' }] });
    await wait(20);
    check('back/forward traversal does not record a transition', Object.keys(transOf(bf)).length === 0);

    // ---- prerendered documents neither record nor persist ------------------
    const pr = build({ referrer: 'https://site.test/list', prerendering: true });
    pr.domReady();
    await wait(20);
    pr.emitLcp({ url: 'https://cdn.site.test/hero.jpg', startTime: 800, element: makeEl('img') });
    pr.load();
    await wait(3400);
    check('prerendered page records no phantom transition', Object.keys(transOf(pr)).length === 0,
        Object.keys(transOf(pr)).join(',') || 'store empty');
    check('prerendered page persists no LCP record', Object.keys(lcpOf(pr)).length === 0);

    pr.activatePrerender();
    await wait(3500);
    check('activation records the transition', Boolean(transOf(pr)['/list']),
        Object.keys(transOf(pr)).join(',') || 'nothing stored');
    check('activation lets the LCP record persist', Boolean(lcpOf(pr)['/article']),
        Object.keys(lcpOf(pr)).join(',') || 'nothing stored');

    // ---- soft-nav revisits must not erode learned records ------------------
    const er = build({ gm: { 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/other': { url: 'https://cdn.site.test/other.jpg', vw: '1280x2', at: Date.now(), seen: 2 } }) } });
    er.domReady();
    er.load();
    await wait(20);
    er.navigateTo('/other');
    await wait(3500);
    const erRec = lcpOf(er)['/other'];
    check('soft-nav revisit does not erode the learned record',
        Boolean(erRec) && Number(erRec.seen) === 2,
        erRec ? 'seen=' + erRec.seen : 'record deleted');

    // The legitimate decrement — initial hard-navigation route with no image
    // LCP — must survive the erosion fix.
    const dec = build({ gm: { 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/article': { url: 'https://cdn.site.test/hero.jpg', vw: '1280x2', at: Date.now(), seen: 2 } }) } });
    dec.domReady();
    dec.load();
    await wait(3500);
    const decRec = lcpOf(dec)['/article'];
    check('hard-nav route with no image LCP still decrements',
        Boolean(decRec) && Number(decRec.seen) === 1,
        decRec ? 'seen=' + decRec.seen : 'record deleted');

    // ---- 3.x migration (runs at script eval, so seed before build) ---------
    const mig = build({ localStorageSeed: {
        'tm-qs-content-visibility': '1',
        'tm-cache-lru-metadata': '{"a":1}',
        'tm-cache-stats': '{"hits":9}'
    } });
    await wait(20);
    check('CV preference migrates from localStorage into GM storage',
        mig.store.get('tm-qs-content-visibility::https://site.test') === '1');
    check('legacy localStorage keys are removed',
        mig.sandbox.localStorage.getItem('tm-qs-content-visibility') === null
        && mig.sandbox.localStorage.getItem('tm-cache-lru-metadata') === null
        && mig.sandbox.localStorage.getItem('tm-cache-stats') === null);

    // ---- status must show prediction as off when speculation is off --------
    const off = build({ speculation: false });
    await wait(20);
    off.menu.get('Quicksilver: Status')();
    const offReport = off.alerts[0] || '';
    check('status shows prediction as off when speculation unsupported',
        offReport.includes('○ Next-page prediction') && offReport.includes('not supported'),
        (offReport.split('\n').find(l => l.includes('Next-page')) || '').trim());

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
    check('status reports the header version', report.startsWith('Quicksilver ' + SCRIPT_VERSION + ' '),
        report.split('\n')[0]);

    // ---- 4.1.0: blanket rules ---------------------------------------------
    const bl = build();
    bl.domReady();
    await wait(20);
    const blRules = bl.blanketRules();
    const sameOrigin = blRules && blRules.prefetch.find(r => JSON.stringify(r.where).includes('{"href_matches":"/*"}'));
    check('blanket rules install at DOMContentLoaded, before load', Boolean(blRules));
    check('same-origin prefetch is eager', Boolean(sameOrigin) && sameOrigin.eagerness === 'eager');
    const blText = JSON.stringify(blRules || {});
    check('declarative excludes cover action verbs at any depth, case-insensitively',
        blText.includes("a[href*='/vote' i]") && blText.includes("a[href^='hide' i]"));
    check('declarative excludes cover CSRF-token query strings',
        blText.includes("a[href*='auth=' i]") && blText.includes("a[href*='sesskey' i]"));
    const crossOrigin = blRules && blRules.prefetch.find(r => JSON.stringify(r.where).includes('{"not":{"href_matches":"/*"}}'));
    check('cross-origin links prefetch on pointerdown', Boolean(crossOrigin) && crossOrigin.eagerness === 'conservative');

    const blMod = build({ connection: MODERATE });
    blMod.domReady();
    await wait(20);
    const blModRules = blMod.blanketRules();
    check('moderate tier: eager prefetch, no blanket prerender',
        Boolean(blModRules) && blModRules.prefetch[0].eagerness === 'eager' && !blModRules.prerender);

    const frame = build({ topFrame: false });
    frame.domReady();
    frame.load();
    await wait(80);
    check('no speculation rules inside an iframe', frame.specRules() === '');

    // ---- 4.1.0: pointerdown refuses action links ---------------------------
    const pd = build({ pathname: '/news' });
    pd.domReady();
    await wait(20);
    pd.head.children.length = 0;
    pd.pointerdown('vote?id=1&how=up&auth=abc123&goto=news');
    pd.pointerdown('ucp.php?mode=logout&sid=deadbeef');
    pd.pointerdown('/wp-admin/post.php?post=9&action=trash&_wpnonce=abc');
    check('pointerdown refuses vote, logout and nonce links', pd.specRules() === '', pd.specRules() || 'nothing installed');
    pd.pointerdown('item?id=1');
    check('pointerdown still warms an ordinary link', pd.specRules().includes('https://site.test/item?id=1'));

    // ---- 4.2.0: lists re-checked against Jev ----------------------------------
    const warms = href => { pd.head.children.length = 0; pd.pointerdown(href); return pd.specRules() !== ''; };
    check('refused: /notifications/mark-all-read', !warms('/notifications/mark-all-read'));
    check('refused: /basket/add and /wishlist/add/12', !warms('/basket/add?item=12') && !warms('/wishlist/add/12'));
    check('refused: ?do=vote and ?action=trash as query values', !warms('/forum.php?do=vote&id=3') && !warms('/post.php?action=trash&post=9'));
    check('refused: /delete-account and /logout.php', !warms('/delete-account') && !warms('/logout.php'));
    check('warmed: Wikipedia ?action=history', warms('/w/index.php?title=X&action=history'));
    check('warmed: an article slug that starts with a verb', warms('/2025/06/like-a-pro-guide'));
    check('warmed: a plural index page', warms('/reports/annual-2025'));

    // ---- 4.1.0: learned origins and viewport matching ----------------------
    const orig = build({ gm: { 'tm-qs-origins::https://site.test': JSON.stringify({
        origins: [{ o: 'https://cdn.other.test', c: false, n: 1, t: 100, u: Date.now() }] }) } });
    await wait(20);
    check('a once-seen critical origin is preconnected',
        orig.head.children.some(c => c.rel === 'preconnect' && c.href === 'https://cdn.other.test'));

    const lcpSeed = rec => ({ 'tm-qs-lcp::https://site.test': JSON.stringify({
        '/article': Object.assign({ url: 'https://cdn.site.test/hero.jpg', at: Date.now(), seen: 2 }, rec) }) });
    const hasPreload = h => h.head.children.some(c => c.rel === 'preload');

    const zoomSrcset = build({ gm: lcpSeed({ vw: '1280x1', srcset: 'hero-1x.jpg 1x, hero-2x.jpg 2x' }) });
    await wait(20);
    check('4.0.x record with srcset survives a DPR change', hasPreload(zoomSrcset));

    const zoomPlain = build({ gm: lcpSeed({ vw: '1280x1' }) });
    await wait(20);
    check('src-only record is still tied to its DPR', !hasPreload(zoomPlain));

    const nudged = build({ gm: lcpSeed({ vw: 1280, dpr: 2 }), viewport: { width: 1350, dpr: 2 } });
    await wait(20);
    check('new-format record matches its width bucket', hasPreload(nudged));

    check('new records store width bucket and DPR separately',
        lcpOf(a)['/article'] && lcpOf(a)['/article'].vw === 1280 && lcpOf(a)['/article'].dpr === 2);

    // ---- 4.1.0: Trusted Types (YouTube) -----------------------------------
    const tt = build({ trustedTypesEnforced: true });
    tt.domReady();
    await wait(20);
    check('rules install under Trusted Types enforcement', Boolean(tt.blanketRules()));
    tt.head.children.length = 0;
    tt.pointerdown('/item?id=7');
    check('pointerdown warms under Trusted Types enforcement', tt.specRules().includes('/item?id=7'));

    // ---- 4.1.0: target="" and target="_self" stay in this tab -------------
    check('blanket excludes only targets that leave the tab',
        blText.includes("a[target]:not([target='']):not([target='_self' i])"));
    const self = build({ pathname: '/news' });
    self.domReady();
    await wait(20);
    self.head.children.length = 0;
    self.pointerdown('/weather', { target: '_self' });
    check('pointerdown warms a target="_self" link', self.specRules().includes('/weather'));
    self.head.children.length = 0;
    self.pointerdown('/elsewhere', { target: '_blank' });
    check('pointerdown prerenders a target="_blank" link into the new tab',
        self.specRules().includes('"prerender":[{"urls":["https://site.test/elsewhere"],"eagerness":"immediate","target_hint":"_blank"}]'),
        self.specRules() || 'nothing installed');
    self.head.children.length = 0;
    self.pointerdown('/named', { target: 'preview' });
    check('pointerdown skips a link into a named window', self.specRules() === '');

    const oldTab = build({ pathname: '/news', chromeVersion: 137 });
    oldTab.domReady();
    await wait(20);
    const oldPrerender = JSON.stringify(oldTab.blanketRules()?.prerender || []);
    oldTab.head.children.length = 0;
    oldTab.pointerdown('/elsewhere', { target: '_blank' });
    check('before Chrome 138, target="_blank" is left alone', oldTab.specRules() === '');
    check('before Chrome 138, blanket prerender excludes new-tab links',
        oldPrerender.includes("a[target]:not([target='']):not([target='_self' i])")
        && !oldPrerender.includes("not([target='_blank' i])"));

    const blNewTab = JSON.stringify(bl.blanketRules() || {});
    check('Chrome 138+: blanket prerender admits new-tab links, prefetch still skips them',
        JSON.stringify(bl.blanketRules()?.prerender?.[0] || {}).includes(":not([target='_blank' i])")
        && !JSON.stringify(bl.blanketRules()?.prefetch?.[0] || {}).includes(":not([target='_blank' i])"),
        blNewTab.length + ' chars');

    // ---- 4.1.0: SPA detection ---------------------------------------------
    const spaKey = 'tm-qs-spa::https://site.test';
    const sp = build();
    sp.domReady();
    sp.load();
    await wait(20);
    check('blanket rules present before any soft navigation', Boolean(sp.blanketRules()));
    sp.navigateTo('/watch', { click: true });
    await wait(40);
    check('click-driven pushState marks the origin as an SPA', sp.store.has(spaKey));
    check('blanket rules are withdrawn the moment the SPA shows itself', !sp.blanketRules());

    const rs = build();
    rs.load();
    await wait(20);
    rs.navigateTo('/canonical', { push: false, click: true });
    const scroll = build();
    scroll.load();
    await wait(20);
    scroll.navigateTo('/scrolled-to', { push: true });
    await wait(40);
    check('replaceState is not an SPA signal', !rs.store.has(spaKey));
    check('a push with no link click is not an SPA signal', !scroll.store.has(spaKey));

    const legacySpa = build({ navigationApi: false });
    legacySpa.load();
    await wait(20);
    legacySpa.navigateTo('/watch', { click: true });
    await wait(40);
    check('pushState fallback also detects the SPA', legacySpa.store.has(spaKey));

    const scrollAfterAnchor = build({ pathname: '/blog/' });
    scrollAfterAnchor.load();
    await wait(20);
    scrollAfterAnchor.navigateTo('/blog/page/2/', { click: true, clickHref: '/blog/#comments' });
    await wait(40);
    check('a push to a URL other than the clicked link is not an SPA signal (infinite scroll)',
        !scrollAfterAnchor.store.has(spaKey));

    const known = build({ gm: Object.assign({ [spaKey]: JSON.stringify({ at: Date.now() }) }, seeded({ '/next': 5 })) });
    known.domReady();
    known.load();
    await wait(80);
    check('known SPA: no blanket rules, no prediction', known.specRules() === '', known.specRules() || 'nothing installed');
    known.pointerdown('/item?id=1');
    check('known SPA: pointerdown does not warm', known.specRules() === '');
    known.menu.get('Quicksilver: Status')();
    check('status explains why speculation is off on an SPA',
        (known.alerts[0] || '').includes('answers link clicks in-page'));

    // ---- 4.1.0: measured outcomes -----------------------------------------
    const statsOf = h => JSON.parse(h.store.get('tm-qs-stats::https://site.test') || '{}');
    const navOutcome = entry => build({ referrer: 'https://site.test/list', navEntries: [Object.assign({ type: 'navigate' }, entry)] });

    const hitPre = navOutcome({ activationStart: 140, deliveryType: '' });
    const hitPf = navOutcome({ activationStart: 0, deliveryType: 'navigational-prefetch' });
    const miss = build({ referrer: 'https://site.test/list', navEntries: [{ type: 'navigate', activationStart: 0, deliveryType: '' }],
        gm: { 'tm-qs-pending-nav::https://site.test': JSON.stringify({ href: 'https://site.test/article', at: Date.now() }) } });
    const unclicked = navOutcome({ activationStart: 0, deliveryType: '' });
    await wait(20);
    check('prerendered arrival counts as a prerender hit', (statsOf(hitPre).nav || {}).prerender === 1);
    check('prefetched arrival counts as a prefetch hit', (statsOf(hitPf).nav || {}).prefetch === 1);
    check('arrival from a clicked eligible link counts as a miss', (statsOf(miss).nav || {}).miss === 1);
    check('the click marker is consumed', !miss.store.has('tm-qs-pending-nav::https://site.test'));
    check('arrival with no eligible click (new tab, form, excluded link) is not scored',
        !unclicked.store.has('tm-qs-stats::https://site.test'));

    const clicker = build({ pathname: '/list' });
    clicker.load();
    await wait(20);
    const clickOn = (h, href, attrs = {}) => {
        const link = { href: new URL(href, h.sandbox.location.href).href,
            getAttribute: k => (k === 'href' ? href : (k in attrs ? attrs[k] : null)), rel: '', download: false };
        const target = Object.assign(Object.create(h.sandbox.Element.prototype), { closest: () => link });
        h.fireDoc('click', { button: 0, target });
    };
    clickOn(clicker, '/item?id=3', { target: 'preview' });
    check('a link into a named window leaves no marker', !clicker.store.has('tm-qs-pending-nav::https://site.test'));
    clickOn(clicker, '/item?id=4', { target: '_blank' });
    check('a new-tab link leaves a marker (it is prerenderable now)',
        (clicker.store.get('tm-qs-pending-nav::https://site.test') || '').includes('/item?id=4'));
    clickOn(clicker, '/item?id=3');
    check('an eligible click leaves a marker for the next page',
        (clicker.store.get('tm-qs-pending-nav::https://site.test') || '').includes('https://site.test/item?id=3'));

    // ---- 4.2.0: pointerdown on every tier -----------------------------------
    const slow = build({ connection: SLOW, pathname: '/news' });
    slow.domReady();
    await wait(20);
    const slowRules = slow.blanketRules();
    check('slow link: blanket rules still install, pointerdown only',
        Boolean(slowRules) && slowRules.prefetch.every(r => r.eagerness === 'conservative') && !slowRules.prerender,
        JSON.stringify(slowRules && slowRules.prefetch.map(r => r.eagerness)));
    slow.head.children.length = 0;
    slow.pointerdown('/item?id=9');
    check('slow link: pointerdown prefetches, never prerenders',
        slow.specRules().includes('"prefetch":[{"urls":["https://site.test/item?id=9"]') && !slow.specRules().includes('prerender'));
    slow.head.children.length = 0;
    slow.pointerdown('/elsewhere', { target: '_blank' });
    check('slow link: a new-tab link is not warmed (prefetch cannot follow it)', slow.specRules() === '');
    slow.menu.get('Quicksilver: Status')();
    check('status says slow links speculate on pointerdown', (slow.alerts[0] || '').includes('on pointerdown only'));

    const modPd = build({ connection: MODERATE, pathname: '/news' });
    modPd.domReady();
    await wait(20);
    modPd.head.children.length = 0;
    modPd.pointerdown('/item?id=5');
    check('3g: pointerdown prerenders', modPd.specRules().includes('"prerender":[{"urls":["https://site.test/item?id=5"]'));

    const slowStats = build({ connection: SLOW, referrer: 'https://site.test/list',
        navEntries: [{ type: 'navigate', activationStart: 0, deliveryType: 'navigational-prefetch' }] });
    await wait(20);
    check('slow link: outcomes are counted', (statsOf(slowStats).nav || {}).prefetch === 1);

    // ---- 4.2.0: wider prediction budgets ------------------------------------
    const three = seeded({ '/a': 4, '/b': 3, '/c': 1 });
    const pFast = build({ gm: three });
    pFast.load();
    await wait(80);
    const pFastRule = pFast.specRules();
    check('fast: two strong predictions prerender, the third prefetches',
        pFastRule.includes('"prerender":[{"urls":["https://site.test/a","https://site.test/b"]')
        && pFastRule.includes('"prefetch":[{"urls":["https://site.test/c"]'),
        (pFastRule.match(/\{"prerender":\[\{"urls":[^}]*\}\][^}]*\}/) || [''])[0].slice(0, 160));
    const pMod = build({ gm: three, connection: MODERATE });
    pMod.load();
    await wait(80);
    const pModRule = pMod.specRules();
    check('3g: one prediction prerenders, the rest prefetch',
        pModRule.includes('"prerender":[{"urls":["https://site.test/a"]')
        && pModRule.includes('"prefetch":[{"urls":["https://site.test/b","https://site.test/c"]'));

    // ---- 4.2.0 review fixes ---------------------------------------------------
    const rv = build({ pathname: '/home' });
    rv.domReady();
    await wait(20);
    const rvRules = JSON.stringify(rv.blanketRules() || {});
    const rvWarms = (href, attrs) => { rv.head.children.length = 0; rv.pointerdown(href, attrs); return rv.specRules() !== ''; };
    check('refused regardless of case: /Account/LogOff, /Cart/Remove/5, /Orders/Cancel/7',
        !rvWarms('/Account/LogOff') && !rvWarms('/Cart/Remove/5') && !rvWarms('/Orders/Cancel/7'));
    check('refused: the logoff family (/owa/logoff.owa, /sap/public/bc/icf/logoff)',
        !rvWarms('/owa/logoff.owa') && !rvWarms('/sap/public/bc/icf/logoff'));
    check('refused: read-on-view pages (/message/unread/, /notifications)',
        !rvWarms('/message/unread/') && !rvWarms('/notifications'));
    check('refused: compound and camelCase actions (/remove-from-cart/5, /cancelOrder, /DeleteItem)',
        !rvWarms('/remove-from-cart/5') && !rvWarms('/vote-up-comment/5') && !rvWarms('/cancelOrder') && !rvWarms('/DeleteItem?id=3'));
    check('warmed: WordPress-style slug with trailing slash', rvWarms('/blog/like-a-pro-guide/'));
    check('refused: a bare <a download>', !rvWarms('/files/export', { download: '' }));
    check('hover rules exclude mixed-case paths via case-insensitive selectors',
        rvRules.includes("a[href*='/account' i]") && rvRules.includes("a[href*='/logoff' i]") && !rvRules.includes('/*/'));

    const unreadPrediction = build({ gm: seeded({ '/message/unread/': 5 }) });
    unreadPrediction.load();
    await wait(80);
    check('prediction refuses a read-on-view page', !unreadPrediction.specRules().includes('unread'));

    const now = Date.now();
    const full = build({ pathname: '/fresh', referrer: 'https://site.test/list', gm: { 'tm-qs-transitions::https://site.test': JSON.stringify({
        '/list': { t: { '/a': { n: 3, at: now - 1000 }, '/b': { n: 3, at: now - 1000 }, '/c': { n: 3, at: now - 1000 }, '/d': { n: 3, at: now - 1000 } }, at: now - 1000 } }) } });
    await wait(20);
    const fullTargets = (transOf(full)['/list'] || {}).t || {};
    check('a new destination is learned even when four are already stored',
        Boolean(fullTargets['/fresh']) && Object.keys(fullTargets).length === 4, Object.keys(fullTargets).join(','));

    const staleTargets = build({ gm: { 'tm-qs-transitions::https://site.test': JSON.stringify({
        '/article': { t: { '/old': { n: 9, at: now - 15 * 24 * 3600 * 1000 }, '/new': { n: 2, at: now } }, at: now } }) } });
    staleTargets.load();
    await wait(80);
    check('targets age out on their own, even while the source stays active',
        !staleTargets.specRules().includes('/old') && staleTargets.specRules().includes('/new'));

    const legacyCounts = build({ gm: seeded({ '/next': 3 }) });
    legacyCounts.load();
    await wait(80);
    check('4.1.x bare-count targets still predict', legacyCounts.specRules().includes('/next'));

    const textWins = build();
    textWins.domReady();
    await wait(20);
    textWins.emitLcp({ url: 'https://cdn.site.test/logo.png', startTime: 300, element: makeEl('img') });
    textWins.emitLcp({ url: '', startTime: 900, element: makeEl('h1') });
    textWins.load();
    const picture = build({ pathname: '/gallery' });
    picture.domReady();
    await wait(20);
    const pictureImg = makeEl('img');
    pictureImg.parentElement = { tagName: 'PICTURE' };
    pictureImg.setAttribute('srcset', 'hero-800.jpg 800w, hero-1600.jpg 1600w');
    picture.emitLcp({ url: 'https://cdn.site.test/hero-1600.avif', startTime: 700, element: pictureImg });
    picture.load();
    const activated = build({ pathname: '/landed', navEntries: [{ type: 'navigate', activationStart: 400 }] });
    activated.domReady();
    await wait(20);
    activated.emitLcp({ url: 'https://cdn.site.test/h.jpg', startTime: 1000, element: makeEl('img') });
    activated.load();
    await wait(3400);
    check('a text LCP that outgrows an earlier logo leaves no hero record', !lcpOf(textWins)['/article']);
    const pictureRec = lcpOf(picture)['/gallery'];
    check('a <picture> hero records the exact URL and no fallback srcset',
        Boolean(pictureRec) && pictureRec.url.endsWith('.avif') && !pictureRec.srcset);
    const vitalsOf = h => JSON.parse(h.store.get('tm-qs-vitals::https://site.test') || '{}');
    check('LCP samples are measured from activation', (vitalsOf(activated).lcp || [])[0] === 600,
        JSON.stringify(vitalsOf(activated).lcp));

    const csp = build({ pathname: '/home' });
    csp.domReady();
    await wait(20);
    csp.fireDoc('securitypolicyviolation', { disposition: 'report', violatedDirective: 'script-src-elem', blockedURI: 'inline' });
    csp.fireDoc('securitypolicyviolation', { disposition: 'enforce', violatedDirective: 'script-src-elem', blockedURI: 'https://ads.test/x.js' });
    csp.head.children.length = 0;
    csp.pointerdown('/item?id=1');
    check('report-only or unrelated script-src violations keep speculation rules',
        csp.specRules().includes('prerender'), csp.specRules() || 'no rules');
    csp.fireDoc('securitypolicyviolation', { disposition: 'enforce', violatedDirective: 'script-src-elem', blockedURI: 'inline' });
    csp.head.children.length = 0;
    csp.pointerdown('/item?id=2');
    check('an enforced inline block still falls back to <link rel=prefetch>',
        csp.head.children.some(c => c.rel === 'prefetch' && String(c.href).includes('/item?id=2')));

    const fonts = build();
    const fontRule = family => Object.assign(Object.create(fonts.sandbox.CSSFontFaceRule.prototype), {
        style: { fontDisplay: '', getPropertyValue: k => (k === 'font-family' ? family : '') } });
    const iconRule = fontRule('"FontAwesome"');
    const textRule = fontRule('"Inter"');
    fonts.sandbox.document.styleSheets.push({ cssRules: [iconRule, textRule] });
    fonts.domReady();
    await wait(20);
    check('font-display is set on text fonts but not on icon fonts',
        textRule.style.fontDisplay === 'swap' && iconRule.style.fontDisplay === '');

    check('the script declares @noframes', /\/\/ @noframes/.test(fs.readFileSync(path.join(__dirname, '..', 'Quicksilver.js'), 'utf8')));

    const old = build({ chromeVersion: 140 });
    old.domReady();
    await wait(20);
    check('before Chrome 143, same-origin prefetch stays moderate', old.blanketRules()?.prefetch[0].eagerness === 'moderate');
    const crossText = JSON.stringify(bl.blanketRules()?.prefetch[1] || {});
    check('cross-origin rule excludes action paths on any host', crossText.includes("a[href*='/vote' i]"));
    check('all-sites totals are kept alongside', JSON.parse(miss.store.get('tm-qs-stats-all') || '{}').nav?.miss === 1);

    const typed = build({ navEntries: [{ type: 'navigate' }] });
    const spaNav = build({ referrer: 'https://site.test/list', navEntries: [{ type: 'navigate' }],
        gm: { [spaKey]: JSON.stringify({ at: Date.now() }) } });
    await wait(20);
    check('typed URLs and known-SPA origins are not counted',
        !typed.store.has('tm-qs-stats::https://site.test') && !spaNav.store.has('tm-qs-stats::https://site.test'));

    const hero = build({ gm: lcpSeed({ vw: 1280, dpr: 2 }) });
    hero.domReady();
    await wait(20);
    hero.emitLcp({ url: 'https://cdn.site.test/hero.jpg', startTime: 700, element: makeEl('img') });
    hero.load();
    const heroWrong = build({ gm: lcpSeed({ vw: 1280, dpr: 2 }) });
    heroWrong.domReady();
    await wait(20);
    heroWrong.emitLcp({ url: 'https://cdn.site.test/other.jpg', startTime: 700, element: makeEl('img') });
    heroWrong.load();
    await wait(3400);
    check('hero preload that painted counts as a hit', (statsOf(hero).hero || {}).hit === 1);
    check('hero preload of the wrong image counts as a miss', (statsOf(heroWrong).hero || {}).miss === 1);

    const rep = build({ gm: {
        'tm-qs-stats::https://site.test': JSON.stringify({ nav: { prerender: 3, prefetch: 5, miss: 2 }, hero: { hit: 4, miss: 1 } }),
        'tm-qs-stats-all': JSON.stringify({ nav: { prerender: 0, prefetch: 0, miss: 12 } })
    } });
    await wait(20);
    rep.menu.get('Quicksilver: Status')();
    const repText = rep.alerts[0] || '';
    check('status reports the site hit rate', repText.includes('80% hit (8 of 10) — prerendered 3, prefetched 5, missed 2'),
        (repText.split('\n').find(l => l.includes('% hit')) || '').trim());
    check('status reports hero accuracy', repText.includes('this site: 4 of 5'));
    check('status flags speculation that never lands', repText.includes('"Preload pages"'));

    const bad = results.filter(r => !r[1]).length;
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
    process.exit(bad ? 1 : 0);
})();
