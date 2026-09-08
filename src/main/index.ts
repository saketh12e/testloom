import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JourneyService } from '../core/service';

protocol.registerSchemesAsPrivileged([
  { scheme: 'journeyproof', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// Keep the original data directory when upgrading the renamed application.
const dataOverride = process.env.TESTLOOM_DATA_DIR || process.env.JOURNEYPROOF_DATA_DIR;
if (dataOverride) app.setPath('userData', path.resolve(dataOverride));
else {
  const legacy = ['JourneyProof', 'journeyproof']
    .map((name) => path.join(app.getPath('appData'), name))
    .find((folder) => existsSync(path.join(folder, 'workspace', 'session.json')));
  if (legacy) app.setPath('userData', legacy);
}
let window: BrowserWindow | undefined;
let service: JourneyService;
let closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  window?.show();
  window?.focus();
});

async function chooseProject() {
  const result = await dialog.showOpenDialog(window!, {
    title: 'Open a test project folder',
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) await service.connect(result.filePaths[0]);
  return service.state;
}
function registerHandlers() {
  const actions: Record<string, (...args: any[]) => any> = {
    'get-state': () => service.state,
    'choose-project': chooseProject,
    'load-demo': () => service.loadDemo(),
    'start-recording': (input) => service.startRecording(input),
    'stop-recording': () => service.stopRecording(),
    'export-browser-startup-report': async () => {
      const result = await dialog.showSaveDialog(window!, {
        title: 'Export browser startup report',
        defaultPath: 'testloom-browser-startup.json',
        filters: [{ name: 'Startup report', extensions: ['json'] }],
      });
      return result.canceled || !result.filePath
        ? null
        : service.exportBrowserStartupReportTo(result.filePath);
    },
    'save-scenario': (input) => service.saveScenario(input),
    'save-case': (input) => service.saveCase(input),
    'duplicate-case': (input) => service.duplicateCase(input),
    'delete-case': (input) => service.deleteCase(input),
    'select-case': (input) => service.selectCase(input),
    'save-settings': (input) => service.saveSettings(input),
    'reset-agent-session': (input) => service.resetAgentSession(input),
    'choose-context-files': async () => {
      if (!service.state.project) throw new Error('Open a project first.');
      const result = await dialog.showOpenDialog(window!, {
        title: 'Choose project conventions and helper files',
        defaultPath: service.state.project.path,
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? service.state : service.addContextFiles(result.filePaths);
    },
    'refresh-agents': () => service.refreshAgents(),
    'preview-prompt': (input) => service.previewPrompt(input),
    'import-suite': async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Import a Testloom suite',
        properties: ['openFile'],
        filters: [{ name: 'Testloom suite', extensions: ['json'] }],
      });
      return result.canceled ? service.state : service.importSuiteFrom(result.filePaths[0]);
    },
    'export-suite': async () => {
      const result = await dialog.showSaveDialog(window!, {
        title: 'Export editable test suite',
        defaultPath: 'testloom-suite.json',
        filters: [{ name: 'Testloom suite', extensions: ['json'] }],
      });
      return result.canceled || !result.filePath ? null : service.exportSuiteTo(result.filePath);
    },
    generate: (input) => service.generate(input),
    verify: (input) => service.verify(input),
    cancel: () => service.cancel(),
    reveal: async () => {
      const result = await shell.openPath(service.state.generation?.workspace || service.root);
      if (result) throw new Error(result);
    },
    export: async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: 'Export scenario and test evidence',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : service.exportTo(result.filePaths[0]);
    },
  };
  for (const [channel, handler] of Object.entries(actions))
    ipcMain.handle('journey:' + channel, async (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame?.url.startsWith('journeyproof://app/')
      )
        throw new Error('Untrusted application request.');
      try {
        return await handler(...args);
      } catch (error) {
        if (!/Recording cancelled\./.test(String(error))) service.reportError(error);
        throw error;
      }
    });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'Testloom',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 17 },
    backgroundColor: '#f7f6f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.loadURL('journeyproof://app/index.html');
  window.on('closed', () => {
    window = undefined;
  });
}
app.whenReady().then(async () => {
  const renderer = path.join(app.getAppPath(), 'dist/renderer');
  protocol.handle('journeyproof', (request) => {
    const url = new URL(request.url);
    let file: string;
    try {
      file = path.resolve(renderer, '.' + decodeURIComponent(url.pathname));
    } catch {
      return new Response('Invalid path', { status: 400 });
    }
    if (url.host !== 'app' || !file.startsWith(renderer + path.sep))
      return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  service = new JourneyService(
    path.join(app.getPath('userData'), 'workspace'),
    path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'examples/cart'),
    {
      browserBundleRoot: app.isPackaged
        ? path.join(process.resourcesPath, 'recording-browser')
        : undefined,
    },
  );
  await service.initialize();
  service.on('update', (state) => {
    if (window && !window.isDestroyed()) window.webContents.send('journey:update', state);
  });
  registerHandlers();
  createWindow();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Testloom',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Open Project Folder…',
            accelerator: 'CmdOrCtrl+O',
            click: () => chooseProject().catch((error) => service.reportError(error)),
          },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Getting started',
            click: () => {
              void shell.openExternal(
                'https://github.com/saketh12e/testloom/blob/main/docs/GETTING-STARTED.md',
              );
            },
          },
          {
            label: 'Export browser startup report…',
            click: async () => {
              try {
                if (!service.state.browserStartup)
                  throw new Error('Start a recording first to create a startup report.');
                const result = await dialog.showSaveDialog(window!, {
                  title: 'Export browser startup report',
                  defaultPath: 'testloom-browser-startup.json',
                  filters: [{ name: 'Startup report', extensions: ['json'] }],
                });
                if (!result.canceled && result.filePath)
                  await service.exportBrowserStartupReportTo(result.filePath);
              } catch (error) {
                service.reportError(error);
              }
            },
          },
          {
            label: 'Testloom on GitHub',
            click: () => {
              void shell.openExternal('https://github.com/saketh12e/testloom');
            },
          },
        ],
      },
    ]),
  );
  app.on('activate', () => {
    if (!window) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing || !service) return;
  event.preventDefault();
  closing = true;
  service.close().finally(() => app.quit());
});
