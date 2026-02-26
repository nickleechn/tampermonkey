// ==UserScript==
// @name         CrystalEye
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automatically forces YouTube to the highest available resolution (4K/8K when available).
// @author       You
// @match        *://*.youtube.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const QUALITY_ORDER = [
        'highres', 'hd2160', 'hd1440', 'hd1080',
        'hd720', 'large', 'medium', 'small', 'tiny'
    ];

    let lastVideoId = null;

    function getPlayer() {
        const el = document.getElementById('movie_player');
        if (el && typeof el.getAvailableQualityLevels === 'function') return el;
        return null;
    }

    function getVideoId() {
        const params = new URLSearchParams(location.search);
        return params.get('v') || '';
    }

    async function forceMaxQuality() {
        const videoId = getVideoId();
        if (!videoId) return;

        // Avoid re-applying for the same video
        if (videoId === lastVideoId) return;

        const player = getPlayer();
        if (!player) return;

        // Poll for available quality levels (they load asynchronously)
        let qualities = [];
        for (let i = 0; i < 40; i++) {
            qualities = player.getAvailableQualityLevels();
            if (qualities && qualities.length > 0) break;
            await new Promise(r => setTimeout(r, 250));
        }

        if (!qualities || qualities.length === 0) {
            console.log('[CrystalEye] No quality levels available');
            return;
        }

        // Pick the highest available quality (filter out 'auto')
        const real = qualities.filter(q => q !== 'auto');
        if (real.length === 0) return;
        const best = real[0];
        const current = player.getPlaybackQuality();

        if (current === best) {
            console.log(`[CrystalEye] Already at max: ${best}`);
            lastVideoId = videoId;
            return;
        }

        player.setPlaybackQualityRange(best, best);
        lastVideoId = videoId;
        console.log(`[CrystalEye] Set quality: ${current} -> ${best} (from ${qualities.length} options)`);
    }

    // --- SPA NAVIGATION HANDLING ---
    // YouTube fires this custom event on client-side navigation
    document.addEventListener('yt-navigate-finish', () => {
        lastVideoId = null; // Reset so we re-apply
        setTimeout(forceMaxQuality, 500);
    });

    // Also handle player state changes (e.g. ad -> video transition)
    function hookPlayerState() {
        const player = getPlayer();
        if (!player || player.__crystalEyeHooked) return;

        if (typeof player.addEventListener === 'function') {
            player.addEventListener('onStateChange', (state) => {
                // State 1 = playing, -1 = unstarted (new video loading)
                if (state === 1 || state === -1) {
                    lastVideoId = null;
                    setTimeout(forceMaxQuality, 300);
                }
            });
            player.__crystalEyeHooked = true;
            console.log('[CrystalEye] Player state hook attached');
        }
    }

    // --- MENU COMMAND ---
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Show Current Quality', () => {
            const player = getPlayer();
            if (!player) {
                alert('No YouTube player found on this page.');
                return;
            }
            const current = player.getPlaybackQuality();
            const available = player.getAvailableQualityLevels();
            alert(`Current: ${current}\nAvailable: ${available.join(', ')}`);
        });
    }

    // --- INIT ---
    // Initial run + hook setup
    setTimeout(() => {
        forceMaxQuality();
        hookPlayerState();
    }, 1000);

    // Retry hook attachment for late-loading players
    setTimeout(hookPlayerState, 3000);

    console.log('[CrystalEye] Loaded');
})();
