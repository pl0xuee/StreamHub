// Syntax-check the Jellyfin shell, both halves of it.
//
// jellyfin-shell.js builds the injected script as one long template literal, which makes it
// unusually easy to break in a way nothing notices until the app will not start: a single
// backtick in a comment inside that literal closes it early, and the module stops parsing. That
// has happened twice. `node --check` on the module catches that one, but not the other half —
// the *emitted* string is only ever parsed by the browser, so a syntax error inside it reaches
// the page as a silently dead shell and Jellyfin quietly falls back to its own player.
//
// So: require the module (proving it parses), emit the script, and parse that too.
//
// Run with `npm run check`. There is no test framework in this project and this does not pretend
// to be one — it is the one automated check that would have caught a real outage.
const vm = require('vm');
const path = require('path');
const fs = require('fs');

const shellPath = path.join(__dirname, '..', 'src', 'jellyfin-shell.js');

let failures = 0;
function fail(what, err) {
  failures += 1;
  // eslint-disable-next-line no-console
  console.error(`FAIL  ${what}\n      ${err && err.message}`);
}

let jellyfinShellJs = null;
try {
  ({ jellyfinShellJs } = require(shellPath));
  // eslint-disable-next-line no-console
  console.log('PASS  src/jellyfin-shell.js parses and loads');
} catch (err) {
  fail('src/jellyfin-shell.js does not load', err);
}

if (jellyfinShellJs) {
  let source = null;
  try {
    source = jellyfinShellJs({ deviceName: 'check', appVersion: '0.0.0' });
    // eslint-disable-next-line no-console
    console.log(`PASS  emitted shell built (${source.length} bytes)`);
  } catch (err) {
    fail('emitting the shell threw', err);
  }

  if (typeof source === 'string') {
    // new vm.Script compiles without running, which is exactly the question being asked: would
    // the page have been handed something it can parse?
    try {
      // eslint-disable-next-line no-new
      new vm.Script(source, { filename: 'jellyfin-shell.injected.js' });
      // eslint-disable-next-line no-console
      console.log('PASS  emitted shell is syntactically valid JavaScript');
    } catch (err) {
      fail('emitted shell has a syntax error', err);
    }

    // A backtick surviving into the emitted source is not necessarily wrong, but an unbalanced
    // one is how the literal gets closed early, so it is worth saying out loud.
    if (source.includes('`')) {
      // eslint-disable-next-line no-console
      console.warn('WARN  emitted shell contains a backtick — check it is deliberate');
    }
  }
}

// ---- The other code that only a page ever parses ----
//
// Same argument as above, for the rest of it. The site enhancements and the snippets views.js
// injects are all built as template literals in the main process and handed to a web page as
// strings, so nothing in this repo parses them before Chromium does — a typo in one reaches the
// user as a feature that quietly stopped working, with no error anywhere the app can see.

// The two site controllers are plain modules with no Electron dependency, so they can be built
// here for real. Both settings states, because each one emits a different program.
for (const name of ['enhance-youtube', 'enhance-twitch']) {
  let controllerJs = null;
  try {
    ({ controllerJs } = require(path.join(__dirname, '..', 'src', name)));
  } catch (err) {
    fail(`src/${name}.js does not load`, err);
  }
  if (!controllerJs) continue;
  for (const settings of [{}, { theater: true, twitchTheater: true }]) {
    try {
      // eslint-disable-next-line no-new
      new vm.Script(controllerJs(settings), { filename: `${name}.injected.js` });
    } catch (err) {
      fail(`src/${name}.js emits a syntax error`, err);
    }
  }
  // eslint-disable-next-line no-console
  if (!failures) console.log(`PASS  src/${name}.js emits parseable source`);
}

// views.js cannot be required outside Electron, so its snippets are read out of the source. Each
// is a top-level `const NAME = \`…\`;`, which is enough structure to lift out reliably.
const INJECTED_IN_VIEWS = ['PLAYPAUSE_JS', 'PAUSE_ALL_JS', 'RESUME_JS', 'SCROLLBAR_JS'];
const viewsSource = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'src', 'views.js'), 'utf8');
  } catch (err) {
    fail('src/views.js could not be read', err);
    return '';
  }
})();

for (const name of INJECTED_IN_VIEWS) {
  const declaration = `const ${name} = \``;
  const at = viewsSource.indexOf(declaration);
  if (at === -1) {
    fail(`src/views.js no longer declares ${name}`, new Error('renamed, or no longer a literal'));
    continue;
  }
  const open = at + declaration.length - 1;
  let close = -1;
  for (let i = open + 1; i < viewsSource.length; i += 1) {
    if (viewsSource[i] === '`' && viewsSource[i - 1] !== '\\') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    fail(`src/views.js: ${name} has no closing backtick`, new Error('unterminated literal'));
    continue;
  }
  // SCROLLBAR_JS interpolates its rule list. The value does not matter to a syntax check, only
  // that something of the right shape stands where it goes.
  const body = viewsSource
    .slice(open + 1, close)
    .replace(/\$\{JSON\.stringify\(SCROLLBAR_RULES\)\}/g, '["* { color: red !important; }"]');
  if (body.includes('${')) {
    fail(`src/views.js: ${name} has an interpolation this check does not know about`,
      new Error('teach check-shell.js what to substitute for it'));
    continue;
  }
  try {
    // eslint-disable-next-line no-new
    new vm.Script(body, { filename: `views.${name}.js` });
    // eslint-disable-next-line no-console
    console.log(`PASS  ${name} is syntactically valid JavaScript`);
  } catch (err) {
    fail(`src/views.js: ${name} has a syntax error`, err);
  }
}

if (failures) {
  // eslint-disable-next-line no-console
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('\nAll shell checks passed');
