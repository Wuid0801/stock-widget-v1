// preload.js — 렌더러에 노출할 안전한 IPC 표면만 정의.
// 렌더러는 node/fetch에 접근할 수 없고, 아래 4개 함수만 쓸 수 있다.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchChart: (params) => ipcRenderer.invoke('yf:chart', params),
  search: (query) => ipcRenderer.invoke('yf:search', query),
  realtimeQuotes: (symbols) => ipcRenderer.invoke('quote:realtime', symbols),
  indices: () => ipcRenderer.invoke('quote:indices'),
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  dockWindow: (on, height) => ipcRenderer.send('win:dock', on, height),
  notify: (payload) => ipcRenderer.send('notify', payload),
  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  closeWindow: () => ipcRenderer.send('win:close'),
});
