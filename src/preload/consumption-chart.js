const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consumptionChartApi', {
  overview: () => ipcRenderer.invoke('consumption:overview'),
  openDetails: (range) => ipcRenderer.invoke('consumption:open-details', range),
  onChanged: (handler) => ipcRenderer.on('consumption:changed', () => handler()),
});
