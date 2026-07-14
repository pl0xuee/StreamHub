// Runs in every service view. Its job is to make the JS-visible browser identity agree
// with the User-Agent the view presents (see CHROME_UA / FIREFOX_UA in services.js).
//
// Electron reports brands like [Chromium, Not;A=Brand] with no "Google Chrome" entry,
// and at the engine's real version — so a page could read navigator.userAgentData and
// see a different browser than the UA string claims. reCAPTCHA on the streaming sign-in
// pages reads both, and treats the disagreement as an automation signal.
//
// On Google's sign-in host the view instead masquerades as Firefox (the header half of
// this lives in views.js), so here we mirror what Firefox exposes to JS: the Firefox UA
// string, no userAgentData, and an empty navigator.vendor.
//
// The patch is applied via webFrame.executeJavaScript so it lands in the page's own
// world (this preload runs in an isolated one) before any page script runs. No app
// privileges are exposed to the page: nothing is bridged, only navigator is amended.
const { webFrame } = require('electron');
const { FIREFOX_UA, isGoogleAuthHost } = require('./services');

const FLAG = '--lvs-chrome-major=';
const arg = process.argv.find((a) => a.startsWith(FLAG));
const major = arg ? arg.slice(FLAG.length) : '';

let host = '';
try {
  host = window.location.hostname;
} catch {
  // location unavailable this early on some about:/blank docs; treat as non-auth.
}

if (isGoogleAuthHost(host)) {
  // Firefox: real UA string, no Client Hints API, empty vendor. Overriding the getters in
  // the page's own world means Google's "secure browser" check reads Firefox, not Chromium.
  webFrame.executeJavaScript(`(() => {
    const def = (name, value) => Object.defineProperty(Navigator.prototype, name, {
      get: () => value,
      configurable: true,
      enumerable: true,
    });
    def('userAgent', ${JSON.stringify(FIREFOX_UA)});
    def('userAgentData', undefined);
    def('vendor', '');
  })()`);
} else if (major) {
  webFrame.executeJavaScript(`(() => {
    const brands = [
      { brand: 'Not;A=Brand', version: '8' },
      { brand: 'Chromium', version: '${major}' },
      { brand: 'Google Chrome', version: '${major}' },
    ];
    const fullVersion = '${major}.0.0.0';
    const low = { brands, mobile: false, platform: 'Linux' };

    const high = {
      architecture: 'x86',
      bitness: '64',
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: fullVersion })),
      model: '',
      platformVersion: '6.1.0',
      uaFullVersion: fullVersion,
      ...low,
    };

    const data = {
      ...low,
      toJSON: () => ({ ...low }),
      getHighEntropyValues: (hints) => Promise.resolve(
        (hints || []).reduce((out, h) => {
          if (h in high) out[h] = high[h];
          return out;
        }, { ...low }),
      ),
    };

    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => data,
      configurable: true,
      enumerable: true,
    });
  })()`);
}
