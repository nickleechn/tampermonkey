#!/usr/bin/env node
// Real-browser checks for Quicksilver.js, driven over the Chrome DevTools
// Protocol with nothing but Node 22's built-in fetch and WebSocket.
//
//   node test/quicksilver-chrome/run.js
//
// Chrome binary: $QS_CHROME, else Google Chrome on macOS, else google-chrome /
// chromium on PATH. The headless suite stubs the DOM and so cannot see what
// Chrome does with the rules this script writes; this one can. It asserts on
// Chrome's own reports (the CDP Preload domain), on navigation timing in the
// page that was opened, and on the fixture server's request log.
//
// Each check gets its own fixture server, and so its own origin: the script's
// learning lives in per-origin localStorage here (no GM_* APIs), and one
// check's SPA flag must not switch speculation off for the next.
//
// Prerender cannot be *activated* while DevTools is attached (Chrome reports
// PrerenderingDisabledByDevTools), so prerender checks assert that Chrome
// accepted the rule and made the attempt; prefetch checks go all the way to a
// navigation served from the prefetch.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
// $QS_SCRIPT runs another build, e.g. an older release, to see what it fails.
const SCRIPT = fs.readFileSync(process.env.QS_SCRIPT || path.join(ROOT, 'Quicksilver.js'), 'utf8');
const VERSION = (SCRIPT.match(/@version\s+(\S+)/) || [])[1];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra) => {
    results.push([name, ok]);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function findChrome() {
    if (process.env.QS_CHROME) return process.env.QS_CHROME;
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(mac)) return mac;
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try {
            return execFileSync('which', [name], { encoding: 'utf8' }).trim();
        } catch (_) {}
    }
    throw new Error('No Chrome found; set QS_CHROME to its binary.');
}

