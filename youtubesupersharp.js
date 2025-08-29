// ==UserScript==
// @name YouTube SuperSharp Enhanced
// @namespace http://tampermonkey.net/
// @version 1.2
// @description Enhanced YouTube auto quality with better debugging
// @match https://www.youtube.com/*
// @run-at document-idle
// @grant none
// ==/UserScript==

(function () {
  'use strict';
  
  let lastVideoId = null;
  let isProcessing = false;
  const DEBUG = true; // Set to false to reduce console spam
  
  function log(...args) {
    if (DEBUG) console.log('[YT SuperSharp]', ...args);
  }
  
  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v');
  }
  
  function getPlayer() {
    try {
      // Try multiple selectors for robustness
      const selectors = [
        'ytd-player',
        '#movie_player',
        '.html5-video-player',
        '[data-youtube-player]'
      ];
      
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element?.getPlayer) {
          return element.getPlayer();
        }
        if (element?.getAvailableQualityLevels) {
          return element;
        }
      }
      
      return null;
    } catch (e) {
      log('Error in getPlayer:', e);
      return null;
    }
  }
  
  function setHighestQuality(player) {
    try {
      if (!player) {
        log('No player found');
        return false;
      }
      
      // Log available methods for debugging
      if (DEBUG) {
        log('Player methods:', Object.getOwnPropertyNames(player).filter(m => m.includes('quality') || m.includes('Quality')));
      }
      
      if (typeof player.getAvailableQualityLevels !== 'function') {
        log('getAvailableQualityLevels not available');
        return false;
      }
      
      const state = player.getPlayerState?.();
      log('Player state:', state);
      
      // Be more permissive with player states
      if (state !== undefined && state < 0) {
        log('Player not ready, state:', state);
        return false;
      }
      
      const levels = player.getAvailableQualityLevels();
      log('Available qualities:', levels);
      
      if (!Array.isArray(levels) || levels.length === 0) {
        log('No quality levels available');
        return false;
      }
      
      // Quality priority: Premium 1080p > highest non-auto > any
      const qualityPriority = [
        'hd1080premium', 'hd2160', 'hd1440', 'hd1080', 
        'hd720', 'large', 'medium', 'small'
      ];
      
      let selectedQuality = null;
      for (const quality of qualityPriority) {
        if (levels.includes(quality)) {
          selectedQuality = quality;
          break;
        }
      }
      
      if (!selectedQuality) {
        const nonAutoLevels = levels.filter(q => q !== 'auto');
        selectedQuality = nonAutoLevels[0] || levels[0];
      }
      
      log('Setting quality to:', selectedQuality);
      
      // Try multiple setting methods
      const methods = ['setPlaybackQualityRange', 'setPlaybackQuality'];
      let success = false;
      
      for (const method of methods) {
        if (typeof player[method] === 'function') {
          try {
            if (method === 'setPlaybackQualityRange') {
              player[method](selectedQuality, selectedQuality);
            } else {
              player[method](selectedQuality);
            }
            success = true;
            log('Quality set using', method);
            break;
          } catch (e) {
            log('Error with', method, ':', e);
          }
        }
      }
      
      return success;
      
    } catch (e) {
      log('Error in setHighestQuality:', e);
      return false;
    }
  }
  
  function init() {
    const currentVideoId = getVideoId();
    if (!currentVideoId) return;
    
    if (isProcessing || currentVideoId === lastVideoId) {
      log('Skipping - processing or same video');
      return;
    }
    
    log('Processing video:', currentVideoId);
    isProcessing = true;
    lastVideoId = currentVideoId;
    
    let attempts = 0;
    const maxAttempts = 20;
    const interval = 300;
    
    const timer = setInterval(() => {
      attempts++;
      const player = getPlayer();
      
      if (setHighestQuality(player) || attempts >= maxAttempts) {
        clearInterval(timer);
        isProcessing = false;
        log(attempts >= maxAttempts ? 'Max attempts reached' : 'Quality set successfully');
      }
    }, interval);
  }
  
  // Event listeners
  function addListeners() {
    // YouTube SPA navigation
    document.addEventListener('yt-navigate-finish', init, { passive: true });
    document.addEventListener('yt-page-data-updated', init, { passive: true });
    
    // Fallback for URL changes
    let lastUrl = location.href;
    new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        setTimeout(init, 500);
      }
    }).observe(document, { subtree: true, childList: true });
  }
  
  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        addListeners();
        init();
      }, 1000);
    });
  } else {
    addListeners();
    init();
  }
})();
