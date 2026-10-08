'use strict';
// Preload for the "agent is using this computer" pill (indicator.cjs). Sandboxed; two channels only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intelioIndicator', {
  stop: () => ipcRenderer.send('intelio-node-indicator:stop'),
  onState: (fn) => ipcRenderer.on('intelio-node-indicator:state', (_event, state) => fn(state)),
});
