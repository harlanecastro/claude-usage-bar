const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consumptionApi', {
  overview: () => ipcRenderer.invoke('consumption:overview'),
  records: (request) => ipcRenderer.invoke('consumption:records', request),
  eventContent: (request) => ipcRenderer.invoke('consumption:event-content', request),
  refresh: () => ipcRenderer.invoke('consumption:refresh'),
  daily: (request) => ipcRenderer.invoke('consumption:daily', request),
  vpsUsage: (request) => ipcRenderer.invoke('consumption:vps-usage', request),
  vpsTurns: (request) => ipcRenderer.invoke('consumption:vps-turns', request),
  vpsTurnDetail: (request) => ipcRenderer.invoke('consumption:vps-turn-detail', request),
  openSettings: () => ipcRenderer.invoke('consumption:open-settings'),
  onChanged: (handler) => ipcRenderer.on('consumption:changed', () => handler()),
  onSelectWindow: (handler) => ipcRenderer.on('consumption:select-window', (_event, range) => handler(range)),
});
