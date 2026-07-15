const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  signIn: () => ipcRenderer.invoke('settings:signIn'),
  signOut: () => ipcRenderer.invoke('settings:signOut'),
  onAuth: (handler) => ipcRenderer.on('settings:auth', (_e, signedIn) => handler(signedIn)),
});
