// Flips Electron "fuses" on the packaged binary, after electron-builder has laid it down.
//
// The only one we set is cookie encryption. Without it Electron writes cookies — i.e. every
// service's login — to disk in plaintext; with it they go through the OS secret store
// (kwallet/gnome-libsecret on Linux), the way Chrome's do. It is a build-time switch baked
// into the binary, which is why it cannot simply be turned on from main.js.
//
// electron-builder 25 has no `electronFuses` option of its own, hence this hook.
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, context.packager.executableName);

  await flipFuses(exe, {
    version: FuseVersion.V1,
    // resetAdHocDarwinSignature is macOS-only; this app ships Linux, so it is moot.
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  // eslint-disable-next-line no-console
  console.log(`  • cookie encryption fuse enabled  file=${exe}`);
};
