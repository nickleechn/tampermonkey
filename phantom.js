// ==UserScript==
// @name         Phantom
// @namespace    https://github.com/user/phantom
// @version      1.4
// @description  Automatically denies privacy-invasive browser API requests (location, camera, mic, notifications, etc.)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[Phantom]';
    const log = (msg) => console.info(`${LOG_PREFIX} ${msg}`);

    // Helper: safely override a property on a prototype or object
    function override(obj, prop, descriptor) {
        try {
            Object.defineProperty(obj, prop, { configurable: true, ...descriptor });
        } catch (e) {
            if ('value' in descriptor) obj[prop] = descriptor.value;
        }
    }

    // --- Geolocation ---
    if (navigator.geolocation) {
        override(Geolocation.prototype, 'getCurrentPosition', {
            value: function (_success, error) {
                log('Blocked getCurrentPosition');
                if (error) error({ code: 1, message: 'User denied Geolocation' });
            },
        });
        override(Geolocation.prototype, 'watchPosition', {
            value: function (_success, error) {
                log('Blocked watchPosition');
                if (error) error({ code: 1, message: 'User denied Geolocation' });
                return 0;
            },
        });
    }

    // --- Camera / Microphone ---
    if (navigator.mediaDevices) {
        override(MediaDevices.prototype, 'getUserMedia', {
            value: function () {
                log('Blocked getUserMedia');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
        override(MediaDevices.prototype, 'getDisplayMedia', {
            value: function () {
                log('Blocked getDisplayMedia');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
        override(MediaDevices.prototype, 'enumerateDevices', {
            value: function () {
                log('Blocked enumerateDevices');
                return Promise.resolve([]);
            },
        });
    }

    // --- Notifications ---
    if (window.Notification) {
        Object.defineProperty(Notification, 'permission', {
            get: () => 'denied',
            configurable: true,
        });
        Notification.requestPermission = function () {
            log('Blocked Notification.requestPermission');
            return Promise.resolve('denied');
        };
    }

    // --- Clipboard read ---
    if (navigator.clipboard) {
        override(Clipboard.prototype, 'readText', {
            value: function () {
                log('Blocked clipboard.readText');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
        override(Clipboard.prototype, 'read', {
            value: function () {
                log('Blocked clipboard.read');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Installed Related Apps ---
    if (navigator.getInstalledRelatedApps) {
        override(Navigator.prototype, 'getInstalledRelatedApps', {
            value: function () {
                log('Blocked getInstalledRelatedApps');
                return Promise.resolve([]);
            },
        });
    }

    // --- Hardware APIs (Bluetooth, USB, HID, Serial, NFC) ---
    const hardwareApis = [
        { obj: navigator.bluetooth, proto: window.Bluetooth?.prototype, method: 'requestDevice' },
        { obj: navigator.usb, proto: window.USB?.prototype, method: 'requestDevice' },
        { obj: navigator.hid, proto: window.HID?.prototype, method: 'requestDevice' },
        { obj: navigator.serial, proto: window.Serial?.prototype, method: 'requestPort' },
        { obj: window.NDEFReader, proto: window.NDEFReader?.prototype, method: 'scan' },
        { obj: window.NDEFReader, proto: window.NDEFReader?.prototype, method: 'write' }
    ];

    hardwareApis.forEach(({ obj, proto, method }) => {
        if (obj && proto) {
            override(proto, method, {
                value: function () {
                    log(`Blocked ${method} on hardware API`);
                    return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
                },
            });
        }
    });

    // --- Battery Status ---
    if (navigator.getBattery) {
        override(Navigator.prototype, 'getBattery', {
            value: function () {
                log('Blocked getBattery');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Device Motion / Orientation ---
    for (const evt of ['devicemotion', 'deviceorientation', 'deviceorientationabsolute']) {
        window.addEventListener(evt, (e) => {
            e.stopImmediatePropagation();
            log(`Blocked ${evt} event`);
        }, true);
    }
    for (const prop of ['ondevicemotion', 'ondeviceorientation', 'ondeviceorientationabsolute']) {
        Object.defineProperty(window, prop, {
            set: () => log(`Blocked setting ${prop}`),
            get: () => null,
            configurable: true,
        });
    }

    // --- Permissions API ---
    // [GEMINI NOTE]: Replaced the raw EventTarget mock with Object.create(PermissionStatus.prototype) 
    // to bypass strict `instanceof PermissionStatus` type-checking that broke some sites.
    if (navigator.permissions) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        override(Permissions.prototype, 'query', {
            value: function (desc) {
                const blockedPermissions = new Set([
                    'geolocation', 'notifications', 'camera', 'microphone',
                    'magnetometer', 'accelerometer', 'gyroscope',
                    'ambient-light-sensor', 'bluetooth', 'nfc',
                    'idle-detection', 'screen-wake-lock',
                    'window-management', 'local-fonts',
                ]);
                if (desc && blockedPermissions.has(desc.name)) {
                    log(`Permissions.query: denied "${desc.name}"`);
                    
                    const fakeStatus = Object.create(PermissionStatus.prototype || Object.prototype);
                    Object.defineProperty(fakeStatus, 'state', { value: 'denied', enumerable: true });
                    Object.defineProperty(fakeStatus, 'name', { value: desc.name, enumerable: true });
                    fakeStatus.onchange = null;
                    
                    return Promise.resolve(fakeStatus);
                }
                return originalQuery(desc);
            },
        });
    }

    // --- Idle Detection ---
    if (window.IdleDetector) {
        IdleDetector.requestPermission = function () {
            log('Blocked IdleDetector.requestPermission');
            return Promise.resolve('denied');
        };
        override(IdleDetector.prototype, 'start', {
            value: function () {
                log('Blocked IdleDetector.start');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Wake Lock ---
    if (navigator.wakeLock) {
        override(WakeLock.prototype, 'request', {
            value: function () {
                log('Blocked wakeLock.request');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Window Management (multi-screen) ---
    if (window.getScreenDetails) {
        override(Window.prototype, 'getScreenDetails', {
            value: function () {
                log('Blocked getScreenDetails');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Local Font Access ---
    if (window.queryLocalFonts) {
        override(Window.prototype, 'queryLocalFonts', {
            value: function () {
                log('Blocked queryLocalFonts');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- SendBeacon ---
    override(Navigator.prototype, 'sendBeacon', {
        value: function (url) {
            log(`Blocked sendBeacon to ${url}`);
            return true;
        },
    });

    // --- Network Information ---
    if (navigator.connection) {
        override(Navigator.prototype, 'connection', {
            get: function () {
                log('Blocked navigator.connection');
                return undefined;
            },
        });
    }

    // --- Canvas Fingerprinting ---
    // [GEMINI NOTE]: Added try/catch block to `poisonCanvas`. If a site draws a cross-origin image 
    // to a canvas, it becomes "tainted". Calling `getImageData` on it throws a SecurityError. 
    // Failing to catch this crashes the entire userscript and halts page execution.
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    const poisonCanvas = (canvas) => {
        if (canvas.width > 16 && canvas.height > 16) {
            try {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const pixel = originalGetImageData.call(ctx, 0, 0, 1, 1);
                    pixel.data[0] = (pixel.data[0] + Math.floor(Math.random() * 3)) % 256;
                    ctx.putImageData(pixel, 0, 0);
                    log('Poisoned canvas fingerprint');
                }
            } catch (e) {
                // Ignore SecurityError on tainted canvases
            }
        }
    };

    override(HTMLCanvasElement.prototype, 'toDataURL', {
        value: function () {
            poisonCanvas(this);
            return originalToDataURL.apply(this, arguments);
        },
    });

    override(HTMLCanvasElement.prototype, 'toBlob', {
        value: function () {
            poisonCanvas(this);
            return originalToBlob.apply(this, arguments);
        },
    });

    // --- AudioContext Fingerprinting ---
    if (window.AudioContext || window.webkitAudioContext) {
        const originalGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
        override(AnalyserNode.prototype, 'getFloatFrequencyData', {
            value: function (array) {
                originalGetFloatFreq.call(this, array);
                for (let i = 0; i < array.length; i++) {
                    array[i] += (Math.random() - 0.5) * 0.1;
                }
                log('Poisoned AudioContext getFloatFrequencyData');
            },
        });

        // [GEMINI NOTE]: Previously returned a completely silent buffer. This broke web audio apps. 
        // Now it awaits the actual render and injects subtle noise into the real audio data.
        const originalStartRendering = OfflineAudioContext.prototype.startRendering;
        override(OfflineAudioContext.prototype, 'startRendering', {
            value: async function () {
                const buffer = await originalStartRendering.call(this);
                if (buffer && buffer.numberOfChannels > 0) {
                    const channel = buffer.getChannelData(0);
                    for (let i = 0; i < channel.length; i++) {
                        channel[i] += (Math.random() - 0.5) * 1e-7;
                    }
                    log('Poisoned OfflineAudioContext render');
                }
                return buffer;
            },
        });
    }

    // --- WebRTC IP Leak Prevention ---
    // [GEMINI NOTE]: Added `safeConfig` cloning. Some sites pass a frozen object to RTCPeerConnection. 
    // Mutating `config.iceTransportPolicy` directly caused a TypeError that broke WebRTC entirely.
    if (window.RTCPeerConnection) {
        const OriginalRTC = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends OriginalRTC {
            constructor(config) {
                const safeConfig = config ? { ...config } : {};
                safeConfig.iceTransportPolicy = 'relay';
                super(safeConfig);
                log('WebRTC forced to relay-only');
            }
        };
        if (window.webkitRTCPeerConnection) {
            window.webkitRTCPeerConnection = window.RTCPeerConnection;
        }
    }

    // --- WebGL Renderer Fingerprinting ---
    const getParamBlock = new Set([0x9245, 0x9246]);
    for (const CtxProto of [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
        const originalGetParameter = CtxProto.getParameter;
        override(CtxProto, 'getParameter', {
            value: function (param) {
                if (getParamBlock.has(param)) {
                    log(`Spoofed WebGL getParameter(0x${param.toString(16)})`);
                    return 'Generic GPU';
                }
                return originalGetParameter.call(this, param);
            },
        });
        const originalGetExtension = CtxProto.getExtension;
        override(CtxProto, 'getExtension', {
            value: function (name) {
                if (name === 'WEBGL_debug_renderer_info') {
                    log('Blocked WEBGL_debug_renderer_info extension');
                    return null;
                }
                return originalGetExtension.call(this, name);
            },
        });
    }

    // --- Navigator Property Normalization ---
    const navSpoofs = {
        hardwareConcurrency: 8,
        deviceMemory: 8,
        platform: 'MacIntel',
        vendor: 'Google Inc.',
    };
    for (const [prop, val] of Object.entries(navSpoofs)) {
        override(Navigator.prototype, prop, {
            get: () => {
                log(`Spoofed navigator.${prop}`);
                return val;
            },
        });
    }
    override(Navigator.prototype, 'languages', {
        get: () => {
            log('Spoofed navigator.languages');
            return Object.freeze(['en-US', 'en']);
        },
    });
    override(Navigator.prototype, 'language', { get: () => 'en-US' });

    // --- Screen Property Normalization ---
    const screenSpoofs = {
        width: 1920, height: 1080,
        availWidth: 1920, availHeight: 1080,
        colorDepth: 24, pixelDepth: 24,
    };
    for (const [prop, val] of Object.entries(screenSpoofs)) {
        override(Screen.prototype, prop, {
            get: () => {
                log(`Spoofed screen.${prop}`);
                return val;
            },
        });
    }
    override(Window.prototype, 'devicePixelRatio', {
        get: () => {
            log('Spoofed devicePixelRatio');
            return 1;
        },
    });

    // --- performance.now() Precision Reduction ---
    const originalPerfNow = Performance.prototype.now;
    override(Performance.prototype, 'now', {
        value: function () {
            return Math.round(originalPerfNow.call(this) * 10) / 10;
        },
    });

    // --- window.name Supercookie ---
    // [GEMINI NOTE]: Removed the getter/setter override entirely. Hard-blocking window.name 
    // broke OAuth flows (like Google/Facebook login) and cross-origin communication. 
    // Simply clearing it on script load removes stale tracking data without breaking active sessions.
    if (window.name) {
        log(`Cleared window.name supercookie on load`);
        window.name = '';
    }

    // --- Visibility API ---
    override(Document.prototype, 'hidden', { get: () => false });
    override(Document.prototype, 'visibilityState', { get: () => 'visible' });
    
    const originalDocAddListener = Document.prototype.addEventListener;
    override(Document.prototype, 'addEventListener', {
        value: function (type, listener, options) {
            if (type === 'visibilitychange') {
                log('Blocked visibilitychange listener');
                return;
            }
            return originalDocAddListener.call(this, type, listener, options);
        },
    });

    // --- Cookie Consent Auto-Dismiss (reject all) ---
    const cookieDismiss = () => {
        const rejectSelectors = [
            '#onetrust-reject-all-handler', '.onetrust-close-btn-handler',
            '#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
            '.qc-cmp2-summary-buttons button[mode="secondary"]', '[class*="qc-cmp"][class*="reject"]',
            '.truste_overlay .pdynamicbutton .call', '#truste-consent-required',
            '#didomi-notice-disagree-button', '[data-choice="deny"]',
            '.klaro .cm-btn-decline', '.cmplz-deny', '.cky-btn-reject', '.osano-cm-deny',
            '[data-testid="cookie-reject"]', '[data-cookiefirst-action="reject"]',
            'button[aria-label*="reject" i]', 'button[aria-label*="decline" i]',
            'button[aria-label*="deny" i]', 'button[aria-label*="refuse" i]',
        ];

        const bannerSelectors = [
            '#cookie-banner', '#cookie-consent', '#cookie-notice', '#cookie-bar',
            '#gdpr-banner', '#gdpr-consent', '#consent-banner', '#consent-popup',
            '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
            '[class*="gdpr"]', '[class*="consent-banner"]', '[class*="consent-popup"]',
            '[id*="cookie"]', '[class*="cc-banner"]', '[class*="cc_banner"]', '[class*="CookieConsent"]',
        ];

        const rejectPatterns = /^(reject|decline|deny|refuse|no thanks|only necessary|only essential|essentials only|necessary only|manage|settings|preferences|customize)/i;

        for (const sel of rejectSelectors) {
            const btn = document.querySelector(sel);
            // [GEMINI NOTE]: Changed strict `!== null` to `!= null` to catch both null and undefined.
            // SVG elements return undefined for `offsetParent`, so the strict check failed on banners using SVGs.
            if (btn && btn.offsetParent != null) { 
                btn.click();
                log(`Cookie banner dismissed via: ${sel}`);
                return true;
            }
        }

        for (const bannerSel of bannerSelectors) {
            const banner = document.querySelector(bannerSel);
            if (!banner || banner.offsetParent == null) continue;

            const buttons = banner.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (rejectPatterns.test(text)) {
                    btn.click();
                    log(`Cookie banner dismissed via text match: "${text}"`);
                    return true;
                }
            }
        }
        return false;
    };

    const startCookieDismiss = () => {
        if (cookieDismiss()) return;

        let attempts = 0;
        let debounceTimer;
        
        // [GEMINI NOTE]: Added a 300ms debounce. Running `querySelectorAll` across the whole document 
        // on every single DOM node mutation locked up the main thread on heavy single-page applications. 
        // This ensures it only checks after the DOM settles.
        const observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (cookieDismiss() || ++attempts > 50) {
                    observer.disconnect();
                }
            }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => observer.disconnect(), 15000);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCookieDismiss);
    } else {
        startCookieDismiss();
    }

    log('All privacy-invasive APIs blocked and patched.');
})();
