// ==UserScript==
// @name         Quicksilver
// @namespace    http://tampermonkey.net/
// @version      4.1.0
// @description  Chrome-only: connection-tiered Speculation Rules prefetch/prerender, learned LCP preload + origin preconnect, navigation-transition prediction, media priority hints, and opt-in content-visibility. Avoids sensitive links and degrades gracefully on slow connections.
// @author       You
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.js
// @downloadURL  https://raw.githubusercontent.com/nickleechn/tampermonkey/main/Quicksilver.js
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// 4.1.0 — more aggressive where it costs bytes, stricter where it could cost
// correctness.
//
// The correctness fix first, because every aggressive change depends on it.
// The sensitive-link list only knew account-ish path words, and destructive
// GETs mostly aren't shaped like that. Hacker News votes, hides and flags are
// plain links (vote?id=…&how=up&auth=…), so hovering an upvote arrow for the
// 200ms 'moderate' window cast the vote. Links are now also refused when the
// href carries a CSRF-style token (auth=, token=, nonce, sid=, sesskey…),
// because a URL that embeds a per-user token is an action by construction,
// and the path list gained the common action verbs. Declarative patterns
// now match those words at any depth, not only as the first segment.
//
// Chrome 143 redefined 'eager' for document rules: 10ms of hover on desktop,
// a short viewport dwell on mobile, capped at two in flight. It is no longer
// "fetch every link", so the 40-link budget that guarded against that is gone
// and same-origin prefetch is eager on every non-slow tier. Rules install at
// DOMContentLoaded rather than after load, so early hovers count.
//
// Also: learned critical origins act on the second visit (a preconnect is
// cheap); a single observed transition earns a prefetch and two earn a
// prerender, now on the moderate tier too; cross-origin links prefetch on
// pointerdown; the hero record survives zoom and small resizes when the
// browser resolves srcset itself; the learned-origin budget is 6 on fast
// links; Parts 2–5 no longer run inside iframes. The hero preload keeps its
// two-sighting gate: that gate is what stops a homepage with a daily
// rotating hero from preloading yesterday's image at high priority.
//
// Found by testing on live sites rather than stubs:
// - YouTube enforces Trusted Types, so assigning the rules JSON to a
//   script's text threw, and every caller's try/catch swallowed it: no
//   speculation there at all, in any 4.x. A private pass-through policy now
//   carries it.
// - Which exposed the bigger YouTube problem: its router answers link clicks
//   in-page, so a speculated document is never used. One click-driven
//   pushState now marks an origin as an SPA and switches link speculation
//   and prediction off there (learning continues).
// - target="" (YouTube) and target="_self" (BBC's whole nav) stay in the
//   tab, and are no longer excluded as if they opened a new one.
// - Status reports measured outcomes, this site and all sites: how many
//   same-site link clicks landed on a prefetched or prerendered page versus
//   missed, and how often the hero preload was the image that painted.
//
// 4.0.1 — pointerdown warming no longer strands the first link it tries on a
// strict-CSP origin. The securitypolicyviolation that tells us inline
// speculation rules are blocked arrives after speculate() has already
// returned, so the link was recorded as warmed and every later press on it
// took the early return instead of the <link rel=prefetch> fallback. The warm
// record now tracks which mechanism was used, and the violation handler
// re-warms the link that was in flight rather than waiting for a press that
// may never come.
//
// 4.0.0 — two changes worth knowing about, both driven by measurement rather
// than taste.
//
// The optimistic fetch cache (Part 1, roughly half the script) is gone. It
// could only ever intercept requests the page made through window.fetch, and a
// real page makes almost none. instagram.com issues 42 resource requests:
// 31 parser-discovered <link>, 8 XMLHttpRequest, 2 CSS-initiated, 1 beacon —
// and 0 fetch. Nothing available to a userscript or an extension caches page
// subresources either; a Chrome extension's declarativeNetRequest rule that
// rewrites Cache-Control is applied to responses on their way *out* of the HTTP
// cache, not on their way in. The browser's own cache is the only thing
// positioned to do that job, and it already does it. Removing the wrapper also
// removes the only part of this script that could serve a site stale
// JavaScript.
//
// Learning no longer waits for pagehide. That was the one moment the LCP was
// certainly final, but a single-page app may never reach it — and if it does,
// location.pathname has usually moved on, so the record landed under the wrong
// route. The route is now captured with the observation and finalised when the
// LCP settles: shortly after load, on a client-side route change, or at
// pagehide, whichever comes first.
//
// New in 4.0.0: Part 9 learns which page you actually go to from here and
// prerenders it, which is aimed at app shells where "prefetch every link" has
// almost nothing to work with.

