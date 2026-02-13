const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

const PORT = process.env.PORT || 3847;
let mainWindow;
let server;
let retryCount = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    title: 'Call Transcript Merger',
    show: false,
    backgroundColor: '#f8f9fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Show a loading screen immediately while the server starts
  mainWindow.loadURL(`data:text/html,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             display: flex; justify-content: center; align-items: center; height: 100vh;
             margin: 0; background: #f8f9fb; color: #374151; }
      .loading { text-align: center; }
      h1 { font-size: 22px; margin-bottom: 8px; }
      p { color: #6b7280; font-size: 14px; }
    </style></head>
    <body><div class="loading"><h1>Call Transcript Merger</h1><p>Starting up...</p></div></body>
    </html>
  `)}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadApp() {
  if (!mainWindow) return;

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.once('did-fail-load', () => {
    retryCount++;
    if (retryCount < 10) {
      setTimeout(loadApp, 500);
    } else {
      dialog.showErrorBox('Startup Error',
        'The app server failed to start. Try restarting the application.');
    }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Downloads Folder',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const os = require('os');
            shell.openPath(path.join(os.homedir(), 'Downloads'));
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  createWindow(); // Show loading screen immediately

  try {
    // Start the Express server and wait for it to be listening
    server = require('./server');
    await server.ready;
    // Server is ready — load the real app UI
    loadApp();
  } catch (e) {
    dialog.showErrorBox('Startup Error', `Server failed to start: ${e.message}`);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
    if (server) loadApp();
  }
});

// Graceful shutdown: close the HTTP server before quitting
app.on('before-quit', () => {
  if (server && typeof server.close === 'function') {
    server.close();
  }
});
