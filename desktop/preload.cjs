const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Keep the bridge specific to the local shell. Never expose ipcRenderer to websites.
contextBridge.exposeInMainWorld('looplineChatGpt', {
  setLayout: (layout) => ipcRenderer.send('loopline-chatgpt:layout', layout),
  navigate: (action) => ipcRenderer.send('loopline-chatgpt:navigate', action),
  openInBrowser: () => ipcRenderer.send('loopline-chatgpt:browser'),
  getState: () => ipcRenderer.invoke('loopline-chatgpt:state'),
  onState: (callback) => subscribe('loopline-chatgpt:state', callback),
  onCommand: (callback) => subscribe('loopline-chatgpt:command', callback),
});
