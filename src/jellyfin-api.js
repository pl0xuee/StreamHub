// The slice of Jellyfin's HTTP API that playing a file through mpv needs, and nothing else.
//
// StreamHub is not a Jellyfin client: jellyfin-web is, and it stays the thing that browses the
// library, remembers where you were and knows what a season is. This module exists because the
// moment playback leaves the browser for mpv, three jobs stop being the web client's and become
// ours — asking the server which stream to open, opening it, and telling the server what is
// happening to it. Everything else is still jellyfin-web's.
//
// Two consequences run through the whole file:
//
//   * We never sign in. The base URL and the access token are lifted from the already
//     signed-in page (see the injected shell) and handed here. No password ever reaches this
//     process, and nothing here is persisted — if the user signs out of the page, the token we
//     were given simply stops working, which is the correct outcome.
//   * Nothing here may take playback down. A progress report that times out because the
//     server is briefly busy must not interrupt a film. So every call is bounded by a timeout
//     and every failure comes back as `null` or `false` for the caller to shrug at, never as a
//     rejection escaping into the main process.
//
// Written against Jellyfin's documented HTTP API. No code is taken from Jellyfin's own clients,
// which are GPL-2.0 while this repo is MIT.
const { normalizeServerUrl } = require('./services');

// Read from package.json for the same reason main.js does — app.getVersion() reports Electron's
// version rather than the app's under some packaging.
const APP_VERSION = require('../package.json').version;

// Jellyfin measures every position, duration and resume point in "ticks" of 100 nanoseconds,
// while mpv (and everything else in this app) speaks seconds. Mixing the two silently is the
// classic way to break resume points: a position off by a factor of ten million reads as either
// "the very start" or "past the end", and either way "Continue Watching" quietly stops working.
// So the conversion lives in exactly two functions, and no raw multiplication by 10000000
// appears anywhere else in the app.
const TICKS_PER_SECOND = 10000000;

function secondsToTicks(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * TICKS_PER_SECOND);
}

function ticksToSeconds(ticks) {
  const n = Number(ticks);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / TICKS_PER_SECOND;
}