async function launchChrome() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-chrome-'));
    const args = [
        '--headless=new', '--remote-debugging-port=0', '--no-first-run',
        '--no-default-browser-check', '--disable-gpu', `--user-data-dir=${profile}`,
        '--window-size=1280,1000', 'about:blank'
    ];
    if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
    const proc = spawn(findChrome(), args, { stdio: 'ignore' });

    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

    const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = msg => {
        const data = JSON.parse(msg.data);
        if (data.id && pending.has(data.id)) {
            const { resolve, reject } = pending.get(data.id);
            pending.delete(data.id);
            if (data.error) reject(new Error(data.error.message));
            else resolve(data.result || {});
            return;
        }
        for (const fn of listeners.get(data.sessionId || '') || []) fn(data.method, data.params || {});
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

    return {
        browser: version.Browser,
        async newPage() {
            const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
            const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
            const events = [];
            listeners.set(sessionId, [(method, params) => events.push({ method, params })]);
            const page = {
                events,
                send: (method, params) => send(method, params, sessionId),
                async eval(expression) {
                    const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
                    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' in ' + expression);
                    return r.result.value;
                },
                async goto(url) {
                    const loaded = page.waitForEvent('Page.loadEventFired', 15000);
                    await page.send('Page.navigate', { url });
                    await loaded;
                },
                // Only events after the call, unless `past` (status reports
                // often land while the test is still hovering or pressing).
                async waitForEvent(method, timeout = 10000, pred = () => true, past = false) {
                    const deadline = Date.now() + timeout;
                    let seen = past ? 0 : events.length;
                    while (Date.now() < deadline) {
                        for (; seen < events.length; seen++) {
                            if (events[seen].method === method && pred(events[seen].params)) return events[seen].params;
                        }
                        await sleep(25);
                    }
                    throw new Error('timed out waiting for ' + method);
                },
                async center(selector) {
                    return page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                },
                async hover(selector, ms = 400) {
                    const { x, y } = await page.center(selector);
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
                    await sleep(ms);
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 990 });
                },
                async click(selector) {
                    const { x, y } = await page.center(selector);
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
                    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                },
                // A pointerdown with no click after it: the moment Part 4 warms.
                pointerdown: selector => page.eval(`document.querySelector(${JSON.stringify(selector)})
                    .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }))`),
                ruleSets: () => events.filter(e => e.method === 'Preload.ruleSetUpdated').map(e => e.params.ruleSet),
                attempts: () => events
                    .filter(e => e.method === 'Preload.prefetchStatusUpdated' || e.method === 'Preload.prerenderStatusUpdated')
                    .map(e => ({ url: e.params.key.url, action: e.params.key.action, status: e.params.status,
                        reason: e.params.prefetchStatus || e.params.prerenderStatus || '' })),
                close: () => send('Target.closeTarget', { targetId })
            };
            await page.send('Page.enable');
            await page.send('Runtime.enable');
            await page.send('Preload.enable');
            // No GM_* APIs: the script falls back to per-origin localStorage.
            await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT });
            return page;
        },
        close() {
            try { ws.close(); } catch (_) {}
            proc.kill();
            setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300);
        }
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Chrome ignores low-entropy images as LCP candidates, so a flat-colour hero
// would never be learned. Seeded noise keeps runs reproducible.
function noisePng(w, h, seed) {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    const crc = buf => {
        let x = 0xffffffff;
        for (const v of buf) x = table[(x ^ v) & 255] ^ (x >>> 8);
        return (x ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const stride = w * 3 + 1;
    const raw = Buffer.alloc(stride * h);
    let s = seed >>> 0 || 1;
    for (let i = 0; i < raw.length; i++) {
        if (i % stride === 0) continue;
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        raw[i] = s & 255;
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const HERO = noisePng(640, 400, 7);
const ROUTE_HERO = noisePng(640, 400, 11);

const doc = (body, title = 'fixture') => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title>
<style>body{font:16px sans-serif;margin:20px} a{display:inline-block;margin:6px;padding:4px}</style></head>
<body>${body}</body></html>`;

const ORDINARY_LINKS = `<p>Ordinary links</p>
<a id=a1 href="/article-1">Article one</a>
<a id=a2 href="/article-2">Article two</a>
<a id=a3 href="/article-3">Article three</a>
<a id=blank href="/article-4" target="_blank">New tab</a>
<a id=next rel=next href="/page-2">Next</a>`;

const SENSITIVE = [
    ['logout', '/logout'],
    ['logoff', '/Account/LogOff'],
    ['vote', '/vote?id=1&how=up&auth=abc123'],
    ['cart', '/remove-from-cart/5'],
    ['download', '/files/report', ' download']
];
const SENSITIVE_LINKS = SENSITIVE.map(([id, href, extra]) => `<a id=${id} href="${href}"${extra || ''}>${id}</a>`).join('\n');

// A client-side router: answers clicks on [data-route] links in-page.
// data-delay holds the push back, as a router waiting on its data does.
const ROUTER_JS = `
document.addEventListener('click', e => {
    const link = e.target.closest('a[data-route]');
    if (!link) return;
    e.preventDefault();
    const delay = Number(link.dataset.delay) || 0;
    setTimeout(() => {
        history.pushState({}, '', link.getAttribute('href'));
        const root = document.getElementById('root');
        root.innerHTML = link.dataset.hero
            ? '<h2>Route title</h2><img src="' + link.dataset.hero + '" width=640 height=400>'
            : '<h1 style="font-size:64px">A route headline, big enough to paint</h1>';
    }, delay);
});`;

function startServer(routes, headers = {}) {
    const log = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        log.push({ path: url.pathname + url.search, purpose: req.headers['sec-purpose'] || '' });
        const route = routes[url.pathname];
        if (url.pathname === '/router.js') {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            return res.end(ROUTER_JS);
        }
        if (url.pathname === '/hero.png' || url.pathname === '/route-hero.png') {
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=600' });
            return res.end(url.pathname === '/hero.png' ? HERO : ROUTE_HERO);
        }
        res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, headers));
        res.end(route || doc(`<p>Page ${url.pathname}</p><a href="/">home</a>`));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const origin = `http://127.0.0.1:${server.address().port}`;
        resolve({ origin, log, hits: p => log.filter(r => r.path === p), close: () => server.close() });
    }));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function rulesParse(chrome) {
    const srv = await startServer({ '/': doc(ORDINARY_LINKS + '<a href="https://example.invalid/x">offsite</a>') });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        await page.pointerdown('#a2');
        await sleep(200);
        await page.pointerdown('#blank');
        await sleep(500);
        const sets = page.ruleSets();
        const bad = sets.filter(s => s.errorType);
        check('every rule set the script writes parses in Chrome', sets.length >= 3 && bad.length === 0,
            `${sets.length} rule sets` + (bad.length ? `; ${bad[0].errorType}: ${bad[0].errorMessage}` : ''));
        const blank = sets.find(s => s.sourceText.includes('"target_hint":"_blank"'));
        check('new-tab link warmed with target_hint _blank', Boolean(blank) && !blank.errorType);
    } finally {
        await page.close();
        srv.close();
    }
}

