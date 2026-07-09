// Minimal Electron shell used by tests/mobile_drive.mjs to load the mobile
// PWA from disk (no server needed).
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 430,
        height: 930,
        webPreferences: { contextIsolation: true },
    });
    win.loadFile(path.join(__dirname, '..', 'mobile', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
