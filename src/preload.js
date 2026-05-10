const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mcpAPI', {
  getServers: () => ipcRenderer.invoke('get-servers'),
  createServer: (data) => ipcRenderer.invoke('create-server', data),
  updateServer: (server) => ipcRenderer.invoke('update-server', server),
  deleteServer: (id) => ipcRenderer.invoke('delete-server', id),
  discoverServer: (server) => ipcRenderer.invoke('discover-server', server),
  getLogs: (id) => ipcRenderer.invoke('get-logs', id),
  getReadme: (id) => ipcRenderer.invoke('get-readme', id),
  getTools: (id) => ipcRenderer.invoke('get-tools', id),
  onDiscoveryLog: (callback) => {
    ipcRenderer.on('discovery-log', (event, data) => callback(data));
  },
  removeDiscoveryLogListener: () => {
    ipcRenderer.removeAllListeners('discovery-log');
  }
});