const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  rescan: () => ipcRenderer.invoke('devices:rescan'),
  start: (opts) => ipcRenderer.invoke('stream:start', opts),
  stop: () => ipcRenderer.invoke('stream:stop'),
  chunk: (buf) => ipcRenderer.send('stream:chunk', buf),
  log: (msg) => ipcRenderer.send('log', msg),
  openLicenses: () => ipcRenderer.invoke('licenses:open'),
  allowFirewall: () => ipcRenderer.invoke('firewall:allow'),
  onFirewallHint: (cb) => ipcRenderer.on('firewall:hint', () => cb()),
  onDevices: (cb) => ipcRenderer.on('devices:update', (_e, v) => cb(v)),
  onStatus: (cb) => ipcRenderer.on('stream:status', (_e, v) => cb(v)),
  onEnded: (cb) => ipcRenderer.on('stream:ended', (_e, v) => cb(v)),
});
