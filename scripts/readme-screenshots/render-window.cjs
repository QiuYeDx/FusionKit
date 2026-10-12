// Minimal Electron entry for banner.mjs: one off-screen window that never takes focus.
const { app, BrowserWindow } = require('electron');

for (const name of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) {
  app.commandLine.appendSwitch(name);
}
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 440, useContentSize: true, x: -32000, y: -32000,
    show: false, frame: false, skipTaskbar: true, focusable: false, backgroundColor: '#00000000',
  });
  window.loadURL('about:blank').then(() => window.showInactive());
});