async function sensitiveRefused(chrome) {
    const srv = await startServer({ '/': doc(SENSITIVE_LINKS) });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        for (const [id] of SENSITIVE) {
            await page.hover('#' + id, 350);
            await page.pointerdown('#' + id);
        }
        await sleep(800);
        const fetched = srv.log.filter(r => r.path !== '/' && r.path !== '/favicon.ico');
        const attempted = page.attempts().filter(a => !a.url.endsWith('/'));
        check('action links: no request after hover and pointerdown', fetched.length === 0,
            fetched.map(r => r.path).join(', ') || SENSITIVE.length + ' links');
        check('action links: Chrome made no preload attempt', attempted.length === 0,
            attempted.map(a => a.action + ' ' + a.url).join(', '));
    } finally {
        await page.close();
        srv.close();
    }
}

async function hoverServesNavigation(chrome) {
    const srv = await startServer({ '/': doc(ORDINARY_LINKS) });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        await page.hover('#a1', 600);
        let ready = null;
        try {
            ready = await page.waitForEvent('Preload.prefetchStatusUpdated', 5000,
                p => p.key.url.endsWith('/article-1') && p.status === 'Ready', true);
        } catch (_) {}
        check('hover prefetches an ordinary link', Boolean(ready),
            srv.hits('/article-1').map(r => 'Sec-Purpose: ' + r.purpose).join(', ') || 'no request');

        const loaded = page.waitForEvent('Page.loadEventFired', 10000);
        await page.click('#a1');
        await loaded;
        const nav = await page.eval(`(() => { const n = performance.getEntriesByType('navigation')[0];
            return { path: location.pathname, deliveryType: n.deliveryType }; })()`);
        check('click lands on the prefetched document', nav.path === '/article-1'
            && nav.deliveryType === 'navigational-prefetch', JSON.stringify(nav));
        check('the click made no second request', srv.hits('/article-1').length === 1,
            srv.hits('/article-1').length + ' request(s)');
    } finally {
        await page.close();
        srv.close();
    }
}

async function pointerdownPrerenders(chrome) {
    const srv = await startServer({ '/': doc(ORDINARY_LINKS) });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        await page.pointerdown('#a3');
        let attempt = null;
        try {
            attempt = await page.waitForEvent('Preload.prerenderStatusUpdated', 4000, p => p.key.url.endsWith('/article-3'), true);
        } catch (_) {}
        check('pointerdown makes a prerender attempt', Boolean(attempt),
            attempt ? attempt.status + ' ' + (attempt.prerenderStatus || '') : 'none');
    } finally {
        await page.close();
        srv.close();
    }
}

async function trustedTypes(chrome) {
    const srv = await startServer({ '/': doc(ORDINARY_LINKS) },
        { 'content-security-policy': "require-trusted-types-for 'script'" });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        await page.pointerdown('#a2');
        await sleep(500);
        const sets = page.ruleSets();
        check('Trusted Types page still gets its rules', sets.length >= 2 && sets.every(s => !s.errorType),
            sets.length + ' rule sets');
    } finally {
        await page.close();
        srv.close();
    }
}

async function strictCspFallback(chrome) {
    const srv = await startServer({ '/': doc(ORDINARY_LINKS) }, { 'content-security-policy': "script-src 'self'" });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        await page.pointerdown('#a3');
        await sleep(800);
        const hits = srv.hits('/article-3');
        check('strict CSP: pointerdown falls back to <link rel=prefetch>',
            hits.length === 1 && /prefetch/.test(hits[0].purpose),
            hits.map(r => 'Sec-Purpose: ' + r.purpose).join(', ') || 'no request');
    } finally {
        await page.close();
        srv.close();
    }
}

const spaState = page => page.eval(`({
    flag: localStorage.getItem('tm-qs-spa'),
    blanket: [...document.querySelectorAll('script[type=speculationrules]')].some(s => s.textContent.includes('"where"'))
})`);

async function spaDetection(chrome) {
    const app = doc(`<a id=go data-route href="/app/inbox-list">Go</a><div id=root></div><script src="/router.js"></script>`);
    const srv = await startServer({ '/': app });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        await sleep(300);
        const before = await spaState(page);
        await page.click('#go');
        await sleep(600);
        const after = await spaState(page);
        check('SPA router detected and link speculation withdrawn',
            before.blanket && !before.flag && Boolean(after.flag) && !after.blanket, JSON.stringify({ before, after }));
    } finally {
        await page.close();
        srv.close();
    }
}

