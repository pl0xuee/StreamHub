// electron-builder afterPack hook.
//
// On Windows, Widevine only plays in a *packaged* build if the Electron executables are
// VMP-signed (Verified Media Path) with a castLabs EVS certificate — electron-builder's
// repackaging invalidates the stock dev signature. This hook signs the packed app before
// the installer is assembled.
//
// It runs ONLY on Windows AND only when EVS_ACCOUNT_NAME is set (from a GitHub secret in
// CI, after `castlabs_evs.account reauth`). Otherwise it logs and skips, so local and
// unsigned builds still succeed — Windows DRM just won't play until the app is signed.
// (Linux is unaffected: the stock ECS signature already works there.)
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  if (!process.env.EVS_ACCOUNT_NAME) {
    console.log(
      '[vmp] EVS_ACCOUNT_NAME not set — skipping Widevine VMP signing. ' +
        'The Windows build will run but protected playback will fail until it is signed.',
    );
    return;
  }

  const dir = context.appOutDir;
  console.log(`[vmp] VMP-signing packaged app: ${dir}`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', dir], { stdio: 'inherit' });
  console.log('[vmp] VMP signing complete.');
};
