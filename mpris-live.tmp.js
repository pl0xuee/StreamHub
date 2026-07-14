const { app } = require('electron');
const { Mpris } = require('./src/mpris.js');
app.whenReady().then(() => {
  const m = new Mpris({ playPause(){}, seek(){}, raise(){}, quit(){} });
  m.start();
  m.update({ playing: true, title: 'Test Video', service: 'YouTube' });
  setInterval(() => console.log('ALIVE'), 3000);
  setTimeout(() => app.exit(0), 30000);
});
