const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usagePanel', {
  onState: (handler) => ipcRenderer.on('panel:state', (_e, view) => handler(view)),
  rendered: (size) => ipcRenderer.send('panel:rendered', size),
});
