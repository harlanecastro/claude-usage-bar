const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consumptionApi', {
  overview: () => ipcRenderer.invoke('consumption:overview'),
  records: (request) => ipcRenderer.invoke('consumption:records', request),
  refresh: () => ipcRenderer.invoke('consumption:refresh'),
  onChanged: (handler) => ipcRenderer.on('consumption:changed', () => handler()),
  onSelectWindow: (handler) => ipcRenderer.on('consumption:select-window', (_event, range) => handler(range)),
});
