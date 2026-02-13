const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

const PORT = process.env.PORT || 3847;
let mainWindow;
let server;

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

  // Show the window once the page has actually rendered
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // If the page fails to load (server not ready), retry
  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    }, 500);
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
  // Start the Express server and wait for it to be listening
  server = require('./server');
  await server.ready;

  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Graceful shutdown: close the HTTP server before quitting
app.on('before-quit', () => {
  if (server && typeof server.close === 'function') {
    server.close();
  }
});
