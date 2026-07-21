const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('consumptionChartApi', {
  overview: () => ipcRenderer.invoke('consumption:overview'),
  vpsUsage: (days) => ipcRenderer.invoke('consumption:vps-usage', { days }),
  openDetails: (range) => ipcRenderer.invoke('consumption:open-details', range),
  onChanged: (handler) => ipcRenderer.on('consumption:changed', () => handler()),
});