// New in 4.3.0: a router that pushes only after the 5 s click window.
async function slowRouterSoftNav(chrome) {
    const app = doc(`<a id=go data-route data-delay=5600 href="/app/slow-route">Go</a><div id=root></div><script src="/router.js"></script>`);
    const srv = await startServer({ '/': app });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        const soft = await page.eval(`PerformanceObserver.supportedEntryTypes.includes('soft-navigation')`);
        if (!soft) {
            check('slow router marked as SPA via Soft Navigations', true, 'skipped: this Chrome has no Soft Navigations');
            return;
        }
        await sleep(300);
        await page.click('#go');
        await sleep(6600);
        const state = await spaState(page);
        const entries = await page.eval(`performance.getEntriesByType('soft-navigation').map(e => e.name)`);
        check('slow router (push after 5.6 s) marked as SPA via Soft Navigations', Boolean(state.flag) && !state.blanket,
            JSON.stringify({ state, softNavigations: entries }));
    } finally {
        await page.close();
        srv.close();
    }
}

const lcpStore = page => page.eval(`JSON.parse(localStorage.getItem('tm-qs-lcp') || '{}')`);

// New in 4.3.0: a client-side route's hero is learned from
// interaction-contentful-paint, then preloaded when the router goes there.
async function softRouteHero(chrome) {
    const app = doc(`<p>App shell</p><a id=go data-route data-hero="/route-hero.png" href="/app/photo">Photo</a>
        <button id=modal onclick="document.getElementById('root').insertAdjacentHTML('beforeend','<img src=/hero.png width=640 height=400>')">modal</button>
        <div id=root></div><script src="/router.js"></script>`);
    const srv = await startServer({ '/': app });
    const page = await chrome.newPage();
    try {
        await page.goto(srv.origin + '/');
        if (!await page.eval(`PerformanceObserver.supportedEntryTypes.includes('interaction-contentful-paint')`)) {
            check('client-side route hero learned and preloaded', true, 'skipped: this Chrome has no Soft Navigations');
            return;
        }
        const seenAfter = [];
        for (let visit = 1; visit <= 3; visit++) {
            if (visit > 1) await page.goto(srv.origin + '/');
            await sleep(400);
            await page.click('#go');
            await sleep(400);
            if (visit === 3) {
                const preloaded = await page.eval(`[...document.querySelectorAll('link[rel=preload][as=image]')].map(l => l.href)`);
                check('client-side route: learned hero preloaded on the third visit',
                    preloaded.some(h => h.endsWith('/route-hero.png')), JSON.stringify(preloaded));
                break;
            }
            // A later click that paints a bigger image is not the route's hero.
            await page.click('#modal');
            await sleep(3600);
            const rec = (await lcpStore(page))['/app/photo'];
            seenAfter.push(rec ? rec.url.replace(srv.origin, '') + ' ×' + rec.seen : 'none');
        }
        check('client-side route: hero learned from the navigating interaction only',
            seenAfter[0] === '/route-hero.png ×1' && seenAfter[1] === '/route-hero.png ×2', seenAfter.join(', '));
    } finally {
        await page.close();
        srv.close();
    }
}

async function hardHero(chrome) {
    const srv = await startServer({ '/': doc(`<p>Story</p><img id=hero src="/hero.png" width=640 height=400>`) });
    const page = await chrome.newPage();
    try {
        for (let visit = 1; visit <= 2; visit++) {
            await page.goto(srv.origin + '/');
            await sleep(3500);
        }
        await page.goto(srv.origin + '/');
        const preloaded = await page.eval(`[...document.querySelectorAll('link[rel=preload][as=image]')].map(l => l.getAttribute('href'))`);
        check('page-load hero preloaded on the third visit', preloaded.some(h => h.endsWith('/hero.png')),
            JSON.stringify(preloaded) + ' ' + JSON.stringify(await lcpStore(page)));
    } finally {
        await page.close();
        srv.close();
    }
}

(async () => {
    const chrome = await launchChrome();
    console.log(`Quicksilver ${VERSION} on ${chrome.browser}\n`);
    try {
        for (const run of [rulesParse, sensitiveRefused, hoverServesNavigation, pointerdownPrerenders,
            trustedTypes, strictCspFallback, spaDetection, slowRouterSoftNav, softRouteHero, hardHero]) {
            try {
                await run(chrome);
            } catch (error) {
                check(run.name, false, 'threw: ' + error.message);
            }
        }
    } finally {
        chrome.close();
    }
    const bad = results.filter(r => !r[1]).length;
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : `\nALL ${results.length} CHECKS PASSED`);
    process.exit(bad ? 1 : 0);
})();