// A position can arrive either way round: mpv's `time-pos` is seconds, while anything read back
// out of a Jellyfin item is already ticks. Both are accepted at the door and resolved here, so
// the conversion happens once per report rather than zero or two times.
function positionTicks(opts) {
  if (!opts) return 0;
  if (opts.positionTicks !== undefined && opts.positionTicks !== null) {
    const n = Number(opts.positionTicks);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  return secondsToTicks(opts.positionSeconds);
}

// PlaybackInfo can be slow in a way the reports never are: the server may have to probe the
// file with ffprobe before it can answer. Give it room, and keep the reports on a short leash
// so a stalled one is abandoned long before the next tick of progress is due.
const INFO_TIMEOUT_MS = 20000;
const REPORT_TIMEOUT_MS = 6000;

// What we tell the server we did with the stream. It is what the dashboard shows and what the
// server uses to decide whether a transcode session is still needed, so it has to be honest.
const PLAY_METHOD_DIRECT = 'DirectPlay';
const PLAY_METHOD_TRANSCODE = 'Transcode';

// Jellyfin's own header parser reads `key="value"` pairs separated by commas, so a value
// containing a quote, a backslash or a comma does not merely look untidy — it splits the header
// in the wrong place and the request comes back 401. Device names are user-visible strings
// ("James's Desktop, spare"), so they get scrubbed rather than trusted.
function authValue(value) {
  return String(value === undefined || value === null ? '' : value).replace(/["\\,\r\n]/g, ' ').trim();
}

class JellyfinApi {
  // `serverUrl` and `token` come from the signed-in page. `userId` is that page's current user;
  // it is needed for PlaybackInfo (the answer depends on who is asking — transcode limits and
  // parental ratings are per user) and for marking an item played.
  constructor(options = {}) {
    this.client = options.client || 'StreamHub';
    this.version = options.version || APP_VERSION;
    this.deviceName = options.deviceName || 'StreamHub';
    this.deviceId = options.deviceId || '';
    this.update(options);
  }

  // The page can hand over new credentials at any time — signing out and back in, or pointing
  // the service at a different server — so this is deliberately re-callable rather than a thing
  // settled once in the constructor.
  update(options = {}) {
    if (options.serverUrl !== undefined) {
      // The single source of truth for what a server address means, shared with the setup page
      // and the view that loads it. A server behind a reverse proxy under a sub-path is normal,
      // and this is what keeps that path attached to every request below.
      this.baseUrl = normalizeServerUrl(options.serverUrl) || '';
      // Kept separately because a root-relative path the server hands back has to be tested
      // against it — see resolve().
      this.basePath = this.baseUrl ? new URL(this.baseUrl).pathname.replace(/\/+$/, '') : '';
    }
    if (options.token !== undefined) this.token = options.token || '';
    if (options.userId !== undefined) this.userId = options.userId || '';
    if (options.deviceId !== undefined && options.deviceId) this.deviceId = options.deviceId;
    if (options.deviceName !== undefined && options.deviceName) this.deviceName = options.deviceName;
    if (options.client !== undefined && options.client) this.client = options.client;
    if (options.version !== undefined && options.version) this.version = options.version;
  }

  // Is there enough here to talk to a server at all? Callers use this to stay on the browser
  // player rather than trying and failing.
  get ready() {
    return Boolean(this.baseUrl && this.token);
  }

  // Jellyfin's own authorisation scheme. The token could also go in the older `X-Emby-Token`
  // header, but the full `MediaBrowser` form is what identifies the session in the dashboard
  // and in "Devices" — without Client/Device/DeviceId the user sees an anonymous session and
  // cannot tell which machine is playing.
  //
  // DeviceId in particular must be stable across runs: it is the identity the server ties
  // playback state and remote-control to, so a fresh random one each launch litters the
  // device list. The caller supplies it; this module does not invent one.
  authHeader() {
    const parts = [
      `Token="${authValue(this.token)}"`,
      `Client="${authValue(this.client)}"`,
      `Device="${authValue(this.deviceName)}"`,
      `DeviceId="${authValue(this.deviceId)}"`,
      `Version="${authValue(this.version)}"`,
    ];
    return `MediaBrowser ${parts.join(', ')}`;
  }

  headers(extra) {
    return {
      accept: 'application/json',
      authorization: this.authHeader(),
      ...(extra || null),
    };
  }

  // Build an absolute URL for one of our own API calls. `pathname` is written root-relative
  // ('/Sessions/Playing') and the server's base path, if it has one, is in this.baseUrl already.
  url(pathname, query) {
    if (!this.baseUrl) return '';
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return `${this.baseUrl}${pathname}${qs ? `?${qs}` : ''}`;
  }

  // Turn something the *server* handed us — a TranscodingUrl — into an absolute URL.
  //
  // The sub-path case is the one that bites. When Jellyfin sits at https://host/jellyfin there
  // are two arrangements, and they need opposite treatment: if the server has been told its own
  // base path (Networking → Base URL) it returns '/jellyfin/videos/...' already prefixed, and
  // gluing our base on the front produces '/jellyfin/jellyfin/...'; if the prefix is stripped by
  // the proxy instead, it returns a bare '/videos/...' that only works with our base in front.
  // Testing for the prefix distinguishes them.
  resolve(serverPath) {
    if (typeof serverPath !== 'string' || !serverPath) return '';
    if (/^https?:\/\//i.test(serverPath)) return serverPath;
    if (!this.baseUrl) return '';
    const rel = serverPath.startsWith('/') ? serverPath : `/${serverPath}`;
    if (this.basePath && (rel === this.basePath || rel.startsWith(`${this.basePath}/`))) {
      return `${new URL(this.baseUrl).origin}${rel}`;
    }
    return `${this.baseUrl}${rel}`;
  }

  // Every network call in this file goes through here, which is where the promise of "no
  // unhandled rejection, ever" is actually kept. A failure — offline, 401 after a sign-out, a
  // server mid-restart — is a warning on the console and a null return, and the caller decides
  // whether that matters. For a progress report it does not.
  async request(method, pathname, options = {}) {
    if (!this.ready) return null;
    const target = this.url(pathname, options.query);
    if (!target) return null;
    const hasBody = options.body !== undefined;
    try {
      const res = await fetch(target, {
        method,
        headers: this.headers(hasBody ? { 'content-type': 'application/json' } : null),
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || REPORT_TIMEOUT_MS),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn('[jellyfin]', method, pathname, 'answered', res.status);
        return null;
      }
      // Most of these answer 204 with no body at all; an empty object still means "it worked",
      // so callers can test the result rather than the status.
      const text = await res.text().catch(() => '');
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[jellyfin]', method, pathname, 'failed:', (err && err.message) || err);
      return null;
    }
  }

  // Ask the server how this item can be played, and pick the source to open.
  //
  // This one call is where direct play is won or lost. The device profile we send says what this
  // client can decode; because the client is mpv, the honest answer is "essentially anything",
  // and the server responds with a source it will serve untouched instead of a transcode. The
  // profile itself is built by the injected shell — it belongs with the rest of what jellyfin-web
  // is told about us — and is passed straight through here.
  //
  // Returns null on any failure, or { mediaSource, playSessionId, playMethod, sources }.
  // PlaySessionId comes back with the *response*, not the source, and it has to travel with
  // every later report: it is how the server ties progress — and, for a transcode, the ffmpeg
  // process it started — to this playback. Dropping it leaves transcodes running after the
  // user has stopped watching, so it is returned alongside rather than left behind.
  async playbackInfo(itemId, options = {}) {
    if (!itemId) return null;
    const userId = options.userId || this.userId || '';
    const body = {
      UserId: userId || undefined,
      MediaSourceId: options.mediaSourceId || undefined,
      StartTimeTicks: positionTicks({
        positionTicks: options.startTimeTicks,
        positionSeconds: options.startSeconds,
      }),
      DeviceProfile: options.deviceProfile || undefined,
      MaxStreamingBitrate: options.maxStreamingBitrate || undefined,
      AudioStreamIndex: options.audioStreamIndex,
      SubtitleStreamIndex: options.subtitleStreamIndex,
      // Say yes to everything and let the profile do the deciding. Turning any of these off
      // here would rule out a source the profile has already said we can play.
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      // For a live stream (a tuner, or anything behind an m3u) the source is not usable until
      // the server has opened it; asking it to do that now saves a second round trip and is
      // what makes LiveStreamId — needed to close it again — come back populated.
      AutoOpenLiveStream: true,
    };

    // userId also goes on the query string: some deployments' auth middleware reads it from
    // there, and the server accepts either.
    const data = await this.request('POST', `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      query: { userId },
      body,
      timeoutMs: INFO_TIMEOUT_MS,
    });
    if (!data) return null;

    const sources = Array.isArray(data.MediaSources) ? data.MediaSources : [];
    if (!sources.length) {
      // ErrorCode is the server's own explanation — no compatible stream, no licence, too many
      // sessions — and it is worth surfacing, because the alternative is a black window.
      // eslint-disable-next-line no-console
      console.warn('[jellyfin] no playable source for', itemId, data.ErrorCode || '');
      return null;
    }

    // An item can have several sources (different rips of the same film, or the versions of an
    // episode). If the page named one, honour it exactly; otherwise the server's first is its
    // preferred one.
    const wanted = options.mediaSourceId
      ? sources.find((s) => s && s.Id === options.mediaSourceId)
      : null;
    const mediaSource = wanted || sources[0];

    return {
      mediaSource,
      sources,
      playSessionId: data.PlaySessionId || '',
      playMethod: playMethodFor(mediaSource),
    };
  }

  // The URL to hand mpv.
  //
  // Preferred: the static stream, which is the original file served byte for byte — that is the
  // whole point of the feature. `static=true` is what stops the server helpfully remuxing it.
  // The container is put in the path as an extension purely so mpv can guess the demuxer from
  // the name instead of probing, which shaves the delay before the first frame.
  //
  // Fallback: whatever TranscodingUrl the server returned, when it has decided it cannot serve
  // the file as it is. That URL is the server's own and already carries its own credentials and
  // PlaySessionId, so it is resolved rather than rebuilt.
  //
  // The token goes in the query string here and nowhere else in this file. mpv fetches over
  // plain HTTP with no headers of ours, so `api_key=` is the only way it can authenticate —
  // this is the one place a URL carrying a credential is created, and it must not be logged.
  directStreamUrl(itemId, mediaSource, options = {}) {
    if (!this.baseUrl || !mediaSource) return '';
    const method = playMethodFor(mediaSource);
    if (method === PLAY_METHOD_TRANSCODE) {
      return this.resolve(mediaSource.TranscodingUrl);
    }
    if (!itemId) return '';
    // Audio-only items are served from their own route; video is the common case.
    const segment = options.mediaType === 'Audio' ? 'Audio' : 'Videos';
    const container = typeof mediaSource.Container === 'string'
      ? mediaSource.Container.split(',')[0].trim().toLowerCase()
      : '';
    const extension = /^[a-z0-9]+$/.test(container) ? `.${container}` : '';
    return this.url(`/${segment}/${encodeURIComponent(itemId)}/stream${extension}`, {
      static: 'true',
      mediaSourceId: mediaSource.Id || itemId,
      playSessionId: options.playSessionId || undefined,
      liveStreamId: mediaSource.LiveStreamId || undefined,
      tag: mediaSource.ETag || undefined,
      api_key: this.token,
    });
  }

  // ---- Telling the server what is happening ----
  //
  // Without these three the integration silently breaks the library: nothing resumes, "Continue
  // Watching" never fills, nothing is ever marked played, and — worse — a transcode the server
  // started for us keeps running because nobody said stop. All three take the same shape, so
  // they share a body builder; the differences between them are only which fields the endpoint
  // reads and how often it is called.

  playbackBody(options = {}) {
    return {
      ItemId: options.itemId,
      MediaSourceId: options.mediaSourceId || options.itemId,
      PlaySessionId: options.playSessionId || undefined,
      LiveStreamId: options.liveStreamId || undefined,
      PositionTicks: positionTicks(options),
      // mpv can always seek in a file it has fetched, and saying so is what puts a scrubber in
      // the remote-control clients rather than a dead bar.
      CanSeek: options.canSeek !== false,
      IsPaused: options.isPaused === true,
      IsMuted: options.isMuted === true,
      VolumeLevel: options.volumeLevel === undefined ? undefined : Math.round(options.volumeLevel),
      AudioStreamIndex: options.audioStreamIndex,
      SubtitleStreamIndex: options.subtitleStreamIndex,
      PlayMethod: options.playMethod || PLAY_METHOD_DIRECT,
      RepeatMode: 'RepeatNone',
    };
  }

  // "I have started playing this." Sent once, as playback begins, and it is what makes the item
  // appear as an active session on the server's dashboard.
  async reportStart(options = {}) {
    if (!options.itemId) return false;
    const body = this.playbackBody(options);
    return Boolean(await this.request('POST', '/Sessions/Playing', { body }));
  }

  // "I am still here, and this is where." Sent on a timer and on every pause, seek and track
  // change. This is what the resume point is made of, so it is also the call most likely to be
  // in flight when something goes wrong — hence the short timeout and the shrug on failure.
  async reportProgress(options = {}) {
    if (!options.itemId) return false;
    const body = this.playbackBody(options);
    // The server passes EventName on to remote-control clients so their buttons follow ours;
    // 'timeupdate' is the right thing for the periodic tick.
    body.EventName = options.eventName || 'timeupdate';
    return Boolean(await this.request('POST', '/Sessions/Playing/Progress', { body }));
  }

  // "I have stopped." The one report that must not be skipped: it writes the final resume
  // position and it is what tears down a transcode. Send it on every way out — the user
  // stopping, the item ending, mpv dying, the app quitting.
  async reportStopped(options = {}) {
    if (!options.itemId) return false;
    const body = {
      ItemId: options.itemId,
      MediaSourceId: options.mediaSourceId || options.itemId,
      PlaySessionId: options.playSessionId || undefined,
      LiveStreamId: options.liveStreamId || undefined,
      PositionTicks: positionTicks(options),
      Failed: options.failed === true,
    };
    return Boolean(await this.request('POST', '/Sessions/Playing/Stopped', { body }));
  }

  // Mark an item watched, for when it reached the end.
  //
  // Jellyfin will do this itself from a stop report near the end of the runtime, but only if the
  // position it is given is close enough to the runtime for its own threshold — and mpv's last
  // reported position can be a second or two short of it. Saying so explicitly at EOF is the
  // difference between an episode that greys out and one that sits at 99% forever.
  async markPlayed(itemId, userId) {
    const user = userId || this.userId;
    if (!itemId || !user) return false;
    const path = `/Users/${encodeURIComponent(user)}/PlayedItems/${encodeURIComponent(itemId)}`;
    return Boolean(await this.request('POST', path, { body: {} }));
  }
}

// Which of the server's answers we got, in the vocabulary the dashboard speaks.
//
// The distinction that matters is only ever "is the server re-encoding this or not": a source
// the server will serve as it is comes back with SupportsDirectPlay or SupportsDirectStream, and
// we fetch it with static=true and call that DirectPlay. Anything else means it handed us a
// TranscodingUrl instead, and reporting that as anything but Transcode would misdescribe a
// running ffmpeg to the person looking at their own server.
function playMethodFor(mediaSource) {
  if (!mediaSource) return PLAY_METHOD_TRANSCODE;
  if (mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream) return PLAY_METHOD_DIRECT;
  return PLAY_METHOD_TRANSCODE;
}

module.exports = {
  JellyfinApi,
  secondsToTicks,
  ticksToSeconds,
  playMethodFor,
  TICKS_PER_SECOND,
  PLAY_METHOD_DIRECT,
  PLAY_METHOD_TRANSCODE,
};
