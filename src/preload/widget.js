const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageBar', {
  onState: (handler) => ipcRenderer.on('widget:state', (_e, view) => handler(view)),
  rendered: (size) => ipcRenderer.send('widget:rendered', size),
  click: (button) => ipcRenderer.send('widget:click', button),
});
