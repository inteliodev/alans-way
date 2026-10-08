'use strict';
// Preload for the Terminal window (terminal/main.cjs). Sandboxed; one invoke channel, one event.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intelioTerminal', {
  run: (target, op, value) => ipcRenderer.invoke('intelio-terminal', target, op, value),
  onOpen: (fn) => ipcRenderer.on('intelio-terminal:open', (_event, target) => fn(target)),
});
