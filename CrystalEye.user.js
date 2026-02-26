// ==UserScript==
// @name         CrystalEye
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Automatically locks YouTube to the highest available resolution (4K/8K). Uses DOM-based selection so it truly overrides Auto.
// @author       You
// @match        *://*.youtube.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    let lastVideoId = null;
    let pending = false;

    function getVideoId() {
        const params = new URLSearchParams(location.search);
        return params.get('v') || '';
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // Wait for an element matching a selector to appear (up to timeout ms)
    function waitForElement(selector, root, timeout = 3000) {
        return new Promise((resolve) => {
            const el = (root || document).querySelector(selector);
            if (el) { resolve(el); return; }

            const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
            const obs = new MutationObserver(() => {
                const el = (root || document).querySelector(selector);
                if (el) { obs.disconnect(); clearTimeout(timer); resolve(el); }
            });
            obs.observe(root || document.body, { childList: true, subtree: true });
        });
    }

    // Core: click through Settings > Quality > highest option
    async function forceMaxQuality() {
        const videoId = getVideoId();
        if (!videoId || videoId === lastVideoId || pending) return;

        // Wait for the player and settings button to exist
        const settingsBtn = await waitForElement('.ytp-settings-button', document, 10000);
        if (!settingsBtn) {
            console.log('[CrystalEye] Settings button not found');
            return;
        }

        // Wait for quality data to be populated (means video is loaded enough)
        const player = document.getElementById('movie_player');
        if (player && typeof player.getAvailableQualityLevels === 'function') {
            for (let i = 0; i < 40; i++) {
                const q = player.getAvailableQualityLevels();
                if (q && q.length > 1) break;
                await sleep(250);
            }
        }

        // Check if already manually set to highest (not Auto)
        if (player && typeof player.getPreferredQuality === 'function') {
            const pref = player.getPreferredQuality();
            if (pref && pref !== 'auto') {
                const avail = player.getAvailableQualityLevels().filter(q => q !== 'auto');
                if (avail.length > 0 && pref === avail[0]) {
                    console.log(`[CrystalEye] Already locked to max: ${pref}`);
                    lastVideoId = videoId;
                    return;
                }
            }
        }

        pending = true;

        try {
            // Step 1: Open settings menu
            settingsBtn.click();
            await sleep(250);

            // Step 2: Find and click the "Quality" row
            const menuItems = document.querySelectorAll('.ytp-settings-menu .ytp-menuitem');
            let qualityRow = null;
            for (const item of menuItems) {
                const label = item.querySelector('.ytp-menuitem-label');
                if (label && label.textContent.trim() === 'Quality') {
                    qualityRow = item;
                    break;
                }
            }

            if (!qualityRow) {
                console.log('[CrystalEye] Quality row not found in settings');
                settingsBtn.click(); // close
                pending = false;
                return;
            }

            qualityRow.click();
            await sleep(250);

            // Step 3: Find the highest quality option (first menuitemradio)
            const qualityOptions = document.querySelectorAll(
                '.ytp-settings-menu .ytp-menuitem[role="menuitemradio"]'
            );

            if (qualityOptions.length === 0) {
                console.log('[CrystalEye] No quality options found');
                settingsBtn.click();
                pending = false;
                return;
            }

            // First radio option is always the highest resolution
            const best = qualityOptions[0];
            const bestLabel = best.querySelector('.ytp-menuitem-label');
            const label = bestLabel ? bestLabel.textContent.trim() : 'unknown';

            if (best.getAttribute('aria-checked') === 'true') {
                console.log(`[CrystalEye] Already at max: ${label}`);
                settingsBtn.click(); // close
                lastVideoId = videoId;
                pending = false;
                return;
            }

            // Click the highest quality
            best.click();
            lastVideoId = videoId;
            console.log(`[CrystalEye] Locked to: ${label}`);

        } catch (err) {
            console.warn('[CrystalEye] Error:', err);
            // Try to close menu if it's open
            try { settingsBtn.click(); } catch (_) {}
        }

        pending = false;
    }

    // --- SPA NAVIGATION ---
    document.addEventListener('yt-navigate-finish', () => {
        lastVideoId = null;
        setTimeout(forceMaxQuality, 1000);
    });

    // --- PLAYER STATE CHANGES (ad -> video, playlist advancement) ---
    function hookPlayerState() {
        const player = document.getElementById('movie_player');
        if (!player || player.__crystalEyeHooked) return;
        if (typeof player.addEventListener !== 'function') return;

        player.addEventListener('onStateChange', (state) => {
            // -1 = unstarted (new video), 1 = playing
            if (state === -1 || state === 1) {
                // Only re-apply if the video ID changed
                const vid = getVideoId();
                if (vid && vid !== lastVideoId) {
                    setTimeout(forceMaxQuality, 800);
                }
            }
        });
        player.__crystalEyeHooked = true;
        console.log('[CrystalEye] Player hook attached');
    }

    // --- MENU COMMAND ---
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Show Quality Info', () => {
            const player = document.getElementById('movie_player');
            if (!player || typeof player.getPlaybackQuality !== 'function') {
                alert('No YouTube player found.');
                return;
            }
            const current = player.getPlaybackQuality();
            const preferred = player.getPreferredQuality();
            const available = player.getAvailableQualityLevels();
            alert(
                `Playing: ${player.getPlaybackQualityLabel()}\n` +
                `Quality key: ${current}\n` +
                `Preferred: ${preferred}\n` +
                `Available: ${available.join(', ')}`
            );
        });
    }

    // --- INIT ---
    setTimeout(() => {
        forceMaxQuality();
        hookPlayerState();
    }, 1500);

    setTimeout(hookPlayerState, 4000);

    console.log('[CrystalEye] v2.0 loaded');
})();
