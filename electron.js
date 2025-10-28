const { app, BrowserWindow } = require('electron');
const path = require('path');

// Ensure the server does not auto-open external browser
process.env.AUTO_OPEN = 'false';

// Start the HTTP server from app.js and open it in a webview (BrowserWindow)
const { startServer } = require(path.join(__dirname, 'app.js'));

let mainWindow = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.loadURL(url);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const { url } = await startServer(0); // let OS choose a free port
      createWindow(url);
    } catch (err) {
      console.error('Failed to start server for Electron window:', err);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      // On macOS, recreate window on dock icon click
      // If needed, we could restart the server or remember last URL
    }
  });
}
