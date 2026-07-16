// Runs on the packaged app, after electron-builder has laid it down but before it is wrapped
// into an installer. Two jobs, in this order (the order matters — see below).
//
// 1. Cookie encryption fuse. Without it Electron writes cookies — i.e. every service's login —
//    to disk in plaintext; with it they go through the OS secret store (kwallet/gnome-libsecret
//    on Linux, DPAPI on Windows), the way Chrome's do. It is a build-time switch baked into the
//    binary, which is why it cannot simply be turned on from main.js. electron-builder 25 has no
//    `electronFuses` option of its own, hence this hook.
//
// 2. VMP signing (Windows and macOS only). castLabs ECS bundles the Widevine CDM, but on Windows
//    and macOS Widevine refuses to serve licenses in a packaged build unless the app is
//    VMP-signed via castLabs' EVS. (Linux does not require it, which is why the Linux build has
//    never had this step.) Signing writes .sig sidecars covering the app's binaries, so it MUST
//    run AFTER the fuse flip — the fuse edits the main executable, and a signature taken before
//    that would no longer match. It must also run before any Authenticode signing of the exe; we
//    configure none, so afterPack is the right place. Were an Authenticode cert added later, the
//    VMP signing would need to move to a hook that runs after it (afterSign).
const path = require('path');
const { execFileSync } = require('child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const exe = path.join(context.appOutDir, context.packager.executableName);

  await flipFuses(exe, {
    version: FuseVersion.V1,
    // resetAdHocDarwinSignature is macOS-only and moot for the platforms this ships.
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  // eslint-disable-next-line no-console
  console.log(`  • cookie encryption fuse enabled  file=${exe}`);

  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  if (platform === 'win32' || platform === 'darwin') {
    // Credentials come from the environment (EVS_ACCOUNT_NAME / EVS_PASSWD), authenticated by
    // the CI step before the build runs. `python` must be on PATH with the `castlabs-evs`
    // package installed.
    // eslint-disable-next-line no-console
    console.log(`  • VMP-signing Widevine components  dir=${context.appOutDir}`);
    execFileSync('python', ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], {
      stdio: 'inherit',
    });
  }
};
