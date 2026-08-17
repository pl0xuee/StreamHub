// Runs on the packaged app, after electron-builder has laid it down but before it is wrapped
// into an installer. Three jobs; the first two are ordered (the order matters — see below), the
// third only reads.
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
//
// 3. Saying, out loud, whether this build shipped mpv. Bundling it is optional — it is there
//    only if build/stage-mpv.sh was run first — and "did that AppImage get a player or not?" is
//    otherwise invisible until someone runs it on a machine with no mpv installed. So the build
//    log answers it. This step changes nothing; it reads the tree and prints.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  // The packaged executable's path. `executableName` is set on Linux ("streamhub") but comes
  // back undefined on Windows, so fall back to the product filename and add the .exe there.
  const base = context.packager.executableName || context.packager.appInfo.productFilename;
  const ext = context.electronPlatformName === 'win32' ? '.exe' : '';
  const exe = path.join(context.appOutDir, `${base}${ext}`);

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

  // resources/mpv/mpv is exactly the path src/mpv.js looks for, so this is the same question the
  // app asks itself at runtime. On Windows the resources directory sits beside the exe; on Linux
  // it is the same layout, which is why appOutDir/resources works for both.
  const bundledMpv = path.join(context.appOutDir, 'resources', 'mpv', 'mpv');
  if (fs.existsSync(bundledMpv)) {
    // A bundled mpv is GPL software riding along with an MIT app, which is only allowed while
    // its licence rides with it. Fail the build rather than ship a violation.
    const licence = path.join(context.appOutDir, 'resources', 'mpv', 'mpv-COPYING.txt');
    if (!fs.existsSync(licence)) {
      throw new Error(
        'mpv was bundled without mpv-COPYING.txt — re-run `npm run stage:mpv` and read its output',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  • mpv bundled  file=${bundledMpv}`);
  } else {
    // eslint-disable-next-line no-console
    console.log('  • no mpv bundled; the app will use the system mpv (run `npm run stage:mpv` to bundle one)');
  }
};
