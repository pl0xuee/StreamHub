// System media controls on Linux (MPRIS), so KDE's panel, the lock screen and the media
// applet can see what is playing and drive it.
//
// Chromium implements MPRIS, and the strings are still in the binary, but Electron never
// instantiates it — verified: playing audible video in Electron registers no
// org.mpris.MediaPlayer2.* name on the bus, with or without the MediaSessionService feature
// flag. So we serve the interface ourselves.
//
// This is deliberately the small half of the spec: the properties a panel actually reads and
// the methods it actually calls. Everything else is declared false/unsupported rather than
// half-implemented, so a client never offers a control that does nothing.
const dbus = require('@httptoolkit/dbus-native');

const BUS_NAME = 'org.mpris.MediaPlayer2.streamhub';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const TRACK_ID = '/org/mpris/MediaPlayer2/streamhub/track';

// dbus-native marshals a variant as [signature, value].
const v = (signature, value) => [signature, value];

class Mpris {
  // `controls` is the bridge to the app: playPause/seek/raise, plus what is playing now.
  constructor(controls) {
    this.controls = controls;
    this.bus = null;
    this.playing = false;
    this.title = 'StreamHub';
    this.service = '';
    this.props = null; // the exported Player interface, once dbus hands it to us
  }

  start() {
    if (this.bus) return;
    try {
      this.bus = dbus.sessionBus();
    } catch {
      return; // no session bus (a container, a TTY) — media controls are simply absent
    }
    if (!this.bus) return;
    // Errors on the bus must never take the app down; losing the panel applet is not worth
    // a crash. 0x4 = DBUS_NAME_FLAG_DO_NOT_QUEUE.
    this.bus.connection.on('error', () => {});
    this.bus.requestName(BUS_NAME, 0x4, () => {});

    this.exportRoot();
    this.exportPlayer();
  }

  stop() {
    if (!this.bus) return;
    try {
      this.bus.releaseName(BUS_NAME, () => {});
      this.bus.connection.end();
    } catch {
      /* going away anyway */
    }
    this.bus = null;
  }

  // org.mpris.MediaPlayer2 — identity, and Raise so clicking the applet brings the window up.
  exportRoot() {
    const self = this;
    this.bus.exportInterface(
      {
        Raise() {
          self.controls.raise();
        },
        Quit() {
          self.controls.quit();
        },
        CanRaise: true,
        CanQuit: true,
        Identity: 'StreamHub',
        DesktopEntry: 'streamhub',
        // We do not open files or URIs on request, and saying so keeps clients from asking.
        HasTrackList: false,
        SupportedUriSchemes: [],
        SupportedMimeTypes: [],
      },
      OBJECT_PATH,
      {
        name: 'org.mpris.MediaPlayer2',
        methods: { Raise: ['', ''], Quit: ['', ''] },
        properties: {
          CanRaise: 'b',
          CanQuit: 'b',
          Identity: 's',
          DesktopEntry: 's',
          HasTrackList: 'b',
          SupportedUriSchemes: 'as',
          SupportedMimeTypes: 'as',
        },
        signals: {},
      },
    );
  }

  // org.mpris.MediaPlayer2.Player — the half that panels actually use.
  exportPlayer() {
    const self = this;
    this.props = this.bus.exportInterface(
      {
        PlayPause() {
          self.controls.playPause();
        },
        Play() {
          self.controls.playPause();
        },
        Pause() {
          self.controls.playPause();
        },
        Stop() {
          self.controls.playPause();
        },
        // These sites have no notion of a next track, so the media keys are wired to seek
        // instead — the same ±10s the app's own media-key handling does, so the hardware
        // keys and the panel buttons agree rather than doing different things.
        Next() {
          self.controls.seek(10);
        },
        Previous() {
          self.controls.seek(-10);
        },

        get PlaybackStatus() {
          return self.playing ? 'Playing' : 'Paused';
        },
        get Metadata() {
          return [
            ['mpris:trackid', v('o', TRACK_ID)],
            ['xesam:title', v('s', self.title)],
            // The service ("YouTube") reads naturally as the artist line in every applet.
            ['xesam:artist', v('as', self.service ? [self.service] : [])],
          ];
        },
        CanPlay: true,
        CanPause: true,
        CanGoNext: true,
        CanGoPrevious: true,
        CanControl: true,
        // Seeking to an absolute position is not wired up, so do not advertise a scrubber.
        CanSeek: false,
      },
      OBJECT_PATH,
      {
        name: 'org.mpris.MediaPlayer2.Player',
        methods: {
          PlayPause: ['', ''],
          Play: ['', ''],
          Pause: ['', ''],
          Stop: ['', ''],
          Next: ['', ''],
          Previous: ['', ''],
        },
        properties: {
          PlaybackStatus: 's',
          Metadata: 'a{sv}',
          CanPlay: 'b',
          CanPause: 'b',
          CanGoNext: 'b',
          CanGoPrevious: 'b',
          CanControl: 'b',
          CanSeek: 'b',
        },
        signals: {},
      },
    );
  }

  // Tell the bus what changed. Without this the panel shows whatever was true when it first
  // looked, so a paused video still reads as playing.
  update({ playing, title, service }) {
    if (playing !== undefined) this.playing = playing;
    if (title !== undefined) this.title = title || 'StreamHub';
    if (service !== undefined) this.service = service || '';
    if (!this.props || !this.props.emit) return;
    try {
      this.props.emit('PropertiesChanged', 'org.mpris.MediaPlayer2.Player', {
        PlaybackStatus: v('s', this.playing ? 'Playing' : 'Paused'),
        Metadata: v('a{sv}', [
          ['mpris:trackid', v('o', TRACK_ID)],
          ['xesam:title', v('s', this.title)],
          ['xesam:artist', v('as', this.service ? [this.service] : [])],
        ]),
      });
    } catch {
      /* the panel will catch up on its next read */
    }
  }
}

module.exports = { Mpris };
