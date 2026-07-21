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
//
// IMPORTANT: service views are sandboxed, which is worth keeping for sites we do not control.
// A sandboxed preload cannot `require` a local module, so everything this file needs is handed
// to it by views.js through additionalArguments rather than imported from services.js. Adding a
// `require('./…')` here would throw before any of the below runs — silently, since the failure
// is reported to the page's console and not the app's — and the view would go back to
// advertising itself as Electron.
const { webFrame } = require('electron');

const FLAG = '--streamhub-identity=';
const arg = process.argv.find((a) => a.startsWith(FLAG));

let identity = null;
try {
  identity = arg ? JSON.parse(arg.slice(FLAG.length)) : null;
} catch {
  // Malformed payload: leave the identity alone rather than patching in half of one.
}

let host = '';
try {
  host = window.location.hostname;
} catch {
  // location unavailable this early on some about:/blank docs; treat as non-auth.
}

if (identity) {
  const isAuthHost = (identity.authHosts || []).includes(host);

  if (isAuthHost) {
    // Firefox: real UA string, no Client Hints API, empty vendor. Overriding the getters in
    // the page's own world means Google's "secure browser" check reads Firefox, not Chromium.
    webFrame.executeJavaScript(`(() => {
      const def = (name, value) => Object.defineProperty(Navigator.prototype, name, {
        get: () => value,
        configurable: true,
        enumerable: true,
      });
      def('userAgent', ${JSON.stringify(identity.firefoxUa)});
      def('userAgentData', undefined);
      def('vendor', '');
    })()`);
  } else {
    webFrame.executeJavaScript(`(() => {
      const major = ${JSON.stringify(String(identity.chromeMajor))};
      const brands = [
        { brand: 'Not;A=Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ];
      const fullVersion = major + '.0.0.0';
      const low = { brands, mobile: false, platform: ${JSON.stringify(identity.chPlatform)} };

      const high = {
        architecture: ${JSON.stringify(identity.chArch)},
        bitness: ${JSON.stringify(identity.chBitness)},
        fullVersionList: brands.map((b) => ({ brand: b.brand, version: fullVersion })),
        model: '',
        platformVersion: ${JSON.stringify(identity.chPlatformVersion)},
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
}