(function () {
    'use strict';

    const uaBrands = navigator.userAgentData && navigator.userAgentData.brands;
    const isChromium = (uaBrands && uaBrands.some(b => /Chromium|Google Chrome/i.test(b.brand)))
        || /Chrome\//.test(navigator.userAgent);
    if (!isChromium) return;

    const chromiumMajor = (() => {
        const brand = uaBrands && uaBrands.find(b => /Chromium|Google Chrome/i.test(b.brand));
        const version = brand ? brand.version : (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1];
        return Number.parseInt(version, 10) || 0;
    })();

    // =========================================================================
    // Shared helpers
    // =========================================================================

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;

    // Ad-heavy pages carry 20+ cross-origin frames. Running the learning,
    // media and rendering passes in each one charges their setup cost to the
    // very page load this script exists to speed up, for hints that are
    // near-useless inside a 300x250 frame.
    const isTopFrame = (() => {
        try {
            return window.top === window.self;
        } catch (_) {
            return false;
        }
    })();

    const conn = navigator.connection;
    const supportsSpeculationRules = Boolean(HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'));

    // Set once Part 6 has read storage, and flipped live by the SPA detector
    // there. Declared up here because Parts 2 and 4 read it and can run
    // before Part 6's constants exist when the script is injected late.
    let knownSpa = false;

    // YouTube and other Trusted Types origins reject a plain string assigned
    // to a script's text. Every caller wraps this in try/catch, so before
    // 4.1.0 that TypeError silently switched all speculation off there. The
    // pass-through policy never leaves this closure and only ever sees JSON
    // built by this script.
    let trustedScriptPolicy;

    function makeRulesScript(rules) {
        const script = document.createElement('script');
        script.type = 'speculationrules';
        const text = JSON.stringify(rules);

        try {
            script.textContent = text;
        } catch (error) {
            // Compared by name: the error comes from the page's realm, not
            // the userscript sandbox's, so instanceof would miss it.
            if (!error || error.name !== 'TypeError' || typeof trustedTypes === 'undefined') throw error;
            if (trustedScriptPolicy === undefined) {
                try {
                    trustedScriptPolicy = trustedTypes.createPolicy('quicksilver', { createScript: s => s });
                } catch (_) {
                    // A trusted-types directive that doesn't list our name.
                    trustedScriptPolicy = null;
                }
            }
            if (!trustedScriptPolicy) throw error;
            script.textContent = trustedScriptPolicy.createScript(text);
        }

        return script;
    }

    // The Prioritized Task Scheduling API exposes `scheduler` as a Window
    // global, not on navigator (navigator.scheduling is a different API with
    // isInputPending), so the previous navigator.scheduler probe never matched
    // and every caller silently fell through to requestIdleCallback.
    const taskScheduler = (window.scheduler && typeof window.scheduler.postTask === 'function')
        ? window.scheduler
        : null;

    // Bandwidth is zero-sum on a constrained link: every speculative byte we
    // spend is a byte the current page does not get. A single slow/not-slow
    // flag is too coarse for that trade-off, so features below read a tier.
    // Always call getConnectionTier() rather than caching it — effectiveType
    // changes as the radio state changes mid-page.
    const TIER_SLOW = 1;
    const TIER_MODERATE = 2;
    const TIER_FAST = 3;

    function getConnectionTier() {
        if (!conn) return TIER_FAST;
        if (conn.saveData) return TIER_SLOW;

        switch (conn.effectiveType) {
            case 'slow-2g':
            case '2g': return TIER_SLOW;
            case '3g': return TIER_MODERATE;
        }

        // effectiveType buckets coarsely and rounds up; rtt/downlink catch a
        // '4g' label sitting on a congested or high-latency link.
        if (Number.isFinite(conn.rtt) && conn.rtt > 0) {
            if (conn.rtt >= 600) return TIER_SLOW;
            if (conn.rtt >= 270) return TIER_MODERATE;
        }
        if (Number.isFinite(conn.downlink) && conn.downlink > 0 && conn.downlink < 0.7) return TIER_SLOW;

        return TIER_FAST;
    }

    function postBackgroundTask(fn, timeout) {
        const deadline = Number.isFinite(timeout) ? timeout : 3000;
        let ran = false;

        const run = () => {
            if (ran) return;
            ran = true;
            fn();
        };

        if (taskScheduler) {
            try {
                // postTask rejects if the task is aborted; nothing here passes a
                // signal, but an unhandled rejection would still surface.
                const task = taskScheduler.postTask(run, { priority: 'background' });
                if (task && typeof task.catch === 'function') task.catch(() => {});
                // Unlike requestIdleCallback's timeout, 'background' priority
                // carries no deadline at all — a busy page can starve it for as
                // long as it stays busy. Everything queued here is optional but
                // not indefinitely postponable (speculation rules, quota
                // pruning), so keep the guarantee the idle path always had.
                setTimeout(run, deadline);
                return;
            } catch (_) {}
        }

        if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: deadline });
        else setTimeout(run, Math.min(deadline, 750));
    }

    function runWhenDomReady(fn) {
        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    function runWhenLoadedIdle(fn) {
        const runIdle = () => postBackgroundTask(fn, 3000);

        if (document.readyState === 'complete') runIdle();
        else window.addEventListener('load', runIdle, { once: true });
    }

    function getClosestLinkTarget(target) {
        return target instanceof Element ? target.closest('a[href]') : null;
    }

    function toUrl(href, base) {
        try {
            return new URL(href, base || location.href);
        } catch (_) {
            return null;
        }
    }

    const DOWNLOAD_EXTENSIONS = [
        '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dmg', '.pkg',
        '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.iso', '.img', '.bin', '.deb', '.rpm', '.apk'
    ];
    const DOWNLOAD_REGEX = new RegExp('\\.(?:' + DOWNLOAD_EXTENSIONS.map(ext => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[?#]|$)', 'i');

    // Speculation issues a real, credentialed GET, and prerender runs the
    // page too, so any link whose GET *does* something must never match.
    // The account words were the original list; the action verbs are what
    // sites without CSRF-protected forms put in link paths (Hacker News:
    // vote, hide, flag, fave).
    const SENSITIVE_PATH_WORDS = [
        'logout', 'signout', 'log-out', 'sign-out', 'checkout', 'cart', 'account', 'admin',
        'order', 'payment', 'delete', 'auth', 'login', 'signin', 'sign-in', 'session',
        'destroy', 'revoke', 'unsubscribe', 'remove', 'transfer',
        'vote', 'upvote', 'downvote', 'unvote', 'hide', 'unhide', 'flag', 'unflag',
        'fave', 'unfave', 'favorite', 'favourite', 'like', 'unlike', 'follow', 'unfollow',
        'subscribe', 'report', 'markread', 'mark-read', 'mark_read', 'archive', 'trash', 'spam',
        'cancel', 'confirm', 'approve', 'reject', 'accept', 'decline', 'leave', 'reset',
        'enable', 'disable', 'toggle'
    ];
    // URL patterns cannot express a segment boundary, so these are prefix
    // matches at any depth and exclude more than the regex below does
    // (/author, /reports). That errs the right way, and Part 4 still warms
    // an over-excluded link on pointerdown using the precise regex.
    const SENSITIVE_PATH_PATTERNS = SENSITIVE_PATH_WORDS.flatMap(word => ['/' + word + '*', '/*/' + word + '*']);
    const SENSITIVE_ANY_ORIGIN_PATTERNS = SENSITIVE_PATH_PATTERNS.map(pattern => '*://*' + pattern);
    const SENSITIVE_HREF_REGEX = new RegExp(
        '\\/(?:' + SENSITIVE_PATH_WORDS.join('|') + ')s?(?:[\\/?#.;_-]|$)',
        'i'
    );

    // Matched anywhere in the raw href, query string included. The path list
    // can't see ucp.php?mode=logout or index.php?action=logout, and a URL
    // carrying a per-user CSRF token (HN auth=, phpBB sid=/hash=, WordPress
    // _wpnonce, Moodle sesskey) is an action link by construction: nobody
    // puts a token on a URL that only reads.
    const SENSITIVE_HREF_SUBSTRINGS = [
        'logout', 'log-out', 'log_out', 'signout', 'sign-out', 'sign_out', 'delete', 'unsubscribe',
        'auth=', 'token=', 'nonce', 'csrf', 'xsrf', 'sesskey', 'sesc=', 'sid=', 'hash=',
        'mark=', 'action='
    ];
    const SENSITIVE_SUBSTRING_REGEX = new RegExp(
        SENSITIVE_HREF_SUBSTRINGS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'i'
    );

    function isSensitiveHref(pathname, rawHref) {
        return SENSITIVE_HREF_REGEX.test(pathname) || SENSITIVE_SUBSTRING_REGEX.test(rawHref || pathname);
    }

    // =========================================================================
    // Part 2: Speculation Rules prefetch/prerender (Chrome, aggressive)
    // =========================================================================

    // Tracking parameters never change the response body, so a prefetch of
    // /post should still satisfy a click on /post?utm_source=x. Without this
    // hint every campaign-tagged link discards its own prefetch.
    const NO_VARY_SEARCH_PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid', 'igshid',
        'mc_cid', 'mc_eid', '_ga', '_gl'
    ];
    const EXPECTS_NO_VARY_SEARCH = 'params=(' + NO_VARY_SEARCH_PARAMS.map(p => '"' + p + '"').join(' ') + ')';

    let blanketRulesScript = null;

    function initSpeculationRules() {
        const tier = getConnectionTier();
        if (!supportsSpeculationRules || tier === TIER_SLOW || knownSpa) return;

        // Path words go through href_matches (segment-anchored, so no
        // href*='order'→border trap); the substring list is deliberately
        // unanchored, because its entries live in the query string.
        const excludeSelectors = [
            "a[href^='javascript:']",
            "a[href^='mailto:']",
            "a[href^='tel:']",
            "a[href*='download' i]",
            // BBC marks nav links target="_self" and YouTube target="";
            // both stay in this tab and are fair game.
            "a[target]:not([target='']):not([target='_self' i])",
            "a[download]",
            "a[rel~='nofollow']",
            "a[rel~='external']",
            ...DOWNLOAD_EXTENSIONS.map(ext => "a[href$='" + ext + "' i]"),
            ...SENSITIVE_HREF_SUBSTRINGS.map(s => "a[href*='" + s + "' i]")
        ].join(', ');

        const eligibleLinks = {
            and: [
                { href_matches: '/*' },
                { not: { href_matches: SENSITIVE_PATH_PATTERNS } },
                { not: { selector_matches: excludeSelectors } }
            ]
        };

        // Since Chrome 143 'eager' on a document rule means 10ms of hover on
        // desktop and a short viewport dwell on mobile, two in flight at most
        // (FIFO). That is intent-gated and bounded, so it is safe on any tier
        // the script speculates on at all. Before 143 it meant "every link on
        // the page, now", so older builds keep the 200ms hover of 'moderate'.
        const rules = {
            prefetch: [
                {
                    where: eligibleLinks,
                    eagerness: chromiumMajor >= 143 ? 'eager' : 'moderate',
                    expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
                },
                // Cross-origin links on pointerdown: the click is usually on
                // its way, so this buys the gap before it lands. Cross-site
                // prefetches go without cookies, but a same-site subdomain's
                // may carry them, and pointerdown is not consent (see Part 4),
                // so the action paths are excluded here too, host-agnostic.
                {
                    where: {
                        and: [
                            { not: { href_matches: '/*' } },
                            { not: { href_matches: SENSITIVE_ANY_ORIGIN_PATTERNS } },
                            { not: { selector_matches: excludeSelectors } }
                        ]
                    },
                    eagerness: 'conservative'
                }
            ]
        };

        // Prerender downloads *and* executes the target page. That is the right
        // trade only when the connection can absorb it; on 3g the same budget
        // is better spent finishing the page the user is actually looking at.
        if (tier === TIER_FAST) {
            rules.prerender = [
                {
                    where: eligibleLinks,
                    eagerness: 'moderate',
                    expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
                },
                // Speculation rules only ever match <a>/<area> elements, so a
                // link[rel=next] selector would be dead; ~= handles multi-token
                // rel values like "next nofollow".
                {
                    where: {
                        and: [
                            { selector_matches: "a[rel~='next']" },
                            { not: { selector_matches: excludeSelectors } },
                            { not: { href_matches: SENSITIVE_PATH_PATTERNS } }
                        ]
                    },
                    eagerness: 'immediate',
                    expects_no_vary_search: EXPECTS_NO_VARY_SEARCH
                }
            ];
        }

        try {
            const script = makeRulesScript(rules);
            (document.head || document.documentElement).appendChild(script);
            blanketRulesScript = script;
        } catch (_) {}
    }

    // DOMContentLoaded, not load-then-idle: document rules match links as
    // they appear and fire only on hover, so installing late just throws
    // away every hover that happens while images are still loading. Top
    // frame only, like Parts 3–5 — a 300x250 ad frame has no navigation
    // worth speeding up, and its same-origin links are ad click URLs.
    // One task later than DOMContentLoaded strictly needs: if Tampermonkey
    // injects late, runWhenDomReady calls straight through, before Part 6
    // has read this origin's SPA flag further down.
    if (isTopFrame) runWhenDomReady(() => setTimeout(initSpeculationRules, 0));

    // =========================================================================
    // Part 3: preconnect + dns-prefetch on hover/focus
    // =========================================================================

    function initPreconnectOnIntent() {
        const connected = new Map();
        const dnsPrefetched = new Set();
        const currentOrigin = location.origin;
        const maxPreconnects = 16;
        let lastLink = null;

        function removeOldestPreconnect() {
            const oldest = connected.keys().next().value;
            if (!oldest) return;

            const oldLink = connected.get(oldest);
            if (oldLink) oldLink.remove();
            connected.delete(oldest);
        }

        function dnsPrefetch(origin) {
            if (!document.head || dnsPrefetched.has(origin) || origin === currentOrigin) return;
            dnsPrefetched.add(origin);
            const hint = document.createElement('link');
            hint.rel = 'dns-prefetch';
            hint.href = origin;
            document.head.appendChild(hint);
        }

        function preconnect(origin) {
            if (!document.head || connected.has(origin) || origin === currentOrigin) return;
            if (connected.size >= maxPreconnects) removeOldestPreconnect();

            // No crossorigin attribute: hovered links lead to document
            // navigations, which reuse the credentialed non-CORS connection.
            // An anonymous preconnect would warm a connection navigations
            // never use.
            const hint = document.createElement('link');
            hint.rel = 'preconnect';
            hint.href = origin;
            document.head.appendChild(hint);
            connected.set(origin, hint);
        }

        function maybePreconnect(target) {
            const link = getClosestLinkTarget(target);
            if (!link || link === lastLink) return;
            lastLink = link;

            const url = toUrl(link.href);
            if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
                dnsPrefetch(url.origin);
                preconnect(url.origin);
            }
        }

        document.addEventListener('pointerover', e => maybePreconnect(e.target), { passive: true, capture: true });
        document.addEventListener('focusin', e => maybePreconnect(e.target), { passive: true, capture: true });
    }

    if (isTopFrame) runWhenDomReady(initPreconnectOnIntent);

    // =========================================================================
    // Part 4: pointerdown prefetch supplement (Chrome gaps / older builds)
    // =========================================================================

    // A same-origin link this script would warm. Shared with the outcome
    // counter in Part 6, which only scores clicks on links like these.
    function isSpeculableLink(link) {
        if (!link || !link.href) return false;

        const url = toUrl(link.href);
        if (!url) return false;
        if (url.origin !== location.origin) return false;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (url.pathname + url.search === location.pathname + location.search) return false;

        const href = link.getAttribute('href') || '';
        if (DOWNLOAD_REGEX.test(href)) return false;
        // Pointerdown is not a click: a confirm() in the click handler,
        // or a drag off the link, means the user never agreed to this GET.
        if (isSensitiveHref(url.pathname, href) || /download/i.test(href)) return false;
        const target = (link.getAttribute('target') || '').toLowerCase();
        if ((target && target !== '_self') || link.download || /\b(?:nofollow|external)\b/i.test(link.rel || '')) return false;

        return true;
    }

    function initPointerdownPrefetch() {
        if (getConnectionTier() === TIER_SLOW) return;

        // Deliberately not a growing memo of every link ever warmed: only one
        // speculation is installed at a time, and removing a rules script
        // cancels its prefetch/prerender outright. A Set would make a second
        // pointerdown on an earlier link a silent no-op after its rule had
        // already been torn down.
        let currentHref = null;
        let currentHint = null;
        let currentRuleScript = null;
        let rulesBlocked = false;
        // Which mechanism warmed currentHref. Without this the href alone is
        // an ambiguous record: a link warmed by a speculation rule that CSP
        // then blocked looks identical to one that is genuinely warm.
        let currentMethod = null;

        // Inline speculation-rules scripts need CSP 'inline-speculation-rules'.
        // On a strict-CSP origin every pointerdown would otherwise be a blocked
        // script plus a violation report, with no fallback ever reached.
        document.addEventListener('securitypolicyviolation', event => {
            if (event && typeof event.violatedDirective === 'string'
                && event.violatedDirective.indexOf('script-src') === 0) {
                const first = !rulesBlocked;
                rulesBlocked = true;

                // The blocked script was this link's only warm, and the click
                // it was meant to cover is usually already on its way. Re-warm
                // now down the hint path instead of waiting for another
                // pointerdown on the same link.
                if (first && currentHref && currentMethod === 'rules') {
                    const href = currentHref;
                    currentHref = null;
                    currentMethod = null;
                    warm(href);
                }
            }
        });

        // A URL-scoped speculation rule beats <link rel=prefetch> here: the
        // navigation consults the speculation-rules prefetch cache, and on a
        // fast link prerender hands over an already-rendered page instead of
        // just bytes. Only one is kept alive at a time — Chrome caps concurrent
        // prerenders, and a rule for a link the user moved past is pure cost.
        function speculate(href) {
            const action = getConnectionTier() === TIER_FAST ? 'prerender' : 'prefetch';
            const rules = {};
            rules[action] = [{ urls: [href], eagerness: 'immediate' }];

            const script = makeRulesScript(rules);

            if (currentRuleScript) currentRuleScript.remove();
            (document.head || document.documentElement).appendChild(script);
            currentRuleScript = script;
        }

        function prefetchHint(href) {
            const hint = document.createElement('link');
            hint.rel = 'prefetch';
            hint.href = href;

            if (currentHint) currentHint.remove();
            (document.head || document.documentElement).appendChild(hint);
            currentHint = hint;
        }

        function warm(href) {
            const method = (supportsSpeculationRules && !rulesBlocked) ? 'rules' : 'hint';
            // Re-warming the same href is a no-op only while the mechanism
            // stays the same. Once CSP has ruled speculation rules out, the
            // link that was warmed under the old assumption still needs its
            // fallback.
            if (currentHref === href && currentMethod === method) return;
            currentHref = href;
            currentMethod = method;

            try {
                if (method === 'rules') speculate(href);
                else prefetchHint(href);
            } catch (_) {
                // makeRulesScript throws only when Trusted Types refuses the
                // rules and no policy could be made — as final as a CSP block.
                if (method !== 'rules') return;
                rulesBlocked = true;
                currentMethod = 'hint';
                try {
                    prefetchHint(href);
                } catch (_) {}
            }
        }

        document.addEventListener('pointerdown', e => {
            // An in-page router answers the click itself; the document we
            // would fetch is never used.
            if (knownSpa) return;
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const link = getClosestLinkTarget(e.target);
            if (isSpeculableLink(link)) warm(link.href);
        }, { passive: true, capture: true });
    }

    if (isTopFrame) runWhenDomReady(initPointerdownPrefetch);

    // =========================================================================
    // Part 5: font-display swap injection
    // =========================================================================

    function initFontDisplaySwap() {
        if (typeof CSSFontFaceRule === 'undefined') return;

        // `swap` still repaints and reflows when the webfont finally arrives —
        // on a slow link that can be several seconds after first paint, which
        // is the worst of both worlds. `optional` renders the fallback and
        // never swaps, so text is stable from the first frame.
        const displayValue = getConnectionTier() === TIER_SLOW ? 'optional' : 'swap';

        function patchSheet(sheet) {
            try {
                const rules = sheet.cssRules || sheet.rules;
                if (!rules) return false;

                for (const rule of rules) {
                    if (rule instanceof CSSFontFaceRule && !rule.style.fontDisplay) {
                        rule.style.fontDisplay = displayValue;
                    }
                }

                return true;
            } catch (_) {
                return false;
            }
        }

        function patchStyleSheets() {
            for (const sheet of document.styleSheets) patchSheet(sheet);
        }

        let scanPending = false;
        function scheduleScan() {
            if (scanPending) return;
            scanPending = true;

            window.requestAnimationFrame(() => {
                scanPending = false;
                patchStyleSheets();
            });
        }

        patchStyleSheets();

        const observer = new MutationObserver(mutations => {
            let needsScan = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;

                    // Stylesheet links only: matching every <link> would make
                    // icons, preconnects and prefetches (including the hints
                    // this script injects) schedule full stylesheet rescans.
                    if (node.matches('link[rel~="stylesheet"], style')) {
                        const tryPatch = () => {
                            if (!node.sheet || !patchSheet(node.sheet)) scheduleScan();
                        };

                        // A <link>'s sheet only exists once the stylesheet has
                        // loaded, which is after this mutation fires.
                        if (node.matches('link') && !node.sheet) {
                            node.addEventListener('load', tryPatch, { once: true });
                        } else {
                            window.requestAnimationFrame(tryPatch);
                        }
                    } else if (node.querySelector('link[rel~="stylesheet"], style')) {
                        needsScan = true;
                    }
                }
            }

            if (needsScan) scheduleScan();
        });

        const options = { childList: true, subtree: true };
        if (document.head) observer.observe(document.head, options);
        if (document.body) observer.observe(document.body, options);
        else window.addEventListener('DOMContentLoaded', () => {
            if (document.body) observer.observe(document.body, options);
        }, { once: true });
    }

    if (isTopFrame) runWhenDomReady(initFontDisplaySwap);

    // =========================================================================
    // Part 6: cross-visit learning (LCP preload + critical-origin preconnect)
    // =========================================================================
    //
    // Everything above this point is reactive: it can only speed up a resource
    // once the page has already revealed that it wants it. The largest single
    // win left is starting the two things that gate first paint — the hero
    // image and the third-party connections — before the parser discovers
    // them. We cannot know those on a cold visit, but we saw them last time.

    const LEARN_LCP_KEY = 'tm-qs-lcp';
    const LEARN_ORIGINS_KEY = 'tm-qs-origins';
    const LEARN_VITALS_KEY = 'tm-qs-vitals';
    const LEARN_TRANSITIONS_KEY = 'tm-qs-transitions';
    const LEARN_SPA_KEY = 'tm-qs-spa';
    const STATS_KEY = 'tm-qs-stats';
    const PENDING_NAV_KEY = 'tm-qs-pending-nav';
    // Not origin-scoped: the all-sites totals behind the status report.
    const STATS_ALL_KEY = 'tm-qs-stats-all';
    const CV_FLAG_KEY = 'tm-qs-content-visibility';
    const LEARN_LCP_MAX_ENTRIES = 60;
    const LEARN_ORIGIN_MAX_ENTRIES = 8;
    const LEARN_VITALS_SAMPLES = 12;
    const LEARN_MAX_AGE = 14 * 24 * HOUR;
    // The hero acts on the third visit, after two sightings of the same
    // image. That gate is a stability test, not a delay: a homepage whose
    // hero rotates daily resets the count on every visit and never
    // qualifies, where a one-sighting gate would preload yesterday's image
    // at fetchpriority=high on every visit, against the real LCP.
    const LEARN_LCP_MIN_SIGHTINGS = 2;
    // A wrong preconnect costs one idle socket, so one sighting is enough.
    const LEARN_ORIGIN_MIN_SIGHTINGS = 1;
    const LEARN_EARLY_RESOURCE_MS = 4000;
    // LCP candidates stop arriving at the first user interaction, and in
    // practice well before this after load. Snapshotting here is what lets a
    // page the user simply sits on — the common case, and the one earlier
    // versions never recorded — contribute a record at all.
    const LEARN_SETTLE_MS = 3000;
    const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

    let learnedLcpUrl = null;

    // localStorage would put a durable visit log somewhere every script on the
    // origin can read — including analytics and ad tags, which run in the top
    // origin's context and would inherit history from before they were present.
    // Extension storage is invisible to the page. It is shared across origins
    // though, so keys are namespaced and the origin set is bounded.
    const LEARN_INDEX_KEY = 'tm-qs-origin-index';
    const LEARN_MAX_ORIGINS = 150;
    const ORIGIN_KEYS = [LEARN_LCP_KEY, LEARN_ORIGINS_KEY, LEARN_VITALS_KEY, LEARN_TRANSITIONS_KEY, LEARN_SPA_KEY, STATS_KEY, PENDING_NAV_KEY];
    const hasGmStorage = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function storeKey(key) {
        return hasGmStorage ? key + '::' + location.origin : key;
    }

    function rawRead(key) {
        try {
            return hasGmStorage ? GM_getValue(key, null) : localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function rawWrite(key, raw) {
        try {
            if (hasGmStorage) GM_setValue(key, raw);
            else localStorage.setItem(key, raw);
        } catch (_) {}
    }

    function rawDelete(key) {
        try {
            if (hasGmStorage) {
                if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
                else GM_setValue(key, '');
            } else {
                localStorage.removeItem(key);
            }
        } catch (_) {}
    }

    function readStore(key) {
        try {
            const raw = rawRead(storeKey(key));
            if (!raw || typeof raw !== 'string') return null;
            const value = JSON.parse(raw);
            // Anything here may have been written by a hostile origin (in the
            // localStorage fallback) or by an older schema.
            return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
        } catch (_) {
            return null;
        }
    }

    function writeStore(key, value) {
        try {
            rawWrite(storeKey(key), JSON.stringify(value));
        } catch (_) {}
        touchOriginIndex();
    }

    function deleteStore(key) {
        rawDelete(storeKey(key));
    }

    // Extension storage is not scoped per origin and nothing else would ever
    // evict it, so the set of origins we hold data for is capped explicitly.
    function touchOriginIndex() {
        if (!hasGmStorage) return;

        let index;
        try {
            const raw = rawRead(LEARN_INDEX_KEY);
            index = raw ? JSON.parse(raw) : null;
        } catch (_) {
            index = null;
        }
        if (!Array.isArray(index)) index = [];

        const now = Date.now();
        const kept = index.filter(entry => entry && typeof entry.o === 'string' && entry.o !== location.origin);
        kept.push({ o: location.origin, at: now });
        kept.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

        for (const evicted of kept.slice(LEARN_MAX_ORIGINS)) {
            for (const key of ORIGIN_KEYS.concat([CV_FLAG_KEY])) {
                rawDelete(key + '::' + evicted.o);
            }
        }

        try {
            rawWrite(LEARN_INDEX_KEY, JSON.stringify(kept.slice(0, LEARN_MAX_ORIGINS)));
        } catch (_) {}
    }

    // -------------------------------------------------------------------------
    // 3.x migration
    // -------------------------------------------------------------------------
    //
    // 3.x kept an asset cache in CacheStorage plus its metadata in
    // localStorage, and the content-visibility toggle in localStorage. 4.0.0
    // removed the cache and moved the toggle into GM storage; without this,
    // every origin visited under 3.x keeps megabytes of dead cache forever and
    // silently loses its rendering preference on upgrade. All idempotent.

    function migrateLegacyStorage() {
        if (hasGmStorage) {
            try {
                const legacyFlag = localStorage.getItem(CV_FLAG_KEY);
                if (legacyFlag !== null) {
                    if (rawRead(storeKey(CV_FLAG_KEY)) === null) {
                        rawWrite(storeKey(CV_FLAG_KEY), legacyFlag);
                    }
                    localStorage.removeItem(CV_FLAG_KEY);
                }
            } catch (_) {}
        }

        try {
            localStorage.removeItem('tm-cache-lru-metadata');
            localStorage.removeItem('tm-cache-stats');
        } catch (_) {}
    }

    function purgeLegacyCache() {
        // The Cache API only exists in secure contexts, and deleting a cache
        // that is already gone is a cheap async no-op, so this is safe to run
        // on every load. 3.x cached in every frame, so no isTopFrame gate.
        try {
            if (typeof caches !== 'undefined') {
                caches.delete('tm-smart-lru-v3').catch(() => {});
            }
        } catch (_) {}
    }

    migrateLegacyStorage();
    runWhenLoadedIdle(purgeLegacyCache);

    // -------------------------------------------------------------------------
    // Same-document route changes
    // -------------------------------------------------------------------------
    //
    // A client-side router changes the URL without a navigation, so nothing in
    // the page lifecycle fires. Both the learning and the prediction parts need
    // to know, so the plumbing is shared.

    const routeChangeHandlers = [];
    let routeWatcherInstalled = false;

    function onRouteChange(handler) {
        routeChangeHandlers.push(handler);
        installRouteWatcher();
    }

    // A router answering a link click is the SPA signature. A push that no
    // click preceded is something else: Wikipedia's replaceState redirect
    // fixups, or a news page rewriting its URL as you scroll.
    const LINK_CLICK_WINDOW_MS = 1000;
    let lastLinkClickAt = 0;

    function installRouteWatcher() {
        if (routeWatcherInstalled) return;
        routeWatcherInstalled = true;

        // Capture on document runs before the router's own click handler.
        document.addEventListener('click', event => {
            if (getClosestLinkTarget(event.target)) lastLinkClickAt = Date.now();
        }, { passive: true, capture: true });

        // Deferred a turn: pushState updates location *before* returning, but
        // the Navigation API's navigate event fires before the new URL is
        // committed, so reading it fresh on the next task is correct for both.
        // What kind of change it was is captured now, though, while the click
        // that caused it is still recent.
        const fire = push => {
            const info = { push, afterLinkClick: Date.now() - lastLinkClickAt < LINK_CLICK_WINDOW_MS };
            setTimeout(() => {
                for (const handler of routeChangeHandlers) {
                    try {
                        handler(info);
                    } catch (_) {}
                }
            }, 0);
        };

        // The Navigation API reports every same-document navigation without
        // touching page globals, so it is strongly preferred over patching
        // history.pushState.
        if (window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('navigate', event => fire(Boolean(event) && event.navigationType === 'push'));
            return;
        }

        window.addEventListener('popstate', () => fire(false));

        // Fallback only. A pushState-only router fires nothing else at all, so
        // without this the whole SPA case goes dark on builds that predate the
        // Navigation API.
        try {
            const target = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).history;
            for (const method of ['pushState', 'replaceState']) {
                const original = target[method];
                if (typeof original !== 'function') continue;
                target[method] = function (...args) {
                    const result = original.apply(this, args);
                    fire(method === 'pushState');
                    return result;
                };
            }
        } catch (_) {}
    }

    // -------------------------------------------------------------------------
    // SPA detection
    // -------------------------------------------------------------------------
    //
    // On a site whose router answers link clicks in-page (YouTube, GitHub),
    // a prefetched or prerendered document is never used: the click becomes
    // a pushState and a JSON fetch. Every hover-speculation there is a whole
    // page load thrown away, and 4.1.0's eager prefetch would multiply that.
    // One observed click-driven soft navigation switches Parts 2, 4 and 9
    // off for the origin; learning carries on.

    const SPA_FLAG_REFRESH = 24 * HOUR;

    function isKnownSpa() {
        const flag = readStore(LEARN_SPA_KEY);
        return Boolean(flag) && Date.now() - (Number(flag.at) || 0) < LEARN_MAX_AGE;
    }

    function initSpaDetection() {
        let lastRoute = pageKey();

        onRouteChange(info => {
            const next = pageKey();
            if (next === lastRoute) return;
            lastRoute = next;
            if (!info || !info.push || !info.afterLinkClick) return;

            // Kept alive by use and aged out like everything else, so a site
            // that drops its client-side router gets speculation back.
            const flag = readStore(LEARN_SPA_KEY);
            if (!flag || Date.now() - (Number(flag.at) || 0) > SPA_FLAG_REFRESH) {
                writeStore(LEARN_SPA_KEY, { at: Date.now() });
            }

            if (knownSpa) return;
            knownSpa = true;
            // Stop paying for this visit too, not only future ones.
            if (blanketRulesScript) {
                blanketRulesScript.remove();
                blanketRulesScript = null;
            }
        });
    }

    // -------------------------------------------------------------------------
    // Measured outcomes
    // -------------------------------------------------------------------------
    //
    // 3.x reported a cache hit rate, which measured its own machinery. These
    // count what the user actually got: a navigation served from a prefetch
    // or prerender or not, and a hero preload that was the real LCP or not.

    function bumpStats(section, outcome) {
        const bump = previous => {
            const stats = (previous && typeof previous === 'object' && !Array.isArray(previous)) ? previous : {};
            const bucket = (stats[section] && typeof stats[section] === 'object') ? stats[section] : {};
            bucket[outcome] = (Number(bucket[outcome]) || 0) + 1;
            stats[section] = bucket;
            if (!stats.since) stats.since = Date.now();
            return stats;
        };

        writeStore(STATS_KEY, bump(readStore(STATS_KEY)));

        // The localStorage fallback is per-origin by nature; there is no
        // "all sites" to add to.
        if (!hasGmStorage) return;
        rawWrite(STATS_ALL_KEY, JSON.stringify(bump(readAllStats())));
    }

    function readAllStats() {
        try {
            return JSON.parse(rawRead(STATS_ALL_KEY) || 'null');
        } catch (_) {
            return null;
        }
    }

    // A same-site arrival is only a *miss* if it came from a click on a link
    // speculation could have served. New tabs, form posts, excluded links
    // and redirects arrive with a same-origin referrer too, and counting
    // them would make a site where every eligible click was prerendered
    // read as 60%. So the click leaves a marker for the page it opens.
    const PENDING_NAV_MAX_AGE = MINUTE;

    function initOutcomeMarker() {
        document.addEventListener('click', event => {
            if (knownSpa || !supportsSpeculationRules || getConnectionTier() === TIER_SLOW) return;
            // Modified clicks open a new tab or window: not this navigation.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const link = getClosestLinkTarget(event.target);
            if (!isSpeculableLink(link)) return;
            writeStore(PENDING_NAV_KEY, { href: link.href, at: Date.now() });
        }, { passive: true, capture: true });
    }

    function recordNavigationOutcome(nav) {
        const pending = readStore(PENDING_NAV_KEY);
        if (pending) deleteStore(PENDING_NAV_KEY);

        // activationStart is non-zero only on a prerendered page (the moment
        // the user arrived); deliveryType names a navigation that Chrome
        // answered from a prefetch. Hits count without the marker: a
        // prerender activates instantly, possibly before the old page's
        // write has reached this one.
        if (nav && Number(nav.activationStart) > 0) return bumpStats('nav', 'prerender');
        if (nav && nav.deliveryType === 'navigational-prefetch') return bumpStats('nav', 'prefetch');

        const clicked = pending && pending.href === location.href
            && Date.now() - (Number(pending.at) || 0) < PENDING_NAV_MAX_AGE;
        if (clicked) bumpStats('nav', 'miss');
    }

    // -------------------------------------------------------------------------
    // Hint emission
    // -------------------------------------------------------------------------

    function appendToHead(node) {
        if (document.head) {
            document.head.appendChild(node);
            return;
        }

        const root = document.documentElement;
        if (!root) return;

        // document-start can run before <head> exists. Resource hints are only
        // reliably processed once they are in the document, so wait for it.
        const observer = new MutationObserver(() => {
            if (!document.head) return;
            observer.disconnect();
            document.head.appendChild(node);
        });
        observer.observe(root, { childList: true });
    }

    // A different viewport can mean a different layout and so a different
    // hero, so a record is only reused at a similar width. 320px buckets
    // survive a nudged window edge; 160px ones did not.
    const VIEWPORT_BUCKET_PX = 320;

    function viewportWidthBucket() {
        return Math.round((window.innerWidth || 0) / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX;
    }

    function currentDpr() {
        return Math.round(window.devicePixelRatio || 1);
    }

    function recordBucket(record) {
        // 4.0.x stored "1280x2" at 160px granularity. Re-bucket it rather
        // than make every learned hero start over.
        if (typeof record.vw === 'string') {
            const match = /^(\d+)x(\d+)$/.exec(record.vw);
            if (!match) return null;
            return {
                width: Math.round(Number(match[1]) / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX,
                dpr: Number(match[2])
            };
        }
        return { width: Number(record.vw), dpr: Number(record.dpr) };
    }

    function matchesViewport(record) {
        const bucket = recordBucket(record);
        if (!bucket || bucket.width !== viewportWidthBucket()) return false;
        // With srcset replayed as imagesrcset the browser picks the density
        // itself, so zoom (which changes devicePixelRatio) only invalidates a
        // src-only hero, whose URL was chosen for the old density.
        return Boolean(record.srcset) || bucket.dpr === currentDpr();
    }

    function pageKey() {
        // Exact pathname, deliberately not a normalised /post/* pattern: two
        // articles under the same route have different hero images, and
        // preloading the wrong one spends scarce bytes on an unused image.
        return location.pathname.slice(0, 200);
    }

    function capStore(store, limit) {
        const entries = Object.entries(store)
            .sort((a, b) => (Number(b[1] && b[1].at) || 0) - (Number(a[1] && a[1].at) || 0))
            .slice(0, limit);
        return Object.fromEntries(entries);
    }

    let emittedPreloadFor = null;
    // Which route a hero preload went out for, and every URL that would
    // count as it being right: with imagesrcset the browser may pick any
    // candidate, all of which are the same image.
    let heroPreload = null;

    function preloadUrls(record) {
        const urls = [record.url];
        for (const candidate of String(record.srcset || '').split(',')) {
            const url = toUrl(candidate.trim().split(/\s+/)[0]);
            if (url) urls.push(url.href);
        }
        return urls;
    }

    function applyLearnedHints(route) {
        const key = route || pageKey();
        const tier = getConnectionTier();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const record = lcpStore && lcpStore[key];

        if (
            record
            && typeof record.url === 'string'
            && (Number(record.seen) || 0) >= LEARN_LCP_MIN_SIGHTINGS
            && matchesViewport(record)
            && Date.now() - (Number(record.at) || 0) < LEARN_MAX_AGE
            && emittedPreloadFor !== record.url
        ) {
            learnedLcpUrl = record.url;
            emittedPreloadFor = record.url;
            heroPreload = { route: key, urls: preloadUrls(record) };

            try {
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = record.url;
                link.setAttribute('fetchpriority', 'high');
                // The preload has to match how the element will fetch it. A
                // mismatched CORS mode produces a second request rather than a
                // warm cache entry, which is worse than not preloading at all.
                if (record.cors) link.crossOrigin = record.cors;
                // Replaying srcset/sizes lets the browser resolve the same
                // candidate the <img> will, instead of us betting on the
                // viewport bucket still matching.
                if (record.srcset) {
                    link.setAttribute('imagesrcset', record.srcset);
                    if (record.sizes) link.setAttribute('imagesizes', record.sizes);
                }
                // A hero that 404s or was removed should stop being preloaded
                // rather than cost a request a day for two weeks.
                link.addEventListener('error', () => {
                    const current = readStore(LEARN_LCP_KEY);
                    if (!current || !current[key]) return;
                    delete current[key];
                    writeStore(LEARN_LCP_KEY, current);
                }, { once: true });
                appendToHead(link);
            } catch (_) {}
        }

        // Origins are a property of the site, not the route, so they are only
        // worth emitting once per document.
        if (route) return;

        const originStore = readStore(LEARN_ORIGINS_KEY);
        const origins = (originStore && Array.isArray(originStore.origins)) ? originStore.origins : [];
        const budget = tier === TIER_SLOW ? 2 : (tier === TIER_MODERATE ? 3 : 6);

        let used = 0;
        for (const entry of origins) {
            if (used >= budget) break;
            if (!entry || typeof entry.o !== 'string') continue;
            if ((Number(entry.n) || 0) < LEARN_ORIGIN_MIN_SIGHTINGS) continue;
            if (entry.o === location.origin) continue;
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && Date.now() - updatedAt > LEARN_MAX_AGE) continue;

            try {
                const hint = document.createElement('link');
                hint.rel = 'preconnect';
                hint.href = entry.o;
                // Fonts and other CSS-initiated subresources fetch in CORS mode
                // and will not reuse an uncredentialed-mismatched connection.
                if (entry.c) hint.crossOrigin = 'anonymous';
                appendToHead(hint);
                used += 1;
            } catch (_) {}
        }
    }

    // -------------------------------------------------------------------------
    // Observation
    // -------------------------------------------------------------------------

    function initLearning() {
        let pending = null;
        let settleTimer = null;
        let sawLoad = document.readyState === 'complete';
        // A prerendered document reports 'hidden' while it loads, but a user
        // who activates it is looking at a normally-loaded page — that must
        // not latch the backgrounded-tab guard, or every route Part 9
        // successfully prerenders becomes a route Part 6 refuses to learn.
        let hiddenBeforeLoad = document.visibilityState === 'hidden' && !document.prerendering;
        let softNavigated = false;
        let currentRoute = pageKey();
        let persistedRoute = null;

        try {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    // LCP is reported repeatedly as larger candidates appear;
                    // the final one wins. Text LCP has no url — nothing to
                    // preload there, so those entries are ignored.
                    if (!entry || !entry.url) continue;

                    // Snapshot now, not at persist time: entry.element is null
                    // once the element leaves the document, which is routine for
                    // carousels and SPA route changes, and reading crossOrigin
                    // as null then is exactly the CORS-mode mismatch that turns
                    // the preload into a second full download.
                    const element = entry.element;
                    pending = {
                        url: entry.url,
                        startTime: entry.startTime,
                        cors: (element && element.crossOrigin) || null,
                        srcset: (element && element.getAttribute) ? element.getAttribute('srcset') : null,
                        sizes: (element && element.getAttribute) ? element.getAttribute('sizes') : null,
                        // Bound to the route that was current when the hero
                        // painted. Reading location.pathname at persist time is
                        // what used to file an SPA's hero under the wrong page.
                        route: currentRoute
                    };
                }
            });
            observer.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (_) {}

        function persistLcp(route, observed) {
            if (!route || persistedRoute === route) return;
            persistedRoute = route;

            if (heroPreload && heroPreload.route === route) {
                const painted = observed && observed.url ? toUrl(observed.url) : null;
                bumpStats('hero', painted && heroPreload.urls.includes(painted.href) ? 'hit' : 'miss');
                heroPreload = null;
            }

            if (!observed || !observed.url) {
                // No image LCP for this route: redesigned to a text headline,
                // or the hero is gone. Returning early would leave the old
                // record authoritative for the full LEARN_MAX_AGE, preloading
                // an image the page no longer references against the real LCP.
                const existing = readStore(LEARN_LCP_KEY);
                if (!existing || !existing[route]) return;

                const seen = (Number(existing[route].seen) || 0) - 1;
                if (seen <= 0) delete existing[route];
                else existing[route] = Object.assign({}, existing[route], { seen });
                writeStore(LEARN_LCP_KEY, existing);
                return;
            }

            const url = toUrl(observed.url);
            if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return;

            const store = readStore(LEARN_LCP_KEY) || {};
            const previous = store[route];
            const sameTarget = Boolean(previous && previous.url === url.href && matchesViewport(previous));

            store[route] = {
                url: url.href,
                cors: observed.cors,
                srcset: observed.srcset,
                sizes: observed.sizes,
                vw: viewportWidthBucket(),
                dpr: currentDpr(),
                at: Date.now(),
                // A changed target resets confidence rather than accumulating
                // it, so a redesigned page stops being preloaded immediately.
                seen: sameTarget ? Math.min(Number(previous.seen) || 0, 50) + 1 : 1
            };

            writeStore(LEARN_LCP_KEY, capStore(store, LEARN_LCP_MAX_ENTRIES));

            const vitals = readStore(LEARN_VITALS_KEY) || {};
            const samples = Array.isArray(vitals.lcp) ? vitals.lcp.filter(Number.isFinite) : [];
            samples.push(Math.round(observed.startTime));
            writeStore(LEARN_VITALS_KEY, { lcp: samples.slice(-LEARN_VITALS_SAMPLES) });
        }

        function settle() {
            // Never persist from a document that is still prerendering: the
            // page has not been seen, so its timer-driven settle would record
            // a visit that never happened. Rescheduled on prerenderingchange.
            if (document.prerendering) return;
            // The LCP API only reports entries for the initial hard
            // navigation. Once a client-side route change has happened, an
            // empty pending is the API staying silent, not evidence the hero
            // is gone — running the no-image decrement then would erode every
            // learned record each time its route is revisited in an SPA.
            if (!pending && softNavigated) return;
            // A page backgrounded during load finalises its LCP on whatever had
            // painted — often the logo. That wrong value is *consistent* across
            // such visits, so the seen>=2 gate would endorse it rather than
            // filter it out, and the script would train itself to preload the
            // logo and shield it from lazying while the real hero stays
            // eligible for fetchpriority=low.
            if (!sawLoad || hiddenBeforeLoad) return;
            // pending.route is authoritative: it names the route that was
            // current when the hero actually painted, independent of handler
            // ordering on a route change.
            persistLcp(pending ? pending.route : currentRoute, pending);
        }

        function scheduleSettle() {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(settle, LEARN_SETTLE_MS);
        }

        // A client-side route change ends the old route's observation window.
        // Finalise what we saw for it, then start again for the new one.
        onRouteChange(() => {
            const next = pageKey();
            if (next === currentRoute) return;

            settle();
            softNavigated = true;

            currentRoute = next;
            persistedRoute = null;
            pending = null;
            emittedPreloadFor = null;
            learnedLcpUrl = null;

            applyLearnedHints(next);
            scheduleSettle();
        });

        if (sawLoad) scheduleSettle();
        else window.addEventListener('load', () => {
            sawLoad = true;
            scheduleSettle();
        }, { once: true });

        // Kept as a backstop: settle() is idempotent per route, so whichever of
        // these fires first wins and the rest are no-ops.
        window.addEventListener('pagehide', settle);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'hidden') return;
            if (!sawLoad) hiddenBeforeLoad = true;
            settle();
        });

        // Activation of a prerendered document is the moment the user really
        // arrives; the settle clock starts from here. Never fires otherwise.
        document.addEventListener('prerenderingchange', scheduleSettle, { once: true });
    }

    function persistOrigins() {
        let entries;
        try {
            entries = performance.getEntriesByType('resource') || [];
        } catch (_) {
            return;
        }

        const observed = new Map();
        for (const entry of entries) {
            // Only resources needed early are worth a preconnect; a lazily
            // loaded widget's origin is not on the critical path.
            if (!entry || entry.startTime > LEARN_EARLY_RESOURCE_MS) continue;

            const url = toUrl(entry.name);
            if (!url || url.origin === location.origin) continue;
            if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

            const needsCors = entry.initiatorType === 'css' || FONT_EXTENSION.test(url.pathname);
            const existing = observed.get(url.origin);

            if (existing) {
                existing.cors = existing.cors || needsCors;
                existing.first = Math.min(existing.first, entry.startTime);
            } else {
                observed.set(url.origin, { origin: url.origin, cors: needsCors, first: entry.startTime });
            }
        }

        if (!observed.size) return;

        const store = readStore(LEARN_ORIGINS_KEY) || {};
        const previous = Array.isArray(store.origins) ? store.origins : [];
        const merged = new Map();

        const now = Date.now();
        for (const entry of previous) {
            if (!entry || typeof entry.o !== 'string') continue;
            // Without aging, a CDN that mattered a year ago outranks a
            // currently-critical origin forever and keeps costing a
            // DNS+TCP+TLS handshake on every visit.
            const updatedAt = Number(entry.u) || 0;
            if (updatedAt && now - updatedAt > LEARN_MAX_AGE) continue;

            merged.set(entry.o, {
                o: entry.o,
                c: Boolean(entry.c),
                n: Number(entry.n) || 0,
                t: Number(entry.t) || 0,
                u: updatedAt
            });
        }

        for (const info of observed.values()) {
            const existing = merged.get(info.origin);
            if (existing) {
                existing.n += 1;
                existing.c = existing.c || info.cors;
                existing.t = Math.min(existing.t || info.first, info.first);
                existing.u = now;
            } else {
                merged.set(info.origin, { o: info.origin, c: info.cors, n: 1, t: info.first, u: now });
            }
        }

        // Most consistently used first, ties broken by how early the origin is
        // needed — that is the order a preconnect budget should spend in.
        const ranked = Array.from(merged.values())
            .sort((a, b) => (b.n - a.n) || (a.t - b.t))
            .slice(0, LEARN_ORIGIN_MAX_ENTRIES);

        writeStore(LEARN_ORIGINS_KEY, { origins: ranked, at: Date.now() });
    }

    if (isTopFrame) {
        knownSpa = isKnownSpa();
        // Registered before Parts 6 and 9 hook route changes, so the flag is
        // already set by the time their handlers look at it.
        initSpaDetection();
        initOutcomeMarker();
        applyLearnedHints();
        initLearning();
        runWhenLoadedIdle(() => {
            // Origin sightings from a prerendered document would credit a
            // visit that never happened; count them only after activation.
            if (document.prerendering) {
                document.addEventListener('prerenderingchange', persistOrigins, { once: true });
            } else {
                persistOrigins();
            }
        });
    }

    // =========================================================================
    // Part 9: navigation-transition prediction
    // =========================================================================
    //
    // Parts 2 and 4 speculate from what is on the page: every eligible link, or
    // the one under the pointer. On a link-dense article that is a fair bet. On
    // an app shell with seventeen anchors and client-side routing it has almost
    // nothing to work with — which is the case that motivated this part.
    //
    // document.referrer already says which page you came from, and same-origin
    // navigations carry it in full under Chrome's default referrer policy. Two
    // sightings of the same transition is a better prediction than "some link
    // on this page", and costs one prerender instead of dozens of prefetches.
    //
    // Scope limit, deliberate: only same-origin transitions are recorded, keyed
    // by pathname with query strings and fragments dropped before anything is
    // written. Those carry session tokens and search terms, and none of it
    // changes which page you are going to next. The result is in-site
    // prediction with no cross-site browsing graph anywhere in storage.

    const TRANSITION_MAX_SOURCES = 120;
    const TRANSITION_MAX_TARGETS = 4;
    // A wrong prefetch wastes bytes; a wrong prerender runs a whole page. So
    // one real navigation earns a prefetch, and it takes two for a prerender.
    const TRANSITION_PREFETCH_CONFIDENCE = 1;
    const TRANSITION_PRERENDER_CONFIDENCE = 2;

    let predictedTargets = [];
    let currentPredictionScript = null;

    function recordTransition(fromPath, toPath) {
        const from = String(fromPath || '').slice(0, 200);
        const to = String(toPath || '').slice(0, 200);
        if (!from || !to || from === to) return;

        const store = readStore(LEARN_TRANSITIONS_KEY) || {};
        const now = Date.now();

        const entry = (store[from] && typeof store[from] === 'object') ? store[from] : { t: {}, at: 0 };
        const targets = (entry.t && typeof entry.t === 'object') ? entry.t : {};

        targets[to] = (Number(targets[to]) || 0) + 1;

        // Keep only the strongest few targets per source. A page that leads
        // everywhere predicts nothing, and storing its whole fan-out just
        // spends quota to dilute the ranking.
        const ranked = Object.entries(targets)
            .sort((a, b) => b[1] - a[1])
            .slice(0, TRANSITION_MAX_TARGETS);

        store[from] = { t: Object.fromEntries(ranked), at: now };

        // Age out, then cap by recency. Without this a page visited once a year
        // outranks nothing but still occupies a slot forever.
        const live = Object.entries(store)
            .filter(([, value]) => value && (now - (Number(value.at) || 0)) < LEARN_MAX_AGE)
            .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
            .slice(0, TRANSITION_MAX_SOURCES);

        writeStore(LEARN_TRANSITIONS_KEY, Object.fromEntries(live));
    }

    function predictNext(fromPath) {
        const store = readStore(LEARN_TRANSITIONS_KEY);
        const entry = store && store[String(fromPath || '').slice(0, 200)];
        if (!entry || !entry.t) return [];

        return Object.entries(entry.t)
            .filter(([, count]) => (Number(count) || 0) >= TRANSITION_PREFETCH_CONFIDENCE)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(([path, count]) => ({ path, count: Number(count) || 0 }));
    }

    function isSpeculationEligible(url) {
        if (!url) return false;
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        if (url.origin !== location.origin) return false;
        if (url.pathname === location.pathname) return false;
        if (DOWNLOAD_REGEX.test(url.pathname)) return false;
        // Prerender *executes* the target. A destructive GET behind one of
        // these paths would be run, not merely fetched.
        if (isSensitiveHref(url.pathname)) return false;
        return true;
    }

    function speculateOnPrediction() {
        if (!supportsSpeculationRules) return;
        if (getConnectionTier() === TIER_SLOW) return;
        if (knownSpa) {
            // The router will answer the next click in-page; a live
            // prediction from before the site showed that is pure cost.
            if (currentPredictionScript) currentPredictionScript.remove();
            currentPredictionScript = null;
            return;
        }

        const candidates = predictNext(pageKey());
        if (!candidates.length) return;

        const eligible = [];
        for (const candidate of candidates) {
            const url = toUrl(candidate.path, location.origin);
            if (!isSpeculationEligible(url)) continue;
            eligible.push({ path: candidate.path, count: candidate.count, href: url.href });
        }

        if (!eligible.length) return;
        predictedTargets = eligible;

        // Only the single strongest prediction is prerendered, which is also
        // why it is allowed on the moderate tier: one background page load
        // for a destination seen twice is a good trade even on 3G. Chrome
        // caps concurrent prerenders hard, so anything else is prefetched.
        const rules = {};
        const top = eligible[0];
        const prerenderTop = top.count >= TRANSITION_PRERENDER_CONFIDENCE;
        if (prerenderTop) rules.prerender = [{ urls: [top.href], eagerness: 'immediate' }];

        const prefetchHrefs = eligible.slice(prerenderTop ? 1 : 0).map(c => c.href);
        if (prefetchHrefs.length) rules.prefetch = [{ urls: prefetchHrefs, eagerness: 'immediate' }];

        try {
            const script = makeRulesScript(rules);
            // One prediction is live at a time. Removing a rules script cancels
            // its speculation, which is what we want when a route change makes
            // the previous prediction obsolete — and without this a long
            // single-page session would accumulate one script per navigation.
            if (currentPredictionScript) currentPredictionScript.remove();
            (document.head || document.documentElement).appendChild(script);
            currentPredictionScript = script;
        } catch (_) {}
    }

    function initTransitionLearning() {
        let previousRoute = pageKey();

        // document.referrer survives reloads and back/forward traversals, so
        // recording it unconditionally would count /list → /item once per
        // reload of /item, letting a single real navigation reach the
        // confidence gate by itself. Only a fresh navigation is a choice.
        let navType = 'navigate';
        let navEntry = null;
        try {
            const nav = performance.getEntriesByType('navigation');
            navEntry = (nav && nav[0]) || null;
            if (navEntry && navEntry.type) navType = navEntry.type;
        } catch (_) {}

        // A full navigation: the referrer is the page we came from. Chrome's
        // default policy sends it in full for same-origin requests, which is
        // the only case recorded here anyway.
        if (navType === 'navigate' && document.referrer) {
            const from = toUrl(document.referrer);
            if (from && from.origin === location.origin) {
                recordTransition(from.pathname, previousRoute);
                // Same-site link navigations are the ones speculation could
                // have served, so they are the hit-rate denominator. Skipped
                // where speculation is off on purpose (SPA, slow link), so
                // a deliberate "no" doesn't read as a miss.
                if (supportsSpeculationRules && !knownSpa && getConnectionTier() !== TIER_SLOW) {
                    recordNavigationOutcome(navEntry);
                }
            }
        }

        // A same-document navigation: no request is made, so nothing carries a
        // referrer and the transition would otherwise go unrecorded.
        onRouteChange(() => {
            const next = pageKey();
            if (next === previousRoute) return;

            recordTransition(previousRoute, next);
            previousRoute = next;

            predictedTargets = [];
            speculateOnPrediction();
        });

        runWhenLoadedIdle(speculateOnPrediction);
    }

    if (isTopFrame) {
        // A prerendered document runs this script too. Recording its referrer
        // there would count Part 9's own prerenders as navigations the user
        // made — a feedback loop where a wrong prediction reinforces itself
        // forever. Learn (and predict) only once the user actually arrives.
        if (document.prerendering) {
            document.addEventListener('prerenderingchange', initTransitionLearning, { once: true });
        } else {
            initTransitionLearning();
        }
    }

    // =========================================================================
    // Part 7: priority hints and lazy media
    // =========================================================================
    //
    // Caveat worth knowing: for images the HTML parser discovers, Chrome's
    // preload scanner may have already started the fetch before a userscript
    // can touch the element, and neither loading=lazy nor fetchpriority
    // retroactively cancels or reorders an in-flight request. The reliable win
    // is script-inserted media — infinite scroll, SPA route changes, lazy
    // widgets — which is also where the runaway byte counts usually are.

    const MEDIA_SCAN_BUDGET = 300;
    const BELOW_FOLD_FACTOR = 1.5;

    function initMediaPriority() {
        const tunedImages = new WeakSet();
        let pending = null;

        function foldLimit() {
            return (window.innerHeight || document.documentElement.clientHeight || 0) * BELOW_FOLD_FACTOR;
        }

        // A responsive hero has no resolved currentSrc until layout runs, and
        // may never expose the learned URL through .src at all, so match on
        // every candidate the element could resolve to.
        function isLcpCandidate(img) {
            if (!learnedLcpUrl) return false;
            if (img.currentSrc === learnedLcpUrl || img.src === learnedLcpUrl) return true;

            const srcset = img.getAttribute('srcset');
            if (!srcset) return false;

            return srcset.split(',').some(candidate => {
                const href = candidate.trim().split(/\s+/)[0];
                if (!href) return false;
                const url = toUrl(href);
                return Boolean(url) && url.href === learnedLcpUrl;
            });
        }

        // Every decision here needs layout. Guessing from document order was
        // tried and is actively harmful: on markup that opens with a logo and
        // a few nav icons, the hero is image five, and lazy + fetchpriority=low
        // on the LCP element is the best-documented way to make a page slower.
        function tuneWithLayout(el, limit) {
            if (el.hasAttribute('loading') || el.hasAttribute('fetchpriority')) return;

            const rect = el.getBoundingClientRect();
            // No box yet (display:none, detached, mid-parse): leave it alone
            // rather than deprioritise something about to become the hero.
            if (rect.width === 0 && rect.height === 0) return;
            if (rect.top <= limit) return;

            const isImage = el.tagName === 'IMG';
            if (isImage && isLcpCandidate(el)) return;

            el.setAttribute('loading', 'lazy');
            // fetchpriority has no meaning on <iframe>; loading=lazy is the
            // whole lever there.
            if (isImage) el.setAttribute('fetchpriority', 'low');
        }

        function tuneVideo(video) {
            // rtt >= 270ms lands ordinary 4G in the moderate tier, and
            // preload="none" leaves duration NaN until play, which breaks
            // custom players that build their scrubber on loadedmetadata.
            // "metadata" still avoids downloading the media body.
            if (getConnectionTier() !== TIER_SLOW) return;
            if (video.hasAttribute('preload') || video.autoplay) return;
            if (!video.paused || video.currentTime > 0) return;
            video.setAttribute('preload', 'metadata');
        }

        function scanWithLayout() {
            const limit = foldLimit();
            let budget = MEDIA_SCAN_BUDGET;

            try {
                for (const img of document.images) {
                    if (budget-- <= 0) break;
                    tuneWithLayout(img, limit);
                }
                for (const frame of document.querySelectorAll('iframe')) {
                    if (budget-- <= 0) break;
                    tuneWithLayout(frame, limit);
                }
                for (const video of document.querySelectorAll('video')) {
                    if (budget-- <= 0) break;
                    tuneVideo(video);
                }
            } catch (_) {}
        }

        // Late-inserted media (infinite scroll, SPA routes) is where the real
        // byte savings are, and by then layout is available. Batching into a
        // frame also collapses the duplicate delivery a subtree observer sees
        // for a container and each of its children.
        function flushPending() {
            const batch = pending;
            pending = null;
            if (!batch) return;

            const limit = foldLimit();
            for (const el of batch) {
                try {
                    if (el.tagName === 'VIDEO') tuneVideo(el);
                    else tuneWithLayout(el, limit);
                } catch (_) {}
            }
        }

        function enqueue(el) {
            if (tunedImages.has(el)) return;
            tunedImages.add(el);

            if (!pending) {
                pending = new Set();
                window.requestAnimationFrame(flushPending);
            }
            if (pending.size < MEDIA_SCAN_BUDGET) pending.add(el);
        }

        const root = document.documentElement;
        if (root) {
            const observer = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (!(node instanceof Element)) continue;

                        try {
                            const tag = node.tagName;
                            if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') enqueue(node);
                            else if (node.firstElementChild) {
                                for (const el of node.querySelectorAll('img, video, iframe')) enqueue(el);
                            }
                        } catch (_) {}
                    }
                }
            });
            observer.observe(root, { childList: true, subtree: true });
        }

        runWhenDomReady(scanWithLayout);
        runWhenLoadedIdle(scanWithLayout);
    }

    if (isTopFrame) initMediaPriority();

    // =========================================================================
    // Part 8: content-visibility (opt-in)
    // =========================================================================
    //
    // Skipping layout and paint for offscreen sections is often a bigger win
    // than any network change on a low-end device, but it interacts badly with
    // sticky positioning, in-page anchors and some virtualised lists — so it
    // stays behind a per-origin toggle rather than defaulting on.

    const CV_MIN_HEIGHT = 300;
    const CV_MAX_ELEMENTS = 60;

    function contentVisibilityEnabled() {
        return rawRead(storeKey(CV_FLAG_KEY)) === '1';
    }

    function initContentVisibility() {
        if (!contentVisibilityEnabled()) return;
        if (typeof CSS === 'undefined' || !CSS.supports || !CSS.supports('content-visibility', 'auto')) return;

        const container = document.querySelector('main, [role="main"], article') || document.body;
        if (!container) return;

        const limit = (window.innerHeight || 0) * BELOW_FOLD_FACTOR;
        const candidates = [];

        // Measure everything first, then write: interleaving would thrash
        // layout once per section.
        for (const child of container.children) {
            if (candidates.length >= CV_MAX_ELEMENTS) break;
            if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') continue;

            const rect = child.getBoundingClientRect();
            if (rect.top <= limit || rect.height < CV_MIN_HEIGHT) continue;
            candidates.push([child, rect.height]);
        }

        for (const [child, height] of candidates) {
            // contain-intrinsic-size is what keeps the scrollbar and any
            // in-page anchor offsets stable while the section is skipped.
            child.style.setProperty('content-visibility', 'auto');
            child.style.setProperty('contain-intrinsic-size', 'auto ' + Math.round(height) + 'px');
        }
    }

    if (isTopFrame) runWhenLoadedIdle(initContentVisibility);

    // =========================================================================
    // Menu commands
    // =========================================================================
    //
    // The old commands reported a cache hit rate, which measured the machinery
    // rather than the outcome, and reported zeros in the two situations that
    // matter most: working-but-nothing-learned-yet, and switched-off. Each
    // feature now says which of the three it is.

    function statusReport() {
        const tier = getConnectionTier();
        const tierName = { 1: 'slow', 2: 'moderate', 3: 'fast' }[tier] || 'unknown';
        const route = pageKey();

        const lcpStore = readStore(LEARN_LCP_KEY);
        const originStore = readStore(LEARN_ORIGINS_KEY);
        const vitals = readStore(LEARN_VITALS_KEY);
        const transitions = readStore(LEARN_TRANSITIONS_KEY);
        const record = lcpStore && lcpStore[route];

        const lines = [];
        const feature = (mark, name, detail) => lines.push('  ' + mark + ' ' + name + '\n      ' + detail);

        // Read from the header so the two can't drift apart again (4.0.1
        // shipped reporting itself as 4.0.0).
        let version = '';
        try {
            version = GM_info.script.version || '';
        } catch (_) {}
        lines.push('Quicksilver ' + (version ? version + ' ' : '') + '— ' + location.origin + route);
        lines.push('');
        lines.push('ACTIVE ON THIS PAGE');

        let anchors = 0;
        try {
            anchors = document.querySelectorAll('a[href]').length;
        } catch (_) {}

        if (!supportsSpeculationRules) feature('○', 'Link speculation', 'not supported by this Chrome build');
        else if (tier === TIER_SLOW) feature('○', 'Link speculation', 'paused — connection is ' + tierName);
        else if (knownSpa) feature('○', 'Link speculation', SPA_OFF_REASON);
        else feature('●', 'Link speculation', anchors + ' eligible links on this page');

        if (learnedLcpUrl) {
            feature('●', 'Learned hero preload', 'preloading this route’s hero image');
        } else if (record) {
            const seen = Number(record.seen) || 0;
            const need = Math.max(0, LEARN_LCP_MIN_SIGHTINGS - seen);
            feature('◐', 'Learned hero preload', need > 0
                ? 'seen ' + seen + '× — ' + need + ' more visit' + (need === 1 ? '' : 's') + ' before it acts'
                : 'record exists but did not match this viewport');
        } else {
            feature('◐', 'Learned hero preload', 'no record for this route yet');
        }

        if (!supportsSpeculationRules) {
            feature('○', 'Next-page prediction', 'not supported by this Chrome build');
        } else if (tier === TIER_SLOW) {
            feature('○', 'Next-page prediction', 'paused — connection is ' + tierName);
        } else if (knownSpa) {
            feature('○', 'Next-page prediction', SPA_OFF_REASON);
        } else if (predictedTargets.length) {
            const next = predictedTargets[0];
            const how = next.count >= TRANSITION_PRERENDER_CONFIDENCE ? 'prerendering' : 'prefetching';
            feature('●', 'Next-page prediction', how + ' ' + next.path + ' (seen ' + next.count + '×)');
        } else {
            feature('◐', 'Next-page prediction',
                'learns where you go from here — prefetches after ' + TRANSITION_PREFETCH_CONFIDENCE
                + ' visit along the same path, prerenders after ' + TRANSITION_PRERENDER_CONFIDENCE);
        }

        feature(contentVisibilityEnabled() ? '●' : '○', 'Aggressive rendering',
            contentVisibilityEnabled() ? 'skipping layout for offscreen sections' : 'off for this origin');

        const samples = (vitals && Array.isArray(vitals.lcp) ? vitals.lcp : []).filter(Number.isFinite);
        let lcpText = 'no samples yet';
        if (samples.length) {
            const sorted = samples.slice().sort((a, b) => a - b);
            lcpText = Math.round(sorted[Math.floor(sorted.length / 2)]) + ' ms (median of ' + sorted.length + ')';
        }

        lines.push('');
        lines.push('LEARNED FOR THIS ORIGIN');
        lines.push('  Pages with a hero record   ' + (lcpStore ? Object.keys(lcpStore).length : 0));
        lines.push('  Critical origins           ' + ((originStore && Array.isArray(originStore.origins))
            ? originStore.origins.length : 0));
        lines.push('  Navigation sources         ' + (transitions ? Object.keys(transitions).length : 0));
        lines.push('  Median LCP                 ' + lcpText);
        lines.push('  Connection                 ' + tierName + ' (' + ((conn && conn.effectiveType) || 'unknown') + ')');

        const siteStats = readStore(STATS_KEY);
        const allStats = hasGmStorage ? readAllStats() : null;
        const siteNav = navCounts(siteStats);
        const allNav = navCounts(allStats);

        lines.push('');
        lines.push('MEASURED OUTCOMES');
        lines.push('  Same-site link clicks, this site');
        lines.push('      ' + describeNav(siteNav));
        if (allStats) {
            lines.push('  Same-site link clicks, all sites');
            lines.push('      ' + describeNav(allNav));
        }
        lines.push('  Hero preload was the real LCP');
        lines.push('      this site: ' + describeHero(siteStats)
            + (allStats ? '   all sites: ' + describeHero(allStats) : ''));

        // Zero hits over a real sample almost never means every guess was
        // wrong: it means Chrome isn't speculating at all.
        const sample = allStats ? allNav : siteNav;
        if (sample.total >= 10 && sample.served === 0) {
            lines.push('');
            lines.push('  Nothing has been served from a speculation in ' + sample.total + ' navigations.');
            lines.push('  Check Chrome Settings → Performance → "Preload pages", and Energy');
            lines.push('  Saver, which switches preloading off.');
        }

        return lines.join('\n');
    }

    const SPA_OFF_REASON = 'off — this site answers link clicks in-page, so a prefetched page is never used';

    function navCounts(stats) {
        const nav = (stats && stats.nav && typeof stats.nav === 'object') ? stats.nav : {};
        const prerender = Number(nav.prerender) || 0;
        const prefetch = Number(nav.prefetch) || 0;
        const miss = Number(nav.miss) || 0;
        return { prerender, prefetch, miss, served: prerender + prefetch, total: prerender + prefetch + miss };
    }

    function describeNav(counts) {
        if (!counts.total) return 'none measured yet';
        return Math.round(counts.served * 100 / counts.total) + '% hit (' + counts.served + ' of ' + counts.total
            + ') — prerendered ' + counts.prerender + ', prefetched ' + counts.prefetch + ', missed ' + counts.miss;
    }

    function describeHero(stats) {
        const hero = (stats && stats.hero && typeof stats.hero === 'object') ? stats.hero : {};
        const hit = Number(hero.hit) || 0;
        const total = hit + (Number(hero.miss) || 0);
        return total ? hit + ' of ' + total : 'none yet';
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Quicksilver: Status', () => {
            alert(statusReport());
        });

        GM_registerMenuCommand('Quicksilver: Forget this site', () => {
            for (const key of ORIGIN_KEYS) deleteStore(key);
            learnedLcpUrl = null;
            emittedPreloadFor = null;
            predictedTargets = [];
            alert('Quicksilver forgot everything learned for ' + location.origin
                + '.\n\nThe aggressive-rendering preference was kept.');
        });

        GM_registerMenuCommand('Quicksilver: Forget navigation history (this site)', () => {
            deleteStore(LEARN_TRANSITIONS_KEY);
            predictedTargets = [];
            alert('Quicksilver forgot every page-to-page transition learned for '
                + location.origin + '.');
        });

        GM_registerMenuCommand('Quicksilver: Toggle aggressive rendering', () => {
            const next = contentVisibilityEnabled() ? '0' : '1';
            rawWrite(storeKey(CV_FLAG_KEY), next);
            alert('Aggressive rendering ' + (next === '1' ? 'enabled' : 'disabled')
                + ' for this origin. Reload to apply.\n\nSkips layout and paint for offscreen '
                + 'sections. Disable if dropdowns or tooltips appear clipped at a section '
                + 'edge, or if sticky headers or in-page anchors misbehave.');
        });
    }
})();
