const { contextBridge, ipcRenderer } = require('electron');

// No click channel on purpose. The page is only ever captured to a bitmap and can
// never be clicked, so a click that arrived from here could carry no coordinates —
// and the main process would have had to hit-test `undefined`, which silently
// matches nothing. Clicks reach the main process from the native surface instead:
// the tray item on macOS, the taskbar strip on Windows.
contextBridge.exposeInMainWorld('usageBar', {
  onState: (handler) => ipcRenderer.on('widget:state', (_e, view) => handler(view)),
  rendered: (size) => ipcRenderer.send('widget:rendered', size),
});
