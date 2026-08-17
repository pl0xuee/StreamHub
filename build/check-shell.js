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

if (failures) {
  // eslint-disable-next-line no-console
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('\nAll shell checks passed');
