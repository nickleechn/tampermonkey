// ==UserScript==
// @name YouTube SuperSharp
// @namespace http://tampermonkey.net/
// @version 0.9
// @description Automatically sets YouTube videos to the highest quality available, prioritizing 1080p Premium for Premium users using the player API (no UI/overlay).
// @match https://www.youtube.com/*
// @run-at document-idle
// @grant none
// ==/UserScript==
(function () {
  'use strict';
  // --- Robust player getter ---
  function getPlayer() {
    try {
      const api = document.querySelector('ytd-player')?.getPlayer?.();
      if (api) return api;
      return (
        document.querySelector('#movie_player') ||
        document.getElementsByClassName('html5-video-player')[0] ||
        null
      );
    } catch (e) {
      console.error('[YT Auto HQ] Error in getPlayer:', e);
      return null;
    }
  }
  // --- Set highest quality with explicit 1080p Premium support ---
  function setHighestQualityOnce() {
    try {
      const player = getPlayer();
      if (!player) {
        console.debug('[YT Auto HQ] No player found');
        return false;
      }
      if (typeof player.getAvailableQualityLevels !== 'function') {
        console.debug('[YT Auto HQ] getAvailableQualityLevels not available');
        return false;
      }
      // Check if player is ready (state 1 = playing, 2 = paused, etc.)
      if (player.getPlayerState && ![1, 2].includes(player.getPlayerState())) {
        console.debug('[YT Auto HQ] Player not ready, state:', player.getPlayerState());
        return false;
      }
      const levels = player.getAvailableQualityLevels();
      if (!Array.isArray(levels) || levels.length === 0) {
        console.debug('[YT Auto HQ] No quality levels available');
        return false;
      }
      // Explicitly prioritize 'hd1080premium' first
      const premium1080p = levels.find((q) => q === 'hd1080premium');
      // Otherwise, exclude 'auto' and pick highest non-auto level
      const validLevels = levels.filter((q) => q !== 'auto' && q !== 'hd1080premium');
      const highest = premium1080p || validLevels[0] || levels[0];
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(highest);
      }
      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(highest, highest);
      }
      console.debug('[YT Auto HQ] Set quality to', highest, 'from', levels, 'Premium 1080p:', !!premium1080p);
      return true;
    } catch (e) {
      console.error('[YT Auto HQ] Error in setHighestQualityOnce:', e);
      return false;
    }
  }
  // --- Retry loop ---
  function init() {
    let attempts = 0;
    const maxAttempts = 40; // ~10s @ 250ms
    const timer = setInterval(() => {
      attempts++;
      console.debug('[YT Auto HQ] Attempt', attempts);
      if (setHighestQualityOnce() || attempts >= maxAttempts) {
        clearInterval(timer);
        if (attempts >= maxAttempts) {
          console.debug('[YT Auto HQ] Max attempts reached');
        }
      }
    }, 250); // Faster retries for responsiveness
  }
  // --- Observe DOM for player changes ---
  function observePlayer() {
    const observer = new MutationObserver((mutations, obs) => {
      if (getPlayer()) {
        init();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
  // Run now and on SPA navigations
  init();
  document.addEventListener('yt-navigate-finish', init, { passive: true });
  document.addEventListener('yt-page-data-updated', init, { passive: true });
  observePlayer();
})();
