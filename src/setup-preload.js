// The bridge for the built-in setup page (src/ui/setup.html) — the landing page a self-hosted
// service shows until it has been told where its server is.
//
// A service view normally carries service-preload.js, which deliberately exposes *nothing* to the
// page: those are other people's websites and they stay isolated. This preload is only ever
// attached to a view showing our own file:// page (views.js chooses it when the service has no
// address, and main.js rebuilds the view the moment one is saved), so it can hand that page the
// two calls it needs. The main process checks the caller really is that page before acting on
// either of them — see fromSetupPage in main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  // Ask whether there is a Jellyfin server at this address, before anything is saved. Resolves
  // to { ok: true, url, name, version } or { ok: false, url, error } — never rejects, so the
  // page always has something to say.
  probe: (url) => ipcRenderer.invoke('probe-server', url),
  // Save the address against the service and open it. This view is replaced as a result, so
  // nothing after the call runs on a page that is still on screen.
  save: (serviceId, url) => ipcRenderer.invoke('set-server-url', serviceId, url),
});
