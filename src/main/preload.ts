import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, JourneyAPI } from '../shared/types';

const api: JourneyAPI = {
  getState: () => ipcRenderer.invoke('journey:get-state'),
  chooseProject: () => ipcRenderer.invoke('journey:choose-project'),
  loadDemo: () => ipcRenderer.invoke('journey:load-demo'),
  startRecording: (input) => ipcRenderer.invoke('journey:start-recording', input),
  stopRecording: () => ipcRenderer.invoke('journey:stop-recording'),
  saveScenario: (input) => ipcRenderer.invoke('journey:save-scenario', input),
  saveCase: (input) => ipcRenderer.invoke('journey:save-case', input),
  duplicateCase: (input) => ipcRenderer.invoke('journey:duplicate-case', input),
  deleteCase: (input) => ipcRenderer.invoke('journey:delete-case', input),
  selectCase: (input) => ipcRenderer.invoke('journey:select-case', input),
  saveSettings: (input) => ipcRenderer.invoke('journey:save-settings', input),
  chooseContextFiles: () => ipcRenderer.invoke('journey:choose-context-files'),
  refreshAgents: () => ipcRenderer.invoke('journey:refresh-agents'),
  previewPrompt: (input) => ipcRenderer.invoke('journey:preview-prompt', input),
  importSuite: () => ipcRenderer.invoke('journey:import-suite'),
  exportSuite: () => ipcRenderer.invoke('journey:export-suite'),
  generate: (input) => ipcRenderer.invoke('journey:generate', input),
  verify: (input) => ipcRenderer.invoke('journey:verify', input),
  exportBundle: () => ipcRenderer.invoke('journey:export'),
  revealWorkspace: () => ipcRenderer.invoke('journey:reveal'),
  cancelRun: () => ipcRenderer.invoke('journey:cancel'),
  onUpdate: (callback) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on('journey:update', listener);
    return () => ipcRenderer.removeListener('journey:update', listener);
  },
};
contextBridge.exposeInMainWorld('journey', api);
