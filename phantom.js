// ==UserScript==
// @name         Phantom
// @namespace    https://github.com/user/phantom
// @version      1.3
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
            // Fallback: direct assignment if defineProperty fails
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
            configurable: false,
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
        // writeText is left intact so copy-to-clipboard buttons still work
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

    // --- Bluetooth ---
    if (navigator.bluetooth) {
        override(Bluetooth.prototype, 'requestDevice', {
            value: function () {
                log('Blocked bluetooth.requestDevice');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- USB ---
    if (navigator.usb) {
        override(USB.prototype, 'requestDevice', {
            value: function () {
                log('Blocked usb.requestDevice');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- HID ---
    if (navigator.hid) {
        override(HID.prototype, 'requestDevice', {
            value: function () {
                log('Blocked hid.requestDevice');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- Serial ---
    if (navigator.serial) {
        override(Serial.prototype, 'requestPort', {
            value: function () {
                log('Blocked serial.requestPort');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

    // --- NFC ---
    if (window.NDEFReader) {
        override(NDEFReader.prototype, 'scan', {
            value: function () {
                log('Blocked NDEFReader.scan');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
        override(NDEFReader.prototype, 'write', {
            value: function () {
                log('Blocked NDEFReader.write');
                return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
            },
        });
    }

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
    // Also block the on* property setters
    for (const prop of ['ondevicemotion', 'ondeviceorientation', 'ondeviceorientationabsolute']) {
        Object.defineProperty(window, prop, {
            set: () => log(`Blocked setting ${prop}`),
            get: () => null,
            configurable: true,
        });
    }

    // --- Permissions API (report everything as denied) ---
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
                    const fakeStatus = new EventTarget();
                    fakeStatus.state = 'denied';
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

    // --- SendBeacon (tracking pings on page unload) ---
    override(Navigator.prototype, 'sendBeacon', {
        value: function (url) {
            log(`Blocked sendBeacon to ${url}`);
            return true; // pretend it succeeded so callers don't retry
        },
    });

    // --- Network Information (connection fingerprinting) ---
    if (navigator.connection) {
        override(Navigator.prototype, 'connection', {
            get: function () {
                log('Blocked navigator.connection');
                return undefined;
            },
        });
    }

    // --- Canvas Fingerprinting ---
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    override(HTMLCanvasElement.prototype, 'toDataURL', {
        value: function () {
            // Allow small canvases (icons, UI) — only poison large ones used for fingerprinting
            if (this.width > 16 && this.height > 16) {
                const ctx = this.getContext('2d');
                if (ctx) {
                    // Add imperceptible noise to poison the fingerprint
                    const pixel = originalGetImageData.call(ctx, 0, 0, 1, 1);
                    pixel.data[0] = (pixel.data[0] + Math.floor(Math.random() * 3)) % 256;
                    ctx.putImageData(pixel, 0, 0);
                    log('Poisoned canvas toDataURL fingerprint');
                }
            }
            return originalToDataURL.apply(this, arguments);
        },
    });

    override(HTMLCanvasElement.prototype, 'toBlob', {
        value: function (callback) {
            if (this.width > 16 && this.height > 16) {
                const ctx = this.getContext('2d');
                if (ctx) {
                    const pixel = originalGetImageData.call(ctx, 0, 0, 1, 1);
                    pixel.data[0] = (pixel.data[0] + Math.floor(Math.random() * 3)) % 256;
                    ctx.putImageData(pixel, 0, 0);
                    log('Poisoned canvas toBlob fingerprint');
                }
            }
            return originalToBlob.apply(this, arguments);
        },
    });

    // --- AudioContext Fingerprinting ---
    if (window.AudioContext || window.webkitAudioContext) {
        // Poison AnalyserNode frequency data with subtle noise after real analysis
        const originalGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
        override(AnalyserNode.prototype, 'getFloatFrequencyData', {
            value: function (array) {
                originalGetFloatFreq.call(this, array);
                // Add imperceptible noise to poison the fingerprint
                for (let i = 0; i < array.length; i++) {
                    array[i] += (Math.random() - 0.5) * 0.1;
                }
                log('Poisoned AudioContext getFloatFrequencyData');
            },
        });

        override(OfflineAudioContext.prototype, 'startRendering', {
            value: function () {
                log('Blocked OfflineAudioContext.startRendering (fingerprint)');
                return new Promise((resolve) => {
                    // Return a silent buffer with slight noise
                    const buffer = new AudioBuffer({
                        length: this.length,
                        sampleRate: this.sampleRate,
                        numberOfChannels: this.numberOfChannels,
                    });
                    const channel = buffer.getChannelData(0);
                    for (let i = 0; i < channel.length; i++) {
                        channel[i] = (Math.random() - 0.5) * 1e-7; // imperceptible noise
                    }
                    resolve(buffer);
                });
            },
        });
    }

    // --- WebRTC IP Leak Prevention ---
    if (window.RTCPeerConnection) {
        const OriginalRTC = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends OriginalRTC {
            constructor(config = {}) {
                config.iceTransportPolicy = 'relay';
                super(config);
                log('WebRTC forced to relay-only (no local IP leak)');
            }
        };
        // Also cover the webkit prefix
        if (window.webkitRTCPeerConnection) {
            window.webkitRTCPeerConnection = window.RTCPeerConnection;
        }
    }

    // --- WebGL Renderer Fingerprinting ---
    const getParamBlock = new Set([
        0x9245, // UNMASKED_VENDOR_WEBGL
        0x9246, // UNMASKED_RENDERER_WEBGL
    ]);
    for (const CtxProto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
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
        // Block the debug extension entirely
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
            get: function () {
                log(`Spoofed navigator.${prop}`);
                return val;
            },
        });
    }
    // Normalize languages to a common value
    override(Navigator.prototype, 'languages', {
        get: function () {
            log('Spoofed navigator.languages');
            return Object.freeze(['en-US', 'en']);
        },
    });
    override(Navigator.prototype, 'language', {
        get: function () {
            return 'en-US';
        },
    });

    // --- Screen Property Normalization ---
    const screenSpoofs = {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1080,
        colorDepth: 24,
        pixelDepth: 24,
    };
    for (const [prop, val] of Object.entries(screenSpoofs)) {
        override(Screen.prototype, prop, {
            get: function () {
                log(`Spoofed screen.${prop}`);
                return val;
            },
        });
    }
    override(Window.prototype, 'devicePixelRatio', {
        get: function () {
            log('Spoofed devicePixelRatio');
            return 1;
        },
    });

    // --- performance.now() Precision Reduction ---
    const originalPerfNow = Performance.prototype.now;
    override(Performance.prototype, 'now', {
        value: function () {
            // Reduce to 100μs precision (from 5μs) to prevent timing attacks
            return Math.round(originalPerfNow.call(this) * 10) / 10;
        },
    });

    // --- window.name Supercookie ---
    // Clear on load and prevent sites from persisting data across navigations
    window.name = '';
    override(Window.prototype, 'name', {
        set: function (val) {
            if (val !== '' && val != null) {
                log(`Blocked window.name supercookie: "${String(val).substring(0, 50)}..."`);
            }
        },
        get: function () {
            return '';
        },
    });

    // --- Visibility API ---
    override(Document.prototype, 'hidden', {
        get: function () {
            return false; // always report as visible
        },
    });
    override(Document.prototype, 'visibilityState', {
        get: function () {
            return 'visible'; // never reveal tab switching
        },
    });
    // Swallow visibilitychange events
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
        // Common "reject/decline" button selectors across major CMPs
        const rejectSelectors = [
            // OneTrust
            '#onetrust-reject-all-handler',
            '.onetrust-close-btn-handler',
            // CookieBot
            '#CybotCookiebotDialogBodyButtonDecline',
            '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
            // Quantcast / TCF
            '.qc-cmp2-summary-buttons button[mode="secondary"]',
            '[class*="qc-cmp"][class*="reject"]',
            // TrustArc / TrustE
            '.truste_overlay .pdynamicbutton .call',
            '#truste-consent-required',
            // Didomi
            '#didomi-notice-disagree-button',
            // Axeptio
            '[data-choice="deny"]',
            // Klaro
            '.klaro .cm-btn-decline',
            // Complianz
            '.cmplz-deny',
            // CookieYes
            '.cky-btn-reject',
            // Osano
            '.osano-cm-deny',
            // Generic patterns (broad catch-all)
            '[data-testid="cookie-reject"]',
            '[data-cookiefirst-action="reject"]',
            'button[aria-label*="reject" i]',
            'button[aria-label*="decline" i]',
            'button[aria-label*="deny" i]',
            'button[aria-label*="refuse" i]',
        ];

        // Generic text matching for unlabeled buttons inside cookie banners
        const bannerSelectors = [
            '#cookie-banner', '#cookie-consent', '#cookie-notice', '#cookie-bar',
            '#gdpr-banner', '#gdpr-consent', '#consent-banner', '#consent-popup',
            '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
            '[class*="gdpr"]', '[class*="consent-banner"]', '[class*="consent-popup"]',
            '[id*="cookie"]', '[class*="cc-banner"]', '[class*="cc_banner"]',
            '[class*="CookieConsent"]',
        ];

        const rejectPatterns = /^(reject|decline|deny|refuse|no thanks|only necessary|only essential|essentials only|necessary only|manage|settings|preferences|customize)/i;

        // Try specific selectors first
        for (const sel of rejectSelectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
                btn.click();
                log(`Cookie banner dismissed via: ${sel}`);
                return true;
            }
        }

        // Fall back to text matching inside known banner containers
        for (const bannerSel of bannerSelectors) {
            const banner = document.querySelector(bannerSel);
            if (!banner || banner.offsetParent === null) continue;

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

    // Run after DOM loads, then watch for late-injected banners
    const startCookieDismiss = () => {
        if (cookieDismiss()) return;

        let attempts = 0;
        const observer = new MutationObserver(() => {
            if (cookieDismiss() || ++attempts > 50) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Safety timeout: stop watching after 15s
        setTimeout(() => observer.disconnect(), 15000);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startCookieDismiss);
    } else {
        startCookieDismiss();
    }

    log('All privacy-invasive APIs blocked.');
})();
