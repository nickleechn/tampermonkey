// ==UserScript==
// @name YouTube SuperSharp
// @namespace http://tampermonkey.net/
// @version 1.1
// @description Automatically sets YouTube videos to the highest quality available, prioritizing 1080p Premium for Premium users using the player API (no UI/overlay).
// @match https://www.youtube.com/*
// @run-at document-idle
// @grant none
// ==/UserScript==
(function () {
  'use strict';

  let lastPlayer = null;
  let isProcessing = false;

  // --- Detect Safari ---
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  // --- Robust player getter ---
  function getPlayer() {
    try {
      const api = document.querySelector('ytd-player')?.getPlayer?.();
      return api || document.querySelector('#movie_player') || null;
    } catch (e) {
      console.error('[YT Auto HQ] Error in getPlayer:', e);
      return null;
    }
  }

  // --- Set highest quality ---
  function setHighestQualityOnce(player) {
    try {
      if (!player || typeof player.getAvailableQualityLevels !== 'function') {
        console.debug('[YT Auto HQ] No player or getAvailableQualityLevels not available');
        return false;
      }

      // Broader state check for Safari
      const state = player.getPlayerState && player.getPlayerState();
      if (state === undefined || ![1, 2, 3].includes(state)) {
        console.debug('[YT Auto HQ] Player not ready, state:', state);
        return false;
      }

      const levels = player.getAvailableQualityLevels();
      if (!Array.isArray(levels) || levels.length === 0) {
        console.debug('[YT Auto HQ] No quality levels available');
        return false;
      }

      const premium1080p = levels.find((q) => q === 'hd1080premium');
      const validLevels = levels.filter((q) => q !== 'auto');
      const highest = premium1080p || validLevels[0] || levels[0];

      // Try quality setting with fallback
      try {
        if (typeof player.setPlaybackQualityRange === 'function') {
          player.setPlaybackQualityRange(highest, highest);
        } else if (typeof player.setPlaybackQuality === 'function') {
          player.setPlaybackQuality(highest);
        } else {
          console.debug('[YT Auto HQ] No quality setting method available');
          return false;
        }
      } catch (e) {
        console.error('[YT Auto HQ] Error setting quality:', e);
        return false;
      }

      console.debug('[YT Auto HQ] Set quality to', highest, 'from', levels);
      return true;
    } catch (e) {
      console.error('[YT Auto HQ] Error in setHighestQualityOnce:', e);
      return false;
    }
  }

  // --- Retry logic with Safari-adjusted timing ---
  function init() {
    if (isProcessing) {
      console.debug('[YT Auto HQ] Already processing, skipping');
      return;
    }
    isProcessing = true;

    const player = getPlayer();
    if (!player || player === lastPlayer) {
      isProcessing = false;
      return;
    }
    lastPlayer = player;

    let attempts = 0;
    const maxAttempts = isSafari ? 10 : 15; // Shorter retry for Safari
    const interval = isSafari ? 500 : 250; // Slower retries for Safari
    const timer = setInterval(() => {
      attempts++;
      if (setHighestQualityOnce(player) || attempts >= maxAttempts) {
        clearInterval(timer);
        isProcessing = false;
        if (attempts >= maxAttempts) {
          console.debug('[YT Auto HQ] Max attempts reached');
        }
      }
    }, interval);
  }

  // --- Start with delay for Safari ---
  function start() {
    const delay = isSafari ? 1000 : 0; // 1s delay for Safari
    setTimeout(init, delay);
  }

  // Initial run and SPA event listeners
  start();
  document.addEventListener('yt-navigate-finish', start, { passive: true });
  document.addEventListener('yt-page-data-updated', start, { passive: true });
})();
