// Runs in every service view. Its only job is to make the User-Agent Client Hints API
// agree with the Chrome User-Agent the view presents (see CHROME_UA in services.js).
//
// Electron reports brands like [Chromium, Not;A=Brand] with no "Google Chrome" entry,
// and at the engine's real version — so a page could read navigator.userAgentData and
// see a different browser than the UA string claims. reCAPTCHA on the streaming sign-in
// pages reads both, and treats the disagreement as an automation signal.
//
// The patch is applied via webFrame.executeJavaScript so it lands in the page's own
// world (this preload runs in an isolated one) before any page script runs. No app
// privileges are exposed to the page: nothing is bridged, only navigator is amended.
const { webFrame } = require('electron');

const FLAG = '--lvs-chrome-major=';
const arg = process.argv.find((a) => a.startsWith(FLAG));
const major = arg ? arg.slice(FLAG.length) : '';

if (major) {
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
