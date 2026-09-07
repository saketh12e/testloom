import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JourneyService } from '../core/service';

protocol.registerSchemesAsPrivileged([{ scheme: 'journeyproof', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.JOURNEYPROOF_DATA_DIR) app.setPath('userData', path.resolve(process.env.JOURNEYPROOF_DATA_DIR));
let window: BrowserWindow | undefined; let service: JourneyService; let closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

async function chooseProject() {
  const result = await dialog.showOpenDialog(window!, { title: 'Open a test project folder', properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths[0]) await service.connect(result.filePaths[0]); return service.state;
}
function registerHandlers() {
  const actions: Record<string, (...args: any[]) => any> = {
    'get-state': () => service.state,
    'choose-project': chooseProject,
    'load-demo': () => service.loadDemo(),
    'start-recording': input => service.startRecording(input),
    'stop-recording': () => service.stopRecording(),
    'save-scenario': input => service.saveScenario(input),
    generate: input => service.generate(input),
    verify: input => service.verify(input),
    cancel: () => service.cancel(),
    reveal: async () => { const result = await shell.openPath(service.state.generation?.workspace || service.root); if (result) throw new Error(result); },
    export: async () => { const result = await dialog.showOpenDialog(window!, { title: 'Export scenario and test evidence', properties: ['openDirectory','createDirectory'] }); return result.canceled ? null : service.exportTo(result.filePaths[0]); },
  };
  for (const [channel, handler] of Object.entries(actions)) ipcMain.handle('journey:' + channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame?.url.startsWith('journeyproof://app/')) throw new Error('Untrusted application request.');
    try { return await handler(...args); } catch (error) { service.reportError(error); throw error; }
  });
}
function createWindow() {
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 1024, minHeight: 720, title: 'JourneyProof', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 17 }, backgroundColor: '#f7f6f2', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.loadURL('journeyproof://app/index.html');
  window.on('closed', () => { window = undefined; });
}
app.whenReady().then(async () => {
  const renderer = path.join(app.getAppPath(), 'dist/renderer');
  protocol.handle('journeyproof', request => {
    const url = new URL(request.url); let file: string;
    try { file = path.resolve(renderer, '.' + decodeURIComponent(url.pathname)); } catch { return new Response('Invalid path', { status: 400 }); }
    if (url.host !== 'app' || !file.startsWith(renderer + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  service = new JourneyService(path.join(app.getPath('userData'), 'workspace'), path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'examples/cart'));
  await service.initialize();
  service.on('update', state => { if (window && !window.isDestroyed()) window.webContents.send('journey:update', state); });
  registerHandlers(); createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'JourneyProof', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: () => chooseProject().catch(error => service.reportError(error)) }, { role: 'close' }] },
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' }] }, { role: 'windowMenu' },
    { role: 'help', submenu: [{label:'Getting started',click:()=>{void shell.openExternal('https://github.com/saketh12e/journeyproof/blob/main/docs/GETTING-STARTED.md');}},{label:'JourneyProof on GitHub',click:()=>{void shell.openExternal('https://github.com/saketh12e/journeyproof');}}] },
  ]));
  app.on('activate', () => { if (!window) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (closing || !service) return; event.preventDefault(); closing = true; service.close().finally(() => app.quit()); });
